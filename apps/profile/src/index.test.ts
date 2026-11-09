/**
 * The profile worker's sign-in routing: no landing page, sign-in straight
 * through auth (silent when the browser is signed in), return path kept,
 * tokens refreshed, and silent re-auth when they lapse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV, NOW_MS, NOW_S, jwt } from "./test-helpers";
import { LOGIN_COOKIE } from "./sign-in";
import { revokedKey, sessionKey } from "./session-store";

const client = { exchange: vi.fn(), verify: vi.fn(), refresh: vi.fn() };
vi.mock("@al-ummah-now/openauth/client", () => ({ createClient: () => client }));

const { default: worker } = await import("./index");

const APP = "https://profile.auth.qa.alummahnow.net";
const AUTH = "https://auth.qa.alummahnow.net";
const USER = { id: "u1", email: "a@example.com", roles: ["Member"] };

let kv: FakeKV;
const env = () => ({ AUTH_STORAGE: kv.asKV(), AUTH_SERVER_URL: AUTH, APP_URL: APP, APP_ENV: "qa" });

async function get(path: string, cookie = "") {
  const req = new Request(new URL(path, APP), { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  return worker.fetch(req, env() as never, {} as ExecutionContext);
}

/** Set-Cookie values (Node's Headers has getSetCookie; the Workers types lack it). */
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function cookiePair(res: Response, name: string): string | null {
  const c = setCookies(res).find((v) => v.startsWith(`${name}=`));
  return c ? c.split(";")[0] : null;
}

function seedSession(access: string, refresh = "r0", token = "sid-1") {
  kv.store.set(
    sessionKey(token),
    JSON.stringify({ user: USER, tokens: { access, refresh }, expiresAt: new Date(NOW_MS + 86400_000).toISOString() }),
  );
  return `profile_session=${token}`;
}

