/**
 * Delivering account events (RFC 8935) from the account-events queue:
 *
 *   202                 delivered
 *   400                 failed: the client refuses this event
 *   not a subscriber    failed: it left, or was disabled, since
 *   anything else       retried: 30 s, 60 s, 2, 4, 8, 15 min, then failed
 *
 * A user's events go to a client in order: while an earlier one is pending, a
 * later one waits, and is queued when that one settles. A failed event does not
 * hold back later ones: the receiver ignores an event older than the last it
 * applied (`seq`), so sending it again is harmless.
 */
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import { authStorage } from '../storage/auth-storage';
import { enqueue, PAGE, statementsFor } from './record';
import { signSet } from './set';
import { subscriber, subscribers } from './subscribers';
import { accountEventsOn, type AccountEventMessage, type AccountEventsEnv, type AccountEventType } from './types';

export const MAX_ATTEMPTS = 7; // first try + max_retries 6 (wrangler config)
export const TIMEOUT_MS = 10_000;
const DAY = 24 * 60 * 60 * 1000;
export const KEEP_MS = 30 * DAY;

/** Backoff before retry n (1-based): 30 s doubling, at most 15 minutes. */
export const retryDelaySeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 900);

interface DeliveryRow {
	jti: string;
	seq: number;
	client_id: string;
	user_id: string;
	status: string;
	type: AccountEventType;
	reason: string | null;
	export_id: string | null;
	created_at: number;
}

const DELIVERY_SQL = `SELECT d.jti, d.seq, d.client_id, d.user_id, d.status, e.type, e.reason, e.export_id, e.created_at
	FROM account_event_deliveries d JOIN account_events e ON e.seq = d.seq WHERE d.jti = ?1`;
const EARLIER_SQL = `SELECT 1 FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_order
	WHERE client_id = ?1 AND user_id = ?2 AND seq < ?3 AND status = 'pending' LIMIT 1`;
const NEXT_SQL = `SELECT jti FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_order
	WHERE client_id = ?1 AND user_id = ?2 AND seq > ?3 AND status = 'pending' ORDER BY seq LIMIT 1`;
const DUE_SQL = `SELECT jti FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_due
	WHERE status = 'pending' AND next_at <= ?1 ORDER BY next_at LIMIT ?2`;
const LAST_SQL = `SELECT created_at FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_order
	WHERE client_id = ?1 AND user_id = '' ORDER BY seq DESC LIMIT 1`;
const OLD_DELIVERED_SQL = `DELETE FROM account_event_deliveries WHERE jti IN (SELECT jti FROM account_event_deliveries INDEXED BY idx_account_event_deliveries_settled
	WHERE status = 'delivered' AND settled_at <= ?1 ORDER BY settled_at LIMIT ?2)`;
const OLD_EVENTS_SQL = `DELETE FROM account_events WHERE seq IN (SELECT e.seq FROM account_events e INDEXED BY idx_account_events_created
	WHERE e.created_at <= ?1 AND NOT EXISTS (SELECT 1 FROM account_event_deliveries d WHERE d.seq = e.seq) ORDER BY e.created_at LIMIT ?2)`;
/** For the test that none of them scans a table. */
export const QUERIES = { DELIVERY_SQL, EARLIER_SQL, NEXT_SQL, DUE_SQL, LAST_SQL, OLD_DELIVERED_SQL, OLD_EVENTS_SQL };

export interface DeliverOptions {
	storage?: StorageAdapter;
	fetchImpl?: typeof fetch;
	now?: number;
}

export type DeliveryResult = 'delivered' | 'failed' | 'retry' | 'waiting' | 'skipped';

type Attempt = { ok: true } | { ok: false; permanent: boolean; error: string };

