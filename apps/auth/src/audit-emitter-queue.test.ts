/**
 * Queue Size Limits Tests for Audit Emitter
 *
 * Tests for queue overflow protection and metrics
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  WebhookSink,
  D1Sink,
  QueueMetrics,
} from './audit-emitter-enhanced';
import {
  AuditEventType,
  AuditEventSeverity,
  createLoginSuccessEvent,
  createLoginFailedEvent,
  createTokenIssuedEvent,
  AuditEvent,
} from './audit-events';

// Helper function to create test events
function createTestEvent(id: string, severity: AuditEventSeverity = AuditEventSeverity.INFO): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    eventType: AuditEventType.LOGIN_SUCCESS,
    severity,
    userId: `user-${id}`,
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    requestId: `req-${id}`,
    success: true,
    metadata: { id },
  };
}

describe('WebhookSink Queue Limits', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    global.fetch = fetchSpy;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should enforce maximum queue size', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 3,
      batchSize: 10, // Won't batch until 10
    });

    // Add 5 events
    for (let i = 1; i <= 5; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    // Queue should only have last 3 events
    const metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(3);
    expect(metrics.droppedEvents).toBe(2);
    expect(metrics.queueUtilization).toBe(100);
  });

  it('should drop oldest events when queue is full', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 2,
      batchSize: 10,
    });

    const event1 = createTestEvent('event-1');
    const event2 = createTestEvent('event-2');
    const event3 = createTestEvent('event-3');

    await sink.emit(event1);
    await sink.emit(event2);
    await sink.emit(event3);

    // Manually trigger flush to check queue contents
    await sink.flush();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const sentEvents = body.events;

    expect(sentEvents).toHaveLength(2);
    expect(sentEvents[0].metadata.id).toBe('event-2');
    expect(sentEvents[1].metadata.id).toBe('event-3');
  });

  it('should track dropped events by type', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 1,
      batchSize: 10,
    });

    await sink.emit(createLoginSuccessEvent('user1@test.com', 'user-1', {}));
    await sink.emit(createLoginFailedEvent('user2@test.com', 'invalid', {}));
    await sink.emit(createTokenIssuedEvent('user-3', 'client-1', {}));

    const metrics = sink.getMetrics();
    expect(metrics.droppedEvents).toBe(2);
    expect(metrics.droppedEventsByType![AuditEventType.LOGIN_SUCCESS]).toBe(1);
    expect(metrics.droppedEventsByType![AuditEventType.LOGIN_FAILED]).toBe(1);
  });

  it('should log warnings at 80% capacity', async () => {
    const warnSpy = vi.spyOn(console, 'warn');

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 10,
      batchSize: 20,
    });

    // Fill to 80%
    for (let i = 0; i < 8; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('80% capacity')
    );

    warnSpy.mockRestore();
  });

  it('should log critical errors at 90% capacity', async () => {
    const errorSpy = vi.spyOn(console, 'error');

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 10,
      batchSize: 20,
    });

    // Fill to 90%
    for (let i = 0; i < 9; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL')
    );

    errorSpy.mockRestore();
  });

  it('should track high water mark', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 10,
      batchSize: 3,
    });

    // Add 5 events
    for (let i = 0; i < 5; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    let metrics = sink.getMetrics();
    expect(metrics.highWaterMark).toBeGreaterThanOrEqual(2);
    expect(metrics.highWaterMark).toBeLessThanOrEqual(5);

    // Trigger flush
    await sink.flush();

    metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(0);
    expect(metrics.highWaterMark).toBe(0); // Reset after successful flush
  });

  it('should handle critical event drops differently', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 1,
      batchSize: 10,
    });

    // Add critical event
    await sink.emit(createTestEvent('event-1', AuditEventSeverity.CRITICAL));

    // This should drop the critical event
    await sink.emit(createTestEvent('event-2', AuditEventSeverity.INFO));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL: Dropped audit event')
    );

    // Add info event
    await sink.emit(createTestEvent('event-3', AuditEventSeverity.INFO));

    // This should drop an info event
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropped audit event')
    );

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('should requeue events on flush failure with capacity limit', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 3,
      batchSize: 2,
    });

    // Add 2 events
    await sink.emit(createTestEvent('event-1'));
    await sink.emit(createTestEvent('event-2'));

    // This will trigger flush which will fail
    await sink.flush();

    // Events should be requeued
    let metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(2);

    // Add more events to exceed capacity
    await sink.emit(createTestEvent('event-3'));
    await sink.emit(createTestEvent('event-4'));

    // Should not exceed max queue size
    metrics = sink.getMetrics();
    expect(metrics.currentSize).toBeLessThanOrEqual(3);
    expect(metrics.droppedEvents).toBeGreaterThan(0);
  });

  it('should validate configuration', () => {
    const warnSpy = vi.spyOn(console, 'warn');

    // maxQueueSize less than batchSize
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 5,
      batchSize: 10,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('less than batchSize')
    );

    // Should be adjusted to batchSize * 2
    const metrics = sink.getMetrics();
    expect(metrics.maxSize).toBe(20);

    warnSpy.mockRestore();
  });

  it('should include metrics in webhook headers', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 5,
      batchSize: 2,
    });

    // Add events to trigger drops
    for (let i = 0; i < 7; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    // Trigger flush
    await sink.flush();

    expect(fetchSpy).toHaveBeenCalled();
    const headers = fetchSpy.mock.calls[0][1].headers;

    const queueStats = JSON.parse(headers['X-Queue-Stats']);
    expect(queueStats.dropped).toBe(2);
    expect(queueStats.highWaterMark).toBeGreaterThan(0);
  });

  it('should emit overflow audit event every 100 drops', async () => {
    const logSpy = vi.spyOn(console, 'log');

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 1,
      batchSize: 10,
    });

    // Generate 100 drops
    for (let i = 0; i <= 100; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    // Should have logged an overflow event
    const overflowEventLogged = logSpy.mock.calls.some(call => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.event?.eventType === 'audit.queue.overflow';
      } catch {
        return false;
      }
    });

    expect(overflowEventLogged).toBe(true);

    logSpy.mockRestore();
  });

  it('should calculate oldest event age', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 10,
      batchSize: 20,
    });

    const oldEvent = createTestEvent('old');
    oldEvent.timestamp = new Date(Date.now() - 5000).toISOString(); // 5 seconds old

    await sink.emit(oldEvent);
    await sink.emit(createTestEvent('new'));

    const metrics = sink.getMetrics();
    expect(metrics.oldestEventAge).toBeGreaterThanOrEqual(4900);
    expect(metrics.oldestEventAge).toBeLessThanOrEqual(5100);
  });
});

describe('D1Sink Queue Limits', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn(),
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should enforce maximum queue size for D1', async () => {
    const sink = new D1Sink(mockDb, {
      maxQueueSize: 3,
      batchSize: 10,
    });

    // Add 5 events
    for (let i = 1; i <= 5; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    const metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(3);
    expect(metrics.droppedEvents).toBe(2);
  });

  it('should log dropped events to stdout for D1', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const warnSpy = vi.spyOn(console, 'warn');

    const sink = new D1Sink(mockDb, {
      maxQueueSize: 1,
      batchSize: 10,
    });

    await sink.emit(createTestEvent('event-1'));
    await sink.emit(createTestEvent('event-2'));

    // Should log warning about drop
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('D1 queue overflow')
    );

    // Should log the dropped event for recovery
    const droppedEventLogged = logSpy.mock.calls.some(call => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.type === 'audit_event_dropped' && parsed.sink === 'd1';
      } catch {
        return false;
      }
    });

    expect(droppedEventLogged).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('should handle D1 write failures with requeue', async () => {
    mockDb.batch.mockRejectedValueOnce(new Error('D1 error'));

    const sink = new D1Sink(mockDb, {
      maxQueueSize: 5,
      batchSize: 2,
    });

    await sink.emit(createTestEvent('event-1'));
    await sink.emit(createTestEvent('event-2'));

    // Trigger flush (will fail)
    await sink.flush();

    // Events should be requeued
    const metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(2);

    // Add more events
    for (let i = 3; i <= 7; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    // Should not exceed max queue size
    const finalMetrics = sink.getMetrics();
    expect(finalMetrics.currentSize).toBeLessThanOrEqual(5);
  });

  it('should backup failed D1 writes to stdout', async () => {
    const logSpy = vi.spyOn(console, 'log');
    mockDb.batch.mockRejectedValueOnce(new Error('D1 error'));

    const sink = new D1Sink(mockDb, {
      maxQueueSize: 10,
      batchSize: 2,
    });

    await sink.emit(createTestEvent('event-1'));
    await sink.emit(createTestEvent('event-2'));

    await sink.flush();

    // Should log backup events
    const backupLogged = logSpy.mock.calls.some(call => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.type === 'audit_events_backup' && parsed.sink === 'd1';
      } catch {
        return false;
      }
    });

    expect(backupLogged).toBe(true);

    logSpy.mockRestore();
  });

  it('should validate D1 configuration', () => {
    const warnSpy = vi.spyOn(console, 'warn');

    const sink = new D1Sink(mockDb, {
      maxQueueSize: 5,
      batchSize: 10,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('less than batchSize')
    );

    const metrics = sink.getMetrics();
    expect(metrics.maxSize).toBe(20);

    warnSpy.mockRestore();
  });
});

describe('Queue Load Testing', () => {
  it('should handle sustained high load for WebhookSink', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('OK'));
    global.fetch = fetchSpy;

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 100,
      batchSize: 50,
      batchTimeout: 100,
    });

    const eventCount = 500;

    // Simulate high event rate
    for (let i = 0; i < eventCount; i++) {
      await sink.emit(createTestEvent(`load-${i}`));
    }

    const metrics = sink.getMetrics();

    console.log(`Load test results:
      Events submitted: ${eventCount}
      Events in queue: ${metrics.currentSize}
      Events dropped: ${metrics.droppedEvents}
      Drop rate: ${(metrics.droppedEvents / eventCount * 100).toFixed(2)}%
      High water mark: ${metrics.highWaterMark}
      Queue utilization: ${metrics.queueUtilization.toFixed(1)}%
    `);

    expect(metrics.droppedEvents).toBeGreaterThan(0);
    expect(metrics.currentSize).toBeLessThanOrEqual(100);
  });

  it('should recover after endpoint comes back online', async () => {
    let shouldFail = true;
    const fetchSpy = vi.fn().mockImplementation(() => {
      if (shouldFail) {
        return Promise.reject(new Error('Service unavailable'));
      }
      return Promise.resolve(new Response('OK'));
    });
    global.fetch = fetchSpy;

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 50,
      batchSize: 10,
      batchTimeout: 100,
    });

    // Fill queue while endpoint is down
    for (let i = 0; i < 75; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    let metrics = sink.getMetrics();
    expect(metrics.droppedEvents).toBeGreaterThan(0);
    const droppedWhileDown = metrics.droppedEvents;

    // Endpoint comes back online
    shouldFail = false;

    // Trigger successful flush
    await sink.flush();

    metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(0);
    expect(metrics.droppedEvents).toBe(droppedWhileDown); // No new drops
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('should handle burst traffic patterns', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 50,
      batchSize: 20,
      batchTimeout: 500,
    });

    const burstSize = 30;
    const numBursts = 5;
    let totalDropped = 0;

    for (let burst = 0; burst < numBursts; burst++) {
      // Send a burst of events
      for (let i = 0; i < burstSize; i++) {
        await sink.emit(createTestEvent(`burst-${burst}-${i}`));
      }

      const metrics = sink.getMetrics();
      totalDropped = metrics.droppedEvents;

      // Wait between bursts
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const finalMetrics = sink.getMetrics();

    console.log(`Burst test results:
      Total events: ${burstSize * numBursts}
      Events dropped: ${finalMetrics.droppedEvents}
      Final queue size: ${finalMetrics.currentSize}
      High water mark: ${finalMetrics.highWaterMark}
    `);

    expect(finalMetrics.currentSize).toBeLessThanOrEqual(50);
    expect(finalMetrics.droppedEvents).toBeGreaterThan(0);
  });
});

describe('Queue Metrics Aggregation', () => {
  it('should aggregate metrics from multiple sinks', async () => {
    const { AuditEmitter } = await import('./audit-emitter-enhanced');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn(),
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    };

    const emitter = new AuditEmitter();

    const webhookSink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 10,
      batchSize: 20,
    });

    const d1Sink = new D1Sink(mockDb, {
      maxQueueSize: 15,
      batchSize: 20,
    });

    emitter.addSink(webhookSink);
    emitter.addSink(d1Sink);

    // Add events
    for (let i = 0; i < 5; i++) {
      await emitter.emit(createTestEvent(`event-${i}`));
    }

    const metrics = emitter.getMetrics();

    expect(metrics).toHaveProperty('webhook');
    expect(metrics).toHaveProperty('d1');
    expect(metrics.webhook.currentSize).toBe(5);
    expect(metrics.d1.currentSize).toBe(5);
    expect(metrics.webhook.maxSize).toBe(10);
    expect(metrics.d1.maxSize).toBe(15);
  });
});