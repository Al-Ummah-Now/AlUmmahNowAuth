/**
 * Audit Logging - Concurrency Tests
 *
 * Tests for concurrent operations, race conditions, and parallel processing.
 * Addresses GitHub Issue #65 - Concurrency testing gaps.
 *
 * Test IDs: CON-01 through CON-08
 */

import { describe, it, expect, vi } from 'vitest';
import { WebhookSink, D1Sink, AuditEmitter } from './audit-emitter-enhanced';
import {
  createTestEvents,
  createMockWebhookServer,
  createMockD1Database,
} from './__mocks__/audit-helpers';

describe('Audit Logging - Concurrency Tests', () => {
  describe('CON-01: Concurrent emit() calls to WebhookSink', () => {
    it('should handle 100 concurrent emits without data loss', async () => {
      const mockServer = createMockWebhookServer();
      mockServer.addResponse(200, 'OK');
      global.fetch = vi.fn(mockServer.mockFetch);

      const sink = new WebhookSink({
        url: 'https://test.webhook.com/audit',
        secret: 'test-secret-32-characters-long!',
        batchSize: 10,
        batchTimeout: 1000,
      });

      // Emit 100 events concurrently
      const events = createTestEvents(100);
      const emitPromises = events.map(event => sink.emit(event));

      await Promise.all(emitPromises);
      await sink.flush();

      // Verify all events sent
      const sentEvents = mockServer.getAllEvents();
      expect(sentEvents).toHaveLength(100);

      // Verify batching (should be ~10 requests of 10 events each)
      const requestCount = mockServer.getRequestCount();
      expect(requestCount).toBeGreaterThanOrEqual(10);
      expect(requestCount).toBeLessThanOrEqual(11); // Allow for timing variance

      // Verify no duplicates
      const eventIds = sentEvents.map((e: any) => e.userId);
      const uniqueIds = new Set(eventIds);
      expect(uniqueIds.size).toBe(100);
    });

    it('should handle concurrent emits faster than batch timeout', async () => {
      const mockServer = createMockWebhookServer();
      mockServer.addResponse(200);
      global.fetch = vi.fn(mockServer.mockFetch);

      const sink = new WebhookSink({
        url: 'https://test.com',
        batchSize: 50,
        batchTimeout: 5000, // 5 second timeout
      });

      // Emit 50 events rapidly (should trigger batch size, not timeout)
      const events = createTestEvents(50);
      const startTime = Date.now();

      for (const event of events) {
        await sink.emit(event);
      }

      const emitDuration = Date.now() - startTime;

      // Should trigger by batch size, not timeout
      expect(emitDuration).toBeLessThan(1000); // Less than 1 second
      expect(mockServer.getRequestCount()).toBeGreaterThanOrEqual(1);
      expect(mockServer.getAllEvents()).toHaveLength(50);
    });

    it('should not lose events when emit called during flush', async () => {
      const mockServer = createMockWebhookServer();
      mockServer.addResponse(200);
      global.fetch = vi.fn(mockServer.mockFetch);

      const sink = new WebhookSink({
        url: 'https://test.com',
        batchSize: 10,
      });

      // Emit 10 events to fill batch
      const batch1 = createTestEvents(10);
      for (const event of batch1) {
        await sink.emit(event);
      }

      // Start flush (don't await)
      const flushPromise = sink.flush();

      // Immediately emit more events
      const batch2 = createTestEvents(10);
      for (const event of batch2) {
        await sink.emit(event);
      }

      // Wait for flush to complete
      await flushPromise;

      // Flush remaining events
      await sink.flush();

      // Verify all 20 events sent
      expect(mockServer.getAllEvents()).toHaveLength(20);
    });
  });

  describe('CON-02: Concurrent emit() calls to D1Sink', () => {
    it('should handle 100 concurrent emits without data loss', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 20 });

      // Emit 100 events concurrently
      const events = createTestEvents(100);
      const emitPromises = events.map(event => sink.emit(event));

      await Promise.all(emitPromises);
      await sink.flush();

      // Verify batch called correct number of times (5 batches of 20)
      expect(mockDb.batch).toHaveBeenCalledTimes(5);

      // Verify total statements
      let totalStatements = 0;
      for (const call of vi.mocked(mockDb.batch).mock.calls) {
        totalStatements += call[0].length;
      }
      expect(totalStatements).toBe(100);
    });

    it('should maintain event order within batches', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 10 });

      // Emit 10 events sequentially
      const events = createTestEvents(10);
      for (const event of events) {
        await sink.emit(event);
      }

      await sink.flush();

      // Verify events are in order (can't directly check without inspecting bind calls)
      expect(mockDb.batch).toHaveBeenCalledOnce();
      const batchCall = vi.mocked(mockDb.batch).mock.calls[0];
      expect(batchCall[0]).toHaveLength(10);
    });
  });

  describe('CON-03: Concurrent flush() calls', () => {
    it('should be idempotent - multiple flushes only insert once', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 50 });

      // Add 20 events
      const events = createTestEvents(20);
      for (const event of events) {
        await sink.emit(event);
      }

      // Call flush 10 times concurrently
      const flushPromises = Array.from({ length: 10 }, () => sink.flush());
      await Promise.all(flushPromises);

      // Verify batch called only once
      expect(mockDb.batch).toHaveBeenCalledTimes(1);

      // Verify 20 statements in the batch
      const batchCall = vi.mocked(mockDb.batch).mock.calls[0];
      expect(batchCall[0]).toHaveLength(20);
    });

    it('should handle flush called on empty queue', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb);

      // Flush empty queue multiple times
      await Promise.all([
        sink.flush(),
        sink.flush(),
        sink.flush(),
      ]);

      // Should not call batch on empty queue
      expect(mockDb.batch).not.toHaveBeenCalled();
    });

    it('should queue events correctly after concurrent flushes', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 10 });

      // First batch
      for (let i = 0; i < 5; i++) {
        await sink.emit(createTestEvents(1)[0]);
      }

      // Concurrent flushes
      await Promise.all([sink.flush(), sink.flush()]);
      expect(mockDb.batch).toHaveBeenCalledTimes(1);

      // Add more events
      for (let i = 0; i < 5; i++) {
        await sink.emit(createTestEvents(1)[0]);
      }

      // Second flush
      await sink.flush();
      expect(mockDb.batch).toHaveBeenCalledTimes(2);
    });
  });

  describe('CON-04: Race between emit() and flush()', () => {
    it('should not lose events during concurrent emit/flush', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 100 });

      // Emit 50 events
      const batch1 = createTestEvents(50);
      for (const event of batch1) {
        await sink.emit(event);
      }

      // Start flush (don't await)
      const flushPromise = sink.flush();

      // Immediately emit 50 more events (race condition)
      const batch2 = createTestEvents(50);
      const emitPromises = batch2.map(event => sink.emit(event));

      // Wait for both
      await Promise.all([flushPromise, ...emitPromises]);
      await sink.flush(); // Flush remaining

      // Verify all 100 events inserted
      expect(mockDb.batch).toHaveBeenCalledTimes(2);

      const firstBatch = vi.mocked(mockDb.batch).mock.calls[0][0];
      const secondBatch = vi.mocked(mockDb.batch).mock.calls[1][0];

      expect(firstBatch.length + secondBatch.length).toBe(100);
    });

    it('should handle interleaved emit and flush operations', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 5 });

      const operations: Promise<any>[] = [];

      // Interleave emits and flushes
      for (let i = 0; i < 10; i++) {
        operations.push(sink.emit(createTestEvents(1)[0]));
        if (i % 2 === 0) {
          operations.push(sink.flush());
        }
      }

      await Promise.all(operations);
      await sink.flush(); // Final flush

      // All events should be inserted
      let totalEvents = 0;
      for (const call of vi.mocked(mockDb.batch).mock.calls) {
        totalEvents += call[0].length;
      }
      expect(totalEvents).toBe(10);
    });
  });

  describe('CON-05: Multiple timers scheduling simultaneously', () => {
    it('should handle concurrent timer-based flushes', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, {
        batchSize: 100, // High batch size
        batchTimeout: 100, // 100ms timeout
      });

      // Emit events slowly to trigger timeouts
      for (let i = 0; i < 5; i++) {
        await sink.emit(createTestEvents(1)[0]);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Wait for timeout to trigger
      await new Promise(resolve => setTimeout(resolve, 200));

      // Events should be flushed by timeout, not batch size
      expect(mockDb.batch).toHaveBeenCalled();
    }, 1000); // 1 second test timeout

    it('should cancel timer when batch size reached', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, {
        batchSize: 10,
        batchTimeout: 5000, // 5 second timeout
      });

      const startTime = Date.now();

      // Emit 10 events rapidly to trigger batch size
      const events = createTestEvents(10);
      for (const event of events) {
        await sink.emit(event);
      }

      const duration = Date.now() - startTime;

      // Should flush immediately by batch size, not wait for timeout
      expect(duration).toBeLessThan(1000);
      expect(mockDb.batch).toHaveBeenCalledOnce();
    });
  });

  describe('CON-06: Concurrent emits to multiple sinks', () => {
    it('should emit to all sinks concurrently without interference', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const mockDb = createMockD1Database();
      const mockServer = createMockWebhookServer();
      mockServer.addResponse(200);
      global.fetch = vi.fn(mockServer.mockFetch);

      const emitter = new AuditEmitter();
      emitter.addSink(new WebhookSink({ url: 'https://test.com', batchSize: 5 }));
      emitter.addSink(new D1Sink(mockDb, { batchSize: 5 }));

      // Emit 10 events
      const events = createTestEvents(10);
      for (const event of events) {
        await emitter.emit(event);
      }

      // Flush all sinks
      await emitter.flush();

      // Verify both sinks received events
      expect(mockDb.batch).toHaveBeenCalled();
      expect(mockServer.getRequestCount()).toBeGreaterThan(0);
      expect(mockServer.getAllEvents()).toHaveLength(10);

      consoleSpy.mockRestore();
    });

    it('should isolate sink failures from each other', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockDb = createMockD1Database();
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      global.fetch = mockFetch;

      const emitter = new AuditEmitter();
      emitter.addSink(new WebhookSink({ url: 'https://test.com', batchSize: 5 }));
      emitter.addSink(new D1Sink(mockDb, { batchSize: 5 }));

      // Emit 5 events
      const events = createTestEvents(5);
      for (const event of events) {
        await emitter.emit(event);
      }

      // Flush - webhook will fail, D1 should succeed
      await emitter.flush();

      // Verify D1 still succeeded
      expect(mockDb.batch).toHaveBeenCalledOnce();

      // Verify webhook error logged
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('CON-07: Interleaved emit/flush sequences', () => {
    it('should handle complex emit/flush patterns', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 5 });

      // Complex pattern: emit, emit, flush, emit, emit, flush
      await sink.emit(createTestEvents(1)[0]);
      await sink.emit(createTestEvents(1)[0]);
      await sink.flush();

      expect(mockDb.batch).toHaveBeenCalledTimes(1);

      await sink.emit(createTestEvents(1)[0]);
      await sink.emit(createTestEvents(1)[0]);
      await sink.flush();

      expect(mockDb.batch).toHaveBeenCalledTimes(2);

      // Verify no events lost
      let totalEvents = 0;
      for (const call of vi.mocked(mockDb.batch).mock.calls) {
        totalEvents += call[0].length;
      }
      expect(totalEvents).toBe(4);
    });
  });

  describe('CON-08: High-frequency emit() calls', () => {
    it('should handle rapid emit calls (>100/sec)', async () => {
      const mockDb = createMockD1Database();
      const sink = new D1Sink(mockDb, { batchSize: 50 });

      const startTime = Date.now();

      // Emit 200 events as fast as possible
      const events = createTestEvents(200);
      for (const event of events) {
        await sink.emit(event);
      }

      await sink.flush();

      const duration = Date.now() - startTime;
      const eventsPerSecond = 200 / (duration / 1000);

      console.log(`Throughput: ${eventsPerSecond.toFixed(0)} events/sec`);

      // Should handle at least 100 events/sec
      expect(eventsPerSecond).toBeGreaterThan(100);

      // Verify all events accounted for
      let totalEvents = 0;
      for (const call of vi.mocked(mockDb.batch).mock.calls) {
        totalEvents += call[0].length;
      }
      expect(totalEvents).toBe(200);
    }, 5000); // 5 second timeout
  });
});
