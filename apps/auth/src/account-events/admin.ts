/**
 * Admin > Account events (AlUmmahNowAuth#507 C1c):
 *
 *   GET  /admin/settings/account-events            each subscriber: last delivery, pending and failed counts;
 *        ?status=failed|pending|delivered&client=   and the deliveries of one status, newest first
 *        &before=<cursor>
 *   POST /admin/settings/account-events            { action: "resend", jti }: send a failed delivery again (audited),
 *                                                  while its client still receives that event
 *
 * 404 feature_off while events are off. Admins only (verifyAdminRequest checks
 * the acting user's roles in D1). Nothing here names a person but the user id.
 */
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { verifyAdminRequest } from '../auth-middleware';
import { getClientIP, withinRateLimit } from '../rate-limit';
import { enqueue } from './record';
import { subscriber, subscribers } from './subscribers';
import { accountEventsOn, type AccountEventType } from './types';

export const ACCOUNT_EVENTS_PATH = '/admin/settings/account-events';
export const PAGE_SIZE = 50;
/** Counting stops here: past it the page says "or more". */
export const COUNT_LIMIT = 1000;

const STATUSES = ['failed', 'pending', 'delivered'] as const;
type Status = (typeof STATUSES)[number];
const JTI = /^[0-9a-f-]{36}$/;

export interface SubscriberView {
	clientId: string;
	name: string;
	uri: string;
	types: AccountEventType[];
	lastDeliveredAt: number | null;
	pending: number;
	failed: number;
}

export interface DeliveryView {
	jti: string;
	seq: number;
	clientId: string;
	type: string;
	reason: string | null;
	userId: string;
	status: Status;
	attempts: number;
	error: string | null;
	createdAt: number;
	settledAt: number | null;
}

const LAST_DELIVERED_SQL = `SELECT MAX(settled_at) AS at FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_client
	WHERE client_id = ?1 AND status = 'delivered'`;
