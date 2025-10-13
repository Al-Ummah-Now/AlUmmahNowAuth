/**
 * Admin DLQ Management Routes
 *
 * Provides HTTP endpoints for managing the webhook Dead Letter Queue
 */

import * as v from 'valibot';
import { DLQReplayService } from './dlq-replay';
import { getUserSession } from './session';
import { checkRateLimit, getClientIP } from './rate-limit';

const replaySchema = v.object({
  batchSize: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(100))),
  maxAge: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(720))), // Max 30 days
  filterStatus: v.optional(v.union([v.literal('pending'), v.literal('failed')])),
  webhookUrl: v.optional(v.pipe(v.string(), v.url())),
  dryRun: v.optional(v.boolean()),
});

const cleanupSchema = v.object({
  maxAge: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(365))), // Max 1 year
  statusFilter: v.optional(v.string()),
});

/**
 * Verify admin authentication
 *
 * Validates that the request has a valid session token and the user has admin role.
 * Supports both Authorization header (Bearer token) and cookie-based authentication.
 */
async function verifyAdminAuth(request: Request, storage: KVNamespace): Promise<boolean> {
  try {
    // Get user session from cookie or Authorization header
    const session = await getUserSession(request, storage);

    if (!session || !session.user) {
      return false;
    }

    // Verify user has admin role
    return session.user.role === 'admin';
  } catch (error) {
    console.error('Admin auth verification failed:', error);
    return false;
  }
}

/**
 * Handle DLQ replay requests
 */
export async function handleDLQReplay(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Verify admin authentication
  if (!(await verifyAdminAuth(request, env.AUTH_STORAGE))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Rate limiting: 10 replay requests per hour per admin (Issue #5)
  const clientIP = getClientIP(request);
  const rateLimitKey = `admin:dlq:replay:${clientIP}`;
  const rateLimit = await checkRateLimit(
    env.AUTH_STORAGE,
    rateLimitKey,
    10, // limit
    3600 // 1 hour in seconds
  );

  if (!rateLimit.allowed) {
    const retryAfter = rateLimit.resetAt - Math.floor(Date.now() / 1000);
    return Response.json({
      error: 'Too Many Requests',
      details: `Rate limit exceeded. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
      retryAfter,
    }, {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    });
  }

  // Determine if running in development mode
  const url = new URL(request.url);
  const isDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  try {
    // Parse request body
    const body = await request.json();
    const parsed = v.safeParse(replaySchema, body);

    if (!parsed.success) {
      return Response.json({
        error: 'Invalid request',
        details: v.flatten(parsed.issues),
      }, { status: 400 });
    }

    // Initialize replay service
    const replayService = new DLQReplayService(
      env.AUTH_DB,
      env.AUDIT_WEBHOOK_SECRET
    );

    // Execute replay
    const result = await replayService.replayFailedEvents(parsed.output);

    return Response.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error('DLQ replay error:', error);
    return Response.json({
      error: 'Internal server error',
      ...(isDevelopment && { message: error instanceof Error ? error.message : String(error) }),
    }, { status: 500 });
  }
}

/**
 * Handle DLQ list requests
 */
export async function handleDLQList(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify admin authentication
  if (!(await verifyAdminAuth(request, env.AUTH_STORAGE))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Determine if running in development mode
  const url = new URL(request.url);
  const isDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  try {
    // Parse and validate pagination parameters
    const limitParam = url.searchParams.get('limit') ?? '100';
    const offsetParam = url.searchParams.get('offset') ?? '0';
    const limit = parseInt(limitParam);
    const offset = parseInt(offsetParam);

    // Enforce pagination limits (Issue #7)
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      return Response.json({
        error: 'Invalid limit parameter',
        details: 'Limit must be between 1 and 1000',
      }, { status: 400 });
    }

    if (isNaN(offset) || offset < 0) {
      return Response.json({
        error: 'Invalid offset parameter',
        details: 'Offset must be >= 0',
      }, { status: 400 });
    }

    // Validate status parameter
    const status = url.searchParams.get('status') ?? undefined;
    if (status && !['pending', 'replaying', 'completed', 'failed'].includes(status)) {
      return Response.json({
        error: 'Invalid status parameter',
        details: 'Status must be one of: pending, replaying, completed, failed',
      }, { status: 400 });
    }

    const maxAgeParam = url.searchParams.get('maxAge');
    const maxAge = maxAgeParam ? parseInt(maxAgeParam) : undefined;

    if (maxAge !== undefined && (isNaN(maxAge) || maxAge < 1)) {
      return Response.json({
        error: 'Invalid maxAge parameter',
        details: 'maxAge must be >= 1',
      }, { status: 400 });
    }

    const replayService = new DLQReplayService(env.AUTH_DB);
    const result = await replayService.getQueuedEvents({
      limit,
      offset,
      status,
      maxAge,
    });

    return Response.json(result);
  } catch (error) {
    console.error('DLQ list error:', error);
    return Response.json({
      error: 'Internal server error',
      ...(isDevelopment && { message: error instanceof Error ? error.message : String(error) }),
    }, { status: 500 });
  }
}

/**
 * Handle DLQ statistics requests
 */
export async function handleDLQStats(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify admin authentication
  if (!(await verifyAdminAuth(request, env.AUTH_STORAGE))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Determine if running in development mode
  const url = new URL(request.url);
  const isDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  try {
    const replayService = new DLQReplayService(env.AUTH_DB);
    const stats = await replayService.getStatistics();

    return Response.json(stats);
  } catch (error) {
    console.error('DLQ stats error:', error);
    return Response.json({
      error: 'Internal server error',
      ...(isDevelopment && { message: error instanceof Error ? error.message : String(error) }),
    }, { status: 500 });
  }
}

/**
 * Handle DLQ cleanup requests
 */
export async function handleDLQCleanup(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify admin authentication
  if (!(await verifyAdminAuth(request, env.AUTH_STORAGE))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Determine if running in development mode
  const url = new URL(request.url);
  const isDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  try {
    const body = await request.json();
    const parsed = v.safeParse(cleanupSchema, body);

    if (!parsed.success) {
      return Response.json({
        error: 'Invalid request',
        details: v.flatten(parsed.issues),
      }, { status: 400 });
    }

    const replayService = new DLQReplayService(env.AUTH_DB);
    const result = await replayService.cleanup({
      maxAge: parsed.output.maxAge,
      statusFilter: parsed.output.statusFilter,
    });

    return Response.json({
      success: true,
      deleted: result.deleted,
    });
  } catch (error) {
    console.error('DLQ cleanup error:', error);
    return Response.json({
      error: 'Internal server error',
      ...(isDevelopment && { message: error instanceof Error ? error.message : String(error) }),
    }, { status: 500 });
  }
}

/**
 * Route admin DLQ requests
 */
export async function routeAdminDLQ(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);

  // Admin DLQ endpoints
  if (url.pathname === '/admin/dlq/replay' && request.method === 'POST') {
    return handleDLQReplay(request, env, ctx);
  }

  if (url.pathname === '/admin/dlq/list' && request.method === 'GET') {
    return handleDLQList(request, env);
  }

  if (url.pathname === '/admin/dlq/stats' && request.method === 'GET') {
    return handleDLQStats(request, env);
  }

  if (url.pathname === '/admin/dlq/cleanup' && request.method === 'POST') {
    return handleDLQCleanup(request, env);
  }

  // Not an admin DLQ route
  return null;
}
