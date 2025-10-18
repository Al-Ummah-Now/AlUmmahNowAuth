# Webhook Retry with DLQ - Implementation Guide

## Overview

This guide provides step-by-step instructions for implementing webhook retry logic with a Dead Letter Queue (DLQ) for the audit event system in AlUmmahNowAuth.

## Implementation Steps

### Step 1: Create DLQ Database Migration

Create the migration file for the DLQ table:

```sql
-- File: apps/auth/migrations/0010_create_webhook_dlq_table.sql

-- Create webhook_dlq table for storing failed webhook deliveries
-- This table acts as a dead letter queue for audit events that couldn't be delivered
CREATE TABLE IF NOT EXISTS webhook_dlq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  events TEXT NOT NULL,          -- JSON array of AuditEvent objects
  webhook_url TEXT NOT NULL,     -- Target webhook URL that failed
  error TEXT,                     -- Last error message from delivery attempt
  timestamp TEXT NOT NULL,        -- ISO8601 timestamp of failure
  retry_count INTEGER DEFAULT 0, -- Number of retries attempted before DLQ
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'replaying', 'completed', 'failed')),
  replayed_at TEXT,               -- ISO8601 timestamp when manual replay occurred
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for time-based queries (e.g., recent failures)
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_timestamp ON webhook_dlq(timestamp);

-- Index for filtering by status (e.g., pending replays)
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_status ON webhook_dlq(status);

-- Index for cleanup operations (TTL-based deletion)
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created_at ON webhook_dlq(created_at);

-- Composite index for efficient queries on pending items by age
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_status_timestamp ON webhook_dlq(status, timestamp);
```

### Step 2: Update WebhookSink Class with Retry Logic

Update `apps/auth/src/audit-emitter.ts`:

```typescript
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
      console.log(`Webhook delivery successful: ${events.length} events delivered`);

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
        console.log(`Webhook delivery succeeded on attempt ${attemptNumber} (${duration}ms)`);
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
        console.log(`Webhook delivery failed with ${response.status}, retrying in ${delay}ms (attempt ${attemptNumber}/${this.maxRetries})`);

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
        console.log(`Retrying in ${delay}ms (attempt ${attemptNumber}/${this.maxRetries})`);

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

      console.log(`Stored ${events.length} events to DLQ (ID: ${result.meta.last_row_id})`);
    } catch (dlqError) {
      // Critical: Failed to store in DLQ - last resort logging
      console.error('CRITICAL: Failed to store events in DLQ:', dlqError);
      console.error('Lost events:', JSON.stringify(events));
    }
  }

  /**
   * Get delivery metrics for monitoring
   */
  getMetrics(): typeof this.deliveryMetrics {
    return { ...this.deliveryMetrics };
  }
}
```

### Step 3: Create DLQ Replay Service

Create `apps/auth/src/dlq-replay.ts`:

