import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRecentSignIn,
  orchestrateAccountDeletion,
  REAUTH_MAX_AGE_SECONDS,
  resolveVideosApiUrl,
} from "./delete-account";
import { renderDeleteAccountPage, renderHomePage } from "./page";
import { FakeKV, NOW_MS, NOW_S, fakeD1 } from "./test-helpers";
import { getSession, sessionId } from "./session-store";

const client = { exchange: vi.fn(), verify: vi.fn(), refresh: vi.fn() };
vi.mock("@al-ummah-now/openauth/client", () => ({ createClient: () => client }));

const { default: worker } = await import("./index");

const APP = "https://profile.auth.qa.alummahnow.net";
const AUTH = "https://auth.qa.alummahnow.net";
const VIDEOS_API = "https://videos.api.qa.alummahnow.net";
const USER = { id: "u-del-1", email: "delete-me@example.com", roles: ["Member"] };

function jwtWithAuthTime(exp: number, authTime?: number): string {
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({
    mode: "access",
    exp,
    ...(authTime === undefined ? {} : { auth_time: authTime }),
  })}.sig`;
}

describe("delete-account orchestration (AlUmmahNowAuth#532)", () => {
  it("resolves Videos API URL from explicit var or environment", () => {
    expect(resolveVideosApiUrl("https://custom.videos.test/", "qa")).toBe("https://custom.videos.test");
    expect(resolveVideosApiUrl(undefined, "production")).toBe("https://videos.api.alummahnow.net");
    expect(resolveVideosApiUrl(undefined, "qa")).toBe("https://videos.api.qa.alummahnow.net");
    expect(resolveVideosApiUrl(undefined, null)).toBeNull();
  });

  it("checks auth_time freshness before erasing any Videos data", async () => {
    const staleToken = jwtWithAuthTime(NOW_S + 900, NOW_S - REAUTH_MAX_AGE_SECONDS - 10);
    expect(isRecentSignIn(staleToken, NOW_MS)).toBe(false);
    expect(isRecentSignIn(jwtWithAuthTime(NOW_S + 900, NOW_S - 60), NOW_MS)).toBe(true);
    expect(isRecentSignIn(jwtWithAuthTime(NOW_S + 900), NOW_MS)).toBe(false);

    const fetchSpy = vi.fn();
    const res = await orchestrateAccountDeletion({
      accessToken: staleToken,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, status: 401, error: "insufficient_user_authentication", maxAge: REAUTH_MAX_AGE_SECONDS });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("erases Videos data across resume passes first, then deletes the Auth account", async () => {
    const freshToken = jwtWithAuthTime(NOW_S + 900, NOW_S - 30);
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url === `${VIDEOS_API}/api/privacy/data` && calls.length === 1) {
        return new Response(JSON.stringify({ success: true, complete: false, resumeToken: "tok-2" }), { status: 200 });
      }
      if (url === `${VIDEOS_API}/api/privacy/data` && calls.length === 2) {
        return new Response(JSON.stringify({ success: true, complete: true }), { status: 200 });
      }
      if (url === `${AUTH}/account`) {
        return new Response(JSON.stringify({ deleted: true, userId: USER.id, deletedAt: NOW_MS }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });

    const outcome = await orchestrateAccountDeletion({
      accessToken: freshToken,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: true, userId: USER.id, deletedAt: NOW_MS });
    expect(calls).toEqual([
      { url: `${VIDEOS_API}/api/privacy/data`, method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) },
      { url: `${VIDEOS_API}/api/privacy/data`, method: "DELETE", body: JSON.stringify({ confirm: "DELETE", resumeToken: "tok-2" }) },
      { url: `${AUTH}/account`, method: "DELETE", body: undefined },
    ]);
  });

  it("does not delete the Auth account if Videos erasure fails", async () => {
    const freshToken = jwtWithAuthTime(NOW_S + 900, NOW_S - 30);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/privacy/data")) return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    });

    const outcome = await orchestrateAccountDeletion({
      accessToken: freshToken,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, status: 502, error: "videos_erasure_failed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("profile worker /delete-account and DELETE /api/account", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  const origFetch = globalThis.fetch;

  const env = () => ({
    AUTH_STORAGE: kv.asKV(),
    AUTH_DB: db,
    AUTH_SERVER_URL: AUTH,
    APP_URL: APP,
    VIDEOS_API_URL: VIDEOS_API,
    APP_ENV: "qa",
  });

  async function seedSession(access: string, token = "sid-del") {
    await db
      .prepare(
        `INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, created_at, updated_at)
         VALUES (?1, 'profile', ?2, ?3, 'r0', ?4, ?5, ?5)`,
      )
      .bind(await sessionId(token), JSON.stringify(USER), access, NOW_MS + 86400_000, NOW_MS)
      .run();
    return `profile_session=${token}`;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    kv = new FakeKV();
    db = await fakeD1();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/themes/resolve")) return new Response("not found", { status: 404 });
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.useRealTimers();
  });

  it("GET /delete-account works signed out (200 OK) in en and ar, naming Al Ummah Now and Studio", async () => {
    const enRes = await worker.fetch(new Request(`${APP}/delete-account`), env() as never, {} as ExecutionContext);
    expect(enRes.status).toBe(200);
    const enHtml = await enRes.text();
    expect(enHtml).toContain("Al Ummah Now");
    expect(enHtml).toContain("Al Ummah Now Studio");
    expect(enHtml).toContain('data-testid="delete-account-signin"');
    expect(enHtml).toContain("prompt=login");
    expect(enHtml).toContain("30 days");

    const arRes = await worker.fetch(new Request(`${APP}/delete-account?lang=ar`), env() as never, {} as ExecutionContext);
    expect(arRes.status).toBe(200);
    const arHtml = await arRes.text();
    expect(arHtml).toContain('lang="ar" dir="rtl"');
    expect(arHtml).toContain("٣٠ يومًا");
    expect(arHtml).not.toContain("30 يوم");
    expect(arHtml).not.toContain("فيديو");
  });

  it("GET /delete-account signed in renders the accessible in-app dialog and never browser confirm/alert", async () => {
    const cookie = await seedSession(jwtWithAuthTime(NOW_S + 900, NOW_S - 30));
    const res = await worker.fetch(new Request(`${APP}/delete-account`, { headers: { Cookie: cookie } }), env() as never, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="delete-account-dialog"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(USER.email);
    expect(html).not.toMatch(/\bwindow\.(confirm|alert)\b|\bconfirm\(/);
  });

  it("profile home page links to /delete-account in both locales", () => {
    for (const locale of ["en", "ar"] as const) {
      const html = renderHomePage({
        locale,
        apps: [],
        user: USER,
        authServerUrl: AUTH,
        appUrl: APP,
        clientId: "profile",
      });
      const expectedHref = locale === "ar" ? "/delete-account?lang=ar" : "/delete-account";
      expect(html).toContain(`href="${expectedHref}"`);
    }
    const doneHtml = renderDeleteAccountPage({ locale: "en", user: null, authServerUrl: AUTH, deleted: true });
    expect(doneHtml).toContain('data-testid="delete-account-done"');
  });

  it("DELETE /api/account enforces CSRF Origin, confirmation word, step-up, and clears session on success", async () => {
    const freshToken = jwtWithAuthTime(NOW_S + 900, NOW_S - 20);
    const cookie = await seedSession(freshToken, "sid-ok");

    // Cross-origin blocked
    const csrf = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(csrf.status).toBe(403);

    // Missing confirmation rejected
    const badConfirm = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "NO" }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(badConfirm.status).toBe(400);

    // Full deletion succeeds and ends profile session
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u === `${VIDEOS_API}/api/privacy/data`) return new Response(JSON.stringify({ success: true, complete: true }), { status: 200 });
      if (u === `${AUTH}/account`) return new Response(JSON.stringify({ deleted: true, userId: USER.id, deletedAt: NOW_MS }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const ok = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true, userId: USER.id, deletedAt: NOW_MS });
    expect(await getSession({ db, kv: kv.asKV() }, "sid-ok", NOW_MS)).toBeNull();
    expect(ok.headers.get("Set-Cookie")).toContain("profile_session=;");
  });

  it("/logout keeps a safe same-origin ?return=/delete-account?deleted=1", async () => {
    const res = await worker.fetch(
      new Request(`${APP}/logout?return=${encodeURIComponent("/delete-account?deleted=1")}`, { redirect: "manual" }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(`${AUTH}/logout`);
    expect(loc.searchParams.get("return")).toBe(`${APP}/delete-account?deleted=1`);
  });
});
