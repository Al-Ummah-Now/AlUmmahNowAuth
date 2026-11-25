import { createClient } from "@al-ummah-now/openauth/client";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import { generatePKCE } from "@al-ummah-now/openauth/pkce";
import * as v from "valibot";
import { appsForUser, resolveAppEnv } from "./apps";
import { orchestrateAccountDeletion, resolveVideosApiUrl } from "./delete-account";
import {
  accountDeleted,
  accountDeletionOn,
  putDeleteProgress,
  putDoneProof,
  readDeleteProgress,
  readStoredProgress,
  removeDeleteProgress,
  settleDeleteProgress,
  takeDoneProof,
  type DeleteProgress,
  type DoneProof,
} from "./delete-progress";
import { localeOf, pickLocale } from "./i18n";
import { renderDeleteAccountPage, renderHomePage } from "./page";
import {
  buildAuthorizeUrl,
  clearLoginCookie,
  clearPkceCookie,
  pkceCookie,
  savedPkceVerifier,
  loginCookie,
  loginPath,
  parsePrompt,
  readCookie,
  safeReturnPath,
  savedReturnPath,
  stateMatches,
} from "./sign-in";
import {
  SESSION_COOKIE,
  createSession as createStoredSession,
  endSession,
  ensureFreshTokens,
  getSession as getStoredSession,
  sessionId,
  sessionOwner,
  type SessionStores,
  type StoredSession,
} from "./session-store";
import { aliasRedirect } from "./alias";
import { fetchAuthTheme } from './theme';
// only this app's set, so the sign-in icons are not bundled into the profile Worker
import { APP_ICONS as PROFILE_ICONS } from '../../../packages/ui/src/app-icons/profile.generated.ts';
import { iconServer } from '../../../packages/ui/src/app-icons/serve.ts';
import { NAV_ICONS } from '../../../packages/ui/src/nav/aun-nav-icons.generated.ts';
import { applyLogLevel } from '../../../packages/ui/src/log-level.ts';
import { noIndexWorker } from '../../../packages/ui/src/crawlers.ts';
import { streetResponse } from '../../../packages/ui/src/fanous-street/index.ts';

/** Account's tab and app icons (the owner's account lantern, cropped and downscaled by AlUmmahNow packages/app-icons). */
// and the account menu's app icons (every app's favicon, /aun-nav/icons/<id>.webp; never inlined in the CSS)
const serveIcon = iconServer({ ...PROFILE_ICONS, ...NAV_ICONS });

const PROFILE_CLIENT_ID = "109a1087-6626-40f7-8a7f-7f42f83f4f30";

// Define subjects matching the auth server
const subjects = createSubjects({
  user: v.object({
    id: v.string(),
    email: v.pipe(v.string(), v.email()),
    roles: v.array(v.string()),
  }),
});

interface Env {
  /** Sessions from before PF-1 (read once, then copied to D1) */
  AUTH_STORAGE: KVNamespace;
  /** The auth D1 database: sessions (`app_sessions`) */
  AUTH_DB: D1Database;
  AUTH_SERVER_URL?: string;
  APP_URL?: string;
  VIDEOS_API_URL?: string;
  /** "production" | "qa"; selects app launcher URLs (see apps.ts) */
  APP_ENV?: string;
  CF_WEB_ANALYTICS_TOKEN?: string;
  /** "warn" on QA/stage: console lines below it are dropped */
  LOG_LEVEL?: string;
}

function sessionTokenOf(request: Request): string | null {
  return readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
}

const storesOf = (env: Env): SessionStores => ({ db: env.AUTH_DB, kv: env.AUTH_STORAGE });

async function getSession(request: Request, env: Env) {
  return getStoredSession(storesOf(env), sessionTokenOf(request));
}

/**
 * The session with tokens fresh for the next REFRESH_SKEW_SECONDS, or null
 * when there is none or its tokens can no longer be refreshed (the caller
 * then re-authorizes silently).
 */
