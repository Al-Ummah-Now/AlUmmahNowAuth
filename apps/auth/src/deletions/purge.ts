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

/**
 * Hard-deletes one soft-deleted item now and drops it from the list. False when
 * it is not in the list (restored meanwhile). Throws when the kind's purge
 * fails; the caller records the failure. Audit-logged like every purge.
 */
export async function purgeItem(env: DeletionEnv, kind: DeletionKind, itemId: string): Promise<boolean> {
	const store = new DeletionStore(env.AUTH_DB);
	// Restored meanwhile: the row is gone, so there is nothing to purge
	const current = await store.get(kind, itemId);
	if (!current) return false;
	await HANDLERS[kind].purge(env, current);
	await store.removeStatement(kind, itemId).run();
	await auditDeletion(
		AuditEventType.ADMIN_ITEM_PURGED,
		null,
		{
			kind,
			item_id: itemId,
			label: current.label,
			deleted_by: current.deleted_by,
			deleted_at: current.deleted_at,
			requested_by: current.purge_requested_by,
			trigger: current.purge_requested_at !== null ? 'requested' : 'retention',
		},
		AuditEventSeverity.CRITICAL
	);
	return true;
}

export async function purgeDeleted(env: DeletionEnv, opts: { now?: number; limit?: number } = {}): Promise<PurgeResult> {
	const now = opts.now ?? Date.now();
	const store = new DeletionStore(env.AUTH_DB);
	const result: PurgeResult = { purged: zero(), failed: zero() };
	const due = await store.due(now, opts.limit ?? PURGE_BATCH);
	for (const row of due) {
		try {
			if (await purgeItem(env, row.kind, row.item_id)) result.purged[row.kind]++;
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
