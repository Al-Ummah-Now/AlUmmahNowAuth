/**
 * Tenant-Scoped Session Cookie Utilities
 *
 * SECURITY CRITICAL: Prevents cross-tenant session replay attacks
 *
 * Without tenant isolation, a session cookie obtained on Tenant A's domain
 * could be replayed on Tenant B's domain, allowing:
 * - Cross-tenant authentication bypass
 * - Unauthorized access to other tenants' data
 * - SSO/admin actions performed in wrong tenant context
 *
 * Solution: Each tenant gets its own cookie name to prevent cross-tenant replay
 *
 * @module utils/tenant-session-cookie
 */

const SESSION_COOKIE_NAME = '__session';

interface SessionCookieOptions {
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  maxAge: number;
  domain?: string;
}

/**
 * Create tenant-scoped session cookie name
 *
 * Each tenant gets its own cookie to prevent cross-tenant replay attacks.
 *
 * @param tenantSlug - Tenant slug
 * @returns Cookie name unique to tenant
 */
export function getTenantCookieName(tenantSlug: string): string {
  // Sanitize tenant slug for cookie name
  const safeTenantSlug = tenantSlug.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return `${SESSION_COOKIE_NAME}_${safeTenantSlug}`;
}

/**
 * Create session cookie scoped to tenant domain
 *
 * @param token - Session token
 * @param tenantSlug - Tenant slug
 * @param tenantDomain - Optional custom domain for tenant
 * @returns Cookie header value
 */
export function createTenantSessionCookie(
  token: string,
  tenantSlug: string,
  tenantDomain?: string | null
): string {
  const cookieName = getTenantCookieName(tenantSlug);
  const options: SessionCookieOptions = {
    secure: true,
    sameSite: 'Lax',
    maxAge: 604800, // 7 days
  };

  // Scope cookie to tenant's domain if using custom domain
  if (tenantDomain) {
    options.domain = tenantDomain;
  }

  const parts = [
    `${cookieName}=${token}`,
    'HttpOnly',
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite}`,
  ];

  if (options.secure) parts.push('Secure');
  if (options.domain) parts.push(`Domain=${options.domain}`);
  parts.push('Path=/');

  return parts.join('; ');
}

/**
 * Parse tenant-specific session cookie from request
 *
 * @param cookieHeader - Cookie header value
 * @param tenantSlug - Tenant slug
 * @returns Session token or null
 */
export function parseTenantSessionCookie(
  cookieHeader: string | null,
  tenantSlug: string
): string | null {
  if (!cookieHeader) return null;

  const cookieName = getTenantCookieName(tenantSlug);
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith(`${cookieName}=`));

  if (!sessionCookie) return null;
  return sessionCookie.slice(cookieName.length + 1);
}

/**
 * Create a cookie header to clear tenant session cookie
 *
 * @param tenantSlug - Tenant slug
 * @param tenantDomain - Optional custom domain for tenant
 * @returns Cookie header value to clear the cookie
 */
export function clearTenantSessionCookie(
  tenantSlug: string,
  tenantDomain?: string | null
): string {
  return createTenantSessionCookie('', tenantSlug, tenantDomain).replace(
    /Max-Age=\d+/,
    'Max-Age=0'
  );
}
