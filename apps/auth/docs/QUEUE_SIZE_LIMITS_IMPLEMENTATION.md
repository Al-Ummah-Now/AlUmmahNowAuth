# Queue Size Limits Implementation Guide

## Executive Summary

This document provides a comprehensive implementation plan for adding queue size limits to the audit sinks (`WebhookSink` and `D1Sink`) in the AlUmmahNowAuth authentication service. The primary goal is to prevent unbounded memory growth and potential worker crashes when downstream services are unavailable for extended periods.

## Architecture Overview

### Current State
```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Audit Event │────►│ Event Queue  │────►│ Batch Flush  │
│  Emission   │     │ (Unbounded)  │     │  to Sinks    │
└─────────────┘     └──────────────┘     └──────────────┘
                           ⚠️
                    Memory Leak Risk
```

### Target State
```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Audit Event │────►│ Bounded Queue│────►│ Batch Flush  │
│  Emission   │     │ (Max: 1000)  │     │  to Sinks    │
└─────────────┘     └──────────────┘     └──────────────┘
                           │
                    ┌──────▼──────┐
                    │ Drop Oldest  │
                    │  + Metrics   │
                    └──────────────┘
```

## Memory Usage Analysis

### Cloudflare Workers Constraints
- **Memory Limit**: 128MB per worker instance
- **CPU Time**: 10-50ms per request (paid plan)
- **Runtime**: V8 isolate with automatic garbage collection

### Event Size Calculations
```typescript
// Average AuditEvent size breakdown
{
  timestamp: 24 bytes,      // ISO 8601 string
  eventType: 30 bytes,      // enum string
  severity: 10 bytes,       // enum string
  userId: 36 bytes,         // UUID
  ipAddress: 45 bytes,      // IPv6 max
  userAgent: 200 bytes,     // typical UA string
  requestId: 36 bytes,      // UUID
  metadata: 500 bytes,      // average object size
  success: 5 bytes,         // boolean
  errorMessage: 100 bytes   // optional string
}
// Total: ~1KB per event (conservative estimate)
```

### Queue Memory Impact
| Queue Size | Memory Usage | % of Worker Memory |
|------------|--------------|-------------------|
| 100        | ~100KB       | 0.08%            |
| 1,000      | ~1MB         | 0.78%            |
| 5,000      | ~5MB         | 3.91%            |
| 10,000     | ~10MB        | 7.81%            |
| 50,000     | ~50MB        | 39.06%           |
| 100,000    | ~100MB       | 78.13% ⚠️        |

**Recommendation**: Default limit of 1,000 events provides good buffer while maintaining minimal memory footprint.

## Implementation Strategy

### 1. Queue Management Approaches

#### Option A: Drop Oldest (FIFO) - RECOMMENDED ✅
```typescript
if (this.eventQueue.length >= this.maxQueueSize) {
  this.droppedEvents++;
  this.eventQueue.shift(); // O(n) but simple
}
this.eventQueue.push(event);
```

**Pros:**
- Simple and predictable behavior
- Maintains temporal ordering
- Easy to debug and reason about

**Cons:**
- Loses historical context
- O(n) shift operation (mitigated by small queue size)

#### Option B: Drop by Severity
```typescript
if (this.eventQueue.length >= this.maxQueueSize) {
  const dropIndex = this.findLowestSeverityEvent();
  this.eventQueue.splice(dropIndex, 1);
}
```

**Pros:**
- Preserves critical events
- Better for security auditing

**Cons:**
- Complex priority logic
- O(n) search for each drop
- May lose all info-level events

#### Option C: Ring Buffer
```typescript
class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.maxSize;
    if (this.size < this.maxSize) {
      this.size++;
    } else {
      this.head = (this.head + 1) % this.maxSize;
      this.droppedCount++;
    }
  }
}
```

**Pros:**
- O(1) operations
- Memory efficient
- No array resizing

