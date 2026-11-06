/**
 * Unit Tests for Audit Consumer
 *
 * Tests the consumer worker logic using Vitest and Cloudflare Workers test utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditEventMessage } from '@al-ummah-now/openauth/services/audit';
import type { D1Database, MessageBatch } from '@cloudflare/workers-types';

// Mock the audit consumer module
vi.mock('@al-ummah-now/openauth/services/audit-consumer', () => ({
  handleAuditBatch: vi.fn(),
}));

import worker from './index';
import { handleAuditBatch } from '@al-ummah-now/openauth/services/audit-consumer';

describe('Audit Consumer Worker', () => {
  let mockEnv: Env;
  let mockBatch: MessageBatch<AuditEventMessage>;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup mock environment
    mockEnv = {
      AUDIT_DB: {} as D1Database,
    } as Env;

    // Setup mock message batch
    const mockMessage = {
      id: 'msg-1',
      timestamp: new Date(),
      attempts: 1,
      body: {
        version: 1 as const,
        event: {
          token_id: 'tok_123',
          subject: 'user:abc',
          event_type: 'generated' as const,
          client_id: 'client_1',
          timestamp: Date.now(),
        },
        enqueued_at: Date.now(),
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    mockBatch = {
      messages: [mockMessage],
      retryAll: vi.fn(),
      ackAll: vi.fn(),
      queue: 'test-queue',
    };
  });

  describe('queue() handler', () => {
    it('processes audit event messages successfully', async () => {
      // Mock successful processing
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);

      // Verify handleAuditBatch was called with correct arguments
      expect(handleAuditBatch).toHaveBeenCalledWith(
        mockBatch,
        mockEnv.AUDIT_DB,
        'token_usage'
      );
      expect(handleAuditBatch).toHaveBeenCalledTimes(1);
    });

    it('handles batch processing errors gracefully', async () => {
      // Mock processing failure
      const error = new Error('D1 write failed');
      vi.mocked(handleAuditBatch).mockRejectedValueOnce(error);

      // Should not throw - error handling is internal
      await expect(worker.queue(mockBatch, mockEnv)).resolves.toBeUndefined();
    });

    it('processes batch with multiple messages', async () => {
      // Create batch with multiple messages
      const messages = Array.from({ length: 5 }, (_, i) => ({
        id: `msg-${i}`,
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: `tok_${i}`,
            subject: 'user:abc',
            event_type: 'refreshed' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      }));

      mockBatch = {
        messages,
        retryAll: vi.fn(),
        ackAll: vi.fn(),
        queue: 'test-queue',
      };

      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);

      expect(handleAuditBatch).toHaveBeenCalledTimes(1);
    });

    it('processes batch with maximum size (50 messages)', async () => {
      // Create batch with 50 messages (max batch size)
      const messages = Array.from({ length: 50 }, (_, i) => ({
        id: `msg-${i}`,
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: `tok_${i}`,
            subject: 'user:abc',
            event_type: 'generated' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      }));

      mockBatch = {
        messages,
        retryAll: vi.fn(),
        ackAll: vi.fn(),
        queue: 'test-queue',
      };

      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);

      expect(handleAuditBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetch() handler', () => {
    it('returns healthy status on /health endpoint', async () => {
      const request = new Request('http://localhost/health');
      const response = await worker.fetch(request, mockEnv);

      expect(response.status).toBe(200);

      const body = await response.json() as { status: string; service: string; timestamp: number };
      expect(body).toMatchObject({
        status: 'healthy',
        service: 'audit-consumer',
      });
      expect(body.timestamp).toBeGreaterThan(0);
    });

    it('returns metrics on /metrics endpoint', async () => {
      const request = new Request('http://localhost/metrics');
      const response = await worker.fetch(request, mockEnv);

      expect(response.status).toBe(200);

      const body = await response.json() as { service: string };
      expect(body.service).toBe('audit-consumer');
    });

    it('returns default message for root path', async () => {
      const request = new Request('http://localhost/');
      const response = await worker.fetch(request, mockEnv);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/plain');

      const text = await response.text();
      expect(text).toContain('Audit Consumer');
    });

    it('handles unknown paths gracefully', async () => {
      const request = new Request('http://localhost/unknown');
      const response = await worker.fetch(request, mockEnv);

      expect(response.status).toBe(200);
    });
  });

  describe('Event Types', () => {
    it('handles "generated" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: 'tok_123',
            subject: 'user:abc',
            event_type: 'generated' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles "refreshed" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: 'tok_123',
            subject: 'user:abc',
            event_type: 'refreshed' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles "revoked" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: 'tok_123',
            subject: 'user:abc',
            event_type: 'revoked' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles "reused" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: 'tok_123',
            subject: 'user:abc',
            event_type: 'reused' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });
  });

  describe('Optional Fields', () => {
    it('handles events with all optional fields', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: 'tok_123',
            subject: 'user:abc',
            event_type: 'generated' as const,
            client_id: 'client_1',
            ip_address: '192.168.1.1',
            user_agent: 'Mozilla/5.0',
            timestamp: Date.now(),
            metadata: {
              device: 'mobile',
              location: 'US',
            },
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles events without optional fields', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1 as const,
          event: {
            token_id: 'tok_123',
            subject: 'user:abc',
            event_type: 'generated' as const,
            timestamp: Date.now(),
          },
          enqueued_at: Date.now(),
        },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'test-queue' };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });
  });

  describe('Application audit events (app_audit_event)', () => {
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

    function mockDb(batchImpl: () => Promise<unknown>) {
      const bind = vi.fn().mockReturnValue({});
      return {
        prepare: vi.fn().mockReturnValue({ bind }),
        batch: vi.fn().mockImplementation(batchImpl),
        bind,
      };
    }

    it('writes app audit events to audit_events and acks them', async () => {
      const db = mockDb(() => Promise.resolve([]));
      const msg = appMessage('a1');
      const batch = { messages: [msg], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'q' };

      await worker.queue(batch as any, { AUDIT_DB: db } as any);

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_events'));
      expect(db.bind).toHaveBeenCalledWith(
        '2026-01-01T00:00:00.000Z', 'tenant.created', 'info', 'admin-1', '203.0.113.1',
        'test', 'req-1', JSON.stringify({ tenantId: 't1' }), 1, null
      );
      expect(msg.ack).toHaveBeenCalled();
      expect(handleAuditBatch).not.toHaveBeenCalled();
    });

    it('routes mixed batches: app events to audit_events, token events to handleAuditBatch', async () => {
      const db = mockDb(() => Promise.resolve([]));
      const app = appMessage('a1');
      const token = mockBatch.messages[0];
      const batch = { messages: [app, token], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'q' };

      await worker.queue(batch as any, { AUDIT_DB: db } as any);

      expect(app.ack).toHaveBeenCalled();
      expect(handleAuditBatch).toHaveBeenCalledTimes(1);
      const passed = vi.mocked(handleAuditBatch).mock.calls[0][0] as any;
      expect(passed.messages).toEqual([token]);
    });

    it('retries app events when the D1 write fails, then acks after max attempts', async () => {
      const db = mockDb(() => Promise.reject(new Error('D1 down')));
      const fresh = appMessage('a1', 1);
      const exhausted = appMessage('a2', 3);
      const batch = { messages: [fresh, exhausted], retryAll: vi.fn(), ackAll: vi.fn(), queue: 'q' };

      await worker.queue(batch as any, { AUDIT_DB: db } as any);

      expect(fresh.retry).toHaveBeenCalled();
      expect(fresh.ack).not.toHaveBeenCalled();
      expect(exhausted.ack).toHaveBeenCalled();
      expect(exhausted.retry).not.toHaveBeenCalled();
    });
  });
});

