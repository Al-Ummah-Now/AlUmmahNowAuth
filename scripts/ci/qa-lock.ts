/**
 * A cross-run lock (copy of AlUmmahNow scripts/ci/qa-lock.ts, tested there).
 * Here: one QA deploy + E2E at a time (test.yml qa-lock). There: the E2E specs that change global QA state
 * (site theme, shared translations, the legacy-profile restore scan). Everything
 * else runs with per-run accounts and needs no lock.
 *
 * Why not a GitHub `concurrency` group: GitHub keeps only ONE pending job per
 * group, so each newly queued run replaced (cancelled) the one waiting before
 * it, and with several PRs pushing at once most never ran. A job holding this
 * lock waits its turn instead; nobody is dropped.
 *
 * The lock is a git ref, refs/ci-locks/<name>, changed only with compare-and-swap
 * (GraphQL updateRefs with beforeOid), so exactly one holder wins. Its target is
 * a parentless commit whose message is the holder (run id, attempt, job, expiry).
 * A lock whose holder run has completed, or whose expiry has passed, is taken
 * over (again by compare-and-swap). Release deletes the ref only if it still
 * points at the holder's commit.
 *
 *   node --experimental-strip-types scripts/ci/qa-lock.ts acquire <name> --ttl-min 60 --max-wait-min 120
 *     → prints holder=<sha> to $GITHUB_OUTPUT (the release step's input)
 *   node --experimental-strip-types scripts/ci/qa-lock.ts release <name> --holder <sha>
 *
 * Env: GITHUB_TOKEN (contents: write, actions: read), GITHUB_REPOSITORY,
 * GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB; GITHUB_API_URL / GITHUB_GRAPHQL_URL optional.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ZERO = '0000000000000000000000000000000000000000';
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Holder {
	runId: string;
	attempt: string;
	job: string;
	expiresAt: number;
}

export function lockRef(name: string): string {
	if (!NAME.test(name)) throw new Error(`lock name must match ${NAME}, got ${JSON.stringify(name)}`);
	return `refs/ci-locks/${name}`;
}

export function holderMessage(h: Holder): string {
	return `ci-lock ${JSON.stringify(h)}`;
}

export function parseHolder(message: string): Holder | null {
	const m = /^ci-lock (\{.*\})\s*$/s.exec(message);
	if (!m) return null;
	try {
		const h = JSON.parse(m[1]) as Holder;
		return typeof h.runId === 'string' && typeof h.expiresAt === 'number' ? h : null;
	} catch {
		return null;
	}
}

/** True when the current holder can be taken over. */
export function isStale(holder: Holder | null, now: number, runStatus: string | null): boolean {
	if (!holder) return true; // unreadable: never blocks forever
	if (holder.expiresAt <= now) return true;
	return runStatus === 'completed';
}

export interface Gh {
	rest<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }>;
	graphql<T>(query: string, variables: Record<string, unknown>): Promise<{ data?: T; errors?: unknown[] }>;
}

export function createGh(env: NodeJS.ProcessEnv = process.env): Gh {
	const token = env.GITHUB_TOKEN;
	if (!token) throw new Error('GITHUB_TOKEN is required');
	const api = env.GITHUB_API_URL || 'https://api.github.com';
	const gql = env.GITHUB_GRAPHQL_URL || `${api}/graphql`;
	const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'al-ummah-qa-lock' };
	return {
		async rest(method, path, body) {
			const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
			const text = await res.text();
			return { status: res.status, data: text ? JSON.parse(text) : null };
		},
		async graphql(query, variables) {
			const res = await fetch(gql, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
			return (await res.json()) as { data?: never; errors?: unknown[] };
		},
	};
}

const UPDATE_REFS = 'mutation($r:ID!,$u:[RefUpdate!]!){updateRefs(input:{repositoryId:$r,refUpdates:$u}){clientMutationId}}';

export class Lock {
	private repoId: string | null = null;
	private gh: Gh;
	private repo: string;
	private name: string;
	private log: (line: string) => void;
	constructor(gh: Gh, repo: string, name: string, log: (line: string) => void = () => undefined) {
		this.gh = gh;
		this.repo = repo;
		this.name = name;
		this.log = log;
	}

	private get ref() {
		return lockRef(this.name);
	}

	async current(): Promise<string | null> {
		const res = await this.gh.rest<{ object?: { sha?: string } }>('GET', `/repos/${this.repo}/git/ref/${this.ref.slice('refs/'.length)}`);
		if (res.status === 404) return null;
		if (res.status !== 200) throw new Error(`reading ${this.ref}: ${res.status}`);
		return res.data.object?.sha ?? null;
	}

	/** Compare-and-swap; the ref read afterwards is the only source of truth. */
	async swap(before: string, after: string): Promise<boolean> {
		if (!this.repoId) {
			const [owner, name] = this.repo.split('/');
			const r = await this.gh.graphql<{ repository: { id: string } }>('query($o:String!,$n:String!){repository(owner:$o,name:$n){id}}', { o: owner, n: name });
			if (!r.data?.repository?.id) throw new Error(`repository ${this.repo} not found`);
			this.repoId = r.data.repository.id;
		}
		await this.gh.graphql(UPDATE_REFS, { r: this.repoId, u: [{ name: this.ref, beforeOid: before, afterOid: after, force: true }] });
		const now = await this.current();
		return after === ZERO ? now !== before : now === after;
	}

