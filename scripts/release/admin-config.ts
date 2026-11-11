/**
 * The admin app (React Router + @cloudflare/vite-plugin) is built once; the build
 * writes build/server/wrangler.json from the top-level (production) config. This
 * derives the deploy config for another env from env.<name> in apps/admin/wrangler.json,
 * so stage and prod deploy the same bundle (replaces the hand-written QA patch for stage).
 *
 *   node --experimental-strip-types scripts/release/admin-config.ts stage
 *   → apps/admin/build/server/wrangler.stage.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonc } from './jsonc.ts';

/** Keys an env block may override in the generated config. */
// observability/logpush: `wrangler versions deploy` syncs them from this config (stage logs warn/error only)
const ENV_KEYS = ['name', 'vars', 'kv_namespaces', 'routes', 'd1_databases', 'services', 'secrets_store_secrets', 'observability', 'logpush'] as const;

export function deriveEnvConfig(built: Record<string, unknown>, source: { env?: Record<string, Record<string, unknown>> }, envName: string) {
	const block = source.env?.[envName];
	if (!block) throw new Error(`apps/admin/wrangler.json has no env.${envName}`);
	const out: Record<string, unknown> = { ...built };
	for (const key of ENV_KEYS) {
		if (key in block) out[key] = block[key];
		else if (key === 'vars' || key === 'kv_namespaces' || key === 'd1_databases' || key === 'services' || key === 'secrets_store_secrets') delete out[key];
	}
	for (const key of ['configPath', 'userConfigPath', 'topLevelName', 'env']) delete out[key];
	return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const envName = process.argv[2];
	if (!envName) {
		process.stderr.write('usage: admin-config.ts <env>\n');
		process.exit(2);
	}
	const root = resolve(new URL('../..', import.meta.url).pathname);
	const builtPath = join(root, 'apps/admin/build/server/wrangler.json');
	const built = JSON.parse(readFileSync(builtPath, 'utf8')) as Record<string, unknown>;
	const source = parseJsonc(readFileSync(join(root, 'apps/admin/wrangler.json'), 'utf8')) as { env?: Record<string, Record<string, unknown>> };
	const outPath = join(root, `apps/admin/build/server/wrangler.${envName}.json`);
	writeFileSync(outPath, JSON.stringify(deriveEnvConfig(built, source, envName), null, 2));
	process.stdout.write(`Wrote ${outPath}\n`);
}
