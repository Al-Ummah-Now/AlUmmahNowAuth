/**
 * Analytics utility for Cloudflare Workers Analytics Engine
 *
 * Tracks auth events like logins, token refreshes, errors, etc.
 */

type EventType =
  | 'login_attempt'
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'token_refresh'
  | 'token_revoke'
  | 'register'
  | 'password_reset'
  | 'rate_limit_hit'
  | 'error';

interface AnalyticsEvent {
  event: EventType;
  clientId?: string;
  userId?: string;
  email?: string;
  ipAddress?: string;
  userAgent?: string;
  duration?: number;
  errorCode?: string;
  success?: boolean;
}

/**
 * Write an analytics event to the Analytics Engine
 */
export function trackEvent(env: Env, event: AnalyticsEvent): void {
  if (!env.AUTH_ANALYTICS) {
    return; // Analytics not configured
  }

  try {
    env.AUTH_ANALYTICS.writeDataPoint({
      // Indexes - used for filtering/aggregation (max 1)
      indexes: [event.event],
      // Blobs - string data for grouping (max 20)
      blobs: [
        event.event,
        event.clientId || '',
        event.userId || '',
        event.email || '',
        event.ipAddress || '',
        event.userAgent?.substring(0, 100) || '', // Truncate user agent
        event.errorCode || '',
        event.success !== undefined ? (event.success ? 'success' : 'failure') : '',
      ],
      // Doubles - numeric data (max 20)
      doubles: [
        event.duration || 0,
        event.success ? 1 : 0,
        Date.now(),
      ],
    });
  } catch (error) {
    // Don't let analytics errors affect the main flow
    console.error('Analytics write error:', error);
  }
}

/**
 * Track request timing
 */
export function trackRequestTiming(
  env: Env,
  path: string,
  method: string,
  statusCode: number,
  durationMs: number,
  clientIp?: string
): void {
  if (!env.AUTH_ANALYTICS) {
    return;
  }

  try {
    env.AUTH_ANALYTICS.writeDataPoint({
      indexes: ['request'],
      blobs: [
        'request',
        path,
        method,
        String(statusCode),
        clientIp || '',
      ],
      doubles: [
        durationMs,
        statusCode >= 200 && statusCode < 400 ? 1 : 0,
        Date.now(),
      ],
    });
  } catch (error) {
    console.error('Analytics write error:', error);
  }
}
