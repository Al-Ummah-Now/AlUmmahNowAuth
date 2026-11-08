import { describe, expect, it, vi } from "vitest";
import {
  decodeJwtExp,
  ensureFreshTokens,
  needsRefresh,
  persistSessionTokens,
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
