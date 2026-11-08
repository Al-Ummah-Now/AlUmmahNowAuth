import { describe, expect, it, vi } from "vitest";
import {
  decodeJwtExp,
  ensureFreshTokens,
  isSessionRevoked,
  needsRefresh,
  persistSessionTokens,
  REVOKED_TTL_SECONDS,
  revokeSession,
  type TokenRefresher,
} from "./session-tokens.server";
import { FakeKV, NOW_MS, NOW_S, jwt, storedSession } from "./test-helpers";

const SID = "sid-1";

function refresher(impl: TokenRefresher["refresh"]) {
  return { refresh: vi.fn(impl) };
}

describe("decodeJwtExp / needsRefresh", () => {
  it("reads exp and refreshes within two minutes of expiry or after it", () => {
    expect(decodeJwtExp(jwt(NOW_S + 900))).toBe(NOW_S + 900);
    expect(needsRefresh(jwt(NOW_S + 900), NOW_MS)).toBe(false);
    expect(needsRefresh(jwt(NOW_S + 30 * 24 * 3600), NOW_MS)).toBe(false); // legacy 30-day token
    expect(needsRefresh(jwt(NOW_S + 120), NOW_MS)).toBe(true);
    expect(needsRefresh(jwt(NOW_S - 1), NOW_MS)).toBe(true);
  });

  it("leaves unreadable tokens to signature verification", () => {
    for (const token of ["", "abc", "a.b", "a.!!!.c"]) {
      expect(decodeJwtExp(token)).toBeNull();
      expect(needsRefresh(token, NOW_MS)).toBe(false);
    }
  });
});

describe("ensureFreshTokens", () => {
  it("keeps a token with time to spare and does not call the issuer", async () => {
    const kv = new FakeKV();
    const tokens = { access: jwt(NOW_S + 900), refresh: "user:r0" };
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(tokens.access, tokens.refresh)));
    const client = refresher(async () => ({ err: new Error("should not be called") }));

    const result = await ensureFreshTokens({ kv: kv.asKV(), sessionToken: SID, tokens, client, now: () => NOW_MS });
    expect(result).toEqual({ ok: true, tokens, source: "current" });
    expect(client.refresh).not.toHaveBeenCalled();
    expect(kv.puts).toHaveLength(0);
  });

  it("refreshes ahead of expiry and persists the rotated pair to KV", async () => {
    const kv = new FakeKV();
    const old = { access: jwt(NOW_S + 60, "old"), refresh: "user:r0" };
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(old.access, old.refresh)));
    const fresh = jwt(NOW_S + 900, "new");
    const client = refresher(async () => ({ err: false, tokens: { access: fresh, refresh: "user:r1" } }));

    const result = await ensureFreshTokens({ kv: kv.asKV(), sessionToken: SID, tokens: old, client, now: () => NOW_MS });

    expect(client.refresh).toHaveBeenCalledWith("user:r0");
    expect(result).toEqual({ ok: true, tokens: { access: fresh, refresh: "user:r1" }, source: "refreshed" });
    const saved = kv.session(SID);
    expect(saved.tokens).toEqual({ access: fresh, refresh: "user:r1" });
    expect(saved.user.email).toBe("admin@example.com");
    // Session lifetime is kept, not extended: ~3 days left.
    expect(kv.puts[0].expirationTtl).toBe(3 * 24 * 3600);
  });

  it("uses tokens another request already rotated instead of spending the old refresh token", async () => {
    const kv = new FakeKV();
    const old = { access: jwt(NOW_S + 30, "old"), refresh: "user:r0" };
    const rotated = { access: jwt(NOW_S + 880, "rotated"), refresh: "user:r1" };
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(rotated.access, rotated.refresh)));
    const client = refresher(async () => ({ err: new Error("should not be called") }));

    const result = await ensureFreshTokens({ kv: kv.asKV(), sessionToken: SID, tokens: old, client, now: () => NOW_MS });

    expect(result).toEqual({ ok: true, tokens: rotated, source: "stored" });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("refreshes with the newest stored refresh token when the stored access token is also near expiry", async () => {
    const kv = new FakeKV();
    const old = { access: jwt(NOW_S - 600, "old"), refresh: "user:r0" };
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(jwt(NOW_S + 10, "newer"), "user:r1")));
    const client = refresher(async () => ({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "user:r2" } }));

    const result = await ensureFreshTokens({ kv: kv.asKV(), sessionToken: SID, tokens: old, client, now: () => NOW_MS });

    expect(client.refresh).toHaveBeenCalledWith("user:r1");
    expect(result.ok && result.source).toBe("refreshed");
    expect(kv.session(SID).tokens.refresh).toBe("user:r2");
  });

  it("keeps a still-valid access token when the refresh fails", async () => {
    const kv = new FakeKV();
    const tokens = { access: jwt(NOW_S + 60), refresh: "user:r0" };
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(tokens.access, tokens.refresh)));
    for (const impl of [
      async () => ({ err: new Error("InvalidRefreshTokenError") }),
      async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    ] as TokenRefresher["refresh"][]) {
      const result = await ensureFreshTokens({ kv: kv.asKV(), sessionToken: SID, tokens, client: refresher(impl), now: () => NOW_MS });
      expect(result).toEqual({ ok: true, tokens, source: "current" });
    }
    expect(kv.puts).toHaveLength(0);
  });

  it("fails when the access token has expired and the refresh is rejected", async () => {
    const kv = new FakeKV();
    const tokens = { access: jwt(NOW_S - 5), refresh: "user:r0" };
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(tokens.access, tokens.refresh)));
    const client = refresher(async () => ({ err: new Error("InvalidRefreshTokenError") }));

    const result = await ensureFreshTokens({ kv: kv.asKV(), sessionToken: SID, tokens, client, now: () => NOW_MS });
    expect(result.ok).toBe(false);
  });
});

