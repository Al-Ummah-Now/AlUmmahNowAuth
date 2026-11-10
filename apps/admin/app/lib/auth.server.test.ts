import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV, NOW_MS, NOW_S, fakeD1, jwt, storedSession } from "./test-helpers";

const client = {
  refresh: vi.fn(),
  verify: vi.fn(),
  authorize: vi.fn(async () => ({ url: "https://auth.example/authorize?x=1" })),
};

vi.mock("./openauth.client.server", () => ({
  getOpenAuthClient: () => client,
  subjects: {},
}));

const { requireAuth } = await import("./auth.server");
const { getSession, revokeSession, sessionId } = await import("./session-tokens.server");

const SID = "sid-1";
const ADMIN = { type: "user", properties: { id: "u1", email: "admin@example.com", roles: ["Admin"] } };

function request() {
  return new Request("https://admin.auth.example/users", { headers: { Cookie: `auth_session=${SID}` } });
}

describe("requireAuth(…, true) token refresh", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;

  beforeEach(async () => {
    // Only the clock: the D1 stand-in yields with real timers
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    kv = new FakeKV();
    db = await fakeD1();
    client.refresh.mockReset();
    client.verify.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const env = () => ({ AUTH_STORAGE: kv.asKV(), AUTH_DB: db, AUTH_SERVER_URL: "https://auth.example" });
  const stores = () => ({ db, kv: kv.asKV() });
  const tokensNow = async () => (await getSession(stores(), SID))?.tokens;
  async function seed(access: string, refresh: string) {
    const s = storedSession(access, refresh);
    await db
      .prepare(
        `INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, created_at, updated_at)
         VALUES (?1, 'admin', ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(await sessionId(SID), JSON.stringify(s.user), access, refresh, Date.parse(s.expiresAt), NOW_MS)
      .run();
  }

  it("refreshes ahead of expiry, saves the rotated tokens and verifies the new access token", async () => {
    await seed(jwt(NOW_S + 90, "old"), "user:r0");
    const fresh = jwt(NOW_S + 900, "new");
    client.refresh.mockResolvedValue({ err: false, tokens: { access: fresh, refresh: "user:r1", expiresIn: 900 } });
    client.verify.mockResolvedValue({ subject: ADMIN });

    const user = await requireAuth(request(), env(), true);

    expect(user).toEqual({ id: "u1", email: "admin@example.com", roles: ["Admin"] });
    expect(client.refresh).toHaveBeenCalledWith("user:r0");
    expect(client.verify).toHaveBeenCalledWith({}, fresh);
    expect(await tokensNow()).toEqual({ access: fresh, refresh: "user:r1" });
  });

  it("never lets verify() refresh on its own, outside the per-session lock (AD-1)", async () => {
    await seed(jwt(NOW_S + 900), "user:r0");
    client.verify.mockResolvedValue({ subject: ADMIN });

    await requireAuth(request(), env(), true);

    expect(client.refresh).not.toHaveBeenCalled();
    expect(client.verify).toHaveBeenCalledWith({}, expect.any(String));
    expect(client.verify.mock.calls[0]).toHaveLength(2);
  });

  it("AD-1: 30 concurrent admin requests at the refresh threshold make one refresh", async () => {
    await seed(jwt(NOW_S + 90, "old"), "user:r0");
    client.refresh.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { err: false, tokens: { access: jwt(NOW_S + 900, "new"), refresh: "user:r1", expiresIn: 900 } };
    });
    client.verify.mockResolvedValue({ subject: ADMIN });
    const users = await Promise.all(Array.from({ length: 30 }, () => requireAuth(request(), env(), true)));
    expect(users.every((u) => u.id === "u1")).toBe(true);
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  it("stays signed in across several expiries (the ~16-minute logout)", async () => {
    let n = 0;
    await seed(jwt(NOW_S + 900, "t0"), "user:r0");
    client.refresh.mockImplementation(async (refresh: string) => {
      // The issuer only accepts the latest refresh token.
      if (refresh !== `user:r${n}`) return { err: new Error("InvalidRefreshTokenError") };
      n += 1;
      return { err: false, tokens: { access: jwt(Math.floor(Date.now() / 1000) + 900, `t${n}`), refresh: `user:r${n}`, expiresIn: 900 } };
    });
    client.verify.mockResolvedValue({ subject: ADMIN });

    for (let minute = 0; minute <= 60; minute += 5) {
      vi.setSystemTime(NOW_MS + minute * 60_000);
      await expect(requireAuth(request(), env(), true)).resolves.toMatchObject({ id: "u1" });
    }
    expect(n).toBeGreaterThanOrEqual(4);
    expect((await tokensNow())?.refresh).toBe(`user:r${n}`);
  });

  it("a KV session from before AD-1 (30-day access token) keeps working, copied to D1, not refreshed", async () => {
    const legacy = jwt(NOW_S + 29 * 24 * 3600);
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(legacy, "user:r0")));
    client.verify.mockResolvedValue({ subject: ADMIN });

    await requireAuth(request(), env(), true);

    expect(client.refresh).not.toHaveBeenCalled();
    expect(client.verify).toHaveBeenCalledWith({}, legacy);
    expect(kv.puts).toHaveLength(0);
    expect(db.rows()).toHaveLength(1);
  });

  it("redirects to /login when the token expired and the refresh token is rejected", async () => {
    await seed(jwt(NOW_S - 60), "user:r0");
    client.refresh.mockResolvedValue({ err: new Error("InvalidRefreshTokenError") });

    const thrown = await requireAuth(request(), env(), true).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect(new URL((thrown as Response).headers.get("Location")!).pathname).toBe("/login");
    expect(client.verify).not.toHaveBeenCalled();
  });

  it("logout races refresh -> stays logged out", async () => {
    await seed(jwt(NOW_S + 60, "old"), "user:r0");
    client.refresh.mockImplementation(async () => {
      // The admin logs out in another tab while this request refreshes.
      await revokeSession({ stores: stores(), sessionToken: SID });
      return { err: false, tokens: { access: jwt(NOW_S + 900), refresh: "user:r1", expiresIn: 900 } };
    });

    const thrown = await requireAuth(request(), env(), true).catch((e: unknown) => e);
    expect((thrown as Response).status).toBe(302);
    expect(await getSession(stores(), SID)).toBeNull();

    // And the next request with the old cookie is not let back in.
    const again = await requireAuth(request(), env(), true).catch((e: unknown) => e);
    expect(new URL((again as Response).headers.get("Location")!).pathname).toBe("/login");
  });

  it("a KV session logged out by the previous version (tombstone) is rejected", async () => {
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(jwt(NOW_S + 900), "user:r0")));
    kv.store.set(`revoked:${SID}`, "1");

    const thrown = await requireAuth(request(), env(), true).catch((e: unknown) => e);

    expect((thrown as Response).status).toBe(302);
    expect(client.verify).not.toHaveBeenCalled();
    expect(db.rows()).toEqual([]);
  });
});
