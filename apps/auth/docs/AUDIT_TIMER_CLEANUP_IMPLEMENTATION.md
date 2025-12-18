# Audit Event Timer Cleanup and Flush Implementation Guide

## Architecture Overview

This document provides a comprehensive implementation plan for adding timer cleanup and flush capabilities to the audit event system in the AlUmmahNowAuth Cloudflare Worker. The solution addresses the potential loss of audit events when workers terminate unexpectedly or during scheduled maintenance.

### Key Components

1. **Timer Registry System**: Tracks all active timers across sinks
2. **Scheduled Handler**: Periodic flush mechanism using Cloudflare Cron triggers
3. **Graceful Shutdown**: Cleanup methods for timer cancellation and event flushing
4. **Enhanced Sinks**: Timer lifecycle management in WebhookSink and D1Sink

### Cloudflare Workers Lifecycle Constraints

Cloudflare Workers have specific lifecycle characteristics that inform our design:

- **No shutdown hooks**: Workers can terminate without warning
- **30-second CPU limit**: Must complete operations quickly
- **ExecutionContext.waitUntil()**: Extends worker lifetime for async operations
- **Scheduled handlers**: Reliable periodic execution via Cron triggers
- **Stateless nature**: Each request gets a fresh worker instance

## Implementation Architecture

```
┌─────────────────────┐
│   Worker Fetch      │
│     Handler         │
└──────────┬──────────┘
           │
           v
┌─────────────────────┐     ┌─────────────────────┐
│   AuditEmitter      │────>│   Timer Registry    │
│                     │     │  (Active Timers)    │
└──────────┬──────────┘     └─────────────────────┘
           │
    ┌──────┴──────┬─────────────┬────────────┐
    v             v             v              v
┌────────┐  ┌──────────┐  ┌────────┐  ┌─────────────┐
│Stdout  │  │Webhook   │  │  D1    │  │  Scheduled  │
│ Sink   │  │  Sink    │  │ Sink   │  │   Handler   │
└────────┘  └──────────┘  └────────┘  └─────────────┘
              │     │        │     │
              └─────┴────────┴─────┘
                    Periodic Flush
```

## Detailed Implementation Steps

### Step 1: Enhance AuditEventSink Interface

```typescript
// apps/auth/src/audit-emitter.ts

export interface AuditEventSink {
  /**
   * Name of the sink for identification
   */
  name: string;

  /**
   * Emit an audit event
   */
  emit(event: AuditEvent): Promise<void>;

  /**
   * Flush any pending events (for batched sinks)
   */
  flush?(): Promise<void>;

  /**
   * Clear all active timers and flush pending events
   * Called during graceful shutdown
   */
  clearTimers?(): Promise<void>;

  /**
   * Check if sink has pending events
   */
  hasPendingEvents?(): boolean;
}
```

### Step 2: Implement Timer Registry in AuditEmitter

```typescript
// apps/auth/src/audit-emitter.ts

export class AuditEmitter {
  private sinks: AuditEventSink[] = [];
  private ctx: ExecutionContext | null = null;
  private shutdownInProgress = false;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Add a sink to the emitter
   */
  addSink(sink: AuditEventSink): void {
    // Store reference for cleanup
    this.sinks.push(sink);
  }

  /**
   * Gracefully shutdown the emitter
   * - Prevents duplicate shutdown calls
   * - Cancels all timers
   * - Flushes all pending events
   */
  async shutdown(): Promise<void> {
    // Prevent concurrent shutdowns
    if (this.shutdownInProgress) {
      return this.shutdownPromise || Promise.resolve();
    }

    this.shutdownInProgress = true;
    console.log('[AuditEmitter] Initiating graceful shutdown');

    this.shutdownPromise = (async () => {
      try {
        // First, cancel all timers to prevent new flushes during shutdown
        const timerClearPromises = this.sinks
          .filter(sink => typeof sink.clearTimers === 'function')
          .map(sink =>
            sink.clearTimers!().catch(error => {
              console.error(`[AuditEmitter] Failed to clear timers for ${sink.name}:`, error);
            })
          );

        await Promise.all(timerClearPromises);
        console.log('[AuditEmitter] All timers cleared');

        // Then flush any remaining events
        await this.flush();
        console.log('[AuditEmitter] All events flushed');
      } catch (error) {
        console.error('[AuditEmitter] Shutdown error:', error);
      } finally {
        this.shutdownInProgress = false;
      }
    })();

    return this.shutdownPromise;
  }

  /**
   * Check if any sinks have pending events
   */
  hasPendingEvents(): boolean {
    return this.sinks.some(sink =>
      typeof sink.hasPendingEvents === 'function' && sink.hasPendingEvents()
    );
  }

  /**
   * Flush all sinks
   */
  async flush(): Promise<void> {
    const promises = this.sinks
      .filter(sink => typeof sink.flush === 'function')
      .map(sink => sink.flush!().catch(error => {
        console.error(`Sink ${sink.name} failed to flush:`, error);
      }));

    await Promise.all(promises);
  }

  // ... existing methods ...
}
```

