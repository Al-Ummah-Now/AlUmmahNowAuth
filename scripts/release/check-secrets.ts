/**
 * Live secrets check (release pipeline pre-promote gate).
 *
 *   node --experimental-strip-types scripts/release/check-secrets.ts [--env production|qa|stage] [--json]
 *
 * For every Worker x env in secrets-manifest.ts, against what is DEPLOYED:
 *   - the Worker exists
 *   - every required secret is bound (worker secret or Secrets Store), and every
 *     Secrets Store binding points at a secret that exists and is active
 *   - no forbidden (test-only) secret is bound
 *   - every client id the Worker uses (deployed var or fixed in code) exists and is
 *     enabled in that env's auth D1 `oauth_clients`
 * Prints names and client ids only, never values. Exits 1 if anything fails.
 *
 * Needs CLOUDFLARE_API_TOKEN with Workers Scripts:Read, D1:Read and Secrets Store:Read
 * (locally, `wrangler login` is enough). Same file in AlUmmahNow and AlUmmahNowAuth;
 * only secrets-manifest.ts differs.
 */
import { resolve } from 'node:path';
import { createCfClient, d1Query, getWorkerBindings, type CfClient, type WorkerBinding } from './cf-api.ts';
import { AUTH_DBS, SECRETS_MANIFEST, type EnvName, type WorkerSecrets } from './secrets-manifest.ts';

export interface Finding {
	app: string;
	env: EnvName;
	worker: string;
	ok: boolean;
	check: string;
	detail?: string;
}

interface StoreSecret {
	name: string;
	status?: string;
}

export interface Deps {
	bindings(worker: string): Promise<WorkerBinding[] | null>;
	storeSecrets(storeId: string): Promise<StoreSecret[]>;
	clientIds(databaseId: string, ids: string[]): Promise<Map<string, boolean>>;
}

export function liveDeps(cf: CfClient): Deps {
	const storeCache = new Map<string, Promise<StoreSecret[]>>();
	return {
		bindings: (worker) => getWorkerBindings(cf, worker),
		storeSecrets(storeId) {
			if (!storeCache.has(storeId)) {
				storeCache.set(storeId, cf.request<StoreSecret[]>('GET', `/secrets_store/stores/${storeId}/secrets?per_page=100`));
			}
			return storeCache.get(storeId)!;
		},
		async clientIds(databaseId, ids) {
			const rows = await d1Query<{ id: string; enabled: number }>(
				cf,
				databaseId,
				`SELECT id, enabled FROM oauth_clients WHERE id IN (${ids.map(() => '?').join(',')})`,
				ids
			);
			return new Map(rows.map((r) => [r.id, r.enabled === 1]));
		},
	};
}

export async function checkWorker(entry: WorkerSecrets, deps: Deps): Promise<Finding[]> {
	const base = { app: entry.app, env: entry.env, worker: entry.worker };
	const out: Finding[] = [];
	const bindings = await deps.bindings(entry.worker);
	if (!bindings) return [{ ...base, ok: false, check: 'worker exists', detail: 'not deployed' }];
	out.push({ ...base, ok: true, check: 'worker exists' });

	for (const req of entry.required ?? []) {
		const b = bindings.find((x) => x.name === req.name);
		const check = `secret ${req.name}`;
		if (!b) {
			out.push({ ...base, ok: false, check, detail: `missing (${req.purpose})` });
		} else if (b.type === 'secret_text') {
			out.push({ ...base, ok: true, check, detail: 'worker secret' });
		} else if (b.type === 'secrets_store_secret') {
			const secrets = await deps.storeSecrets(b.store_id ?? '');
			const s = secrets.find((x) => x.name === b.secret_name);
			const ok = !!s && (s.status ?? 'active') === 'active';
			out.push({ ...base, ok, check, detail: `Secrets Store ${b.secret_name}${ok ? '' : s ? ` is ${s.status}` : ' does not exist'}` });
		} else {
			out.push({ ...base, ok: false, check, detail: `bound as ${b.type}, not a secret` });
		}
	}

	for (const name of entry.forbidden ?? []) {
		if (bindings.some((x) => x.name === name)) out.push({ ...base, ok: false, check: `forbidden ${name}`, detail: 'test-only secret bound here' });
	}

	const ids: { id: string; source: string }[] = [];
	for (const v of entry.clientIdVars ?? []) {
		const value = bindings.find((x) => x.name === v.name && x.type === 'plain_text')?.text;
		if (value) ids.push({ id: value, source: `var ${v.name}` });
		else if (v.required) out.push({ ...base, ok: false, check: `client var ${v.name}`, detail: 'not set on the deployed Worker' });
	}
	for (const id of entry.fixedClientIds ?? []) ids.push({ id, source: 'fixed in code' });

	if (ids.length > 0) {
		const db = AUTH_DBS[entry.env];
		const found = await deps.clientIds(db, [...new Set(ids.map((x) => x.id))]);
		for (const { id, source } of ids) {
			const enabled = found.get(id);
			out.push({
				...base,
				ok: enabled === true,
				check: `client ${id} (${source})`,
				detail: enabled === undefined ? `not in ${entry.env} auth D1` : enabled ? `in ${entry.env} auth D1` : 'disabled',
			});
		}
	}
	return out;
}

export async function runSecretsCheck(env: EnvName | undefined, deps: Deps): Promise<Finding[]> {
	const entries = SECRETS_MANIFEST.filter((e) => !env || e.env === env);
	return (await Promise.all(entries.map((e) => checkWorker(e, deps)))).flat();
}

function parse(argv: string[]): { env?: EnvName; json: boolean } {
	const out: { env?: EnvName; json: boolean } = { json: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--env') out.env = argv[++i] as EnvName;
		else if (argv[i] === '--json') out.json = true;
		else throw new Error(`Unknown flag ${argv[i]}`);
	}
	if (out.env && !(out.env in AUTH_DBS)) throw new Error(`--env must be one of ${Object.keys(AUTH_DBS).join(', ')}`);
	return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	try {
		const args = parse(process.argv.slice(2));
		const findings = await runSecretsCheck(args.env, liveDeps(createCfClient()));
		const failed = findings.filter((f) => !f.ok);
		if (args.json) {
			process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, findings }, null, 2)}\n`);
		} else {
			for (const f of findings) {
				process.stdout.write(`${f.ok ? 'ok  ' : 'FAIL'}  ${f.env.padEnd(10)} ${f.app.padEnd(16)} ${f.check}${f.detail ? ` — ${f.detail}` : ''}\n`);
			}
			process.stdout.write(`\n${failed.length === 0 ? 'Secrets check passed' : `Secrets check failed: ${failed.length} problem(s)`} (${findings.length} checks).\n`);
		}
		if (failed.length > 0) process.exit(1);
	} catch (error) {
		console.error(`check-secrets: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
}
