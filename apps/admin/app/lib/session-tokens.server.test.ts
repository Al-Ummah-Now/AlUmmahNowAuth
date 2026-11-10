import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_LOCK_MS,
  createSession,
  decodeJwtExp,
  ensureFreshTokens,
  getSession,
  needsRefresh,
  revokeSession,
  revokedKey,
  sessionId,
  sessionKey,
  type SessionStores,
} from "./session-tokens.server";
import { FakeKV, NOW_MS, NOW_S, fakeD1, jwt, storedSession } from "./test-helpers";

vi.mock("./logger.server", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("decodeJwtExp / needsRefresh", () => {
  it("reads exp and refreshes within two minutes of expiry or after it", () => {
    expect(decodeJwtExp(jwt(NOW_S + 900))).toBe(NOW_S + 900);
    expect(needsRefresh(jwt(NOW_S + 900), NOW_MS)).toBe(false);
    expect(needsRefresh(jwt(NOW_S + 119), NOW_MS)).toBe(true);
    expect(needsRefresh(jwt(NOW_S - 1), NOW_MS)).toBe(true);
  });

  it("leaves unreadable tokens to signature verification", () => {
    expect(decodeJwtExp("nope")).toBeNull();
    expect(needsRefresh("nope", NOW_MS)).toBe(false);
  });
});

const user = { id: "u1", email: "admin@example.com", roles: ["Admin"] };

describe("admin sessions in D1 (AD-1)", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  let stores: SessionStores;
  const client = { refresh: vi.fn() };

  beforeEach(async () => {
    kv = new FakeKV();
    db = await fakeD1();
    stores = { db, kv: kv.asKV() };
    client.refresh.mockReset();
  });

  const session = (access: string, refresh = "user:r0") => createSession(stores, { user, tokens: { access, refresh } }, NOW_MS);
  const fresh = (sid: string, tokens: { access: string; refresh?: string }, now = NOW_MS) =>
    ensureFreshTokens({ stores, sessionToken: sid, tokens, client, now: () => now, sleep: () => new Promise((r) => setTimeout(r, 1)) });

  it("stores the session in D1 under a hash of the cookie, never in KV", async () => {
    const sid = await session(jwt(NOW_S + 900));
    expect(kv.puts).toHaveLength(0);
    expect(db.rows()[0]).toMatchObject({ id: await sessionId(sid), app: "admin" });
    expect((await getSession(stores, sid, NOW_MS))?.user).toEqual(user);
  });

  it("keeps a token with time to spare and does not call the issuer", async () => {
    const sid = await session(jwt(NOW_S + 900));
    expect(await fresh(sid, { access: jwt(NOW_S + 900), refresh: "user:r0" })).toMatchObject({ ok: true, source: "current" });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("refreshes ahead of expiry and saves the rotated pair", async () => {
    const old = jwt(NOW_S + 90, "old");
    const sid = await session(old);
    const next = jwt(NOW_S + 900, "new");
    client.refresh.mockResolvedValue({ err: false, tokens: { access: next, refresh: "user:r1" } });
    expect(await fresh(sid, { access: old, refresh: "user:r0" })).toEqual({ ok: true, tokens: { access: next, refresh: "user:r1" }, source: "refreshed" });
    expect(client.refresh).toHaveBeenCalledWith("user:r0");
    expect((await getSession(stores, sid, NOW_MS))?.tokens).toEqual({ access: next, refresh: "user:r1" });
  });

  it("AD-1: 50 concurrent requests at the refresh threshold make one refresh and all get the new pair", async () => {
    const old = jwt(NOW_S + 90, "old");
    const sid = await session(old);
    const next = jwt(NOW_S + 900, "new");
    client.refresh.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { err: false, tokens: { access: next, refresh: "user:r1" } };
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => fresh(sid, { access: old, refresh: "user:r0" })));
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok && r.tokens.refresh === "user:r1")).toBe(true);
    expect(results.filter((r) => r.ok && r.source === "refreshed")).toHaveLength(1);
  });

  it("AD-1: stale tokens long after the reuse window never spend the old refresh token", async () => {
    const old = jwt(NOW_S + 90, "old");
    const sid = await session(old);
    client.refresh.mockResolvedValueOnce({ err: false, tokens: { access: jwt(NOW_S + 900, "a"), refresh: "user:r1" } });
    await fresh(sid, { access: old, refresh: "user:r0" });
    const late = await fresh(sid, { access: old, refresh: "user:r0" }, NOW_MS + 5 * 60_000);
    expect(late).toMatchObject({ ok: true, source: "stored", tokens: { refresh: "user:r1" } });
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  it("a crashed holder's lock expires inside the reuse window", async () => {
    const sid = await session(jwt(NOW_S + 90));
    expect(REFRESH_LOCK_MS).toBeLessThan(60_000);
    await db.prepare("UPDATE app_sessions SET refresh_lock = 'dead', refresh_lock_until = ?1").bind(NOW_MS + REFRESH_LOCK_MS).run();
    client.refresh.mockResolvedValue({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "user:r1" } });
    expect(await fresh(sid, { access: jwt(NOW_S + 90), refresh: "user:r0" }, NOW_MS + REFRESH_LOCK_MS)).toMatchObject({
      ok: true,
      source: "refreshed",
    });
  });

  it("keeps a still-valid access token when the refresh fails, and frees the lock", async () => {
    const sid = await session(jwt(NOW_S + 60));
    client.refresh.mockResolvedValue({ err: new Error("InvalidRefreshTokenError") });
    expect(await fresh(sid, { access: jwt(NOW_S + 60), refresh: "user:r0" })).toMatchObject({ ok: true, source: "current" });
    expect(db.rows()[0].refresh_lock).toBeNull();
  });

  it("fails when the access token has expired and the refresh is rejected", async () => {
    const sid = await session(jwt(NOW_S - 10));
    client.refresh.mockResolvedValue({ err: new Error("InvalidRefreshTokenError") });
    expect(await fresh(sid, { access: jwt(NOW_S - 10), refresh: "user:r0" })).toEqual({ ok: false, reason: "Error" });
  });
});