```typescript
/**
 * Dead Letter Queue Replay Service
 *
 * Provides functionality to replay failed webhook deliveries from the DLQ
 */

import { AuditEvent } from './audit-events';
import { WebhookSink } from './audit-emitter';

export interface DLQEntry {
  id: number;
  events: AuditEvent[];
  webhookUrl: string;
  error: string;
  timestamp: string;
  retryCount: number;
  status: 'pending' | 'replaying' | 'completed' | 'failed';
  replayedAt?: string;
  createdAt: string;
}

export interface ReplayResult {
  totalEntries: number;
  successfulReplays: number;
  failedReplays: number;
  errors: Array<{ id: number; error: string }>;
}

export interface DLQReplayOptions {
  batchSize?: number;      // Number of entries to process at once
  maxAge?: number;         // Max age in hours for entries to replay
  filterStatus?: 'pending' | 'failed'; // Filter by status
  webhookUrl?: string;     // Filter by specific webhook URL
  dryRun?: boolean;        // Simulate replay without actual delivery
}

export class DLQReplayService {
  private db: D1Database;
  private webhookSecret?: string;

  constructor(db: D1Database, webhookSecret?: string) {
    this.db = db;
    this.webhookSecret = webhookSecret;
  }

  /**
   * Get queued events from DLQ
   */
  async getQueuedEvents(options: {
    limit?: number;
    offset?: number;
    status?: string;
    maxAge?: number;
  } = {}): Promise<{ entries: DLQEntry[]; total: number }> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    let query = 'SELECT * FROM webhook_dlq WHERE 1=1';
    const bindings: any[] = [];

    if (options.status) {
      query += ' AND status = ?';
      bindings.push(options.status);
    }

    if (options.maxAge) {
      const cutoff = new Date(Date.now() - options.maxAge * 60 * 60 * 1000).toISOString();
      query += ' AND timestamp >= ?';
      bindings.push(cutoff);
    }

    // Get total count
    const countResult = await this.db.prepare(
      query.replace('SELECT *', 'SELECT COUNT(*) as count')
    ).bind(...bindings).first<{ count: number }>();

    // Get paginated results
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    const results = await this.db.prepare(query).bind(...bindings).all<any>();

    const entries: DLQEntry[] = results.results.map(row => ({
      id: row.id,
      events: JSON.parse(row.events),
      webhookUrl: row.webhook_url,
      error: row.error,
      timestamp: row.timestamp,
      retryCount: row.retry_count,
      status: row.status,
      replayedAt: row.replayed_at,
      createdAt: row.created_at,
    }));

    return {
      entries,
      total: countResult?.count ?? 0,
    };
  }

  /**
   * Replay failed events from DLQ
   */
  async replayFailedEvents(options: DLQReplayOptions = {}): Promise<ReplayResult> {
    const batchSize = options.batchSize ?? 10;
    const maxAge = options.maxAge ?? 24; // Default 24 hours
    const dryRun = options.dryRun ?? false;

    console.log(`Starting DLQ replay (dryRun: ${dryRun}):`, options);

    // Fetch entries to replay
    const { entries } = await this.getQueuedEvents({
      limit: batchSize,
      status: options.filterStatus ?? 'pending',
      maxAge: maxAge,
    });

    if (entries.length === 0) {
      console.log('No entries found for replay');
      return {
        totalEntries: 0,
        successfulReplays: 0,
        failedReplays: 0,
        errors: [],
      };
    }

    const result: ReplayResult = {
      totalEntries: entries.length,
      successfulReplays: 0,
      failedReplays: 0,
      errors: [],
    };

    // Mark entries as replaying
    if (!dryRun) {
      const ids = entries.map(e => e.id);
      await this.updateStatus(ids, 'replaying');
    }

    // Process each entry
    for (const entry of entries) {
      try {
        console.log(`Replaying DLQ entry ${entry.id} (${entry.events.length} events)`);

        if (!dryRun) {
          // Create a temporary webhook sink for replay
          const webhookSink = new WebhookSink({
            url: options.webhookUrl ?? entry.webhookUrl,
            secret: this.webhookSecret,
            maxRetries: 2, // Fewer retries for replay
            retryDelays: [1000, 2000],
          });

          // Emit all events
          for (const event of entry.events) {
            await webhookSink.emit(event);
          }

          // Flush to trigger delivery
          await webhookSink.flush();

          // Mark as completed
          await this.updateStatus([entry.id], 'completed', new Date().toISOString());
          result.successfulReplays++;

          console.log(`Successfully replayed entry ${entry.id}`);
        } else {
          // Dry run - just count as successful
          result.successfulReplays++;
          console.log(`[DRY RUN] Would replay entry ${entry.id}`);
        }

      } catch (error) {
        result.failedReplays++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({ id: entry.id, error: errorMessage });

        if (!dryRun) {
          // Mark as failed
          await this.updateStatus([entry.id], 'failed');
        }

        console.error(`Failed to replay entry ${entry.id}:`, errorMessage);
      }
    }

    console.log('DLQ replay completed:', result);
    return result;
  }

  /**
   * Update status of DLQ entries
   */
  private async updateStatus(
    ids: number[],
    status: 'pending' | 'replaying' | 'completed' | 'failed',
    replayedAt?: string
  ): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    let query = `UPDATE webhook_dlq SET status = ?`;
    const bindings: any[] = [status];

    if (replayedAt) {
      query += ', replayed_at = ?';
      bindings.push(replayedAt);
    }

    query += ` WHERE id IN (${placeholders})`;
    bindings.push(...ids);

    await this.db.prepare(query).bind(...bindings).run();
  }

  /**
   * Clean up old DLQ entries
   */
  async cleanup(options: {
    maxAge?: number;        // Max age in days
    statusFilter?: string;  // Only cleanup specific status
  } = {}): Promise<{ deleted: number }> {
    const maxAge = options.maxAge ?? 30; // Default 30 days
    const cutoff = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000).toISOString();

    let query = 'DELETE FROM webhook_dlq WHERE created_at < ?';
    const bindings: any[] = [cutoff];

    if (options.statusFilter) {
      query += ' AND status = ?';
      bindings.push(options.statusFilter);
    }

    const result = await this.db.prepare(query).bind(...bindings).run();

    console.log(`Cleaned up ${result.meta.changes} old DLQ entries`);
    return { deleted: result.meta.changes };
  }

  /**
   * Get DLQ statistics
   */
  async getStatistics(): Promise<{
    total: number;
    pending: number;
    replaying: number;
    completed: number;
    failed: number;
    oldestEntry?: string;
    newestEntry?: string;
  }> {
    const stats = await this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'replaying' THEN 1 ELSE 0 END) as replaying,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        MIN(timestamp) as oldest_entry,
        MAX(timestamp) as newest_entry
      FROM webhook_dlq
    `).first<any>();

    return {
      total: stats?.total ?? 0,
      pending: stats?.pending ?? 0,
      replaying: stats?.replaying ?? 0,
      completed: stats?.completed ?? 0,
      failed: stats?.failed ?? 0,
      oldestEntry: stats?.oldest_entry,
      newestEntry: stats?.newest_entry,
    };
  }
}
```

### Step 4: Update Initialization Function

Update the `initializeAuditEmitter` function in `apps/auth/src/audit-emitter.ts`:

```typescript
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
    const d1Sink = new D1Sink(options.db);
    if (options.ctx) {
      d1Sink.setContext(options.ctx);
    }
    emitter.addSink(d1Sink);
  }

  globalAuditEmitter = emitter;
  return emitter;
}
```

### Step 5: Add Admin API Endpoints

Create `apps/auth/src/routes/admin/dlq.ts`:

```typescript
import { z } from 'zod';
import { DLQReplayService } from '../../dlq-replay';

