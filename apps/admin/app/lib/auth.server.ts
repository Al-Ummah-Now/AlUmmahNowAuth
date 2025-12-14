// Server-side authentication utilities for admin app
import { logger } from "./logger.server";
import { getAuthServerUrl, getAppUrl, getOAuthClientId } from "./config";
import { getOpenAuthClient } from "./openauth.client.server";

// Helper to fetch fresh roles from DB
async function getUserRolesFromDB(db: D1Database, userId: string): Promise<string[]> {
  const rolesResult = await db.prepare(`
    SELECT r.name
    FROM rbac_user_roles ur
    JOIN rbac_roles r ON ur.role_id = r.id
    WHERE ur.user_id = ?
      AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
    ORDER BY r.name
  `).bind(userId).all<{ name: string }>();

  return rolesResult.results?.map(r => r.name) || [];
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
    let session: { user?: { id: string; email: string; roles?: string[] }; expiresAt?: string };
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
    return session.user;
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
  env: { AUTH_STORAGE?: KVNamespace; AUTH_DB?: D1Database; AUTH_SERVER_URL?: string },
  requireAdmin: boolean = false
) {
  const url = new URL(request.url);

  // If no storage available, always redirect to login
  if (!env?.AUTH_STORAGE) {
    logger.error('AUTH_STORAGE not available', { path: url.pathname });
    throw redirectToLogin(request);
  }

  const user = await getAuthenticatedUser(request, env as { AUTH_STORAGE: KVNamespace });

  if (!user) {
    logger.info('Unauthenticated access attempt', { path: url.pathname });
    throw redirectToLogin(request);
  }

  if (requireAdmin) {
    // Always query DB for fresh roles - don't trust cached session roles
    if (!env?.AUTH_DB) {
      logger.error('AUTH_DB not available for admin check', { path: url.pathname });
      throw new Response("Forbidden: Database not available", { status: 403 });
    }

    const roles = await getUserRolesFromDB(env.AUTH_DB, user.id);
    const hasAdminAccess = roles.includes("admin") || roles.includes("super_admin");

    if (!hasAdminAccess) {
      logger.warn('Admin access denied - redirecting to account select', { userId: user.id, email: user.email, roles });
      // Redirect to auth server with prompt=select_account to allow switching to admin account
      throw await redirectToAuthWithSelect(request, env);
    }

    // Return user with fresh roles
    return { ...user, roles };
  }

  return user;
}
