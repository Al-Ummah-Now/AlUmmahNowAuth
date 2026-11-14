import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_TOKEN_CUTOFF_S,
  REFRESH_LOCK_MS,
  REFRESH_WAIT_MS,
  createSession,
  endSession,
  ensureFreshTokens,
  getSession,
  needsRefresh,
  revokedKey,
  sessionId,
  sessionKey,
  type SessionStores,
} from "./session-store";
import { FakeKV, NOW_MS, NOW_S, fakeD1, jwt } from "./test-helpers";

describe("needsRefresh", () => {
  it("refreshes within the skew and treats unreadable tokens as expired", () => {
    expect(needsRefresh(jwt(NOW_S + 900), NOW_MS)).toBe(false);
    expect(needsRefresh(jwt(NOW_S + 60), NOW_MS)).toBe(true);
    expect(needsRefresh(jwt(NOW_S - 1), NOW_MS)).toBe(true);
    expect(needsRefresh("not-a-jwt", NOW_MS)).toBe(true);
  });

  it("refreshes a long-lived token from before 15-minute access tokens (Auth's account API refuses it)", () => {
    // 30-day token issued 6 days before 15-minute tokens, a day later: valid for 23 more days
    const issued = LEGACY_TOKEN_CUTOFF_S - 6 * 86400;
    const nowMs = (LEGACY_TOKEN_CUTOFF_S + 86400) * 1000;
    const legacy = jwt(issued + 30 * 86400, "legacy", issued);
    expect(needsRefresh(legacy, nowMs)).toBe(true);
    // ...but it still counts as unexpired if the refresh fails (skew 0)
    expect(needsRefresh(legacy, nowMs, 0)).toBe(false);
    // A current 15-minute token is left alone
    expect(needsRefresh(jwt(NOW_S + 840, "short", NOW_S - 60), NOW_MS)).toBe(false);
  });

  it("only treats tokens issued before 15-minute tokens as legacy (no refresh loop where the issuer still issues long ones)", () => {
    const issued = LEGACY_TOKEN_CUTOFF_S - 6 * 86400;
    const nowMs = (LEGACY_TOKEN_CUTOFF_S + 86400) * 1000;
    expect(needsRefresh(jwt(issued + 30 * 86400, "old", issued), nowMs)).toBe(true);
    const fresh = LEGACY_TOKEN_CUTOFF_S + 3600;
    expect(needsRefresh(jwt(fresh + 30 * 86400, "local", fresh), (fresh + 60) * 1000)).toBe(false);
  });
});

const user = { id: "u1", email: "a@example.com", roles: [] };