describe("persistSessionTokens", () => {
  it("is a no-op for a session that is gone", async () => {
    const kv = new FakeKV();
    await persistSessionTokens(kv.asKV(), SID, { access: "a", refresh: "r" }, NOW_MS);
    expect(kv.puts).toHaveLength(0);
  });

  it("never writes a TTL below KV's 60 s minimum", async () => {
    const kv = new FakeKV();
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession("a0", "r0", 10_000)));
    await persistSessionTokens(kv.asKV(), SID, { access: "a1", refresh: "r1" }, NOW_MS);
    expect(kv.puts[0].expirationTtl).toBe(60);
    expect(kv.session(SID).tokens).toEqual({ access: "a1", refresh: "r1" });
  });
});

describe("logout tombstone", () => {
  const issuer = "https://auth.example";

  function seeded(access = jwt(NOW_S + 60, "old")) {
    const kv = new FakeKV();
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(access, "user:r0")));
    return kv;
  }

  it("logout tombstones and deletes the session and revokes its refresh token", async () => {
    const kv = seeded();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await revokeSession({ kv: kv.asKV(), sessionToken: SID, issuer, clientId: "admin-client", fetch: fetchImpl as unknown as typeof fetch });

    expect(kv.store.has(`session:${SID}`)).toBe(false);
    expect(await isSessionRevoked(kv.asKV(), SID)).toBe(true);
    expect(kv.puts.find((p) => p.key === `revoked:${SID}`)?.expirationTtl).toBe(REVOKED_TTL_SECONDS);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${issuer}/token/revoke`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("token")).toBe("user:r0");
    expect(form.get("client_id")).toBe("admin-client");
  });

  it("logout still succeeds when the issuer has no /token/revoke yet (404) or is unreachable", async () => {
    for (const impl of [
      async () => new Response("Not Found", { status: 404 }),
      async () => {
        throw new Error("fetch failed");
      },
    ]) {
      const kv = seeded();
      await expect(
        revokeSession({ kv: kv.asKV(), sessionToken: SID, issuer, clientId: "c", fetch: vi.fn(impl) as unknown as typeof fetch }),
      ).resolves.toBeUndefined();
      expect(kv.store.has(`session:${SID}`)).toBe(false);
      expect(await isSessionRevoked(kv.asKV(), SID)).toBe(true);
    }
  });

  it("logout races refresh (logout while /token is in flight) -> stays logged out", async () => {
    const kv = seeded();
    const client = refresher(async () => {
      await revokeSession({ kv: kv.asKV(), sessionToken: SID });
      return { err: false, tokens: { access: jwt(NOW_S + 900), refresh: "user:r1" } };
    });

    const result = await ensureFreshTokens({
      kv: kv.asKV(), sessionToken: SID, tokens: { access: jwt(NOW_S + 60, "old"), refresh: "user:r0" }, client, now: () => NOW_MS,
    });

    expect(result).toMatchObject({ ok: false, revoked: true });
    expect(kv.store.has(`session:${SID}`)).toBe(false);
  });

  it("logout landing between persist's read and put -> the write is undone", async () => {
    const kv = seeded();
    kv.beforePut = async () => {
      await revokeSession({ kv: kv.asKV(), sessionToken: SID });
    };

    const saved = await persistSessionTokens(kv.asKV(), SID, { access: "a1", refresh: "user:r1" }, NOW_MS);

    expect(saved).toBe(false);
    expect(kv.store.has(`session:${SID}`)).toBe(false);
  });

  it("never refreshes or writes back a session that is already logged out", async () => {
    const kv = seeded();
    await kv.put(`revoked:${SID}`, "1"); // tombstone visible, stale session still readable
    const client = refresher(async () => ({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "user:r1" } }));

    const result = await ensureFreshTokens({
      kv: kv.asKV(), sessionToken: SID, tokens: { access: jwt(NOW_S + 60, "old"), refresh: "user:r0" }, client, now: () => NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, revoked: true });
    expect(client.refresh).not.toHaveBeenCalled();
    expect(await persistSessionTokens(kv.asKV(), SID, { access: "a1", refresh: "r1" }, NOW_MS)).toBe(false);
    expect(kv.session(SID).tokens.refresh).toBe("user:r0"); // untouched
  });
});
