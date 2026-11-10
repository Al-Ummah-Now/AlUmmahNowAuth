/**
 * D1 access for moderation requests (tables from migration 0022).
 */
import { allowedFrom, type CreateRequestInput, type Decision, type ModerationAction, type ModerationStatus, type ReasonCategory } from './model';

export interface Evidence {
	url: string;
	label?: string;
}

export interface ModerationRequestRow {
	id: string;
	tenant_id: string;
	client_id: string;
	subject_user_id: string;
	action: ModerationAction;
	reason_category: ReasonCategory;
	reason: string;
	evidence: string;
	requested_by_id: string;
	requested_by_name: string;
	idempotency_key: string;
	payload_hash: string;
	status: ModerationStatus;
	decision_note: string | null;
	decided_by: string | null;
	decided_at: number | null;
	actioned_at: number | null;
	action_result: string | null;
	action_error: string | null;
	created_at: number;
	updated_at: number;
}

export interface ModerationEventRow {
	id: string;
	request_id: string;
	type: string;
	actor_type: 'client' | 'admin' | 'system';
	actor_id: string;
	actor_name: string | null;
	note: string | null;
	metadata: string | null;
	created_at: number;
}

export interface Actor {
	type: 'client' | 'admin' | 'system';
	id: string;
	name?: string | null;
}