async function post(uri: string, token: string, fetchImpl: typeof fetch): Promise<Attempt> {
	let res: Response;
	try {
		res = await fetchImpl(uri, {
			method: 'POST',
			headers: { 'Content-Type': 'application/secevent+jwt', Accept: 'application/json' },
			body: token,
			// a redirect is an answer we don't accept, not an address to follow
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		return { ok: false, permanent: false, error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error' };
	}
	if (res.status === 202) {
		await res.body?.cancel().catch(() => undefined);
		return { ok: true };
	}
	// Only a SET error code of a known shape is kept (RFC 8935 §2.3), never the body
	const length = Number(res.headers.get('content-length') ?? 0);
	let code = '';
	if (res.status === 400 && length > 0 && length <= 2048) {
		const body = (await res.json().catch(() => null)) as { err?: unknown } | null;
		if (typeof body?.err === 'string' && /^[a-z_]{1,40}$/.test(body.err)) code = ` ${body.err}`;
	} else {
		await res.body?.cancel().catch(() => undefined);
	}
	return { ok: false, permanent: res.status === 400, error: `${res.status}${code}` };
}

async function settle(env: AccountEventsEnv, row: DeliveryRow, status: 'delivered' | 'failed', attempts: number, error: string | null, now: number): Promise<boolean> {
	const done = await env.AUTH_DB.prepare(
		`UPDATE account_event_deliveries SET status = ?2, attempts = ?3, error = ?4, settled_at = ?5 WHERE jti = ?1 AND status = 'pending'`
	)
		.bind(row.jti, status, attempts, error, now)
		.run();
	if (!done.meta.changes) return false;
	if (status === 'failed') {
		logger.error('[account-events] Delivery failed', { jti: row.jti, clientId: row.client_id, type: row.type, attempts, error });
		await emitAuditEvent({
			timestamp: new Date(now).toISOString(),
			eventType: AuditEventType.ACCOUNT_EVENT_DELIVERY_FAILED,
			severity: AuditEventSeverity.ERROR,
			userId: null,
			ipAddress: null,
			userAgent: null,
			requestId: null,
			metadata: { jti: row.jti, clientId: row.client_id, type: row.type, ...(row.user_id ? { targetUserId: row.user_id } : {}), attempts, error, needsAttention: true },
			success: false,
			errorMessage: error,
		});
	}
	// The user's next event for this client was waiting for this one
	const next = await env.AUTH_DB.prepare(NEXT_SQL).bind(row.client_id, row.user_id, row.seq).first<{ jti: string }>();
	if (next) await enqueue(env, [next.jti], now);
	return true;
}

/** One attempt to deliver. */
export async function deliver(env: AccountEventsEnv, jti: string, attempt: number, opts: DeliverOptions = {}): Promise<DeliveryResult> {
	const now = opts.now ?? Date.now();
	const row = await env.AUTH_DB.prepare(DELIVERY_SQL).bind(jti).first<DeliveryRow>();
	if (!row || row.status !== 'pending') return 'skipped';
	if (await env.AUTH_DB.prepare(EARLIER_SQL).bind(row.client_id, row.user_id, row.seq).first()) return 'waiting';
	const to = await subscriber(env.AUTH_DB, row.client_id);
	if (!to || !to.types.includes(row.type)) {
		await settle(env, row, 'failed', attempt, 'not subscribed', now);
		return 'failed';
	}
	if (!env.OPENAUTH_ISSUER) throw new Error('OPENAUTH_ISSUER is not set');
	const token = await signSet(
		opts.storage ?? authStorage(env),
		{ issuer: env.OPENAUTH_ISSUER, clientId: row.client_id, jti: row.jti, seq: row.seq, type: row.type, userId: row.user_id, reason: row.reason, exportId: row.export_id, at: row.created_at },
		now
	);
	const result = await post(to.uri, token, opts.fetchImpl ?? fetch);
	if (result.ok) {
		await settle(env, row, 'delivered', attempt, null, now);
		return 'delivered';
	}
	const failure = result as Extract<Attempt, { ok: false }>;
	if (failure.permanent || attempt >= MAX_ATTEMPTS) {
		await settle(env, row, 'failed', attempt, failure.error, now);
		return 'failed';
	}
	await env.AUTH_DB.prepare(`UPDATE account_event_deliveries SET attempts = ?2, error = ?3 WHERE jti = ?1 AND status = 'pending'`).bind(jti, attempt, failure.error).run();
	return 'retry';
}

/** The dead-letter queue: our own handling kept failing. The row says so and stays. */
export async function deadLetter(env: AccountEventsEnv, jti: string, opts: DeliverOptions = {}): Promise<void> {
	const row = await env.AUTH_DB.prepare(DELIVERY_SQL).bind(jti).first<DeliveryRow>();
	if (row?.status === 'pending') await settle(env, row, 'failed', MAX_ATTEMPTS, 'could not be sent after every retry', opts.now ?? Date.now());
}

export const isAccountEventQueue = (queue: string) => /^account-events(?:-|$)/.test(queue);

/** Queue handler for account-events[-env] and its DLQ (index.ts). */
export async function handleAccountEventBatch(batch: MessageBatch<unknown>, env: AccountEventsEnv, opts: DeliverOptions = {}): Promise<void> {
	const dlq = batch.queue.endsWith('-dlq');
	await Promise.all(
		batch.messages.map(async (msg) => {
			const body = msg.body as Partial<AccountEventMessage> | null;
			// Turned off meanwhile: the row stays pending, and the cron queues it once events are on again
			if (body?.type !== 'account-event.deliver' || typeof body.jti !== 'string' || !accountEventsOn(env)) return msg.ack();
			try {
				if (dlq) {
					await deadLetter(env, body.jti, opts);
					return msg.ack();
				}
				const result = await deliver(env, body.jti, msg.attempts, opts);
				if (result === 'retry') msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
				else msg.ack();
			} catch (error) {
				logger.error('[account-events] queue handler error', { jti: body.jti, error: error instanceof Error ? error.message : String(error) });
				msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
			}
		})
	);
}

/** Hourly: the daily verification event per subscriber, deliveries whose message was lost, and clean-up. */
export async function accountEventsCron(env: AccountEventsEnv, now = Date.now()): Promise<{ verified: number; queued: number; removed: number }> {
	const done = { verified: 0, queued: 0, removed: 0 };
	if (accountEventsOn(env)) {
		for (const s of (await subscribers(env.AUTH_DB)).filter((x) => x.types.includes('verification'))) {
			const last = await env.AUTH_DB.prepare(LAST_SQL).bind(s.clientId).first<{ created_at: number }>();
			// a little under a day, so an hourly cron that runs late doesn't skip to the 25th hour
			if (last && now - last.created_at < DAY - 30 * 60 * 1000) continue;
			const { statements } = statementsFor(env.AUTH_DB, { type: 'verification', userId: '' }, [s], now);
			await env.AUTH_DB.batch(statements);
			done.verified++;
		}
		for (let page = 0; page < 10; page++) {
			const { results } = await env.AUTH_DB.prepare(DUE_SQL).bind(now, PAGE).all<{ jti: string }>();
			if (!results.length) break;
			await enqueue(env, results.map((r) => r.jti), now);
			done.queued += results.length;
			// nothing moved (the queue is down): the next run tries again
			const again = await env.AUTH_DB.prepare(DUE_SQL).bind(now, 1).first<{ jti: string }>();
			if (!again || results.some((r) => r.jti === again.jti)) break;
		}
	}
	const old = await env.AUTH_DB.prepare(OLD_DELIVERED_SQL).bind(now - KEEP_MS, 500).run();
	const events = await env.AUTH_DB.prepare(OLD_EVENTS_SQL).bind(now - KEEP_MS, 500).run();
	done.removed = (old.meta.changes ?? 0) + (events.meta.changes ?? 0);
	return done;
}
