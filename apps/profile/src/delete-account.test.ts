import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTINUATION_REAUTH_MAX_AGE_SECONDS,
  DEFAULT_RETRY_AFTER_SECONDS,
  isRecentSignIn,
  leftoverOf,
  orchestrateAccountDeletion,
  PRECHECK_REAUTH_MAX_AGE_SECONDS,
  REAUTH_MAX_AGE_SECONDS,
  resolveVideosApiUrl,
  retryAfterSeconds,
  tokenUserIdOf,
  type DeletionState,
} from "./delete-account";
import {
  accountDeleted,
  clearAccountDeletionSwitchCache,
  progressKey,
  putDeleteProgress,
  readDeleteProgress,
  readStoredProgress,
  removeDeleteProgress,
  settleDeleteProgress,
  type DeleteProgress,
} from "./delete-progress";
import { renderHomePage } from "./page";
import { FakeKV, NOW_MS, NOW_S, fakeD1 } from "./test-helpers";
import { getSession, sessionId } from "./session-store";

const client = { exchange: vi.fn(), verify: vi.fn(), refresh: vi.fn() };
vi.mock("@al-ummah-now/openauth/client", () => ({ createClient: () => client }));

const { default: worker } = await import("./index");

const APP = "https://profile.auth.qa.alummahnow.net";
const AUTH = "https://auth.qa.alummahnow.net";
const VIDEOS_API = "https://videos.api.qa.alummahnow.net";
const ERASE = `${VIDEOS_API}/api/privacy/data`;
const ACCOUNT = `${AUTH}/account`;
const USER = { id: "u-del-1", email: "delete-me@example.com", roles: ["Member"] };
const ctx = {} as ExecutionContext;

function jwtWithClaims(exp: number, authTime?: number, userId: string | null = USER.id): string {
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({
    mode: "access",
    exp,
    ...(authTime === undefined ? {} : { auth_time: authTime }),
    ...(userId === null ? {} : { properties: { id: userId, email: USER.email, roles: USER.roles } }),
  })}.sig`;
}

const signedInAgo = (seconds: number) => jwtWithClaims(NOW_S + 900, NOW_S - seconds);
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const DELETED = { deleted: true, userId: USER.id, deletedAt: NOW_MS };

type Step = Response | Error | (() => Response | Promise<Response>);

/** Videos and Auth answering in order; records what was called with what. */
function upstream(videos: Step[], auth: Step[] = []) {
  const calls: { url: string; body: unknown }[] = [];
  const queue: Record<string, Step[]> = { [ERASE]: [...videos], [ACCOUNT]: [...auth] };
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/themes/resolve")) return new Response("not found", { status: 404 });
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const step = queue[url]?.shift();
    if (!step) throw new Error(`unexpected call to ${url}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch, urls: () => calls.map((c) => c.url) };
}

function memoryState(initial: DeleteProgress | null = null, o: { deleted?: () => boolean; failWrite?: (p: DeleteProgress) => boolean } = {}) {
  let stored = initial;
  const writes: DeleteProgress[] = [];
  const state: DeletionState = {
    read: async () => (stored ? { record: stored, raw: JSON.stringify(stored) } : null),
    put: async (p, expected) => {
      if (o.failWrite?.(p)) throw new Error("D1 down");
      if ((stored ? JSON.stringify(stored) : null) !== expected) return null;
      writes.push(p);
      stored = p;
      return JSON.stringify(p);
    },
    remove: async (expected) => {
      if (!stored || JSON.stringify(stored) !== expected) return false;
      stored = null;
      return true;
    },
    accountDeleted: async () => o.deleted?.() ?? false,
  };
  return { state, writes, stored: () => stored };
}

const run = (o: Partial<Parameters<typeof orchestrateAccountDeletion>[0]>) =>
  orchestrateAccountDeletion({
    accessToken: signedInAgo(20),
    expectedUserId: USER.id,
    authServerUrl: AUTH,
    videosApiUrl: VIDEOS_API,
    state: memoryState().state,
    nowMs: NOW_MS,
    ...o,
  });

const record = (p: Partial<DeleteProgress>): DeleteProgress => ({ stage: "started", startedAt: NOW_MS - 1000, updatedAt: NOW_MS - 1000, ...p });