function parseEvidence(raw: string): Evidence[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/** What the requesting client sees: no auth admin identities, no internal ids. */
export function clientView(row: ModerationRequestRow, events: ModerationEventRow[] = []) {
	return {
		id: row.id,
		status: row.status,
		subject_user_id: row.subject_user_id,
		action: row.action,
		reason_category: row.reason_category,
		reason: row.reason,
		evidence: parseEvidence(row.evidence),
		requested_by: { id: row.requested_by_id, display_name: row.requested_by_name },
		decision_note: row.decision_note,
		decided_at: iso(row.decided_at),
		actioned_at: iso(row.actioned_at),
		created_at: iso(row.created_at),
		updated_at: iso(row.updated_at),
		history: events.map((e) => ({
			type: e.type,
			by: e.actor_type === 'admin' ? 'auth_admin' : e.actor_type === 'client' ? e.actor_name ?? 'client' : 'system',
			note: e.note,
			at: iso(e.created_at),
		})),
	};
}

/** What auth admins see: everything. */
export function adminView(row: ModerationRequestRow, events: ModerationEventRow[] = []) {
	return {
		...clientView(row),
		client_id: row.client_id,
		decided_by: row.decided_by,
		action_result: row.action_result ? safeJson(row.action_result) : null,
		action_error: row.action_error,
		history: events.map((e) => ({
			id: e.id,
			type: e.type,
			actor_type: e.actor_type,
			actor_id: e.actor_id,
			actor_name: e.actor_name,
			note: e.note,
			metadata: e.metadata ? safeJson(e.metadata) : null,
			at: iso(e.created_at),
		})),
	};
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

export function newRequestId(): string {
	return `modreq_${crypto.randomUUID().replace(/-/g, '')}`;
}

export class ModerationStore {
	constructor(private readonly db: D1Database) {}

	async get(id: string): Promise<ModerationRequestRow | null> {
		return this.db.prepare('SELECT * FROM moderation_requests WHERE id = ?').bind(id).first<ModerationRequestRow>();
	}

	async findByIdempotencyKey(clientId: string, key: string): Promise<ModerationRequestRow | null> {
		return this.db
			.prepare('SELECT * FROM moderation_requests WHERE client_id = ? AND idempotency_key = ?')
			.bind(clientId, key)
			.first<ModerationRequestRow>();
	}

	async countRecentByClient(clientId: string, sinceMs: number): Promise<number> {
		const row = await this.db
			.prepare('SELECT COUNT(*) AS n FROM moderation_requests WHERE client_id = ? AND created_at >= ?')
			.bind(clientId, sinceMs)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	async events(requestId: string): Promise<ModerationEventRow[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM moderation_request_events WHERE request_id = ? ORDER BY created_at ASC, rowid ASC')
			.bind(requestId)
			.all<ModerationEventRow>();
		return results ?? [];
	}

	/**
	 * Inserts the request and its "created" event. Returns null when another call
	 * with the same idempotency key won the race (UNIQUE(client_id, idempotency_key)).
	 */
	async create(params: {
		clientId: string;
		tenantId: string;
		input: CreateRequestInput;
		idempotencyKey: string;
		payloadHash: string;
		now?: number;
	}): Promise<ModerationRequestRow | null> {
		const now = params.now ?? Date.now();
		const id = newRequestId();
		const { input } = params;
		const insert = this.db
			.prepare(
				`INSERT OR IGNORE INTO moderation_requests
				(id, tenant_id, client_id, subject_user_id, action, reason_category, reason, evidence,
				 requested_by_id, requested_by_name, idempotency_key, payload_hash, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
			)
			.bind(
				id,
				params.tenantId,
				params.clientId,
				input.subject_user_id,
				input.action,
				input.reason_category,
				input.reason,
				JSON.stringify(input.evidence),
				input.requested_by.id,
				input.requested_by.display_name,
				params.idempotencyKey,
				params.payloadHash,
				now,
				now
			);
		const result = await insert.run();
		if (!result.meta?.changes) return null;
		await this.addEvent(id, 'created', { type: 'client', id: params.clientId, name: input.requested_by.display_name }, null, {
			requested_by_id: input.requested_by.id,
		}, now);
		return this.get(id);
	}

	async addEvent(requestId: string, type: string, actor: Actor, note: string | null, metadata?: Record<string, unknown> | null, now = Date.now()) {
		await this.db
			.prepare(
				`INSERT INTO moderation_request_events (id, request_id, type, actor_type, actor_id, actor_name, note, metadata, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				`mre_${crypto.randomUUID().replace(/-/g, '')}`,
				requestId,
				type,
				actor.type,
				actor.id,
				actor.name ?? null,
				note,
				metadata ? JSON.stringify(metadata) : null,
				now
			)
			.run();
	}

	/**
	 * Moves a request to `to` only if it is still in a status the decision may start
	 * from: two admins deciding at once cannot both win. Returns the updated row, or
	 * null when the request had already moved on.
	 */
	async transition(
		id: string,
		decision: Decision,
		to: ModerationStatus,
		fields: { decision_note?: string | null; decided_by?: string | null; decided?: boolean; actioned?: boolean; action_result?: unknown; action_error?: string | null },
		now = Date.now()
	): Promise<ModerationRequestRow | null> {
		const from = allowedFrom(decision);
		const sets = ['status = ?', 'updated_at = ?'];
		const values: unknown[] = [to, now];
		if (fields.decision_note !== undefined) {
			sets.push('decision_note = ?');
			values.push(fields.decision_note);
		}
		if (fields.decided_by !== undefined) {
			sets.push('decided_by = ?');
			values.push(fields.decided_by);
		}
		if (fields.decided) {
			sets.push('decided_at = ?');
			values.push(now);
		}
		if (fields.actioned) {
			sets.push('actioned_at = ?');
			values.push(now);
		}
		if (fields.action_result !== undefined) {
			sets.push('action_result = ?');
			values.push(fields.action_result === null ? null : JSON.stringify(fields.action_result));
		}
		if (fields.action_error !== undefined) {
			sets.push('action_error = ?');
			values.push(fields.action_error);
		}
		const placeholders = from.map(() => '?').join(', ');
		const result = await this.db
			.prepare(`UPDATE moderation_requests SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
			.bind(...values, id, ...from)
			.run();
		if (!result.meta?.changes) return null;
		return this.get(id);
	}

	/** Records an action failure without changing the status (stays approved; can be retried). */
	async recordActionError(id: string, error: string, now = Date.now()) {
		await this.db.prepare('UPDATE moderation_requests SET action_error = ?, updated_at = ? WHERE id = ?').bind(error, now, id).run();
	}

	async list(filters: {
		clientId?: string;
		status?: string;
		action?: string;
		subjectUserId?: string;
		from?: number;
		to?: number;
		limit: number;
		offset: number;
	}): Promise<{ rows: ModerationRequestRow[]; total: number }> {
		const where: string[] = [];
		const values: unknown[] = [];
		if (filters.clientId) {
			where.push('client_id = ?');
			values.push(filters.clientId);
		}
		if (filters.status) {
			where.push('status = ?');
			values.push(filters.status);
		}
		if (filters.action) {
			where.push('action = ?');
			values.push(filters.action);
		}
		if (filters.subjectUserId) {
			where.push('subject_user_id = ?');
			values.push(filters.subjectUserId);
		}
		if (filters.from !== undefined) {
			where.push('created_at >= ?');
			values.push(filters.from);
		}
		if (filters.to !== undefined) {
			where.push('created_at <= ?');
			values.push(filters.to);
		}
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const [{ results }, count] = await Promise.all([
			this.db
				.prepare(`SELECT * FROM moderation_requests ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
				.bind(...values, filters.limit, filters.offset)
				.all<ModerationRequestRow>(),
			this.db.prepare(`SELECT COUNT(*) AS n FROM moderation_requests ${clause}`).bind(...values).first<{ n: number }>(),
		]);
		return { rows: results ?? [], total: count?.n ?? 0 };
	}

	/** Pending + info_requested counts (the admin queue badge). */
	async openCount(): Promise<number> {
		const row = await this.db
			.prepare("SELECT COUNT(*) AS n FROM moderation_requests WHERE status IN ('pending', 'info_requested')")
			.first<{ n: number }>();
		return row?.n ?? 0;
	}
}