**Cons:**
- More complex implementation
- Harder to debug
- Requires array conversion for batch operations

### 2. Configuration Design

```typescript
interface QueueConfig {
  maxQueueSize?: number;        // Default: 1000
  dropStrategy?: 'oldest' | 'severity' | 'newest';  // Default: 'oldest'
  enableMetrics?: boolean;       // Default: true
  alertThreshold?: number;       // Default: 0.8 (80% full)
  backpressureMode?: 'drop' | 'block' | 'slow';  // Default: 'drop'
}
```

### 3. Monitoring & Metrics

```typescript
interface QueueMetrics {
  currentSize: number;
  maxSize: number;
  droppedEvents: number;
  droppedEventsPerMinute: number;
  oldestEventAge: number;  // milliseconds
  queueUtilization: number; // percentage
  backpressureActivations: number;
  lastDropTime?: string;
  dropReasons: {
    queueFull: number;
    timeout: number;
    error: number;
  };
}
```

## Implementation Code

### Enhanced WebhookSink with Queue Limits

```typescript
export class WebhookSink implements AuditEventSink {
  name = 'webhook';
  private url: string;
  private secret?: string;
  private batchSize: number;
  private batchTimeout: number;
  private maxQueueSize: number;
  private eventQueue: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: ExecutionContext | null = null;
  private flushing = false;

  // Metrics
  private metrics: {
    droppedEvents: number;
    droppedEventsByType: Map<string, number>;
    lastDropTimestamp?: string;
    queueHighWaterMark: number;
  } = {
    droppedEvents: 0,
    droppedEventsByType: new Map(),
    queueHighWaterMark: 0,
  };

  constructor(options: {
    url: string;
    secret?: string;
    batchSize?: number;
    batchTimeout?: number;
    maxQueueSize?: number;
  }) {
    this.url = options.url;
    this.secret = options.secret;
    this.batchSize = options.batchSize ?? 10;
    this.batchTimeout = options.batchTimeout ?? 5000;
    this.maxQueueSize = options.maxQueueSize ?? 1000;

    // Validate configuration
    if (this.maxQueueSize < this.batchSize) {
      console.warn(
        `maxQueueSize (${this.maxQueueSize}) is less than batchSize (${this.batchSize}). ` +
        `Setting maxQueueSize to ${this.batchSize * 2}`
      );
      this.maxQueueSize = this.batchSize * 2;
    }

    if (options.secret && options.secret.length < 32) {
      console.warn('Webhook secret should be at least 32 characters for security');
    }
  }

  async emit(event: AuditEvent): Promise<void> {
    // Check queue capacity
    if (this.eventQueue.length >= this.maxQueueSize) {
      this.handleQueueOverflow(event);
    }

    this.eventQueue.push(event);

    // Update high water mark
    this.metrics.queueHighWaterMark = Math.max(
      this.metrics.queueHighWaterMark,
      this.eventQueue.length
    );

    // Log warning if queue is getting full
    const utilization = this.eventQueue.length / this.maxQueueSize;
    if (utilization >= 0.8 && utilization < 0.9) {
      console.warn(
        `Webhook queue at ${Math.round(utilization * 100)}% capacity ` +
        `(${this.eventQueue.length}/${this.maxQueueSize})`
      );
    } else if (utilization >= 0.9) {
      console.error(
        `CRITICAL: Webhook queue at ${Math.round(utilization * 100)}% capacity ` +
        `(${this.eventQueue.length}/${this.maxQueueSize}). Events may be dropped.`
      );
    }

    // Existing flush logic
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      if (!this.flushTimer && !this.flushing) {
        this.scheduleFlush();
      }
    }
  }

  private handleQueueOverflow(incomingEvent: AuditEvent): void {
    // Drop oldest event (FIFO)
    const droppedEvent = this.eventQueue.shift();

    if (droppedEvent) {
      this.metrics.droppedEvents++;
      this.metrics.lastDropTimestamp = new Date().toISOString();

      // Track dropped events by type
      const eventType = droppedEvent.eventType;
      const currentCount = this.metrics.droppedEventsByType.get(eventType) || 0;
      this.metrics.droppedEventsByType.set(eventType, currentCount + 1);

      // Log based on severity
      const message =
        `Dropped audit event due to queue overflow. ` +
        `Type: ${droppedEvent.eventType}, ` +
        `Severity: ${droppedEvent.severity}, ` +
        `Timestamp: ${droppedEvent.timestamp}, ` +
        `Total dropped: ${this.metrics.droppedEvents}`;

      if (droppedEvent.severity === 'critical' || droppedEvent.severity === 'error') {
        console.error(`CRITICAL: ${message}`);
      } else {
        console.warn(message);
      }

      // Emit a special audit event about the drop (only every 100 drops to avoid loops)
      if (this.metrics.droppedEvents % 100 === 0) {
        const dropEvent: AuditEvent = {
          timestamp: new Date().toISOString(),
          eventType: 'audit.queue.overflow' as any,
          severity: 'warning',
          userId: null,
          ipAddress: null,
          userAgent: null,
          requestId: null,
          success: false,
          metadata: {
            droppedCount: this.metrics.droppedEvents,
            queueSize: this.maxQueueSize,
            droppedEventType: droppedEvent.eventType,
          },
        };

        // Try to emit to stdout as fallback
        console.log(JSON.stringify({
          type: 'audit_event',
          event: dropEvent,
        }));
      }
    }
  }

  private scheduleFlush(): void {
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
      const body = JSON.stringify({
        events,
        metrics: this.getMetrics(),
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'AlUmmahNow-Auth/1.0',
        'X-Queue-Stats': JSON.stringify({
          dropped: this.metrics.droppedEvents,
          highWaterMark: this.metrics.queueHighWaterMark,
        }),
      };

      if (this.secret) {
        // ... existing signature logic ...
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
        console.error(
          `Webhook delivery failed: ${response.status} ${response.statusText}. ` +
          `Queue metrics: ${JSON.stringify(this.getMetrics())}`
        );
      } else {
        // Reset high water mark on successful flush
        this.metrics.queueHighWaterMark = this.eventQueue.length;
      }
    } catch (error) {
      console.error('Webhook delivery error:', error);
      console.error('Queue metrics at failure:', this.getMetrics());

      // Put events back if there's room (with overflow protection)
      const roomAvailable = this.maxQueueSize - this.eventQueue.length;
      const eventsToRequeue = events.slice(0, Math.min(roomAvailable, events.length));
      const eventsDropped = events.length - eventsToRequeue.length;

      if (eventsDropped > 0) {
        console.error(
          `Dropping ${eventsDropped} events due to flush failure and queue capacity`
        );
        this.metrics.droppedEvents += eventsDropped;
      }

      this.eventQueue.unshift(...eventsToRequeue);
    }
  }

  getMetrics(): QueueMetrics {
    const now = Date.now();
    const oldestEvent = this.eventQueue[0];
    const oldestEventAge = oldestEvent
      ? now - new Date(oldestEvent.timestamp).getTime()
      : 0;

    return {
      currentSize: this.eventQueue.length,
      maxSize: this.maxQueueSize,
      droppedEvents: this.metrics.droppedEvents,
      droppedEventsPerMinute: 0, // Would need time-window tracking
      oldestEventAge,
      queueUtilization: (this.eventQueue.length / this.maxQueueSize) * 100,
      backpressureActivations: 0, // Would need to track this
      lastDropTime: this.metrics.lastDropTimestamp,
      dropReasons: {
        queueFull: this.metrics.droppedEvents,
        timeout: 0,
        error: 0,
      },
      droppedEventsByType: Object.fromEntries(this.metrics.droppedEventsByType),
      highWaterMark: this.metrics.queueHighWaterMark,
    };
  }

  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }
}
```

