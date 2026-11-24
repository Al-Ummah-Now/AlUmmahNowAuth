/**
 * Registers the queue consumers a Worker's wrangler config declares, when they are
 * missing. `wrangler versions upload` (the promote) does not register consumers,
 * so a consumer added to an existing Worker would otherwise never receive messages.
 * Run after the promote; idempotent (present consumers are left as they are).
 *
 *   node --experimental-strip-types scripts/release/queue-consumers.ts --config apps/auth/wrangler.json --env production [--dry-run]
 *
 * With --create-queues (before the deploy: a binding to a queue that does not exist
 * fails it) it only creates the queues the config names, when they are missing.
 *
 * --env names the config's env block (omit for the top level). Needs
 * CLOUDFLARE_API_TOKEN with Queues:Edit (locally, `wrangler login`).
 * Same file in AlUmmahNow and AlUmmahNowAuth.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCfClient, type CfClient } from './cf-api.ts';
import { parseJsonc } from './jsonc.ts';

export interface ConsumerSpec {
	queue: string;
	worker: string;
	settings: { batch_size?: number; max_retries?: number; max_wait_time_ms?: number; retry_delay?: number };
	dead_letter_queue?: string;
}

interface ConsumerConfig {
	queue: string;
	max_batch_size?: number;
	max_batch_timeout?: number;
	max_retries?: number;
	retry_delay?: number;
	dead_letter_queue?: string;
}
interface Block {
	name?: string;
	queues?: { producers?: { queue: string }[]; consumers?: ConsumerConfig[] };
	env?: Record<string, Block>;
}

/** The consumers of the config's top level or of one env block. */
export function consumersOf(config: Block, env?: string): ConsumerSpec[] {
	const block = env ? config.env?.[env] : config;
	if (!block) throw new Error(`No env "${env}" in the config`);
	const worker = block.name ?? config.name;
	if (!worker) throw new Error('The config has no Worker name');
	return (block.queues?.consumers ?? []).map((c) => ({
		queue: c.queue,
		worker,
		dead_letter_queue: c.dead_letter_queue,
		settings: {
			...(c.max_batch_size !== undefined ? { batch_size: c.max_batch_size } : {}),
			...(c.max_retries !== undefined ? { max_retries: c.max_retries } : {}),
			...(c.max_batch_timeout !== undefined ? { max_wait_time_ms: c.max_batch_timeout * 1000 } : {}),
			...(c.retry_delay !== undefined ? { retry_delay: c.retry_delay } : {}),
		},
	}));
}

/** Every queue the config's top level or one env block names: produced to, consumed, or dead-lettered to. */
export function queuesOf(config: Block, env?: string): string[] {
	const block = env ? config.env?.[env] : config;
	if (!block) throw new Error(`No env "${env}" in the config`);
	const names = [...(block.queues?.producers ?? []).map((p) => p.queue), ...(block.queues?.consumers ?? []).flatMap((c) => [c.queue, c.dead_letter_queue])];
	return [...new Set(names.filter((n): n is string => !!n))];
}

interface QueueInfo {
	queue_id: string;
	queue_name: string;
}
interface QueueConsumer {
	script?: string;
	script_name?: string;
	service?: string;
}

const PER_PAGE = 500;

/** Every queue of the account, page by page. */
async function listQueues(cf: CfClient): Promise<QueueInfo[]> {
	const all: QueueInfo[] = [];
	for (let page = 1; ; page++) {
		const queues = await cf.request<QueueInfo[]>('GET', `/queues?page=${page}&per_page=${PER_PAGE}`);
		all.push(...queues);
		if (queues.length < PER_PAGE) return all;
	}
}

/** Creates the queues that are missing. Never changes or deletes one. */
export async function ensureQueues(cf: CfClient, names: string[], dryRun = false): Promise<string[]> {
	if (!names.length) return [];
	const existing = new Set((await listQueues(cf)).map((q) => q.queue_name));
	const lines: string[] = [];
	for (const name of names) {
		if (existing.has(name)) lines.push(`ok       ${name}`);
		else if (dryRun) lines.push(`missing  ${name} (dry run)`);
		else {
			await cf.request('POST', '/queues', { queue_name: name });
			lines.push(`created  ${name}`);
		}
	}
	return lines;
}

export async function ensureConsumers(cf: CfClient, specs: ConsumerSpec[], dryRun = false): Promise<string[]> {
	const lines: string[] = [];
	if (!specs.length) return lines;
	const queues = await listQueues(cf);
	for (const spec of specs) {
		const queue = queues.find((q) => q.queue_name === spec.queue);
		if (!queue) throw new Error(`Queue ${spec.queue} does not exist (wrangler queues create ${spec.queue})`);
		const consumers = await cf.request<QueueConsumer[]>('GET', `/queues/${queue.queue_id}/consumers`);
		if (consumers.some((c) => (c.script_name ?? c.script ?? c.service) === spec.worker)) {
			lines.push(`ok       ${spec.queue} -> ${spec.worker}`);
			continue;
		}
		if (dryRun) {
			lines.push(`missing  ${spec.queue} -> ${spec.worker} (dry run)`);
			continue;
		}
		await cf.request('POST', `/queues/${queue.queue_id}/consumers`, {
			type: 'worker',
			script_name: spec.worker,
			...(spec.dead_letter_queue ? { dead_letter_queue: spec.dead_letter_queue } : {}),
			settings: spec.settings,
		});
		lines.push(`added    ${spec.queue} -> ${spec.worker}`);
	}
	return lines;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const args = process.argv.slice(2);
	const value = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	try {
		const configPath = value('--config');
		if (!configPath) throw new Error('--config is required');
		const config = parseJsonc(readFileSync(configPath, 'utf8')) as Block;
		const dryRun = args.includes('--dry-run');
		const lines = args.includes('--create-queues')
			? await ensureQueues(createCfClient(), queuesOf(config, value('--env')), dryRun)
			: await ensureConsumers(createCfClient(), consumersOf(config, value('--env')), dryRun);
		for (const line of lines) console.log(line);
	} catch (error) {
		console.error(`queue-consumers: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
