/**
 * @fileoverview Admin Enterprise Routes for audit logs and user token operations
 *
 * These routes expose the OpenAuth fork's built-in enterprise features:
 * - Audit log viewing with filtering
 * - Force logout users (revoke all tokens)
 * - Service health metrics
 *
 * NOTE: OAuth client management is now handled by OpenAuth's clientAdminRoutes
 * (see src/index.ts and src/router.ts)
 */

import { verifyAdminRequest, createAuthErrorResponse } from './auth-middleware';
import { logger } from './logger';
import { emitAuditEvent } from './audit-emitter-enhanced';
import { AuditEventType, AuditEventSeverity, createSecurityAlertEvent } from './audit-events';
import { checkRateLimit, getClientIP } from './rate-limit';
import * as v from 'valibot';

// ============================================================================
// Validation Schemas
// ============================================================================

const AuditLogQuerySchema = v.object({
  page: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1))),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(100))),
  event_type: v.optional(v.string()),
  severity: v.optional(v.picklist(['info', 'warning', 'error', 'critical'])),
  user_id: v.optional(v.string()),
  start_date: v.optional(v.string()),
  end_date: v.optional(v.string()),
});

const TokenAuditQuerySchema = v.object({
  page: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1))),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(100))),
  user_id: v.optional(v.string()),
  action: v.optional(v.picklist(['generated', 'refreshed', 'revoked', 'reused'])),
  client_id: v.optional(v.string()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  search: v.optional(v.string()),
});

const RevokeUserTokensSchema = v.object({
  user_id: v.pipe(v.string(), v.minLength(1)),
  reason: v.optional(v.string()),
});

// ============================================================================
// Type Definitions
// ============================================================================

interface AuditEvent {
  id: number;
  timestamp: string;
  event_type: string;
  severity: string;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: string;
  success: number;
  error_message: string | null;
  created_at: string;
}

interface TokenUsageRecord {
  id: string;
  token_id: string;
  subject: string;
  event_type: string;
  client_id: string | null;
  timestamp: number;
  ip_address: string | null;
  user_agent: string | null;
  metadata: string | null;
}

// ============================================================================
// Route Handler Class
// ============================================================================

export class AdminEnterpriseRoutes {
  constructor(private db: D1Database, private kv: KVNamespace) {}

  /**
   * Add CORS headers to response for admin dashboard
   */
  private addCorsHeaders(response: Response, env: Env, request: Request): Response {
    const origin = request.headers.get('Origin');
    const allowedOrigins = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim())
      : [];

