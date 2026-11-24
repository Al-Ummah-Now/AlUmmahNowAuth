/**
 * The admin app (React Router + @cloudflare/vite-plugin) is built once; the build
 * writes build/server/wrangler.json from the top-level (production) config. This
 * derives the deploy config for another env: stage from env.stage in apps/admin/wrangler.json
 * (so stage and prod deploy the same bundle), QA from apps/admin/wrangler.qa.json. Nothing of
 * production's bindings is kept, and a config that still names one of them is refused.
 *
 *   node --experimental-strip-types scripts/release/admin-config.ts stage|qa
 *   → apps/admin/build/server/wrangler.<env>.json
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonc } from './jsonc.ts';

/** Keys an env block may override in the generated config. */
// observability/logpush: `wrangler versions deploy` syncs them from this config (stage logs warn/error only)
const ENV_KEYS = ['name', 'vars', 'kv_namespaces', 'routes', 'd1_databases', 'services', 'secrets_store_secrets', 'observability', 'logpush'] as const;

export function deriveEnvConfig(built: Record<string, unknown>, source: { env?: Record<string, Record<string, unknown>> }, envName: string) {
	const block = source.env?.[envName];
	if (!block) throw new Error(`apps/admin has no env.${envName}`);
	const out: Record<string, unknown> = { ...built };
	for (const key of ENV_KEYS) {
		if (key in block) out[key] = block[key];
		else if (key === 'vars' || key === 'kv_namespaces' || key === 'd1_databases' || key === 'services' || key === 'secrets_store_secrets') delete out[key];
	}
	for (const key of ['configPath', 'userConfigPath', 'topLevelName', 'env']) delete out[key];
	// A generated config has no env blocks; a source one does, and theirs are not production's
	const production = resourceIds({ ...built, env: undefined });
	const shared = resourceIds(out).filter((id) => production.includes(id));
	if (shared.length > 0) throw new Error(`apps/admin ${envName}: the config still holds production's ${shared.join(', ')}`);
	return out;
}

/** Ids of the stores a config binds, and its hosts. */
export function resourceIds(config: Record<string, unknown>): string[] {
	const ids: string[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === 'object') {
			for (const [key, v] of Object.entries(value)) {
				if (typeof v === 'string' && ['id', 'database_id', 'pattern', 'store_id', 'bucket_name', 'queue'].includes(key)) ids.push(v);
				else walk(v);
			}
		}
	};
	walk(config);
	return ids;
}

/** QA's config as an env block; stage's is already one. */
export function adminSource(root: string, envName: string): { env?: Record<string, Record<string, unknown>> } {
	const read = (file: string) => parseJsonc(readFileSync(join(root, 'apps/admin', file), 'utf8')) as Record<string, unknown>;
	return envName === 'qa' ? { env: { qa: read('wrangler.qa.json') } } : read('wrangler.json');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const envName = process.argv[2];
	if (!envName) {
		process.stderr.write('usage: admin-config.ts <env>\n');
		process.exit(2);
	}
	const root = resolve(new URL('../..', import.meta.url).pathname);
	const builtPath = join(root, 'apps/admin/build/server/wrangler.json');
	const built = JSON.parse(readFileSync(builtPath, 'utf8')) as Record<string, unknown>;
	const outPath = join(root, `apps/admin/build/server/wrangler.${envName}.json`);
	writeFileSync(outPath, JSON.stringify(deriveEnvConfig(built, adminSource(root, envName), envName), null, 2));
	process.stdout.write(`Wrote ${outPath}\n`);
}
