// Server-side authentication utilities for admin app
import { logger } from "./logger.server";
import { loginPath, type LoginPrompt } from "./sign-in";
import { getAppUrl } from "./config";
import { getOpenAuthClient, subjects } from "./openauth.client.server";
import {
  ensureFreshTokens,
  isSessionRevoked,
  persistSessionTokens,
  sessionKey,
  type StoredSession,
} from "./session-tokens.server";

/**
 * Check if user has admin access based on their roles
 * Case-insensitive check - OpenAuth roles are "Admin" and "Super Admin"
 */
export function hasAdminRole(roles: string[]): boolean {
  return roles.some(r =>
    r.toLowerCase() === "admin" || r.toLowerCase() === "super admin"
  );
}

// Session data structure stored in KV
type SessionData = StoredSession;

export async function getAuthenticatedUser(request: Request, env: { AUTH_STORAGE: KVNamespace }) {
  const url = new URL(request.url);
  logger.debug('getAuthenticatedUser called', { path: url.pathname });

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

  // Verify session token with AUTH_STORAGE KV
  try {
    const [sessionData, revoked] = await Promise.all([
      env.AUTH_STORAGE.get(sessionKey(sessionToken)),
      isSessionRevoked(env.AUTH_STORAGE, sessionToken),
    ]);
    if (revoked) {
      // Logged out; a racing token refresh may have written the session back.
      logger.info('Session was logged out');
      if (sessionData) await env.AUTH_STORAGE.delete(sessionKey(sessionToken));
      return null;
    }
    if (!sessionData) {
      logger.warn('Session not found in KV storage');
      return null;
    }

    // Parse session data with error handling
    let session: SessionData;
    try {
      session = JSON.parse(sessionData);
    } catch (parseError) {
      logger.error('Failed to parse session data, deleting corrupted session', {
        error: parseError instanceof Error ? parseError.message : String(parseError)
      });
      await env.AUTH_STORAGE.delete(sessionKey(sessionToken));
      return null;
    }

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      logger.info('Session expired', { userId: session.user?.id, email: session.user?.email });
      await env.AUTH_STORAGE.delete(sessionKey(sessionToken));
      return null;
    }

    // Return both user data and tokens for verification
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
  env: { AUTH_STORAGE?: KVNamespace; AUTH_SERVER_URL?: string; APP_URL?: string; ADMIN_CLIENT_ID?: string },
  requireAdmin: boolean = false
) {
  const url = new URL(request.url);

  // If no storage available, always redirect to login
  if (!env?.AUTH_STORAGE) {
    logger.error('AUTH_STORAGE not available', { path: url.pathname });
    throw redirectToLogin(request);
  }

  const sessionData = await getAuthenticatedUser(request, env as { AUTH_STORAGE: KVNamespace });

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

      // Refresh ahead of expiry and persist the rotated pair: the issuer
      // only honours the previous refresh token for 60 s after rotation.
      const fresh = await ensureFreshTokens({
        kv: env.AUTH_STORAGE,
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

      const verified = await client.verify(subjects, fresh.tokens.access, {
        refresh: fresh.tokens.refresh,
      });

      // verify() refreshes an already expired token itself; the rotated
      // pair must be saved or the next request re-sends a dead refresh token.
      if (!verified?.err && verified?.tokens) {
        const saved = await persistSessionTokens(env.AUTH_STORAGE, sessionData.sessionToken, verified.tokens);
        if (!saved) {
          logger.warn('Session logged out during verification', { userId: sessionData.user.id });
          throw redirectToLogin(request, "none");
        }
        logger.info('Persisted tokens refreshed during verification', { userId: sessionData.user.id });
      }

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
