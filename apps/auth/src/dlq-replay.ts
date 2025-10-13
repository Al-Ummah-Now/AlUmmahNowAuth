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
