/**
 * Approved moderation requests run their action from a queue (docs/MODERATION_REQUESTS.md):
 *
 *   approve / execute ──enqueue──▶ moderation-actions ──▶ runQueuedAction
 *        ok                → actioned
 *        permanent error   → execution failed, flagged for an auth admin (no retry)
 *        transient error   → retried: 30 s, 60 s, 2 min, 4 min, 8 min, 15 min (max_retries 6)
 *        retries exhausted → moderation-actions-dlq ──▶ flagged for an auth admin
 *
 * "Flagged" = execution_status 'failed' + action_error + an action_failed event and
 * an ERROR audit event; the auth admin queue lists it under "Needs attention" and
 * the admin can run it again (re-enqueue) or close it by hand.
 */
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import { ModerationStore, type ModerationRequestRow } from './store';
import type { ActionOutcome, ActionRunner, AutomaticAction } from './actions';

export interface ModerationQueueMessage {
	type: 'moderation.execute';
	requestId: string;
	/** The auth admin who approved (for audit). */
	adminId: string;
}

export const MAX_ATTEMPTS = 7; // first try + max_retries 6 (wrangler config)

/** Backoff before retry n (1-based): 30 s doubling, at most 15 minutes. */
export function retryDelaySeconds(attempt: number): number {
	return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 900);
}

/** Queues the action of an approved request. Without a queue binding the request is flagged at once. */
export async function enqueueExecution(env: Env, store: ModerationStore, row: ModerationRequestRow, adminId: string): Promise<boolean> {
	if (!env.MODERATION_QUEUE) {
		await flagFailed(store, row, 'The moderation-actions queue is not configured (MODERATION_QUEUE)', adminId);
		return false;
	}
	await store.setExecution(row.id, 'queued', { resetAttempts: true });
	const message: ModerationQueueMessage = { type: 'moderation.execute', requestId: row.id, adminId };
	try {
		await env.MODERATION_QUEUE.send(message, { contentType: 'json' });
	} catch (error) {
		await flagFailed(store, row, `Could not queue the action: ${error instanceof Error ? error.message : String(error)}`, adminId);
		return false;
	}
	return true;
}

async function flagFailed(store: ModerationStore, row: ModerationRequestRow, error: string, adminId: string) {
	await store.setExecution(row.id, 'failed', { error });
	await store.addEvent(row.id, 'action_failed', { type: 'system', id: 'moderation-actions' }, error, { attempts: row.execution_attempts });
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.MODERATION_REQUEST_ACTION_FAILED,
		severity: AuditEventSeverity.ERROR,
		userId: adminId || null,
		ipAddress: null,
		userAgent: null,
		requestId: null,
		metadata: { requestId: row.id, targetUserId: row.subject_user_id, action: row.action, clientId: row.client_id, error, needsAttention: true },
		success: false,
		errorMessage: error,
	});
}

export type QueueResult = 'done' | 'skipped' | 'retry' | 'failed';

/** One delivery of a moderation.execute message. */
export async function runQueuedAction(store: ModerationStore, run: ActionRunner, message: ModerationQueueMessage, attempt: number): Promise<QueueResult> {
	const row = await store.get(message.requestId);
	// Rejected, already done or closed by hand since it was queued: nothing to do
	if (!row || row.status !== 'approved' || row.action === 'other') return 'skipped';
	await store.setExecution(row.id, attempt > 1 ? 'retrying' : 'queued', { attempts: attempt });
	const outcome = await run(row.action as AutomaticAction, row.subject_user_id, row.tenant_id || 'default');
	if (outcome.ok) {
		const done = await store.transition(row.id, 'execute', 'actioned', { actioned: true, action_result: outcome.result ?? null, action_error: null });
		if (!done) return 'skipped';
		await store.setExecution(row.id, 'done');
		await store.addEvent(row.id, 'actioned', { type: 'system', id: 'moderation-actions' }, null, { attempts: attempt });
		await emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.MODERATION_REQUEST_ACTIONED,
			severity: AuditEventSeverity.CRITICAL,
			userId: message.adminId || null,
			ipAddress: null,
			userAgent: null,
			requestId: null,
			metadata: { requestId: row.id, targetUserId: row.subject_user_id, action: row.action, clientId: row.client_id, attempts: attempt, result: outcome.result ?? null },
			success: true,
			errorMessage: null,
		});
		return 'done';
	}
	const failure = outcome as Extract<ActionOutcome, { ok: false }>;
	const error = `${row.action} failed (attempt ${attempt}): ${failure.error}`;
	logger.warn('[moderation] action failed', { requestId: row.id, attempt, permanent: failure.permanent });
	if (failure.permanent || attempt >= MAX_ATTEMPTS) {
		await flagFailed(store, { ...row, execution_attempts: attempt }, error, message.adminId);
		return 'failed';
	}
	await store.setExecution(row.id, 'retrying', { error, attempts: attempt });
	return 'retry';
}

/** The dead-letter queue: retries ran out. */
export async function deadLetter(store: ModerationStore, message: ModerationQueueMessage): Promise<void> {
	const row = await store.get(message.requestId);
	if (!row || row.status !== 'approved' || row.execution_status === 'failed') return;
	await flagFailed(store, row, row.action_error ?? 'The action failed after every retry', message.adminId);
}

/** Queue handler for the auth worker (index.ts). */
export async function handleModerationBatch(batch: MessageBatch<ModerationQueueMessage>, env: Env, run: ActionRunner): Promise<void> {
	const store = new ModerationStore(env.AUTH_DB);
	const dlq = batch.queue.endsWith('-dlq');
	for (const msg of batch.messages) {
		const body = msg.body;
		if (!body || body.type !== 'moderation.execute' || !body.requestId) {
			msg.ack();
			continue;
		}
		try {
			if (dlq) {
				await deadLetter(store, body);
				msg.ack();
				continue;
			}
			const result = await runQueuedAction(store, run, body, msg.attempts);
			if (result === 'retry') msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
			else msg.ack();
		} catch (error) {
			// Our own bookkeeping failed (D1 hiccup): let the queue retry the message
			logger.error('[moderation] queue handler error', { requestId: body.requestId, error: error instanceof Error ? error.message : String(error) });
			msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
		}
	}
}
