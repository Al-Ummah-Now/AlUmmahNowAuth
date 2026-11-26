import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import coreSql from '../../migrations/0001_core_tables.sql?raw';
import coreQaSql from '../../migrations-qa/0001_core_tables.sql?raw';
import replaySql from '../../migrations/0054_webhook_dlq_replay_timestamps.sql?raw';
import replayQaSql from '../../migrations-qa/0054_webhook_dlq_replay_timestamps.sql?raw';
import { sqlStatements } from '../test-setup';
import { AuditEventType, AuditEventSeverity, type AuditEvent } from '../audit-events';
import { WebhookSink } from '../audit-emitter';
import { DLQReplayService } from '../dlq-replay';
import { handleDLQList, handleDLQStats } from '../admin-dlq-routes';

vi.mock(import('../session'), async (importOriginal) => ({
  ...await importOriginal(),
  getUserSession: vi.fn().mockResolvedValue({ user: { roles: ['admin'] } }),
}));

const db = env.AUTH_DB;
const adminEnv = env as unknown as Env;
const webhookUrl = 'https://hooks.test/audit';
const events: AuditEvent[] = [
  { timestamp: '2026-11-26T01:00:00.000Z', eventType: AuditEventType.LOGIN_SUCCESS, severity: AuditEventSeverity.INFO, metadata: {}, success: true },
  { timestamp: '2026-11-26T01:00:01.000Z', eventType: AuditEventType.LOGIN_SUCCESS, severity: AuditEventSeverity.INFO, metadata: {}, success: true },
];
const HOUR_MS = 60 * 60 * 1000;

describe.each([
  ['production', coreSql, replaySql],
  ['QA', coreQaSql, replayQaSql],
])('DLQ on migrated %s D1', (_environment, core, replay) => {
  const service = new DLQReplayService(db);
  const fetchWebhook = vi.fn<typeof fetch>();

  beforeAll(async () => {
    await db.prepare('DROP TABLE IF EXISTS webhook_dlq').run();
    await db.batch(sqlStatements(core).filter(sql => sql.includes('webhook_dlq')).map(sql => db.prepare(sql)));
    // Verify the additive upgrade also handles a row created on the old schema.
    await db.prepare(`INSERT INTO webhook_dlq (id, webhook_url, event_type, payload)
      VALUES ('pre-migration', ?, ?, ?)`)
      .bind(webhookUrl, events[0]!.eventType, JSON.stringify(events[0])).run();
    await db.batch(sqlStatements(replay).map(sql => db.prepare(sql)));
    const { entries } = await service.getQueuedEvents();
    expect(entries).toMatchObject([{ id: 'pre-migration', status: 'pending', events: [events[0]] }]);
  });

  beforeEach(async () => {
    fetchWebhook.mockReset();
    vi.stubGlobal('fetch', fetchWebhook);
    await db.prepare('DELETE FROM webhook_dlq').run();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function storeBatch() {
    fetchWebhook.mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Unavailable' }));
    const sink = new WebhookSink({ url: webhookUrl, db, maxRetries: 2, retryDelays: [0] });
    for (const event of events) await sink.emit(event);
    await sink.flush();
    expect(sink.getMetrics()).toMatchObject({ totalAttempts: 2, dlqWrites: 1 });
  }

  it('stores the failed batch, lists it through admin, and only completes on successful delivery', async () => {
    await storeBatch();

    const list = await handleDLQList(new Request('http://localhost/admin/dlq/list?limit=1&status=pending&maxAge=1'), adminEnv);
    expect(list.status).toBe(200);
    const body = await list.json<{ entries: { id: string; createdAt: string }[] }>();
    expect(body).toMatchObject({ total: 1, entries: [{
      id: expect.any(String), events, webhookUrl, error: 'HTTP 503: Unavailable', retryCount: 1, status: 'pending',
    }] });
    const entry = body.entries[0]!;

    expect(await service.replayFailedEvents({ dryRun: true })).toMatchObject({ totalEntries: 1, successfulReplays: 1 });
    expect(await service.replayFailedEvents({ webhookUrl: 'https://other.test/audit' })).toMatchObject({ totalEntries: 0 });
    expect(fetchWebhook).toHaveBeenCalledTimes(2);

    fetchWebhook.mockResolvedValueOnce(new Response(null, { status: 400, statusText: 'Bad Request' }));
    expect(await service.replayFailedEvents()).toEqual({
      totalEntries: 1, successfulReplays: 0, failedReplays: 1, errors: [{ id: entry.id, error: 'HTTP 400: Bad Request' }],
    });
    expect((await service.getQueuedEvents({ status: 'failed' })).entries).toMatchObject([{
      id: entry.id, status: 'failed', error: 'HTTP 400: Bad Request', replayedAt: undefined, replayingStartedAt: undefined,
    }]);

    fetchWebhook.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await service.replayFailedEvents({ filterStatus: 'failed', webhookUrl })).toMatchObject({ successfulReplays: 1 });
    expect(fetchWebhook).toHaveBeenLastCalledWith(webhookUrl, expect.objectContaining({ body: JSON.stringify({ events }) }));
    expect((await service.getQueuedEvents()).entries).toMatchObject([{
      id: entry.id, status: 'completed', replayedAt: expect.any(String), replayingStartedAt: undefined,
    }]);
    const stats = await handleDLQStats(new Request('http://localhost/admin/dlq/stats'), adminEnv);
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual({
      total: 1, pending: 0, replaying: 0, completed: 1, failed: 0, oldestEntry: entry.createdAt, newestEntry: entry.createdAt,
    });
  });

  it('claims the row once for overlapping replays', async () => {
    await storeBatch();
    fetchWebhook.mockClear();
    fetchWebhook.mockImplementation(async () => new Response(null, { status: 204 }));
    const runs = await Promise.all([service.replayFailedEvents(), service.replayFailedEvents()]);
    expect(runs.map(run => run.successfulReplays).sort()).toEqual([0, 1]);
    expect(fetchWebhook).toHaveBeenCalledTimes(1);
  });

  it('applies age filters, resets stale claims and cleans up completed rows using epoch timestamps', async () => {
    const now = Date.now();
    const insert = db.prepare(`INSERT INTO webhook_dlq
      (id, webhook_url, event_type, payload, status, created_at, replaying_started_at)
      VALUES (?, ?, ?, '[]', ?, ?, ?)`);
    await db.batch([
      insert.bind('recent', webhookUrl, 'audit.batch', 'pending', now, null),
      insert.bind('old', webhookUrl, 'audit.batch', 'completed', now - 48 * HOUR_MS, null),
      insert.bind('stale', webhookUrl, 'audit.batch', 'replaying', now - 2 * HOUR_MS, now - HOUR_MS),
      insert.bind('active', webhookUrl, 'audit.batch', 'replaying', now, now),
      insert.bind('unclaimed', webhookUrl, 'audit.batch', 'replaying', now, null),
    ]);

    expect((await service.getQueuedEvents({ maxAge: 3, limit: 1, offset: 1 })).total).toBe(4);
    expect(await service.resetStaleReplayingEntries()).toEqual({ reset: 2 });
    expect((await service.getQueuedEvents({ status: 'replaying' })).entries).toMatchObject([{ id: 'active' }]);
    expect(await service.cleanup({ maxAge: 1, statusFilter: 'completed' })).toEqual({ deleted: 1 });
    expect((await service.getQueuedEvents()).total).toBe(4);
  });
});
