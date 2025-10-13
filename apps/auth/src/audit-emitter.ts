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
    console.log(JSON.stringify({
      type: 'audit_event',
      event,
    }));
  }
}

/**
 * Webhook sink - sends events to an HTTP endpoint
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

      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        console.error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
        // In a production system, you might want to implement retry logic here
      }
    } catch (error) {
      console.error('Webhook delivery error:', error);
      // In a production system, you might want to implement retry logic or dead letter queue
    }
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

      await this.db.batch(statements);
    } catch (error) {
      console.error('D1 audit event storage error:', error);
      // Events are lost if D1 write fails - consider fallback to stdout
      // In production, you might want to write to stdout as backup
      console.log(JSON.stringify({
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
    });
    if (options.ctx) {
      webhookSink.setContext(options.ctx);
    }
    emitter.addSink(webhookSink);
  }

  // Add D1 sink if database is provided
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
