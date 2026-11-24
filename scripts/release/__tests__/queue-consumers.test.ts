/**
 * The release registers queue consumers that `wrangler versions upload` leaves out
 * (moderation-actions on the auth worker, docs/MODERATION_REQUESTS.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consumersOf, ensureConsumers, ensureQueues, queuesOf } from '../queue-consumers.ts';
import { parseJsonc } from '../jsonc.ts';
import type { CfClient } from '../cf-api.ts';

const authConfig = parseJsonc(readFileSync(resolve(__dirname, '../../../apps/auth/wrangler.json'), 'utf8')) as never;

describe('queue consumers', () => {
	it('reads the auth worker\'s moderation-actions consumers per env', () => {
		expect(consumersOf(authConfig, 'production')).toEqual([
			{ queue: 'moderation-actions', worker: 'al-ummah-now-auth', dead_letter_queue: 'moderation-actions-dlq', settings: { batch_size: 5, max_retries: 6, max_wait_time_ms: 5000, retry_delay: 30 } },
			{ queue: 'moderation-actions-dlq', worker: 'al-ummah-now-auth', dead_letter_queue: undefined, settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 5000 } },
			{ queue: 'account-events', worker: 'al-ummah-now-auth', dead_letter_queue: 'account-events-dlq', settings: { batch_size: 5, max_retries: 6, max_wait_time_ms: 5000, retry_delay: 30 } },
			{ queue: 'account-events-dlq', worker: 'al-ummah-now-auth', dead_letter_queue: undefined, settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 5000 } },
		]);
		expect(consumersOf(authConfig, 'stage').map((c) => `${c.queue}->${c.worker}`)).toEqual([
			'moderation-actions-stage->al-ummah-now-auth-stage',
			'moderation-actions-stage-dlq->al-ummah-now-auth-stage',
			'account-events-stage->al-ummah-now-auth-stage',
			'account-events-stage-dlq->al-ummah-now-auth-stage',
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
		const lines = await ensureConsumers(cf, consumersOf(authConfig, 'production').slice(0, 2));
		expect(lines).toEqual(['ok       moderation-actions -> al-ummah-now-auth', 'added    moderation-actions-dlq -> al-ummah-now-auth']);
		expect(posted).toEqual([{ path: '/queues/q2/consumers', body: { type: 'worker', script_name: 'al-ummah-now-auth', settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 5000 } } }]);
	});

	it('creates the queues the config names that are missing, and nothing else', async () => {
		expect(queuesOf(authConfig, 'production')).toEqual(['audit-events', 'moderation-actions', 'account-events', 'moderation-actions-dlq', 'account-events-dlq']);
		expect(queuesOf(authConfig, 'stage')).toEqual(['audit-events-stage', 'moderation-actions-stage', 'account-events-stage', 'moderation-actions-stage-dlq', 'account-events-stage-dlq']);
		const calls: string[] = [];
		const cf = {
			accountId: 'a',
			async request(method: string, path: string, body?: unknown) {
				calls.push(`${method} ${path} ${JSON.stringify(body) ?? ''}`.trim());
				return method === 'GET' ? [{ queue_id: 'q1', queue_name: 'audit-events' }] : {};
			},
		} as unknown as CfClient;
		expect(await ensureQueues(cf, ['audit-events', 'account-events'], true)).toEqual(['ok       audit-events', 'missing  account-events (dry run)']);
		expect(calls).toEqual(['GET /queues?page=1&per_page=500']);
		expect(await ensureQueues(cf, ['audit-events', 'account-events'])).toEqual(['ok       audit-events', 'created  account-events']);
		expect(calls.slice(2)).toEqual(['POST /queues {"queue_name":"account-events"}']);
		expect(await ensureQueues(cf, [])).toEqual([]);
	});

	it('reads every page of queues before it decides one is missing', async () => {
		const names = Array.from({ length: 1001 }, (_, i) => (i === 1000 ? 'account-events' : `q${i}`));
		const asked: string[] = [];
		const cf = {
			accountId: 'a',
			async request(method: string, path: string) {
				asked.push(`${method} ${path}`);
				if (path.endsWith('/consumers')) return [{ script_name: 'w' }];
				const page = Number(/page=(\d+)/.exec(path)![1]);
				return names.slice((page - 1) * 500, page * 500).map((n) => ({ queue_id: n, queue_name: n }));
			},
		} as unknown as CfClient;
		expect(await ensureQueues(cf, ['account-events'])).toEqual(['ok       account-events']);
		expect(asked).toEqual([1, 2, 3].map((p) => `GET /queues?page=${p}&per_page=500`));
		expect(await ensureConsumers(cf, [{ queue: 'account-events', worker: 'w', settings: {} }])).toEqual(['ok       account-events -> w']);
	});

	it('fails when a queue does not exist', async () => {
		const cf = { accountId: 'a', request: async () => [] } as unknown as CfClient;
		await expect(ensureConsumers(cf, consumersOf(authConfig, 'production'))).rejects.toThrow(/does not exist/);
	});
});
