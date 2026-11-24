import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRecentSignIn,
  orchestrateAccountDeletion,
  PRECHECK_REAUTH_MAX_AGE_SECONDS,
  REAUTH_MAX_AGE_SECONDS,
  resolveVideosApiUrl,
  tokenUserIdOf,
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

function jwtWithClaims(exp: number, authTime?: number, userId: string | undefined = USER.id): string {
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({
    mode: "access",
    exp,
    ...(authTime === undefined ? {} : { auth_time: authTime }),
    ...(userId === undefined ? {} : { properties: { id: userId, email: USER.email, roles: USER.roles } }),
  })}.sig`;
}

describe("delete-account orchestration (AlUmmahNowAuth#532)", () => {
  it("resolves Videos API URL from explicit var or environment", () => {
    expect(resolveVideosApiUrl("https://custom.videos.test/", "qa")).toBe("https://custom.videos.test");
    expect(resolveVideosApiUrl(undefined, "production")).toBe("https://videos.api.alummahnow.net");
    expect(resolveVideosApiUrl(undefined, "qa")).toBe("https://videos.api.qa.alummahnow.net");
    expect(resolveVideosApiUrl(undefined, "local")).toBe("http://localhost:3086");
    expect(resolveVideosApiUrl(undefined, null)).toBeNull();
  });

  it("extracts token properties.id and rejects account mismatch before any upstream call", async () => {
    const tokenForB = jwtWithClaims(NOW_S + 900, NOW_S - 20, "u-other-b");
    expect(tokenUserIdOf(tokenForB)).toBe("u-other-b");
    const fetchSpy = vi.fn();
    const res = await orchestrateAccountDeletion({
      accessToken: tokenForB,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, status: 409, error: "account_mismatch" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces the 300s pre-check margin (inside Auth's 600s limit) before erasing any Videos data", async () => {
    // 595s old is inside Auth's 600s window, but must be rejected BEFORE erasing Videos data
    const nearExpiryToken = jwtWithClaims(NOW_S + 900, NOW_S - 595);
    expect(isRecentSignIn(nearExpiryToken, NOW_MS)).toBe(false);
    expect(isRecentSignIn(jwtWithClaims(NOW_S + 900, NOW_S - PRECHECK_REAUTH_MAX_AGE_SECONDS - 1), NOW_MS)).toBe(false);
    expect(isRecentSignIn(jwtWithClaims(NOW_S + 900, NOW_S - 60), NOW_MS)).toBe(true);
    expect(isRecentSignIn(jwtWithClaims(NOW_S + 900, NOW_S + 120), NOW_MS)).toBe(false);
    expect(isRecentSignIn(jwtWithClaims(NOW_S + 900), NOW_MS)).toBe(false);

    const fetchSpy = vi.fn();
    const res = await orchestrateAccountDeletion({
      accessToken: nearExpiryToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(res).toMatchObject({
      ok: false,
      status: 401,
      error: "insufficient_user_authentication",
      maxAge: PRECHECK_REAUTH_MAX_AGE_SECONDS,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs one bounded pass per request, carries resumeToken across retries, then deletes Auth", async () => {
    const freshToken = jwtWithClaims(NOW_S + 900, NOW_S - 30);
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    let videosCall = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url === `${VIDEOS_API}/api/privacy/data`) {
        videosCall += 1;
        if (videosCall === 1) {
          return new Response(JSON.stringify({ success: true, complete: false, resumeToken: "tok-2" }), { status: 200 });
        }
        if (videosCall === 2) {
          return new Response("temporary error", { status: 503 });
        }
        return new Response(JSON.stringify({ success: true, complete: true }), { status: 200 });
      }
      if (url === `${AUTH}/account`) {
        return new Response(JSON.stringify({ deleted: true, userId: USER.id, deletedAt: NOW_MS }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });

    // Pass 1 returns complete=false and resumeToken without calling Auth
    const pass1 = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(pass1).toEqual({ ok: true, complete: false, resumeToken: "tok-2" });

    // Pass 2 fails transiently and preserves resumeToken for retry
    const pass2Fail = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      resumeToken: "tok-2",
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(pass2Fail).toEqual({ ok: false, status: 502, error: "videos_erasure_failed", resumeToken: "tok-2" });

    // Retry of pass 2 resumes from tok-2, completes, and deletes Auth
    const pass2Retry = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      resumeToken: "tok-2",
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(pass2Retry).toEqual({ ok: true, complete: true, userId: USER.id, deletedAt: NOW_MS });

    expect(calls).toEqual([
      { url: `${VIDEOS_API}/api/privacy/data`, method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) },
      { url: `${VIDEOS_API}/api/privacy/data`, method: "DELETE", body: JSON.stringify({ confirm: "DELETE", resumeToken: "tok-2" }) },
      { url: `${VIDEOS_API}/api/privacy/data`, method: "DELETE", body: JSON.stringify({ confirm: "DELETE", resumeToken: "tok-2" }) },
      { url: `${AUTH}/account`, method: "DELETE", body: undefined },
    ]);
  });

  it("returns distinct content_erased_reauth_required (409) when Auth rejects 401 after Videos complete=true", async () => {
    const freshToken = jwtWithClaims(NOW_S + 900, NOW_S - 30);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/privacy/data")) {
        return new Response(JSON.stringify({ success: true, complete: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: "insufficient_user_authentication", max_age: REAUTH_MAX_AGE_SECONDS }),
        { status: 401 },
      );
    });

    const outcome = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({
      ok: false,
      status: 409,
      error: "content_erased_reauth_required",
      contentErased: true,
      maxAge: REAUTH_MAX_AGE_SECONDS,
    });
  });

  it("fails closed (503) when videosApiUrl is unconfigured so Auth is never deleted alone", async () => {
    const freshToken = jwtWithClaims(NOW_S + 900, NOW_S - 30);
    const fetchSpy = vi.fn();
    const outcome = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: null,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, status: 503, error: "videos_api_unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 502 (not a re-login loop 401) when Videos returns a non-step-up 401 (e.g. audience mismatch)", async () => {
    const freshToken = jwtWithClaims(NOW_S + 900, NOW_S - 30);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    const outcome = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, status: 502, error: "videos_erasure_failed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 401 step-up only when Videos explicitly asks for insufficient_user_authentication", async () => {
    const freshToken = jwtWithClaims(NOW_S + 900, NOW_S - 30);
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ error: "insufficient_user_authentication" }), { status: 401 }),
    );
    const outcome = await orchestrateAccountDeletion({
      accessToken: freshToken,
      expectedUserId: USER.id,
      authServerUrl: AUTH,
      videosApiUrl: VIDEOS_API,
      nowMs: NOW_MS,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({
      ok: false,
      status: 401,
      error: "insufficient_user_authentication",
      maxAge: PRECHECK_REAUTH_MAX_AGE_SECONDS,
    });
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

  async function seedSession(access: string, token = "sid-del", user = USER) {
    await db
      .prepare(
        `INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, created_at, updated_at)
         VALUES (?1, 'profile', ?2, ?3, 'r0', ?4, ?5, ?5)`,
      )
      .bind(await sessionId(token), JSON.stringify(user), access, NOW_MS + 86400_000, NOW_MS)
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
    expect(enHtml).toContain("Al\u00A0Ummah\u00A0Now");
    expect(enHtml).toContain("Al\u00A0Ummah\u00A0Now Studio");
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

  it("?deleted=1 alone never fakes a deletion (signed out or signed in); only the HttpOnly proof cookie renders done when signed out", async () => {
    // Signed out with ?deleted=1 and no cookie -> normal signed-out sign-in prompt
    const spoofedOut = await worker.fetch(new Request(`${APP}/delete-account?deleted=1`), env() as never, {} as ExecutionContext);
    const spoofedOutHtml = await spoofedOut.text();
    expect(spoofedOutHtml).not.toContain('data-testid="delete-account-done"');
    expect(spoofedOutHtml).toContain('data-testid="delete-account-signin"');

    // Signed in with ?deleted=1 (and even with stale done cookie) -> normal delete page, never done card
    const cookie = await seedSession(jwtWithClaims(NOW_S + 900, NOW_S - 30), "sid-spoof");
    const spoofedIn = await worker.fetch(
      new Request(`${APP}/delete-account?deleted=1`, { headers: { Cookie: `${cookie}; delete_account_done=1` } }),
      env() as never,
      {} as ExecutionContext,
    );
    const spoofedInHtml = await spoofedIn.text();
    expect(spoofedInHtml).not.toContain('data-testid="delete-account-done"');
    expect(spoofedInHtml).toContain('data-testid="delete-account-open-dialog"');

    // Signed out WITH delete_account_done=1 cookie -> renders done card with matching hero
    const proved = await worker.fetch(
      new Request(`${APP}/delete-account`, { headers: { Cookie: "delete_account_done=1" } }),
      env() as never,
      {} as ExecutionContext,
    );
    const provedHtml = await proved.text();
    expect(provedHtml).toContain('data-testid="delete-account-done"');
    expect(provedHtml).toContain("Your account has been deleted");
    expect(provedHtml).not.toContain("Delete your Al\u00A0Ummah\u00A0Now account");
  });

  it("GET /delete-account signed in renders the accessible in-app dialog, embeds userId, uses <bdi> for email, and never browser confirm/alert", async () => {
    const cookie = await seedSession(jwtWithClaims(NOW_S + 900, NOW_S - 30));
    const res = await worker.fetch(new Request(`${APP}/delete-account`, { headers: { Cookie: cookie } }), env() as never, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="delete-account-dialog"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(`<bdi dir="ltr">${USER.email}</bdi>`);
    expect(html).toContain(`EXPECTED_USER_ID = "${USER.id}"`);
    expect(html).toContain("ev.preventDefault()");
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

  it("DELETE /api/account enforces Origin, confirmation word, session presence, account identity, step-up freshness, and sets done cookie on completion", async () => {
    const freshToken = jwtWithClaims(NOW_S + 900, NOW_S - 20);
    const cookie = await seedSession(freshToken, "sid-ok");

    // Missing Origin blocked (403)
    const missingOrigin = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE", userId: USER.id }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(missingOrigin.status).toBe(403);

    // Cross-origin blocked (403)
    const csrf = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE", userId: USER.id }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(csrf.status).toBe(403);

    // Missing confirmation rejected (400)
    const badConfirm = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "NO", userId: USER.id }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(badConfirm.status).toBe(400);

    // No session rejected (401)
    const noSession = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Origin: APP, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE", userId: USER.id }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(noSession.status).toBe(401);
    expect(await noSession.json()).toEqual({ error: "not_authenticated" });

    // Account mismatch (tab opened for A, session now B) rejected (409) BEFORE any upstream call
    const upstreamSpy = vi.fn();
    globalThis.fetch = upstreamSpy as unknown as typeof fetch;
    const mismatch = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: APP, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE", userId: "u-other-tab" }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: "account_mismatch" });
    expect(upstreamSpy).not.toHaveBeenCalled();

    // Stale session on the real route rejected (401 step-up) with ZERO upstream calls
    const staleCookie = await seedSession(jwtWithClaims(NOW_S + 900, NOW_S - 450), "sid-stale");
    const staleRes = await worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { Cookie: staleCookie, Origin: APP, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE", userId: USER.id }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(staleRes.status).toBe(401);
    expect(await staleRes.json()).toMatchObject({ error: "insufficient_user_authentication" });
    expect(upstreamSpy).not.toHaveBeenCalled();

    // Full deletion succeeds, ends profile session, clears profile_session, and sets delete_account_done proof cookie
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
        body: JSON.stringify({ confirm: "DELETE", userId: USER.id }),
      }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true, complete: true, userId: USER.id, deletedAt: NOW_MS });
    expect(await getSession({ db, kv: kv.asKV() }, "sid-ok", NOW_MS)).toBeNull();
    const cookies = ok.headers.getSetCookie?.() ?? [ok.headers.get("Set-Cookie") ?? ""];
    expect(cookies.join("\n")).toContain("profile_session=;");
    expect(cookies.join("\n")).toContain("delete_account_done=1;");
  });

  it("/logout keeps a safe same-origin ?return=/delete-account?lang=ar", async () => {
    const res = await worker.fetch(
      new Request(`${APP}/logout?return=${encodeURIComponent("/delete-account?lang=ar")}`, { redirect: "manual" }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(`${AUTH}/logout`);
    expect(loc.searchParams.get("return")).toBe(`${APP}/delete-account?lang=ar`);
  });

  it("renders ?reauth=1 with the re-auth banner, sign-in CTA, and no redundant Delete my account button", async () => {
    const cookie = await seedSession(jwtWithClaims(NOW_S + 900, NOW_S - 30));
    const res = await worker.fetch(
      new Request(`${APP}/delete-account?reauth=1`, { headers: { Cookie: cookie } }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="delete-account-reauth"');
    expect(html).toContain('data-testid="delete-account-reauth-signin"');
    expect(html).not.toContain('data-testid="delete-account-open-dialog"');

    // ?reauth=1&erased=1 shows the distinct content-already-removed copy
    const erasedRes = await worker.fetch(
      new Request(`${APP}/delete-account?reauth=1&erased=1`, { headers: { Cookie: cookie } }),
      env() as never,
      {} as ExecutionContext,
    );
    expect(await erasedRes.text()).toContain("Your Videos content has been removed");
  });
});
