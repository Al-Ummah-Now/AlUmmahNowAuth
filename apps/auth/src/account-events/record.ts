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

type Row = { type: AccountEvent['type'] | 'verification'; userId: string; reason?: string; exportId?: string };

export function statementsFor(db: D1Database, event: Row, to: Subscriber[], now: number): Recorded {
	if (!to.length) return { statements: [], jtis: [] };
	const id = crypto.randomUUID();
	const jtis = to.map(() => crypto.randomUUID());
	return {
		jtis,
		statements: [
			db
				.prepare('INSERT INTO account_events (id, type, user_id, reason, export_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
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

/** The event and its deliveries, to add to the batch of the change. */
export async function recordAccountEvent(env: AccountEventsEnv, event: AccountEvent, now = Date.now()): Promise<Recorded> {
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
		now
	);
}

/** Queues deliveries. Never throws: what is not queued stays due for the cron. */
export async function enqueue(env: AccountEventsEnv, jtis: string[], now = Date.now()): Promise<void> {
	if (!jtis.length || !accountEventsOn(env)) return;
	try {
		if (!env.ACCOUNT_EVENTS_QUEUE) throw new Error('ACCOUNT_EVENTS_QUEUE is not configured');
		for (let i = 0; i < jtis.length; i += PAGE) {
			const page = jtis.slice(i, i + PAGE);
			await env.ACCOUNT_EVENTS_QUEUE.sendBatch(page.map((jti) => ({ body: { type: 'account-event.deliver', jti } satisfies AccountEventMessage, contentType: 'json' as const })));
			// Queued: the cron leaves it alone until every retry has run
			await env.AUTH_DB.prepare(`UPDATE account_event_deliveries SET next_at = ?1 WHERE status = 'pending' AND jti IN (${page.map((_, k) => `?${k + 2}`).join(', ')})`)
				.bind(now + REQUEUE_AFTER_MS, ...page)
				.run();
		}
	} catch (error) {
		logger.error('[account-events] Could not queue deliveries; the cron will', { count: jtis.length, error: error instanceof Error ? error.message : String(error) });
	}
}
