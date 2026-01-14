/**
 * @fileoverview CORS utilities for origin matching and validation
 */

/**
 * Check if an origin matches allowed origins (supports wildcards like *.example.com)
 *
 * @param origin - The origin to check
 * @param allowedOrigins - Array of allowed origins (can include wildcards like *.example.com)
 * @returns True if the origin matches any allowed pattern
 *
 * @example
 * matchOrigin('https://sub.example.com', ['*.example.com']); // true
 * matchOrigin('https://example.com', ['*.example.com']); // false (exact domain doesn't match wildcard)
 * matchOrigin('https://app.example.com', ['https://app.example.com']); // true
 */
export function matchOrigin(origin: string, allowedOrigins: string[]): boolean {
	for (const allowed of allowedOrigins) {
		if (allowed.startsWith('*.')) {
			// Wildcard match: *.example.com matches sub.example.com
			const domain = allowed.slice(2); // Remove "*."
			try {
				const originHost = new URL(origin).hostname;
				if (originHost.endsWith(domain) && originHost !== domain) {
					return true;
				}
			} catch {
				continue;
			}
		} else if (allowed === origin) {
			return true;
		}
	}
	return false;
}

/**
 * Get allowed origins from env, supporting wildcards
 *
 * Returns origins suitable for CORS headers. Wildcard patterns are resolved
 * to actual origins when the request origin matches.
 *
 * @param env - Environment with ALLOWED_ORIGINS config
 * @param requestOrigin - The origin from the request (optional)
 * @returns Array of allowed origins (without wildcards, suitable for headers)
 *
 * @example
 * // env.ALLOWED_ORIGINS = "https://app.example.com,*.example.com"
 * getAllowedOrigins(env, 'https://sub.example.com');
 * // Returns: ['https://app.example.com', 'https://sub.example.com']
 */
export function getAllowedOrigins(
	env: { ALLOWED_ORIGINS?: string },
	requestOrigin?: string | null
): string[] {
	const origins = env.ALLOWED_ORIGINS
		? env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim())
		: [];

	// If request origin matches a wildcard pattern, include it explicitly
	if (requestOrigin && matchOrigin(requestOrigin, origins)) {
		// Return the actual origin for CORS header (wildcards don't work in headers)
		if (!origins.includes(requestOrigin)) {
			return [...origins.filter((o) => !o.startsWith('*.')), requestOrigin];
		}
	}

	return origins.filter((o) => !o.startsWith('*.'));
}

/**
 * Create CORS headers for a response
 *
 * @param origin - The request origin
 * @param env - Environment with ALLOWED_ORIGINS config
 * @param methods - Allowed HTTP methods (default: GET, POST, DELETE, OPTIONS)
 * @returns Headers object with CORS headers, or null if origin not allowed
 */
export function createCorsHeaders(
	origin: string | null,
	env: { ALLOWED_ORIGINS?: string },
	methods: string = 'GET, POST, DELETE, OPTIONS'
): Record<string, string> | null {
	if (!origin) return null;

	const allowedOrigins = getAllowedOrigins(env, origin);
	const allConfiguredOrigins = env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) || [];
	const isAllowed = matchOrigin(origin, [...allowedOrigins, ...allConfiguredOrigins]);

	if (!isAllowed) return null;

	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': methods,
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Max-Age': '86400',
	};
}