describe("account deletion, one step (AlUmmahNowAuth#532)", () => {
  it("resolves the Videos API from the variable or the environment", () => {
    expect(resolveVideosApiUrl("https://custom.videos.test/", "qa")).toBe("https://custom.videos.test");
    expect(resolveVideosApiUrl(undefined, "production")).toBe("https://videos.api.alummahnow.net");
    expect(resolveVideosApiUrl(undefined, "qa")).toBe("https://videos.api.qa.alummahnow.net");
    expect(resolveVideosApiUrl(undefined, "local")).toBe("http://localhost:3086");
    expect(resolveVideosApiUrl(undefined, null)).toBeNull();
  });

  it("refuses a token of another account, or of none, before anything is written or called", async () => {
    for (const userId of ["u-other-b", null]) {
      const accessToken = jwtWithClaims(NOW_S + 900, NOW_S - 20, userId);
      expect(tokenUserIdOf(accessToken)).toBe(userId);
      const up = upstream([]);
      const mem = memoryState();
      expect(await run({ accessToken, fetchFn: up.fetchFn, state: mem.state })).toMatchObject({ ok: false, status: 409, error: "account_mismatch" });
      expect(up.calls).toEqual([]);
      expect(mem.writes).toEqual([]);
    }
  });

  it("asks for a recent sign-in before anything is written or called: 300 s at first, 570 s once started", async () => {
    expect(PRECHECK_REAUTH_MAX_AGE_SECONDS).toBe(300);
    expect(CONTINUATION_REAUTH_MAX_AGE_SECONDS).toBeLessThan(REAUTH_MAX_AGE_SECONDS);
    expect(isRecentSignIn(jwtWithClaims(NOW_S + 900), NOW_MS)).toBe(false);
    expect(isRecentSignIn(signedInAgo(-120), NOW_MS)).toBe(false);

    const first = memoryState();
    const up = upstream([]);
    expect(await run({ accessToken: signedInAgo(301), state: first.state, fetchFn: up.fetchFn })).toEqual({
      ok: false, status: 401, error: "insufficient_user_authentication", maxAge: 300, started: false,
    });
    expect(first.writes).toEqual([]);

    const late = memoryState(record({ resumeToken: "t1" }));
    expect(await run({ accessToken: signedInAgo(571), state: late.state, fetchFn: up.fetchFn })).toMatchObject({ status: 401, started: true });
    expect(late.stored()).toEqual(record({ resumeToken: "t1" }));
    expect(up.calls).toEqual([]);

    const on = upstream([reply({ complete: true })], [reply(DELETED)]);
    expect(await run({ accessToken: signedInAgo(560), state: late.state, fetchFn: on.fetchFn })).toMatchObject({ ok: true, complete: true });
  });

  it("never deletes the sign-in account when the Videos API is not configured", async () => {
    const up = upstream([]);
    const mem = memoryState();
    expect(await run({ videosApiUrl: null, fetchFn: up.fetchFn, state: mem.state })).toMatchObject({ status: 503, error: "videos_api_unconfigured" });
    expect(up.calls).toEqual([]);
    expect(mem.writes).toEqual([]);
  });

  it("records the start before the first call, and calls nothing when it cannot", async () => {
    const mem = memoryState();
    let seen: DeleteProgress | null = null;
    const up = upstream([() => ((seen = mem.stored()), reply({ complete: false, resumeToken: "t1" }))]);
    expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toEqual({ ok: true, complete: false, restarted: false });
    expect(seen).toMatchObject({ stage: "started" });
    expect(mem.stored()).toMatchObject({ stage: "started", resumeToken: "t1" });

    const broken = upstream([]);
    const noWrite = memoryState(null, { failWrite: () => true });
    expect(await run({ state: noWrite.state, fetchFn: broken.fetchFn })).toEqual({ ok: false, status: 503, error: "progress_unavailable", started: false });
    const noRead = { ...noWrite.state, read: async () => Promise.reject(new Error("D1 down")) };
    expect(await run({ state: noRead, fetchFn: broken.fetchFn })).toEqual({ ok: false, status: 503, error: "progress_unavailable", started: false });
    expect(broken.calls).toEqual([]);
  });

  it("keeps the record when the first pass ends in a 503, a 5xx, a network failure or an unreadable answer", async () => {
    const steps: [Step, Record<string, unknown>][] = [
      [reply({ code: "resume_unavailable", error: "later" }, 503, { "Retry-After": "300" }), { status: 503, error: "resume_unavailable", retryAfter: 300 }],
      [reply({ code: "busy" }, 503), { status: 503, error: "videos_busy", retryAfter: DEFAULT_RETRY_AFTER_SECONDS }],
      [new Response("boom", { status: 500 }), { status: 502, error: "videos_erasure_failed" }],
      [new Error("network"), { status: 502, error: "videos_erasure_failed" }],
      [new Response("<html>", { status: 200 }), { status: 502, error: "videos_erasure_incomplete" }],
      [reply({ complete: false }), { status: 502, error: "videos_erasure_incomplete" }],
    ];
    for (const [step, expected] of steps) {
      const mem = memoryState();
      const up = upstream([step]);
      expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toMatchObject({ ok: false, started: true, ...expected });
      expect(mem.stored()).toMatchObject({ stage: "started" });
      expect(up.urls()).toEqual([ERASE]);
    }
  });

  it("does not call a deletion started when Videos refused the request before erasing", async () => {
    for (const [step, expected] of [
      [reply({ error: "insufficient_user_authentication" }, 401), { status: 401, error: "insufficient_user_authentication" }],
      [reply({ error: "invalid_audience" }, 401), { status: 502, error: "videos_erasure_refused" }],
      [reply({}, 404), { status: 502, error: "videos_erasure_refused" }],
      [reply({}, 429, { "Retry-After": "60" }), { status: 503, error: "videos_busy", retryAfter: 60 }],
    ] as [Response, Record<string, unknown>][]) {
      const mem = memoryState();
      expect(await run({ state: mem.state, fetchFn: upstream([step.clone()]).fetchFn })).toMatchObject({ ok: false, started: false, ...expected });
      expect(mem.stored()).toBeNull();
      // One that had started stays started, with its token
      const going = memoryState(record({ resumeToken: "t1" }));
      expect(await run({ state: going.state, fetchFn: upstream([step.clone()]).fetchFn })).toMatchObject({ ok: false, started: true });
      expect(going.stored()).toMatchObject({ stage: "started", resumeToken: "t1" });
    }
  });

  it("hands the opaque token back unread across requests, and goes on with a restarted run's new one", async () => {
    const mem = memoryState();
    const up = upstream(
      [
        reply({ complete: false, resumeToken: "a.b.c" }),
        reply({ code: "resume_unavailable" }, 503, { "Retry-After": "120" }),
        reply({ complete: false, resumeToken: "d.e.f", restarted: true }),
        reply({ complete: true }),
      ],
      [reply(DELETED)],
    );
    expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toEqual({ ok: true, complete: false, restarted: false });
    expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toMatchObject({ error: "resume_unavailable", retryAfter: 120 });
    expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toEqual({ ok: true, complete: false, restarted: true });
    expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toEqual({ ok: true, complete: true, deletedAt: NOW_MS });
    expect(up.calls.map((c) => (c.body as { resumeToken?: string } | undefined)?.resumeToken)).toEqual([undefined, "a.b.c", "a.b.c", "d.e.f", undefined]);
  });

  it("a lost record starts over", async () => {
    const up = upstream([reply({ complete: true })], [reply(DELETED)]);
    expect(await run({ state: memoryState(null).state, fetchFn: up.fetchFn })).toMatchObject({ ok: true, complete: true });
    expect(up.calls[0].body).toEqual({ confirm: "DELETE" });
  });

  it("after Auth failed, a retry runs the Videos erase again before deleting the account", async () => {
    for (const authStep of [reply({}, 500), new Error("network"), reply({ error: "invalid_token" }, 401), reply({}, 200)] as Step[]) {
      const mem = memoryState();
      const first = upstream([reply({ complete: true })], [authStep]);
      expect(await run({ state: mem.state, fetchFn: first.fetchFn })).toMatchObject({ ok: false, started: true, contentErased: true });
      expect(mem.stored()).toMatchObject({ stage: "content_erased" });
      expect(mem.stored()).not.toHaveProperty("resumeToken");

      // Something uploaded meanwhile: the retry's erase needs two passes, and Auth comes only after both
      const second = upstream([reply({ complete: false, resumeToken: "n1" }), reply({ complete: true })], [reply(DELETED)]);
      expect(await run({ state: mem.state, fetchFn: second.fetchFn })).toEqual({ ok: true, complete: false, restarted: false });
      expect(mem.stored()).toMatchObject({ stage: "started", resumeToken: "n1" });
      expect(await run({ state: mem.state, fetchFn: second.fetchFn })).toMatchObject({ ok: true, complete: true });
      expect(second.urls()).toEqual([ERASE, ERASE, ACCOUNT]);
      expect(second.calls[0].body).toEqual({ confirm: "DELETE" });
    }
  });

  it("asks to sign in again when Auth no longer accepts the sign-in", async () => {
    const up = upstream([reply({ complete: true })], [reply({ error: "insufficient_user_authentication", max_age: 600 }, 401)]);
    expect(await run({ fetchFn: up.fetchFn })).toEqual({
      ok: false, status: 409, error: "content_erased_reauth_required", maxAge: 600, started: true, contentErased: true,
    });
  });

  it("an account Auth no longer knows, right after the erase, is deleted; any other 404 is not", async () => {
    expect(await run({ fetchFn: upstream([reply({ complete: true })], [reply({ error: "not_found" }, 404)]).fetchFn })).toEqual({ ok: true, complete: true });
    expect(await run({ fetchFn: upstream([reply({ complete: true })], [reply({ error: "no_route" }, 404)]).fetchFn })).toMatchObject({ ok: false });
  });

  it("a lost Auth answer is settled from Auth's own row", async () => {
    for (const authStep of [new Error("network"), reply({}, 500), reply({ error: "invalid_token" }, 401), new Response("<html>")] as Step[]) {
      const mem = memoryState(null, { deleted: () => true });
      expect(await run({ state: mem.state, fetchFn: upstream([reply({ complete: true })], [authStep]).fetchFn })).toEqual({ ok: true, complete: true });
    }
  });

  it("records the erase before calling Auth, and does not call Auth when it cannot", async () => {
    const mem = memoryState();
    let seen: DeleteProgress | null = null;
    const up = upstream([reply({ complete: true })], [() => ((seen = mem.stored()), reply(DELETED))]);
    await run({ state: mem.state, fetchFn: up.fetchFn });
    expect(seen).toMatchObject({ stage: "content_erased" });

    const broken = memoryState(null, { failWrite: (p) => p.stage === "content_erased" });
    const stop = upstream([reply({ complete: true })]);
    expect(await run({ state: broken.state, fetchFn: stop.fetchFn })).toEqual({ ok: false, status: 503, error: "progress_unavailable", started: true });
    expect(stop.urls()).toEqual([ERASE]);
    expect(broken.stored()).toMatchObject({ stage: "started" });
  });

  it("reports what the erase left behind, across passes; a restarted run counts again", async () => {
    expect(leftoverOf([])).toBeUndefined();
    expect(leftoverOf(["admin_backups_unbound"])).toBe("other");
    expect(leftoverOf(["admin_backups_unbound", "channel_unreadable:c1"])).toBe("channel");

    const mem = memoryState();
    const up = upstream(
      [reply({ complete: false, resumeToken: "t1", errors: ["channel_unreadable:c1"] }), reply({ complete: true, errors: ["admin_backups_unbound"] })],
      [reply(DELETED)],
    );
    await run({ state: mem.state, fetchFn: up.fetchFn });
    // Auth is not called before the person knows
    expect(await run({ state: mem.state, fetchFn: up.fetchFn })).toEqual({ ok: true, complete: false, leftover: "channel" });
    expect(up.urls()).toEqual([ERASE, ERASE]);
    expect(mem.stored()).toMatchObject({ stage: "content_erased", leftover: "channel" });
    // Told about records only: a channel is asked about again; then the erase runs once more and the account goes
    const left = { complete: true, errors: ["channel_unreadable:c1"] };
    const told = upstream([reply(left), reply(left)], [reply(DELETED)]);
    expect(await run({ state: mem.state, fetchFn: told.fetchFn, acceptLeftover: "other" })).toEqual({ ok: true, complete: false, leftover: "channel" });
    expect(await run({ state: mem.state, fetchFn: told.fetchFn, acceptLeftover: "channel" })).toMatchObject({ ok: true, complete: true, leftover: "channel" });
    expect(told.urls()).toEqual([ERASE, ERASE, ACCOUNT]);
    // Auth failing after that does not claim everything was erased
    const failed = upstream([reply(left)], [reply({}, 500)]);
    expect(await run({ state: mem.state, fetchFn: failed.fetchFn, acceptLeftover: "channel" })).toMatchObject({ ok: false, contentErased: false, started: true });

    const again = memoryState(record({ resumeToken: "t1", leftover: "channel" }));
    const restarted = upstream([reply({ complete: true, restarted: true })], [reply(DELETED)]);
    expect(await run({ state: again.state, fetchFn: restarted.fetchFn })).toEqual({ ok: true, complete: true, deletedAt: NOW_MS });
  });

  it("a record of a finished deletion (an account restored since) does not skip or resume anything", async () => {
    const mem = memoryState(record({ stage: "deleted" }));
    const up = upstream([]);
    expect(await run({ accessToken: signedInAgo(320), state: mem.state, fetchFn: up.fetchFn })).toMatchObject({ status: 401, maxAge: 300, started: false });
  });

  it("reads Retry-After as seconds or a date, within an hour", () => {
    expect(retryAfterSeconds("45", NOW_MS)).toBe(45);
    expect(retryAfterSeconds(new Date(NOW_MS + 90_000).toUTCString(), NOW_MS)).toBe(90);
    expect(retryAfterSeconds("99999", NOW_MS)).toBe(3600);
    for (const bad of [null, "", "soon", "-5", "0"]) expect(retryAfterSeconds(bad, NOW_MS)).toBe(300);
  });
});

