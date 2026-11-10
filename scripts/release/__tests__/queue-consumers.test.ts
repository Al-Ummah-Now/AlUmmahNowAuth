/**
 * The release registers queue consumers that `wrangler versions upload` leaves out
 * (moderation-actions on the auth worker, docs/MODERATION_REQUESTS.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consumersOf, ensureConsumers } from '../queue-consumers.ts';
import { parseJsonc } from '../jsonc.ts';
import type { CfClient } from '../cf-api.ts';

const authConfig = parseJsonc(readFileSync(resolve(__dirname, '../../../apps/auth/wrangler.json'), 'utf8')) as never;

describe('queue consumers', () => {
	it('reads the auth worker\'s moderation-actions consumers per env', () => {
		expect(consumersOf(authConfig, 'production')).toEqual([
			{ queue: 'moderation-actions', worker: 'al-ummah-now-auth', dead_letter_queue: 'moderation-actions-dlq', settings: { batch_size: 5, max_retries: 6, max_wait_time_ms: 5000, retry_delay: 30 } },
			{ queue: 'moderation-actions-dlq', worker: 'al-ummah-now-auth', dead_letter_queue: undefined, settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 5000 } },
		]);
		expect(consumersOf(authConfig, 'stage').map((c) => `${c.queue}->${c.worker}`)).toEqual([
			'moderation-actions-stage->al-ummah-now-auth-stage',
			'moderation-actions-stage-dlq->al-ummah-now-auth-stage',
		]);
		expect(() => consumersOf(authConfig, 'nope')).toThrow(/No env/);
	});

	it('adds only missing consumers', async () => {
		const posted: Array<{ path: string; body: unknown }> = [];
		const cf: CfClient = {
			accountId: 'a',
			async request<T>(method: string, path: string, body?: unknown): Promise<T> {
				if (path.startsWith('/queues?')) return [{ queue_id: 'q1', queue_name: 'moderation-actions' }, { queue_id: 'q2', queue_name: 'moderation-actions-dlq' }] as T;
				if (method === 'GET' && path === '/queues/q1/consumers') return [{ script_name: 'al-ummah-now-auth' }] as T;
				if (method === 'GET') return [] as T;
				posted.push({ path, body });
				return {} as T;
			},
		};
		const lines = await ensureConsumers(cf, consumersOf(authConfig, 'production'));
		expect(lines).toEqual(['ok       moderation-actions -> al-ummah-now-auth', 'added    moderation-actions-dlq -> al-ummah-now-auth']);
		expect(posted).toEqual([{ path: '/queues/q2/consumers', body: { type: 'worker', script_name: 'al-ummah-now-auth', settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 5000 } } }]);
	});

	it('fails when a queue does not exist', async () => {
		const cf = { accountId: 'a', request: async () => [] } as unknown as CfClient;
		await expect(ensureConsumers(cf, consumersOf(authConfig, 'production'))).rejects.toThrow(/does not exist/);
	});
});
