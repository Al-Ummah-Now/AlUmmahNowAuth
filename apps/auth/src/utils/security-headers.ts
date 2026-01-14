/**
 * @fileoverview Security headers utility for HTTP responses
 */

/**
 * Add security headers to response
 *
 * Applies comprehensive security headers to all responses:
 * - X-Content-Type-Options: Prevent MIME type sniffing
 * - X-Frame-Options: Prevent clickjacking
 * - X-XSS-Protection: Enable browser XSS protection
 * - Referrer-Policy: Control referrer information
 * - Strict-Transport-Security: Enforce HTTPS (production only)
 * - Content-Security-Policy: Restrict resource loading
 *
 * @param response - The response to add headers to
 * @param isProduction - Whether the app is running in production
 * @returns Response with security headers applied
 */
export function addSecurityHeaders(
	response: Response,
	isProduction: boolean = true
): Response {
	const headers = new Headers(response.headers);

	// Prevent MIME type sniffing
	headers.set('X-Content-Type-Options', 'nosniff');

	// Prevent clickjacking
	headers.set('X-Frame-Options', 'DENY');

	// Enable XSS protection (legacy browsers)
	headers.set('X-XSS-Protection', '1; mode=block');

	// Control referrer information
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	// Enforce HTTPS in production
	if (isProduction) {
		// HSTS: Enforce HTTPS for 1 year, include subdomains
		headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}

	// Content Security Policy
	// - default-src 'self': Only load resources from same origin by default
	// - script-src 'self' 'unsafe-inline': Allow inline scripts for OpenAuth UI
	// - style-src: Allow inline styles, Tailwind preflight, and Google Fonts CSS for OpenAuth UI
	// - img-src 'self' data: https: Allow images from same origin, data URIs, and HTTPS
	// - font-src 'self' https://fonts.gstatic.com: Allow fonts from same origin and Google Fonts
	// - connect-src 'self': Only make network requests to same origin
	// - frame-ancestors 'none': Prevent embedding (same as X-Frame-Options: DENY)
	headers.set(
		'Content-Security-Policy',
		"default-src 'self'; " +
			"script-src 'self' 'unsafe-inline'; " +
			"style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
			"img-src 'self' data: https:; " +
			"font-src 'self' https://fonts.gstatic.com; " +
			"connect-src 'self'; " +
			"frame-ancestors 'none'"
	);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
