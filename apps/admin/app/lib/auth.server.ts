// Server-side authentication utilities for admin app
import { logger } from "./logger.server";
import { loginPath, type LoginPrompt } from "./sign-in";
import { getAppUrl } from "./config";
import { getOpenAuthClient, subjects } from "./openauth.client.server";
import { ensureFreshTokens, getSession, type SessionStores } from "./session-tokens.server";

/** The bindings sessions need: the auth D1, and KV for sessions from before AD-1. */
export interface SessionEnv {
  AUTH_DB?: D1Database;
  AUTH_STORAGE?: KVNamespace;
}

export function sessionStores(env: SessionEnv | undefined): SessionStores | null {
  return env?.AUTH_DB && env.AUTH_STORAGE ? { db: env.AUTH_DB, kv: env.AUTH_STORAGE } : null;
}

/**
 * Check if user has admin access based on their roles
 * Case-insensitive check - OpenAuth roles are "Admin" and "Super Admin"
 */
export function hasAdminRole(roles: string[]): boolean {
  return roles.some(r =>
    r.toLowerCase() === "admin" || r.toLowerCase() === "super admin"
  );
}

export async function getAuthenticatedUser(request: Request, env: SessionEnv) {
  const url = new URL(request.url);
  logger.debug('getAuthenticatedUser called', { path: url.pathname });

  const stores = sessionStores(env);
  if (!stores) return null;

  // Get session cookie
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }

  // Parse cookies to find session token
  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map(c => {
      const [key, ...v] = c.split("=");
      return [key, v.join("=")];
    })
  );

  const sessionToken = cookies["auth_session"];
  if (!sessionToken) {
    return null;
  }

  // D1 is read current everywhere: a logout anywhere is seen here at once
  try {
    const session = await getSession(stores, sessionToken);
    if (!session) {
      logger.info('No live session for this cookie');
      return null;
    }
    return {
      sessionToken,
      user: session.user,
      tokens: session.tokens
    };
  } catch (error) {
    logger.error("Error verifying session", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Into sign-in, coming back to this page. No prompt for a missing session
 * (auth signs in silently when the browser is signed in, else the form);
 * prompt=none when the session's tokens lapsed (silent re-auth; only a
 * login_required answer then shows the form).
 */
export function redirectToLogin(request: Request, prompt?: LoginPrompt) {
  const url = new URL(request.url);
  const redirectUrl = new URL(loginPath(url.pathname + url.search, prompt), url.origin);

  return Response.redirect(redirectUrl.toString(), 302);
}

// Redirect to auth server with prompt=select_account to switch accounts
export async function redirectToAuthWithSelect(request: Request, env: { AUTH_SERVER_URL?: string; APP_URL?: string; ADMIN_CLIENT_ID?: string }) {
  const appUrl = getAppUrl(request, env);
  const client = getOpenAuthClient(request, env);

  // Generate authorize URL with prompt=select_account for account picker
  const { url: baseAuthorizeUrl } = await client.authorize(`${appUrl}/auth/callback`, "code");
  const authorizeUrl = `${baseAuthorizeUrl}&prompt=select_account`;

  logger.info('Redirecting non-admin user to account select', { authorizeUrl });

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
    },
  });
}

export async function requireAuth(
  request: Request,
  env: SessionEnv & { AUTH_SERVER_URL?: string; APP_URL?: string; ADMIN_CLIENT_ID?: string },
  requireAdmin: boolean = false
) {
  const url = new URL(request.url);

  // If no storage available, always redirect to login
  const stores = sessionStores(env);
  if (!stores) {
    logger.error('AUTH_DB / AUTH_STORAGE not available', { path: url.pathname });
    throw redirectToLogin(request);
  }

  const sessionData = await getAuthenticatedUser(request, env);

  if (!sessionData) {
    logger.info('Unauthenticated access attempt', { path: url.pathname });
    throw redirectToLogin(request);
  }

  if (requireAdmin) {
    // Verify access token to get fresh roles from claims
    try {
      const client = getOpenAuthClient(request, env);

      logger.debug('Verifying access token for admin check', {
        userId: sessionData.user.id,
        email: sessionData.user.email
      });

      // Refresh ahead of expiry, one refresh per session at a time (AD-1): the
      // issuer only honours the previous refresh token for 60 s after rotation.
      const fresh = await ensureFreshTokens({
        stores,
        sessionToken: sessionData.sessionToken,
        tokens: sessionData.tokens,
        client,
      });
      if (!fresh.ok) {
        logger.warn('Session tokens could not be refreshed', {
          reason: fresh.reason,
          userId: sessionData.user.id
        });
        throw redirectToLogin(request, "none");
      }

      // No refresh token here: verify() would refresh an expired token itself,
      // outside the per-session lock. An access token that lapsed in between
      // fails verification and the admin re-authorizes silently.
      const verified = await client.verify(subjects, fresh.tokens.access);

      // Check if verification returned an error
      if (verified?.err) {
        logger.error('Token verification failed during admin check', {
          error: verified.err,
          userId: sessionData.user.id
        });
        throw redirectToLogin(request, "none");
      }

      if (!verified || !verified.subject) {
        logger.error('Token verification failed - no subject', {
          userId: sessionData.user.id
        });
        throw redirectToLogin(request);
      }

      // Extract roles from verified token
      const userRoles = verified.subject.properties.roles || [];

      if (!hasAdminRole(userRoles)) {
        logger.warn('Admin access denied - redirecting to account select', {
          userId: sessionData.user.id,
          email: sessionData.user.email,
          roles: userRoles
        });
        // Redirect to auth server with prompt=select_account to allow switching to admin account
        throw await redirectToAuthWithSelect(request, env);
      }

      // Return user with fresh roles from token
      return {
        id: sessionData.user.id,
        email: sessionData.user.email,
        roles: userRoles
      };
    } catch (error) {
      // If error is already a Response (redirect), rethrow it
      if (error instanceof Response) {
        throw error;
      }

      logger.error('Error during token verification for admin check', {
        error: error instanceof Error ? error.message : String(error),
        userId: sessionData.user.id
      });
      throw redirectToLogin(request);
    }
  }

  return sessionData.user;
}
