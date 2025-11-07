/**
 * Enhanced Audit Event Emitter with Advanced Queue Management
 *
 * This module provides the event emission system for audit events with
 * comprehensive queue management, metrics tracking, and graceful shutdown.
 */

import { AuditEvent, AuditEventSeverity } from './audit-events';

/**
 * Queue metrics interface
 */
export interface QueueMetrics {
  currentSize: number;
  maxSize: number;
  droppedEvents: number;
  droppedEventsByType?: Record<string, number>;
  highWaterMark: number;
  queueUtilization: number; // Percentage
  oldestEventAge?: number; // Milliseconds
}

/**
 * Enhanced Audit event sink interface with timer management
 */
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

  /**
   * Get queue metrics (for sinks with queues)
   */
  getMetrics?(): QueueMetrics;
}

/**
 * Stdout sink - writes events to console as JSON
 */
export class StdoutSink implements AuditEventSink {
  name = 'stdout';

  async emit(event: AuditEvent): Promise<void> {
    // Output as structured JSON for parsing by log aggregators
    console.log(JSON.stringify({
      type: 'audit_event',
      event,
    }));
  }

  // No timers or batching, so no cleanup needed
  hasPendingEvents(): boolean {
    return false;
  }
}

/**
 * Enhanced Webhook sink with advanced queue management
 */
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
  private timerCleared = false;

  // Metrics tracking
  private droppedEvents = 0;
  private droppedEventsByType: Record<string, number> = {};
  private highWaterMark = 0;
  private overflowEventCount = 0;

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

    // Validate configuration - prevent misconfiguration
    if (this.maxQueueSize < this.batchSize * 2) {
      throw new Error(`[WebhookSink] Invalid configuration: maxQueueSize (${this.maxQueueSize}) must be at least twice the batchSize (${this.batchSize * 2}). This prevents immediate queue overflow.`);
    }

    // Validate webhook secret strength
    if (options.secret && options.secret.length < 32) {
      console.warn('Webhook secret should be at least 32 characters for security');
    }
  }

  /**
   * Set ExecutionContext for async operations
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }

  /**
   * Get current queue metrics
   */
  getMetrics(): QueueMetrics {
    const utilization = (this.eventQueue.length / this.maxQueueSize) * 100;

    let oldestEventAge: number | undefined;
    if (this.eventQueue.length > 0) {
      const oldestTimestamp = new Date(this.eventQueue[0].timestamp).getTime();
      oldestEventAge = Date.now() - oldestTimestamp;
    }

    return {
      currentSize: this.eventQueue.length,
      maxSize: this.maxQueueSize,
      droppedEvents: this.droppedEvents,
      droppedEventsByType: { ...this.droppedEventsByType },
      highWaterMark: this.highWaterMark,
      queueUtilization: utilization,
      oldestEventAge,
    };
  }

  async emit(event: AuditEvent): Promise<void> {
    // Don't accept new events if timer has been cleared (shutdown in progress)
    if (this.timerCleared) {
      console.warn('[WebhookSink] Rejecting event after timer clear');
      return;
    }

    // Check if queue is full
    if (this.eventQueue.length >= this.maxQueueSize) {
      // Drop the oldest event
      const droppedEvent = this.eventQueue.shift();
      if (droppedEvent) {
        this.droppedEvents++;

        // Track dropped events by type
        const eventType = droppedEvent.eventType;
        this.droppedEventsByType[eventType] = (this.droppedEventsByType[eventType] || 0) + 1;

        // Log based on severity
        if (droppedEvent.severity === AuditEventSeverity.CRITICAL) {
          console.error(`CRITICAL: Dropped audit event (type: ${eventType}, queue full at ${this.maxQueueSize})`);
        } else {
          console.warn(`Dropped audit event (type: ${eventType}, queue full at ${this.maxQueueSize})`);
        }

        // Emit overflow event every 100 drops
        this.overflowEventCount++;
        if (this.overflowEventCount % 100 === 0) {
          console.log(JSON.stringify({
            type: 'audit_event',
            event: {
              timestamp: new Date().toISOString(),
              eventType: 'audit.queue.overflow',
              severity: 'warning',
              userId: null,
              ipAddress: null,
              userAgent: null,
              requestId: null,
              metadata: {
                totalDropped: this.droppedEvents,
                queueSize: this.maxQueueSize,
              },
              success: false,
              errorMessage: `Queue overflow: ${this.droppedEvents} events dropped`,
            },
          }));
        }
      }
    }

    this.eventQueue.push(event);

    // Update high water mark
    if (this.eventQueue.length > this.highWaterMark) {
      this.highWaterMark = this.eventQueue.length;
    }

    // Check capacity warnings
    const utilization = (this.eventQueue.length / this.maxQueueSize) * 100;
    if (utilization >= 90) {
      console.error(`[WebhookSink] CRITICAL: Queue at ${utilization.toFixed(1)}% capacity (${this.eventQueue.length}/${this.maxQueueSize})`);
    } else if (utilization >= 80) {
      console.warn(`[WebhookSink] Queue at 80% capacity (${this.eventQueue.length}/${this.maxQueueSize})`);
    }

    // Flush if batch size reached and not already flushing
    // But don't flush if batch size is larger than max queue (test scenario)
    if (this.eventQueue.length >= this.batchSize && this.batchSize <= this.maxQueueSize) {
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
    this.timerCleared = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      console.log('[WebhookSink] Timer cleared');
    }

    // Wait for any in-progress flush to complete
    if (this.flushing) {
      console.log('[WebhookSink] Waiting for in-progress flush');
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
        'X-Queue-Stats': JSON.stringify({
          dropped: this.droppedEvents,
          highWaterMark: this.highWaterMark,
          currentSize: this.eventQueue.length,
        }),
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

        // Requeue events if not shutting down and have capacity
        if (!this.timerCleared && this.eventQueue.length + events.length <= this.maxQueueSize) {
          this.eventQueue.unshift(...events);
        }

        // During shutdown, log to stdout as fallback
        if (this.timerCleared) {
          console.log(JSON.stringify({
            type: 'audit_events_webhook_failed',
            events,
            error: `HTTP ${response.status}`,
            timestamp: new Date().toISOString(),
          }));
        }
      } else {
        console.log(`[WebhookSink] Successfully delivered ${events.length} events`);
        // Reset high water mark after successful flush
        this.highWaterMark = 0;
      }
    } catch (error) {
      console.error('[WebhookSink] Delivery error:', error);

      // Requeue events if not shutting down and have capacity
      if (!this.timerCleared && this.eventQueue.length + events.length <= this.maxQueueSize) {
        this.eventQueue.unshift(...events);
      }

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
}