describe("profile worker: /delete-account and DELETE /api/account", () => {
  let kv: FakeKV;
  let db: Awaited<ReturnType<typeof fakeD1>>;
  let failSql: RegExp | null;
  const origFetch = globalThis.fetch;

  const env = (over: Record<string, unknown> = {}) => ({
    AUTH_STORAGE: kv.asKV(),
    AUTH_DB: {
      prepare: (sql: string) => {
        if (failSql?.test(sql)) throw new Error("D1 down");
        return db.prepare(sql);
      },
    },
    AUTH_SERVER_URL: AUTH,
    APP_URL: APP,
    VIDEOS_API_URL: VIDEOS_API,
    APP_ENV: "qa",
    ...over,
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

  const setAccount = (status: string, id = USER.id) =>
    db
      .prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES (?1, 'default', ?2, ?3, 1, 1) ON CONFLICT(id) DO UPDATE SET status = excluded.status`)
      .bind(id, `${id}@example.com`, status)
      .run();

  const page = (cookie?: string, path = "/delete-account") =>
    worker.fetch(new Request(`${APP}${path}`, cookie ? { headers: { Cookie: cookie } } : {}), env() as never, ctx);
  const pageText = async (cookie?: string, path?: string) => (await page(cookie, path)).text();

  const del = (cookie: string | null, body: unknown = { confirm: "DELETE", userId: USER.id }, origin: string | null = APP) =>
    worker.fetch(
      new Request(`${APP}/api/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body),
      }),
      env() as never,
      ctx,
    );

  const progress = () => readDeleteProgress(db, USER.id, NOW_MS);
  /** As an earlier or another attempt left it. */
  const setRecord = (p: DeleteProgress) =>
    db
      .prepare(`INSERT INTO openauth_atomic (key, value, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
      .bind(progressKey(USER.id), JSON.stringify(p), p.stage === "deleted" ? p.updatedAt + 86400_000 : null)
      .run();
  const expiry = async () =>
    (await db.prepare(`SELECT expires_at FROM openauth_atomic WHERE key = ?1`).bind(progressKey(USER.id)).first<{ expires_at: number | null }>())?.expires_at;
  const cookiesOf = (res: Response) => res.headers.getSetCookie();
  const nonceOf = (res: Response) => /delete_account_done=([0-9a-f-]{36});/.exec(cookiesOf(res).join("\n"))![0].replace(";", "");

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearAccountDeletionSwitchCache();
    failSql = null;
    kv = new FakeKV();
    db = await fakeD1();
    await setAccount("active");
    globalThis.fetch = upstream([]).fetchFn;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("works signed out in both languages: names the apps, what goes, what stays, and asks to sign in", async () => {
    const res = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const en = await res.text();
    expect(en).toContain("Al Ummah Now Studio");
    expect(en).toContain('data-testid="delete-account-signin"');
    expect(en).toContain("prompt=login");
    expect(en).toContain("30 days");
    expect(en).toContain("Their other admins do not keep them");
    expect(en).toContain("Stored copies of video and image files are not removed at the same moment");
    expect(en).not.toContain('data-testid="delete-account-dialog"');

    const ar = await pageText(undefined, "/delete-account?lang=ar");
    expect(ar).toContain('lang="ar" dir="rtl"');
    expect(ar).toContain("٣٠ يومًا");
    expect(ar).not.toContain("30 يوم");
    expect(ar).not.toContain("فيديو");
    expect(ar).toContain("ولا تبقى لمشرفيها الآخرين");
  });

  it("signed in: an in-app dialog bound to the account, with the warning about shared channels", async () => {
    const html = await pageText(await seedSession(signedInAgo(30)));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(`<bdi dir="ltr">${USER.email}</bdi>`);
    expect(html).toContain(`EXPECTED_USER_ID = "${USER.id}"`);
    expect(html).toContain("deleted whole, with what their other admins and members added");
    expect(html).not.toMatch(/\bwindow\.(confirm|alert)\b|\bconfirm\(/);
  });

  it("the profile home page shows the card only while the feature is on", () => {
    for (const locale of ["en", "ar"] as const) {
      const home = (accountDeletion: boolean) =>
        renderHomePage({ locale, apps: [], user: USER, authServerUrl: AUTH, appUrl: APP, clientId: "profile", accountDeletion });
      expect(home(true)).toContain(`href="${locale === "ar" ? "/delete-account?lang=ar" : "/delete-account"}"`);
      expect(home(false)).not.toContain("/delete-account");
    }
  });

  it("the switch turns the page, the API and the card off", async () => {
    const cookie = await seedSession(signedInAgo(30));
    expect(await pageText(cookie, "/")).toContain('data-testid="profile-delete-account"');
    await db.prepare(`INSERT INTO auth_settings (key, value, updated_at) VALUES ('account_deletion', '{"on":false}', 1)`).run();
    // Cached for half a minute
    expect((await page(cookie)).status).toBe(200);
    vi.setSystemTime(NOW_MS + 31_000);
    expect((await page(cookie)).status).toBe(404);
    const res = await del(cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "feature_off" });
    expect(await pageText(cookie, "/")).not.toContain("/delete-account");
    expect(await progress()).toBeNull();
  });

  it("an unreadable switch deletes nothing", async () => {
    const cookie = await seedSession(signedInAgo(30));
    failSql = /auth_settings/;
    expect((await del(cookie)).status).toBe(404);
    expect((await page(cookie)).status).toBe(404);
  });

  it("refuses a missing or foreign Origin, a missing confirmation, no session and another account, with no call made", async () => {
    const cookie = await seedSession(signedInAgo(20));
    const up = upstream([]);
    globalThis.fetch = up.fetchFn;
    expect((await del(cookie, undefined, null)).status).toBe(403);
    expect((await del(cookie, undefined, "https://evil.example")).status).toBe(403);
    expect((await del(cookie, { confirm: "NO", userId: USER.id })).status).toBe(400);
    expect((await del(cookie, { confirm: "DELETE" })).status).toBe(409);
    const none = await del(null);
    expect([none.status, await none.json()]).toEqual([401, { error: "not_authenticated" }]);
    const other = await del(cookie, { confirm: "DELETE", userId: "u-other-tab" });
    expect([other.status, await other.json()]).toEqual([409, { error: "account_mismatch" }]);
    expect(up.calls).toEqual([]);
    expect(client.refresh).not.toHaveBeenCalled();
    expect(await progress()).toBeNull();
  });

  it("a sign-in that is too old changes nothing and leaves nothing behind", async () => {
    const res = await del(await seedSession(signedInAgo(450)));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "insufficient_user_authentication", started: false, max_age: 300 });
    expect(await progress()).toBeNull();
  });

  it("several passes to the end: progress kept in D1, the token never sent to the browser, then signed out and confirmed once", async () => {
    const cookie = await seedSession(signedInAgo(20));
    const up = upstream([reply({ complete: false, resumeToken: "sealed-1" }), reply({ complete: false, resumeToken: "sealed-2", restarted: true }), reply({ complete: true })], [reply(DELETED)]);
    globalThis.fetch = up.fetchFn;

    const one = await del(cookie);
    expect([one.status, await one.json()]).toEqual([200, { deleted: false, complete: false }]);
    expect(await progress()).toMatchObject({ stage: "started", resumeToken: "sealed-1" });
    expect(await pageText(cookie)).toContain("was started and is not finished");
    expect(await (await del(cookie)).json()).toEqual({ deleted: false, complete: false, restarted: true });
    const last = await del(cookie);
    expect([last.status, await last.json()]).toEqual([200, { deleted: true, complete: true, erased: true, deletedAt: NOW_MS }]);
    expect(up.calls.map((c) => (c.body as { resumeToken?: string } | undefined)?.resumeToken)).toEqual([undefined, "sealed-1", "sealed-2", undefined]);

    expect(await getSession({ db, kv: kv.asKV() }, "sid-del", NOW_MS)).toBeNull();
    expect(await progress()).toMatchObject({ stage: "deleted" });
    const set = cookiesOf(last);
    expect(set.some((c) => c.startsWith("profile_session=;"))).toBe(true);
    expect(set.find((c) => c.startsWith("delete_account_done="))).toMatch(
      /^delete_account_done=[0-9a-f-]{36}; Path=\/delete-account; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );

    const proof = nonceOf(last);
    const done = await page(proof);
    expect(cookiesOf(done).join("\n")).toContain("delete_account_done=;");
    const html = await done.text();
    expect(html).toContain('data-testid="delete-account-done"');
    expect(html).toContain("Your Videos content was erased and your Al Ummah Now account was deleted");
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html.split("Your account has been deleted")).toHaveLength(2);
    expect(await pageText(proof)).not.toContain('data-testid="delete-account-done"');
  });

  it("the done state cannot be faked: queries, made-up or expired cookies, or a signed-in view", async () => {
    for (const [cookie, path] of [
      [undefined, "/delete-account?deleted=1&erased=1"],
      ["delete_account_done=1", "/delete-account"],
      [`delete_account_done=${crypto.randomUUID()}`, "/delete-account"],
    ] as const) {
      const html = await pageText(cookie, path);
      expect(html).not.toContain('data-testid="delete-account-done"');
      expect(html).toContain('data-testid="delete-account-signin"');
    }
    globalThis.fetch = upstream([reply({ complete: true })], [reply(DELETED)]).fetchFn;
    const proof = nonceOf(await del(await seedSession(signedInAgo(20))));
    const other = await seedSession(jwtWithClaims(NOW_S + 900, NOW_S, "u-2"), "sid-2", { ...USER, id: "u-2" });
    expect(await pageText(`${other}; ${proof}`)).toContain('data-testid="delete-account-open-dialog"');
    vi.setSystemTime(NOW_MS + 601_000);
    expect(await pageText(proof)).not.toContain('data-testid="delete-account-done"');
  });

  it("what could not be removed is said on the done page, in both languages", async () => {
    for (const [errors, en, ar] of [
      [["channel_unreadable:c1"], "except for a channel we could not remove. It stays until our team removes it", "ما عدا قناة لم نتمكن من إزالتها، وتبقى حتى يزيلها فريقنا"],
      [["admin_backups_unbound"], "except for some records", "ما عدا بعض السجلات"],
    ] as const) {
      for (const lang of ["en", "ar"]) {
        const cookie = await seedSession(signedInAgo(20), `sid-${errors[0]}-${lang}`);
        const up = upstream([reply({ complete: true, errors }), reply({ complete: true, errors })], [reply(DELETED)]);
        globalThis.fetch = up.fetchFn;
        const acceptLeftover = errors[0].startsWith("channel") ? "channel" : "other";
        expect(await (await del(cookie)).json()).toEqual({ deleted: false, complete: false, leftover: acceptLeftover });
        expect(up.urls()).toEqual([ERASE]);
        // Left there: not called erased
        expect(await pageText(cookie)).toContain("was started and is not finished");
        const res = await del(cookie, { confirm: "DELETE", userId: USER.id, acceptLeftover });
        expect(await res.clone().json()).toMatchObject({ deleted: true, leftover: errors[0].startsWith("channel") ? "channel" : "other" });
        expect(await pageText(nonceOf(res), `/delete-account?lang=${lang}`)).toContain(lang === "ar" ? ar : en);
      }
    }
  });

  it("503 resume_unavailable on the first pass: Retry-After passed on, and the page says some content may be gone", async () => {
    const cookie = await seedSession(signedInAgo(20));
    globalThis.fetch = upstream([reply({ code: "resume_unavailable" }, 503, { "Retry-After": "300" })]).fetchFn;
    const res = await del(cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(await res.json()).toEqual({ error: "resume_unavailable", started: true, retryAfter: 300 });
    expect(await pageText(cookie)).toContain("Some of your content may already be gone");
    expect(await pageText(cookie, "/delete-account?lang=ar")).toContain("وربما أُزيل بعض محتواك");
  });

  it("a closed tab or a cancelled Worker during the first pass still shows on return", async () => {
    const cookie = await seedSession(signedInAgo(20));
    // The request never gets past Videos
    globalThis.fetch = upstream([() => new Promise<Response>(() => {})]).fetchFn;
    void del(cookie);
    await vi.waitFor(async () => expect(await progress()).toMatchObject({ stage: "started" }));
    globalThis.fetch = upstream([]).fetchFn;
    expect(await pageText(cookie)).toContain("was started and is not finished");
  });

  it("progress outlives a day, a new sign-in and an empty KV, belongs to one account, and is never taken from the query", async () => {
    const cookie = await seedSession(signedInAgo(20));
    globalThis.fetch = upstream([reply({ complete: false, resumeToken: "sealed-1" })]).fetchFn;
    await del(cookie);
    const later = NOW_MS + 3 * 86400_000;
    vi.setSystemTime(later);
    kv = new FakeKV();
    globalThis.fetch = upstream([]).fetchFn;
    const again = await seedSession(jwtWithClaims(later / 1000 + 900, later / 1000 - 5), "sid-new");
    await db.prepare(`UPDATE app_sessions SET expires_at = ?1`).bind(later + 86400_000).run();
    const html = await pageText(again);
    expect(html).toContain("was started and is not finished");
    expect(html).toContain("anything you add before then is deleted too");
    expect(html).not.toContain("sealed-1");
    const other = await seedSession(jwtWithClaims(later / 1000 + 900, later / 1000 - 5, "u-2"), "sid-2", { ...USER, id: "u-2" });
    for (const path of ["/delete-account", "/delete-account?reauth=1&erased=1&started=1&stage=content_erased"]) {
      const theirs = await pageText(other, path);
      expect(theirs).not.toContain("was started and is not finished");
      expect(theirs).not.toContain("content was erased, but");
    }

    const up = upstream([reply({ complete: true })], [reply(DELETED)]);
    globalThis.fetch = up.fetchFn;
    expect(await (await del(again)).json()).toMatchObject({ deleted: true });
    expect(up.calls[0].body).toEqual({ confirm: "DELETE", resumeToken: "sealed-1" });
  });

  it("a sign-in that runs out in the middle: the token stays, the page asks to sign in and says it has started", async () => {
    const cookie = await seedSession(signedInAgo(20));
    globalThis.fetch = upstream([reply({ complete: false, resumeToken: "sealed-1" }), reply({ error: "insufficient_user_authentication" }, 401)]).fetchFn;
    await del(cookie);
    const res = await del(cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "insufficient_user_authentication", started: true });
    expect(await progress()).toMatchObject({ stage: "started", resumeToken: "sealed-1" });
    const html = await pageText(cookie, "/delete-account?reauth=1");
    expect(html).toContain('data-testid="delete-account-reauth-signin"');
    expect(html).toContain("Some of your content may already be gone. Sign in again to finish");
    expect(html).not.toContain('data-testid="delete-account-open-dialog"');
    // Signed out meanwhile in this browser: the same, from its own ended session
    await db.prepare(`UPDATE app_sessions SET revoked_at = 1, access_token = '', refresh_token = NULL`).run();
    expect(await pageText(cookie, "/delete-account?reauth=1")).toContain("was started and is not finished");
    expect((await (await del(cookie)).json())).toEqual({ error: "not_authenticated" });
  });

  it("coming back from the asked sign-in as someone else says so once, offers no delete, and touches neither account", async () => {
    const mine = await seedSession(signedInAgo(450));
    const asked = await page(mine, "/delete-account?reauth=1");
    const set = cookiesOf(asked).find((c) => c.startsWith("delete_account_for="))!;
    expect(set).toMatch(/^delete_account_for=[0-9a-f]{64}; Path=\/delete-account; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    expect(set).not.toContain(USER.id);
    const asCookie = set.split(";")[0];
    const other = await seedSession(jwtWithClaims(NOW_S + 900, NOW_S, "u-2"), "sid-2", { ...USER, id: "u-2" });
    for (const [lang, text] of [["en", "for a different account than this one"], ["ar", "لحساب آخر غير هذا الحساب"]]) {
      const res = await page(`${other}; ${asCookie}`, `/delete-account?lang=${lang}`);
      expect(cookiesOf(res).join("\n")).toContain("delete_account_for=; Path=/delete-account");
      const html = await res.text();
      expect(html).toContain(text);
      expect(html).toContain('data-testid="delete-account-wrong-account"');
      expect(html).not.toContain('data-testid="delete-account-open-dialog"');
    }
    // Without the cookie: their own page. Back as the same account: the dialog, and the cookie goes
    expect(await pageText(other)).toContain('data-testid="delete-account-open-dialog"');
    const back = await page(`${mine}; ${asCookie}`);
    expect(cookiesOf(back).join("\n")).toContain("delete_account_for=; Path=/delete-account");
    expect(await back.text()).toContain('data-testid="delete-account-open-dialog"');
    expect(await progress()).toBeNull();
    expect(await readDeleteProgress(db, "u-2", NOW_MS)).toBeNull();
  });

  it("Auth fails after the erase: said as it is, and the retry erases again before the account goes", async () => {
    const cookie = await seedSession(signedInAgo(20));
    const up = upstream([reply({ complete: true }), reply({ complete: true })], [reply({}, 500), reply(DELETED)]);
    globalThis.fetch = up.fetchFn;
    const first = await del(cookie);
    expect([first.status, await first.json()]).toEqual([502, { error: "account_deletion_failed", started: true, contentErased: true }]);
    const html = await pageText(cookie);
    expect(html).toContain("Your Videos content was erased, but your sign-in account still exists");
    expect(html).toContain("anything you have added since is deleted too");
    expect(await pageText(cookie, "/delete-account?reauth=1")).toContain("still exists. Sign in again to finish");
    expect(await (await del(cookie)).json()).toMatchObject({ deleted: true });
    expect(up.urls()).toEqual([ERASE, ACCOUNT, ERASE, ACCOUNT]);
  });

  it("a deletion that worked is never shown as failed when the cleanup after it fails", async () => {
    for (const [sql, confirmed] of [
      [/UPDATE app_sessions SET revoked_at/, undefined],
      [/INSERT INTO openauth_atomic/, false],
    ] as const) {
      const cookie = await seedSession(signedInAgo(20), `sid-${sql.source.length}`);
      globalThis.fetch = upstream(
        [reply({ complete: true })],
        [() => ((failSql = sql), reply(DELETED))],
      ).fetchFn;
      const res = await del(cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean; confirmed?: boolean };
      expect(body.deleted).toBe(true);
      expect(body.confirmed).toBe(confirmed);
      expect(cookiesOf(res).some((c) => c.startsWith("profile_session=;"))).toBe(true);
      failSql = null;
    }
  });

  it("a lost last answer: the retry and a reload both find the deletion done, with no further call", async () => {
    const cookie = await seedSession(signedInAgo(20));
    globalThis.fetch = upstream(
      [reply({ complete: true })],
      [
        async () => {
          await setAccount("deleted");
          return reply(DELETED);
        },
      ],
    ).fetchFn;
    await del(cookie); // the browser never sees this
    const none = upstream([]);
    globalThis.fetch = none.fetchFn;
    const retry = await del(cookie);
    expect([retry.status, await retry.json()]).toEqual([200, { deleted: true, complete: true, erased: true }]);
    expect(await pageText(cookie)).toContain("Your Videos content was erased and your Al Ummah Now account was deleted");
    expect(none.calls).toEqual([]);
    expect(await expiry()).toBe(NOW_MS + 86400_000);
  });

  it("a Worker that died right after Auth committed: settled on the next request or view, session still open", async () => {
    const cookie = await seedSession(signedInAgo(20));
    await setRecord(record({ stage: "content_erased", leftover: "channel" }));
    expect(await expiry()).toBeNull();
    await setAccount("deleted");
    const view = await page(cookie);
    // Settled by the view alone
    expect(await expiry()).toBe(NOW_MS + 86400_000);
    expect(await progress()).toMatchObject({ stage: "deleted", leftover: "channel" });
    expect(cookiesOf(view).join("\n")).toContain("profile_session=;");
    const html = await view.text();
    expect(html).toContain("except for a channel we could not remove. It stays until our team removes it");
    expect(html).not.toContain(USER.email);
    expect(await getSession({ db, kv: kv.asKV() }, "sid-del", NOW_MS)).toBeNull();
    const none = upstream([]);
    globalThis.fetch = none.fetchFn;
    expect(await (await del(cookie)).json()).toEqual({ deleted: true, complete: true, erased: true, leftover: "channel" });
    expect(none.calls).toEqual([]);
  });

  it("an account deleted some other way: nothing is claimed about its Videos content", async () => {
    const cookie = await seedSession(signedInAgo(20));
    await setAccount("deleted");
    const res = await del(cookie);
    expect(await res.clone().json()).toEqual({ deleted: true, complete: true, erased: false });
    const html = await pageText(nonceOf(res));
    expect(html).toContain("Your Al Ummah Now account was deleted. You are signed out of all apps.");
    expect(html).not.toContain("content was erased");
    // No record to keep
    expect(await progress()).toBeNull();
  });

  it("an account deleted some other way while a deletion was under way: its record expires, without the token or a claim", async () => {
    for (const how of ["retry", "view"]) {
      const cookie = await seedSession(signedInAgo(20), `sid-${how}`);
      await setRecord(record({ resumeToken: "sealed-1" }));
      await setAccount("deleted");
      if (how === "retry") expect(await (await del(cookie)).json()).toEqual({ deleted: true, complete: true, erased: false });
      else expect(await pageText(cookie)).toContain("Your Al Ummah Now account was deleted. You are signed out of all apps.");
      expect(await expiry()).toBe(NOW_MS + 86400_000);
      const left = await progress();
      expect(left).toMatchObject({ stage: "deleted", erased: false });
      expect(left).not.toHaveProperty("resumeToken");
      // Asked again: still no claim, and the day does not start over
      vi.setSystemTime(NOW_MS + 3600_000);
      expect(await pageText(cookie)).not.toContain("content was erased");
      expect(await expiry()).toBe(NOW_MS + 86400_000);
      vi.setSystemTime(NOW_MS + 86400_001);
      expect(await readDeleteProgress(db, USER.id)).toBeNull();
      vi.setSystemTime(NOW_MS);
      await db.prepare(`DELETE FROM openauth_atomic`).run();
    }
  });

  it("two first attempts in the same millisecond: the refused one never takes the other's record away", async () => {
    const cookie = await seedSession(signedInAgo(20));
    for (const refusedFirst of [true, false]) {
      // Both start; one is refused by Videos at once, the other is still erasing
      let finish: (r: Response) => void = () => {};
      const erasing = () => new Promise<Response>((r) => { finish = r; });
      const refused = () => reply({ error: "invalid_audience" }, 401);
      let waiting = 0;
      let bothOut: () => void = () => {};
      const both = new Promise<void>((r) => { bothOut = r; });
      const answers = refusedFirst ? [refused, erasing] : [erasing, refused];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/themes/")) return new Response("", { status: 404 });
        const mine = answers.shift()!;
        if (++waiting === 2) bothOut();
        await both;
        return mine();
      }) as typeof fetch;
      const a = del(cookie);
      const b = del(cookie);
      const first = await Promise.race([a, b]);
      // The other attempt may be erasing: never "nothing was removed"
      expect(await first.json()).toEqual({ error: "videos_erasure_refused", started: true });
      expect(await progress()).toMatchObject({ stage: "started" });
      // The other Worker dies here: the page still says so
      const held = globalThis.fetch;
      globalThis.fetch = upstream([]).fetchFn;
      expect(await pageText(cookie)).toContain("was started and is not finished");
      globalThis.fetch = held;
      finish(reply({ complete: false, resumeToken: "t1" }));
      await Promise.all([a, b]);
      expect(await progress()).toMatchObject({ stage: "started", resumeToken: "t1" });
      await db.prepare(`DELETE FROM openauth_atomic`).run();
    }
  });

  it("the record's compare-and-set: made once, replaced or removed only as it was read, settled once", async () => {
    const put = (p: Partial<DeleteProgress>, expected: string | null) => putDeleteProgress(db, USER.id, record(p), expected, NOW_MS);
    const a = await put({ attempt: "a" }, null);
    expect(a).not.toBeNull();
    expect(await put({ attempt: "b" }, null)).toBeNull();
    const b = await put({ attempt: "b", resumeToken: "t" }, a);
    expect(b).not.toBeNull();
    expect(await put({ attempt: "a2" }, a)).toBeNull();
    expect(await removeDeleteProgress(db, USER.id, a!)).toBe(false);
    expect(await progress()).toMatchObject({ resumeToken: "t" });
    // Settled: in a day, without the token; not again, not by the claim-free variant, and not by a stale attempt
    await settleDeleteProgress(db, USER.id, { erased: true, leftover: "channel" }, NOW_MS);
    const settled = await readStoredProgress(db, USER.id, NOW_MS);
    expect(settled!.record).toMatchObject({ stage: "deleted", leftover: "channel" });
    await settleDeleteProgress(db, USER.id, { erased: true }, NOW_MS + 5000);
    await settleDeleteProgress(db, USER.id, { erased: false }, NOW_MS + 5000);
    expect(await put({ attempt: "b" }, b)).toBeNull();
    expect(await put({ attempt: "c" }, null)).toBeNull();
    expect(await removeDeleteProgress(db, USER.id, b!)).toBe(false);
    expect((await readStoredProgress(db, USER.id, NOW_MS))!.raw).toBe(settled!.raw);
    expect(await expiry()).toBe(NOW_MS + 86400_000);
    // Taken over on purpose, by who read it (an account restored since), or once it has run out
    expect(await put({ attempt: "d" }, settled!.raw)).not.toBeNull();
    expect(await expiry()).toBeNull();
    await db.prepare(`UPDATE openauth_atomic SET expires_at = ?1`).bind(NOW_MS - 1).run();
    expect(await put({ attempt: "e" }, null)).not.toBeNull();
    expect(await expiry()).toBeNull();
    // No record and nothing erased: none is made
    await db.prepare(`DELETE FROM openauth_atomic`).run();
    await settleDeleteProgress(db, USER.id, { erased: false }, NOW_MS);
    expect(await progress()).toBeNull();
  });

  describe("two attempts at once, at every step", () => {
    type Act = () => Promise<unknown>;
    const gone = async () => {
      await setAccount("deleted");
      await settleDeleteProgress(db, USER.id, { erased: true, leftover: "channel" }, NOW_MS);
    };
    /** What the other attempt does between two of this one's steps, by the step it comes before. */
    function between(hooks: { put?: Act; remove?: Act; read2?: Act }) {
      let reads = 0;
      const once = { ...hooks };
      const take = async (k: "put" | "remove" | "read2") => {
        const act = once[k];
        delete once[k];
        await act?.();
      };
      const state: DeletionState = {
        read: async () => {
          if (++reads > 1) await take("read2");
          return readStoredProgress(db, USER.id, NOW_MS);
        },
        put: async (p, expected) => {
          await take("put");
          return putDeleteProgress(db, USER.id, p, expected, NOW_MS);
        },
        remove: async (expected) => {
          await take("remove");
          return removeDeleteProgress(db, USER.id, expected);
        },
        accountDeleted: () => accountDeleted(db, USER.id),
      };
      return state;
    }
    const other = (p: Partial<DeleteProgress>) => () => setRecord(record({ attempt: "other", ...p }));
    const refused = () => reply({ error: "invalid_audience" }, 401);
    const settledAnswer = { ok: true, complete: true, settled: expect.objectContaining({ stage: "deleted", leftover: "channel" }) };
    const unchangedSettled = async () => {
      expect(await progress()).toMatchObject({ stage: "deleted", leftover: "channel" });
      expect(await expiry()).toBe(NOW_MS + 86400_000);
    };

    it("the other starts, saves its token, or finishes its erase before this one's marker: all it saved is kept and used", async () => {
      for (const [saved, sentToken] of [
        [{}, undefined],
        [{ resumeToken: "theirs", leftover: "channel" as const }, "theirs"],
        [{ stage: "content_erased" as const, leftover: "other" as const }, undefined],
      ] as const) {
        const up = upstream([refused]);
        const result = await run({ state: between({ put: other(saved) }), fetchFn: up.fetchFn });
        expect(up.calls.map((c) => c.body)).toEqual([{ confirm: "DELETE", ...(sentToken ? { resumeToken: sentToken } : {}) }]);
        // Refused: but the other may be erasing
        expect(result).toEqual({ ok: false, status: 502, error: "videos_erasure_refused", started: true });
        expect(await progress()).toMatchObject(saved.stage ? saved : { stage: "started", ...saved });
        await db.prepare(`DELETE FROM openauth_atomic`).run();
      }
    });

    it("the other makes the marker and is refused (removes it) before this one's: this one makes its own", async () => {
      let marker: string | null = null;
      const state = between({
        put: async () => {
          marker = await putDeleteProgress(db, USER.id, record({ attempt: "other" }), null, NOW_MS);
        },
        read2: async () => {
          expect(await removeDeleteProgress(db, USER.id, marker!)).toBe(true);
        },
      });
      expect(await run({ state, fetchFn: upstream([refused]).fetchFn })).toMatchObject({ error: "videos_erasure_refused", started: false });
      expect(await progress()).toBeNull();
    });

    it("the other deletes the account before this one's marker: answered as deleted, nothing called, its record untouched", async () => {
      const up = upstream([]);
      expect(await run({ state: between({ put: gone }), fetchFn: up.fetchFn })).toEqual(settledAnswer);
      expect(up.calls).toEqual([]);
      await unchangedSettled();
    });

    it("a settled record of a deleted account read at the start: the same", async () => {
      await gone();
      const up = upstream([]);
      expect(await run({ state: between({}), fetchFn: up.fetchFn })).toEqual(settledAnswer);
      expect(up.calls).toEqual([]);
      await unchangedSettled();
    });

    it("the other deletes the account while this one's Videos call is out, whatever that answers", async () => {
      for (const answer of [refused, () => reply({}, 429), () => reply({ complete: false, resumeToken: "mine" }), () => reply({ complete: true })]) {
        const up = upstream([
          async () => {
            await gone();
            return answer();
          },
        ]);
        expect(await run({ state: between({}), fetchFn: up.fetchFn })).toEqual(settledAnswer);
        expect(up.urls()).toEqual([ERASE]);
        await unchangedSettled();
        await db.prepare(`DELETE FROM openauth_atomic`).run();
        await setAccount("active");
      }
    });

    it("the other deletes the account between this one's refusal and its removal", async () => {
      expect(await run({ state: between({ remove: gone }), fetchFn: upstream([refused]).fetchFn })).toEqual(settledAnswer);
      await unchangedSettled();
    });

    it("the other has deleted the account but not settled its record yet: deleted, with what the record says", async () => {
      const up = upstream([
        async () => {
          await setRecord(record({ attempt: "other", stage: "content_erased", leftover: "channel" }));
          await setAccount("deleted");
          return refused();
        },
      ]);
      expect(await run({ state: between({}), fetchFn: up.fetchFn })).toEqual({
        ok: true, complete: true, settled: expect.objectContaining({ stage: "content_erased", leftover: "channel" }),
      });
    });

    it("the other takes the marker over while this one, its maker, is being refused: kept, and not \"nothing was removed\"", async () => {
      for (const answer of [refused, () => reply({ error: "insufficient_user_authentication" }, 401), () => reply({}, 429)]) {
        for (const when of ["during", "before removal"] as const) {
          const takeover = other({ resumeToken: "theirs" });
          const state = between(when === "before removal" ? { remove: takeover } : {});
          const up = upstream([
            async () => {
              if (when === "during") await takeover();
              return answer();
            },
          ]);
          expect(await run({ state, fetchFn: up.fetchFn })).toMatchObject({ ok: false, started: true });
          expect(await progress()).toMatchObject({ stage: "started", resumeToken: "theirs" });
          await db.prepare(`DELETE FROM openauth_atomic`).run();
        }
      }
    });

    it("the other came and went, erasing nothing: nothing was removed", async () => {
      const up = upstream([
        async () => {
          await db.prepare(`DELETE FROM openauth_atomic`).run();
          return refused();
        },
      ]);
      expect(await run({ state: between({}), fetchFn: up.fetchFn })).toMatchObject({ error: "videos_erasure_refused", started: false });
    });

    it("both save after their pass: the token, what is left and a finished erase all survive", async () => {
      for (const [theirs, mine, kept] of [
        [{ resumeToken: "theirs", leftover: "channel" }, { complete: false, resumeToken: "mine" }, { stage: "started", resumeToken: "mine", leftover: "channel" }],
        [{ stage: "content_erased" }, { complete: false, resumeToken: "mine", errors: ["x"] }, { stage: "content_erased", resumeToken: "mine", leftover: "other" }],
        [{ stage: "content_erased", leftover: "other" }, { complete: false, resumeToken: "mine", errors: ["channel_unreadable:c"] }, { stage: "content_erased", leftover: "channel" }],
      ] as const) {
        const up = upstream([
          async () => {
            await other(theirs as Partial<DeleteProgress>)();
            return reply(mine);
          },
        ]);
        expect(await run({ state: between({}), fetchFn: up.fetchFn })).toEqual({ ok: true, complete: false, restarted: false });
        expect(await progress()).toMatchObject(kept);
        await db.prepare(`DELETE FROM openauth_atomic`).run();
      }
    });

    it("this one's erase finishes while the other found something left: the person is asked before Auth", async () => {
      const up = upstream([
        async () => {
          await other({ stage: "content_erased", leftover: "channel" })();
          return reply({ complete: true });
        },
      ]);
      expect(await run({ state: between({}), fetchFn: up.fetchFn })).toEqual({ ok: true, complete: false, leftover: "channel" });
      expect(up.urls()).toEqual([ERASE]);
      expect(await progress()).toMatchObject({ stage: "content_erased", leftover: "channel" });
    });

    it("the other removes the marker while this one is erasing: this one's progress is written all the same", async () => {
      const up = upstream([
        async () => {
          await db.prepare(`DELETE FROM openauth_atomic`).run();
          return reply({ complete: false, resumeToken: "mine" });
        },
      ]);
      expect(await run({ state: between({}), fetchFn: up.fetchFn })).toMatchObject({ ok: true, complete: false });
      expect(await progress()).toMatchObject({ stage: "started", resumeToken: "mine" });
    });

    it("a settled record of a restored account is taken over once, and an attempt that comes second keeps the first's marker", async () => {
      await setRecord(record({ stage: "deleted", leftover: "channel" }));
      const up = upstream([refused]);
      expect(await run({ state: between({ put: other({ resumeToken: "theirs" }) }), fetchFn: up.fetchFn })).toMatchObject({ started: true });
      expect(await progress()).toMatchObject({ stage: "started", resumeToken: "theirs" });
      expect(await expiry()).toBeNull();
      await setRecord(record({ stage: "deleted", leftover: "channel" }));
      expect(await run({ state: between({}), fetchFn: upstream([() => reply({ complete: false, resumeToken: "n" })]).fetchFn })).toMatchObject({ complete: false });
      const now = await progress();
      expect(now).toMatchObject({ stage: "started", resumeToken: "n" });
      expect(now).not.toHaveProperty("leftover");
    });

    it("a marker or progress that never stops changing is an error, not a guess", async () => {
      let n = 0;
      const state = between({});
      const contested: DeletionState = { ...state, put: async (p, e) => (await setRecord(record({ attempt: `o${++n}` })), state.put(p, e)) };
      const none = upstream([]);
      expect(await run({ state: contested, fetchFn: none.fetchFn })).toEqual({ ok: false, status: 503, error: "progress_unavailable", started: true });
      expect(none.calls).toEqual([]);
      await db.prepare(`DELETE FROM openauth_atomic`).run();
      let out = false;
      const later: DeletionState = { ...state, put: async (p, e) => (out && (await setRecord(record({ attempt: `o${++n}` }))), state.put(p, e)) };
      const up = upstream([() => ((out = true), reply({ complete: true }))]);
      expect(await run({ state: later, fetchFn: up.fetchFn })).toEqual({ ok: false, status: 503, error: "progress_unavailable", started: true });
      expect(up.urls()).toEqual([ERASE]);
    });
  });

  it("a refused first attempt answers from the marker there now, on the real route", async () => {
    const cookie = await seedSession(signedInAgo(20));
    for (const [during, body, status] of [
      [async () => {}, { error: "videos_erasure_refused", started: false }, 502],
      [async () => void (await setRecord(record({ attempt: "other" }))), { error: "videos_erasure_refused", started: true }, 502],
      [async () => void (failSql = /SELECT value FROM openauth_atomic/), { error: "videos_erasure_refused", started: false }, 502],
      [async () => void (failSql = /DELETE FROM openauth_atomic/), { error: "videos_erasure_refused", started: true }, 502],
      [
        async () => {
          await setAccount("deleted");
          await settleDeleteProgress(db, USER.id, { erased: true, leftover: "channel" }, NOW_MS);
        },
        { deleted: true, complete: true, erased: true, leftover: "channel" },
        200,
      ],
    ] as [() => Promise<void>, unknown, number][]) {
      globalThis.fetch = upstream([
        async () => {
          await during();
          return reply({ error: "invalid_audience" }, 401);
        },
      ]).fetchFn;
      const res = await del(cookie);
      expect([res.status, await res.json()]).toEqual([status, body]);
      failSql = null;
      await db.prepare(`DELETE FROM openauth_atomic`).run();
    }
  });

  it("an account restored after a finished deletion starts afresh", async () => {
    const cookie = await seedSession(signedInAgo(20));
    await setRecord(record({ stage: "deleted" }));
    const html = await pageText(cookie);
    expect(html).toContain('data-testid="delete-account-open-dialog"');
    expect(html).not.toContain('data-testid="delete-account-progress-notice"');
  });

  it("state that cannot be read is an error, not an untouched page", async () => {
    const cookie = await seedSession(signedInAgo(20));
    failSql = /SELECT value FROM openauth_atomic/;
    const view = await page(cookie, "/delete-account?lang=ar");
    expect(view.status).toBe(503);
    const html = await view.text();
    expect(html).toContain("لم نتمكن من التحقق");
    expect(html).not.toContain('data-testid="delete-account-open-dialog"');
    expect(html).not.toContain('data-testid="delete-account-actions"');
    const res = await del(cookie);
    expect([res.status, await res.json()]).toEqual([503, { error: "progress_unavailable", started: false }]);
  });

  it("the record is found by its key alone (no scan) and an unreadable one still says started", async () => {
    await db.prepare(`INSERT INTO openauth_atomic (key, value) VALUES (?1, 'not json')`).bind(progressKey(USER.id)).run();
    expect(await progress()).toMatchObject({ stage: "started" });
    const plan = await db.prepare(`EXPLAIN QUERY PLAN SELECT value FROM openauth_atomic WHERE key = 'k' AND (expires_at IS NULL OR expires_at > 1)`).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join()).toMatch(/SEARCH openauth_atomic USING INDEX .*\(key=\?\)/);
  });

  it("/logout keeps a safe same-origin return to the page", async () => {
    const res = await worker.fetch(new Request(`${APP}/logout?return=${encodeURIComponent("/delete-account?lang=ar")}`, { redirect: "manual" }), env() as never, ctx);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(`${AUTH}/logout`);
    expect(loc.searchParams.get("return")).toBe(`${APP}/delete-account?lang=ar`);
  });
});
