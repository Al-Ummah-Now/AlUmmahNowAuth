/**
 * @fileoverview Rate limiting middleware for the admin Hono routes (AU-1)
 *
 * Counts with the Workers Rate Limiting binding (ADMIN_LIMITER, or
 * ADMIN_SENSITIVE_LIMITER for destructive actions); limits live in the wrangler
 * config. Admin calls come server-side from the admin Worker, which shares an
 * egress address with every other Worker, so the bucket is the acting admin
 * (set by requireAdmin), falling back to the client IP.
 */

import type { Context, Next } from 'hono';
import { RATE_LIMIT_PERIOD_SECONDS, getClientIP, withinRateLimit } from '../rate-limit';

export interface RateLimitConfig {
	/** Bucket name, e.g. 'admin:sessions:view' */
	keyPrefix: string;
	/** Destructive action: counted on ADMIN_SENSITIVE_LIMITER */
	sensitive?: boolean;
}

type AdminContext = Context<{ Bindings: Env; Variables: { adminUser?: { userId?: string } } }>;

/** The acting admin, or the client IP when the route has no admin context. */
export function adminRateLimitSubject(c: AdminContext): string {
	const userId = c.get('adminUser')?.userId;
	return userId ? `user:${userId}` : `ip:${getClientIP(c.req.raw)}`;
}

export function rateLimit(config: RateLimitConfig) {
	return async (c: AdminContext, next: Next) => {
		const limiter = config.sensitive ? c.env.ADMIN_SENSITIVE_LIMITER : c.env.ADMIN_LIMITER;
		if (!(await withinRateLimit(limiter, `${config.keyPrefix}:${adminRateLimitSubject(c)}`))) {
			return c.json(
				{
					error: 'Too Many Requests',
					message: `Rate limit exceeded. Try again in ${RATE_LIMIT_PERIOD_SECONDS} seconds.`,
					retryAfter: RATE_LIMIT_PERIOD_SECONDS,
				},
				429,
				{ 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) }
			);
		}
		await next();
	};
}
