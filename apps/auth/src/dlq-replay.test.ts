import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DLQReplayService } from './dlq-replay';
import { AuditEvent } from './audit-events';

describe('DLQ Replay Service', () => {
  let mockDb: any;
  let replayService: DLQReplayService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock D1 database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { last_row_id: 1, changes: 1 }
          }),
          all: vi.fn().mockResolvedValue({
            results: []
          }),
          first: vi.fn().mockResolvedValue(null),
        })
      })
    };

    replayService = new DLQReplayService(mockDb, 'test-secret');
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

  describe('getQueuedEvents', () => {
    it('should list DLQ entries with pagination', async () => {
      const mockEntries = [
        {
          id: 1,
          events: JSON.stringify([createTestEvent()]),
          webhook_url: 'https://example.com/webhook',
          error: 'Connection failed',
          timestamp: new Date().toISOString(),
          retry_count: 3,
          status: 'pending',
          replayed_at: null,
          created_at: new Date().toISOString(),
        },
        {
          id: 2,
          events: JSON.stringify([createTestEvent()]),
          webhook_url: 'https://example.com/webhook',
          error: 'Timeout',
          timestamp: new Date().toISOString(),
          retry_count: 3,
          status: 'pending',
          replayed_at: null,
          created_at: new Date().toISOString(),
        },
      ];

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 2 }),
        })
      });

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: mockEntries }),
        })
      });

      const result = await replayService.getQueuedEvents({
        limit: 10,
        offset: 0,
      });

      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.entries[0].id).toBe(1);
      expect(result.entries[0].status).toBe('pending');
    });

    it('should filter by status', async () => {
      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 0 }),
        })
      });

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        })
      });

      await replayService.getQueuedEvents({
        status: 'failed',
      });

      // Verify status filter was applied in query
      const firstCall = mockDb.prepare.mock.calls[0][0];
      expect(firstCall).toContain('status = ?');
    });

    it('should filter by max age', async () => {
      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 0 }),
        })
      });

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        })
      });

      await replayService.getQueuedEvents({
        maxAge: 24, // 24 hours
      });

      // Verify max age filter was applied in query
      const firstCall = mockDb.prepare.mock.calls[0][0];
      expect(firstCall).toContain('timestamp >= ?');
    });
  });

  describe('replayFailedEvents', () => {
    it('should return empty result when no entries found', async () => {
      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 0 }),
        })
      });

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        })
      });

      const result = await replayService.replayFailedEvents();

      expect(result.totalEntries).toBe(0);
      expect(result.successfulReplays).toBe(0);
      expect(result.failedReplays).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should perform dry run without actual delivery', async () => {
      const mockEntry = {
        id: 1,
        events: JSON.stringify([createTestEvent()]),
        webhook_url: 'https://example.com/webhook',
        error: 'Connection failed',
        timestamp: new Date().toISOString(),
        retry_count: 3,
        status: 'pending',
        replayed_at: null,
        created_at: new Date().toISOString(),
      };

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 1 }),
        })
      });

      mockDb.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [mockEntry] }),
        })
      });

      const result = await replayService.replayFailedEvents({
        dryRun: true,
      });

      expect(result.totalEntries).toBe(1);
      expect(result.successfulReplays).toBe(1);
      expect(result.failedReplays).toBe(0);

      // Verify no UPDATE queries were executed (dry run)
      const updateCalls = mockDb.prepare.mock.calls.filter((call: any[]) =>
        call[0].includes('UPDATE')
      );
      expect(updateCalls).toHaveLength(0);
    });
  });

  describe('cleanup', () => {
    it('should delete old DLQ entries', async () => {
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { changes: 5 }
          })
        })
      });

      const result = await replayService.cleanup({
        maxAge: 30, // 30 days
      });

      expect(result.deleted).toBe(5);

      // Verify DELETE query was executed
      const deleteCall = mockDb.prepare.mock.calls[0][0];
      expect(deleteCall).toContain('DELETE FROM webhook_dlq');
      expect(deleteCall).toContain('created_at < ?');
    });

    it('should filter cleanup by status', async () => {
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { changes: 3 }
          })
        })
      });

      const result = await replayService.cleanup({
        maxAge: 30,
        statusFilter: 'completed',
      });

      expect(result.deleted).toBe(3);

      // Verify status filter was applied
      const deleteCall = mockDb.prepare.mock.calls[0][0];
      expect(deleteCall).toContain('status = ?');
    });
  });

  describe('getStatistics', () => {
    it('should calculate DLQ statistics', async () => {
      const mockStats = {
        total: 10,
        pending: 5,
        replaying: 1,
        completed: 3,
        failed: 1,
        oldest_entry: '2025-01-01T00:00:00Z',
        newest_entry: '2025-01-13T00:00:00Z',
      };

      mockDb.prepare.mockReturnValue({
        first: vi.fn().mockResolvedValue(mockStats),
      });

      const stats = await replayService.getStatistics();

      expect(stats.total).toBe(10);
      expect(stats.pending).toBe(5);
      expect(stats.replaying).toBe(1);
      expect(stats.completed).toBe(3);
      expect(stats.failed).toBe(1);
      expect(stats.oldestEntry).toBe('2025-01-01T00:00:00Z');
      expect(stats.newestEntry).toBe('2025-01-13T00:00:00Z');
    });

    it('should handle empty DLQ', async () => {
      mockDb.prepare.mockReturnValue({
        first: vi.fn().mockResolvedValue({
          total: 0,
          pending: 0,
          replaying: 0,
          completed: 0,
          failed: 0,
          oldest_entry: null,
          newest_entry: null,
        }),
      });

      const stats = await replayService.getStatistics();

      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      // These are undefined when null is returned from DB
      expect(stats.oldestEntry).toBeFalsy();
      expect(stats.newestEntry).toBeFalsy();
    });
  });

  describe('resetStaleReplayingEntries', () => {
    it('should reset stale replaying entries to pending', async () => {
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { changes: 3 }
          })
        })
      });

      const result = await replayService.resetStaleReplayingEntries({
        staleTimeout: 30, // 30 minutes
      });

      expect(result.reset).toBe(3);

      // Verify UPDATE query was executed
      const updateCall = mockDb.prepare.mock.calls[0][0];
      expect(updateCall).toContain('UPDATE webhook_dlq');
      expect(updateCall).toContain("SET status = 'pending'");
      expect(updateCall).toContain("WHERE status = 'replaying'");
      expect(updateCall).toContain('timestamp < ?');
    });

    it('should use default timeout of 30 minutes', async () => {
      const bindMock = vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({
          meta: { changes: 0 }
        })
      });

      mockDb.prepare.mockReturnValue({
        bind: bindMock,
      });

      await replayService.resetStaleReplayingEntries();

      // Verify bind was called with a cutoff time
      expect(bindMock).toHaveBeenCalledWith(expect.any(String));
    });

    it('should handle no stale entries', async () => {
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { changes: 0 }
          })
        })
      });

      const result = await replayService.resetStaleReplayingEntries({
        staleTimeout: 30,
      });

      expect(result.reset).toBe(0);
    });

    it('should accept custom timeout', async () => {
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { changes: 1 }
          })
        })
      });

      const result = await replayService.resetStaleReplayingEntries({
        staleTimeout: 60, // 60 minutes
      });

      expect(result.reset).toBe(1);
    });

    it('should only reset replaying entries older than timeout', async () => {
      const bindMock = vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({
          meta: { changes: 2 }
        })
      });

      mockDb.prepare.mockReturnValue({
        bind: bindMock,
      });

      const staleTimeout = 15; // 15 minutes
      await replayService.resetStaleReplayingEntries({
        staleTimeout,
      });

      // Verify cutoff time is approximately 15 minutes ago
      const cutoffTime = bindMock.mock.calls[0][0];
      const expectedCutoff = new Date(Date.now() - staleTimeout * 60 * 1000);
      const actualCutoff = new Date(cutoffTime);

      // Allow 1 second tolerance for test execution time
      const timeDiff = Math.abs(expectedCutoff.getTime() - actualCutoff.getTime());
      expect(timeDiff).toBeLessThan(1000);
    });
  });
});