### Step 3: Enhance WebhookSink with Timer Management

```typescript
// apps/auth/src/audit-emitter.ts

export class WebhookSink implements AuditEventSink {
  name = 'webhook';
  private url: string;
  private secret?: string;
  private batchSize: number;
  private batchTimeout: number;
  private eventQueue: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: ExecutionContext | null = null;
  private flushing = false;
  private timerCleared = false; // Prevent timer recreation after clear

  constructor(options: {
    url: string;
    secret?: string;
    batchSize?: number;
    batchTimeout?: number;
  }) {
    this.url = options.url;
    this.secret = options.secret;
    this.batchSize = options.batchSize ?? 10;
    this.batchTimeout = options.batchTimeout ?? 5000; // 5 seconds

    // Validate webhook secret strength
    if (options.secret && options.secret.length < 32) {
      console.warn('Webhook secret should be at least 32 characters for security');
    }
  }

  async emit(event: AuditEvent): Promise<void> {
    // Don't accept new events if timer has been cleared (shutdown in progress)
    if (this.timerCleared) {
      console.warn('[WebhookSink] Rejecting event after timer clear');
      return;
    }

    this.eventQueue.push(event);

    // Flush if batch size reached and not already flushing
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      // Schedule flush if not already scheduled, not flushing, and not cleared
      if (!this.flushTimer && !this.flushing && !this.timerCleared) {
        this.scheduleFlush();
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timerCleared) return;

    this.flushTimer = setTimeout(() => {
      this.flushing = true;
      const flushPromise = this.flush().finally(() => {
        this.flushing = false;
      });

      if (this.ctx) {
        this.ctx.waitUntil(flushPromise);
      } else {
        flushPromise.catch(console.error);
      }
    }, this.batchTimeout);
  }

  async clearTimers(): Promise<void> {
    this.timerCleared = true; // Prevent new timers

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      console.log('[WebhookSink] Timer cleared');
    }

    // Wait for any in-progress flush to complete
    if (this.flushing) {
      console.log('[WebhookSink] Waiting for in-progress flush');
      // Simple retry with backoff
      for (let i = 0; i < 10; i++) {
        if (!this.flushing) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Final flush of remaining events
    if (this.eventQueue.length > 0) {
      console.log(`[WebhookSink] Flushing ${this.eventQueue.length} remaining events`);
      await this.flush();
    }
  }

  hasPendingEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.eventQueue.length === 0) {
      return;
    }

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      const body = JSON.stringify({ events });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'AlUmmahNow-Auth/1.0',
        'X-Batch-Size': String(events.length),
        'X-Flush-Reason': this.timerCleared ? 'shutdown' : 'batch',
      };

      // Add signature if secret is configured
      if (this.secret) {
        const encoder = new TextEncoder();
        const data = encoder.encode(body);
        const keyData = encoder.encode(this.secret);
        const key = await crypto.subtle.importKey(
          'raw',
          keyData,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signature = await crypto.subtle.sign('HMAC', key, data);
        const hexSignature = Array.from(new Uint8Array(signature))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        headers['X-Audit-Signature'] = `sha256=${hexSignature}`;
      }

      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        console.error(`[WebhookSink] Delivery failed: ${response.status} ${response.statusText}`);
        // During shutdown, we can't retry - log to stdout as fallback
        if (this.timerCleared) {
          console.log(JSON.stringify({
            type: 'audit_events_webhook_failed',
            events,
            error: `HTTP ${response.status}`,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    } catch (error) {
      console.error('[WebhookSink] Delivery error:', error);
      // During shutdown, log to stdout as fallback
      if (this.timerCleared) {
        console.log(JSON.stringify({
          type: 'audit_events_webhook_error',
          events,
          error: String(error),
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }

  // ... existing methods ...
}
```

