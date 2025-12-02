/**
 * Audit Event Emitter
 *
 * This module provides the event emission system for audit events.
 * It supports multiple sinks (stdout, webhook) for event delivery.
 */

import { AuditEvent } from './audit-events';

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

  // New properties for retry and DLQ
  private db?: D1Database;
  private maxRetries: number;
  private retryDelays: number[];
  private deliveryMetrics = {
    totalAttempts: 0,
    successfulDeliveries: 0,
    failedDeliveries: 0,
    dlqWrites: 0,
  };

  constructor(options: {
    url: string;
    secret?: string;
    batchSize?: number;
    batchTimeout?: number;
    db?: D1Database;           // D1 database for DLQ
    maxRetries?: number;       // Maximum retry attempts
    retryDelays?: number[];    // Custom retry delays in ms
  }) {
    this.url = options.url;
    this.secret = options.secret;
    this.batchSize = options.batchSize ?? 10;
    this.batchTimeout = options.batchTimeout ?? 5000; // 5 seconds
    this.db = options.db;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelays = options.retryDelays ?? [1000, 2000, 4000]; // Default exponential backoff

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
    this.eventQueue.push(event);

    // Flush if batch size reached and not already flushing
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      // Schedule flush if not already scheduled and not currently flushing
      if (!this.flushTimer && !this.flushing) {
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
    }
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

  constructor(db: D1Database, options?: {
    batchSize?: number;
    batchTimeout?: number;
  }) {
    this.db = db;
    this.batchSize = options?.batchSize ?? 20;
    this.batchTimeout = options?.batchTimeout ?? 3000; // 3 seconds
  }

  /**
   * Set ExecutionContext for async operations
   */
  setContext(ctx: ExecutionContext): void {
    this.ctx = ctx;
  }

  async emit(event: AuditEvent): Promise<void> {
    this.eventQueue.push(event);

    // Flush if batch size reached and not already flushing
    if (this.eventQueue.length >= this.batchSize) {
      if (!this.flushing) {
        await this.flush();
      }
    } else {
      // Schedule flush if not already scheduled and not currently flushing
      if (!this.flushTimer && !this.flushing) {
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
   * Get all configured sinks
   */
  getSinks(): AuditEventSink[] {
    return [...this.sinks];
  }
}

/**
 * Global audit emitter instance
 * This will be initialized in the worker's fetch handler
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
  webhookRetryConfig?: {
    maxRetries?: number;
    retryDelays?: number[];
  };
  d1Config?: {
    batchSize?: number;
    batchTimeout?: number;
  };
}): AuditEmitter {
  const emitter = new AuditEmitter();

  if (options.ctx) {
    emitter.setContext(options.ctx);
  }

  // Add stdout sink if enabled (default: true)
  if (options.enableStdout !== false) {
    emitter.addSink(new StdoutSink());
  }

  // Add webhook sink if URL is configured
  if (options.webhookUrl) {
    const webhookSink = new WebhookSink({
      url: options.webhookUrl,
      secret: options.webhookSecret,
      db: options.db, // Pass DB for DLQ support
      maxRetries: options.webhookRetryConfig?.maxRetries,
      retryDelays: options.webhookRetryConfig?.retryDelays,
    });
    if (options.ctx) {
      webhookSink.setContext(options.ctx);
    }
    emitter.addSink(webhookSink);
  }

  // Add D1 sink if database is provided
  if (options.db) {
    const d1Sink = new D1Sink(options.db, options.d1Config);
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
