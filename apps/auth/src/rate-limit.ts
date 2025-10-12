import { logger } from './logger';

/**
 * Rate limit result returned by checkRateLimit
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the current window */
  remaining: number;
  /** Unix timestamp (seconds) when the rate limit resets */
  resetAt: number;
}

/**
 * Stored rate limit data in KV
 */
interface RateLimitData {
  /** Array of request timestamps (Unix time in milliseconds) */
  requests: number[];
  /** Expiry timestamp (Unix time in seconds) */
  expiresAt: number;
}

/**
 * Check rate limit using sliding window algorithm
 *
 * This function implements a sliding window rate limiter using Cloudflare KV.
 * It tracks request timestamps and allows a specified number of requests
 * within a rolling time window.
 *
 * @param storage - Cloudflare KV namespace for storing rate limit data
 * @param key - Unique identifier for the rate limit (e.g., IP address, user ID)
 * @param limit - Maximum number of requests allowed in the window
 * @param windowSeconds - Time window in seconds
 * @returns Rate limit result with allowed status, remaining count, and reset time
 *
 * @example
 * ```typescript
 * const result = await checkRateLimit(
 *   env.AUTH_STORAGE,
 *   `login:${clientIP}`,
 *   5,
 *   300 // 5 requests per 5 minutes
 * );
 *
 * if (!result.allowed) {
 *   return new Response('Too Many Requests', {
 *     status: 429,
 *     headers: { 'Retry-After': String(result.resetAt - Math.floor(Date.now() / 1000)) }
 *   });
 * }
 * ```
 */
export async function checkRateLimit(
  storage: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  logger.debug('Checking rate limit', { key, limit, windowSeconds });

  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);
  const rateLimitKey = `ratelimit:${key}`;

  try {
    // Get existing rate limit data
    const existingData = await storage.get(rateLimitKey);
    let data: RateLimitData;

    if (existingData) {
      try {
        data = JSON.parse(existingData) as RateLimitData;
      } catch (parseError) {
        logger.warn('Failed to parse rate limit data, resetting', { key, error: parseError });
        data = { requests: [], expiresAt: Math.floor((now + windowSeconds * 1000) / 1000) };
      }
    } else {
      data = { requests: [], expiresAt: Math.floor((now + windowSeconds * 1000) / 1000) };
    }

    // Filter out requests outside the sliding window
    const recentRequests = data.requests.filter(timestamp => timestamp > windowStart);

    // Check if limit is exceeded
    const allowed = recentRequests.length < limit;
    const remaining = Math.max(0, limit - recentRequests.length - (allowed ? 1 : 0));

    // Calculate reset time (when the oldest request will fall outside the window)
    let resetAt: number;
    if (recentRequests.length > 0) {
      const oldestRequest = Math.min(...recentRequests);
      resetAt = Math.floor((oldestRequest + windowSeconds * 1000) / 1000);
    } else {
      resetAt = Math.floor((now + windowSeconds * 1000) / 1000);
    }

    // If allowed, add current request timestamp
    if (allowed) {
      recentRequests.push(now);

      // Store updated data in KV with TTL
      const updatedData: RateLimitData = {
        requests: recentRequests,
        expiresAt: Math.floor((now + windowSeconds * 1000) / 1000),
      };

      await storage.put(
        rateLimitKey,
        JSON.stringify(updatedData),
        { expirationTtl: windowSeconds + 60 } // Add 60s buffer to TTL
      );

      logger.debug('Rate limit check passed', { key, remaining, resetAt });
    } else {
      logger.warn('Rate limit exceeded', { key, limit, windowSeconds, requestCount: recentRequests.length });
    }

    return {
      allowed,
      remaining,
      resetAt,
    };
  } catch (error) {
    logger.error('Rate limit check failed', { key, error: error instanceof Error ? error.message : String(error) });

    // On error, allow the request but log the failure
    // This ensures rate limiting failures don't block legitimate traffic
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt: Math.floor((now + windowSeconds * 1000) / 1000),
    };
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
