import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  endSession,
  ensureFreshTokens,
  getSession,
  needsRefresh,
  persistSessionTokens,
  revokedKey,
  sessionKey,
} from "./session-store";
import { FakeKV, NOW_MS, NOW_S, jwt } from "./test-helpers";

describe("needsRefresh", () => {
  it("refreshes within the skew and treats unreadable tokens as expired", () => {
    expect(needsRefresh(jwt(NOW_S + 900), NOW_MS)).toBe(false);
    expect(needsRefresh(jwt(NOW_S + 60), NOW_MS)).toBe(true);
    expect(needsRefresh(jwt(NOW_S - 1), NOW_MS)).toBe(true);
    expect(needsRefresh("not-a-jwt", NOW_MS)).toBe(true);
  });
});

describe("profile session store", () => {
  let kv: FakeKV;
  const client = { refresh: vi.fn() };
  const user = { id: "u1", email: "a@example.com", roles: [] };

  beforeEach(() => {
    kv = new FakeKV();
    client.refresh.mockReset();
  });

  async function session(access: string, refresh = "r0") {
    const token = await createSession(kv.asKV(), { user, tokens: { access, refresh } }, NOW_MS);
    return token;
  }

  it("keeps a token that is not near expiry", async () => {
    const token = await session(jwt(NOW_S + 900));
    const s = (await getSession(kv.asKV(), token, NOW_MS))!;
    const fresh = await ensureFreshTokens({ kv: kv.asKV(), token, tokens: s.tokens, client, now: () => NOW_MS });
    expect(fresh).toMatchObject({ ok: true, refreshed: false });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("refreshes before the 15-minute access token expires and saves the rotated pair", async () => {
    const token = await session(jwt(NOW_S + 60, "old"));
    const next = jwt(NOW_S + 900, "new");
    client.refresh.mockResolvedValue({ err: false, tokens: { access: next, refresh: "r1" } });
    const s = (await getSession(kv.asKV(), token, NOW_MS))!;
    const fresh = await ensureFreshTokens({ kv: kv.asKV(), token, tokens: s.tokens, client, now: () => NOW_MS });
    expect(fresh).toEqual({ ok: true, tokens: { access: next, refresh: "r1" }, refreshed: true });
    expect(client.refresh).toHaveBeenCalledWith("r0");
    expect(kv.session(token).tokens).toEqual({ access: next, refresh: "r1" });
  });

  it("uses tokens a concurrent request already rotated instead of spending the old refresh token", async () => {
    const old = jwt(NOW_S + 60, "old");
    const token = await session(old);
    const rotated = jwt(NOW_S + 900, "rotated");
    await persistSessionTokens(kv.asKV(), token, { access: rotated, refresh: "r1" }, NOW_MS);
    const fresh = await ensureFreshTokens({ kv: kv.asKV(), token, tokens: { access: old, refresh: "r0" }, client, now: () => NOW_MS });
    expect(fresh).toMatchObject({ ok: true, tokens: { access: rotated } });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("keeps working on a failed refresh while the access token is still valid", async () => {
    const token = await session(jwt(NOW_S + 60));
    client.refresh.mockResolvedValue({ err: new Error("x") });
    const fresh = await ensureFreshTokens({ kv: kv.asKV(), token, tokens: kv.session(token).tokens, client, now: () => NOW_MS });
    expect(fresh).toMatchObject({ ok: true, refreshed: false });
  });

  it("reports failure once the access token expired and refresh fails (network error too)", async () => {
    const token = await session(jwt(NOW_S - 10));
    client.refresh.mockRejectedValue(new Error("network"));
    const fresh = await ensureFreshTokens({ kv: kv.asKV(), token, tokens: kv.session(token).tokens, client, now: () => NOW_MS });
    expect(fresh).toEqual({ ok: false, reason: "network" });
  });

  it("never revives a logged-out session", async () => {
    const token = await session(jwt(NOW_S + 60));
    const tokens = kv.session(token).tokens;
    client.refresh.mockImplementation(async () => {
      await endSession(kv.asKV(), token); // logout lands mid-refresh
      return { err: false, tokens: { access: jwt(NOW_S + 900), refresh: "r1" } };
    });
    const fresh = await ensureFreshTokens({ kv: kv.asKV(), token, tokens, client, now: () => NOW_MS });
    expect(fresh.ok).toBe(false);
    expect(kv.store.has(sessionKey(token))).toBe(false);
    expect(kv.store.has(revokedKey(token))).toBe(true);
    expect(await getSession(kv.asKV(), token, NOW_MS)).toBeNull();
  });

  it("drops expired and corrupt sessions", async () => {
    const token = await session(jwt(NOW_S + 900));
    expect(await getSession(kv.asKV(), token, NOW_MS + 8 * 24 * 3600 * 1000)).toBeNull();
    kv.store.set(sessionKey("bad"), "{");
    expect(await getSession(kv.asKV(), "bad", NOW_MS)).toBeNull();
    expect(await getSession(kv.asKV(), null, NOW_MS)).toBeNull();
  });
});

describe("endSession", () => {
  it("writes no tombstone for a token without a session", async () => {
    const kv = new FakeKV();
    await endSession(kv.asKV(), "made-up");
    expect(kv.store.size).toBe(0);
  });
});