const COUNT_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_client
	WHERE client_id = ?1 AND status = ?2 LIMIT ?3)`;
const NAME_SQL = 'SELECT name FROM oauth_clients WHERE id = ?1';
const DELIVERY_COLUMNS = `d.jti, d.seq, d.client_id, d.user_id, d.status, d.attempts, d.error, d.created_at, d.settled_at, e.type, e.reason`;
const FROM = (index: string) => `SELECT ${DELIVERY_COLUMNS} FROM account_event_deliveries d INDEXED BY ${index} JOIN account_events e ON e.seq = d.seq`;
/** Settled rows, newest first; the cursor is the last row's (settled_at, jti), and the page starts there in the index. */
const SETTLED = 'd.settled_at <= ?2 AND (d.settled_at < ?2 OR d.jti < ?3) ORDER BY d.settled_at DESC, d.jti DESC LIMIT ?4';
const LIST_SQL = `${FROM('idx_account_event_deliveries_settled')} WHERE d.status = ?1 AND ${SETTLED}`;
const LIST_CLIENT_SQL = `${FROM('idx_account_event_deliveries_client')} WHERE d.status = ?1 AND d.client_id = ?5 AND ${SETTLED}`;
/** Pending ones are few and short-lived: one page, newest first. None is settled, so the index holds them in rowid order. */
const PENDING_SQL = `${FROM('idx_account_event_deliveries_settled')} WHERE d.status = 'pending' AND d.settled_at IS NULL ORDER BY d.rowid DESC LIMIT ?1`;
const PENDING_CLIENT_SQL = `${FROM('idx_account_event_deliveries_client')} WHERE d.client_id = ?2 AND d.status = 'pending' AND d.settled_at IS NULL ORDER BY d.rowid DESC LIMIT ?1`;
/** Before any real time: the first page. */
const END = { at: Number.MAX_SAFE_INTEGER, jti: '' };
const FAILED_SQL = `SELECT d.client_id, e.type FROM account_event_deliveries d JOIN account_events e ON e.seq = d.seq WHERE d.jti = ?1 AND d.status = 'failed'`;
const RESEND_SQL = `UPDATE account_event_deliveries SET status = 'pending', attempts = 0, error = NULL, settled_at = NULL, next_at = ?2
	WHERE jti = ?1 AND status = 'failed' RETURNING client_id, user_id, seq`;
/** For the test that none of them scans a table. */
export const ADMIN_QUERIES = { LAST_DELIVERED_SQL, COUNT_SQL, NAME_SQL, LIST_SQL, LIST_CLIENT_SQL, PENDING_SQL, PENDING_CLIENT_SQL, FAILED_SQL };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function subscriberViews(db: D1Database): Promise<SubscriberView[]> {
	return Promise.all(
		(await subscribers(db)).map(async (s) => {
			const count = (status: Status) =>
				db
					.prepare(COUNT_SQL)
					.bind(s.clientId, status, COUNT_LIMIT)
					.first<{ n: number }>()
					.then((r) => r?.n ?? 0);
			const [name, last, pending, failed] = await Promise.all([
				db.prepare(NAME_SQL).bind(s.clientId).first<{ name: string }>(),
				db.prepare(LAST_DELIVERED_SQL).bind(s.clientId).first<{ at: number | null }>(),
				count('pending'),
				count('failed'),
			]);
			return { clientId: s.clientId, name: name?.name ?? s.clientId, uri: s.uri, types: s.types, lastDeliveredAt: last?.at ?? null, pending, failed };
		})
	);
}

async function deliveries(db: D1Database, status: Status, client: string | null, before: { at: number; jti: string } | null) {
	const { at, jti } = before ?? END;
	const limit = PAGE_SIZE + 1;
	const stmt =
		status === 'pending'
			? client
				? db.prepare(PENDING_CLIENT_SQL).bind(limit, client)
				: db.prepare(PENDING_SQL).bind(limit)
			: client
				? db.prepare(LIST_CLIENT_SQL).bind(status, at, jti, limit, client)
				: db.prepare(LIST_SQL).bind(status, at, jti, limit);
	const { results } = await stmt.all<{
		jti: string;
		seq: number;
		client_id: string;
		user_id: string;
		status: Status;
		attempts: number;
		error: string | null;
		created_at: number;
		settled_at: number | null;
		type: string;
		reason: string | null;
	}>();
	const page = results.slice(0, PAGE_SIZE);
	const last = page[page.length - 1];
	const rows = page.map(
		(r): DeliveryView => ({ jti: r.jti, seq: r.seq, clientId: r.client_id, type: r.type, reason: r.reason, userId: r.user_id, status: r.status, attempts: r.attempts, error: r.error, createdAt: r.created_at, settledAt: r.settled_at })
	);
	const next = results.length > PAGE_SIZE && last?.settled_at ? `${last.settled_at}_${last.jti}` : null;
	return { rows, next };
}

function cursorOf(value: string | null): { at: number; jti: string } | null | undefined {
	if (value === null) return null;
	const match = /^(\d{1,16})_([0-9a-f-]{36})$/.exec(value);
	return match ? { at: Number(match[1]), jti: match[2]! } : undefined;
}

export async function handleAccountEvents(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
	let actor: { id: string };
	try {
		const auth = await verifyAdminRequest(request.clone(), env);
		if (auth.type === 'm2m') {
			if (!auth.actingUser) return json({ error: 'forbidden' }, 403);
			actor = { id: auth.actingUser.id };
		} else actor = { id: auth.user.id };
	} catch {
		return json({ error: 'forbidden' }, 403);
	}
	if (!accountEventsOn(env)) return json({ error: 'feature_off' }, 404);

	if (request.method === 'GET') {
		const query = new URL(request.url).searchParams;
		const status = (query.get('status') ?? 'failed') as Status;
		const before = cursorOf(query.get('before'));
		const client = query.get('client');
		if (!STATUSES.includes(status) || before === undefined || (client !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(client))) return json({ error: 'invalid_request' }, 400);
		const [clients, page] = await Promise.all([subscriberViews(env.AUTH_DB), deliveries(env.AUTH_DB, status, client, before)]);
		return json({ clients, status, deliveries: page.rows, next: page.next, countLimit: COUNT_LIMIT });
	}

	if (request.method === 'POST') {
		let body: { action?: unknown; jti?: unknown } | null = null;
		try {
			body = (await request.json()) as { action?: unknown; jti?: unknown };
		} catch {
			// handled below
		}
		if (body?.action !== 'resend' || typeof body.jti !== 'string' || !JTI.test(body.jti)) return json({ error: 'invalid_request' }, 400);
		if (!(await withinRateLimit(env.ADMIN_SENSITIVE_LIMITER, `account-events:resend:${actor.id}`))) return json({ error: 'rate_limited' }, 429);
		// Unknown, or delivered or queued by somebody else meanwhile
		const failed = await env.AUTH_DB.prepare(FAILED_SQL).bind(body.jti).first<{ client_id: string; type: AccountEventType }>();
		if (!failed) return json({ error: 'not_failed' }, 409);
		// The client left, lost the scope or no longer takes this event: it would only fail again
		const to = await subscriber(env.AUTH_DB, failed.client_id);
		if (!to?.types.includes(failed.type)) return json({ error: 'not_subscribed' }, 409);
		const now = Date.now();
		const row = await env.AUTH_DB.prepare(RESEND_SQL).bind(body.jti, now).first<{ client_id: string; user_id: string; seq: number }>();
		if (!row) return json({ error: 'not_failed' }, 409);
		await enqueue(env, [body.jti], now);
		ctx.waitUntil(
			emitAuditEvent({
				timestamp: new Date(now).toISOString(),
				eventType: AuditEventType.ACCOUNT_EVENT_RESENT,
				severity: AuditEventSeverity.WARNING,
				userId: actor.id,
				ipAddress: getClientIP(request),
				userAgent: request.headers.get('User-Agent'),
				requestId,
				metadata: { jti: body.jti, clientId: row.client_id, seq: row.seq, ...(row.user_id ? { targetUserId: row.user_id } : {}) },
				success: true,
				errorMessage: null,
			})
		);
		return json({ queued: true }, 202);
	}
	return json({ error: 'method_not_allowed' }, 405);
}