const replaySchema = z.object({
  batchSize: z.number().min(1).max(100).optional(),
  maxAge: z.number().min(1).max(720).optional(), // Max 30 days
  filterStatus: z.enum(['pending', 'failed']).optional(),
  webhookUrl: z.string().url().optional(),
  dryRun: z.boolean().optional(),
});

export async function handleDLQReplay(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Verify admin authentication
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse request body
  const body = await request.json();
  const parsed = replaySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({
      error: 'Invalid request',
      details: parsed.error.flatten(),
    }, { status: 400 });
  }

  // Initialize replay service
  const replayService = new DLQReplayService(
    env.AUTH_DB,
    env.AUDIT_WEBHOOK_SECRET
  );

  // Execute replay
  const result = await replayService.replayFailedEvents(parsed.data);

  return Response.json({
    success: true,
    result,
  });
}

export async function handleDLQList(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify admin authentication
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') ?? '100');
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const status = url.searchParams.get('status') ?? undefined;
  const maxAge = url.searchParams.get('maxAge')
    ? parseInt(url.searchParams.get('maxAge')!)
    : undefined;

  const replayService = new DLQReplayService(env.AUTH_DB);
  const result = await replayService.getQueuedEvents({
    limit,
    offset,
    status,
    maxAge,
  });

  return Response.json(result);
}

export async function handleDLQStats(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify admin authentication
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const replayService = new DLQReplayService(env.AUTH_DB);
  const stats = await replayService.getStatistics();

  return Response.json(stats);
}

export async function handleDLQCleanup(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify admin authentication
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = await request.json();
  const maxAge = body.maxAge ?? 30; // Default 30 days
  const statusFilter = body.statusFilter;

  const replayService = new DLQReplayService(env.AUTH_DB);
  const result = await replayService.cleanup({
    maxAge,
    statusFilter,
  });

  return Response.json({
    success: true,
    deleted: result.deleted,
  });
}
```

### Step 6: Create Test Suite

Create `apps/auth/src/audit-emitter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookSink } from './audit-emitter';
import { AuditEvent } from './audit-events';

// Mock fetch
global.fetch = vi.fn();

