/**
 * Tests for AlUmmahNowAuth#514 (AUN-D1-SCALING D1-4):
 * - GET /admin/audit-logs/stats reads pre-aggregated audit_hourly_counts and
 *   audit_daily_counts without scanning audit_events, and signals `partial: true`
 *   while historical backfill is incomplete.
 * - AFTER INSERT trigger keeps count tables accurate and idempotent across
 *   D1Sink and audit-consumer's WHERE NOT EXISTS inserts.
 * - GET /admin/audit-logs/user/:userId uses idx_audit_events_user_timestamp
 *   with lossless keyset paging (cursor / normalized before) and returns
 *   hasMore instead of COUNT(*).
 * - backfillAuditCounts folds pre-migration rows in bounded indexed batches
 *   with atomic compare-and-swap so overlapping runners never double-count,
 *   and exercises the real migration 0052 watermark SQL.
 * - pruneAuditHourlyCounts and pruneAuditDailyCounts keep both count tables
 *   bounded by primary key.
 * - EXPLAIN QUERY PLAN asserts every query (including audit-consumer's
 *   no-user duplicate check) uses an index with no table scan or temp B-tree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { sqlStatements } from '../test-setup';
import migration0052Sql from '../../migrations/0052_audit_daily_counts_and_user_index.sql?raw';
import { AdminEnterpriseRoutes, AUDIT_ADMIN_QUERIES } from '../admin-enterprise-routes';
import { D1Sink } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import {
  AUDIT_COUNTS_BACKFILL_KEY,
  AUDIT_COUNTS_MAINTENANCE_SQL,
  backfillAuditCounts,
  pruneAuditDailyCounts,
  pruneAuditHourlyCounts,
  utcDay,
  utcHour,
} from '../services/audit-counts-backfill';

vi.mock('../auth-middleware', () => ({
  verifyAdminRequest: vi.fn().mockResolvedValue({
    type: 'user',
    user: { id: 'admin-user', email: 'admin@test.com', roles: ['admin'] },
    permissions: [],
    isAdmin: true,
  }),
  createAuthErrorResponse: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message, status }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../rate-limit', () => ({
  withinRateLimit: vi.fn().mockResolvedValue(true),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function insertAuditRow(opts: {
  timestamp: string;
  eventType: string;
  severity: string;
  userId?: string | null;
  ipAddress?: string | null;
  requestId?: string | null;
  metadata?: string;
  success?: number;
}) {
  await env.AUTH_DB.prepare(`
    INSERT INTO audit_events (timestamp, event_type, severity, user_id, ip_address, request_id, metadata, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      opts.timestamp,
      opts.eventType,
      opts.severity,
      opts.userId === undefined ? 'user-123' : opts.userId,
      opts.ipAddress ?? null,
      opts.requestId ?? null,
      opts.metadata ?? '{}',
      opts.success ?? 1
    )
    .run();
}

describe('Audit stats, user trail keyset paging, and counts backfill (#514)', () => {
  let routes: AdminEnterpriseRoutes;
  const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const mockEnv = env as unknown as Env;

  beforeEach(async () => {
    routes = new AdminEnterpriseRoutes(env.AUTH_DB, env.AUTH_STORAGE);
    await env.AUTH_DB.prepare('DELETE FROM audit_events').run();
    await env.AUTH_DB.prepare('DELETE FROM audit_daily_counts').run();
    await env.AUTH_DB.prepare('DELETE FROM audit_hourly_counts').run();
    await env.AUTH_DB.prepare('DELETE FROM auth_settings WHERE key = ?')
      .bind(AUDIT_COUNTS_BACKFILL_KEY)
      .run();
  });

  describe('GET /admin/audit-logs/stats (pre-aggregated counts)', () => {
    it('serves 1h, 24h, 7d, 90d total, by_severity and top-10 by_event_type from count tables', async () => {
      const now = Date.now();

      // Within last hour
      await insertAuditRow({
        timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
        eventType: 'auth.login.success',
        severity: 'info',
      });
      await insertAuditRow({
        timestamp: new Date(now - 10 * 60 * 1000).toISOString(),
        eventType: 'auth.login.failed',
        severity: 'warning',
        success: 0,
      });

      // 6 hours ago (inside 24h, outside 1h)
      await insertAuditRow({
        timestamp: new Date(now - 6 * HOUR_MS).toISOString(),
        eventType: 'auth.login.success',
        severity: 'info',
      });
      await insertAuditRow({
        timestamp: new Date(now - 6 * HOUR_MS).toISOString(),
        eventType: 'security.alert',
        severity: 'critical',
      });

      // 3 days ago (inside 7d, outside 24h)
      await insertAuditRow({
        timestamp: new Date(now - 3 * DAY_MS).toISOString(),
        eventType: 'user.created',
        severity: 'info',
      });

      // 45 days ago (inside 90d total, outside 7d)
      await insertAuditRow({
        timestamp: new Date(now - 45 * DAY_MS).toISOString(),
        eventType: 'user.updated',
        severity: 'info',
      });

      // 120 days ago (outside 90d window — excluded from total)
      await insertAuditRow({
        timestamp: new Date(now - 120 * DAY_MS).toISOString(),
        eventType: 'user.deleted',
        severity: 'warning',
      });

      const response = await routes.handle(
        new Request('http://localhost/admin/audit-logs/stats', { method: 'GET' }),
        mockEnv,
        mockCtx
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        by_severity: Array<{ severity: string; count: number }>;
        by_event_type: Array<{ event_type: string; count: number }>;
        totals: { last_hour: number; last_24h: number; last_7d: number; total: number };
        partial: boolean;
      };

      expect(body.partial).toBe(false);
      expect(body.totals).toEqual({
        last_hour: 2,
        last_24h: 4,
        last_7d: 5,
        total: 6,
      });
      expect(body.by_severity).toEqual([
        { severity: 'info', count: 2 },
        { severity: 'critical', count: 1 },
        { severity: 'warning', count: 1 },
      ]);
      expect(body.by_event_type).toEqual([
        { event_type: 'auth.login.success', count: 2 },
        { event_type: 'auth.login.failed', count: 1 },
        { event_type: 'security.alert', count: 1 },
      ]);
    });

    it('reports partial: true while backfill is pending and partial: false once backfill finishes', async () => {
      const now = Date.now();
      await insertAuditRow({
        timestamp: new Date(now - 2 * DAY_MS).toISOString(),
        eventType: 'auth.login.success',
        severity: 'info',
      });
      // Reset count tables and run migration 0052's real watermark INSERT statement
      await env.AUTH_DB.prepare('DELETE FROM audit_daily_counts').run();
      await env.AUTH_DB.prepare('DELETE FROM audit_hourly_counts').run();
      const watermarkStmt = sqlStatements(migration0052Sql).find((s) => s.includes('audit_daily_counts_backfill'))!;
      await env.AUTH_DB.prepare(watermarkStmt).run();

      // Mid-backfill: partial must be true
      const beforeRes = await routes.handle(
        new Request('http://localhost/admin/audit-logs/stats', { method: 'GET' }),
        mockEnv,
        mockCtx
      );
      expect(beforeRes.status).toBe(200);
      const beforeBody = (await beforeRes.json()) as { partial: boolean; totals: { total: number } };
      expect(beforeBody.partial).toBe(true);
      expect(beforeBody.totals.total).toBe(0);

      // Run backfill to completion
      const result = await backfillAuditCounts(env.AUTH_DB, { now });
      expect(result).toEqual({ processed: 1, batches: 1, done: true });

      const afterRes = await routes.handle(
        new Request('http://localhost/admin/audit-logs/stats', { method: 'GET' }),
        mockEnv,
        mockCtx
      );
      expect(afterRes.status).toBe(200);
      const afterBody = (await afterRes.json()) as { partial: boolean; totals: { total: number } };
      expect(afterBody.partial).toBe(false);
      expect(afterBody.totals.total).toBe(1);
    });

    it('caps by_event_type to top 10 ordered descending by count', async () => {
      const ts = new Date().toISOString();
      for (let i = 1; i <= 12; i++) {
        for (let k = 0; k < i; k++) {
          await insertAuditRow({
            timestamp: ts,
            eventType: `event.type.${String(i).padStart(2, '0')}`,
            severity: 'info',
          });
        }
      }

      const response = await routes.handle(
        new Request('http://localhost/admin/audit-logs/stats', { method: 'GET' }),
        mockEnv,
        mockCtx
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        by_event_type: Array<{ event_type: string; count: number }>;
      };
      expect(body.by_event_type).toHaveLength(10);
      expect(body.by_event_type[0]).toEqual({ event_type: 'event.type.12', count: 12 });
      expect(body.by_event_type[9]).toEqual({ event_type: 'event.type.03', count: 3 });
    });

    it('trigger stays idempotent under audit-consumer WHERE NOT EXISTS replay and updates via D1Sink', async () => {
      const ts = new Date().toISOString();
      const idempotentInsert = `
        INSERT INTO audit_events (
          timestamp, event_type, severity, user_id, ip_address,
          user_agent, request_id, metadata, success, error_message
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_events
          WHERE timestamp = ? AND event_type = ? AND user_id IS ?
            AND ip_address IS ? AND request_id IS ? AND metadata IS ?
        )
      `;
      const args = [
        ts, 'tenant.created', 'info', 'admin-1', '203.0.113.1',
        'test', 'req-dup-1', '{}', 1, null,
        ts, 'tenant.created', 'admin-1', '203.0.113.1', 'req-dup-1', '{}',
      ];

      // First delivery inserts 1 row; replay inserts 0 rows and must NOT increment counts
      await env.AUTH_DB.prepare(idempotentInsert).bind(...args).run();
      await env.AUTH_DB.prepare(idempotentInsert).bind(...args).run();

      // Direct D1Sink fallback also updates counts through the trigger
      const sink = new D1Sink(env.AUTH_DB, { batchSize: 10 });
      await sink.emit({
        timestamp: ts,
        eventType: AuditEventType.LOGIN_SUCCESS,
        severity: AuditEventSeverity.INFO,
        userId: 'user-123',
        ipAddress: '127.0.0.1',
        userAgent: 'test',
        requestId: 'req-sink-1',
        metadata: {},
        success: true,
        errorMessage: null,
      });
      await sink.flush();

      const daily = await env.AUTH_DB.prepare(
        'SELECT event_type, n FROM audit_daily_counts WHERE day = ? ORDER BY event_type'
      )
        .bind(ts.slice(0, 10))
        .all<{ event_type: string; n: number }>();

      expect(daily.results).toEqual([
        { event_type: 'auth.login.success', n: 1 },
        { event_type: 'tenant.created', n: 1 },
      ]);
    });
  });

  describe('GET /admin/audit-logs/user/:userId (keyset pagination)', () => {
    it('pages losslessly with cursor across identical timestamps and returns hasMore instead of total', async () => {
      // Seed 5 events for user-123 (two share the exact same timestamp) + 1 event for another user
      const rows = [
        { timestamp: '2026-11-24T01:00:00.000Z', eventType: 'e1', userId: 'user-123' },
        { timestamp: '2026-11-24T02:00:00.000Z', eventType: 'e2', userId: 'user-123' },
        { timestamp: '2026-11-24T02:00:00.000Z', eventType: 'e3', userId: 'user-123' },
        { timestamp: '2026-11-24T03:00:00.000Z', eventType: 'e4', userId: 'user-123' },
        { timestamp: '2026-11-24T04:00:00.000Z', eventType: 'e5', userId: 'user-123' },
        { timestamp: '2026-11-24T05:00:00.000Z', eventType: 'other', userId: 'user-456' },
      ];
      for (const r of rows) {
        await insertAuditRow({ timestamp: r.timestamp, eventType: r.eventType, severity: 'info', userId: r.userId });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
        const res = await routes.handle(
          new Request(`http://localhost/admin/audit-logs/user/user-123${qs}`, { method: 'GET' }),
          mockEnv,
          mockCtx
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ event_type: string; user_id: string }>;
          pagination: { limit: number; hasMore: boolean; nextCursor: string | null; nextBefore: string | null; total?: number };
        };

        expect(body.pagination.total).toBeUndefined();
        for (const ev of body.data) {
          expect(ev.user_id).toBe('user-123');
          seen.push(ev.event_type);
        }
        cursor = body.pagination.hasMore ? body.pagination.nextCursor : null;
        if (body.pagination.hasMore) {
          expect(body.pagination.nextCursor).toBeTruthy();
          expect(body.pagination.nextBefore).toBeTruthy();
        } else {
          expect(body.pagination.nextCursor).toBeNull();
          expect(body.pagination.nextBefore).toBeNull();
        }
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      // Newest first, with deterministic id DESC tie-break for e3 vs e2
      expect(seen).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    });

    it('supports before=<timestamp> and normalizes timestamps without milliseconds so exact instants are excluded', async () => {
      await insertAuditRow({ timestamp: '2026-11-24T01:00:00.000Z', eventType: 'older', severity: 'info', userId: 'user-123' });
      await insertAuditRow({ timestamp: '2026-11-24T03:00:00.000Z', eventType: 'exact', severity: 'info', userId: 'user-123' });

      // Without normalizing, '2026-11-24T03:00:00Z' > '2026-11-24T03:00:00.000Z' in ASCII ('Z' > '.')
      const res = await routes.handle(
        new Request('http://localhost/admin/audit-logs/user/user-123?before=2026-11-24T03:00:00Z', { method: 'GET' }),
        mockEnv,
        mockCtx
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ event_type: string }>;
        pagination: { hasMore: boolean };
      };
      expect(body.data.map((d) => d.event_type)).toEqual(['older']);
      expect(body.pagination.hasMore).toBe(false);
    });

    it('returns 400 for invalid limit, malformed cursor, conflicting params, or offset page > 1', async () => {
      const badUrls = [
        'http://localhost/admin/audit-logs/user/user-123?limit=0',
        'http://localhost/admin/audit-logs/user/user-123?limit=101',
        'http://localhost/admin/audit-logs/user/user-123?limit=abc',
        'http://localhost/admin/audit-logs/user/user-123?cursor=not-valid-base64!!!',
        'http://localhost/admin/audit-logs/user/user-123?before=not-a-date',
        'http://localhost/admin/audit-logs/user/user-123?cursor=e30&before=2026-11-24T00:00:00Z',
        'http://localhost/admin/audit-logs/user/user-123?page=2',
      ];
      for (const u of badUrls) {
        const res = await routes.handle(new Request(u, { method: 'GET' }), mockEnv, mockCtx);
        expect(res.status, u).toBe(400);
      }
    });
  });

  describe('Bounded backfill, CAS concurrency safety, and pruning', () => {
    it('backfills pre-migration rows seeded via real migration 0052 watermark without double-counting post-migration rows', async () => {
      const now = Date.parse('2026-11-24T12:00:00.000Z');

      // Seed 5 "pre-migration" rows (1 older than 90d, 4 inside 90d, 2 inside 48h)
      const preRows = [
        { timestamp: new Date(now - 100 * DAY_MS).toISOString(), eventType: 'too.old', severity: 'info' },
        { timestamp: new Date(now - 20 * DAY_MS).toISOString(), eventType: 'auth.login.success', severity: 'info' },
        { timestamp: new Date(now - 5 * DAY_MS).toISOString(), eventType: 'auth.login.success', severity: 'info' },
        { timestamp: new Date(now - 10 * HOUR_MS).toISOString(), eventType: 'auth.login.failed', severity: 'warning' },
        { timestamp: new Date(now - 2 * HOUR_MS).toISOString(), eventType: 'auth.login.failed', severity: 'warning' },
      ];
      for (const r of preRows) {
        await insertAuditRow({ timestamp: r.timestamp, eventType: r.eventType, severity: r.severity });
      }

      // Simulate state immediately after migration 0052: count tables are empty and
      // migration 0052's actual INSERT OR IGNORE watermark statement records cutoff_rowid & cutoff_ts.
      await env.AUTH_DB.prepare('DELETE FROM audit_daily_counts').run();
      await env.AUTH_DB.prepare('DELETE FROM audit_hourly_counts').run();
      const watermarkStmt = sqlStatements(migration0052Sql).find((s) => s.includes('audit_daily_counts_backfill'))!;
      await env.AUTH_DB.prepare(watermarkStmt).run();

      // Insert a post-migration row with an earlier timestamp (simulating delayed queue replay):
      // the trigger counts it immediately, and backfill MUST skip it (rowid > cutoff_rowid).
      await insertAuditRow({
        timestamp: new Date(now - 3 * HOUR_MS).toISOString(),
        eventType: 'auth.login.failed',
        severity: 'warning',
      });

      // Run backfill with small batches (2 rows * 1 batch per call) so it must resume across runs
      const run1 = await backfillAuditCounts(env.AUTH_DB, { now, batchSize: 2, maxBatches: 1 });
      expect(run1).toEqual({ processed: 2, batches: 1, done: false });

      const run2 = await backfillAuditCounts(env.AUTH_DB, { now, batchSize: 2, maxBatches: 1 });
      expect(run2.done).toBe(false);

      const run3 = await backfillAuditCounts(env.AUTH_DB, { now, batchSize: 2, maxBatches: 5 });
      expect(run3.done).toBe(true);

      // Re-running after done is a no-op
      const run4 = await backfillAuditCounts(env.AUTH_DB, { now, batchSize: 2, maxBatches: 5 });
      expect(run4).toEqual({ processed: 0, batches: 0, done: true });

      // Total in audit_daily_counts: 4 pre-migration (within 90d) + 1 post-migration = 5 (too.old excluded, no double count)
      const dailyTotal = await env.AUTH_DB.prepare('SELECT SUM(n) AS total FROM audit_daily_counts').first<{ total: number }>();
      expect(dailyTotal?.total).toBe(5);

      // Hourly counts: 2 pre-migration (within 48h) + 1 post-migration = 3
      const hourlyTotal = await env.AUTH_DB.prepare('SELECT SUM(n) AS total FROM audit_hourly_counts').first<{ total: number }>();
      expect(hourlyTotal?.total).toBe(3);
    });

    it('prevents double-counting when two backfill runners overlap (CAS guard)', async () => {
      const now = Date.parse('2026-11-24T12:00:00.000Z');
      await insertAuditRow({ timestamp: new Date(now - 5 * HOUR_MS).toISOString(), eventType: 'auth.login.success', severity: 'info' });
      await insertAuditRow({ timestamp: new Date(now - 4 * HOUR_MS).toISOString(), eventType: 'auth.login.success', severity: 'info' });
      await insertAuditRow({ timestamp: new Date(now - 3 * HOUR_MS).toISOString(), eventType: 'auth.login.success', severity: 'info' });

      await env.AUTH_DB.prepare('DELETE FROM audit_daily_counts').run();
      await env.AUTH_DB.prepare('DELETE FROM audit_hourly_counts').run();
      const watermarkStmt = sqlStatements(migration0052Sql).find((s) => s.includes('audit_daily_counts_backfill'))!;
      await env.AUTH_DB.prepare(watermarkStmt).run();

      // Runner A reads state, then right before its batch commits, Runner B runs to completion.
      // Runner A's CAS batch must apply 0 count increments and return conflicted: true.
      let runnerBResult: Awaited<ReturnType<typeof backfillAuditCounts>> | null = null;
      const runnerAResult = await backfillAuditCounts(env.AUTH_DB, {
        now,
        batchSize: 10,
        maxBatches: 1,
        beforeBatchCommit: async () => {
          runnerBResult = await backfillAuditCounts(env.AUTH_DB, { now, batchSize: 10, maxBatches: 1 });
        },
      });

      expect(runnerBResult).toEqual({ processed: 3, batches: 1, done: true });
      expect(runnerAResult).toEqual({ processed: 0, batches: 1, done: false, conflicted: true });

      const dailyTotal = await env.AUTH_DB.prepare('SELECT SUM(n) AS total FROM audit_daily_counts').first<{ total: number }>();
      const hourlyTotal = await env.AUTH_DB.prepare('SELECT SUM(n) AS total FROM audit_hourly_counts').first<{ total: number }>();
      expect(dailyTotal?.total).toBe(3);
      expect(hourlyTotal?.total).toBe(3);
    });

    it('prunes audit_hourly_counts (>48h) and audit_daily_counts (>90d) while keeping recent buckets', async () => {
      const now = Date.parse('2026-11-24T12:00:00.000Z');
      await insertAuditRow({ timestamp: new Date(now - 100 * DAY_MS).toISOString(), eventType: 'old.day', severity: 'info' });
      await insertAuditRow({ timestamp: new Date(now - 60 * HOUR_MS).toISOString(), eventType: 'old.hour', severity: 'info' });
      await insertAuditRow({ timestamp: new Date(now - 12 * HOUR_MS).toISOString(), eventType: 'recent.hour', severity: 'info' });

      const deletedHourly = await pruneAuditHourlyCounts(env.AUTH_DB, now);
      expect(deletedHourly).toBe(2);
      const remainingHourly = await env.AUTH_DB.prepare('SELECT event_type FROM audit_hourly_counts').all<{ event_type: string }>();
      expect(remainingHourly.results.map((r) => r.event_type)).toEqual(['recent.hour']);

      const deletedDaily = await pruneAuditDailyCounts(env.AUTH_DB, now);
      expect(deletedDaily).toBe(1);
      const remainingDaily = await env.AUTH_DB.prepare('SELECT event_type FROM audit_daily_counts ORDER BY event_type').all<{ event_type: string }>();
      expect(remainingDaily.results.map((r) => r.event_type)).toEqual(['old.hour', 'recent.hour']);
    });
  });

  describe('EXPLAIN QUERY PLAN index verification', () => {
    it('getAuditStats queries use PK indexes on count tables and auth_settings, and never touch audit_events', async () => {
      const now = Date.now();
      const hourlyPlan = await env.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${AUDIT_ADMIN_QUERIES.statsHourly}`)
        .bind(utcHour(now - 24 * HOUR_MS))
        .all<{ detail: string }>();
      const hourlyDetail = hourlyPlan.results.map((r) => r.detail).join(' | ');
      expect(hourlyDetail).toContain('SEARCH audit_hourly_counts USING');
      expect(hourlyDetail).not.toContain('audit_events');
      expect(hourlyDetail).not.toMatch(/\bSCAN\b/);
      expect(hourlyDetail).not.toContain('TEMP B-TREE');

      const dailyPlan = await env.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${AUDIT_ADMIN_QUERIES.statsDaily}`)
        .bind(utcDay(now - 7 * DAY_MS), utcDay(now - 89 * DAY_MS))
        .all<{ detail: string }>();
      const dailyDetail = dailyPlan.results.map((r) => r.detail).join(' | ');
      expect(dailyDetail).toContain('SEARCH audit_daily_counts USING');
      expect(dailyDetail).not.toContain('audit_events');
      expect(dailyDetail).not.toMatch(/\bSCAN\b/);
      expect(dailyDetail).not.toContain('TEMP B-TREE');

      const statusPlan = await env.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${AUDIT_ADMIN_QUERIES.statsBackfillStatus}`)
        .bind(AUDIT_COUNTS_BACKFILL_KEY)
        .all<{ detail: string }>();
      const statusDetail = statusPlan.results.map((r) => r.detail).join(' | ');
      expect(statusDetail).toContain('SEARCH auth_settings USING');
      expect(statusDetail).not.toMatch(/\bSCAN\b/);
    });

    it('getUserAuditTrail and audit-consumer no-user duplicate check use idx_audit_events_user_timestamp with no SCAN or TEMP B-TREE', async () => {
      const plans = [
        {
          name: 'first page',
          sql: AUDIT_ADMIN_QUERIES.userTrailFirst,
          binds: ['user-123', 51],
        },
        {
          name: 'cursor page',
          sql: AUDIT_ADMIN_QUERIES.userTrailCursor,
          binds: ['user-123', '2026-11-24T01:00:00.000Z', 10, 51],
        },
        {
          name: 'before page',
          sql: AUDIT_ADMIN_QUERIES.userTrailBefore,
          binds: ['user-123', '2026-11-24T01:00:00.000Z', 51],
        },
        {
          name: 'audit-consumer duplicate check with user_id IS NULL',
          sql: `SELECT 1 FROM audit_events
                WHERE timestamp = ? AND event_type = ? AND user_id IS ?
                  AND ip_address IS ? AND request_id IS ? AND metadata IS ?`,
          binds: ['2026-11-24T01:00:00.000Z', 'auth.login.failed', null, '203.0.113.1', 'req-1', '{}'],
        },
      ];

      for (const { name, sql, binds } of plans) {
        const res = await env.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
        const detail = res.results.map((r) => r.detail).join(' | ');
        expect(detail, name).toContain('idx_audit_events_user_timestamp');
        expect(detail, name).not.toMatch(/\bSCAN\b/);
        expect(detail, name).not.toContain('TEMP B-TREE');
      }
    });

    it('backfill and prune queries use indexes with no SCAN or TEMP B-TREE', async () => {
      const plans = [
        {
          name: 'backfillFirst',
          sql: AUDIT_COUNTS_MAINTENANCE_SQL.backfillFirst,
          binds: ['2026-08-27', '2026-11-24T12:00:00.000Z', 500],
          expectedIndex: 'idx_audit_events_timestamp',
        },
        {
          name: 'backfillNext',
          sql: AUDIT_COUNTS_MAINTENANCE_SQL.backfillNext,
          binds: ['2026-11-24T00:00:00.000Z', 100, '2026-11-24T12:00:00.000Z', 500],
          expectedIndex: 'idx_audit_events_timestamp',
        },
        {
          name: 'pruneHourly',
          sql: AUDIT_COUNTS_MAINTENANCE_SQL.pruneHourly,
          binds: ['2026-11-22T12'],
          expectedIndex: 'audit_hourly_counts',
        },
        {
          name: 'pruneDaily',
          sql: AUDIT_COUNTS_MAINTENANCE_SQL.pruneDaily,
          binds: ['2026-08-26'],
          expectedIndex: 'audit_daily_counts',
        },
      ];

      for (const { name, sql, binds, expectedIndex } of plans) {
        const res = await env.AUTH_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
        const detail = res.results.map((r) => r.detail).join(' | ');
        expect(detail, name).toContain(expectedIndex);
        expect(detail, name).not.toMatch(/\bSCAN\b/);
        expect(detail, name).not.toContain('TEMP B-TREE');
      }
    });
  });
});