### Enhanced D1Sink with Queue Limits

```typescript
export class D1Sink implements AuditEventSink {
  name = 'd1';
  private db: D1Database;
  private batchSize: number;
  private batchTimeout: number;
  private maxQueueSize: number;
  private eventQueue: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: ExecutionContext | null = null;
  private flushing = false;

  // Metrics
  private metrics: {
    droppedEvents: number;
    droppedEventsByType: Map<string, number>;
    lastDropTimestamp?: string;
    queueHighWaterMark: number;
  } = {
    droppedEvents: 0,
    droppedEventsByType: new Map(),
    queueHighWaterMark: 0,
  };

  constructor(db: D1Database, options?: {
    batchSize?: number;
    batchTimeout?: number;
    maxQueueSize?: number;
  }) {
    this.db = db;
    this.batchSize = options?.batchSize ?? 20;
    this.batchTimeout = options?.batchTimeout ?? 3000;
    this.maxQueueSize = options?.maxQueueSize ?? 1000;

    // Validate configuration
    if (this.maxQueueSize < this.batchSize) {
      console.warn(
        `maxQueueSize (${this.maxQueueSize}) is less than batchSize (${this.batchSize}). ` +
        `Setting maxQueueSize to ${this.batchSize * 2}`
      );
      this.maxQueueSize = this.batchSize * 2;
    }
  }

  async emit(event: AuditEvent): Promise<void> {
    // Check queue capacity
    if (this.eventQueue.length >= this.maxQueueSize) {
      this.handleQueueOverflow(event);
    }

    this.eventQueue.push(event);

    // Update high water mark
    this.metrics.queueHighWaterMark = Math.max(
      this.metrics.queueHighWaterMark,
      this.eventQueue.length
    );

    // Log warning if queue is getting full
    const utilization = this.eventQueue.length / this.maxQueueSize;
    if (utilization >= 0.8 && utilization < 0.9) {
      console.warn(
        `D1 queue at ${Math.round(utilization * 100)}% capacity ` +
        `(${this.eventQueue.length}/${this.maxQueueSize})`
      );
    } else if (utilization >= 0.9) {
      console.error(
        `CRITICAL: D1 queue at ${Math.round(utilization * 100)}% capacity ` +
        `(${this.eventQueue.length}/${this.maxQueueSize}). Events may be dropped.`
      );
    }

    // Existing flush logic
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      if (!this.flushTimer && !this.flushing) {
        this.scheduleFlush();
      }
    }
  }

  private handleQueueOverflow(incomingEvent: AuditEvent): void {
    // Drop oldest event (FIFO)
    const droppedEvent = this.eventQueue.shift();

    if (droppedEvent) {
      this.metrics.droppedEvents++;
      this.metrics.lastDropTimestamp = new Date().toISOString();

      // Track dropped events by type
      const eventType = droppedEvent.eventType;
      const currentCount = this.metrics.droppedEventsByType.get(eventType) || 0;
      this.metrics.droppedEventsByType.set(eventType, currentCount + 1);

      // Log dropped event to stdout as fallback
      console.warn(
        `D1 queue overflow - dropped event. ` +
        `Type: ${droppedEvent.eventType}, ` +
        `Total dropped: ${this.metrics.droppedEvents}`
      );

      // Log the dropped event to stdout for recovery
      console.log(JSON.stringify({
        type: 'audit_event_dropped',
        sink: 'd1',
        event: droppedEvent,
        reason: 'queue_overflow',
        metrics: this.getMetrics(),
      }));
    }
  }

  private scheduleFlush(): void {
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
      // Insert all events in a single batch
      const statements = events.map(event =>
        this.db.prepare(
          `INSERT INTO audit_events (
            timestamp, event_type, severity, user_id, ip_address,
            user_agent, request_id, metadata, success, error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          event.timestamp,
          event.eventType,
          event.severity,
          event.userId,
          event.ipAddress,
          event.userAgent,
          event.requestId,
          JSON.stringify(event.metadata),
          event.success ? 1 : 0,
          event.errorMessage ?? null
        )
      );

      await this.db.batch(statements);

      // Reset high water mark on successful flush
      this.metrics.queueHighWaterMark = this.eventQueue.length;
    } catch (error) {
      console.error('D1 audit event storage error:', error);
      console.error('Queue metrics at failure:', this.getMetrics());

      // Events are lost if D1 write fails - log to stdout as backup
      console.log(JSON.stringify({
        type: 'audit_events_backup',
        sink: 'd1',
        events,
        error: String(error),
        metrics: this.getMetrics(),
      }));

      // Try to requeue if there's room
      const roomAvailable = this.maxQueueSize - this.eventQueue.length;
      const eventsToRequeue = events.slice(0, Math.min(roomAvailable, events.length));
      const eventsDropped = events.length - eventsToRequeue.length;

      if (eventsDropped > 0) {
        console.error(
          `Dropping ${eventsDropped} events due to D1 flush failure and queue capacity`
        );
        this.metrics.droppedEvents += eventsDropped;
      }

      this.eventQueue.unshift(...eventsToRequeue);
    }
  }

  getMetrics(): QueueMetrics {
    const now = Date.now();
    const oldestEvent = this.eventQueue[0];
    const oldestEventAge = oldestEvent
      ? now - new Date(oldestEvent.timestamp).getTime()
      : 0;

    return {
      currentSize: this.eventQueue.length,
      maxSize: this.maxQueueSize,
      droppedEvents: this.metrics.droppedEvents,
      droppedEventsPerMinute: 0,
      oldestEventAge,
      queueUtilization: (this.eventQueue.length / this.maxQueueSize) * 100,
      backpressureActivations: 0,
      lastDropTime: this.metrics.lastDropTimestamp,
      dropReasons: {
        queueFull: this.metrics.droppedEvents,
        timeout: 0,
        error: 0,
      },
      droppedEventsByType: Object.fromEntries(this.metrics.droppedEventsByType),
      highWaterMark: this.metrics.queueHighWaterMark,
    };
  }

  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }
}
```

## Testing Strategy

### Unit Tests

```typescript
describe('WebhookSink Queue Limits', () => {
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
    const fetchSpy = vi.fn().mockResolvedValue(new Response('OK'));
    global.fetch = fetchSpy;

    await sink.flush();

    const sentEvents = JSON.parse(fetchSpy.mock.calls[0][1].body).events;
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
    expect(metrics.droppedEventsByType['auth.login.success']).toBe(1);
    expect(metrics.droppedEventsByType['auth.login.failed']).toBe(1);
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

    const metrics1 = sink.getMetrics();
    expect(metrics1.highWaterMark).toBeGreaterThanOrEqual(2);

    // Trigger flush by reaching batch size
    await sink.flush();

    const metrics2 = sink.getMetrics();
    expect(metrics2.currentSize).toBe(0);
    expect(metrics2.highWaterMark).toBe(0); // Reset after successful flush
  });

  it('should requeue events on flush failure with capacity limit', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('Network error'));
    global.fetch = fetchSpy;

    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 3,
      batchSize: 2,
    });

    // Add 2 events (will trigger flush)
    await sink.emit(createTestEvent('event-1'));
    await sink.emit(createTestEvent('event-2'));

    await sink.flush();

    // Events should be requeued
    const metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(2);

    // Add more events to exceed capacity during requeue
    await sink.emit(createTestEvent('event-3'));
    await sink.emit(createTestEvent('event-4'));

    // Should not exceed max queue size
    expect(sink.getMetrics().currentSize).toBeLessThanOrEqual(3);
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
    expect(sink['maxQueueSize']).toBe(20); // Should be adjusted to batchSize * 2
  });
});
```

### Load Testing

```typescript
describe('Queue Load Testing', () => {
  it('should handle sustained high load', async () => {
    const sink = new WebhookSink({
      url: 'http://example.com',
      maxQueueSize: 1000,
      batchSize: 50,
      batchTimeout: 100,
    });

    const startTime = Date.now();
    const eventCount = 10000;

    // Simulate high event rate
    for (let i = 0; i < eventCount; i++) {
      await sink.emit(createTestEvent(`load-${i}`));

      // Simulate 100 events per second
      if (i % 100 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const endTime = Date.now();
    const duration = endTime - startTime;
    const metrics = sink.getMetrics();

    console.log(`Load test results:
      Duration: ${duration}ms
      Events submitted: ${eventCount}
      Events in queue: ${metrics.currentSize}
      Events dropped: ${metrics.droppedEvents}
      Drop rate: ${(metrics.droppedEvents / eventCount * 100).toFixed(2)}%
      High water mark: ${metrics.highWaterMark}
    `);

    expect(metrics.droppedEvents).toBeGreaterThan(0);
    expect(metrics.currentSize).toBeLessThanOrEqual(1000);
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
      maxQueueSize: 100,
      batchSize: 10,
      batchTimeout: 100,
    });

    // Fill queue while endpoint is down
    for (let i = 0; i < 150; i++) {
      await sink.emit(createTestEvent(`event-${i}`));
    }

    let metrics = sink.getMetrics();
    expect(metrics.droppedEvents).toBeGreaterThan(0);

    // Endpoint comes back online
    shouldFail = false;

    // Trigger successful flush
    await sink.flush();

    metrics = sink.getMetrics();
    expect(metrics.currentSize).toBe(0);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
```

## Configuration Best Practices

### Environment-Specific Settings

```typescript
// Development
const devConfig = {
  maxQueueSize: 10000,  // Large buffer for debugging
  batchSize: 1,         // Immediate flush for testing
  batchTimeout: 100,    // Fast feedback
  enableMetrics: true,
};

// Staging
const stagingConfig = {
  maxQueueSize: 5000,   // Moderate buffer
  batchSize: 20,        // Balance between performance and latency
  batchTimeout: 2000,   // 2 seconds
  enableMetrics: true,
};

// Production
const prodConfig = {
  maxQueueSize: 1000,   // Conservative to prevent memory issues
  batchSize: 50,        // Optimize for throughput
  batchTimeout: 5000,   // 5 seconds
  enableMetrics: true,
};

// High-volume production
const highVolumeConfig = {
  maxQueueSize: 2000,   // Larger buffer for traffic spikes
  batchSize: 100,       // Maximize batch efficiency
  batchTimeout: 3000,   // Balance latency and efficiency
  enableMetrics: true,
};
```

### Monitoring Setup

```sql
-- Check for dropped events in logs
SELECT
  timestamp,
  JSON_EXTRACT(message, '$.droppedCount') as dropped_count,
  JSON_EXTRACT(message, '$.queueSize') as queue_size,
  JSON_EXTRACT(message, '$.droppedEventType') as dropped_type
FROM logs
WHERE message LIKE '%queue overflow%'
ORDER BY timestamp DESC
LIMIT 100;

-- Aggregate dropped events by hour
SELECT
  DATE_TRUNC('hour', timestamp) as hour,
  COUNT(*) as overflow_events,
  SUM(CAST(JSON_EXTRACT(message, '$.droppedCount') AS INT)) as total_dropped
FROM logs
WHERE message LIKE '%queue overflow%'
GROUP BY DATE_TRUNC('hour', timestamp)
ORDER BY hour DESC;

-- Find patterns in dropped event types
SELECT
  JSON_EXTRACT(message, '$.droppedEventType') as event_type,
  COUNT(*) as drop_count
FROM logs
WHERE message LIKE '%queue overflow%'
GROUP BY JSON_EXTRACT(message, '$.droppedEventType')
ORDER BY drop_count DESC;
```

### Alerting Rules

```yaml
# Prometheus/AlertManager style alerts
alerts:
  - name: AuditQueueHighUtilization
    expr: audit_queue_utilization > 80
    for: 5m
    annotations:
      summary: "Audit queue at {{ $value }}% capacity"
      description: "The {{ $labels.sink }} sink queue is filling up"

  - name: AuditEventDropped
    expr: rate(audit_events_dropped[5m]) > 0
    annotations:
      summary: "Audit events being dropped"
      description: "{{ $value }} events/minute being dropped from {{ $labels.sink }}"

  - name: AuditQueueCritical
    expr: audit_queue_utilization > 95
    annotations:
      summary: "CRITICAL: Audit queue at {{ $value }}% capacity"
      description: "Immediate action required for {{ $labels.sink }} sink"
```

## Trade-offs Analysis

### Drop Oldest (FIFO) Strategy

**Chosen Approach**

| Aspect | Impact | Mitigation |
|--------|--------|------------|
| **Data Loss** | Older events lost during overflows | Log dropped events for recovery |
| **Compliance** | May lose audit trail continuity | Backup to stdout, increase limits |
| **Performance** | O(n) shift operation | Small queues minimize impact |
| **Debugging** | Simple to understand and predict | Clear metrics and logging |
| **Memory** | Predictable memory usage | Hard limit prevents OOM |

### Alternative: Drop by Severity

| Aspect | Impact | Mitigation |
|--------|--------|------------|
| **Data Loss** | Info events lost first | May lose important context |
| **Compliance** | Critical events preserved | Better for security audits |
| **Performance** | O(n) search for each drop | Complex priority calculations |
| **Debugging** | Harder to predict behavior | More complex metrics needed |
| **Memory** | Same predictable usage | Same hard limit |

### Alternative: Circuit Breaker

| Aspect | Impact | Mitigation |
|--------|--------|------------|
| **Data Loss** | All events lost during break | Need alternate sink |
| **Compliance** | Complete audit gaps | Must have fallback |
| **Performance** | Very efficient | No queue operations |
| **Debugging** | Clear on/off states | Simple state machine |
| **Memory** | Minimal usage | No queue needed |

## Migration Plan

### Phase 1: Add Configuration (Non-Breaking)
1. Add `maxQueueSize` parameter to constructors
2. Default to very high limit (100,000)
3. Add metrics collection
4. Deploy and monitor

### Phase 2: Gradual Rollout
1. Set limit to 10,000 in staging
2. Monitor for 1 week
3. Reduce to 5,000
4. Monitor for 1 week
5. Deploy to production with 5,000 limit

### Phase 3: Optimization
1. Reduce to 1,000 based on metrics
2. Tune batch sizes
3. Implement advanced features (backpressure, etc.)

## Rollback Plan

If issues are detected:

1. **Immediate**: Increase `maxQueueSize` via environment variable
2. **Quick Fix**: Deploy with higher limit
3. **Full Rollback**: Remove queue limit code (git revert)

## Future Enhancements

1. **Adaptive Limits**: Automatically adjust based on memory usage
2. **Priority Queues**: Separate queues by severity
3. **Compression**: Compress old events in queue
4. **Persistent Queue**: Use KV for overflow storage
5. **Rate Limiting**: Prevent queue floods
6. **Dead Letter Queue**: Separate storage for dropped events
7. **Backpressure Propagation**: Slow down event generation
8. **Queue Sharding**: Multiple queues for parallelism

## Conclusion

The implementation of queue size limits is a critical hardening step for the audit system. The chosen FIFO drop strategy provides a good balance of simplicity, predictability, and performance while preventing memory exhaustion. The comprehensive metrics and monitoring ensure visibility into queue behavior, allowing for proactive tuning and incident response.

The phased rollout plan minimizes risk while the extensive testing ensures reliability. This implementation follows Cloudflare Workers best practices and maintains the system's edge-first architecture principles.