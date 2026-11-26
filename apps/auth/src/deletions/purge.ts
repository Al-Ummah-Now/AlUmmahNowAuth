/**
 * The cleanup: the only code that hard-deletes what an admin deleted. Runs
 * hourly from the auth worker's cron (cron/token-cron.ts). Each run removes at
 * most PURGE_BATCH items that are due (deleted 30+ days ago, or marked for
 * permanent deletion by an admin), oldest first; an item that fails stays in
 * the list with its error and is retried on the next run, after the others.
 */
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import { HANDLERS, PURGE_TIME_BUDGET_MS, type DeletionEnv, type PurgeOptions } from './kinds';
import { auditDeletion } from './service';
import { DeletionStore, type DeletionKind } from './store';

export const PURGE_BATCH = 25;

export interface PurgeResult {
	purged: Record<DeletionKind, number>;
	failed: Record<DeletionKind, number>;
}

const zero = (): Record<DeletionKind, number> => ({ user: 0, client: 0, role: 0, theme: 0, tenant: 0 });

/**
 * Hard-deletes one soft-deleted item now and drops it from the list. False when
 * it is no longer in the list or needs another run. Throws when the kind's purge
 * fails; the caller records the failure. Audit-logged like every purge.
 */
export async function purgeItem(env: DeletionEnv, kind: DeletionKind, itemId: string, opts?: PurgeOptions): Promise<boolean> {
	const deadline = opts?.deadline ?? Date.now() + PURGE_TIME_BUDGET_MS;
	if (Date.now() >= deadline) return false;
	const store = new DeletionStore(env.AUTH_DB);
	// Restored meanwhile: the row is gone, so there is nothing to purge
	const current = await store.get(kind, itemId);
	if (!current || Date.now() >= deadline) return false;
	const outcome = await HANDLERS[kind].purge(env, current, { ...opts, deadline });
	if (outcome === 'deferred') return false;
	if (kind !== 'user' && kind !== 'tenant') await store.removeStatement(kind, itemId).run();
	const trigger = current.purge_requested_at !== null ? 'requested' : 'retention';
	await auditDeletion(
		AuditEventType.ADMIN_ITEM_PURGED,
		null,
		kind === 'user'
			? { kind, trigger }
			: {
					kind,
					item_id: itemId,
					label: current.label,
					deleted_by: current.deleted_by,
					deleted_at: current.deleted_at,
					requested_by: current.purge_requested_by,
					trigger,
				},
		AuditEventSeverity.CRITICAL
	);
	return true;
}

export async function purgeDeleted(
	env: DeletionEnv,
	opts: { now?: number; limit?: number; timeBudgetMs?: number; auditRedaction?: PurgeOptions['auditRedaction'] } = {}
): Promise<PurgeResult> {
	// The due query, item starts and redaction batches share a deadline.
	// Let an item finish once it starts credential or resource cleanup.
	const start = Date.now();
	const deadline = start + (opts.timeBudgetMs ?? PURGE_TIME_BUDGET_MS);
	const now = opts.now ?? start;
	const store = new DeletionStore(env.AUTH_DB);
	const result: PurgeResult = { purged: zero(), failed: zero() };
	const due = await store.due(now, opts.limit ?? PURGE_BATCH);
	for (const row of due) {
		if (Date.now() >= deadline) break;
		try {
			if (await purgeItem(env, row.kind, row.item_id, { auditRedaction: opts.auditRedaction, deadline })) {
				result.purged[row.kind]++;
			}
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