    // Check if origin is allowed
    if (origin && allowedOrigins.includes(origin)) {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Access-Control-Max-Age', '86400');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  }

  /**
   * Route handler for admin enterprise endpoints
   */
  async handle(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Handle OPTIONS preflight requests
    if (method === 'OPTIONS') {
      const response = new Response(null, {
        status: 204,
        headers: {
          'Content-Length': '0',
        },
      });
      return this.addCorsHeaders(response, env, request);
    }

    // ========================================================================
    // Token Audit Routes
    // ========================================================================
    if (path === '/admin/audit' && method === 'GET') {
      const response = await this.getTokenAudit(request, url, env);
      return this.addCorsHeaders(response, env, request);
    }

    // ========================================================================
    // Audit Log Routes
    // ========================================================================
    if (path === '/admin/audit-logs' && method === 'GET') {
      const response = await this.getAuditLogs(request, url, env);
      return this.addCorsHeaders(response, env, request);
    }
    if (path === '/admin/audit-logs/stats' && method === 'GET') {
      const response = await this.getAuditStats(request, env);
      return this.addCorsHeaders(response, env, request);
    }
    if (path.match(/^\/admin\/audit-logs\/user\/[^/]+$/) && method === 'GET') {
      const userId = path.split('/').pop()!;
      const response = await this.getUserAuditTrail(userId, request, url, env);
      return this.addCorsHeaders(response, env, request);
    }

    // ========================================================================
    // User Token Management Routes
    // ========================================================================
    if (path === '/admin/users/tokens/revoke' && method === 'POST') {
      return this.revokeUserTokens(request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+\/tokens$/) && method === 'GET') {
      const userId = path.split('/')[3];
      return this.getUserTokens(userId, request, env);
    }
    if (path.match(/^\/admin\/users\/[^/]+\/tokens$/) && method === 'DELETE') {
      const userId = path.split('/')[3];
      return this.revokeAllUserTokens(userId, request, env);
    }

    // ========================================================================
    // Health & Metrics Routes
    // ========================================================================
    if (path === '/admin/health' && method === 'GET') {
      return this.getHealth(request, env);
    }
    if (path === '/admin/metrics' && method === 'GET') {
      return this.getMetrics(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }

  // ==========================================================================
  // Token Audit Handlers
  // ==========================================================================

  /**
   * GET /admin/audit - List token usage audit logs with filtering and pagination
   */
  private async getTokenAudit(request: Request, url: URL, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:audit');

      // Parse query parameters
      const queryParams = Object.fromEntries(url.searchParams);
      const params = v.parse(TokenAuditQuerySchema, queryParams);

      const page = params.page || 1;
      const limit = params.limit || 50;
      const offset = (page - 1) * limit;

      // Build dynamic query
      const whereConditions: string[] = [];
      const bindParams: unknown[] = [];

      // Extract user_id from subject field (format: "user:123abc")
      if (params.user_id) {
        whereConditions.push("subject = ?");
        bindParams.push(`user:${params.user_id}`);
      }

      if (params.action) {
        whereConditions.push('event_type = ?');
        bindParams.push(params.action);
      }

      if (params.client_id) {
        whereConditions.push('client_id = ?');
        bindParams.push(params.client_id);
      }

      if (params.from) {
        // Convert ISO date to Unix timestamp
        const fromTimestamp = Math.floor(new Date(params.from).getTime() / 1000);
        whereConditions.push('timestamp >= ?');
        bindParams.push(fromTimestamp);
      }

      if (params.to) {
        // Convert ISO date to Unix timestamp
        const toTimestamp = Math.floor(new Date(params.to).getTime() / 1000);
        whereConditions.push('timestamp <= ?');
        bindParams.push(toTimestamp);
      }

      if (params.search) {
        // Search in subject, client_id, and ip_address
        whereConditions.push('(subject LIKE ? OR client_id LIKE ? OR ip_address LIKE ?)');
        const searchPattern = `%${params.search}%`;
        bindParams.push(searchPattern, searchPattern, searchPattern);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Count total matching records
      const countQuery = `SELECT COUNT(*) as total FROM token_usage ${whereClause}`;
      const countResult = await this.db.prepare(countQuery).bind(...bindParams).first<{ total: number }>();
      const total = countResult?.total || 0;

      // Fetch paginated results
      const dataQuery = `
        SELECT * FROM token_usage
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `;
      const result = await this.db.prepare(dataQuery).bind(...bindParams, limit, offset).all<TokenUsageRecord>();

      // Transform results to match API spec
      const transformedData = (result.results || []).map(record => {
        // Extract user_id from subject (format: "user:123abc")
        const userId = record.subject.startsWith('user:')
          ? record.subject.substring(5)
          : record.subject;

        return {
          id: record.id,
          user_id: userId,
          client_id: record.client_id,
          token_type: 'refresh', // All entries in token_usage are refresh token events
          action: record.event_type,
          ip_address: record.ip_address,
          user_agent: record.user_agent,
          created_at: new Date(record.timestamp * 1000).toISOString(),
        };
      });

      return new Response(JSON.stringify({
        data: transformedData,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to fetch token audit logs', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid query parameters: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch token audit logs',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  // ==========================================================================
  // Audit Log Handlers
  // ==========================================================================

  /**
   * GET /admin/audit-logs - List audit events with filtering and pagination
   */
  private async getAuditLogs(request: Request, url: URL, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:audit');

      // Parse query parameters
      const queryParams = Object.fromEntries(url.searchParams);
      const params = v.parse(AuditLogQuerySchema, queryParams);

      const page = params.page || 1;
      const limit = params.limit || 50;
      const offset = (page - 1) * limit;

      // Build dynamic query
      const whereConditions: string[] = [];
      const bindParams: unknown[] = [];

      if (params.event_type) {
        whereConditions.push('event_type = ?');
        bindParams.push(params.event_type);
      }
      if (params.severity) {
        whereConditions.push('severity = ?');
        bindParams.push(params.severity);
      }
      if (params.user_id) {
        whereConditions.push('user_id = ?');
        bindParams.push(params.user_id);
      }
      if (params.start_date) {
        whereConditions.push('timestamp >= ?');
        bindParams.push(params.start_date);
      }
      if (params.end_date) {
        whereConditions.push('timestamp <= ?');
        bindParams.push(params.end_date);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Count total matching records
      const countQuery = `SELECT COUNT(*) as total FROM audit_events ${whereClause}`;
      const countResult = await this.db.prepare(countQuery).bind(...bindParams).first<{ total: number }>();
      const total = countResult?.total || 0;

      // Fetch paginated results
      const dataQuery = `
        SELECT * FROM audit_events
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `;
      const result = await this.db.prepare(dataQuery).bind(...bindParams, limit, offset).all<AuditEvent>();

      return new Response(JSON.stringify({
        data: result.results || [],
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to fetch audit logs', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid query parameters: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch audit logs',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * GET /admin/audit-logs/stats - Get audit log statistics
   */
  private async getAuditStats(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:audit');

      // Get counts by severity
      const severityCounts = await this.db.prepare(`
        SELECT severity, COUNT(*) as count
        FROM audit_events
        WHERE timestamp >= datetime('now', '-24 hours')
        GROUP BY severity
      `).all<{ severity: string; count: number }>();

      // Get counts by event type (top 10)
      const eventTypeCounts = await this.db.prepare(`
        SELECT event_type, COUNT(*) as count
        FROM audit_events
        WHERE timestamp >= datetime('now', '-24 hours')
        GROUP BY event_type
        ORDER BY count DESC
        LIMIT 10
      `).all<{ event_type: string; count: number }>();

      // Get total events in different time periods
      const totalEvents = await this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM audit_events WHERE timestamp >= datetime('now', '-1 hour')) as last_hour,
          (SELECT COUNT(*) FROM audit_events WHERE timestamp >= datetime('now', '-24 hours')) as last_24h,
          (SELECT COUNT(*) FROM audit_events WHERE timestamp >= datetime('now', '-7 days')) as last_7d,
          (SELECT COUNT(*) FROM audit_events) as total
      `).first<{ last_hour: number; last_24h: number; last_7d: number; total: number }>();

      return new Response(JSON.stringify({
        by_severity: severityCounts.results || [],
        by_event_type: eventTypeCounts.results || [],
        totals: totalEvents || { last_hour: 0, last_24h: 0, last_7d: 0, total: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to fetch audit stats', {
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch audit stats',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * GET /admin/audit-logs/user/:userId - Get audit trail for specific user
   */
  private async getUserAuditTrail(userId: string, request: Request, url: URL, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:audit');

      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = (page - 1) * limit;

      // Count total for this user
      const countResult = await this.db.prepare(
        'SELECT COUNT(*) as total FROM audit_events WHERE user_id = ?'
      ).bind(userId).first<{ total: number }>();
      const total = countResult?.total || 0;

      // Fetch user's audit events
      const result = await this.db.prepare(`
        SELECT * FROM audit_events
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `).bind(userId, limit, offset).all<AuditEvent>();

      return new Response(JSON.stringify({
        data: result.results || [],
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to fetch user audit trail', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch user audit trail',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  // ==========================================================================
  // User Token Management Handlers
  // ==========================================================================

  /**
   * GET /admin/users/:userId/tokens - Get user's active tokens
   */
  private async getUserTokens(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:users');

      // Get active tokens
      // OpenAuth schema: id, token_hash, user_id, client_id, tenant_id, scope, expires_at, revoked, revoked_at, created_at
      const activeTokens = await this.db.prepare(`
        SELECT id, client_id, created_at, expires_at, scope, revoked
        FROM refresh_tokens
        WHERE user_id = ? AND revoked = 0 AND expires_at > ?
        ORDER BY created_at DESC
      `).bind(userId, Math.floor(Date.now() / 1000)).all();

      // Get token count stats
      const stats = await this.db.prepare(`
        SELECT
          SUM(CASE WHEN revoked = 0 AND expires_at > ? THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN revoked = 1 THEN 1 ELSE 0 END) as revoked,
          SUM(CASE WHEN revoked = 0 AND expires_at <= ? THEN 1 ELSE 0 END) as expired
        FROM refresh_tokens
        WHERE user_id = ?
      `).bind(
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
        userId
      ).first<{ active: number; revoked: number; expired: number }>();

      return new Response(JSON.stringify({
        tokens: activeTokens.results || [],
        stats: stats || { active: 0, revoked: 0, expired: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get user tokens', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get user tokens',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * DELETE /admin/users/:userId/tokens - Revoke all user tokens (force logout)
   */
  private async revokeAllUserTokens(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      const authResult = await verifyAdminRequest(request, env, 'admin:users');
      const authContext = authResult.type === 'user' ? authResult : { user: authResult.actingUser, isAdmin: true };

      // Rate limiting for destructive operations
      const rateLimitIP = getClientIP(request);
      const rateLimit = await checkRateLimit(this.kv, `admin:token:revoke:${rateLimitIP}`, 10, 3600);
      if (!rateLimit.allowed) {
        return createAuthErrorResponse('Rate limit exceeded', 429);
      }

      const now = Math.floor(Date.now() / 1000);

      // Count tokens to be revoked
      const countResult = await this.db.prepare(
        'SELECT COUNT(*) as count FROM refresh_tokens WHERE user_id = ? AND revoked = 0'
      ).bind(userId).first<{ count: number }>();

      if (!countResult || countResult.count === 0) {
        return new Response(JSON.stringify({
          success: true,
          tokens_revoked: 0,
          message: 'No active tokens to revoke',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Revoke all active tokens
      // Note: OpenAuth schema doesn't have revoked_reason column
      await this.db.prepare(`
        UPDATE refresh_tokens
        SET revoked = 1, revoked_at = ?
        WHERE user_id = ? AND revoked = 0
      `).bind(now, userId).run();

      // Emit audit event
      await emitAuditEvent({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.USER_FORCE_LOGOUT,
        severity: AuditEventSeverity.WARNING,
        userId: authContext.user.id,
        ipAddress: getClientIP(request),
        userAgent: request.headers.get('User-Agent'),
        requestId: null,
        success: true,
        errorMessage: null,
        metadata: {
          target_user_id: userId,
          tokens_revoked: countResult.count,
        },
      });

      // Emit security alert for the affected user
      await emitAuditEvent(
        createSecurityAlertEvent(
          'FORCE_LOGOUT',
          { admin_id: authContext.user.id, tokens_revoked: countResult.count },
          userId,
          getClientIP(request)
        )
      );

      logger.info('All user tokens revoked (force logout)', {
        targetUserId: userId,
        tokensRevoked: countResult.count,
        revokedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({
        success: true,
        tokens_revoked: countResult.count,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to revoke user tokens', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to revoke user tokens',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * POST /admin/users/tokens/revoke - Revoke tokens for multiple users or by criteria
   */
  private async revokeUserTokens(request: Request, env: Env): Promise<Response> {
    try {
      const authResult = await verifyAdminRequest(request, env, 'admin:users');
      const authContext = authResult.type === 'user' ? authResult : { user: authResult.actingUser, isAdmin: true };

      const body = await request.json();
      const validated = v.parse(RevokeUserTokensSchema, body);

      const now = Math.floor(Date.now() / 1000);
      const reason = validated.reason || 'admin_revocation';

      // Count tokens to be revoked
      const countResult = await this.db.prepare(
        'SELECT COUNT(*) as count FROM refresh_tokens WHERE user_id = ? AND revoked = 0'
      ).bind(validated.user_id).first<{ count: number }>();

      if (!countResult || countResult.count === 0) {
        return new Response(JSON.stringify({
          success: true,
          tokens_revoked: 0,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Revoke tokens
      // Note: OpenAuth schema doesn't have revoked_reason column
      // The reason is logged in the audit event metadata instead
      await this.db.prepare(`
        UPDATE refresh_tokens
        SET revoked = 1, revoked_at = ?
        WHERE user_id = ? AND revoked = 0
      `).bind(now, validated.user_id).run();

      // Emit audit event
      await emitAuditEvent({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.USER_TOKENS_REVOKED,
        severity: AuditEventSeverity.WARNING,
        userId: authContext.user.id,
        ipAddress: getClientIP(request),
        userAgent: request.headers.get('User-Agent'),
        requestId: null,
        success: true,
        errorMessage: null,
        metadata: {
          target_user_id: validated.user_id,
          tokens_revoked: countResult.count,
          reason,
        },
      });

      logger.info('User tokens revoked', {
        targetUserId: validated.user_id,
        tokensRevoked: countResult.count,
        reason,
        revokedBy: authContext.user.id,
      });

      return new Response(JSON.stringify({
        success: true,
        tokens_revoked: countResult.count,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to revoke user tokens', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid request: ' + error.message, 400);
      }

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to revoke user tokens',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  // ==========================================================================
  // Health & Metrics Handlers
  // ==========================================================================

  /**
   * GET /admin/health - Get service health status
   */
  private async getHealth(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:*');

      const checks: Record<string, { status: string; latency?: number; error?: string }> = {};

      // Check D1 database
      const dbStart = Date.now();
      try {
        await this.db.prepare('SELECT 1').first();
        checks.database = { status: 'healthy', latency: Date.now() - dbStart };
      } catch (e) {
        checks.database = { status: 'unhealthy', error: e instanceof Error ? e.message : 'Unknown error' };
      }

      // Check KV store
      const kvStart = Date.now();
      try {
        await this.kv.get('health-check');
        checks.kv_store = { status: 'healthy', latency: Date.now() - kvStart };
      } catch (e) {
        checks.kv_store = { status: 'unhealthy', error: e instanceof Error ? e.message : 'Unknown error' };
      }

      const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

      return new Response(JSON.stringify({
        status: allHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks,
      }), {
        status: allHealthy ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Health check failed',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }

  /**
   * GET /admin/metrics - Get service metrics
   */
  private async getMetrics(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:*');

      // Get user counts
      const userStats = await this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM users) as total_users,
          (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-24 hours')) as users_24h,
          (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) as users_7d
      `).first<{ total_users: number; users_24h: number; users_7d: number }>();

      // Get token stats
      const tokenStats = await this.db.prepare(`
        SELECT
          SUM(CASE WHEN revoked = 0 AND expires_at > ? THEN 1 ELSE 0 END) as active_tokens,
          SUM(CASE WHEN revoked = 1 THEN 1 ELSE 0 END) as revoked_tokens,
          SUM(CASE WHEN revoked = 0 AND expires_at <= ? THEN 1 ELSE 0 END) as expired_tokens,
          COUNT(*) as total_tokens
        FROM refresh_tokens
      `).bind(
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000)
      ).first<{ active_tokens: number; revoked_tokens: number; expired_tokens: number; total_tokens: number }>();

      // Get audit event stats (last 24h)
      const auditStats = await this.db.prepare(`
        SELECT
          COUNT(*) as events_24h,
          SUM(CASE WHEN severity = 'error' OR severity = 'critical' THEN 1 ELSE 0 END) as errors_24h,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_24h
        FROM audit_events
        WHERE timestamp >= datetime('now', '-24 hours')
      `).first<{ events_24h: number; errors_24h: number; failed_24h: number }>();

      // Get client stats
      // OpenAuth schema: client type is derived from client_secret_hash (NULL = public, NOT NULL = confidential)
      const clientStats = await this.db.prepare(`
        SELECT
          COUNT(*) as total_clients,
          SUM(CASE WHEN client_secret_hash IS NULL THEN 1 ELSE 0 END) as public_clients,
          SUM(CASE WHEN client_secret_hash IS NOT NULL THEN 1 ELSE 0 END) as confidential_clients
        FROM oauth_clients
      `).first<{ total_clients: number; public_clients: number; confidential_clients: number }>();

      return new Response(JSON.stringify({
        timestamp: new Date().toISOString(),
        users: userStats || { total_users: 0, users_24h: 0, users_7d: 0 },
        tokens: tokenStats || { active_tokens: 0, revoked_tokens: 0, expired_tokens: 0, total_tokens: 0 },
        audit: auditStats || { events_24h: 0, errors_24h: 0, failed_24h: 0 },
        clients: clientStats || { total_clients: 0, public_clients: 0, confidential_clients: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to get metrics', {
        error: error instanceof Error ? error.message : String(error),
      });

      return createAuthErrorResponse(
        error instanceof Error ? error.message : 'Failed to get metrics',
        error instanceof Error && error.message.includes('required') ? 401 : 500
      );
    }
  }
}
