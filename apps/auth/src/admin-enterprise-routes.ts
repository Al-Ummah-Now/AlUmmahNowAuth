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
import { SYSTEM_USER_IDS_SQL } from './security/system-accounts';
import { logger } from './logger';
import { emitAuditEvent } from './audit-emitter';
import { adminErrorResponse } from './utils/error-response';
import { AuditEventType, AuditEventSeverity, createSecurityAlertEvent } from './audit-events';
import { getClientIP, withinRateLimit } from './rate-limit';
import {
  AUDIT_COUNTS_BACKFILL_KEY,
  AUDIT_STATS_RETENTION_DAYS,
  isAuditCountsBackfillPending,
  utcDay,
  utcHour,
} from './services/audit-counts-backfill';
import * as v from 'valibot';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Exact SQL statements used by getAuditStats and getUserAuditTrail.
 * Exported so unit tests assert EXPLAIN QUERY PLAN directly against the
 * production queries (AlUmmahNowAuth#514).
 */
export const AUDIT_ADMIN_QUERIES = {
  statsHourly: `
    SELECT hour, event_type, severity, n
    FROM audit_hourly_counts
    WHERE hour >= ?1
  `,
  statsDaily: `
    SELECT
      COALESCE(SUM(CASE WHEN day >= ?1 THEN n ELSE 0 END), 0) AS last_7d,
      COALESCE(SUM(n), 0) AS total
    FROM audit_daily_counts
    WHERE day >= ?2
  `,
  statsBackfillStatus: `
    SELECT value FROM auth_settings WHERE key = ?1
  `,
  userTrailPage: `
    SELECT * FROM audit_events
    WHERE user_id = ?1
    ORDER BY timestamp DESC, id DESC
    LIMIT ?2 OFFSET ?3
  `,
  userTrailCount: `
    SELECT COUNT(*) as total FROM audit_events WHERE user_id = ?1
  `,
  userTrailFirst: `
    SELECT * FROM audit_events
    WHERE user_id = ?1
    ORDER BY timestamp DESC, id DESC
    LIMIT ?2
  `,
  userTrailCursor: `
    SELECT * FROM audit_events
    WHERE user_id = ?1 AND (timestamp, id) < (?2, ?3)
    ORDER BY timestamp DESC, id DESC
    LIMIT ?4
  `,
  userTrailBefore: `
    SELECT * FROM audit_events
    WHERE user_id = ?1 AND timestamp < ?2
    ORDER BY timestamp DESC, id DESC
    LIMIT ?3
  `,
} as const;

interface AuditCursor {
  t: string | number;
  i: string | number;
}

function encodeAuditCursor(timestamp: string | number, id: string | number): string {
  const json = JSON.stringify({ t: timestamp, i: id } satisfies AuditCursor);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeAuditCursor(raw: string): AuditCursor | null {
  try {
    if (!raw || raw.length > 512) return null;
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<AuditCursor>;
    if (
      parsed.t === undefined ||
      !((typeof parsed.t === 'string' && parsed.t.length > 0) || Number.isSafeInteger(parsed.t)) ||
      (typeof parsed.i !== 'string' && typeof parsed.i !== 'number') ||
      (typeof parsed.i === 'string' && parsed.i.length === 0)
    ) {
      return null;
    }
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
}

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
  pagination: v.optional(v.string()),
  cursor: v.optional(v.string()),
  before: v.optional(v.string()),
});

const RevokeUserTokensSchema = v.object({
  user_id: v.pipe(v.string(), v.minLength(1)),
  reason: v.optional(v.string()),
});

// ============================================================================
// Type Definitions
// ============================================================================

interface AuditEvent {
  id: string | number;
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

/**
 * Row of the live token_usage table (migrations/0002_jwt_tokens.sql).
 * created_at is epoch milliseconds. token_type holds the token lifecycle event
 * written by apps/audit-consumer (generated | refreshed | revoked | reused).
 */
interface TokenUsageRecord {
  id: string;
  client_id: string;
  user_id: string | null;
  token_type: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: number;
}

type TokenAuditFilters = {
  userId?: string;
  clientId?: string;
  action?: string;
  from?: number;
  to?: number;
  before?: number;
  cursor?: { timestamp: number; id: string };
  search?: string;
};

const TOKEN_AUDIT_COLUMNS = 'id, client_id, user_id, token_type, ip_address, user_agent, created_at';
const TOKEN_AUDIT_ORDER = 'ORDER BY created_at DESC, id DESC';

// Exported to test the production query plans on D1.
export function tokenAuditPageQuery(filters: TokenAuditFilters, fetchLimit: number) {
  const branch = (userId?: string, clientId?: string) => {
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    const add = (condition: string, ...values: (string | number)[]) => {
      conditions.push(condition);
      bindings.push(...values);
    };

    if (userId) add('user_id = ?', userId);
    if (clientId) add('client_id = ?', clientId);
    if (filters.action) add('token_type = ?', filters.action);
    if (filters.from !== undefined) add('created_at >= ?', filters.from);
    if (filters.to !== undefined) add('created_at <= ?', filters.to);
    if (filters.before !== undefined) add('created_at < ?', filters.before);
    if (filters.cursor) add('(created_at, id) < (?, ?)', filters.cursor.timestamp, filters.cursor.id);

    // Pick the same ordered index for the first page and continuation. Other
    // explicit filters are applied before LIMIT so matching rows cannot be skipped.
    const index = userId ? 'idx_token_usage_user_created_at'
      : clientId ? 'idx_token_usage_client_created_at'
      : filters.action ? 'idx_token_usage_action_created_at'
      : 'idx_token_usage_created_at_id';
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return {
      sql: `SELECT ${TOKEN_AUDIT_COLUMNS} FROM token_usage INDEXED BY ${index}
        ${where} ${TOKEN_AUDIT_ORDER} LIMIT ?`,
      bindings: [...bindings, fetchLimit],
    };
  };

  if (!filters.search || filters.userId === filters.search || filters.clientId === filters.search) {
    return branch(filters.userId, filters.clientId);
  }

  // Split the OR into two ordered seeks. A row that matches both is returned
  // once, and the union can sort at most 2 * fetchLimit rows.
  if (filters.userId && filters.clientId) return undefined;
  if (filters.clientId) return branch(filters.search, filters.clientId);
  if (filters.userId) return branch(filters.userId, filters.search);

  const userMatch = branch(filters.search);
  const clientMatch = branch(undefined, filters.search);
  return {
    sql: `SELECT * FROM (${userMatch.sql}) UNION SELECT * FROM (${clientMatch.sql})
      ${TOKEN_AUDIT_ORDER} LIMIT ?`,
    bindings: [...userMatch.bindings, ...clientMatch.bindings, fetchLimit],
  };
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
      const rawUserId = path.split('/').pop()!;
      let userId: string;
      try {
        userId = decodeURIComponent(rawUserId);
      } catch {
        return this.addCorsHeaders(createAuthErrorResponse('Invalid userId encoding', 400), env, request);
      }
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

      const limit = params.limit ?? 50;
      const useKeyset = params.pagination === 'cursor' || params.cursor !== undefined || params.before !== undefined;
      const from = params.from ? Date.parse(params.from) : undefined;
      const to = params.to ? Date.parse(params.to) : undefined;
      if (Number.isNaN(from)) return createAuthErrorResponse('Invalid query parameters: from must be an ISO date', 400);
      if (Number.isNaN(to)) return createAuthErrorResponse('Invalid query parameters: to must be an ISO date', 400);

      const filters: TokenAuditFilters = {
        userId: params.user_id,
        clientId: params.client_id,
        action: params.action,
        from,
        to,
        search: params.search,
      };

      let rows: TokenUsageRecord[];
      let pagination: object;
      if (useKeyset) {
        if (params.page !== undefined || (params.cursor !== undefined && params.before !== undefined)) {
          return createAuthErrorResponse('Invalid query parameters: omit page and provide at most one of cursor or before', 400);
        }
        if (params.before !== undefined) {
          filters.before = Date.parse(params.before);
          if (Number.isNaN(filters.before)) {
            return createAuthErrorResponse('Invalid query parameters: before must be an ISO timestamp', 400);
          }
        }
        if (params.cursor !== undefined) {
          const cursor = decodeAuditCursor(params.cursor);
          if (!cursor || typeof cursor.t !== 'number' || typeof cursor.i !== 'string') {
            return createAuthErrorResponse('Invalid query parameters: malformed cursor', 400);
          }
          filters.cursor = { timestamp: cursor.t, id: cursor.i };
        }

        const query = tokenAuditPageQuery(filters, limit + 1);
        const results = query
          ? (await this.db.prepare(query.sql).bind(...query.bindings).all<TokenUsageRecord>()).results
          : [];
        const hasMore = results.length > limit;
        rows = results.slice(0, limit);
        const last = hasMore ? rows.at(-1) : undefined;
        pagination = { limit, hasMore, nextCursor: last ? encodeAuditCursor(last.created_at, last.id) : null };
      } else {
        const legacy = await this.getNumberedTokenAuditPage(filters, params.page ?? 1, limit);
        rows = legacy.rows;
        pagination = legacy.pagination;
      }

      return Response.json({
        data: rows.map(record => ({
          id: record.id,
          user_id: record.user_id,
          client_id: record.client_id,
          token_type: 'refresh', // token_usage tracks refresh-token lifecycle events
          action: record.token_type,
          ip_address: record.ip_address,
          user_agent: record.user_agent,
          created_at: new Date(record.created_at).toISOString(),
        })),
        pagination,
      });
    } catch (error) {
      logger.error('Failed to fetch token audit logs', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof v.ValiError) {
        return createAuthErrorResponse('Invalid query parameters: ' + error.message, 400);
      }

      return adminErrorResponse(error, 'Failed to fetch token audit logs');
    }
  }

  /** Keep the numbered contract available while clients can opt into indexed pages. */
  private async getNumberedTokenAuditPage(filters: TokenAuditFilters, page: number, limit: number) {
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];
    const add = (condition: string, value: string | number) => {
      conditions.push(condition);
      bindings.push(value);
    };
    if (filters.userId) add('user_id = ?', filters.userId);
    if (filters.clientId) add('client_id = ?', filters.clientId);
    if (filters.action) add('token_type = ?', filters.action);
    if (filters.from !== undefined) add('created_at >= ?', filters.from);
    if (filters.to !== undefined) add('created_at <= ?', filters.to);
    if (filters.search) {
      conditions.push('(instr(user_id, ?) > 0 OR instr(client_id, ?) > 0 OR instr(ip_address, ?) > 0)');
      bindings.push(filters.search, filters.search, filters.search);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.db.prepare(`SELECT COUNT(*) AS total FROM token_usage ${where}`)
      .bind(...bindings).first<{ total: number }>();
    const total = count?.total ?? 0;
    const { results } = await this.db.prepare(`SELECT ${TOKEN_AUDIT_COLUMNS} FROM token_usage
      ${where} ${TOKEN_AUDIT_ORDER} LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, (page - 1) * limit).all<TokenUsageRecord>();
    return { rows: results, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
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

      // Count matching records, at most 20 pages past this one. An uncapped COUNT(*) read every
      // audit event (270k rows on QA, 125M rows/day); `capped` tells the page the total is a floor.
      const countCap = offset + limit * 20;
      const countQuery = `SELECT COUNT(*) as total FROM (SELECT 1 FROM audit_events ${whereClause} LIMIT ?)`;
      const countResult = await this.db.prepare(countQuery).bind(...bindParams, countCap).first<{ total: number }>();
      const total = countResult?.total || 0;
      const capped = total >= countCap;

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
          capped,
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

      return adminErrorResponse(error, 'Failed to fetch audit logs');
    }
  }

  /**
   * GET /admin/audit-logs/stats - Get audit log statistics
   *
   * Reads only the pre-aggregated audit_hourly_counts (last 1h / 24h) and
   * audit_daily_counts (last 7d / 90d total) tables in one D1 batch, avoiding
   * full-table and timestamp-range scans over audit_events (AlUmmahNowAuth#514).
   */
  private async getAuditStats(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:audit');

      const now = Date.now();
      const hour1Cutoff = utcHour(now - HOUR_MS);
      const hour24Cutoff = utcHour(now - 24 * HOUR_MS);
      const day7Cutoff = utcDay(now - 7 * DAY_MS);
      const day90Cutoff = utcDay(now - (AUDIT_STATS_RETENTION_DAYS - 1) * DAY_MS);

      const [hourlyResult, dailyResult, backfillResult] = await this.db.batch([
        this.db.prepare(AUDIT_ADMIN_QUERIES.statsHourly).bind(hour24Cutoff),
        this.db.prepare(AUDIT_ADMIN_QUERIES.statsDaily).bind(day7Cutoff, day90Cutoff),
        this.db.prepare(AUDIT_ADMIN_QUERIES.statsBackfillStatus).bind(AUDIT_COUNTS_BACKFILL_KEY),
      ]);

      const hourlyRows = (hourlyResult?.results || []) as Array<{
        hour: string;
        event_type: string;
        severity: string;
        n: number;
      }>;
      const dailyRow = (dailyResult?.results?.[0] || null) as {
        last_7d: number;
        total: number;
      } | null;
      const backfillRow = (backfillResult?.results?.[0] || null) as { value: string } | null;
      const partial = isAuditCountsBackfillPending(backfillRow?.value);

      const severityMap = new Map<string, number>();
      const eventTypeMap = new Map<string, number>();
      let lastHour = 0;
      let last24h = 0;

      for (const row of hourlyRows) {
        const count = Number(row.n) || 0;
        last24h += count;
        if (row.hour >= hour1Cutoff) {
          lastHour += count;
        }
        severityMap.set(row.severity, (severityMap.get(row.severity) || 0) + count);
        eventTypeMap.set(row.event_type, (eventTypeMap.get(row.event_type) || 0) + count);
      }

      const bySeverity = Array.from(severityMap.entries())
        .map(([severity, count]) => ({ severity, count }))
        .sort((a, b) => b.count - a.count || a.severity.localeCompare(b.severity));

      const byEventType = Array.from(eventTypeMap.entries())
        .map(([event_type, count]) => ({ event_type, count }))
        .sort((a, b) => b.count - a.count || a.event_type.localeCompare(b.event_type))
        .slice(0, 10);

      return new Response(JSON.stringify({
        by_severity: bySeverity,
        by_event_type: byEventType,
        totals: {
          last_hour: lastHour,
          last_24h: last24h,
          last_7d: Number(dailyRow?.last_7d) || 0,
          total: Number(dailyRow?.total) || 0,
        },
        partial,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Failed to fetch audit stats', {
        error: error instanceof Error ? error.message : String(error),
      });

      return adminErrorResponse(error, 'Failed to fetch audit stats');
    }
  }

  /**
   * GET /admin/audit-logs/user/:userId - Get audit trail for specific user
   *
   * Both pagination modes use idx_audit_events_user_timestamp(user_id, timestamp, id).
   * Clients can opt into keyset pagination to avoid counting all of the user's events.
   */
  private async getUserAuditTrail(userId: string, request: Request, url: URL, env: Env): Promise<Response> {
    try {
      await verifyAdminRequest(request, env, 'admin:audit');

      const rawLimit = url.searchParams.get('limit');
      const rawPage = url.searchParams.get('page');
      const rawCursor = url.searchParams.get('cursor');
      const rawBefore = url.searchParams.get('before');
      const useKeyset = url.searchParams.get('pagination') === 'cursor' || rawCursor !== null || rawBefore !== null;

      if (!useKeyset) {
        const page = parseInt(rawPage || '1');
        const limit = parseInt(rawLimit || '50');
        const offset = (page - 1) * limit;
        const countResult = await this.db.prepare(AUDIT_ADMIN_QUERIES.userTrailCount).bind(userId).first<{ total: number }>();
        const total = countResult?.total || 0;
        const result = await this.db.prepare(AUDIT_ADMIN_QUERIES.userTrailPage).bind(userId, limit, offset).all<AuditEvent>();

        return Response.json({
          data: result.results || [],
          pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
      }

      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return createAuthErrorResponse('Invalid query parameters: limit must be an integer between 1 and 100', 400);
      }

      if (rawCursor !== null && rawBefore !== null) {
        return createAuthErrorResponse('Invalid query parameters: provide either cursor or before, not both', 400);
      }

      if (rawPage !== null) {
        return createAuthErrorResponse('Invalid query parameters: page cannot be combined with cursor pagination', 400);
      }

      const fetchLimit = limit + 1;
      let result: D1Result<AuditEvent>;

      if (rawCursor !== null) {
        const parsedCursor = decodeAuditCursor(rawCursor);
        if (!parsedCursor || typeof parsedCursor.t !== 'string') {
          return createAuthErrorResponse('Invalid query parameters: malformed cursor', 400);
        }
        result = await this.db
          .prepare(AUDIT_ADMIN_QUERIES.userTrailCursor)
          .bind(userId, parsedCursor.t, parsedCursor.i, fetchLimit)
          .all<AuditEvent>();
      } else if (rawBefore !== null) {
        const beforeMs = Date.parse(rawBefore);
        if (!rawBefore || Number.isNaN(beforeMs)) {
          return createAuthErrorResponse('Invalid query parameters: before must be an ISO timestamp', 400);
        }
        const normalizedBefore = new Date(beforeMs).toISOString();
        result = await this.db
          .prepare(AUDIT_ADMIN_QUERIES.userTrailBefore)
          .bind(userId, normalizedBefore, fetchLimit)
          .all<AuditEvent>();
      } else {
        result = await this.db
          .prepare(AUDIT_ADMIN_QUERIES.userTrailFirst)
          .bind(userId, fetchLimit)
          .all<AuditEvent>();
      }

      const rows = result.results || [];
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = hasMore ? data[data.length - 1] : undefined;

      return Response.json({
        data,
        pagination: {
          limit,
          hasMore,
          nextCursor: lastRow ? encodeAuditCursor(lastRow.timestamp, lastRow.id) : null,
        },
      });
    } catch (error) {
      logger.error('Failed to fetch user audit trail', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return adminErrorResponse(error, 'Failed to fetch user audit trail');
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

      return adminErrorResponse(error, 'Failed to get user tokens');
    }
  }

  /**
   * DELETE /admin/users/:userId/tokens - Revoke all user tokens (force logout)
   */
  private async revokeAllUserTokens(userId: string, request: Request, env: Env): Promise<Response> {
    try {
      const authResult = await verifyAdminRequest(request, env, 'admin:users');
      const authContext = authResult.type === 'user' ? authResult : { user: authResult.actingUser, isAdmin: true };

      // Rate limiting for destructive operations (AU-1): per acting admin
      const actor = authContext.user?.id ? `user:${authContext.user.id}` : `ip:${getClientIP(request)}`;
      if (!(await withinRateLimit(env.ADMIN_SENSITIVE_LIMITER, `admin:token:revoke:${actor}`))) {
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

      return adminErrorResponse(error, 'Failed to revoke user tokens');
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

      // Revoke tokens with reason
      await this.db.prepare(`
        UPDATE refresh_tokens
        SET revoked = 1, revoked_at = ?, revoked_reason = ?
        WHERE user_id = ? AND revoked = 0
      `).bind(now, reason, validated.user_id).run();

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

      return adminErrorResponse(error, 'Failed to revoke user tokens');
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

      const checks: Record<string, { status: string; latency?: number }> = {};

      // Check D1 database
      const dbStart = Date.now();
      try {
        await this.db.prepare('SELECT 1').first();
        checks.database = { status: 'healthy', latency: Date.now() - dbStart };
      } catch (e) {
        logger.error('Health check: database unavailable', { error: e instanceof Error ? e.message : String(e) });
        checks.database = { status: 'unhealthy' };
      }

      // Check KV store
      const kvStart = Date.now();
      try {
        await this.kv.get('health-check');
        checks.kv_store = { status: 'healthy', latency: Date.now() - kvStart };
      } catch (e) {
        logger.error('Health check: KV unavailable', { error: e instanceof Error ? e.message : String(e) });
        checks.kv_store = { status: 'unhealthy' };
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
      return adminErrorResponse(error, 'Health check failed');
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
          (SELECT COUNT(*) FROM users) - (SELECT COUNT(*) FROM users WHERE id IN (${SYSTEM_USER_IDS_SQL})) as total_users,
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

      return adminErrorResponse(error, 'Failed to get metrics');
    }
  }
}
