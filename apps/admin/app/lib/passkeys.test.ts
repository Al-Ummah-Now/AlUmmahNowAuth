import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV, NOW_MS, NOW_S, fakeD1, storedSession } from "./test-helpers";

/** Staff passkeys in the auth admin (AUTH-PASSKEYS): the consumer rule and step-up. */
const client = { refresh: vi.fn(), verify: vi.fn(), authorize: vi.fn() };
vi.mock("./openauth.client.server", () => ({ getOpenAuthClient: () => client, subjects: {} }));

const { requireAuth, requireStepUp } = await import("./auth.server");
const { sessionId } = await import("./session-tokens.server");
const { loginPath, parseMaxAge, withPrompt } = await import("./sign-in");

const SID = "sid-pk";
const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (claims: Record<string, unknown>) => `${b64url({ alg: "ES256" })}.${b64url({ mode: "access", exp: NOW_S + 900, ...claims })}.sig`;
const ADMIN = { type: "user", properties: { id: "u1", email: "admin@example.com", roles: ["Admin"] } };

describe("auth admin: staff passkeys", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    kv = new FakeKV();
    db = await fakeD1();
    client.verify.mockReset();
    client.verify.mockResolvedValue({ subject: ADMIN });
  });
  afterEach(() => vi.useRealTimers());

  const env = () => ({ AUTH_STORAGE: kv.asKV(), AUTH_DB: db, AUTH_SERVER_URL: "https://auth.example" });
  async function signedIn(access: string) {
    const s = storedSession(access, "user:r0");
    await db
      .prepare(
        `INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, created_at, updated_at)
         VALUES (?1, 'admin', ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(await sessionId(SID), JSON.stringify(s.user), access, "user:r0", Date.parse(s.expiresAt), NOW_MS)
      .run();
    return new Request("https://admin.auth.example/users?x=1", { headers: { Cookie: `auth_session=${SID}` } });
  }

  it("past the deadline without a passkey: redirected to Passkey needed", async () => {
    const req = await signedIn(token({ amr: ["pwd"], properties: { roles: ["Admin"], passkey_deadline: NOW_S - 1 } }));
    const thrown = await requireAuth(req, env(), true).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect(new URL((thrown as Response).headers.get("Location")!).pathname).toBe("/passkey-needed");
    expect((thrown as Response).headers.get("Location")).toContain(encodeURIComponent("/users?x=1"));
  });

  it("with a passkey sign-in, or in the grace period, the admin opens (grace shows the banner date)", async () => {
    const withPasskey = await requireAuth(await signedIn(token({ amr: ["passkey"], properties: { roles: ["Admin"], passkey_deadline: NOW_S - 1 } })), env(), true);
    expect(withPasskey.id).toBe("u1");
    expect((withPasskey as { passkeyGraceUntil?: number }).passkeyGraceUntil).toBeUndefined();
  });

  it("grace: access with the deadline for the banner", async () => {
    const user = await requireAuth(await signedIn(token({ amr: ["pwd"], properties: { roles: ["Admin"], passkey_deadline: NOW_S + 3600 } })), env(), true);
    expect((user as { passkeyGraceUntil?: number }).passkeyGraceUntil).toBe(NOW_S + 3600);
  });

  it("step-up: a sign-in older than 15 minutes goes to sign-in with prompt=login&max_age=900", () => {
    const req = new Request("https://admin.auth.example/users", { method: "POST" });
    expect(() => requireStepUp({ claims: { auth_time: NOW_S - 60, amr: ["passkey"] } }, req, "/users")).not.toThrow();
    let thrown: unknown;
    try {
      requireStepUp({ claims: { auth_time: NOW_S - 901 } }, req, "/users");
    } catch (e) {
      thrown = e;
    }
    const to = new URL((thrown as Response).headers.get("Location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("prompt")).toBe("login");
    expect(to.searchParams.get("max_age")).toBe("900");
    expect(to.searchParams.get("redirect")).toBe("/users");
    // No claims (older token): step up too
    expect(() => requireStepUp({}, req)).toThrow();
  });

  it("login carries max_age to the authorize URL", () => {
    expect(loginPath("/x", "login", 900)).toBe("/login?redirect=%2Fx&prompt=login&max_age=900");
    expect(parseMaxAge("900")).toBe(900);
    expect(parseMaxAge("-1")).toBeUndefined();
    const url = new URL(withPrompt("https://auth.example/authorize?a=1", "login", 900));
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("900");
  });
});