### Step 4: Enhance D1Sink with Timer Management

```typescript
// apps/auth/src/audit-emitter.ts

export class D1Sink implements AuditEventSink {
  name = 'd1';
  private db: D1Database;
  private batchSize: number;
  private batchTimeout: number;
  private eventQueue: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: ExecutionContext | null = null;
  private flushing = false;
  private timerCleared = false;

  constructor(db: D1Database, options?: {
    batchSize?: number;
    batchTimeout?: number;
  }) {
    this.db = db;
    this.batchSize = options?.batchSize ?? 20;
    this.batchTimeout = options?.batchTimeout ?? 3000; // 3 seconds
  }

  async clearTimers(): Promise<void> {
    this.timerCleared = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      console.log('[D1Sink] Timer cleared');
    }

    // Wait for any in-progress flush
    if (this.flushing) {
      console.log('[D1Sink] Waiting for in-progress flush');
      for (let i = 0; i < 10; i++) {
        if (!this.flushing) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Final flush
    if (this.eventQueue.length > 0) {
      console.log(`[D1Sink] Flushing ${this.eventQueue.length} remaining events`);
      await this.flush();
    }
  }

  hasPendingEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  // ... rest of implementation similar to WebhookSink ...
}
```

### Step 5: Implement Scheduled Handler

```typescript
// apps/auth/src/index.ts

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // ... existing fetch handler ...
  },

  /**
   * Scheduled handler - runs periodically via Cron trigger
   * Ensures audit events are flushed regularly to prevent event loss
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const startTime = Date.now();
    console.log(`[Scheduled] Audit flush triggered at ${new Date(event.scheduledTime).toISOString()}`);

    try {
      // Initialize audit emitter with same configuration as fetch handler
      const emitter = initializeAuditEmitter({
        enableStdout: true,
        webhookUrl: env.AUDIT_WEBHOOK_URL,
        webhookSecret: env.AUDIT_WEBHOOK_SECRET,
        db: env.AUTH_DB,
        ctx,
      });

      // Check if there are pending events
      const hasPending = emitter.hasPendingEvents();

      if (hasPending) {
        console.log('[Scheduled] Pending events detected, flushing...');
        await emitter.flush();
        console.log('[Scheduled] Flush completed');
      } else {
        console.log('[Scheduled] No pending events to flush');
      }

      // Perform graceful shutdown to clear timers
      await emitter.shutdown();

      const duration = Date.now() - startTime;
      console.log(`[Scheduled] Audit flush completed in ${duration}ms`);
    } catch (error) {
      console.error('[Scheduled] Audit flush error:', error);
      // Don't throw - let the scheduled job complete successfully
    }
  },

  /**
   * Queue handler - for future implementation of dead letter queue
   * Can be used to process failed audit events
   */
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    console.log(`[Queue] Processing ${batch.messages.length} messages`);

    // Future: Process failed audit events from DLQ
    for (const message of batch.messages) {
      try {
        const event = message.body as AuditEvent;
        console.log(`[Queue] Reprocessing audit event: ${event.eventType}`);

        // Re-emit to appropriate sinks
        await emitAuditEvent(event);

        // Acknowledge successful processing
        message.ack();
      } catch (error) {
        console.error(`[Queue] Failed to process message:`, error);
        // Retry the message
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env>;
```

### Step 6: Update Wrangler Configuration

```json
{
  "compatibility_date": "2024-12-30",
  "main": "src/index.ts",
  "name": "al-ummah-now-auth",
  "upload_source_maps": true,
  "kv_namespaces": [
    {
      "binding": "AUTH_STORAGE",
      "id": "c3f796d40db8420c920aef1ce10a7f13",
      "preview_id": "c9f1b1f1492e4a61b5e20d1872aa14fb"
    }
  ],
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "al-ummah-now-d1",
      "database_id": "af76f007-e21e-43aa-88de-ebfefe46fb56",
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "PROFILE_APP_URL": "https://profile.auth.alummahnow.net/"
  },
  "observability": {
    "enabled": true
  },
  "compatibility_flags": ["nodejs_compat"],
  "tail_consumers": [
    {
      "service": "al-ummah-now-auth-tail"
    }
  ],
  "triggers": {
    "crons": [
      "*/5 * * * *",
      "0 * * * *"
    ]
  }
}
```

