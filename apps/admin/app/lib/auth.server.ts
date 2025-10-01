// Server-side authentication utilities for admin app
import { logger } from "~/lib/logger.server";

export async function getAuthenticatedUser(request: Request, env: { AUTH_STORAGE: KVNamespace }) {
  const url = new URL(request.url);
  logger.debug('getAuthenticatedUser called', { path: url.pathname });
  
  // Get session cookie
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    logger.debug('No cookie header found');
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
    logger.debug('No auth_session cookie found');
    return null;
  }

  // Verify session token with AUTH_STORAGE KV
  try {
    const sessionData = await env.AUTH_STORAGE.get(`session:${sessionToken}`);
    if (!sessionData) {
      logger.warn('Session not found in KV storage', { sessionToken: sessionToken.substring(0, 10) + '...' });
      return null;
    }

    const session = JSON.parse(sessionData);

    // Check if session is expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      logger.info('Session expired', { userId: session.user?.id, email: session.user?.email });
      await env.AUTH_STORAGE.delete(`session:${sessionToken}`);
      return null;
    }

    logger.debug('User authenticated successfully', { userId: session.user?.id, email: session.user?.email, role: session.user?.role });
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

export async function requireAuth(
  request: Request,
  env: { AUTH_STORAGE?: KVNamespace },
  requireAdmin: boolean = false
) {
  const url = new URL(request.url);
  logger.debug('requireAuth called', { path: url.pathname, requireAdmin });
  
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

  if (requireAdmin && user.role !== "admin") {
    logger.warn('Non-admin tried to access admin-only resource', { 
      userId: user.id, 
      email: user.email, 
      role: user.role, 
      path: url.pathname 
    });
    throw new Response("Forbidden: Admin access required", { status: 403 });
  }

  logger.debug('Auth check passed', { 
    userId: user.id, 
    email: user.email, 
    role: user.role, 
    path: url.pathname,
    adminRequired: requireAdmin
  });
  
  return user;
}
