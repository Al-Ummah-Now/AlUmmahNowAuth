/**
 * Audit Event Emitter
 *
 * This is the single audit emitter used by the worker. Sinks:
 * - StdoutSink: structured JSON to Workers logs
 * - QueueSink: publishes to the AUDIT_QUEUE binding (consumed by apps/audit-consumer,
 *   which writes to the audit_events table)
 * - D1Sink: direct writes to audit_events (used when no queue binding is configured)
 * - WebhookSink: optional HTTP delivery with retry + D1 dead-letter queue
 *
 * All batched sinks use bounded in-memory queues (oldest events are dropped and
 * counted when full). The worker flushes the emitter via ctx.waitUntil() at the end
 * of every fetch and scheduled invocation (see flushAuditEvents()).
 */

import { AuditEvent, AuditEventSeverity } from './audit-events';

/** Default upper bound for any sink's in-memory queue */
export const DEFAULT_MAX_QUEUE_SIZE = 1000;

/**
 * Push an event onto a bounded queue, dropping the oldest event when full.
 * Returns the dropped event (if any) so callers can account for it.
 */
function pushBounded(queue: AuditEvent[], event: AuditEvent, maxSize: number, sinkName: string): AuditEvent | undefined {
  let dropped: AuditEvent | undefined;
  if (queue.length >= maxSize) {
    dropped = queue.shift();
    if (dropped) {
      const log = dropped.severity === AuditEventSeverity.CRITICAL ? console.error : console.warn;
      log(`[${sinkName}] audit queue full (${maxSize}); dropped oldest event`, {
        eventType: dropped.eventType,
        timestamp: dropped.timestamp,
      });
    }
  }
  queue.push(event);
  return dropped;
}

/**
 * Audit event sink interface
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
   * Whether the sink still holds undelivered events
   */
  hasPendingEvents?(): boolean;
}

/**
 * Stdout sink - writes events to console as JSON
 */
export class StdoutSink implements AuditEventSink {
  name = 'stdout';

  async emit(event: AuditEvent): Promise<void> {
    // Output as structured JSON for parsing by log aggregators
    try {
      console.info(JSON.stringify({
        type: 'audit_event',
        event,
      }));
    } catch (error) {
      // Handle circular references or other JSON serialization errors
      console.error('Failed to stringify audit event:', error);
      console.info(JSON.stringify({
        type: 'audit_event',
        event: {
          ...event,
          metadata: '[Circular or Invalid JSON]',
        },
      }));
    }
  }
}