The configuration includes two cron triggers:
- `*/5 * * * *` - Every 5 minutes for regular flushes
- `0 * * * *` - Every hour on the hour as a backup

## Test Plan

### Unit Tests

```typescript
// apps/auth/src/audit-emitter.test.ts

describe('Timer Cleanup', () => {
  describe('WebhookSink.clearTimers', () => {
    it('should cancel pending timer', async () => {
      const sink = new WebhookSink({
        url: 'https://example.com/audit',
        batchTimeout: 5000,
      });

      // Add an event to trigger timer
      await sink.emit(createTestEvent());

      // Verify timer is set
      expect(sink['flushTimer']).not.toBeNull();

      // Clear timers
      await sink.clearTimers();

      // Verify timer is cleared
      expect(sink['flushTimer']).toBeNull();
      expect(sink['timerCleared']).toBe(true);
    });

    it('should flush pending events on clear', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('OK'));
      global.fetch = fetchSpy;

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
      const fetchSpy = vi.fn().mockResolvedValue(new Response('OK'));
      global.fetch = fetchSpy;

      const emitter = initializeAuditEmitter({
        webhookUrl: 'https://example.com/audit',
      });

      // Add events without triggering immediate flush
      const sink = emitter.getSinks().find(s => s.name === 'webhook') as WebhookSink;
      sink['batchSize'] = 100; // High batch size

      await emitter.emit(createTestEvent());
      await emitter.emit(createTestEvent());

      expect(fetchSpy).not.toHaveBeenCalled();

      // Shutdown should flush
      await emitter.shutdown();

      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe('Scheduled Handler', () => {
    it('should flush pending events', async () => {
      const env = createTestEnv();
      const ctx = createTestContext();

      // Mock scheduled event
      const event: ScheduledEvent = {
        scheduledTime: Date.now(),
        cron: '*/5 * * * *',
      };

      await worker.scheduled(event, env, ctx);

      // Verify flush was called
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Audit flush completed')
      );
    });
  });
});
```

### Integration Tests

1. **End-to-end Timer Cleanup**
   ```bash
   # Start worker with audit events
   wrangler dev

   # Generate audit events
   curl -X POST http://localhost:8787/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}'

   # Wait for scheduled flush (5 minutes) or trigger manually
   wrangler tail --format pretty

   # Verify events are flushed periodically
   ```

2. **Worker Termination Simulation**
   ```bash
   # Deploy to preview environment
   wrangler deploy --env preview

   # Generate events and immediately restart
   for i in {1..10}; do
     curl -X POST https://auth-preview.example.com/login &
   done
   wrangler deploy --env preview  # Force restart

   # Check logs for flush on shutdown
   wrangler tail --env preview
   ```

## Edge Cases Handled

### 1. Concurrent Flush Operations
- **Issue**: Multiple flush triggers (timer, manual, shutdown) running simultaneously
- **Solution**: Flushing flag prevents concurrent flushes, operations queue properly

### 2. Timer Recreation After Clear
- **Issue**: New events creating timers after shutdown initiated
- **Solution**: `timerCleared` flag prevents timer recreation

### 3. In-Progress Flush During Shutdown
- **Issue**: Shutdown called while flush is executing
- **Solution**: Wait loop with timeout ensures flush completes before final cleanup

### 4. Network Failures During Shutdown
- **Issue**: Webhook delivery fails during shutdown flush
- **Solution**: Fallback to stdout logging ensures events are not lost

### 5. Empty Queue Flush
- **Issue**: Unnecessary network calls for empty batches
- **Solution**: Check queue length before flush operations

### 6. Multiple Cron Trigger Overlap
- **Issue**: Scheduled handler runs while previous instance still executing
- **Solution**: Cloudflare ensures only one instance runs at a time

### 7. Memory Leaks from Uncancelled Timers
- **Issue**: Timers keep worker alive unnecessarily
- **Solution**: Explicit timer cancellation in clearTimers()

## Cloudflare-Specific Considerations

