/**
 * Bounded, resumable backfill and maintenance for audit_daily_counts and
 * audit_hourly_counts (AlUmmahNowAuth#514, AUN-D1-SCALING D1-4).
 *
 * Migration 0052 installs an AFTER INSERT trigger on audit_events and records
 * the pre-migration watermark (cutoff_rowid, cutoff_ts) in auth_settings.
 * This job walks pre-migration audit_events inside the 90-day stats window in
 * small indexed slices (via idx_audit_events_timestamp), skips any row with
 * rowid > cutoff_rowid (already counted by the trigger), and commits the
 * aggregated deltas + compare-and-swap cursor update in one atomic D1 batch
 * so neither a mid-batch crash nor an overlapping runner can double-count.
 */

export const AUDIT_COUNTS_BACKFILL_KEY = 'audit_daily_counts_backfill';
export const AUDIT_STATS_RETENTION_DAYS = 90;
export const AUDIT_HOURLY_RETENTION_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 10;
const DEFAULT_TIME_BUDGET_MS = 2_000;

export interface AuditCountsBackfillState {
	cutoff_rowid: number;
	cutoff_ts: string;
	cursor_ts: string;
	cursor_rowid: number;
	done: 0 | 1;
}

export interface BackfillResult {
	processed: number;
	batches: number;
	done: boolean;
	/** True if another concurrent runner advanced the cursor before our batch committed. */
	conflicted?: boolean;
}

/** UTC calendar day string `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** UTC hour bucket string `YYYY-MM-DDTHH`. */
export function utcHour(ms: number): string {
	return new Date(ms).toISOString().slice(0, 13);
}

/**
 * Exact SQL statements executed by this module; exported so tests can verify
 * every statement's EXPLAIN QUERY PLAN uses an index without temp B-trees.
 */
export const AUDIT_COUNTS_MAINTENANCE_SQL = {
	backfillFirst: `
		SELECT rowid AS row_id, timestamp, event_type, severity
		FROM audit_events
		WHERE timestamp >= ?1 AND timestamp <= ?2
		ORDER BY timestamp ASC, rowid ASC
		LIMIT ?3
	`,
	backfillNext: `
		SELECT rowid AS row_id, timestamp, event_type, severity
		FROM audit_events
		WHERE (timestamp, rowid) > (?1, ?2) AND timestamp <= ?3
		ORDER BY timestamp ASC, rowid ASC
		LIMIT ?4
	`,
	upsertDailyCas: `
		INSERT INTO audit_daily_counts (day, event_type, severity, n)
		SELECT ?1, ?2, ?3, ?4
		WHERE EXISTS (SELECT 1 FROM auth_settings WHERE key = ?5 AND value = ?6)
		ON CONFLICT(day, event_type, severity) DO UPDATE SET n = n + excluded.n
	`,
	upsertHourlyCas: `
		INSERT INTO audit_hourly_counts (hour, event_type, severity, n)
		SELECT ?1, ?2, ?3, ?4
		WHERE EXISTS (SELECT 1 FROM auth_settings WHERE key = ?5 AND value = ?6)
		ON CONFLICT(hour, event_type, severity) DO UPDATE SET n = n + excluded.n
	`,
	updateCursorCas: `
		UPDATE auth_settings
		SET value = ?1, updated_at = ?2, updated_by = ?3
		WHERE key = ?4 AND value = ?5
	`,
	pruneHourly: `DELETE FROM audit_hourly_counts WHERE hour < ?1`,
	pruneDaily: `DELETE FROM audit_daily_counts WHERE day < ?1`,
} as const;

export function parseBackfillState(raw: string | null | undefined): AuditCountsBackfillState | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<AuditCountsBackfillState>;
		if (
			typeof parsed.cutoff_rowid !== 'number' ||
			typeof parsed.cutoff_ts !== 'string' ||
			typeof parsed.cursor_ts !== 'string' ||
			typeof parsed.cursor_rowid !== 'number' ||
			(parsed.done !== 0 && parsed.done !== 1)
		) {
			return null;
		}
		return parsed as AuditCountsBackfillState;
	} catch {
		return null;
	}
}

