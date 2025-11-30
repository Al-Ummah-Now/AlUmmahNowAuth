/**
 * Enhanced Audit Emitter Tests with Timer Cleanup
 *
 * Comprehensive tests for the audit event emission system with
 * timer management and graceful shutdown capabilities
 */

import { describe, it, expect, beforeEach, afterEach, vi, MockedFunction } from 'vitest';
import {
  AuditEmitter,
  StdoutSink,
  WebhookSink,
  D1Sink,
  initializeAuditEmitter,
  AuditEventSink,
} from './audit-emitter-enhanced';
import {
  AuditEventType,
  AuditEventSeverity,
  createLoginSuccessEvent,
  createLogoutEvent,
  AuditEvent,
} from './audit-events';

// Mock D1Database
function mockD1Database(): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
    }),
    batch: vi.fn().mockResolvedValue([]),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

// Helper to create test events
function createTestEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    eventType: AuditEventType.LOGIN_SUCCESS,
    severity: AuditEventSeverity.INFO,
    userId: 'test-user',
    ipAddress: '127.0.0.1',
    userAgent: 'Test/1.0',
    requestId: 'test-request-id',
    metadata: { test: true },
    success: true,
    ...overrides,
  };
}

describe('Enhanced Audit Emitter', () => {
  let consoleSpy: MockedFunction<any>;
  let consoleErrorSpy: MockedFunction<any>;
  let consoleWarnSpy: MockedFunction<any>;
  let consoleDebugSpy: MockedFunction<any>;
  let fetchSpy: MockedFunction<any>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    global.fetch = fetchSpy;
    vi.clearAllTimers();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    vi.clearAllTimers();
  });

  describe('Timer Cleanup', () => {
    describe('WebhookSink.clearTimers', () => {
      it('should cancel pending timer', async () => {
        vi.useFakeTimers();
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchTimeout: 5000,
          batchSize: 10,
        });

        // Add an event to trigger timer
        await sink.emit(createTestEvent());

        // Verify timer is set (internal state check)
        expect(sink['flushTimer']).not.toBeNull();

        // Clear timers
        await sink.clearTimers();

        // Verify timer is cleared
        expect(sink['flushTimer']).toBeNull();
        expect(sink['timerCleared']).toBe(true);

        vi.useRealTimers();
      });

      it('should flush pending events on clear', async () => {
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 10, // High batch size to prevent auto-flush
        });

        // Add events
        await sink.emit(createTestEvent());
        await sink.emit(createTestEvent());

        expect(fetchSpy).not.toHaveBeenCalled();

        // Clear timers (should flush)
        await sink.clearTimers();

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(sink.hasPendingEvents()).toBe(false);
      });

      it('should prevent new events after clear', async () => {
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
        });

        await sink.clearTimers();

        // Try to emit new event
        await sink.emit(createTestEvent());

        // Event should be rejected
        expect(sink.hasPendingEvents()).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalledWith('[WebhookSink] Rejecting event after timer clear');
      });

      it('should handle concurrent flush and clear', async () => {
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 1, // Immediate flush
        });

        // Start a flush
        const flushPromise = sink.emit(createTestEvent());

        // Immediately clear timers
        const clearPromise = sink.clearTimers();

        // Both should complete without error
        await expect(Promise.all([flushPromise, clearPromise])).resolves.not.toThrow();
      });

      it('should wait for in-progress flush before clearing', async () => {
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 1, // Immediate flush
        });

        // Delay the fetch to simulate slow network
        fetchSpy.mockImplementation(
          () => new Promise(resolve => setTimeout(() => resolve(new Response('OK')), 100))
        );

        // Start a flush
        await sink.emit(createTestEvent());

        // Mark as flushing
        sink['flushing'] = true;

        // Clear timers should wait
        const clearStart = Date.now();
        await sink.clearTimers();
        const clearDuration = Date.now() - clearStart;

        // Should have waited for flush
        expect(clearDuration).toBeGreaterThanOrEqual(90);
      });

      it('should add flush reason header during shutdown', async () => {
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 10,
        });

        // Add events
        await sink.emit(createTestEvent());

        // Clear timers (marks as shutdown)
        await sink.clearTimers();

        // Check headers in fetch call
        expect(fetchSpy).toHaveBeenCalled();
        const [_url, options] = fetchSpy.mock.calls[0];
        expect(options.headers['X-Flush-Reason']).toBe('shutdown');
      });

      it('should fallback to stdout on webhook failure during shutdown', async () => {
        fetchSpy.mockResolvedValue(new Response('Error', { status: 500 }));

        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 10,
        });

        // Add event
        const event = createTestEvent();
        await sink.emit(event);

        // Clear timers (triggers shutdown flush)
        await sink.clearTimers();

        // Should log to stdout as fallback (implementation uses console.debug)
        expect(consoleDebugSpy).toHaveBeenCalledWith(
          expect.stringContaining('audit_events_webhook_failed')
        );
      });
    });

    describe('D1Sink.clearTimers', () => {
      it('should cancel pending timer and flush events', async () => {
        vi.useFakeTimers();
        const db = mockD1Database();
        const sink = new D1Sink(db, {
          batchTimeout: 3000,
          batchSize: 20,
        });

        // Add events
        await sink.emit(createTestEvent());
        await sink.emit(createTestEvent());

        expect(sink['flushTimer']).not.toBeNull();

        // Clear timers
        await sink.clearTimers();

        expect(sink['flushTimer']).toBeNull();
        expect(sink['timerCleared']).toBe(true);
        expect(db.batch).toHaveBeenCalled();

        vi.useRealTimers();
      });

      it('should prevent new events after clear', async () => {
        const db = mockD1Database();
        const sink = new D1Sink(db);

        await sink.clearTimers();

        // Try to emit new event
        await sink.emit(createTestEvent());

        // Event should be rejected
        expect(sink.hasPendingEvents()).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalledWith('[D1Sink] Rejecting event after timer clear');
      });

      it('should fallback to stdout on D1 error during shutdown', async () => {
        const db = mockD1Database();
        (db.batch as any).mockRejectedValue(new Error('D1 error'));

        const sink = new D1Sink(db);

        // Add event
        const event = createTestEvent();
        await sink.emit(event);

        // Clear timers (triggers shutdown flush)
        await sink.clearTimers();

        // Should log to stdout as fallback with JSON backup (implementation uses console.error)
        expect(consoleErrorSpy).toHaveBeenCalled();
        const logCall = consoleErrorSpy.mock.calls.find((call: any[]) =>
          typeof call[0] === 'string' && call[0].includes('audit_events_backup')
        );
        expect(logCall).toBeDefined();
        const logData = JSON.parse(logCall[0]);
        expect(logData.type).toBe('audit_events_backup');
        expect(logData.sink).toBe('d1');
      });
    });

    describe('AuditEmitter.shutdown', () => {
      it('should clear all sink timers', async () => {
        const emitter = new AuditEmitter();

        const sink1 = new WebhookSink({ url: 'https://example.com/1' });
        const sink2 = new D1Sink(mockD1Database());

        emitter.addSink(sink1);
        emitter.addSink(sink2);

        // Add events to create timers
        await emitter.emit(createTestEvent());

        // Shutdown
        await emitter.shutdown();

        expect(sink1['timerCleared']).toBe(true);
        expect(sink2['timerCleared']).toBe(true);
      });

      it('should be idempotent', async () => {
        const emitter = new AuditEmitter();

        // Multiple shutdown calls
        const results = await Promise.all([
          emitter.shutdown(),
          emitter.shutdown(),
          emitter.shutdown(),
        ]);

        // All should resolve without error
        expect(results).toHaveLength(3);
      });

      it('should flush all pending events', async () => {
        const emitter = initializeAuditEmitter({
          webhookUrl: 'https://example.com/audit',
        });

        // Get the webhook sink and modify batch size
        const sink = emitter.getSinks().find(s => s.name === 'webhook') as WebhookSink;
        sink['batchSize'] = 100; // High batch size

        await emitter.emit(createTestEvent());
        await emitter.emit(createTestEvent());

        expect(fetchSpy).not.toHaveBeenCalled();

        // Shutdown should flush
        await emitter.shutdown();

        expect(fetchSpy).toHaveBeenCalled();
      });

      it('should log shutdown metrics', async () => {
        const emitter = new AuditEmitter();
        emitter.addSink(new StdoutSink());

        await emitter.shutdown();

        // Implementation uses console.debug for shutdown metrics
        expect(consoleDebugSpy).toHaveBeenCalledWith(
          expect.stringContaining('audit_emitter_shutdown')
        );
      });

      it('should handle sink errors during shutdown gracefully', async () => {
        const emitter = new AuditEmitter();

        // Create a sink that throws on clearTimers
        const failingSink: AuditEventSink = {
          name: 'failing-sink',
          emit: async () => {},
          clearTimers: async () => {
            throw new Error('Clear failed');
          },
        };

        emitter.addSink(failingSink);

        // Should not throw
        await expect(emitter.shutdown()).resolves.not.toThrow();

        // Should log error with correct format: "[AuditEmitter] Failed to clear timers for {name}:", Error
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[AuditEmitter] Failed to clear timers for failing-sink:',
          expect.any(Error)
        );
      });
    });

    describe('hasPendingEvents', () => {
      it('should correctly report pending events in WebhookSink', async () => {
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 10,
        });

        expect(sink.hasPendingEvents()).toBe(false);

        await sink.emit(createTestEvent());
        expect(sink.hasPendingEvents()).toBe(true);

        await sink.flush();
        expect(sink.hasPendingEvents()).toBe(false);
      });

      it('should correctly report pending events in D1Sink', async () => {
        const sink = new D1Sink(mockD1Database(), {
          batchSize: 10,
        });

        expect(sink.hasPendingEvents()).toBe(false);

        await sink.emit(createTestEvent());
        expect(sink.hasPendingEvents()).toBe(true);

        await sink.flush();
        expect(sink.hasPendingEvents()).toBe(false);
      });

      it('should correctly report pending events in AuditEmitter', async () => {
        const emitter = new AuditEmitter();
        const sink = new WebhookSink({
          url: 'https://example.com/audit',
          batchSize: 10,
        });

        emitter.addSink(sink);

        expect(emitter.hasPendingEvents()).toBe(false);

        await sink.emit(createTestEvent()); // Direct emit to sink
        expect(emitter.hasPendingEvents()).toBe(true);

        await sink.flush();
        expect(emitter.hasPendingEvents()).toBe(false);
      });
    });
  });

  describe('Batch Processing', () => {
    it('should batch events up to batchSize', async () => {
      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        batchSize: 3,
      });

      // Add 2 events (shouldn't trigger flush)
      await sink.emit(createTestEvent());
      await sink.emit(createTestEvent());
      expect(fetchSpy).not.toHaveBeenCalled();

      // Add 3rd event (should trigger flush)
      await sink.emit(createTestEvent());
      expect(fetchSpy).toHaveBeenCalledOnce();

      // Check batch size in request
      const [, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.events).toHaveLength(3);
    });

    it('should flush on timeout', async () => {
      vi.useFakeTimers();

      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        batchSize: 10,
        batchTimeout: 1000,
      });

      // Add event
      await sink.emit(createTestEvent());
      expect(fetchSpy).not.toHaveBeenCalled();

      // Advance time to trigger timeout
      vi.advanceTimersByTime(1000);

      // Wait for flush to complete
      await vi.runAllTimersAsync();

      expect(fetchSpy).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('should include batch size in headers', async () => {
      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        batchSize: 2,
      });

      await sink.emit(createTestEvent());
      await sink.emit(createTestEvent());

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers['X-Batch-Size']).toBe('2');
    });
  });

  describe('ExecutionContext Integration', () => {
    it('should propagate context to sinks', () => {
      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const emitter = new AuditEmitter();
      const sink = new WebhookSink({ url: 'https://example.com' });

      emitter.addSink(sink);
      emitter.setContext(ctx);

      expect(sink['ctx']).toBe(ctx);
    });

    it('should use waitUntil for async operations', async () => {
      const waitUntilSpy = vi.fn();
      const ctx = {
        waitUntil: waitUntilSpy,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const emitter = new AuditEmitter();
      emitter.setContext(ctx);
      emitter.addSink(new StdoutSink());

      await emitter.emit(createTestEvent());

      expect(waitUntilSpy).toHaveBeenCalled();
    });
  });

  describe('Security', () => {
    it('should validate webhook secret strength', () => {
      new WebhookSink({
        url: 'https://example.com',
        secret: 'short',
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Webhook secret should be at least 32 characters for security'
      );
    });

    it('should generate correct HMAC signature', async () => {
      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        secret: 'this-is-a-very-long-secret-key-for-testing-purposes',
        batchSize: 1,
      });

      await sink.emit(createTestEvent());

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers['X-Audit-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    });
  });

  describe('Error Handling', () => {
    it('should continue emitting to other sinks on failure', async () => {
      const emitter = new AuditEmitter();

      const failingSink: AuditEventSink = {
        name: 'failing',
        emit: async () => {
          throw new Error('Emit failed');
        },
      };

      const workingSink = new StdoutSink();

      emitter.addSink(failingSink);
      emitter.addSink(workingSink);

      await emitter.emit(createTestEvent());

      // Working sink should have received event
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('audit_event')
      );

      // Error should be logged with correct format: "Sink {name} failed to emit event:", Error
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Sink failing failed to emit event:',
        expect.any(Error)
      );
    });

    it('should handle network errors gracefully', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));

      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        batchSize: 1,
      });

      await sink.emit(createTestEvent());

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[WebhookSink] Delivery error:',
        expect.any(Error)
      );
    });

    it('should handle D1 batch errors', async () => {
      const db = mockD1Database();
      (db.batch as any).mockRejectedValue(new Error('D1 batch error'));

      const sink = new D1Sink(db, { batchSize: 1 });

      await sink.emit(createTestEvent());

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[D1Sink] Storage error:',
        expect.any(Error)
      );

      // Should fallback to stdout with JSON backup (implementation uses console.error)
      const logCall = consoleErrorSpy.mock.calls.find((call: any[]) =>
        typeof call[0] === 'string' && call[0].includes('audit_events_backup')
      );
      expect(logCall).toBeDefined();
      const logData = JSON.parse(logCall[0]);
      expect(logData.type).toBe('audit_events_backup');
      expect(logData.sink).toBe('d1');
    });
  });

  describe('Integration Tests', () => {
    it('should handle complete lifecycle', async () => {
      // Initialize emitter
      const emitter = initializeAuditEmitter({
        webhookUrl: 'https://example.com/audit',
        webhookSecret: 'test-secret-key-that-is-long-enough-for-security',
        db: mockD1Database(),
      });

      // Emit events
      await emitter.emit(createLoginSuccessEvent('user@test.com', 'user-123', {}));
      await emitter.emit(createLogoutEvent('user-123', {}));

      // Check pending
      expect(emitter.hasPendingEvents()).toBe(true);

      // Flush
      await emitter.flush();
      expect(emitter.hasPendingEvents()).toBe(false);

      // Shutdown
      await emitter.shutdown();

      // Verify cleanup
      const sinks = emitter.getSinks();
      for (const sink of sinks) {
        if ('timerCleared' in sink) {
          expect((sink as any).timerCleared).toBe(true);
        }
      }
    });

    it('should handle rapid event emission', async () => {
      const emitter = initializeAuditEmitter({
        webhookUrl: 'https://example.com/audit',
      });

      // Emit many events rapidly
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          emitter.emit(createTestEvent({ userId: `user-${i}` }))
        );
      }

      await Promise.all(promises);

      // Should have batched the requests
      expect(fetchSpy.mock.calls.length).toBeLessThan(100);

      // Shutdown to flush remaining
      await emitter.shutdown();
    });
  });
});