/**
 * Admin delete, restore and "delete permanently now" for every kind of item
 * (users, OAuth clients, roles, themes). A delete hides the item and records
 * who deleted it, when and why; the hourly cleanup (purge.ts) is the only code
 * that removes data, 30 days later or on its next run after an admin asks for
 * permanent deletion. Every step is audit-logged.
 */
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { emitAuditEvent } from '../audit-emitter';
import { logger } from '../logger';
import { ThemeError } from '../themes/service';
import { DeletionError, HANDLERS, type DeletionEnv } from './kinds';
import { DeletionStore, RETENTION_DAYS, cleanReason, purgeDueAt, type DeletionKind, type DeletionRow } from './store';

export { DeletionError };

export interface DeletionActor {
	userId: string;
	email?: string | null;
	ip?: string | null;
	userAgent?: string | null;
	requestId?: string | null;
}

export interface DeletionView {
	kind: DeletionKind;
	id: string;
	label: string | null;
	deletedAt: number;
	deletedBy: string;
	deletedByEmail: string | null;
	reason: string | null;
	purgeRequestedAt: number | null;
	purgeRequestedBy: string | null;
	/** When the cleanup removes it at the latest (ms). */
	purgeAt: number;
	lastError: string | null;
}

export const toView = (row: DeletionRow): DeletionView => ({
	kind: row.kind,
	id: row.item_id,
	label: row.label,
	deletedAt: row.deleted_at,
	deletedBy: row.deleted_by,
	deletedByEmail: row.deleted_by_email,
	reason: row.reason,
	purgeRequestedAt: row.purge_requested_at,
	purgeRequestedBy: row.purge_requested_by,
	purgeAt: purgeDueAt(row),
	lastError: row.last_error,
});

export async function auditDeletion(
	eventType: AuditEventType,
	actor: DeletionActor | null,
	metadata: Record<string, unknown>,
	severity = AuditEventSeverity.WARNING
): Promise<void> {
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType,
		severity,
		userId: actor?.userId ?? null,
		ipAddress: actor?.ip ?? null,
		userAgent: actor?.userAgent ?? null,
		requestId: actor?.requestId ?? null,
		success: true,
		errorMessage: null,
		metadata: { ...metadata, actor_email: actor?.email ?? null },
	});
}

const asDeletionError = (error: unknown): unknown =>
	error instanceof ThemeError ? new DeletionError(error.status as 404, error.code, error.message) : error;

/** Soft-deletes an item. Throws DeletionError (404 unknown/already deleted, 403/409 not allowed). */
export async function softDelete(
	env: DeletionEnv,
	kind: DeletionKind,
	itemId: string,
	actor: DeletionActor,
	opts: { reason?: unknown; tenantId?: string; now?: number } = {}
): Promise<DeletionView> {
	const store = new DeletionStore(env.AUTH_DB);
	const tenantId = opts.tenantId ?? 'default';
	const now = opts.now ?? Date.now();
	if (await store.isDeleted(kind, itemId)) throw new DeletionError(404, 'already_deleted', 'Already deleted');
	let prepared;
	try {
		prepared = await HANDLERS[kind].prepare(env, itemId, { tenantId, actorId: actor.userId, now });
	} catch (error) {
		throw asDeletionError(error);
	}
	const reason = cleanReason(opts.reason);
	try {
		await env.AUTH_DB.batch([
			store.insertStatement({
				kind,
				itemId,
				tenantId,
				label: prepared.label,
				deletedBy: actor.userId,
				deletedByEmail: actor.email,
				reason,
				snapshot: prepared.snapshot,
				now,
			}),
			...prepared.statements,
		]);
	} catch (error) {
		// Two deletes at once: the primary key lets exactly one in
		if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
			throw new DeletionError(404, 'already_deleted', 'Already deleted');
		}
		throw error;
	}
	await prepared.after?.();
	logger.info('[deletions] Item deleted', { kind, itemId, by: actor.userId });
	await auditDeletion(AuditEventType.ADMIN_ITEM_DELETED, actor, { kind, item_id: itemId, label: prepared.label, reason, retention_days: RETENTION_DAYS });
	const row = await store.get(kind, itemId);
	return toView(row!);
}

export async function restore(env: DeletionEnv, kind: DeletionKind, itemId: string, actor: DeletionActor, now = Date.now()): Promise<void> {
	const store = new DeletionStore(env.AUTH_DB);
	const row = await store.get(kind, itemId);
	if (!row) throw new DeletionError(404, 'not_deleted', 'Not in Recently deleted');
	const plan = await HANDLERS[kind].restore(env, row, now);
	try {
		await env.AUTH_DB.batch([store.removeStatement(kind, itemId), ...plan.statements]);
	} catch (error) {
		if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
			throw new DeletionError(409, 'conflict', 'Another item now has the same name or email; it cannot be restored');
		}
		throw error;
	}
	await plan.after?.();
	logger.info('[deletions] Item restored', { kind, itemId, by: actor.userId });
	await auditDeletion(AuditEventType.ADMIN_ITEM_RESTORED, actor, { kind, item_id: itemId, label: row.label });
}

/**
 * "Delete permanently now": the cleanup removes the item on its next run (within
 * the hour). Nothing is removed here, and it can still be restored until then.
 * `confirm` must repeat the item's label (or id when it has none): the
 * type-to-confirm in the admin dialog, checked again here.
 */
export async function requestPurge(
	env: DeletionEnv,
	kind: DeletionKind,
	itemId: string,
	actor: DeletionActor,
	confirm: unknown,
	now = Date.now()
): Promise<DeletionView> {
	const store = new DeletionStore(env.AUTH_DB);
	const row = await store.get(kind, itemId);
	if (!row) throw new DeletionError(404, 'not_deleted', 'Not in Recently deleted');
	const expected = (row.label ?? row.item_id).trim();
	if (typeof confirm !== 'string' || confirm.trim() !== expected) {
		throw new DeletionError(400, 'confirmation_mismatch', `Type "${expected}" to confirm`);
	}
	await store.requestPurge(kind, itemId, actor.userId, now);
	logger.info('[deletions] Permanent deletion requested', { kind, itemId, by: actor.userId });
	await auditDeletion(AuditEventType.ADMIN_ITEM_PURGE_REQUESTED, actor, { kind, item_id: itemId, label: row.label }, AuditEventSeverity.CRITICAL);
	return toView((await store.get(kind, itemId))!);
}

export async function listDeleted(env: Pick<Env, 'AUTH_DB'>, kind?: DeletionKind, tenantId = 'default'): Promise<DeletionView[]> {
	return (await new DeletionStore(env.AUTH_DB).list(kind, tenantId)).map(toView);
}
