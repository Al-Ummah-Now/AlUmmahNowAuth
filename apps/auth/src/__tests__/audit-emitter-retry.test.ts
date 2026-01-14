import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebhookSink } from '../audit-emitter';
import { AuditEvent } from '../audit-events';

// Mock fetch
global.fetch = vi.fn();

describe('WebhookSink Retry Logic', () => {
  let webhookSink: WebhookSink;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock D1 database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { last_row_id: 1, changes: 1 }
          })
        })
      })
    };

    webhookSink = new WebhookSink({
      url: 'https://example.com/webhook',
      secret: 'test-secret-at-least-32-characters-long',
      db: mockDb,
      maxRetries: 3,
      retryDelays: [100, 200, 400], // Short delays for testing
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createTestEvent = (): AuditEvent => ({
    timestamp: new Date().toISOString(),
    eventType: 'auth.login.success',
    severity: 'info',
    userId: 'user123',
    ipAddress: '192.168.1.1',
    userAgent: 'test-agent',
    requestId: 'req123',
    metadata: {},
    success: true,
  });

  it('should succeed on first attempt', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write

    const metrics = webhookSink.getMetrics();
    expect(metrics.successfulDeliveries).toBe(1);
    expect(metrics.failedDeliveries).toBe(0);
    expect(metrics.dlqWrites).toBe(0);
  });

  it('should retry on 500 error and succeed', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write

    const metrics = webhookSink.getMetrics();
    expect(metrics.successfulDeliveries).toBe(1);
    expect(metrics.failedDeliveries).toBe(0);
  });

  it('should not retry on 400 error', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(1); // No retry
    expect(mockDb.prepare).toHaveBeenCalled(); // Written to DLQ

    const metrics = webhookSink.getMetrics();
    expect(metrics.successfulDeliveries).toBe(0);
    expect(metrics.failedDeliveries).toBe(1);
    expect(metrics.dlqWrites).toBe(1);
  });

  it('should write to DLQ after exhausting retries', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Connection refused'));

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(3); // All retries exhausted
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_dlq')
    );

    const metrics = webhookSink.getMetrics();
    expect(metrics.successfulDeliveries).toBe(0);
    expect(metrics.failedDeliveries).toBe(1);
    expect(metrics.dlqWrites).toBe(1);
  });

  it('should handle timeout with retry', async () => {
    const abortError = new Error('AbortError');
    abortError.name = 'AbortError';

    (global.fetch as any)
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write

    const metrics = webhookSink.getMetrics();
    expect(metrics.successfulDeliveries).toBe(1);
    expect(metrics.failedDeliveries).toBe(0);
  });

  it('should apply jitter to retry delays', async () => {
    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      retryDelays: [1000],
    });

    // Test multiple calls to verify jitter
    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const delay = (sink as any).getRetryDelay(1);
      delays.add(delay);
      expect(delay).toBeGreaterThanOrEqual(800);  // -20% jitter
      expect(delay).toBeLessThanOrEqual(1200);    // +20% jitter
    }

    // Should have different values due to jitter
    expect(delays.size).toBeGreaterThan(1);
  });

  it('should retry multiple times with exponential backoff', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write

    const metrics = webhookSink.getMetrics();
    expect(metrics.successfulDeliveries).toBe(1);
    expect(metrics.failedDeliveries).toBe(0);
  });

  it('should maintain HMAC signature on all retry attempts', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const event = createTestEvent();
    await webhookSink.emit(event);
    await webhookSink.flush();

    // Verify both attempts had the signature header
    const calls = (global.fetch as any).mock.calls;
    expect(calls).toHaveLength(2);

    calls.forEach((call: any) => {
      const options = call[1];
      expect(options.headers['X-Audit-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    });
  });

  it('should batch multiple events', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const events = [createTestEvent(), createTestEvent(), createTestEvent()];
    for (const event of events) {
      await webhookSink.emit(event);
    }
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Verify all events were sent in one batch
    const call = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.events).toHaveLength(3);
  });

  it('should handle DLQ write failure gracefully', async () => {
    // Make webhook fail
    (global.fetch as any).mockRejectedValue(new Error('Connection refused'));

    // Make DLQ write fail
    mockDb.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('Database error'))
      })
    });

    const event = createTestEvent();
    await webhookSink.emit(event);

    // Should not throw error
    await expect(webhookSink.flush()).resolves.not.toThrow();

    const metrics = webhookSink.getMetrics();
    expect(metrics.failedDeliveries).toBe(1);
    expect(metrics.dlqWrites).toBe(0); // DLQ write failed
  });

  it('should work without DLQ database', async () => {
    const sinkWithoutDb = new WebhookSink({
      url: 'https://example.com/webhook',
      secret: 'test-secret-at-least-32-characters-long',
      // No db provided
    });

    (global.fetch as any).mockRejectedValue(new Error('Connection refused'));

    const event = createTestEvent();
    await sinkWithoutDb.emit(event);

    // Should not throw error, but log warning
    await expect(sinkWithoutDb.flush()).resolves.not.toThrow();

    const metrics = sinkWithoutDb.getMetrics();
    expect(metrics.failedDeliveries).toBe(1);
    expect(metrics.dlqWrites).toBe(0); // No DLQ available
  });
});

describe('WebhookSink Retry Configuration', () => {
  it('should use custom retry delays', async () => {
    const customDelays = [500, 1000, 2000];
    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      retryDelays: customDelays,
    });

    for (let i = 0; i < customDelays.length; i++) {
      const delay = (sink as any).getRetryDelay(i + 1);
      // Should be within jitter range (±20%)
      expect(delay).toBeGreaterThanOrEqual(customDelays[i] * 0.8);
      expect(delay).toBeLessThanOrEqual(customDelays[i] * 1.2);
    }
  });

  it('should use last delay for attempts beyond configured delays', async () => {
    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      retryDelays: [1000, 2000],
      maxRetries: 5,
    });

    const delay3 = (sink as any).getRetryDelay(3);
    const delay4 = (sink as any).getRetryDelay(4);
    const delay5 = (sink as any).getRetryDelay(5);

    // All should use the last configured delay (2000ms) with jitter
    [delay3, delay4, delay5].forEach(delay => {
      expect(delay).toBeGreaterThanOrEqual(1600); // 2000 * 0.8
      expect(delay).toBeLessThanOrEqual(2400);    // 2000 * 1.2
    });
  });
});