describe("profile sign-in routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    kv = new FakeKV();
    client.exchange.mockReset();
    client.verify.mockReset();
    client.refresh.mockReset();
  });

  it("no session -> 302 into /login (no landing page), keeping the path", async () => {
    const res = await get("/?lang=ar");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?return=%2F%3Flang%3Dar");
  });

  it("/login -> auth /authorize with NO prompt, state bound to the return path", async () => {
    const res = await get("/login?return=%2F%3Flang%3Dar");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe(`${AUTH}/authorize`);
    expect(url.searchParams.get("prompt")).toBeNull();
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP}/callback`);
    const state = url.searchParams.get("state")!;
    expect(cookiePair(res, LOGIN_COOKIE)).toBe(`${LOGIN_COOKIE}=${state}.${encodeURIComponent("/?lang=ar")}`);
    // The sign-in pages follow the Arabic the profile link asked for
    expect(url.searchParams.get("lang")).toBe("ar");
  });

  it("/login without an Arabic return path sends no lang (sign-in defaults to English)", async () => {
    for (const ret of ["/", "/?lang=fr", "/?lang=constructor"]) {
      const url = new URL((await get(`/login?return=${encodeURIComponent(ret)}`)).headers.get("location")!);
      expect(url.searchParams.has("lang")).toBe(false);
    }
  });

  it("/login passes prompt=none and prompt=login, never anything else", async () => {
    const prompt = async (p: string) => new URL((await get(`/login?prompt=${p}`)).headers.get("location")!).searchParams.get("prompt");
    expect(await prompt("none")).toBe("none");
    expect(await prompt("login")).toBe("login");
    expect(await prompt("select_account")).toBeNull();
  });

  it("callback with a code -> session, back to the saved path, old session ended", async () => {
    const login = await get("/login?return=%2F%3Flang%3Dar");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    client.exchange.mockResolvedValue({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "r0" } });
    client.verify.mockResolvedValue({ subject: { type: "user", properties: USER } });
    const old = seedSession(jwt(NOW_S + 900), "r-old", "old-sid");

    const res = await get(`/callback?code=c1&state=${state}`, `${cookiePair(login, LOGIN_COOKIE)}; ${old}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?lang=ar");
    const sid = cookiePair(res, "profile_session")!.split("=")[1];
    expect(kv.session(sid).user).toEqual(USER);
    expect(setCookies(res).some((c) => c.startsWith(`${LOGIN_COOKIE}=;`))).toBe(true);
    expect(kv.store.has(sessionKey("old-sid"))).toBe(false);
    expect(kv.store.has(revokedKey("old-sid"))).toBe(true);
  });

  describe("callback state check (login CSRF)", () => {
    const cases: Array<[string, string, string]> = [
      ["missing state", "/callback?code=c1", `${LOGIN_COOKIE}=mine.${encodeURIComponent("/")}`],
      ["mismatched state", "/callback?code=c1&state=forged", `${LOGIN_COOKIE}=mine.${encodeURIComponent("/")}`],
      ["missing login cookie", "/callback?code=c1&state=mine", ""],
    ];
    for (const [name, path, loginCookieHeader] of cases) {
      it(`${name} -> rejected: no token exchange, the old session is not ended`, async () => {
        const old = seedSession(jwt(NOW_S + 900), "r-old", "old-sid");
        const res = await get(path, [loginCookieHeader, old].filter(Boolean).join("; "));
        expect(res.status).toBe(400);
        const html = await res.text();
        expect(html).toContain('href="/login"');
        expect(html).not.toMatch(/invalid_state/i);
        expect(client.exchange).not.toHaveBeenCalled();
        expect(kv.store.has(sessionKey("old-sid"))).toBe(true);
        expect(kv.store.has(revokedKey("old-sid"))).toBe(false);
        expect(cookiePair(res, "profile_session")).toBeNull();
        expect(setCookies(res).some((c) => c.startsWith(`${LOGIN_COOKIE}=;`))).toBe(true);
      });
    }

    it("an error callback with a forged state is rejected too", async () => {
      const res = await get("/callback?error=login_required&state=forged", `${LOGIN_COOKIE}=mine.%2F`);
      expect(res.status).toBe(400);
    });
  });

  it("login_required (silent sign-in found no account) -> the sign-in form via /login without prompt", async () => {
    const res = await get(`/callback?error=login_required&state=s1`, `${LOGIN_COOKIE}=s1.${encodeURIComponent("/?lang=ar")}`);
    expect(res.headers.get("location")).toBe("/login?return=%2F%3Flang%3Dar");
  });

  it("other callback errors render the page signed out (no redirect loop)", async () => {
    const res = await get(`/callback?error=access_denied&state=s1`, `${LOGIN_COOKIE}=s1.%2F`);
    expect(res.headers.get("location")).toBe("/?error=access_denied");
    const page = await get("/?error=access_denied");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="loggedOutView"');
  });

  it("signed in -> the page, no prompt", async () => {
    const res = await get("/", seedSession(jwt(NOW_S + 900)));
    expect(res.status).toBe(200);
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the access token before it expires and keeps the session", async () => {
    const next = jwt(NOW_S + 900, "new");
    client.refresh.mockResolvedValue({ err: false, tokens: { access: next, refresh: "r1" } });
    const res = await get("/", seedSession(jwt(NOW_S + 30)));
    expect(res.status).toBe(200);
    expect(kv.session("sid-1").tokens).toEqual({ access: next, refresh: "r1" });
  });

  it("refresh failure after expiry -> silent re-auth (prompt=none), session ended", async () => {
    client.refresh.mockResolvedValue({ err: new Error("invalid_grant") });
    const res = await get("/", seedSession(jwt(NOW_S - 30)));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?return=%2F&prompt=none");
    expect(kv.store.has(sessionKey("sid-1"))).toBe(false);
  });

  it("/api/me refreshes too and answers 401 once the session lapsed", async () => {
    client.refresh.mockResolvedValue({ err: new Error("invalid_grant") });
    expect((await get("/api/me", seedSession(jwt(NOW_S - 30)))).status).toBe(401);
    expect((await get("/api/me", seedSession(jwt(NOW_S + 900), "r0", "sid-2"))).status).toBe(200);
  });

  it("/logout (single sign-out) ends the session for good and continues auth's chain", async () => {
    const next = `${AUTH}/logout?step=1`;
    const res = await get(`/logout?next=${encodeURIComponent(next)}`, seedSession(jwt(NOW_S + 900)));
    expect(res.headers.get("location")).toBe(next);
    expect(kv.store.has(sessionKey("sid-1"))).toBe(false);
    expect(kv.store.has(revokedKey("sid-1"))).toBe(true);
    expect((await get("/", "profile_session=sid-1")).headers.get("location")).toBe("/login?return=%2F");
  });
});
