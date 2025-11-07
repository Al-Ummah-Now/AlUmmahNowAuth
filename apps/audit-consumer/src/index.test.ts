/**
 * Unit Tests for Audit Consumer
 *
 * Tests the consumer worker logic using Vitest and Cloudflare Workers test utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditEventMessage } from '@openauthjs/openauth/services/audit';

// Mock the OpenAuth audit consumer module
vi.mock('@openauthjs/openauth/services/audit-consumer', () => ({
  handleAuditBatch: vi.fn(),
}));

import worker from './index';
import { handleAuditBatch } from '@openauthjs/openauth/services/audit-consumer';

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
      body: {
        version: 1,
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
        body: {
          version: 1,
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
        body: {
          version: 1,
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

      const body = await response.json();
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

      const body = await response.json();
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
        body: {
          version: 1,
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

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles "refreshed" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        body: {
          version: 1,
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

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles "revoked" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        body: {
          version: 1,
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

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles "reused" event type', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        body: {
          version: 1,
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

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() };
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
        body: {
          version: 1,
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

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });

    it('handles events without optional fields', async () => {
      const message = {
        id: 'msg-1',
        timestamp: new Date(),
        body: {
          version: 1,
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

      mockBatch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() };
      vi.mocked(handleAuditBatch).mockResolvedValueOnce(undefined);

      await worker.queue(mockBatch, mockEnv);
      expect(handleAuditBatch).toHaveBeenCalled();
    });
  });
});