async function getFreshSession(
  request: Request,
  env: Env,
  authServerUrl: string,
): Promise<{ session: StoredSession | null; lapsed: boolean }> {
  const token = sessionTokenOf(request);
  const session = await getStoredSession(storesOf(env), token);
  if (!session || !token) return { session: null, lapsed: false };
  const fresh = await ensureFreshTokens({
    stores: storesOf(env),
    token,
    tokens: session.tokens,
    client: getAuthClient(authServerUrl),
  });
  if (fresh.ok) return { session: { ...session, tokens: fresh.tokens }, lapsed: false };
  console.info("Profile session tokens could not be refreshed; re-authorizing silently", fresh.reason);
  await endSession(storesOf(env), token);
  return { session: null, lapsed: true };
}

function createSessionCookie(sessionToken: string, isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `profile_session=${sessionToken}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

function clearSessionCookie(isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `profile_session=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

const DELETE_DONE_COOKIE = "delete_account_done";
const DELETE_DONE_TTL_SECONDS = 600;

/** Which account's deletion sent this browser to sign in again (a hash of its id; only compared). */
const DELETE_FOR_COOKIE = "delete_account_for";
const DELETE_FOR_TTL_SECONDS = 600;

function deleteForCookie(value: string, isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${DELETE_FOR_COOKIE}=${value}; Path=/delete-account; HttpOnly; ${secure}SameSite=Lax; Max-Age=${value ? DELETE_FOR_TTL_SECONDS : 0}`;
}

function createDeleteDoneCookie(nonce: string, isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${DELETE_DONE_COOKIE}=${nonce}; Path=/delete-account; HttpOnly; ${secure}SameSite=Lax; Max-Age=${DELETE_DONE_TTL_SECONDS}`;
}

function clearDeleteDoneCookie(isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${DELETE_DONE_COOKIE}=; Path=/delete-account; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

/** Cleanup after a committed deletion: a failure is logged and never turns the success into an error. */
async function bestEffort(what: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.error(`Account deleted, but: ${what}`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** What may be said once the account is gone: about Videos content only if this app erased it. */
const doneProofOf = (p: DeleteProgress | null): DoneProof =>
  p?.stage === "content_erased" || (p?.stage === "deleted" && p.erased !== false)
    ? { erased: true, ...(p.leftover ? { leftover: p.leftover } : {}) }
    : { erased: false };

// One OpenAuth client per isolate: the client caches discovery and JWKS
// inside itself, so a client per request fetched both on every verify.
// Rebuilt every 10 minutes so a rotated signing key is picked up.
const AUTH_CLIENT_TTL_MS = 10 * 60 * 1000;
const authClients = new Map<string, { client: ReturnType<typeof createClient>; createdAt: number }>();

function getAuthClient(authServerUrl: string) {
  const now = Date.now();
  const hit = authClients.get(authServerUrl);
  if (hit && now - hit.createdAt < AUTH_CLIENT_TTL_MS && now >= hit.createdAt) return hit.client;
  const client = createClient({ clientID: PROFILE_CLIENT_ID, issuer: authServerUrl });
  authClients.set(authServerUrl, { client, createdAt: now });
  return client;
}

// Get auth server URL
function getAuthServerUrl(request: Request, env: Env): string {
  // Use environment variable (configured in wrangler.json or .dev.vars)
  if (env.AUTH_SERVER_URL) {
    return env.AUTH_SERVER_URL;
  }

  // Fallback: not recommended for production
  console.warn('AUTH_SERVER_URL not configured, using fallback');
  return 'https://auth.alummahnow.net';
}

/**
 * Where /logout goes after clearing the local session: back into the auth
 * server's single sign-out chain (?next=<auth>/logout?...), or start it.
 */
function singleSignOutNext(url: URL, authServerUrl: string): string {
  const auth = new URL(authServerUrl);
  const next = url.searchParams.get("next");
  if (next) {
    try {
      const target = new URL(next);
      if (target.origin === auth.origin && target.pathname === "/logout") return target.toString();
    } catch {
      // ignore a malformed next
    }
  }
  const start = new URL("/logout", auth.origin);
  const returnPath = safeReturnPath(url.searchParams.get("return"));
  start.searchParams.set("return", `${url.origin}${returnPath}`);
  return start.toString();
}

// Get the current app URL (for OAuth redirect_uri)
function getAppUrl(request: Request, env: Env): string {
  // Use environment variable (configured in wrangler.json or .dev.vars)
  if (env.APP_URL) {
    return env.APP_URL;
  }

  // Fallback: derive from request (not recommended for production)
  const url = new URL(request.url);
  console.warn('APP_URL not configured, using request origin:', url.origin);
  return url.origin;
}

/** Shown when a callback does not match this browser's sign-in (stale, replayed or forged link). */
const INVALID_STATE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sign-in did not complete</title></head>
<body style="font-family: 'Segoe UI', Tahoma, sans-serif; background: #0f172a; color: #f8fafc; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0;">
  <main style="text-align: center; max-width: 420px; padding: 2rem;" data-testid="sign-in-expired">
    <h1 style="font-size: 1.5rem;">Sign-in did not complete</h1>
    <p style="color: #94a3b8;">This sign-in link has expired or was already used.</p>
    <p><a href="/login" data-action="retry" style="display: inline-block; padding: 0.75rem 1.5rem; background: #0ea5e9; color: #fff; border-radius: 8px; text-decoration: none;">Sign in again</a></p>
  </main>
</body>
</html>`;

const worker = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    applyLogLevel(env.LOG_LEVEL);
    const alias = aliasRedirect(request.url, env.APP_URL);
    if (alias) return alias;

    // Tab and app icons: public, no session needed
    const icon = serveIcon(new URL(request.url).pathname, request.method);
    if (icon) return icon;

    // The Fanous lantern street's files (shared module), served from this origin
    if (request.method === 'GET') {
      const street = streetResponse(new URL(request.url).pathname);
      if (street) return street;
    }

    const url = new URL(request.url);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const authServerUrl = getAuthServerUrl(request, env);

    // Handle logout
    if (url.pathname === '/logout') {
      const sessionToken = sessionTokenOf(request);
      if (sessionToken) {
        // Tombstone + delete, so a racing token refresh cannot bring it back
        await endSession(storesOf(env), sessionToken);
      }

      // Single sign-out: the auth server ends the shared sign-in and asks every
      // app to clear its own session, coming back here with ?next=
      return new Response(null, {
        status: 302,
        headers: {
          "Location": singleSignOutNext(url, authServerUrl),
          "Set-Cookie": clearSessionCookie(isLocalhost),
          "Cache-Control": "no-store",
        },
      });
    }

    // Handle token revocation (E2E testing endpoint)
    // Gets refresh token from session and calls auth server's revoke endpoint
    if (url.pathname === '/revoke' && request.method === 'POST') {
      const session = await getSession(request, env);

      if (!session || !session.tokens?.refresh) {
        return new Response(JSON.stringify({ error: 'No session or refresh token found' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      try {
        // Call auth server's revoke endpoint
        const revokeResponse = await fetch(`${authServerUrl}/token/revoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: session.tokens.refresh,
            token_type_hint: 'refresh_token',
            client_id: PROFILE_CLIENT_ID,
          }),
        });

        // Clear the local session after revocation
        const sessionToken = sessionTokenOf(request);
        if (sessionToken) {
          await endSession(storesOf(env), sessionToken);
        }

        return new Response(JSON.stringify({
          success: true,
          revoked: true,
          authServerStatus: revokeResponse.status
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearSessionCookie(isLocalhost),
          },
        });
      } catch (error) {
        console.error('Token revocation error:', error);
        return new Response(JSON.stringify({ error: 'Failed to revoke token' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Passkeys (AUTH-PASSKEYS): the hub's list, rename, remove and undo, through
    // the user's own token; adding one happens on the auth host (/passkeys/setup)
    if (url.pathname === '/passkeys/add' && request.method === 'GET') {
      const target = new URL('/passkeys/setup', authServerUrl);
      const back = new URL('/', url.origin);
      back.hash = 'passkeys';
      const lang = url.searchParams.get('lang');
      if (lang === 'ar') { target.searchParams.set('lang', 'ar'); back.searchParams.set('lang', 'ar'); }
      target.searchParams.set('return_to', url.searchParams.get('return_to') || back.toString());
      const ticket = url.searchParams.get('ticket');
      if (ticket) target.searchParams.set('ticket', ticket);
      return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api/passkeys' || url.pathname.startsWith('/api/passkeys/')) {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      // Changes only from this app's own page (CSRF)
      if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'forbidden' }, 403);
      const { session } = await getFreshSession(request, env, authServerUrl);
      if (!session || !session.user?.id) return json({ error: 'Not authenticated' }, 401);
      const rest = url.pathname.slice('/api/passkeys'.length);
      if (rest && !/^\/[A-Za-z0-9_-]{1,512}(\/restore)?$/.test(rest)) return json({ error: 'not_found' }, 404);
      const upstream = new URL(`/account/passkeys${rest}`, authServerUrl);
      const lang = url.searchParams.get('lang');
      if (lang === 'ar') upstream.searchParams.set('lang', 'ar');
      const init: RequestInit = {
        method: request.method,
        headers: { Authorization: `Bearer ${session.tokens.access}`, 'Content-Type': 'application/json' },
      };
      if (request.method === 'PATCH') init.body = await request.text();
      const res = await fetch(upstream.toString(), init);
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // Self-service account deletion API (AlUmmahNowAuth#532): one bounded step per request (delete-account.ts)
    if (url.pathname === '/api/account' && request.method === 'DELETE') {
      const json = (body: unknown, status = 200, extra: Record<string, string> = {}, cookiesToSet: string[] = []) => {
        const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
        for (const c of cookiesToSet) headers.append('Set-Cookie', c);
        return new Response(JSON.stringify(body), { status, headers });
      };
      // Changes only from this app's own page (CSRF)
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'forbidden' }, 403);
      if (!(await accountDeletionOn(env.AUTH_DB))) return json({ error: 'feature_off' }, 404);
      const body = (await request.json().catch(() => null)) as { confirm?: unknown; userId?: unknown; acceptLeftover?: unknown } | null;
      if (body?.confirm !== 'DELETE') return json({ error: 'confirmation_required' }, 400);
      const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
      if (!userId) return json({ error: 'account_mismatch' }, 409);

      const stores = storesOf(env);
      const sessionToken = sessionTokenOf(request);
      const state = {
        read: () => readStoredProgress(env.AUTH_DB, userId),
        put: (p: DeleteProgress, expected: string | null) => putDeleteProgress(env.AUTH_DB, userId, p, expected),
        remove: (expected: string) => removeDeleteProgress(env.AUTH_DB, userId, expected),
        accountDeleted: () => accountDeleted(env.AUTH_DB, userId),
      };
      /** The account is gone: from here on nothing may turn the answer into a failure. */
      const deleted = async (proof: DoneProof, deletedAt?: number) => {
        await bestEffort('its progress record stays', () => settleDeleteProgress(env.AUTH_DB, userId, proof));
        if (sessionToken) await bestEffort('the profile session could not be ended', () => endSession(stores, sessionToken));
        const nonce = crypto.randomUUID();
        const proved = await bestEffort('the confirmation could not be stored', () => putDoneProof(env.AUTH_DB, nonce, proof));
        return json(
          { deleted: true, complete: true, ...proof, ...(proved ? {} : { confirmed: false }), ...(deletedAt !== undefined ? { deletedAt } : {}) },
          200,
          {},
          // Without the stored proof the page confirms from this answer instead
          proved ? [clearSessionCookie(isLocalhost), createDeleteDoneCookie(nonce, isLocalhost)] : [clearSessionCookie(isLocalhost)],
        );
      };

      // Compared before any token refresh, so an account switch in another tab reaches no other service
      let owner: string | null;
      try {
        owner = await sessionOwner(stores, sessionToken);
      } catch {
        return json({ error: 'progress_unavailable', started: false }, 503);
      }
      if (owner !== null && owner !== userId) return json({ error: 'account_mismatch' }, 409);
      // A deletion whose last answer was lost (its session has ended with it): done, not "sign in again"
      if (owner !== null) {
        try {
          if (await state.accountDeleted()) {
            return await deleted(doneProofOf((await state.read())?.record ?? null));
          }
        } catch {
          return json({ error: 'progress_unavailable', started: false }, 503);
        }
      }
      const storedSession = await getSession(request, env);
      if (!storedSession || !storedSession.user?.id) return json({ error: 'not_authenticated' }, 401);
      if (storedSession.user.id !== userId) return json({ error: 'account_mismatch' }, 409);
      const { session } = await getFreshSession(request, env, authServerUrl);
      if (!session || !session.user?.id) return json({ error: 'not_authenticated' }, 401);
      if (session.user.id !== userId) return json({ error: 'account_mismatch' }, 409);

      const result = await orchestrateAccountDeletion({
        accessToken: session.tokens.access,
        expectedUserId: userId,
        authServerUrl,
        videosApiUrl: resolveVideosApiUrl(env.VIDEOS_API_URL, resolveAppEnv(env.APP_ENV, url.hostname)),
        state,
        ...(body.acceptLeftover === 'channel' || body.acceptLeftover === 'other' ? { acceptLeftover: body.acceptLeftover } : {}),
      });
      if (!result.ok) {
        return json(
          {
            error: result.error,
            started: result.started,
            ...(result.maxAge !== undefined ? { max_age: result.maxAge } : {}),
            ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
            ...(result.contentErased ? { contentErased: true } : {}),
          },
          result.status,
          result.retryAfter !== undefined ? { 'Retry-After': String(result.retryAfter) } : {},
        );
      }
      // The resume token stays on the server
      if (!result.complete) {
        return json({ deleted: false, complete: false, ...('leftover' in result ? { leftover: result.leftover } : result.restarted ? { restarted: true } : {}) });
      }
      if ('settled' in result) return await deleted(doneProofOf(result.settled));
      return await deleted({ erased: true, ...(result.leftover ? { leftover: result.leftover } : {}) }, result.deletedAt);
    }

    // Public web account deletion page (AlUmmahNowAuth#532; Google Play Data safety URL): signed out it says what is
    // deleted and asks to sign in. "Deleted" and the notices about an unfinished deletion come only from the database,
    // for this browser's own session or one-time proof, never from the query.
    if ((url.pathname === '/delete-account' || url.pathname === '/delete-account/') && request.method === 'GET') {
      if (!(await accountDeletionOn(env.AUTH_DB))) return new Response('Not Found', { status: 404 });
      const locale = pickLocale(request);
      const sessionToken = sessionTokenOf(request);
      const { session, lapsed } = await getFreshSession(request, env, authServerUrl);
      const doneNonce = readCookie(request.headers.get('Cookie'), DELETE_DONE_COOKIE);
      let done: DoneProof | null = null;
      let progress: DeleteProgress | null = null;
      let endedHere = lapsed;
      let accountHere: string | null = null;
      let unavailable = false;
      try {
        const owner = session?.user?.id ?? (await sessionOwner(storesOf(env), sessionToken));
        if (owner) {
          accountHere = await sessionId(owner);
          progress = await readDeleteProgress(env.AUTH_DB, owner);
          // Gone although this browser still holds its session, or held one: a lost answer
          if ((!session || progress) && (await accountDeleted(env.AUTH_DB, owner))) {
            const proof = doneProofOf(progress);
            done = proof;
            endedHere = true;
            await bestEffort('its progress record stays', () => settleDeleteProgress(env.AUTH_DB, owner, proof));
            if (session && sessionToken) await bestEffort('the profile session could not be ended', () => endSession(storesOf(env), sessionToken));
          }
          // Restored by staff after a finished deletion: nothing is under way
          if (progress?.stage === 'deleted') progress = null;
        }
        if (!done && !session && doneNonce) done = await takeDoneProof(env.AUTH_DB, doneNonce);
      } catch (error) {
        // Not knowing must not look like "nothing has happened"
        console.error('Account deletion state could not be read', error instanceof Error ? error.message : String(error));
        unavailable = true;
      }
      const reauth = url.searchParams.get('reauth') === '1';
      // The sign-in this page asked for came back as someone else
      const deletionFor = readCookie(request.headers.get('Cookie'), DELETE_FOR_COOKIE);
      const wrongAccount = !done && !unavailable && !reauth && session !== null && deletionFor !== null && deletionFor !== '' && deletionFor !== accountHere;
      const html = renderDeleteAccountPage({
        environment: env.APP_ENV,
        theme: await fetchAuthTheme(authServerUrl, PROFILE_CLIENT_ID, url.searchParams.get('theme')),
        locale,
        user: done ? null : (session?.user ?? null),
        authServerUrl,
        street: true,
        path: url.pathname + url.search,
        done,
        reauth,
        wrongAccount,
        // Erased except for something: not "erased"
        stage: done || !progress || progress.stage === 'deleted' ? null : progress.leftover ? 'started' : progress.stage,
        unavailable,
      });
      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Language': locale,
        'Cache-Control': 'no-store',
        'Vary': 'Cookie',
      });
      if (endedHere) headers.append('Set-Cookie', clearSessionCookie(isLocalhost));
      if (doneNonce && !unavailable) headers.append('Set-Cookie', clearDeleteDoneCookie(isLocalhost));
      if (reauth && accountHere && !done && !unavailable) headers.append('Set-Cookie', deleteForCookie(accountHere, isLocalhost));
      // Said or settled once
      else if (deletionFor && session && !unavailable) headers.append('Set-Cookie', deleteForCookie('', isLocalhost));
      if (unavailable) headers.set('Retry-After', '60');
      return new Response(html, { status: unavailable ? 503 : 200, headers });
    }

    // API endpoint to get user info from session (roles come from JWT)
    if (url.pathname === '/api/me') {
      const { session } = await getFreshSession(request, env, authServerUrl);

      if (!session || !session.user?.id) {
        return new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Return user info from session (roles are from JWT, refreshed on token refresh)
      return new Response(JSON.stringify({
        id: session.user.id,
        email: session.user.email,
        roles: session.user.roles || [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Sign in: straight to the auth server. No prompt by default, so a browser
    // already signed in to Al Ummah Now comes back with a code silently;
    // prompt=none (silent re-auth) and prompt=login (add account) on request.
    if (url.pathname === '/login') {
      const returnTo = safeReturnPath(url.searchParams.get('return'));
      const state = crypto.randomUUID();
      const pkce = await generatePKCE();
      const authorizeUrl = buildAuthorizeUrl({
        codeChallenge: pkce.challenge,
        authServerUrl,
        clientId: PROFILE_CLIENT_ID,
        redirectUri: `${getAppUrl(request, env)}/callback`,
        state,
        prompt: parsePrompt(url.searchParams.get('prompt')),
        // The sign-in pages follow the language the profile link asked for
        lang: localeOf(new URL(returnTo, 'https://profile.invalid').searchParams.get('lang')) === 'ar' ? 'ar' : undefined,
      });
      const headers = new Headers({ "Location": authorizeUrl, "Cache-Control": "no-store" });
      headers.append("Set-Cookie", loginCookie(state, returnTo, isLocalhost));
      headers.append("Set-Cookie", pkceCookie(state, pkce.verifier, isLocalhost));
      return new Response(null, { status: 302, headers });
    }

    // Handle OAuth callback
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const returnTo = savedReturnPath(request.headers.get("Cookie"), url.searchParams.get('state'));
      const redirectWith = (location: string, ...cookies: string[]) => {
        const headers = new Headers({ "Location": location, "Cache-Control": "no-store" });
        headers.append("Set-Cookie", clearLoginCookie(isLocalhost));
        headers.append("Set-Cookie", clearPkceCookie(isLocalhost));
        for (const c of cookies) headers.append("Set-Cookie", c);
        return new Response(null, { status: 302, headers });
      };

      // The callback must answer this browser's own /login (state == login
      // cookie). Checked before any code exchange or session change: a forged
      // callback link must not sign the browser in as someone else (login
      // CSRF) or end its current session.
      if (!stateMatches(request.headers.get("Cookie"), url.searchParams.get('state'))) {
        console.warn('OAuth callback rejected: missing or mismatched state');
        const headers = new Headers({
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        headers.append("Set-Cookie", clearLoginCookie(isLocalhost));
        headers.append("Set-Cookie", clearPkceCookie(isLocalhost));
        return new Response(INVALID_STATE_PAGE, { status: 400, headers });
      }

      if (error) {
        // Silent sign-in found no signed-in account: now show the sign-in form
        // (a plain authorize never answers login_required, so this cannot loop)
        if (error === 'login_required') {
          return redirectWith(loginPath(returnTo));
        }
        return redirectWith(`/?error=${encodeURIComponent(error)}`);
      }

      if (!code) {
        return redirectWith('/?error=missing_code');
      }

      try {
        // Exchange code for tokens
        const client = getAuthClient(authServerUrl);
        const appUrl = getAppUrl(request, env);
        const redirectUri = `${appUrl}/callback`;

        console.info('Exchanging code for tokens', { authServerUrl, appUrl, redirectUri });
        const verifier = savedPkceVerifier(request.headers.get("Cookie"), url.searchParams.get('state'));
        const result = await client.exchange(code, redirectUri, verifier);

        if (result.err !== false) {
          throw new Error(`Token exchange failed: ${result.err}`);
        }

        // Verify the token and get user info
        const verified = await client.verify(subjects, result.tokens.access, {
          refresh: result.tokens.refresh,
        });

        if ('err' in verified) {
          throw new Error(`Token verification failed: ${verified.err}`);
        }

        if (!verified.subject) {
          throw new Error("Failed to verify token - no subject returned");
        }

        const userInfo = verified.subject;
        const tokens = verified.tokens ?? result.tokens;

        // A sign-in replaces any previous profile session in this browser
        // (switching account, or signing in again after an account was removed)
        const previous = sessionTokenOf(request);
        if (previous) await endSession(storesOf(env), previous);

        const sessionToken = await createStoredSession(storesOf(env), {
          user: {
            id: userInfo.properties.id,
            email: userInfo.properties.email,
            roles: userInfo.properties.roles,
          },
          tokens: { access: tokens.access, refresh: tokens.refresh },
        });

        return redirectWith(returnTo, createSessionCookie(sessionToken, isLocalhost), clearDeleteDoneCookie(isLocalhost));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('OAuth callback error:', errorMessage);
        return redirectWith(`/?error=${encodeURIComponent(errorMessage)}`);
      }
    }

    // Serve homepage
    if (url.pathname === '/' || url.pathname === '') {
      const { session, lapsed } = await getFreshSession(request, env, authServerUrl);
      // No interstitial: without a profile session go straight into sign-in
      // (silent when the browser is signed in to Al Ummah Now). Only a failed
      // sign-in (?error=) renders the page signed out, so errors cannot loop.
      if (!session && !url.searchParams.has('error')) {
        const headers = new Headers({
          "Location": loginPath(url.pathname + url.search, lapsed ? 'none' : undefined),
          "Cache-Control": "no-store",
        });
        if (lapsed) headers.append("Set-Cookie", clearSessionCookie(isLocalhost));
        return new Response(null, { status: 302, headers });
      }
      const locale = pickLocale(request);
      const roles = session?.user?.roles ?? [];
      const appEnv = resolveAppEnv(env.APP_ENV, url.hostname);
      if (!appEnv) {
        console.warn('APP_ENV not set to production or qa; app launcher shows only this app');
      }

      const html = renderHomePage({
        environment: env.APP_ENV,
        theme: await fetchAuthTheme(authServerUrl, PROFILE_CLIENT_ID, url.searchParams.get('theme')),
        locale,
        apps: appsForUser(roles, appEnv, locale),
        user: session?.user ?? null,
        authServerUrl,
        appUrl: getAppUrl(request, env),
        clientId: PROFILE_CLIENT_ID,
        analyticsToken: env.CF_WEB_ANALYTICS_TOKEN,
        street: true,
        path: url.pathname + url.search,
        accountDeletion: await accountDeletionOn(env.AUTH_DB),
      });

      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Language': locale,
        'Vary': 'Cookie',
      });
      return new Response(html, { headers });
    }

    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Nothing on this host is for search engines: robots.txt Disallow: / and X-Robots-Tag: noindex (packages/ui/src/crawlers.ts) */
export default noIndexWorker(worker);
