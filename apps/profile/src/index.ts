import { createClient } from "@al-ummah-now/openauth/client";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from "valibot";
import { appsForUser, resolveAppEnv } from "./apps";
import { langCookie, pickLocale } from "./i18n";
import { renderHomePage } from "./page";
import {
  buildAuthorizeUrl,
  clearLoginCookie,
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
  type StoredSession,
} from "./session-store";

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
  AUTH_STORAGE: KVNamespace;
  AUTH_SERVER_URL?: string;
  APP_URL?: string;
  /** "production" | "qa"; selects app launcher URLs (see apps.ts) */
  APP_ENV?: string;
  CF_WEB_ANALYTICS_TOKEN?: string;
}

function sessionTokenOf(request: Request): string | null {
  return readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
}

async function getSession(request: Request, storage: KVNamespace) {
  return getStoredSession(storage, sessionTokenOf(request));
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
  const session = await getStoredSession(env.AUTH_STORAGE, token);
  if (!session || !token) return { session: null, lapsed: false };
  const fresh = await ensureFreshTokens({
    kv: env.AUTH_STORAGE,
    token,
    tokens: session.tokens,
    client: getAuthClient(authServerUrl),
  });
  if (fresh.ok) return { session: { ...session, tokens: fresh.tokens }, lapsed: false };
  console.info("Profile session tokens could not be refreshed; re-authorizing silently", fresh.reason);
  await endSession(env.AUTH_STORAGE, token);
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
  start.searchParams.set("return", `${url.origin}/`);
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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const authServerUrl = getAuthServerUrl(request, env);

    // Handle logout
    if (url.pathname === '/logout') {
      const sessionToken = sessionTokenOf(request);
      if (sessionToken) {
        // Tombstone + delete, so a racing token refresh cannot bring it back
        await endSession(env.AUTH_STORAGE, sessionToken);
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
      const session = await getSession(request, env.AUTH_STORAGE);

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
          await endSession(env.AUTH_STORAGE, sessionToken);
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
      const authorizeUrl = buildAuthorizeUrl({
        authServerUrl,
        clientId: PROFILE_CLIENT_ID,
        redirectUri: `${getAppUrl(request, env)}/callback`,
        state,
        prompt: parsePrompt(url.searchParams.get('prompt')),
      });
      return new Response(null, {
        status: 302,
        headers: {
          "Location": authorizeUrl,
          "Set-Cookie": loginCookie(state, returnTo, isLocalhost),
          "Cache-Control": "no-store",
        },
      });
    }

    // Handle OAuth callback
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const returnTo = savedReturnPath(request.headers.get("Cookie"), url.searchParams.get('state'));
      const redirectWith = (location: string, ...cookies: string[]) => {
        const headers = new Headers({ "Location": location, "Cache-Control": "no-store" });
        headers.append("Set-Cookie", clearLoginCookie(isLocalhost));
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
        const result = await client.exchange(code, redirectUri);

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
        if (previous) await endSession(env.AUTH_STORAGE, previous);

        const sessionToken = await createStoredSession(env.AUTH_STORAGE, {
          user: {
            id: userInfo.properties.id,
            email: userInfo.properties.email,
            roles: userInfo.properties.roles,
          },
          tokens: { access: tokens.access, refresh: tokens.refresh },
        });

        return redirectWith(returnTo, createSessionCookie(sessionToken, isLocalhost));
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
      const { locale, fromQuery } = pickLocale(request);
      const roles = session?.user?.roles ?? [];
      const appEnv = resolveAppEnv(env.APP_ENV, url.hostname);
      if (!appEnv) {
        console.warn('APP_ENV not set to production or qa; app launcher shows only this app');
      }

      const html = renderHomePage({
        locale,
        apps: appsForUser(roles, appEnv, locale),
        user: session?.user ?? null,
        authServerUrl,
        appUrl: getAppUrl(request, env),
        clientId: PROFILE_CLIENT_ID,
        analyticsToken: env.CF_WEB_ANALYTICS_TOKEN,
      });

      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Language': locale,
        'Vary': 'Cookie, Accept-Language',
      });
      if (fromQuery) headers.append('Set-Cookie', langCookie(locale, isLocalhost));
      return new Response(html, { headers });
    }

    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
