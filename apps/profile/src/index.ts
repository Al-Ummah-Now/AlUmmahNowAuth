import { createClient } from "@al-ummah-now/openauth/client";
import { createSubjects } from "@al-ummah-now/openauth/subject";
import * as v from "valibot";
import { appsForUser, resolveAppEnv } from "./apps";
import { langCookie, pickLocale } from "./i18n";
import { renderHomePage } from "./page";

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

// Session management helpers
async function getSession(request: Request, storage: KVNamespace) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map(c => {
      const [key, ...v] = c.split("=");
      return [key, v.join("=")];
    })
  );

  const sessionToken = cookies["profile_session"];
  if (!sessionToken) return null;

  try {
    const sessionData = await storage.get(`session:${sessionToken}`);
    if (!sessionData) return null;

    // Parse session data with error handling
    let session: {
      expiresAt?: string;
      user?: { id: string; email: string; roles: string[] };
      tokens?: { access: string; refresh: string };
    };
    try {
      session = JSON.parse(sessionData);
    } catch (parseError) {
      console.error("Failed to parse session data, deleting corrupted session:", parseError);
      await storage.delete(`session:${sessionToken}`);
      return null;
    }

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      await storage.delete(`session:${sessionToken}`);
      return null;
    }

    return session;
  } catch (error) {
    console.error("Error retrieving session:", error);
    return null;
  }
}

async function createSession(storage: KVNamespace, sessionData: {
  user: { id: string; email: string; roles: string[] };
  tokens: { access: string; refresh: string };
  expiresAt: string;
}) {
  const sessionToken = crypto.randomUUID();

  await storage.put(
    `session:${sessionToken}`,
    JSON.stringify(sessionData),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );

  return sessionToken;
}

function createSessionCookie(sessionToken: string, isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `profile_session=${sessionToken}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

function clearSessionCookie(isLocalhost: boolean) {
  const secure = isLocalhost ? "" : "Secure; ";
  return `profile_session=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

// Get OpenAuth client
function getAuthClient(authServerUrl: string) {
  return createClient({
    clientID: PROFILE_CLIENT_ID,
    issuer: authServerUrl,
  });
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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const authServerUrl = getAuthServerUrl(request, env);

    // Handle logout
    if (url.pathname === '/logout') {
      const session = await getSession(request, env.AUTH_STORAGE);
      if (session) {
        const sessionToken = request.headers.get("Cookie")?.match(/profile_session=([^;]+)/)?.[1];
        if (sessionToken) {
          await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
        }
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
        const sessionToken = request.headers.get("Cookie")?.match(/profile_session=([^;]+)/)?.[1];
        if (sessionToken) {
          await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
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
      const session = await getSession(request, env.AUTH_STORAGE);

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

    // Handle OAuth callback
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        // Handle login_required from prompt=none - retry with normal auth flow
        if (error === 'login_required') {
          const appUrl = getAppUrl(request, env);
          const redirectUri = encodeURIComponent(`${appUrl}/callback`);
          return Response.redirect(`${authServerUrl}/authorize?response_type=code&client_id=${PROFILE_CLIENT_ID}&redirect_uri=${redirectUri}`, 302);
        }
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
      }

      if (!code) {
        return Response.redirect(`${url.origin}/?error=missing_code`, 302);
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

        // Create session
        const sessionData = {
          user: {
            id: userInfo.properties.id,
            email: userInfo.properties.email,
            roles: userInfo.properties.roles,
          },
          tokens: {
            access: result.tokens.access,
            refresh: result.tokens.refresh,
          },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };

        const sessionToken = await createSession(env.AUTH_STORAGE, sessionData);

        // Redirect to homepage with session cookie
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": createSessionCookie(sessionToken, isLocalhost),
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('OAuth callback error:', errorMessage);
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(errorMessage)}`, 302);
      }
    }

    // Serve homepage
    if (url.pathname === '/' || url.pathname === '') {
      const session = await getSession(request, env.AUTH_STORAGE);
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