/** True while historical backfill has not yet folded all pre-migration rows. */
export function isAuditCountsBackfillPending(rawValue: string | null | undefined): boolean {
	const state = parseBackfillState(rawValue);
	return state !== null && state.done === 0 && state.cutoff_rowid > 0 && state.cutoff_ts.length > 0;
}

interface BackfillRow {
	row_id: number;
	timestamp: string;
	event_type: string;
	severity: string;
}

/**
 * Folds up to `maxBatches * batchSize` pre-migration audit_events rows within
 * the 90-day stats window into audit_daily_counts (and the last 48 hours into
 * audit_hourly_counts). Safe to re-run on every hourly cron and safe under
 * overlapping runners: every count upsert is guarded by the expected cursor
 * value and committed in the same D1 batch as the compare-and-swap cursor
 * update.
 */
export async function backfillAuditCounts(
	db: D1Database,
	options: {
		now?: number;
		batchSize?: number;
		maxBatches?: number;
		timeBudgetMs?: number;
		/** Test hook: runs right before the batch commit to simulate an overlapping runner. */
		beforeBatchCommit?: () => Promise<void>;
	} = {}
): Promise<BackfillResult> {
	const now = options.now ?? Date.now();
	const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 2000));
	const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);
	const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

	const setting = await db
		.prepare('SELECT value FROM auth_settings WHERE key = ?1')
		.bind(AUDIT_COUNTS_BACKFILL_KEY)
		.first<{ value: string }>();

	if (!setting) {
		return { processed: 0, batches: 0, done: true };
	}

	let expectedRaw = setting.value;
	const state = parseBackfillState(expectedRaw);
	if (!state || state.done === 1 || state.cutoff_rowid <= 0 || !state.cutoff_ts) {
		return { processed: 0, batches: 0, done: true };
	}

	const windowStart = utcDay(now - (AUDIT_STATS_RETENTION_DAYS - 1) * DAY_MS);
	const hourlyCutoff = utcHour(now - AUDIT_HOURLY_RETENTION_HOURS * HOUR_MS);

	// If every pre-migration row is already older than the 90-day window, mark done via CAS.
	if (state.cutoff_ts < windowStart) {
		const finishedRaw = JSON.stringify({ ...state, done: 1 } satisfies AuditCountsBackfillState);
		const res = await db
			.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.updateCursorCas)
			.bind(finishedRaw, now, 'cron:audit-counts-backfill', AUDIT_COUNTS_BACKFILL_KEY, expectedRaw)
			.run();
		return { processed: 0, batches: 0, done: (res.meta?.changes ?? 0) > 0, conflicted: (res.meta?.changes ?? 0) === 0 };
	}

	let cursorTs = state.cursor_ts;
	let cursorRowid = state.cursor_rowid;
	let done = false;
	let processed = 0;
	let batches = 0;
	const startedAt = Date.now();

	while (batches < maxBatches && (batches === 0 || Date.now() - startedAt < timeBudgetMs)) {
		const isFirst = !cursorTs || cursorTs < windowStart;
		const { results } = isFirst
			? await db
					.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.backfillFirst)
					.bind(windowStart, state.cutoff_ts, batchSize)
					.all<BackfillRow>()
			: await db
					.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.backfillNext)
					.bind(cursorTs, cursorRowid, state.cutoff_ts, batchSize)
					.all<BackfillRow>();

		const rows = results || [];
		batches++;

		if (rows.length === 0) {
			const nextRaw = JSON.stringify({
				...state,
				cursor_ts: cursorTs,
				cursor_rowid: cursorRowid,
				done: 1,
			} satisfies AuditCountsBackfillState);
			await options.beforeBatchCommit?.();
			const res = await db
				.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.updateCursorCas)
				.bind(nextRaw, now, 'cron:audit-counts-backfill', AUDIT_COUNTS_BACKFILL_KEY, expectedRaw)
				.run();
			if ((res.meta?.changes ?? 0) === 0) {
				return { processed, batches, done: false, conflicted: true };
			}
			done = true;
			break;
		}

		const dailyDeltas = new Map<string, { day: string; eventType: string; severity: string; n: number }>();
		const hourlyDeltas = new Map<string, { hour: string; eventType: string; severity: string; n: number }>();
		let batchProcessed = 0;

		for (const row of rows) {
			// Skip rows inserted after migration 0052 (already counted by the AFTER INSERT trigger).
			if (row.row_id > state.cutoff_rowid) continue;
			batchProcessed++;

			const day = row.timestamp.slice(0, 10);
			const dailyKey = `${day}\0${row.event_type}\0${row.severity}`;
			const dailyEntry = dailyDeltas.get(dailyKey);
			if (dailyEntry) {
				dailyEntry.n++;
			} else {
				dailyDeltas.set(dailyKey, { day, eventType: row.event_type, severity: row.severity, n: 1 });
			}

			const hour = row.timestamp.slice(0, 13).replace(' ', 'T');
			if (hour >= hourlyCutoff) {
				const hourlyKey = `${hour}\0${row.event_type}\0${row.severity}`;
				const hourlyEntry = hourlyDeltas.get(hourlyKey);
				if (hourlyEntry) {
					hourlyEntry.n++;
				} else {
					hourlyDeltas.set(hourlyKey, { hour, eventType: row.event_type, severity: row.severity, n: 1 });
				}
			}
		}

		const last = rows[rows.length - 1]!;
		const nextCursorTs = last.timestamp;
		const nextCursorRowid = last.row_id;
		const nextDone = rows.length < batchSize;

		const nextRaw = JSON.stringify({
			...state,
			cursor_ts: nextCursorTs,
			cursor_rowid: nextCursorRowid,
			done: nextDone ? 1 : 0,
		} satisfies AuditCountsBackfillState);

		const stmts: D1PreparedStatement[] = [];
		const dailyStmt = db.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.upsertDailyCas);
		for (const d of dailyDeltas.values()) {
			stmts.push(
				dailyStmt.bind(d.day, d.eventType, d.severity, d.n, AUDIT_COUNTS_BACKFILL_KEY, expectedRaw)
			);
		}
		const hourlyStmt = db.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.upsertHourlyCas);
		for (const h of hourlyDeltas.values()) {
			stmts.push(
				hourlyStmt.bind(h.hour, h.eventType, h.severity, h.n, AUDIT_COUNTS_BACKFILL_KEY, expectedRaw)
			);
		}
		stmts.push(
			db
				.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.updateCursorCas)
				.bind(nextRaw, now, 'cron:audit-counts-backfill', AUDIT_COUNTS_BACKFILL_KEY, expectedRaw)
		);

		await options.beforeBatchCommit?.();
		// Atomic CAS batch: upserts only apply if auth_settings still equals expectedRaw,
		// and the cursor advances in the same transaction.
		const batchResults = await db.batch(stmts);
		const casChanges = batchResults[batchResults.length - 1]?.meta?.changes ?? 0;
		if (casChanges === 0) {
			return { processed, batches, done: false, conflicted: true };
		}

		processed += batchProcessed;
		cursorTs = nextCursorTs;
		cursorRowid = nextCursorRowid;
		expectedRaw = nextRaw;
		done = nextDone;

		if (done) break;
	}

	return { processed, batches, done };
}

/**
 * Deletes audit_hourly_counts buckets older than AUDIT_HOURLY_RETENTION_HOURS
 * via the primary key prefix (hour < ?).
 */
export async function pruneAuditHourlyCounts(db: D1Database, now = Date.now()): Promise<number> {
	const cutoffHour = utcHour(now - AUDIT_HOURLY_RETENTION_HOURS * HOUR_MS);
	const res = await db
		.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.pruneHourly)
		.bind(cutoffHour)
		.run();
	return res.meta?.changes ?? 0;
}

/**
 * Deletes audit_daily_counts buckets older than AUDIT_STATS_RETENTION_DAYS
 * via the primary key prefix (day < ?) so the table stays bounded to the
 * 90-day stats window.
 */
export async function pruneAuditDailyCounts(db: D1Database, now = Date.now()): Promise<number> {
	const cutoffDay = utcDay(now - AUDIT_STATS_RETENTION_DAYS * DAY_MS);
	const res = await db
		.prepare(AUDIT_COUNTS_MAINTENANCE_SQL.pruneDaily)
		.bind(cutoffDay)
		.run();
	return res.meta?.changes ?? 0;
}
