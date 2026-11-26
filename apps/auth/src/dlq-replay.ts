import type { AuditEvent } from './audit-events';
import { WebhookSink } from './audit-emitter';

type DLQStatus = 'pending' | 'replaying' | 'completed' | 'failed';
const HOUR_MS = 60 * 60 * 1000;

interface DLQRow {
  id: string;
  payload: string;
  webhook_url: string;
  error_message: string | null;
  retry_count: number;
  status: DLQStatus;
  replayed_at: number | null;
  replaying_started_at: number | null;
  created_at: number;
}

export interface DLQEntry {
  id: string;
  events: AuditEvent[];
  webhookUrl: string;
  error: string;
  timestamp: string;
  retryCount: number;
  status: DLQStatus;
  replayedAt?: string;
  replayingStartedAt?: string;
  createdAt: string;
}

export interface ReplayResult {
  totalEntries: number;
  successfulReplays: number;
  failedReplays: number;
  errors: Array<{ id: string; error: string }>;
}

export interface DLQReplayOptions {
  batchSize?: number;
  maxAge?: number;
  filterStatus?: 'pending' | 'failed';
  webhookUrl?: string;
  dryRun?: boolean;
}

export class DLQReplayService {
  constructor(private db: D1Database, private webhookSecret?: string) {}

  async getQueuedEvents(options: {
    limit?: number;
    offset?: number;
    status?: string;
    maxAge?: number;
    webhookUrl?: string;
  } = {}): Promise<{ entries: DLQEntry[]; total: number }> {
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];

    if (options.status) {
      conditions.push('status = ?');
      bindings.push(options.status);
    }
    if (options.maxAge) {
      conditions.push('created_at >= ?');
      bindings.push(Date.now() - options.maxAge * HOUR_MS);
    }
    if (options.webhookUrl) {
      conditions.push('webhook_url = ?');
      bindings.push(options.webhookUrl);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.db.prepare(`SELECT COUNT(*) AS count FROM webhook_dlq ${where}`)
      .bind(...bindings).first<{ count: number }>();
    const { results } = await this.db.prepare(`
      SELECT id, payload, webhook_url, error_message, retry_count, status,
             replayed_at, replaying_started_at, created_at
      FROM webhook_dlq ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).bind(...bindings, options.limit ?? 100, options.offset ?? 0).all<DLQRow>();

    const entries = results.map(row => {
      const payload: AuditEvent | AuditEvent[] = JSON.parse(row.payload);
      const createdAt = new Date(row.created_at).toISOString();
      return {
        id: row.id,
        events: Array.isArray(payload) ? payload : [payload],
        webhookUrl: row.webhook_url,
        error: row.error_message ?? '',
        timestamp: createdAt,
        retryCount: row.retry_count,
        status: row.status,
        replayedAt: row.replayed_at === null ? undefined : new Date(row.replayed_at).toISOString(),
        replayingStartedAt: row.replaying_started_at === null ? undefined : new Date(row.replaying_started_at).toISOString(),
        createdAt,
      };
    });
    return { entries, total: count?.count ?? 0 };
  }

  async replayFailedEvents(options: DLQReplayOptions = {}): Promise<ReplayResult> {
    const { entries } = await this.getQueuedEvents({
      limit: options.batchSize ?? 10,
      status: options.filterStatus ?? 'pending',
      maxAge: options.maxAge ?? 24,
      webhookUrl: options.webhookUrl,
    });

    const result: ReplayResult = { totalEntries: 0, successfulReplays: 0, failedReplays: 0, errors: [] };
    if (options.dryRun) return { ...result, totalEntries: entries.length, successfulReplays: entries.length };

    for (const entry of entries) {
      const startedAt = Date.now();
      // Claim each row before sending so overlapping admin requests cannot both deliver it.
      const claim = await this.db.prepare(`
        UPDATE webhook_dlq SET status = 'replaying', replaying_started_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).bind(startedAt, startedAt, entry.id, entry.status).run();
      if (!claim.meta.changes) continue;
      result.totalEntries++;

      let errorMessage: string | null = null;
      try {
        const sink = new WebhookSink({
          url: entry.webhookUrl,
          secret: this.webhookSecret,
          maxRetries: 2,
          retryDelays: [1000],
        });
        await sink.deliverBatch(entry.events);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      const now = Date.now();
      const finished = await this.db.prepare(`
        UPDATE webhook_dlq
        SET status = ?, replayed_at = ?, replaying_started_at = NULL, updated_at = ?,
            error_message = COALESCE(?, error_message)
        WHERE id = ? AND status = 'replaying' AND replaying_started_at = ?
      `).bind(errorMessage === null ? 'completed' : 'failed',
        errorMessage === null ? now : null, now, errorMessage, entry.id, startedAt).run();

      if (!finished.meta.changes) errorMessage = 'Replay claim expired before completion';
      if (errorMessage === null) {
        result.successfulReplays++;
      } else {
        result.failedReplays++;
        result.errors.push({ id: entry.id, error: errorMessage });
      }
    }

    return result;
  }

  async cleanup(options: {
    maxAge?: number;
    statusFilter?: string;
  } = {}): Promise<{ deleted: number }> {
    const cutoff = Date.now() - (options.maxAge ?? 30) * 24 * HOUR_MS;
    let query = "DELETE FROM webhook_dlq WHERE created_at < ? AND status != 'replaying'";
    const bindings: (number | string)[] = [cutoff];
    if (options.statusFilter) {
      query += ' AND status = ?';
      bindings.push(options.statusFilter);
    }
    const result = await this.db.prepare(query).bind(...bindings).run();
    return { deleted: result.meta.changes };
  }

  async resetStaleReplayingEntries(options: {
    staleTimeout?: number;
    batchSize?: number;
  } = {}): Promise<{ reset: number }> {
    const now = Date.now();
    const cutoff = now - (options.staleTimeout ?? 30) * 60 * 1000;
    const result = await this.db.prepare(`
      UPDATE webhook_dlq
      SET status = 'pending', replaying_started_at = NULL, updated_at = ?
      WHERE id IN (
        SELECT id FROM webhook_dlq
        WHERE status = 'replaying'
          AND (replaying_started_at < ? OR replaying_started_at IS NULL)
        LIMIT ?
      )
    `).bind(now, cutoff, options.batchSize ?? 100).run();
    return { reset: result.meta.changes };
  }

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
        COUNT(*) AS total,
        COALESCE(SUM(status = 'pending'), 0) AS pending,
        COALESCE(SUM(status = 'replaying'), 0) AS replaying,
        COALESCE(SUM(status = 'completed'), 0) AS completed,
        COALESCE(SUM(status = 'failed'), 0) AS failed,
        MIN(created_at) AS oldest_entry,
        MAX(created_at) AS newest_entry
      FROM webhook_dlq
    `).first<Record<'total' | DLQStatus, number> & {
      oldest_entry: number | null;
      newest_entry: number | null;
    }>();

    return {
      total: stats?.total ?? 0,
      pending: stats?.pending ?? 0,
      replaying: stats?.replaying ?? 0,
      completed: stats?.completed ?? 0,
      failed: stats?.failed ?? 0,
      oldestEntry: stats?.oldest_entry == null ? undefined : new Date(stats.oldest_entry).toISOString(),
      newestEntry: stats?.newest_entry == null ? undefined : new Date(stats.newest_entry).toISOString(),
    };
  }
}
