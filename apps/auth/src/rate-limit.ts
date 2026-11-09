/**
 * Rate limiting with the Workers Rate Limiting binding (AU-1).
 *
 * The old limiter kept a JSON array of timestamps per key in KV (get, filter,
 * push, put). KV allows about one write per second per key and has no atomic
 * update, so a busy key (every first-party /token call shared one) lost
 * increments, returned 429 on the put, and then failed open, while a PoP whose
 * stale copy was full locked everyone out. The binding is an atomic counter per
 * location with no storage writes; each binding's limit and period (10 or 60 s)
 * live in the wrangler config (`ratelimits`), per environment.
 *
 * Bindings (see apps/auth/wrangler*.json):
 * - TOKEN_LIMITER: /token per user (refresh) or per client IP
 * - TOKEN_CLIENT_LIMITER: /token per client for our own server-side apps
 * - SEND_CODE_LIMITER: verification emails per client IP (per address for E2E)
 * - ADMIN_LIMITER: admin API reads and actions per admin
 * - ADMIN_SENSITIVE_LIMITER: destructive admin actions per admin
 * - PASSWORD_IP_LIMITER / PASSWORD_EMAIL_LIMITER: password POSTs (security/password-guard.ts)
 */
import { logger } from './logger';

/** All our bindings count per 60-second period; a refused client is told to wait that long. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * Counts one request for `key`. True when it is within the limit.
 *
 * A missing binding (local dev, unit tests) allows; production configs are
 * required to have every binding (scripts/release/apps.ts, /health?deep=1).
 * A binding error also allows: the counter is a safety net, never the only
 * defence (attempt limits that matter are in D1, see security/password-attempts.ts).
 */
export async function withinRateLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		const { success } = await limiter.limit({ key });
		if (!success) logger.warn('Rate limit exceeded', { key });
		return success;
	} catch (error) {
		logger.error('Rate limiter failed', { key, error: error instanceof Error ? error.message : String(error) });
		return true;
	}
}

/**
 * Get the client IP address from the request
 *
 * Cloudflare provides the client IP in the CF-Connecting-IP header.
 * Falls back to X-Forwarded-For or X-Real-IP if CF-Connecting-IP is not available.
 *
 * @param request - The incoming HTTP request
 * @returns Client IP address or 'unknown' if not available
 */
export function getClientIP(request: Request): string {
	// Cloudflare provides the real client IP in this header
	const cfConnectingIP = request.headers.get('CF-Connecting-IP');
	if (cfConnectingIP) {
		return cfConnectingIP;
	}

	// Fallback headers (less reliable on Cloudflare)
	const xForwardedFor = request.headers.get('X-Forwarded-For');
	if (xForwardedFor) {
		// X-Forwarded-For can contain multiple IPs, take the first one
		return xForwardedFor.split(',')[0].trim();
	}

	const xRealIP = request.headers.get('X-Real-IP');
	if (xRealIP) {
		return xRealIP;
	}

	logger.warn('Unable to determine client IP address');
	return 'unknown';
}
