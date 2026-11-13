/**
 * Post-deploy check of the audit pipeline: queue -> audit consumer -> audit_events.
 *
 *   node --experimental-strip-types scripts/release/audit-check.ts --env production
 *
 * Publishes one canary message to the env's audit queue through the Cloudflare API
 * and waits for that exact row in D1. Nothing on production can trigger an audit
 * event anonymously without tripping a rate limit, so the canary starts at the
 * queue: it does not exercise the auth worker's AUDIT_QUEUE producer binding.
 * Each release leaves one row of type release.audit_pipeline_check.
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createCfClient, d1Query, type CfClient } from './cf-api.ts';
import { AUTH_DBS } from './secrets-manifest.ts';

export type AuditCheckEnv = 'stage' | 'production';

export const AUDIT_QUEUES: Record<AuditCheckEnv, string> = {
	stage: 'audit-events-stage',
	production: 'audit-events',
};

export const CANARY_EVENT_TYPE = 'release.audit_pipeline_check';

export interface AuditCheckOptions {
	env: AuditCheckEnv;
	timeoutMs?: number;
	pollMs?: number;
	/** Injectable for tests */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	canaryId?: string;
}

export function canaryMessage(canaryId: string, nowMs: number) {
	return {
		content_type: 'json',
		body: {
			version: 1,
			type: 'app_audit_event',
			event: {
				timestamp: new Date(nowMs).toISOString(),
				eventType: CANARY_EVENT_TYPE,
				severity: 'info',
				userId: null,
				ipAddress: null,
				userAgent: 'al-ummah-now-release-check',
				requestId: canaryId,
				metadata: { source: 'release-pipeline' },
				success: true,
				errorMessage: null,
			},
			enqueued_at: nowMs,
		},
	};
}

/** Resolves when the canary row lands; throws when it does not within the timeout. */
export async function runAuditCheck(cf: CfClient, opts: AuditCheckOptions): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const pollMs = opts.pollMs ?? 5_000;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const canaryId = opts.canaryId ?? `release-check-${randomUUID()}`;
	const queueName = AUDIT_QUEUES[opts.env];

	const queues = await cf.request<{ queue_id: string; queue_name: string }[]>('GET', `/queues?name=${encodeURIComponent(queueName)}`);
	const queue = queues.find((q) => q.queue_name === queueName);
	if (!queue) throw new Error(`queue ${queueName} not found`);

	const started = now();
	await cf.request('POST', `/queues/${queue.queue_id}/messages`, canaryMessage(canaryId, started));

	while (now() - started <= timeoutMs) {
		const rows = await d1Query<{ c: number }>(
			cf,
			AUTH_DBS[opts.env],
			'SELECT COUNT(*) AS c FROM audit_events WHERE event_type = ? AND request_id = ?',
			[CANARY_EVENT_TYPE, canaryId],
		);
		if ((rows[0]?.c ?? 0) > 0) return `canary ${canaryId} reached audit_events after ${Math.round((now() - started) / 1000)}s`;
		await sleep(pollMs);
	}
	throw new Error(`canary ${canaryId} did not reach audit_events within ${timeoutMs / 1000}s: check the consumer on ${queueName} and its DLQ`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const i = process.argv.indexOf('--env');
	const env = process.argv[i + 1] as AuditCheckEnv;
	if (i < 0 || !(env in AUDIT_QUEUES)) throw new Error('usage: audit-check.ts --env stage|production');
	process.stdout.write(`PASS  ${await runAuditCheck(createCfClient(), { env })}\n`);
}
