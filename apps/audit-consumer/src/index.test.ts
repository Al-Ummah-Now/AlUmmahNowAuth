/**
 * Unit Tests for Audit Consumer
 *
 * The consumer routes two message kinds from the audit queue:
 * - app_audit_event (from apps/auth QueueSink) -> audit_events
 * - OpenAuth token-usage events               -> token_usage (live schema)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { toTokenUsageRow } from './index';

type Bound = { sql: string; args: unknown[] };

function mockDb(batchImpl: () => Promise<unknown> = () => Promise.resolve([])) {
  const bound: Bound[] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => {
        const b = { sql, args };
        bound.push(b);
        return b;
      },
    })),
    batch: vi.fn().mockImplementation(batchImpl),
  };
  return { db, bound };
}

function tokenMessage(id: string, event: Record<string, unknown> = {}, attempts = 1) {
  return {
    id,
    timestamp: new Date(),
    attempts,
    body: {
      version: 1 as const,
      event: {
        token_id: 'tok_123',
        subject: 'user:abc',
        event_type: 'generated' as const,
        client_id: 'client_1',
        timestamp: 1_767_225_600_000,
        ...event,
      },
      enqueued_at: Date.now(),
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function appMessage(id: string, attempts = 1) {
  return {
    id,
    timestamp: new Date(),
    attempts,
    body: {
      version: 1 as const,
      type: 'app_audit_event' as const,
      event: {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'tenant.created',
        severity: 'info',
        userId: 'admin-1',
        ipAddress: '203.0.113.1',
        userAgent: 'test',
        requestId: 'req-1',
        metadata: { tenantId: 't1' },
        success: true,
        errorMessage: null,
      },
      enqueued_at: Date.now(),
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batchOf(messages: unknown[]) {
  return { messages, retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' } as any;
}

describe('Audit Consumer Worker', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('token usage events -> token_usage (live schema)', () => {
    it('inserts into the live token_usage columns and acks', async () => {
      const { db, bound } = mockDb();
      const msg = tokenMessage('m1', { ip_address: '192.168.1.1', user_agent: 'Mozilla/5.0' });

      await worker.queue(batchOf([msg]), { AUDIT_DB: db } as any);

      expect(bound).toHaveLength(1);
      expect(bound[0].sql).toMatch(/INSERT INTO token_usage \(\s*tenant_id, client_id, user_id, token_type, ip_address, user_agent, created_at/);
      expect(bound[0].args).toEqual(['default', 'client_1', 'abc', 'generated', '192.168.1.1', 'Mozilla/5.0', 1_767_225_600_000]);
      expect(msg.ack).toHaveBeenCalled();
    });

    it('handles a batch of 50 messages in one D1 batch', async () => {
      const { db } = mockDb();
      const messages = Array.from({ length: 50 }, (_, i) => tokenMessage(`m${i}`));
      await worker.queue(batchOf(messages), { AUDIT_DB: db } as any);
      expect(db.batch).toHaveBeenCalledTimes(1);
      expect((db.batch.mock.calls[0][0] as unknown[]).length).toBe(50);
      messages.forEach((m) => expect(m.ack).toHaveBeenCalled());
    });

    it.each(['generated', 'refreshed', 'revoked', 'reused'])('stores %s as token_type', (eventType) => {
      expect(toTokenUsageRow(tokenMessage('x', { event_type: eventType }).body.event as any).token_type).toBe(eventType);
    });

    it('maps optional/missing fields to the NOT NULL constraints', () => {
      const row = toTokenUsageRow({ token_id: 't', subject: 'user:u1', event_type: 'generated', timestamp: 1_700_000_000 } as any);
      expect(row).toEqual({
        tenant_id: 'default',
        client_id: 'unknown',
        user_id: 'u1',
        token_type: 'generated',
        ip_address: null,
        user_agent: null,
        created_at: 1_700_000_000_000, // seconds normalised to ms
      });
    });

    it('uses metadata.tenant_id when present', () => {
      const row = toTokenUsageRow({ token_id: 't', subject: 'u', event_type: 'revoked', timestamp: 1, metadata: { tenant_id: 'acme' } } as any);
      expect(row.tenant_id).toBe('acme');
      expect(row.user_id).toBe('u');
    });

    it('retries on D1 failure and acks after max attempts', async () => {
      const { db } = mockDb(() => Promise.reject(new Error('D1 write failed')));
      const fresh = tokenMessage('m1', {}, 1);
      const exhausted = tokenMessage('m2', {}, 3);

      await expect(worker.queue(batchOf([fresh, exhausted]), { AUDIT_DB: db } as any)).resolves.toBeUndefined();

      expect(fresh.retry).toHaveBeenCalled();
      expect(fresh.ack).not.toHaveBeenCalled();
      expect(exhausted.ack).toHaveBeenCalled();
    });
  });

  describe('application audit events -> audit_events', () => {
    it('writes app audit events to audit_events and acks them', async () => {
      const { db, bound } = mockDb();
      const msg = appMessage('a1');

      await worker.queue(batchOf([msg]), { AUDIT_DB: db } as any);

      expect(bound[0].sql).toContain('INSERT INTO audit_events');
      expect(bound[0].args).toEqual([
        '2026-01-01T00:00:00.000Z', 'tenant.created', 'info', 'admin-1', '203.0.113.1',
        'test', 'req-1', JSON.stringify({ tenantId: 't1' }), 1, null,
      ]);
      expect(msg.ack).toHaveBeenCalled();
    });

    it('routes mixed batches to the right tables', async () => {
      const { db, bound } = mockDb();
      const app = appMessage('a1');
      const token = tokenMessage('t1');

      await worker.queue(batchOf([app, token]), { AUDIT_DB: db } as any);

      expect(bound.map((b) => b.sql.match(/INSERT INTO (\w+)/)?.[1])).toEqual(['audit_events', 'token_usage']);
      expect(app.ack).toHaveBeenCalled();
      expect(token.ack).toHaveBeenCalled();
    });

    it('retries app events when the D1 write fails, then acks after max attempts', async () => {
      const { db } = mockDb(() => Promise.reject(new Error('D1 down')));
      const fresh = appMessage('a1', 1);
      const exhausted = appMessage('a2', 3);

      await worker.queue(batchOf([fresh, exhausted]), { AUDIT_DB: db } as any);

      expect(fresh.retry).toHaveBeenCalled();
      expect(fresh.ack).not.toHaveBeenCalled();
      expect(exhausted.ack).toHaveBeenCalled();
      expect(exhausted.retry).not.toHaveBeenCalled();
    });
  });

  describe('fetch() handler', () => {
    const env = { AUDIT_DB: {} } as any;

    it('returns healthy status on /health endpoint', async () => {
      const response = await worker.fetch(new Request('http://localhost/health'), env);
      expect(response.status).toBe(200);
      const body = await response.json() as { status: string; service: string; timestamp: number };
      expect(body).toMatchObject({ status: 'healthy', service: 'audit-consumer' });
      expect(body.timestamp).toBeGreaterThan(0);
    });

    it('returns metrics on /metrics endpoint', async () => {
      const response = await worker.fetch(new Request('http://localhost/metrics'), env);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { service: string }).service).toBe('audit-consumer');
    });

    it('returns default message for other paths', async () => {
      const response = await worker.fetch(new Request('http://localhost/unknown'), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Audit Consumer');
    });
  });
});
