/**
 * @fileoverview Session cookie utilities for browser session management
 *
 * Provides utilities for creating and clearing session cookies used by
 * the multi-account browser session system.
 */

const SESSION_COOKIE_NAME = '__session';

interface SessionCookieOptions {
	secure: boolean;
	sameSite: 'Strict' | 'Lax' | 'None';
	maxAge: number;
	domain?: string;
}

/**
 * Create session cookie header value
 *
 * Creates a secure HTTP-only session cookie with appropriate security settings.
 * Uses SameSite=None; Secure to support cross-origin requests from profile/admin apps.
 *
 * SECURITY NOTE: SameSite=None is required for cross-origin requests with credentials,
 * which is needed for the account switcher in profile/admin apps on different subdomains.
 * The Secure flag is always required when using SameSite=None.
 *
 * @param token - Browser session token
 * @param domain - Optional custom domain for the cookie (e.g., '.alummahnow.net' for sharing across subdomains)
 * @returns Cookie header value
 *
 * @example
 * ```typescript
 * const cookie = createSessionCookie(sessionToken);
 * c.header('Set-Cookie', cookie);
 * ```
 */
export function createSessionCookie(token: string, domain?: string, isLocalhost: boolean = false): string {
	// Always use SameSite=None to support cross-origin requests from profile/admin apps
	// For localhost: browsers allow SameSite=None without Secure flag
	// For production: SameSite=None requires Secure flag
	const options: SessionCookieOptions = {
		secure: !isLocalhost,
		sameSite: 'None',
		maxAge: 604800, // 7 days (matches SESSION_LIFETIME_DAYS)
	};

	if (domain) {
		options.domain = domain;
	}

	const parts = [`${SESSION_COOKIE_NAME}=${token}`, 'HttpOnly', `Max-Age=${options.maxAge}`, `SameSite=${options.sameSite}`];

	if (options.secure) {
		parts.push('Secure');
	}
	if (options.domain) {
		parts.push(`Domain=${options.domain}`);
	}
	parts.push('Path=/');

	return parts.join('; ');
}

/**
 * Parse session cookie from request
 *
 * Extracts the session token from the Cookie header.
 *
 * @param cookieHeader - Cookie header value from request
 * @returns Session token or null if not found
 *
 * @example
 * ```typescript
 * const token = parseSessionCookie(c.req.header('Cookie'));
 * if (token) {
 *   const session = await sessionService.getByToken(token);
 * }
 * ```
 */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(';').map((c) => c.trim());
	const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

	if (!sessionCookie) return null;
	return sessionCookie.slice(SESSION_COOKIE_NAME.length + 1);
}

/**
 * Create a cookie header to clear the session cookie
 *
 * Returns a Set-Cookie header that expires the session cookie immediately.
 * Used when signing out all accounts or when the last account is removed.
 *
 * @param domain - Optional custom domain for the cookie
 * @returns Cookie header value to clear the cookie
 *
 * @example
 * ```typescript
 * c.header('Set-Cookie', clearSessionCookie());
 * ```
 */
export function clearSessionCookie(domain?: string, isLocalhost: boolean = false): string {
	return createSessionCookie('', domain, isLocalhost).replace(/Max-Age=\d+/, 'Max-Age=0');
}
