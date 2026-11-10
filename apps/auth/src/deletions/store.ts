/**
 * The "recently deleted" list (admin_deletions, migration 0027): one row per
 * item an admin deleted. The row is what makes an item soft-deleted: listings
 * leave out every item with a row here, restore removes the row, and the
 * hourly cleanup (purge.ts) hard-deletes the item and then the row.
 */

export const DELETION_KINDS = ['user', 'client', 'role', 'theme'] as const;
export type DeletionKind = (typeof DELETION_KINDS)[number];

export const isDeletionKind = (value: unknown): value is DeletionKind =>
	typeof value === 'string' && (DELETION_KINDS as readonly string[]).includes(value);

/** Days a deleted item stays restorable before the cleanup removes it. */
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Longest accepted reason (characters). */
export const MAX_REASON_LENGTH = 500;

export interface DeletionRow {
	kind: DeletionKind;
	item_id: string;
	tenant_id: string;
	label: string | null;
	deleted_at: number;
	deleted_by: string;
	deleted_by_email: string | null;
	reason: string | null;
	purge_requested_at: number | null;
	purge_requested_by: string | null;
	snapshot: string | null;
	attempts: number;
	last_error: string | null;
}

export interface NewDeletion {
	kind: DeletionKind;
	itemId: string;
	tenantId: string;
	label: string | null;
	deletedBy: string;
	deletedByEmail?: string | null;
	reason?: string | null;
	snapshot?: unknown;
	now: number;
}

/** The SQL that hides an item: `NOT EXISTS (<this>)` with the item's id column. */
export const deletedClause = (kind: DeletionKind, idColumn: string) =>
	`SELECT 1 FROM admin_deletions d WHERE d.kind = '${kind}' AND d.item_id = ${idColumn}`;

export function cleanReason(reason: unknown): string | null {
	if (typeof reason !== 'string') return null;
	const trimmed = reason.trim();
	return trimmed ? trimmed.slice(0, MAX_REASON_LENGTH) : null;
}

/** When the cleanup will remove the item: now if an admin asked for it, else 30 days after deletion. */
export const purgeDueAt = (row: Pick<DeletionRow, 'deleted_at' | 'purge_requested_at'>) =>
	row.purge_requested_at ?? row.deleted_at + RETENTION_MS;

export class DeletionStore {
	constructor(private db: D1Database) {}

	insertStatement(d: NewDeletion): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO admin_deletions (kind, item_id, tenant_id, label, deleted_at, deleted_by, deleted_by_email, reason, snapshot)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
			)
			.bind(
				d.kind,
				d.itemId,
				d.tenantId,
				d.label,
				d.now,
				d.deletedBy,
				d.deletedByEmail ?? null,
				cleanReason(d.reason),
				d.snapshot === undefined ? null : JSON.stringify(d.snapshot)
			);
	}

	async get(kind: DeletionKind, itemId: string): Promise<DeletionRow | null> {
		return this.db.prepare('SELECT * FROM admin_deletions WHERE kind = ? AND item_id = ?').bind(kind, itemId).first<DeletionRow>();
	}

	async isDeleted(kind: DeletionKind, itemId: string): Promise<boolean> {
		return !!(await this.db.prepare('SELECT 1 FROM admin_deletions WHERE kind = ? AND item_id = ?').bind(kind, itemId).first());
	}

	/** Item ids of one kind that are deleted (for filtering a listing another library builds). */
	async deletedIds(kind: DeletionKind): Promise<Set<string>> {
		const { results } = await this.db.prepare('SELECT item_id FROM admin_deletions WHERE kind = ?').bind(kind).all<{ item_id: string }>();
		return new Set((results ?? []).map((r) => r.item_id));
	}

	async list(kind?: DeletionKind, tenantId = 'default'): Promise<DeletionRow[]> {
		const sql = kind
			? 'SELECT * FROM admin_deletions WHERE tenant_id = ? AND kind = ? ORDER BY deleted_at DESC LIMIT 500'
			: 'SELECT * FROM admin_deletions WHERE tenant_id = ? ORDER BY deleted_at DESC LIMIT 500';
		const stmt = kind ? this.db.prepare(sql).bind(tenantId, kind) : this.db.prepare(sql).bind(tenantId);
		return (await stmt.all<DeletionRow>()).results ?? [];
	}

	removeStatement(kind: DeletionKind, itemId: string): D1PreparedStatement {
		return this.db.prepare('DELETE FROM admin_deletions WHERE kind = ? AND item_id = ?').bind(kind, itemId);
	}

	/** Marks the item for the cleanup's next run. Returns false when it is not (or no longer) deleted. */
	async requestPurge(kind: DeletionKind, itemId: string, by: string, now: number): Promise<boolean> {
		const res = await this.db
			.prepare(
				`UPDATE admin_deletions SET purge_requested_at = COALESCE(purge_requested_at, ?3), purge_requested_by = COALESCE(purge_requested_by, ?4)
				 WHERE kind = ?1 AND item_id = ?2`
			)
			.bind(kind, itemId, now, by)
			.run();
		return (res.meta?.changes ?? 0) > 0;
	}

	/** Items the cleanup should remove now: asked for, or deleted 30+ days ago. Failing items go last. */
	async due(now: number, limit: number): Promise<DeletionRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM admin_deletions
				 WHERE purge_requested_at IS NOT NULL OR deleted_at <= ?1
				 ORDER BY attempts, COALESCE(purge_requested_at, deleted_at)
				 LIMIT ?2`
			)
			.bind(now - RETENTION_MS, limit)
			.all<DeletionRow>();
		return results ?? [];
	}

	async recordFailure(kind: DeletionKind, itemId: string, error: string): Promise<void> {
		await this.db
			.prepare('UPDATE admin_deletions SET attempts = attempts + 1, last_error = ? WHERE kind = ? AND item_id = ?')
			.bind(error.slice(0, 500), kind, itemId)
			.run();
	}
}