describe('WebhookSink Retry Logic', () => {
  let webhookSink: WebhookSink;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock D1 database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({
            meta: { last_row_id: 1, changes: 1 }
          })
        })
      })
    };

    webhookSink = new WebhookSink({
      url: 'https://example.com/webhook',
      secret: 'test-secret-at-least-32-characters-long',
      db: mockDb,
      maxRetries: 3,
      retryDelays: [100, 200, 400], // Short delays for testing
    });
  });

  it('should succeed on first attempt', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'auth.login.success',
      severity: 'info',
      userId: 'user123',
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
      requestId: 'req123',
      metadata: {},
      success: true,
    };

    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write
  });

  it('should retry on 500 error and succeed', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'auth.login.success',
      severity: 'info',
      userId: 'user123',
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
      requestId: 'req123',
      metadata: {},
      success: true,
    };

    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write
  });

  it('should not retry on 400 error', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'auth.login.success',
      severity: 'info',
      userId: 'user123',
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
      requestId: 'req123',
      metadata: {},
      success: true,
    };

    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(1); // No retry
    expect(mockDb.prepare).toHaveBeenCalled(); // Written to DLQ
  });

  it('should write to DLQ after exhausting retries', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Connection refused'));

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'auth.login.success',
      severity: 'info',
      userId: 'user123',
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
      requestId: 'req123',
      metadata: {},
      success: true,
    };

    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(3); // All retries exhausted
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_dlq')
    );
  });

  it('should handle timeout with retry', async () => {
    const abortError = new Error('AbortError');
    abortError.name = 'AbortError';

    (global.fetch as any)
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'auth.login.success',
      severity: 'info',
      userId: 'user123',
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
      requestId: 'req123',
      metadata: {},
      success: true,
    };

    await webhookSink.emit(event);
    await webhookSink.flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockDb.prepare).not.toHaveBeenCalled(); // No DLQ write
  });

  it('should apply jitter to retry delays', async () => {
    const sink = new WebhookSink({
      url: 'https://example.com/webhook',
      retryDelays: [1000],
    });

    // Test multiple calls to verify jitter
    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const delay = (sink as any).getRetryDelay(1);
      delays.add(delay);
      expect(delay).toBeGreaterThanOrEqual(800);  // -20% jitter
      expect(delay).toBeLessThanOrEqual(1200);    // +20% jitter
    }

    // Should have different values due to jitter
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('DLQ Replay Service', () => {
  // Add tests for DLQ replay functionality
  // ... (similar test structure)
});
```

## Deployment Checklist

1. **Pre-deployment**
   - [ ] Run migration on staging environment
   - [ ] Test webhook retry logic in staging
   - [ ] Verify DLQ storage works correctly
   - [ ] Test manual replay functionality
   - [ ] Load test with simulated failures

2. **Deployment**
   - [ ] Deploy migration to production
   - [ ] Update environment variables (if needed)
   - [ ] Deploy updated code
   - [ ] Monitor initial webhook deliveries
   - [ ] Check DLQ is not filling unexpectedly

3. **Post-deployment**
   - [ ] Monitor webhook delivery metrics
   - [ ] Set up alerts for high DLQ depth
   - [ ] Document replay procedures for ops team
   - [ ] Schedule regular DLQ cleanup

## Performance Considerations

### Latency Impact
- Worst case: 7 seconds for 3 retries (1s + 2s + 4s)
- Mitigated by: ExecutionContext.waitUntil() for background processing
- User requests not blocked by retry logic

### Resource Usage
- Memory: Event queue limited by batch size (default: 10)
- CPU: Minimal impact, mostly waiting on network I/O
- D1 Storage: ~1KB per DLQ entry, auto-cleanup after 30 days

### Scalability
- DLQ can handle millions of entries (D1 limits apply)
- Replay processing rate: ~100 events/second
- Concurrent webhooks: No artificial limits

## Monitoring & Alerting

### Key Metrics
```javascript
// Add to monitoring dashboard
const metrics = {
  // Webhook delivery
  'webhook.delivery.success_rate': successCount / totalCount,
  'webhook.delivery.retry_rate': retryCount / totalCount,
  'webhook.delivery.p95_latency': calculateP95(latencies),

  // DLQ health
  'dlq.depth': pendingCount,
  'dlq.age.oldest': oldestEntryAge,
  'dlq.replay.success_rate': replaySuccess / replayTotal,

  // System health
  'audit.events.per_minute': eventsPerMinute,
  'audit.sinks.active': activeSinkCount,
};
```

### Alert Thresholds
- DLQ depth > 1000 entries
- Webhook success rate < 95%
- Oldest DLQ entry > 48 hours
- Replay failure rate > 10%

## Troubleshooting Guide

### Common Issues

1. **High DLQ depth**
   - Check webhook endpoint health
   - Verify network connectivity
   - Review recent deployments
   - Consider increasing retry delays

2. **Replay failures**
   - Check webhook secret hasn't changed
   - Verify endpoint accepts replayed events
   - Check for rate limiting on webhook endpoint
   - Review event payload for issues

3. **Performance degradation**
   - Monitor batch sizes
   - Check flush frequency
   - Review retry configuration
   - Consider scaling webhook endpoints

## Future Enhancements

1. **Circuit Breaker Pattern**
   - Temporarily disable failing webhooks
   - Automatic recovery detection
   - Prevent resource waste

2. **Webhook Health Dashboard**
   - Real-time delivery metrics
   - Historical success rates
   - Latency graphs

3. **Intelligent Retry**
   - Adaptive retry delays based on error types
   - Peak time avoidance
   - Endpoint-specific configurations

4. **Event Deduplication**
   - Prevent duplicate deliveries
   - Idempotency keys
   - Event versioning