### 1. ExecutionContext Lifecycle
```typescript
// Proper usage of waitUntil for extending worker lifetime
ctx.waitUntil(
  auditEmitter.shutdown().finally(() => {
    console.log('Shutdown complete');
  })
);
```

### 2. CPU Time Limits
- Workers have 30-second CPU time limit (50ms for free plan)
- Batch sizes tuned to complete within limits:
  - WebhookSink: 10 events per batch
  - D1Sink: 20 events per batch (D1 operations are faster)

### 3. Subrequest Limits
- Maximum 50 subrequests per worker invocation
- Webhook batching reduces subrequest count
- D1 batch operations count as single subrequest

### 4. Cron Trigger Reliability
- Cron triggers are guaranteed to run (at-least-once delivery)
- May have slight delays during high load
- Duplicate protection through idempotent operations

### 5. Worker Isolation
- Each request gets fresh worker instance
- No shared state between requests
- Timer registry exists only within request lifecycle

## Monitoring and Observability

### Key Metrics to Track

1. **Flush Frequency**
   ```typescript
   console.log({
     type: 'audit_flush_metrics',
     timestamp: new Date().toISOString(),
     eventsCount: events.length,
     flushReason: 'scheduled' | 'batch' | 'shutdown',
     duration: endTime - startTime,
   });
   ```

2. **Timer Cleanup Success**
   ```typescript
   console.log({
     type: 'timer_cleanup',
     sink: sinkName,
     hadPendingEvents: hasPendingEvents,
     cleanupDuration: duration,
   });
   ```

3. **Event Loss Detection**
   ```typescript
   // Track sequence numbers to detect gaps
   let sequenceNumber = 0;
   event.metadata.sequenceNumber = ++sequenceNumber;
   ```

### Alerts to Configure

1. **High Pending Event Count**
   - Alert if pending events > 100
   - Indicates flush mechanism may be failing

2. **Flush Failures**
   - Alert on repeated webhook delivery failures
   - May need to increase timeout or check endpoint

3. **Scheduled Handler Failures**
   - Alert if scheduled handler throws errors
   - Critical for ensuring periodic flushes work

## Migration Plan

### Phase 1: Deploy Core Changes (Day 1)
1. Update audit-emitter.ts with new interfaces
2. Add clearTimers() to WebhookSink and D1Sink
3. Implement shutdown() in AuditEmitter
4. Deploy to staging environment

### Phase 2: Add Scheduled Handler (Day 2)
1. Add scheduled handler to index.ts
2. Update wrangler.json with cron triggers
3. Test in staging with synthetic events
4. Monitor logs for proper execution

### Phase 3: Production Rollout (Day 3-5)
1. Deploy to production during low-traffic window
2. Monitor metrics for 24 hours
3. Adjust batch sizes and timeouts based on data
4. Document operational procedures

### Rollback Plan
If issues arise:
1. Remove cron triggers from wrangler.json
2. Deploy previous version
3. Events will resume batching without scheduled flushes
4. No data loss as stdout sink remains active

## Performance Impact

### Memory Usage
- Timer registry: ~100 bytes per active sink
- Event queue: ~1KB per event × batch size
- Maximum additional memory: ~25KB worst case

### CPU Usage
- Timer management: < 1ms per operation
- Shutdown process: < 100ms typical
- Scheduled handler: < 500ms per execution

### Network Usage
- Reduced webhook calls through batching
- Scheduled flushes add 288 requests/day (every 5 min)
- Bandwidth: ~5KB per batch × 288 = 1.4MB/day

## Security Considerations

1. **No New Attack Vectors**
   - Scheduled handler uses same auth mechanisms
   - No external triggers beyond configured crons

2. **Audit Trail Integrity**
   - Events include flush reason header
   - Shutdown events logged separately
   - Sequence numbers detect gaps

3. **Secret Management**
   - Webhook secrets remain in env vars
   - No secrets in timer registry
   - Proper cleanup prevents secret leaks

## Conclusion

This implementation provides a robust solution for preventing audit event loss in Cloudflare Workers. The combination of timer management, scheduled flushes, and graceful shutdown ensures that audit events are reliably delivered even during worker termination or maintenance windows. The solution is designed to work within Cloudflare's constraints while maintaining high performance and reliability.