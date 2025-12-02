/**
 * @fileoverview Rate limiting middleware for Hono routes
 *
 * Provides middleware for applying rate limits to routes using KV-based
 * sliding window algorithm. Supports both IP-based and custom key rate limiting.
 */

import { checkRateLimit, getClientIP } from '../rate-limit';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
	/** Maximum number of requests allowed in the window */
	limit: number;
	/** Time window in seconds */
	window: number;
	/** Optional custom key prefix for rate limit (default: uses IP) */
	keyPrefix?: string;
	/** Optional custom key generator function */
	keyGenerator?: (c: any) => string;
}

/**
 * Rate limiting middleware factory
 *
 * Creates a middleware that applies rate limiting based on IP address
 * or custom key. Returns 429 Too Many Requests when limit is exceeded.
 *
 * @param config - Rate limit configuration
 * @returns Hono middleware
 *
 * @example
 * ```typescript
 * // IP-based rate limiting
 * app.get('/api/data', rateLimit({ limit: 100, window: 60 }), handler);
 *
 * // Custom key-based rate limiting
 * app.post('/login', rateLimit({
 *   limit: 5,
 *   window: 300,
 *   keyPrefix: 'login',
 *   keyGenerator: (c) => c.req.json().email
 * }), loginHandler);
 * ```
 */
export function rateLimit(config: RateLimitConfig) {
	return async (c: any, next: () => Promise<void>) => {
		const { limit, window, keyPrefix, keyGenerator } = config;

		// Generate rate limit key
		let key: string;
		if (keyGenerator) {
			key = keyGenerator(c);
		} else {
			const ip = getClientIP(c.req.raw);
			key = ip;
		}

		// Add prefix if provided
		const rateLimitKey = keyPrefix ? `${keyPrefix}:${key}` : key;

		// Check rate limit
		const result = await checkRateLimit(c.env.AUTH_STORAGE, rateLimitKey, limit, window);

		if (!result.allowed) {
			const retryAfter = result.resetAt - Math.floor(Date.now() / 1000);
			return c.json(
				{
					error: 'Too Many Requests',
					message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
					retryAfter,
				},
				429,
				{
					'Retry-After': String(retryAfter),
					'X-RateLimit-Limit': String(limit),
					'X-RateLimit-Remaining': String(result.remaining),
					'X-RateLimit-Reset': String(result.resetAt),
				}
			);
		}

		// Add rate limit headers to response
		c.header('X-RateLimit-Limit', String(limit));
		c.header('X-RateLimit-Remaining', String(result.remaining));
		c.header('X-RateLimit-Reset', String(result.resetAt));

		await next();
	};
}
