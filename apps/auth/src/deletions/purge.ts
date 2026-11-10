/**
 * The cleanup: the only code that hard-deletes what an admin deleted. Runs
 * hourly from the auth worker's cron (cron/token-cron.ts). Each run removes at
 * most PURGE_BATCH items that are due (deleted 30+ days ago, or marked for
 * permanent deletion by an admin), oldest first; an item that fails stays in
 * the list with its error and is retried on the next run, after the others.
 */
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import { HANDLERS, type DeletionEnv } from './kinds';
import { auditDeletion } from './service';
import { DeletionStore, type DeletionKind } from './store';

export const PURGE_BATCH = 25;

export interface PurgeResult {
	purged: Record<DeletionKind, number>;
	failed: Record<DeletionKind, number>;
}

const zero = (): Record<DeletionKind, number> => ({ user: 0, client: 0, role: 0, theme: 0 });

export async function purgeDeleted(env: DeletionEnv, opts: { now?: number; limit?: number } = {}): Promise<PurgeResult> {
	const now = opts.now ?? Date.now();
	const store = new DeletionStore(env.AUTH_DB);
	const result: PurgeResult = { purged: zero(), failed: zero() };
	const due = await store.due(now, opts.limit ?? PURGE_BATCH);
	for (const row of due) {
		try {
			// Restored meanwhile: the row is gone, so there is nothing to purge
			const current = await store.get(row.kind, row.item_id);
			if (!current) continue;
			await HANDLERS[row.kind].purge(env, current);
			await store.removeStatement(row.kind, row.item_id).run();
			result.purged[row.kind]++;
			await auditDeletion(
				AuditEventType.ADMIN_ITEM_PURGED,
				null,
				{
					kind: row.kind,
					item_id: row.item_id,
					label: row.label,
					deleted_by: row.deleted_by,
					deleted_at: row.deleted_at,
					requested_by: row.purge_requested_by,
					trigger: row.purge_requested_at !== null ? 'requested' : 'retention',
				},
				AuditEventSeverity.CRITICAL
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.failed[row.kind]++;
			logger.error('[deletions] Purge failed', { kind: row.kind, itemId: row.item_id, attempts: row.attempts + 1, error: message });
			await store.recordFailure(row.kind, row.item_id, message).catch(() => undefined);
		}
	}
	logger.info('[deletions] Cleanup run', { due: due.length, purged: result.purged, failed: result.failed });
	return result;
}