describe("profile session store (D1)", () => {
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

  const session = (access: string, refresh = "r0") => createSession(stores, { user, tokens: { access, refresh } }, NOW_MS);
  const fresh = (token: string, tokens: { access: string; refresh?: string }, now = NOW_MS) =>
    ensureFreshTokens({ stores, token, tokens, client, now: () => now, sleep: () => new Promise((r) => setTimeout(r, 1)) });

  it("keeps the session in D1 under a hash of the cookie, never in KV", async () => {
    const token = await session(jwt(NOW_S + 900));
    expect(kv.store.size).toBe(0);
    const [row] = db.rows();
    expect(row.id).toBe(await sessionId(token));
    expect(row.id).not.toBe(token);
    expect(row.app).toBe("profile");
    expect((await getSession(stores, token, NOW_MS))?.user).toEqual(user);
  });

  it("keeps a token that is not near expiry", async () => {
    const token = await session(jwt(NOW_S + 900));
    const s = (await getSession(stores, token, NOW_MS))!;
    expect(await fresh(token, s.tokens)).toMatchObject({ ok: true, refreshed: false });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("refreshes before the 15-minute access token expires and saves the rotated pair", async () => {
    const token = await session(jwt(NOW_S + 60, "old"));
    const next = jwt(NOW_S + 900, "new");
    client.refresh.mockResolvedValue({ err: false, tokens: { access: next, refresh: "r1" } });
    const s = (await getSession(stores, token, NOW_MS))!;
    expect(await fresh(token, s.tokens)).toEqual({ ok: true, tokens: { access: next, refresh: "r1" }, refreshed: true });
    expect(client.refresh).toHaveBeenCalledWith("r0");
    expect((await getSession(stores, token, NOW_MS))?.tokens).toEqual({ access: next, refresh: "r1" });
  });

  it("PF-1: 50 concurrent requests at the refresh threshold spend the refresh token once and all get the new pair", async () => {
    const old = jwt(NOW_S + 60, "old");
    const token = await session(old);
    const next = jwt(NOW_S + 900, "new");
    client.refresh.mockImplementation(async (r: string) => {
      await new Promise((res) => setTimeout(res, 20)); // the issuer round trip
      return { err: false, tokens: { access: next, refresh: `${r}-next` } };
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => fresh(token, { access: old, refresh: "r0" })));
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok && r.tokens.access === next && r.tokens.refresh === "r0-next")).toBe(true);
    expect(results.filter((r) => r.ok && r.refreshed)).toHaveLength(1);
  });

  it("PF-1: a request holding stale tokens (as a lagging read would) uses the rotated pair instead of the old refresh token", async () => {
    const old = jwt(NOW_S + 60, "old");
    const token = await session(old);
    client.refresh.mockResolvedValueOnce({ err: false, tokens: { access: jwt(NOW_S + 900, "a"), refresh: "r1" } });
    await fresh(token, { access: old, refresh: "r0" });
    // Long after the issuer's reuse window, a request that read the session before the rotation
    const late = await fresh(token, { access: old, refresh: "r0" }, NOW_MS + 5 * 60_000);
    expect(late).toMatchObject({ ok: true, tokens: { refresh: "r1" } });
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  it("a lock left by a crashed request expires (inside the reuse window) and the next request refreshes", async () => {
    const token = await session(jwt(NOW_S + 60));
    expect(REFRESH_LOCK_MS).toBeLessThan(60_000);
    // Lock taken and never released
    await db
      .prepare("UPDATE app_sessions SET refresh_lock = 'dead', refresh_lock_until = ?1")
      .bind(NOW_MS + REFRESH_LOCK_MS)
      .run();
    client.refresh.mockResolvedValue({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "r1" } });
    // While it is held, a waiter falls back to the still-valid access token after REFRESH_WAIT_MS
    let t = NOW_MS;
    const waiting = await ensureFreshTokens({
      stores,
      token,
      tokens: { access: jwt(NOW_S + 60), refresh: "r0" },
      client,
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    expect(waiting).toMatchObject({ ok: true, refreshed: false });
    expect(t - NOW_MS).toBeGreaterThanOrEqual(REFRESH_WAIT_MS);
    expect(client.refresh).not.toHaveBeenCalled();
    // Once it has expired, the next request takes over
    const after = await fresh(token, { access: jwt(NOW_S + 60), refresh: "r0" }, NOW_MS + REFRESH_LOCK_MS);
    expect(after).toMatchObject({ ok: true, refreshed: true });
  });

  it("keeps working on a failed refresh while the access token is still valid, and frees the lock", async () => {
    const token = await session(jwt(NOW_S + 60));
    client.refresh.mockResolvedValueOnce({ err: new Error("x") });
    expect(await fresh(token, { access: jwt(NOW_S + 60), refresh: "r0" })).toMatchObject({ ok: true, refreshed: false });
    expect(db.rows()[0].refresh_lock).toBeNull();
    client.refresh.mockResolvedValueOnce({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "r1" } });
    expect(await fresh(token, { access: jwt(NOW_S + 60), refresh: "r0" })).toMatchObject({ ok: true, refreshed: true });
  });

  it("reports failure once the access token expired and refresh fails (network error too)", async () => {
    const token = await session(jwt(NOW_S - 10));
    client.refresh.mockRejectedValue(new Error("network"));
    expect(await fresh(token, { access: jwt(NOW_S - 10), refresh: "r0" })).toEqual({ ok: false, reason: "network" });
  });

  it("never revives a logged-out session", async () => {
    const token = await session(jwt(NOW_S + 60));
    client.refresh.mockImplementation(async () => {
      await endSession(stores, token, NOW_MS); // logout lands mid-refresh
      return { err: false, tokens: { access: jwt(NOW_S + 900), refresh: "r1" } };
    });
    const result = await fresh(token, { access: jwt(NOW_S + 60), refresh: "r0" });
    expect(result).toEqual({ ok: false, reason: "logged out during refresh" });
    expect(await getSession(stores, token, NOW_MS)).toBeNull();
    expect(db.rows()[0]).toMatchObject({ access_token: "", refresh_token: null });
  });

  it("PF-2: logout is seen by every request at once (no per-location lag)", async () => {
    const token = await session(jwt(NOW_S + 900));
    await endSession(stores, token, NOW_MS);
    expect(await getSession(stores, token, NOW_MS)).toBeNull();
    expect(await fresh(token, { access: jwt(NOW_S + 60), refresh: "r0" })).toEqual({ ok: false, reason: "logged out" });
  });

  it("drops expired sessions and ignores a missing cookie", async () => {
    const token = await session(jwt(NOW_S + 900));
    expect(await getSession(stores, token, NOW_MS + 8 * 24 * 3600 * 1000)).toBeNull();
    expect(await getSession(stores, null, NOW_MS)).toBeNull();
    expect(await getSession(stores, "unknown", NOW_MS)).toBeNull();
  });

  it("writes nothing for a token without a session", async () => {
    await endSession(stores, "made-up", NOW_MS);
    expect(db.rows()).toEqual([]);
    expect(kv.store.size).toBe(0);
  });
});

describe("sessions from before PF-1 (still in KV)", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  let stores: SessionStores;

  beforeEach(async () => {
    kv = new FakeKV();
    db = await fakeD1();
    stores = { db, kv: kv.asKV() };
  });

  const legacy = (token: string, expiresAtMs = NOW_MS + 3600_000) =>
    kv.store.set(
      sessionKey(token),
      JSON.stringify({ user, tokens: { access: jwt(NOW_S + 900), refresh: "kv-r0" }, expiresAt: new Date(expiresAtMs).toISOString() }),
    );

  it("keep working: the first read copies the session into D1, then D1 alone decides", async () => {
    legacy("old-sid");
    expect((await getSession(stores, "old-sid", NOW_MS))?.tokens.refresh).toBe("kv-r0");
    expect(db.rows()).toHaveLength(1);
    // A stale KV copy elsewhere no longer matters
    kv.store.set(sessionKey("old-sid"), "{");
    expect((await getSession(stores, "old-sid", NOW_MS))?.user).toEqual(user);
  });

  it("100 concurrent first reads make one D1 row", async () => {
    legacy("old-sid");
    const all = await Promise.all(Array.from({ length: 100 }, () => getSession(stores, "old-sid", NOW_MS)));
    expect(all.every((s) => s?.user.id === "u1")).toBe(true);
    expect(db.rows()).toHaveLength(1);
  });

  it("logged-out, expired and corrupt KV sessions are not copied", async () => {
    legacy("gone");
    kv.store.set(revokedKey("gone"), "1");
    legacy("expired", NOW_MS - 1);
    kv.store.set(sessionKey("bad"), "{");
    for (const t of ["gone", "expired", "bad"]) expect(await getSession(stores, t, NOW_MS)).toBeNull();
    expect(db.rows()).toEqual([]);
  });

  it("a KV logout that shows up after the copy (lagging KV, or the previous version mid-rollout) still ends the session", async () => {
    legacy("old-sid");
    expect(await getSession(stores, "old-sid", NOW_MS)).not.toBeNull();
    kv.store.set(revokedKey("old-sid"), "1"); // tombstone written in another location
    expect(await getSession(stores, "old-sid", NOW_MS)).toBeNull();
    expect(db.rows()[0]).toMatchObject({ revoked_at: NOW_MS, refresh_token: null });
    kv.store.delete(revokedKey("old-sid")); // D1 now remembers it on its own
    expect(await getSession(stores, "old-sid", NOW_MS)).toBeNull();
  });

  it("logout of a KV session revokes it in D1 (everywhere) and tombstones the KV copy for the previous version", async () => {
    legacy("old-sid");
    await endSession(stores, "old-sid", NOW_MS);
    expect(kv.store.has(sessionKey("old-sid"))).toBe(false);
    expect(kv.store.get(revokedKey("old-sid"))).toBe("1");
    expect(db.rows()[0].revoked_at).toBe(NOW_MS);
    // Even if a lagging location still had the KV copy, D1 says logged out
    legacy("old-sid");
    expect(await getSession(stores, "old-sid", NOW_MS)).toBeNull();
  });
});
