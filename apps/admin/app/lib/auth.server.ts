// Server-side authentication utilities for admin app
import { logger } from "./logger.server";
import { getAuthServerUrl, getAppUrl, getOAuthClientId } from "./config";
import { getOpenAuthClient, subjects } from "./openauth.client.server";

// Session data structure stored in KV
interface SessionData {
  user: {
    id: string;
    email: string;
    roles: string[];
  };
  tokens: {
    access: string;
    refresh?: string;
  };
  expiresAt: string;
}

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
    const sessionData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
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
      await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
      return null;
    }

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      logger.info('Session expired', { userId: session.user?.id, email: session.user?.email });
      await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
      return null;
    }

    // Return both user data and tokens for verification
    return {
      user: session.user,
      tokens: session.tokens
    };
  } catch (error) {
    logger.error("Error verifying session", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export function redirectToLogin(request: Request) {
  const url = new URL(request.url);
  const redirectUrl = new URL("/login", url.origin);
  redirectUrl.searchParams.set("redirect", url.pathname);

  return Response.redirect(redirectUrl.toString(), 302);
}

// Redirect to auth server with prompt=select_account to switch accounts
export async function redirectToAuthWithSelect(request: Request, env: { AUTH_SERVER_URL?: string; APP_URL?: string }) {
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
  env: { AUTH_STORAGE?: KVNamespace; AUTH_SERVER_URL?: string; APP_URL?: string },
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

      const verified = await client.verify(subjects, sessionData.tokens.access, {
        refresh: sessionData.tokens.refresh,
      });

      // Check if verification returned an error
      if (verified?.err) {
        logger.error('Token verification failed during admin check', {
          error: verified.err,
          userId: sessionData.user.id
        });
        throw redirectToLogin(request);
      }

      if (!verified || !verified.subject) {
        logger.error('Token verification failed - no subject', {
          userId: sessionData.user.id
        });
        throw redirectToLogin(request);
      }

      // Extract roles from verified token
      const userRoles = verified.subject.properties.roles || [];
      // Case-insensitive check - OpenAuth roles are "Admin" and "Super Admin"
      const hasAdminAccess = userRoles.some(r =>
        r.toLowerCase() === "admin" || r.toLowerCase() === "super admin"
      );

      if (!hasAdminAccess) {
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
