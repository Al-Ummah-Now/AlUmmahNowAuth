import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  QueueSink,
  D1Sink,
  WebhookSink,
  ensureAuditEmitter,
  initializeAuditEmitter,
  emitAuditEvent,
  flushAuditEvents,
  getAuditEmitter,
  type AppAuditQueueMessage,
} from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, type AuditEvent } from '../audit-events';

function makeEvent(i = 0, severity = AuditEventSeverity.INFO): AuditEvent {
  return {
    timestamp: new Date(1_700_000_000_000 + i).toISOString(),
    eventType: AuditEventType.TENANT_CREATED,
    severity,
    userId: `admin-${i}`,
    ipAddress: null,
    userAgent: null,
    requestId: `req-${i}`,
    metadata: { i },
    success: true,
    errorMessage: null,
  } as AuditEvent;
}

function mockQueue() {
  const sent: AppAuditQueueMessage[] = [];
  const queue = {
    send: vi.fn(),
    sendBatch: vi.fn(async (msgs: { body: AppAuditQueueMessage }[]) => {
      sent.push(...msgs.map((m) => m.body));
    }),
  };
  return { queue: queue as unknown as Queue, raw: queue, sent };
}

describe('QueueSink', () => {
  it('buffers events and publishes them as app_audit_event messages on flush', async () => {
    const { queue, raw, sent } = mockQueue();
    const sink = new QueueSink(queue, { batchSize: 10 });

    await sink.emit(makeEvent(1));
    await sink.emit(makeEvent(2));
    expect(raw.sendBatch).not.toHaveBeenCalled();
    expect(sink.hasPendingEvents()).toBe(true);

    await sink.flush();
    expect(raw.sendBatch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ version: 1, type: 'app_audit_event', event: { requestId: 'req-1' } });
    expect(sink.hasPendingEvents()).toBe(false);
  });

  it('sends automatically when the batch fills', async () => {
    const { queue, raw } = mockQueue();
    const sink = new QueueSink(queue, { batchSize: 2 });
    await sink.emit(makeEvent(1));
    await sink.emit(makeEvent(2));
    expect(raw.sendBatch).toHaveBeenCalledTimes(1);
  });

  it('is bounded: drops the oldest events when the buffer is full', async () => {
    const { queue, raw, sent } = mockQueue();
    raw.sendBatch.mockRejectedValue(new Error('queue unavailable'));
    const sink = new QueueSink(queue, { batchSize: 100, maxQueueSize: 100 });
    for (let i = 0; i < 150; i++) {
      await sink.emit(makeEvent(i));
    }
    const metrics = sink.getMetrics();
    expect(metrics.queueSize).toBeLessThanOrEqual(100);
    expect(metrics.droppedEvents).toBeGreaterThan(0);
    expect(metrics.failedSends).toBeGreaterThan(0);

    raw.sendBatch.mockImplementation(async (msgs: { body: AppAuditQueueMessage }[]) => {
      sent.push(...msgs.map((m) => m.body));
    });
    await sink.flush();
    // Newest events survive
    expect(sent.at(-1)?.event.requestId).toBe('req-149');
    expect(sink.hasPendingEvents()).toBe(false);
  });

  it('keeps events for a later flush when sending fails', async () => {
    const { queue, raw } = mockQueue();
    raw.sendBatch.mockRejectedValueOnce(new Error('transient'));
    const sink = new QueueSink(queue, { batchSize: 10 });
    await sink.emit(makeEvent(1));
    await sink.flush();
    expect(sink.hasPendingEvents()).toBe(true);
    await sink.flush();
    expect(sink.hasPendingEvents()).toBe(false);
    expect(raw.sendBatch).toHaveBeenCalledTimes(2);
  });
});

describe('bounded D1/Webhook sink queues', () => {
  it('WebhookSink stays bounded while a slow delivery is in flight', async () => {
    let release: (r: Response) => void = () => {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((resolve) => { release = resolve; })
    ) as unknown as typeof fetch;
    const sink = new WebhookSink({ url: 'https://hooks.test/audit', batchSize: 10, batchTimeout: 60_000, maxQueueSize: 20 });

    for (let i = 0; i < 9; i++) await sink.emit(makeEvent(i));
    const inFlight = sink.emit(makeEvent(9)); // 10th event starts a flush that hangs
    for (let i = 10; i < 40; i++) await sink.emit(makeEvent(i));

    expect(sink.getMetrics().droppedEvents).toBe(10);
    release(new Response('ok'));
    await inFlight;
    globalThis.fetch = originalFetch;
  });

  it('D1Sink stays bounded while a timer flush is in flight', async () => {
    let release: () => void = () => {};
    const stmt = { bind: vi.fn().mockReturnThis() };
    const db = {
      prepare: vi.fn().mockReturnValue(stmt),
      batch: vi.fn(() => new Promise<unknown[]>((resolve) => { release = () => resolve([]); })),
    } as unknown as D1Database;
    const sink = new D1Sink(db, { batchSize: 5, batchTimeout: 1, maxQueueSize: 10 });

    await sink.emit(makeEvent(0));
    await new Promise((r) => setTimeout(r, 20)); // timer fires, flush awaits db.batch
    for (let i = 1; i <= 20; i++) await sink.emit(makeEvent(i));

    expect(sink.getMetrics()).toMatchObject({ queueSize: 10, droppedEvents: 10 });
    release();
  });
});

describe('worker audit emitter wiring', () => {
  beforeEach(() => {
    // reset to a fresh emitter between tests
    initializeAuditEmitter({ enableStdout: false });
  });

  it('ensureAuditEmitter uses the AUDIT_QUEUE sink and flushAuditEvents delivers buffered events', async () => {
    const { queue, sent } = mockQueue();
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;

    const emitter = ensureAuditEmitter({ enableStdout: false, db, queue, ctx });
    expect(emitter.getSinks().map((s) => s.name)).toEqual(['queue']);

    // admin/role/tenant routes call emitAuditEvent -> must reach the queue sink
    await emitAuditEvent(makeEvent(7));
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    expect(sent).toHaveLength(0);

    await flushAuditEvents();
    expect(sent).toHaveLength(1);
    expect(sent[0].event.requestId).toBe('req-7');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('ensureAuditEmitter reuses one emitter across invocations', () => {
    const { queue } = mockQueue();
    const ctx1 = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const ctx2 = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const a = ensureAuditEmitter({ enableStdout: false, queue, ctx: ctx1 });
    const b = ensureAuditEmitter({ enableStdout: false, queue, ctx: ctx2 });
    expect(a).toBe(b);
    expect(getAuditEmitter()).toBe(a);
  });

  it('falls back to direct D1 writes when no queue is bound', () => {
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const emitter = ensureAuditEmitter({ enableStdout: true, db });
    expect(emitter.getSinks().map((s) => s.name)).toEqual(['stdout', 'd1']);
  });
});