describe("logout (AD-1)", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  let stores: SessionStores;
  const client = { refresh: vi.fn() };
  const ISSUER = "https://auth.example";

  beforeEach(async () => {
    kv = new FakeKV();
    db = await fakeD1();
    stores = { db, kv: kv.asKV() };
    client.refresh.mockReset();
  });

  it("ends the session everywhere at once and revokes its refresh token at the issuer", async () => {
    const sid = await createSession(stores, { user, tokens: { access: jwt(NOW_S + 900), refresh: "user:r0" } }, NOW_MS);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    await revokeSession({ stores, sessionToken: sid, issuer: ISSUER, clientId: "admin", fetch: fetchMock as unknown as typeof fetch, nowMs: NOW_MS });
    expect(await getSession(stores, sid, NOW_MS)).toBeNull();
    expect(db.rows()[0]).toMatchObject({ revoked_at: NOW_MS, refresh_token: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ISSUER}/token/revoke`);
    expect(String(init.body)).toContain("token=user%3Ar0");
  });

  it("still succeeds when the issuer has no /token/revoke (404) or is unreachable", async () => {
    for (const fetchImpl of [async () => new Response(null, { status: 404 }), async () => { throw new Error("down"); }]) {
      const sid = await createSession(stores, { user, tokens: { access: jwt(NOW_S + 900), refresh: "user:r0" } }, NOW_MS);
      await revokeSession({ stores, sessionToken: sid, issuer: ISSUER, clientId: "admin", fetch: fetchImpl as unknown as typeof fetch, nowMs: NOW_MS });
      expect(await getSession(stores, sid, NOW_MS)).toBeNull();
    }
  });

  it("logout while /token is in flight -> stays logged out", async () => {
    const sid = await createSession(stores, { user, tokens: { access: jwt(NOW_S + 60), refresh: "user:r0" } }, NOW_MS);
    client.refresh.mockImplementation(async () => {
      await revokeSession({ stores, sessionToken: sid, nowMs: NOW_MS });
      return { err: false, tokens: { access: jwt(NOW_S + 900), refresh: "user:r1" } };
    });
    const result = await ensureFreshTokens({ stores, sessionToken: sid, tokens: { access: jwt(NOW_S + 60), refresh: "user:r0" }, client, now: () => NOW_MS });
    expect(result).toMatchObject({ ok: false, revoked: true });
    expect(await getSession(stores, sid, NOW_MS)).toBeNull();
  });

  it("never refreshes a session that is already logged out", async () => {
    const sid = await createSession(stores, { user, tokens: { access: jwt(NOW_S + 60), refresh: "user:r0" } }, NOW_MS);
    await revokeSession({ stores, sessionToken: sid, nowMs: NOW_MS });
    const result = await ensureFreshTokens({ stores, sessionToken: sid, tokens: { access: jwt(NOW_S + 60), refresh: "user:r0" }, client, now: () => NOW_MS });
    expect(result).toMatchObject({ ok: false, revoked: true });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("a cookie with no session writes nothing", async () => {
    await revokeSession({ stores, sessionToken: "made-up", nowMs: NOW_MS });
    expect(db.rows()).toEqual([]);
    expect(kv.puts).toHaveLength(0);
  });
});

describe("sessions from before AD-1 (still in KV)", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  let stores: SessionStores;

  beforeEach(async () => {
    kv = new FakeKV();
    db = await fakeD1();
    stores = { db, kv: kv.asKV() };
  });

  it("keep working: copied into D1 on first read (once, under concurrency), then D1 decides", async () => {
    kv.store.set(sessionKey("old"), JSON.stringify(storedSession(jwt(NOW_S + 900), "user:kv")));
    const all = await Promise.all(Array.from({ length: 50 }, () => getSession(stores, "old", NOW_MS)));
    expect(all.every((s) => s?.tokens.refresh === "user:kv")).toBe(true);
    expect(db.rows()).toHaveLength(1);
  });

  it("logged-out, expired and corrupt KV sessions are not copied", async () => {
    kv.store.set(sessionKey("gone"), JSON.stringify(storedSession(jwt(NOW_S + 900), "user:r")));
    kv.store.set(revokedKey("gone"), "1");
    kv.store.set(sessionKey("expired"), JSON.stringify(storedSession(jwt(NOW_S + 900), "user:r", -1)));
    kv.store.set(sessionKey("bad"), "{");
    for (const sid of ["gone", "expired", "bad"]) expect(await getSession(stores, sid, NOW_MS)).toBeNull();
    expect(db.rows()).toEqual([]);
  });

  it("a KV logout that shows up after the copy (lagging KV, or the previous version mid-rollout) still ends it", async () => {
    kv.store.set(sessionKey("old"), JSON.stringify(storedSession(jwt(NOW_S + 900), "user:kv")));
    expect(await getSession(stores, "old", NOW_MS)).not.toBeNull();
    kv.store.set(revokedKey("old"), "1");
    expect(await getSession(stores, "old", NOW_MS)).toBeNull();
    kv.store.delete(revokedKey("old"));
    expect(await getSession(stores, "old", NOW_MS)).toBeNull();
  });

  it("logout of a KV session also tombstones the KV copy for the previous version", async () => {
    kv.store.set(sessionKey("old"), JSON.stringify(storedSession(jwt(NOW_S + 900), "user:kv")));
    await revokeSession({ stores, sessionToken: "old", nowMs: NOW_MS });
    expect(kv.store.has(sessionKey("old"))).toBe(false);
    expect(kv.store.get(revokedKey("old"))).toBe("1");
    expect(await getSession(stores, "old", NOW_MS)).toBeNull();
  });
});
