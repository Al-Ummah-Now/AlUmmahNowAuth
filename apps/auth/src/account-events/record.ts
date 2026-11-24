/**
 * Recording account events. The statements go in the same D1 batch as the change
 * that causes the event, so there is an event exactly when there is a change;
 * queueing is best effort (the cron queues what is left, deliver.ts).
 */
import { logger } from '../logger';
import { subscribers, type Subscriber } from './subscribers';
import { accountEventsOn, type AccountEvent, type AccountEventMessage, type AccountEventsEnv } from './types';

/** When the cron looks at a queued delivery again: after every queue retry (about 30 minutes) has run. */
export const REQUEUE_AFTER_MS = 2 * 60 * 60 * 1000;
/** D1 binds at most 100 values; a queue batch holds at most 100 messages. */
export const PAGE = 90;

export interface Recorded {
	/** For the caller's batch; empty while events are off or nobody subscribes. */
	statements: D1PreparedStatement[];
	/** For enqueue() once the batch committed. */
	jtis: string[];
}

/**
 * The state the account must still be in when the batch runs, read before the
 * change that follows in it: when another request got there first, there is no
 * change, so there is no event. A purge of a restored account must never be sent.
 */
const ONLY_IF = {
	live: 'deleted_at IS NULL',
	deleted: 'deleted_at IS NOT NULL',
	/** An invited account nobody has claimed. */
	invited: `status = 'invited' AND deleted_at IS NULL`,
	/** A deleted account nobody ever signed in to (a revoked invite's). */
	unused: `status = 'deleted' AND last_login_at IS NULL`,
} as const;
export type OnlyIf = keyof typeof ONLY_IF;

type Row = { type: AccountEvent['type'] | 'verification'; userId: string; reason?: string; exportId?: string };

export function statementsFor(db: D1Database, event: Row, to: Subscriber[], now: number, onlyIf?: OnlyIf): Recorded {
	if (!to.length) return { statements: [], jtis: [] };
	const id = crypto.randomUUID();
	const jtis = to.map(() => crypto.randomUUID());
	return {
		jtis,
		statements: [
			db
				.prepare(
					`INSERT INTO account_events (id, type, user_id, reason, export_id, created_at)
					 SELECT ?1, ?2, ?3, ?4, ?5, ?6${onlyIf ? ` WHERE EXISTS (SELECT 1 FROM users WHERE id = ?3 AND ${ONLY_IF[onlyIf]})` : ''}`
				)
				.bind(id, event.type, event.userId, event.reason ?? null, event.exportId ?? null, now),
			...to.map((s, i) =>
				db
					.prepare(
						`INSERT INTO account_event_deliveries (jti, seq, client_id, user_id, next_at, created_at)
						 SELECT ?1, seq, ?2, user_id, ?3, ?4 FROM account_events WHERE id = ?5`
					)
					// due at once for the cron: a lost enqueue waits for the next run, not two hours
					.bind(jtis[i]!, s.clientId, now, now, id)
			),
		],
	};
}

/** The event and its deliveries, to add to the batch of the change, before the change. */
export async function recordAccountEvent(env: AccountEventsEnv, event: AccountEvent, opts: { now?: number; onlyIf?: OnlyIf } = {}): Promise<Recorded> {
	if (!accountEventsOn(env)) return { statements: [], jtis: [] };
	const to = (await subscribers(env.AUTH_DB)).filter((s) => s.types.includes(event.type));
	return statementsFor(
		env.AUTH_DB,
		{
			type: event.type,
			userId: event.userId,
			...(event.type === 'account-disabled' ? { reason: event.reason } : {}),
			...(event.type === 'account-export-requested' ? { exportId: event.exportId } : {}),
		},
		to,
		opts.now ?? Date.now(),
		opts.onlyIf
	);
}

/** Queues deliveries and says how many. Never throws: what is not queued stays due for the cron. */
export async function enqueue(env: AccountEventsEnv, jtis: string[], now = Date.now()): Promise<number> {
	let queued = 0;
	if (!jtis.length || !accountEventsOn(env)) return queued;
	try {
		if (!env.ACCOUNT_EVENTS_QUEUE) throw new Error('ACCOUNT_EVENTS_QUEUE is not configured');
		for (let i = 0; i < jtis.length; i += PAGE) {
			const page = jtis.slice(i, i + PAGE);
			await env.ACCOUNT_EVENTS_QUEUE.sendBatch(page.map((jti) => ({ body: { type: 'account-event.deliver', jti } satisfies AccountEventMessage, contentType: 'json' as const })));
			// Queued: the cron leaves it alone until every retry has run
			await env.AUTH_DB.prepare(`UPDATE account_event_deliveries SET next_at = ?1 WHERE status = 'pending' AND jti IN (${page.map((_, k) => `?${k + 2}`).join(', ')})`)
				.bind(now + REQUEUE_AFTER_MS, ...page)
				.run();
			queued += page.length;
		}
	} catch (error) {
		logger.error('[account-events] Could not queue deliveries; the cron will', { count: jtis.length - queued, error: error instanceof Error ? error.message : String(error) });
	}
	return queued;
}
