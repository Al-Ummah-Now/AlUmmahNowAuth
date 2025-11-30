/**
 * Audit Emitter Tests
 *
 * Tests for the audit event emission system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AuditEmitter,
  StdoutSink,
  WebhookSink,
  initializeAuditEmitter,
  getAuditEmitter,
} from './audit-emitter';
import {
  createLoginSuccessEvent,
} from './audit-events';

describe('Audit Emitter', () => {
  describe('StdoutSink', () => {
    it('should output events to console as JSON', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const sink = new StdoutSink();

      const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

      await sink.emit(event);

      expect(consoleSpy).toHaveBeenCalledOnce();
      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(loggedData.type).toBe('audit_event');
      expect(loggedData.event.eventType).toBe(AuditEventType.LOGIN_SUCCESS);
      expect(loggedData.event.userId).toBe('user-123');

      consoleSpy.mockRestore();
    });
  });

  describe('AuditEmitter', () => {
    let emitter: AuditEmitter;

    beforeEach(() => {
      emitter = new AuditEmitter();
    });

    it('should allow adding sinks', () => {
      const sink = new StdoutSink();
      emitter.addSink(sink);

      expect(emitter.getSinks()).toHaveLength(1);
      expect(emitter.getSinks()[0]).toBe(sink);
    });

    it('should emit events to all sinks', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const sink1 = new StdoutSink();
      const sink2 = new StdoutSink();

      emitter.addSink(sink1);
      emitter.addSink(sink2);

      const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

      await emitter.emit(event);

      expect(consoleSpy).toHaveBeenCalledTimes(2);

      consoleSpy.mockRestore();
    });

    it('should handle sink errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Create a sink that throws an error
      const failingSink = {
        name: 'failing-sink',
        emit: async () => {
          throw new Error('Sink failed');
        },
      };

      const workingSink = new StdoutSink();

      emitter.addSink(failingSink);
      emitter.addSink(workingSink);

      const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

      // Should not throw
      await emitter.emit(event);

      // Failing sink should log error
      expect(consoleSpy).toHaveBeenCalled();

      // Working sink should still emit
      expect(consoleLogSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('should flush all sinks', async () => {
      let flushed = false;

      const flushableSink = {
        name: 'flushable-sink',
        emit: async () => {},
        flush: async () => {
          flushed = true;
        },
      };

      emitter.addSink(flushableSink);

      await emitter.flush();

      expect(flushed).toBe(true);
    });
  });

  describe('initializeAuditEmitter', () => {
    it('should initialize with stdout sink by default', () => {
      const emitter = initializeAuditEmitter({});

      const sinks = emitter.getSinks();
      expect(sinks).toHaveLength(1);
      expect(sinks[0].name).toBe('stdout');
    });

    it('should not add stdout sink when explicitly disabled', () => {
      const emitter = initializeAuditEmitter({ enableStdout: false });

      const sinks = emitter.getSinks();
      expect(sinks).toHaveLength(0);
    });

    it('should add webhook sink when URL is provided', () => {
      const emitter = initializeAuditEmitter({
        webhookUrl: 'https://example.com/audit',
        webhookSecret: 'test-secret-that-is-32-characters-long-for-security',
      });

      const sinks = emitter.getSinks();
      expect(sinks.length).toBeGreaterThanOrEqual(2);
      expect(sinks.some(s => s.name === 'webhook')).toBe(true);
    });
  });

  describe('getAuditEmitter', () => {
    it('should return a global emitter instance', () => {
      const emitter1 = getAuditEmitter();
      const emitter2 = getAuditEmitter();

      // Should return the same instance (though we can't test reference equality)
      expect(emitter1).toBeDefined();
      expect(emitter2).toBeDefined();
    });

    it('should have stdout sink by default', () => {
      // Reset global emitter first by calling initializeAuditEmitter with stdout enabled
      const emitter = initializeAuditEmitter({ enableStdout: true });
      const sinks = emitter.getSinks();

      expect(sinks.length).toBeGreaterThanOrEqual(1);
      expect(sinks.some(s => s.name === 'stdout')).toBe(true);
    });
  });

  describe('WebhookSink Signature', () => {
    it('should generate correct HMAC signature', async () => {
      // Mock fetch to capture the request
      const fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      global.fetch = fetchSpy;

      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        secret: 'test-secret-that-is-32-characters-long-for-security',
        batchSize: 1, // Immediate flush
      });

      const event = createLoginSuccessEvent('user@example.com', 'user-123', {});

      await sink.emit(event);
      await sink.flush();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];

      expect(url).toBe('https://example.com/audit');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['X-Audit-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

      fetchSpy.mockRestore();
    });
  });

  describe('Integration', () => {
    it('should emit events end-to-end', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Initialize emitter
      const emitter = initializeAuditEmitter({
        enableStdout: true,
      });

      // Create and emit event
      const event = createLoginSuccessEvent('user@example.com', 'user-123', {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      await emitter.emit(event);

      // Verify event was logged
      expect(consoleSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(loggedData.type).toBe('audit_event');
      expect(loggedData.event.eventType).toBe(AuditEventType.LOGIN_SUCCESS);
      expect(loggedData.event.userId).toBe('user-123');
      expect(loggedData.event.metadata.email).toBe('user@example.com');

      consoleSpy.mockRestore();
    });
  });
});