/**
 * Enhanced D1 Database sink with queue management
 */
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
  private timerCleared = false;

  // Metrics tracking
  private droppedEvents = 0;
  private droppedEventsByType: Record<string, number> = {};
  private highWaterMark = 0;

  constructor(db: D1Database, options?: {
    batchSize?: number;
    batchTimeout?: number;
    maxQueueSize?: number;
  }) {
    this.db = db;
    this.batchSize = options?.batchSize ?? 20;
    this.batchTimeout = options?.batchTimeout ?? 3000;
    this.maxQueueSize = options?.maxQueueSize ?? 1000;

    // Validate configuration - prevent misconfiguration
    if (this.maxQueueSize < this.batchSize * 2) {
      throw new Error(`[D1Sink] Invalid configuration: maxQueueSize (${this.maxQueueSize}) must be at least twice the batchSize (${this.batchSize * 2}). This prevents immediate queue overflow.`);
    }
  }

  /**
   * Set ExecutionContext for async operations
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }

  /**
   * Get current queue metrics
   */
  getMetrics(): QueueMetrics {
    const utilization = (this.eventQueue.length / this.maxQueueSize) * 100;

    let oldestEventAge: number | undefined;
    if (this.eventQueue.length > 0) {
      const oldestTimestamp = new Date(this.eventQueue[0].timestamp).getTime();
      oldestEventAge = Date.now() - oldestTimestamp;
    }

    return {
      currentSize: this.eventQueue.length,
      maxSize: this.maxQueueSize,
      droppedEvents: this.droppedEvents,
      droppedEventsByType: { ...this.droppedEventsByType },
      highWaterMark: this.highWaterMark,
      queueUtilization: utilization,
      oldestEventAge,
    };
  }

  async emit(event: AuditEvent): Promise<void> {
    // Don't accept new events if timer has been cleared
    if (this.timerCleared) {
      console.warn('[D1Sink] Rejecting event after timer clear');
      return;
    }

    // Check if queue is full
    if (this.eventQueue.length >= this.maxQueueSize) {
      // Drop the oldest event
      const droppedEvent = this.eventQueue.shift();
      if (droppedEvent) {
        this.droppedEvents++;

        // Track dropped events by type
        const eventType = droppedEvent.eventType;
        this.droppedEventsByType[eventType] = (this.droppedEventsByType[eventType] || 0) + 1;

        // Log warning and the dropped event for recovery
        console.warn(`[D1Sink] D1 queue overflow: dropped event (type: ${eventType})`);

        // Log dropped event to stdout for potential recovery
        console.log(JSON.stringify({
          type: 'audit_event_dropped',
          sink: 'd1',
          event: droppedEvent,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    this.eventQueue.push(event);

    // Update high water mark
    if (this.eventQueue.length > this.highWaterMark) {
      this.highWaterMark = this.eventQueue.length;
    }

    // Flush if batch size reached and not already flushing
    // But don't flush if batch size is larger than max queue (test scenario)
    if (this.eventQueue.length >= this.batchSize && this.batchSize <= this.maxQueueSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      // Schedule flush if not already scheduled and not cleared
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
      console.log(`[D1Sink] Successfully stored ${events.length} events`);
    } catch (error) {
      console.error('[D1Sink] Storage error:', error);

      // Requeue events if not shutting down and have capacity
      if (!this.timerCleared && this.eventQueue.length + events.length <= this.maxQueueSize) {
        this.eventQueue.unshift(...events);
      }

      // Log backup events to stdout
      console.log(JSON.stringify({
        type: 'audit_events_backup',
        sink: 'd1',
        events,
        error: String(error),
        timestamp: new Date().toISOString(),
        isShutdown: this.timerCleared,
      }));
    }
  }
}

/**
 * Enhanced Audit Event Emitter with shutdown capabilities
 */
export class AuditEmitter {
  private sinks: AuditEventSink[] = [];
  private ctx: ExecutionContext | null = null;
  private shutdownInProgress = false;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Add a sink to the emitter
   */
  addSink(sink: AuditEventSink): void {
    this.sinks.push(sink);
  }

  /**
   * Set ExecutionContext for async operations
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
    // Propagate to sinks that support it
    this.sinks.forEach(sink => {
      if ('setContext' in sink && typeof sink.setContext === 'function') {
        (sink as any).setContext(ctx);
      }
    });
  }

  /**
   * Emit an audit event to all sinks
   */
  async emit(event: AuditEvent): Promise<void> {
    // Emit to all sinks in parallel
    const promises = this.sinks.map(sink =>
      sink.emit(event).catch(error => {
        console.error(`Sink ${sink.name} failed to emit event:`, error);
      })
    );

    if (this.ctx) {
      this.ctx.waitUntil(Promise.all(promises));
    } else {
      await Promise.all(promises);
    }
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

  /**
   * Get aggregated metrics from all sinks
   */
  getMetrics(): Record<string, QueueMetrics> {
    const metrics: Record<string, QueueMetrics> = {};

    for (const sink of this.sinks) {
      if (typeof sink.getMetrics === 'function') {
        metrics[sink.name] = sink.getMetrics();
      }
    }

    return metrics;
  }

  /**
   * Gracefully shutdown the emitter
   */
  async shutdown(): Promise<void> {
    if (this.shutdownInProgress) {
      return this.shutdownPromise || Promise.resolve();
    }

    this.shutdownInProgress = true;
    console.log('[AuditEmitter] Initiating graceful shutdown');

    this.shutdownPromise = (async () => {
      try {
        const timerClearPromises = this.sinks
          .filter(sink => typeof sink.clearTimers === 'function')
          .map(sink =>
            sink.clearTimers!().catch(error => {
              console.error(`[AuditEmitter] Failed to clear timers for ${sink.name}:`, error);
            })
          );

        await Promise.all(timerClearPromises);
        console.log('[AuditEmitter] All timers cleared');

        await this.flush();
        console.log('[AuditEmitter] All events flushed');

        console.log(JSON.stringify({
          type: 'audit_emitter_shutdown',
          timestamp: new Date().toISOString(),
          sinkCount: this.sinks.length,
          sinksWithPending: this.sinks.filter(s =>
            typeof s.hasPendingEvents === 'function' && s.hasPendingEvents()
          ).length,
        }));
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
   * Get all configured sinks
   */
  getSinks(): AuditEventSink[] {
    return [...this.sinks];
  }
}

/**
 * Global audit emitter instance
 */
let globalAuditEmitter: AuditEmitter | null = null;

/**
 * Initialize the global audit emitter
 */
export function initializeAuditEmitter(options: {
  enableStdout?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  db?: D1Database;
  ctx?: ExecutionContext;
}): AuditEmitter {
  const emitter = new AuditEmitter();

  if (options.ctx) {
    emitter.setContext(options.ctx);
  }

  if (options.enableStdout !== false) {
    emitter.addSink(new StdoutSink());
  }

  if (options.webhookUrl) {
    const webhookSink = new WebhookSink({
      url: options.webhookUrl,
      secret: options.webhookSecret,
    });
    if (options.ctx) {
      webhookSink.setContext(options.ctx);
    }
    emitter.addSink(webhookSink);
  }

  if (options.db) {
    const d1Sink = new D1Sink(options.db);
    if (options.ctx) {
      d1Sink.setContext(options.ctx);
    }
    emitter.addSink(d1Sink);
  }

  globalAuditEmitter = emitter;
  return emitter;
}

/**
 * Get the global audit emitter
 */
export function getAuditEmitter(): AuditEmitter {
  if (!globalAuditEmitter) {
    globalAuditEmitter = new AuditEmitter();
    globalAuditEmitter.addSink(new StdoutSink());
  }
  return globalAuditEmitter;
}

/**
 * Convenience function to emit an audit event
 */
export async function emitAuditEvent(event: AuditEvent): Promise<void> {
  const emitter = getAuditEmitter();
  await emitter.emit(event);
}
