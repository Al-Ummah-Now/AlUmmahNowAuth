/**
 * Auth admin sign-in: no landing page, /login goes straight to auth with no
 * prompt (silent when the browser is signed in), the return path is kept,
 * and lapsed tokens re-authorize silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKV, NOW_MS, NOW_S, jwt, storedSession } from "../lib/test-helpers";
import { LOGIN_COOKIE } from "../lib/sign-in";

const client = {
  authorize: vi.fn(async (redirectUri: string) => ({
    url: `https://auth.example/authorize?client_id=c&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=st-1`,
    challenge: { state: "st-1" },
  })),
  exchange: vi.fn(),
  verify: vi.fn(),
  refresh: vi.fn(),
};
vi.mock("../lib/openauth.client.server", () => ({ getOpenAuthClient: () => client, subjects: {} }));

const login = await import("./login");
const callback = await import("./auth.callback");
const index = await import("./_index");

const APP = "https://admin.auth.example";
const ADMIN = { id: "u1", email: "admin@example.com", roles: ["Admin"] };
let kv: FakeKV;

function args(path: string, cookie = "") {
  const request = new Request(new URL(path, APP), { headers: cookie ? { Cookie: cookie } : {} });
  return {
    request,
    params: {},
    context: { cloudflare: { env: { AUTH_STORAGE: kv.asKV(), AUTH_SERVER_URL: "https://auth.example", APP_URL: APP }, ctx: undefined } },
  } as never;
}

async function settle(p: Promise<unknown>): Promise<Response> {
  try {
    const value = await p;
    return value as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

describe("auth admin sign-in routes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    kv = new FakeKV();
    client.exchange.mockReset();
    client.verify.mockReset();
    client.refresh.mockReset();
  });

  it("dashboard without a session -> 302 into /login (no 'Admin Sign In' page), keeping the path", async () => {
    const res = await settle(index.loader(args("/?tab=1")));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect")).toBe("/?tab=1");
    expect(location.searchParams.get("prompt")).toBeNull();
  });

  it("/login -> auth /authorize with NO prompt and the return path bound to the state", async () => {
    const res = await settle(login.loader(args("/login?redirect=%2Fusers")));
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("Location")!);
    expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
    expect(url.searchParams.get("prompt")).toBeNull();
    expect(setCookies(res)[0].split(";")[0]).toBe(`${LOGIN_COOKIE}=st-1.${encodeURIComponent("/users")}`);
  });

  it("/login passes prompt=none and prompt=login only", async () => {
    const prompt = async (p: string) =>
      new URL((await settle(login.loader(args(`/login?prompt=${p}`)))).headers.get("Location")!).searchParams.get("prompt");
    expect(await prompt("none")).toBe("none");
    expect(await prompt("login")).toBe("login");
    expect(await prompt("select_account")).toBeNull();
  });

  it("/login?error= renders a retry link instead of redirecting again", async () => {
    const data = (await login.loader(args("/login?error=boom&redirect=%2Fusers"))) as { error: string; retryUrl: string };
    expect(data).toEqual({ error: "boom", retryUrl: "/login?redirect=%2Fusers" });
  });

  it("callback -> admin session, back to the saved path, previous session ended", async () => {
    client.exchange.mockResolvedValue({ err: false, tokens: { access: jwt(NOW_S + 900), refresh: "r0" } });
    client.verify.mockResolvedValue({ subject: { type: "user", properties: ADMIN } });
    kv.store.set("session:old", JSON.stringify(storedSession(jwt(NOW_S + 900), "r-old")));

    const res = await settle(
      callback.loader(args("/auth/callback?code=c&state=st-1", `${LOGIN_COOKIE}=st-1.${encodeURIComponent("/users")}; auth_session=old`)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/users");
    const cookies = setCookies(res);
    const sid = cookies.find((c) => c.startsWith("auth_session="))!.split(";")[0].split("=")[1];
    expect(kv.session(sid).user).toEqual(ADMIN);
    expect(cookies.some((c) => c.startsWith(`${LOGIN_COOKIE}=;`))).toBe(true);
    expect(kv.store.has("session:old")).toBe(false);
    expect(kv.store.has("revoked:old")).toBe(true);
  });

  it("callback login_required -> /login without prompt (the form), keeping the path", async () => {
    const res = await settle(callback.loader(args("/auth/callback?error=login_required&state=st-1", `${LOGIN_COOKIE}=st-1.${encodeURIComponent("/roles")}`)));
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Froles");
  });

  it("other callback errors go to /login?error= (shown, not looped)", async () => {
    const res = await settle(callback.loader(args("/auth/callback?error=access_denied")));
    expect(res.headers.get("Location")).toBe("/login?redirect=%2F&error=access_denied");
  });

  it("lapsed tokens (refresh rejected after expiry) -> silent re-auth with prompt=none", async () => {
    kv.store.set("session:sid", JSON.stringify(storedSession(jwt(NOW_S - 60), "r0")));
    client.refresh.mockResolvedValue({ err: new Error("InvalidRefreshTokenError") });
    const res = await settle(index.loader(args("/?x=1", "auth_session=sid")));
    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("prompt")).toBe("none");
    expect(location.searchParams.get("redirect")).toBe("/?x=1");
  });
});
