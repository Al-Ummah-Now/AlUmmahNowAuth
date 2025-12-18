/**
 * Edge Case Tests for Audit Logging System
 *
 * Tests edge cases, error scenarios, and boundary conditions
 * for the current audit logging implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAuditEvent,
  createLoginSuccessEvent,
  createLoginFailedEvent,
  createLogoutEvent,
  AuditEventType,
  AuditEventSeverity,
} from '../audit-events';
import {
  StdoutSink,
  WebhookSink,
  D1Sink,
  AuditEmitter,
} from '../audit-emitter';

describe('Audit Events - Edge Cases', () => {
  describe('Metadata Size Validation', () => {
    it('should reject metadata larger than 10MB', () => {
      // Create large metadata (11MB)
      const largeString = 'x'.repeat(11 * 1024 * 1024);

      expect(() => {
        createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
          severity: AuditEventSeverity.INFO,
          success: true,
          metadata: { data: largeString },
        });
      }).toThrow(/Event metadata too large/);
    });

    it('should accept metadata at 10MB limit', () => {
      // Create metadata just under 10MB (accounting for JSON overhead)
      const largeString = 'x'.repeat(10 * 1024 * 1024 - 1000);

      expect(() => {
        createAuditEvent(AuditEventType.LOGIN_SUCCESS, {
          severity: AuditEventSeverity.INFO,
          success: true,
          metadata: { data: largeString },
        });
      }).not.toThrow();
    });

    it('should handle empty metadata', () => {
      const event = createAuditEvent(AuditEventType.LOGOUT, {
        severity: AuditEventSeverity.INFO,
        success: true,
        metadata: {},
      });

      expect(event.metadata).toEqual({});
    });

    it('should handle null values in metadata', () => {
      const event = createAuditEvent(AuditEventType.LOGIN_FAILED, {
        severity: AuditEventSeverity.WARNING,
        success: false,
        metadata: {
          nullField: null,
          undefinedField: undefined,
          emptyString: '',
        },
      });

      expect(event.metadata.nullField).toBeNull();
      expect(event.metadata.undefinedField).toBeUndefined();
      expect(event.metadata.emptyString).toBe('');
    });
  });

  describe('errorMessage Consistency', () => {
    it('should set errorMessage to null for successful events', () => {
      const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

      expect(event.errorMessage).toBeNull();
      expect(event.errorMessage).not.toBeUndefined();
    });

    it('should set errorMessage to null when not provided', () => {
      const event = createAuditEvent(AuditEventType.LOGOUT, {
        severity: AuditEventSeverity.INFO,
        success: true,
      });

      expect(event.errorMessage).toBeNull();
    });

    it('should preserve errorMessage when provided', () => {
      const errorMsg = 'Authentication failed';
      const event = createLoginFailedEvent('user@example.com', errorMsg, {});

      expect(event.errorMessage).toBe(errorMsg);
    });
  });

  describe('Timestamp Generation', () => {
    it('should generate valid ISO 8601 timestamps', () => {
      const event = createLogoutEvent('user-123', {});

      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(() => new Date(event.timestamp)).not.toThrow();
    });

    it('should generate unique timestamps for rapid events', async () => {
      const timestamps = new Set();

      for (let i = 0; i < 100; i++) {
        const event = createLogoutEvent(`user-${i}`, {});
        timestamps.add(event.timestamp);
        // Add tiny delay to allow timestamp changes
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      // Should have multiple unique timestamps with delays
      expect(timestamps.size).toBeGreaterThan(10);
    });
  });
});

describe('StdoutSink - Edge Cases', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should handle circular references in metadata', async () => {
    const sink = new StdoutSink();

    // Create circular reference
    const circularObj: any = { name: 'test' };
    circularObj.self = circularObj;

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});
    event.metadata = circularObj;

    await sink.emit(event);

    // Should fallback to sanitized output
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to stringify audit event:',
      expect.any(TypeError)
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Circular or Invalid JSON]')
    );
  });

  it('should handle very large events', async () => {
    const sink = new StdoutSink();

    // Create event with large metadata (within 10MB limit)
    const largeMetadata = {
      data: 'x'.repeat(1024 * 1024), // 1MB
      items: Array(1000).fill({ id: 1, name: 'test', value: 'data' }),
    };

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});
    event.metadata = largeMetadata;

    await expect(sink.emit(event)).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('should handle special characters in event data', async () => {
    const sink = new StdoutSink();

    const event = createLoginFailedEvent(
      'user@example.com',
      'Invalid password: \n\t\r\b\f\\\'"',
      {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0 <script>alert("xss")</script>',
      }
    );

    await sink.emit(event);

    const logged = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logged);

    // Verify special characters are preserved
    expect(logged).toContain('\\n');
    expect(logged).toContain('\\t');
    // Verify userAgent is properly included (JSON.stringify keeps special chars as-is)
    expect(parsed.event.userAgent).toContain('<script>');
    // But in the raw string, it should be escaped or contained within quotes
    expect(typeof parsed.event.userAgent).toBe('string');
  });
});

describe('WebhookSink - Edge Cases', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle HTTP 500 errors gracefully', async () => {
    fetchSpy.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      batchSize: 1,
    });

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

    await expect(sink.emit(event)).resolves.not.toThrow();
    await expect(sink.flush()).resolves.not.toThrow();
  });

  it('should handle HTTP 404 errors gracefully', async () => {
    fetchSpy.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const sink = new WebhookSink({
      url: 'https://example.com/nonexistent',
      batchSize: 1,
    });

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

    await expect(sink.emit(event)).resolves.not.toThrow();
    await expect(sink.flush()).resolves.not.toThrow();
  });

  it('should handle network timeouts', async () => {
    // Simulate timeout by rejecting with AbortError after signal
    fetchSpy.mockImplementation(
      (_url: string, options: any) => {
        return new Promise((resolve, reject) => {
          // Listen for abort signal
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
          // Otherwise resolve after 20 seconds (will be aborted before then)
          setTimeout(() => resolve(new Response('OK')), 20000);
        });
      }
    );

    const sink = new WebhookSink({
      url: 'https://slow.example.com/webhook',
      batchSize: 1,
      maxRetries: 0, // Disable retries for this test to avoid timeout
    });

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});
    await sink.emit(event);

    // Should abort after 10 seconds without retry
    const start = Date.now();
    await sink.flush();
    const duration = Date.now() - start;

    // Should complete within 12 seconds (10s timeout + 2s margin, no retries)
    expect(duration).toBeLessThan(12000);
  }, 15000); // Set test timeout to 15 seconds

  it('should handle fetch throwing errors', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      batchSize: 1,
    });

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

    await expect(sink.emit(event)).resolves.not.toThrow();
    await expect(sink.flush()).resolves.not.toThrow();
  });

  it('should handle invalid webhook URLs', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Invalid URL'));

    const sink = new WebhookSink({
      url: 'not-a-valid-url',
      batchSize: 1,
    });

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

    await expect(sink.emit(event)).resolves.not.toThrow();
    await expect(sink.flush()).resolves.not.toThrow();
  });

  it('should handle empty event queue flush', async () => {
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
    });

    // Flush without any events
    await expect(sink.flush()).resolves.not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should handle HMAC signature with empty secret', async () => {
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      secret: '',
      batchSize: 1,
    });

    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});
    await sink.emit(event);
    await sink.flush();

    expect(fetchSpy).toHaveBeenCalled();
    const [, options] = fetchSpy.mock.calls[0];
    // Empty secret should not add signature header
    expect(options.headers['X-Audit-Signature']).toBeUndefined();
  });

  it('should batch multiple events correctly', async () => {
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      batchSize: 5,
    });

    // Add 5 events
    for (let i = 0; i < 5; i++) {
      await sink.emit(createLoginSuccessEvent(`user${i}@example.com`, `user-${i}`, {}));
    }

    // Should automatically flush after 5 events
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.events).toHaveLength(5);
  });
});

describe('D1Sink - Edge Cases', () => {
  it('should handle database constraint violations', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      batch: vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed')),
    };

    const sink = new D1Sink(mockDb as any, { batchSize: 1 });
    const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

    await expect(sink.emit(event)).resolves.not.toThrow();
    await expect(sink.flush()).resolves.not.toThrow();
  });

  it('should handle partial batch failures', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      batch: vi.fn().mockResolvedValue([
        { success: true },
        { success: false, error: 'Constraint violation' },
        { success: true },
      ]),
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sink = new D1Sink(mockDb as any, { batchSize: 3 });

    for (let i = 0; i < 3; i++) {
      await sink.emit(createLoginSuccessEvent(`user${i}@example.com`, `user-${i}`, {}));
    }

    await sink.flush();

    // Should log the failed statement
    expect(consoleSpy).toHaveBeenCalledWith(
      'D1 batch statement 1 failed:',
      'Constraint violation'
    );

    // Should backup failed event to stdout (implementation uses console.error)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('audit_event_backup')
    );

    consoleSpy.mockRestore();
  });

  it('should handle empty event queue flush', async () => {
    const mockDb = {
      prepare: vi.fn(),
      batch: vi.fn(),
    };

    const sink = new D1Sink(mockDb as any);

    await expect(sink.flush()).resolves.not.toThrow();
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('should handle large batch sizes', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      batch: vi.fn().mockResolvedValue(
        Array(100).fill({ success: true })
      ),
    };

    const sink = new D1Sink(mockDb as any, { batchSize: 100 });

    // Add 100 events
    for (let i = 0; i < 100; i++) {
      await sink.emit(createLoginSuccessEvent(`user${i}@example.com`, `user-${i}`, {}));
    }

    // Should flush automatically
    expect(mockDb.batch).toHaveBeenCalledOnce();
    expect(mockDb.batch.mock.calls[0][0]).toHaveLength(100);
  });

  it('should handle null values in event fields', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      batch: vi.fn().mockResolvedValue([{ success: true }]),
    };

    const sink = new D1Sink(mockDb as any, { batchSize: 1 });

    const event = createAuditEvent(AuditEventType.LOGIN_FAILED, {
      severity: AuditEventSeverity.WARNING,
      success: false,
      userId: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
      errorMessage: null,
    });

    await sink.emit(event);
    await sink.flush();

    // Check that bind was called with null values
    const bindCall = mockDb.bind.mock.calls[0];
    expect(bindCall).toContain(null);
  });
});

describe('AuditEmitter - Edge Cases', () => {
  it('should handle sink failures gracefully', async () => {
    const failingSink = {
      name: 'failing-sink',
      emit: vi.fn().mockRejectedValue(new Error('Sink failed')),
    };

    const successSink = {
      name: 'success-sink',
      emit: vi.fn().mockResolvedValue(undefined),
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const emitter = new AuditEmitter();
    emitter.addSink(failingSink);
    emitter.addSink(successSink);

    const event = createLogoutEvent('user-123', {});
    await emitter.emit(event);

    // Both sinks should be called despite failure
    expect(failingSink.emit).toHaveBeenCalled();
    expect(successSink.emit).toHaveBeenCalled();

    // Error should be logged
    expect(consoleSpy).toHaveBeenCalledWith(
      'Sink failing-sink failed to emit event:',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it('should handle no sinks configured', async () => {
    const emitter = new AuditEmitter();
    const event = createLogoutEvent('user-123', {});

    await expect(emitter.emit(event)).resolves.not.toThrow();
  });

  it('should return sink list correctly', () => {
    const emitter = new AuditEmitter();
    const sink1 = new StdoutSink();
    const sink2 = new StdoutSink();

    emitter.addSink(sink1);
    emitter.addSink(sink2);

    const sinks = emitter.getSinks();
    expect(sinks).toHaveLength(2);
    expect(sinks[0]).toBe(sink1);
    expect(sinks[1]).toBe(sink2);
  });

  it('should flush all sinks', async () => {
    const sink1 = {
      name: 'sink1',
      emit: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const sink2 = {
      name: 'sink2',
      emit: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const emitter = new AuditEmitter();
    emitter.addSink(sink1);
    emitter.addSink(sink2);

    await emitter.flush();

    expect(sink1.flush).toHaveBeenCalled();
    expect(sink2.flush).toHaveBeenCalled();
  });

  it('should handle flush failures gracefully', async () => {
    const failingSink = {
      name: 'failing-sink',
      emit: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error('Flush failed')),
    };

    const successSink = {
      name: 'success-sink',
      emit: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const emitter = new AuditEmitter();
    emitter.addSink(failingSink);
    emitter.addSink(successSink);

    await expect(emitter.flush()).resolves.not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      'Sink failing-sink failed to flush:',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});

describe('Concurrency - Basic Tests', () => {
  it('should handle concurrent emit calls', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    global.fetch = fetchSpy;

    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      batchSize: 50,
    });

    // Emit 50 events concurrently
    const promises = Array.from({ length: 50 }, (_, i) =>
      sink.emit(createLoginSuccessEvent(`user${i}@example.com`, `user-${i}`, {}))
    );

    await Promise.all(promises);

    // Should trigger batch flush automatically
    expect(fetchSpy).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('should handle rapid sequential emit calls', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      batch: vi.fn().mockResolvedValue(
        Array(20).fill({ success: true })
      ),
    };

    const sink = new D1Sink(mockDb as any, { batchSize: 20 });

    // Emit 20 events rapidly
    for (let i = 0; i < 20; i++) {
      await sink.emit(createLoginSuccessEvent(`user${i}@example.com`, `user-${i}`, {}));
    }

    // Should trigger batch flush automatically
    expect(mockDb.batch).toHaveBeenCalledOnce();
  });
});
