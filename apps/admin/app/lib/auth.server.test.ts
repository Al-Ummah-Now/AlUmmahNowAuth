import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV, NOW_MS, NOW_S, jwt, storedSession } from "./test-helpers";

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

const SID = "sid-1";
const ADMIN = { type: "user", properties: { id: "u1", email: "admin@example.com", roles: ["Admin"] } };

function request() {
  return new Request("https://admin.auth.example/users", { headers: { Cookie: `auth_session=${SID}` } });
}

describe("requireAuth(…, true) token refresh", () => {
  let kv: FakeKV;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    kv = new FakeKV();
    client.refresh.mockReset();
    client.verify.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const env = () => ({ AUTH_STORAGE: kv.asKV(), AUTH_SERVER_URL: "https://auth.example" });

  it("refreshes ahead of expiry, saves the rotated tokens and verifies the new access token", async () => {
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(jwt(NOW_S + 90, "old"), "user:r0")));
    const fresh = jwt(NOW_S + 900, "new");
    client.refresh.mockResolvedValue({ err: false, tokens: { access: fresh, refresh: "user:r1", expiresIn: 900 } });
    client.verify.mockResolvedValue({ subject: ADMIN });

    const user = await requireAuth(request(), env(), true);

    expect(user).toEqual({ id: "u1", email: "admin@example.com", roles: ["Admin"] });
    expect(client.refresh).toHaveBeenCalledWith("user:r0");
    expect(client.verify).toHaveBeenCalledWith({}, fresh, { refresh: "user:r1" });
    expect(kv.session(SID).tokens).toEqual({ access: fresh, refresh: "user:r1" });
  });

  it("persists tokens that verify() refreshed itself", async () => {
    // Token readable as fresh to the skew check, but verify still rotated
    // (e.g. clock skew with the issuer): the rotated pair must be saved.
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(jwt(NOW_S + 900), "user:r0")));
    const rotated = { access: jwt(NOW_S + 1800, "v"), refresh: "user:r1", expiresIn: 900 };
    client.verify.mockResolvedValue({ subject: ADMIN, tokens: rotated });

    await requireAuth(request(), env(), true);

    expect(client.refresh).not.toHaveBeenCalled();
    expect(kv.session(SID).tokens).toEqual({ access: rotated.access, refresh: "user:r1" });
  });

  it("stays signed in across several expiries (the ~16-minute logout)", async () => {
    let n = 0;
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(jwt(NOW_S + 900, "t0"), "user:r0")));
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
    expect(kv.session(SID).tokens.refresh).toBe(`user:r${n}`);
  });

  it("does not touch a legacy session holding a 30-day access token", async () => {
    const legacy = jwt(NOW_S + 29 * 24 * 3600);
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(legacy, "user:r0")));
    client.verify.mockResolvedValue({ subject: ADMIN });

    await requireAuth(request(), env(), true);

    expect(client.refresh).not.toHaveBeenCalled();
    expect(client.verify).toHaveBeenCalledWith({}, legacy, { refresh: "user:r0" });
    expect(kv.puts).toHaveLength(0);
  });

  it("redirects to /login when the token expired and the refresh token is rejected", async () => {
    kv.store.set(`session:${SID}`, JSON.stringify(storedSession(jwt(NOW_S - 60), "user:r0")));
    client.refresh.mockResolvedValue({ err: new Error("InvalidRefreshTokenError") });

    const thrown = await requireAuth(request(), env(), true).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect(new URL((thrown as Response).headers.get("Location")!).pathname).toBe("/login");
    expect(client.verify).not.toHaveBeenCalled();
  });
});