	async holderOf(sha: string): Promise<Holder | null> {
		const res = await this.gh.rest<{ message?: string }>('GET', `/repos/${this.repo}/git/commits/${sha}`);
		return res.status === 200 ? parseHolder(res.data.message ?? '') : null;
	}

	async runStatus(runId: string): Promise<string | null> {
		if (!/^\d+$/.test(runId)) return null;
		const res = await this.gh.rest<{ status?: string }>('GET', `/repos/${this.repo}/actions/runs/${runId}`);
		if (res.status === 404) return 'completed';
		return res.status === 200 ? (res.data.status ?? null) : null;
	}

	async makeHolder(h: Holder, tree: string): Promise<string> {
		const res = await this.gh.rest<{ sha: string }>('POST', `/repos/${this.repo}/git/commits`, { message: holderMessage(h), tree, parents: [] });
		if (res.status !== 201) throw new Error(`creating the holder commit: ${res.status}`);
		return res.data.sha;
	}

	private holders = new Map<string, Holder | null>();

	/**
	 * One attempt: our commit sha when we now hold the lock, else null. `mine`
	 * is called only when the lock is free or stale, so a waiter costs two reads
	 * per round (the GITHUB_TOKEN quota is per repository).
	 */
	async tryAcquire(mine: () => Promise<string>, now: number): Promise<string | null> {
		const cur = await this.current();
		if (cur === null) {
			const sha = await mine();
			return (await this.swap(ZERO, sha)) ? sha : null;
		}
		if (!this.holders.has(cur)) this.holders.set(cur, await this.holderOf(cur));
		const holder = this.holders.get(cur) ?? null;
		const status = holder && holder.expiresAt > now ? await this.runStatus(holder.runId) : null;
		if (!isStale(holder, now, status)) {
			this.log(`[qa-lock] ${this.name} held by run ${holder?.runId} attempt ${holder?.attempt} (${holder?.job}); waiting`);
			return null;
		}
		this.log(`[qa-lock] ${this.name}: taking over a stale lock (run ${holder?.runId ?? '?'}, ${status ?? 'expired'})`);
		const sha = await mine();
		return (await this.swap(cur, sha)) ? sha : null;
	}

	async release(mine: string): Promise<boolean> {
		const cur = await this.current();
		if (cur !== mine) {
			this.log(`[qa-lock] ${this.name} is no longer ours; nothing to release`);
			return false;
		}
		return this.swap(mine, ZERO);
	}
}

interface Opts {
	ttlMin: number;
	maxWaitMin: number;
	holder: string;
}

function parseOpts(argv: string[]): Opts {
	const o: Opts = { ttlMin: 60, maxWaitMin: 120, holder: '' };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--ttl-min') o.ttlMin = Number(argv[++i]);
		else if (argv[i] === '--max-wait-min') o.maxWaitMin = Number(argv[++i]);
		else if (argv[i] === '--holder') o.holder = argv[++i] ?? '';
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (!(o.ttlMin > 0) || !(o.maxWaitMin > 0)) throw new Error('--ttl-min and --max-wait-min must be > 0');
	return o;
}

async function main(): Promise<void> {
	const [cmd, name, ...rest] = process.argv.slice(2);
	const env = process.env;
	const repo = env.GITHUB_REPOSITORY ?? '';
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is required');
	const log = (line: string) => process.stdout.write(`${line}\n`);
	const lock = new Lock(createGh(env), repo, name ?? '', log);
	lockRef(name ?? '');
	const opts = parseOpts(rest);

	if (cmd === 'release') {
		if (!/^[0-9a-f]{40}$/.test(opts.holder)) {
			log('[qa-lock] no holder given: this job never took the lock');
			return;
		}
		log((await lock.release(opts.holder)) ? `[qa-lock] released ${name}` : `[qa-lock] ${name} not released`);
		return;
	}
	if (cmd !== 'acquire') throw new Error('usage: qa-lock.ts acquire|release <name> ...');

	const repoInfo = await createGh(env).rest<{ default_branch: string }>('GET', `/repos/${repo}`);
	const head = await createGh(env).rest<{ commit: { commit: { tree: { sha: string } } } }>('GET', `/repos/${repo}/branches/${repoInfo.data.default_branch}`);
	const tree = head.data.commit.commit.tree.sha;
	const started = Date.now();
	const holder: Holder = {
		runId: env.GITHUB_RUN_ID ?? '',
		attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
		job: env.GITHUB_JOB ?? '',
		expiresAt: 0,
	};
	for (;;) {
		if (Date.now() - started > opts.maxWaitMin * 60_000) throw new Error(`waited ${opts.maxWaitMin} min for the ${name} lock`);
		// The expiry counts from the moment we take it
		const got = await lock.tryAcquire(() => lock.makeHolder({ ...holder, expiresAt: Date.now() + opts.ttlMin * 60_000 }, tree), Date.now());
		if (got) {
			log(`[qa-lock] acquired ${name} after ${Math.round((Date.now() - started) / 1000)} s`);
			if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `holder=${got}\n`);
			return;
		}
		// 60-90 s with jitter: waiters do not poll in step
		await new Promise((r) => setTimeout(r, 60_000 + Math.floor(Math.random() * 30_000)));
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`qa-lock: ${(error as Error).message}\n`);
		process.exit(1);
	});
}