/**
 * Webhook sink - sends events to an HTTP endpoint with retry logic
 */
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
  private maxQueueSize: number;

  // New properties for retry and DLQ
  private db?: D1Database;
  private maxRetries: number;
  private retryDelays: number[];
  private deliveryMetrics = {
    totalAttempts: 0,
    successfulDeliveries: 0,
    failedDeliveries: 0,
    dlqWrites: 0,
    droppedEvents: 0,
  };

  constructor(options: {
    url: string;
    secret?: string;
    batchSize?: number;
    batchTimeout?: number;
    db?: D1Database;           // D1 database for DLQ
    maxRetries?: number;       // Maximum retry attempts
    retryDelays?: number[];    // Custom retry delays in ms
    maxQueueSize?: number;     // Upper bound for queued events (drop-oldest)
  }) {
    this.url = options.url;
    this.secret = options.secret;
    this.batchSize = options.batchSize ?? 10;
    this.batchTimeout = options.batchTimeout ?? 5000; // 5 seconds
    this.db = options.db;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelays = options.retryDelays ?? [1000, 2000, 4000]; // Default exponential backoff
    this.maxQueueSize = Math.max(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, this.batchSize);

    // Validate webhook secret strength
    if (options.secret && options.secret.length < 32) {
      throw new Error('Webhook secret must be at least 32 characters for security');
    }
  }

  /**
   * Set ExecutionContext for async operations
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }

  async emit(event: AuditEvent): Promise<void> {
    if (pushBounded(this.eventQueue, event, this.maxQueueSize, 'WebhookSink')) {
      this.deliveryMetrics.droppedEvents++;
    }

    // Flush if batch size reached and not already flushing
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      // Schedule flush if not already scheduled and not currently flushing
      if (!this.flushTimer && !this.flushing) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          const flushPromise = this.flush();

          if (this.ctx) {
            this.ctx.waitUntil(flushPromise);
          } else {
            flushPromise.catch(console.error);
          }
        }, this.batchTimeout);
      }
    }
  }

  hasPendingEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  async flush(): Promise<void> {
    // Prevent concurrent flush operations (Issue #2 - Race condition)
    if (this.flushing) {
      return;
    }
    this.flushing = true;

    try {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      if (this.eventQueue.length === 0) {
        return;
      }

      const events = [...this.eventQueue];
      this.eventQueue = [];

      const body = JSON.stringify({ events });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'AlUmmahNow-Auth/1.0',
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

      // Attempt delivery with retry logic
      try {
        this.deliveryMetrics.totalAttempts++;

        const response = await this.fetchWithRetry(this.url, {
          method: 'POST',
          headers,
          body,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        this.deliveryMetrics.successfulDeliveries++;
        console.info(`Webhook delivery successful: ${events.length} events delivered`);

      } catch (error) {
        this.deliveryMetrics.failedDeliveries++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.error('Webhook delivery failed after retries:', {
          error: errorMessage,
          eventCount: events.length,
          url: this.url,
        });

        // Store in DLQ if database is available
        if (this.db) {
          await this.storeToDLQ(events, errorMessage);
        } else {
          // Fallback: log events that would go to DLQ
          console.error('DLQ not configured. Lost events:', JSON.stringify({ events, error: errorMessage }));
        }
      }
    } finally {
      // Always reset flushing flag
      this.flushing = false;
    }
  }

  /**
   * Fetch with exponential backoff retry logic
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attemptNumber: number = 1
  ): Promise<Response> {
    const startTime = Date.now();

    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout per request

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Success - return the response
      if (response.ok) {
        const duration = Date.now() - startTime;
        console.debug(`Webhook delivery succeeded on attempt ${attemptNumber} (${duration}ms)`);
        return response;
      }

      // Client error (4xx) - don't retry
      if (response.status >= 400 && response.status < 500) {
        console.warn(`Webhook delivery failed with client error ${response.status} - not retrying`);
        return response;
      }

      // Server error (5xx) - retry if attempts remain
      if (attemptNumber < this.maxRetries) {
        const delay = this.getRetryDelay(attemptNumber);
        console.debug(`Webhook delivery failed with ${response.status}, retrying in ${delay}ms (attempt ${attemptNumber}/${this.maxRetries})`);

        await this.sleep(delay);
        return this.fetchWithRetry(url, options, attemptNumber + 1);
      }

      // Exhausted retries
      return response;

    } catch (error) {
      const duration = Date.now() - startTime;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      const errorMessage = isTimeout ? 'Request timeout' : (error instanceof Error ? error.message : String(error));

      console.error(`Webhook delivery error on attempt ${attemptNumber} (${duration}ms):`, errorMessage);

      // Retry if attempts remain
      if (attemptNumber < this.maxRetries) {
        const delay = this.getRetryDelay(attemptNumber);
        console.debug(`Retrying in ${delay}ms (attempt ${attemptNumber}/${this.maxRetries})`);

        await this.sleep(delay);
        return this.fetchWithRetry(url, options, attemptNumber + 1);
      }

      // Exhausted retries - throw the error
      throw error;
    }
  }

  /**
   * Calculate retry delay with jitter
   */
  private getRetryDelay(attemptNumber: number): number {
    const baseDelay = this.retryDelays[Math.min(attemptNumber - 1, this.retryDelays.length - 1)];

    // Add jitter (±20%) to prevent thundering herd
    const jitter = baseDelay * 0.2 * (Math.random() - 0.5);
    return Math.floor(baseDelay + jitter);
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Store failed events to Dead Letter Queue
   */
  private async storeToDLQ(events: AuditEvent[], error: string): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      const result = await this.db.prepare(
        `INSERT INTO webhook_dlq (events, webhook_url, error, timestamp, retry_count)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        JSON.stringify(events),
        this.url,
        error,
        new Date().toISOString(),
        this.maxRetries
      ).run();

      this.deliveryMetrics.dlqWrites++;

      // Log only non-sensitive metadata
      console.info(`Stored ${events.length} events to DLQ`, {
        dlqId: result.meta.last_row_id,
        eventTypes: events.map(e => e.eventType),
        timestamp: new Date().toISOString(),
      });
    } catch (dlqError) {
      // Critical: Failed to store in DLQ - last resort logging
      console.error('CRITICAL: Failed to store events in DLQ:', dlqError);

      // Log only event metadata to avoid leaking sensitive information
      const eventMetadata = events.map(e => ({
        type: e.eventType,
        timestamp: e.timestamp,
        severity: e.severity,
      }));
      console.error(
        `Lost ${events.length} events. Metadata:`,
        JSON.stringify(eventMetadata)
      );
    }
  }

  /**
   * Get delivery metrics for monitoring
   */
  getMetrics(): typeof this.deliveryMetrics {
    return { ...this.deliveryMetrics };
  }
}

/**
 * D1 Database sink - stores events in D1 for querying
 */
export class D1Sink implements AuditEventSink {
  name = 'd1';
  private db: D1Database;
  private batchSize: number;
  private batchTimeout: number;
  private eventQueue: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: ExecutionContext | null = null;
  private flushing = false;

  private maxQueueSize: number;
  private droppedEvents = 0;

  constructor(db: D1Database, options?: {
    batchSize?: number;
    batchTimeout?: number;
    maxQueueSize?: number;
  }) {
    this.db = db;
    this.batchSize = options?.batchSize ?? 20;
    this.batchTimeout = options?.batchTimeout ?? 3000; // 3 seconds
    this.maxQueueSize = Math.max(options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, this.batchSize);
  }

  hasPendingEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  getMetrics(): { queueSize: number; maxQueueSize: number; droppedEvents: number } {
    return { queueSize: this.eventQueue.length, maxQueueSize: this.maxQueueSize, droppedEvents: this.droppedEvents };
  }

  /**
   * Set ExecutionContext for async operations
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }

  async emit(event: AuditEvent): Promise<void> {
    if (pushBounded(this.eventQueue, event, this.maxQueueSize, 'D1Sink')) {
      this.droppedEvents++;
    }

    // Flush if batch size reached and not already flushing
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      // Schedule flush if not already scheduled and not currently flushing
      if (!this.flushTimer && !this.flushing) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
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
    }
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

      const results = await this.db.batch(statements);

      // Check if any individual statement failed
      results.forEach((result, index) => {
        if (!result.success) {
          console.error(`D1 batch statement ${index} failed:`, result.error);
          // Log the failed event to stdout as backup
          console.error(JSON.stringify({
            type: 'audit_event_backup',
            event: events[index],
            error: result.error,
          }));
        }
      });
    } catch (error) {
      console.error('D1 audit event storage error:', error);
      // Events are lost if D1 write fails - consider fallback to stdout
      // In production, you might want to write to stdout as backup
      console.error(JSON.stringify({
        type: 'audit_events_backup',
        events,
        error: String(error),
      }));
    }
  }
}

/**
 * Message published to AUDIT_QUEUE for application audit events.
 * `type` distinguishes these from OpenAuth token-usage messages on the same queue.
 */
export interface AppAuditQueueMessage {
  version: 1;
  type: 'app_audit_event';
  event: AuditEvent;
  enqueued_at: number;
}

/** Cloudflare Queues sendBatch limit */
const QUEUE_SEND_BATCH_LIMIT = 100;

/**
 * Queue sink - buffers events and publishes them to a Cloudflare Queue
 * (AUDIT_QUEUE). Buffered events are sent when the batch fills and when the
 * emitter is flushed at the end of the request.
 */
export class QueueSink implements AuditEventSink {
  name = 'queue';
  private queue: Queue;
  private batchSize: number;
  private maxQueueSize: number;
  private buffer: AuditEvent[] = [];
  private droppedEvents = 0;
  private sentEvents = 0;
  private failedSends = 0;

  constructor(queue: Queue, options?: { batchSize?: number; maxQueueSize?: number }) {
    this.queue = queue;
    this.batchSize = Math.min(Math.max(options?.batchSize ?? 25, 1), QUEUE_SEND_BATCH_LIMIT);
    this.maxQueueSize = Math.max(options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, this.batchSize);
  }

  async emit(event: AuditEvent): Promise<void> {
    if (pushBounded(this.buffer, event, this.maxQueueSize, 'QueueSink')) {
      this.droppedEvents++;
    }
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    while (this.buffer.length > 0) {
      const events = this.buffer.splice(0, QUEUE_SEND_BATCH_LIMIT);
      const now = Date.now();
      try {
        await this.queue.sendBatch(
          events.map((event) => ({
            body: { version: 1, type: 'app_audit_event', event, enqueued_at: now } satisfies AppAuditQueueMessage,
          }))
        );
        this.sentEvents += events.length;
      } catch (error) {
        this.failedSends++;
        // Keep events for the next flush if there is room; otherwise log them so
        // they are still recoverable from Workers logs.
        if (this.buffer.length + events.length <= this.maxQueueSize) {
          this.buffer.unshift(...events);
        } else {
          console.error(JSON.stringify({ type: 'audit_events_backup', sink: 'queue', events, error: String(error) }));
        }
        console.error('[QueueSink] Failed to publish audit events:', error);
        return;
      }
    }
  }

  hasPendingEvents(): boolean {
    return this.buffer.length > 0;
  }

  getMetrics(): { queueSize: number; maxQueueSize: number; droppedEvents: number; sentEvents: number; failedSends: number } {
    return {
      queueSize: this.buffer.length,
      maxQueueSize: this.maxQueueSize,
      droppedEvents: this.droppedEvents,
      sentEvents: this.sentEvents,
      failedSends: this.failedSends,
    };
  }
}

/**
 * Audit Event Emitter
 *
 * Manages multiple sinks and emits events to all of them
 */
export class AuditEmitter {
  private sinks: AuditEventSink[] = [];
  private ctx: ExecutionContext | null = null;

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
        (sink as { setContext: (ctx: ExecutionContext) => void }).setContext(ctx);
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
   * Whether any sink still holds undelivered events
   */
  hasPendingEvents(): boolean {
    return this.sinks.some(sink => typeof sink.hasPendingEvents === 'function' && sink.hasPendingEvents());
  }

  /**
   * Get all configured sinks
   */
  getSinks(): AuditEventSink[] {
    return [...this.sinks];
  }
}

export interface AuditEmitterOptions {
  enableStdout?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  db?: D1Database;
  /** AUDIT_QUEUE binding. When set, events are published to the queue instead of written to D1 directly. */
  queue?: Queue;
  ctx?: ExecutionContext;
  webhookRetryConfig?: {
    maxRetries?: number;
    retryDelays?: number[];
  };
  d1Config?: {
    batchSize?: number;
    batchTimeout?: number;
    maxQueueSize?: number;
  };
  queueConfig?: {
    batchSize?: number;
    maxQueueSize?: number;
  };
}

/**
 * Global audit emitter instance
 * This will be initialized in the worker's fetch/scheduled handlers
 */
let globalAuditEmitter: AuditEmitter | null = null;
let globalEmitterKey: string | null = null;
let warnedUninitialized = false;

function buildEmitter(options: AuditEmitterOptions): AuditEmitter {
  const emitter = new AuditEmitter();

  // Add stdout sink if enabled (default: true)
  if (options.enableStdout !== false) {
    emitter.addSink(new StdoutSink());
  }

  // Add webhook sink if URL is configured
  if (options.webhookUrl) {
    emitter.addSink(new WebhookSink({
      url: options.webhookUrl,
      secret: options.webhookSecret,
      db: options.db, // Pass DB for DLQ support
      maxRetries: options.webhookRetryConfig?.maxRetries,
      retryDelays: options.webhookRetryConfig?.retryDelays,
    }));
  }

  // Durable storage: prefer the queue (consumer writes audit_events), fall back to D1
  if (options.queue) {
    emitter.addSink(new QueueSink(options.queue, options.queueConfig));
  } else if (options.db) {
    emitter.addSink(new D1Sink(options.db, options.d1Config));
  }

  if (options.ctx) {
    emitter.setContext(options.ctx);
  }
  return emitter;
}

/**
 * Initialize (replace) the global audit emitter
 */
export function initializeAuditEmitter(options: AuditEmitterOptions): AuditEmitter {
  globalAuditEmitter = buildEmitter(options);
  globalEmitterKey = null;
  return globalAuditEmitter;
}

/**
 * Worker entry point helper: build the global emitter once per isolate and
 * re-bind it to the current ExecutionContext on every invocation. Reusing one
 * emitter means events buffered by a concurrent request are never orphaned:
 * whichever invocation flushes next delivers them.
 */
export function ensureAuditEmitter(options: AuditEmitterOptions): AuditEmitter {
  const key = JSON.stringify({
    stdout: options.enableStdout !== false,
    webhook: options.webhookUrl || null,
    queue: !!options.queue,
    db: !!options.db,
  });
  if (!globalAuditEmitter || globalEmitterKey !== key) {
    const previous = globalAuditEmitter;
    globalAuditEmitter = buildEmitter({ ...options, ctx: undefined });
    globalEmitterKey = key;
    if (previous?.hasPendingEvents() && options.ctx) {
      options.ctx.waitUntil(previous.flush());
    }
  }
  if (options.ctx) {
    globalAuditEmitter.setContext(options.ctx);
  }
  return globalAuditEmitter;
}

/**
 * Get the global audit emitter
 */
export function getAuditEmitter(): AuditEmitter {
  if (!globalAuditEmitter) {
    if (!warnedUninitialized) {
      warnedUninitialized = true;
      console.warn('[AuditEmitter] used before initialization; events go to stdout only');
    }
    // Lazy initialization with just stdout
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

/**
 * Flush all buffered audit events. Call via ctx.waitUntil() at the end of each
 * fetch/scheduled invocation.
 */
export async function flushAuditEvents(): Promise<void> {
  if (!globalAuditEmitter) return;
  try {
    await globalAuditEmitter.flush();
  } catch (error) {
    console.error('[AuditEmitter] flush failed:', error);
  }
}
