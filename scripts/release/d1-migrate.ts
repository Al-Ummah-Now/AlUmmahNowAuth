/**
 * Applies auth database migrations to a named wrangler env (stage or production):
 *   1. @al-ummah-now/openauth's own migrations, tracked in _openauth_migrations
 *      (same table and checksums as `openauth migrate`, which can only target the
 *      top-level config, i.e. local dev)
 *   2. app migrations from apps/auth/migrations (`wrangler d1 migrations apply`)
 *
 * Migrations are expand-only (pnpm check:migrations), so applying them before the
 * new code serves traffic is safe for the code that is still serving.
 *
 *   node --experimental-strip-types scripts/release/d1-migrate.ts --env production
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const AUTH_DIR = join(ROOT, 'apps/auth');
const OPENAUTH_MIGRATIONS = join(AUTH_DIR, 'node_modules/@al-ummah-now/openauth/src/migrations');

export type DbEnv = 'stage' | 'production';

export function wrangler(args: string[], env: DbEnv): string {
	return execFileSync('npx', ['wrangler', ...args, '-c', 'wrangler.json', '--env', env], {
		cwd: AUTH_DIR,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

export function query<T>(sql: string, env: DbEnv): T[] {
	// --command=<sql>: SQL that starts with "--" would otherwise parse as a flag
	const out = wrangler(['d1', 'execute', 'AUTH_DB', '--remote', '--json', `--command=${sql}`], env);
	return (JSON.parse(out) as { results: T[] }[])[0].results;
}

/**
 * Runs a SQL file as one --command batch. (--file uses D1's bulk import, which
 * makes the database briefly unavailable and is unnecessary for these small files.)
 */
export function execSqlFile(path: string, env: DbEnv): void {
	wrangler(['d1', 'execute', 'AUTH_DB', '--remote', `--command=${readFileSync(path, 'utf8')}`], env);
}

export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const migrationChecksum = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

/** Pending openauth migration files, in order. */
export function pendingOpenauthMigrations(files: string[], applied: Set<string>): string[] {
	return files.filter((f) => /^\d{3}_.*\.sql$/.test(f) && !applied.has(f)).sort();
}

export function applyOpenauthMigrations(env: DbEnv, log: (l: string) => void): void {
	const tables = query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='_openauth_migrations'", env);
	const applied = new Set(tables.length ? query<{ name: string }>('SELECT name FROM _openauth_migrations', env).map((r) => r.name) : []);
	const pending = pendingOpenauthMigrations(readdirSync(OPENAUTH_MIGRATIONS), applied);
	for (const file of pending) {
		const path = join(OPENAUTH_MIGRATIONS, file);
		execSqlFile(path, env);
		query(
			`INSERT OR REPLACE INTO _openauth_migrations (name, applied_at, checksum) VALUES (${sqlString(file)}, ${Date.now()}, ${sqlString(migrationChecksum(readFileSync(path, 'utf8')))})`,
			env
		);
		log(`  openauth: applied ${file}`);
	}
	if (!pending.length) log('  openauth: up to date');
}

export function migrateAuthDb(env: DbEnv, log: (l: string) => void = (l) => process.stdout.write(`${l}\n`)): void {
	log(`Migrating AUTH_DB (${env})`);
	applyOpenauthMigrations(env, log);
	const out = wrangler(['d1', 'migrations', 'apply', 'AUTH_DB', '--remote'], env);
	log(`  app: ${out.includes('No migrations to apply') ? 'up to date' : out.trim().split('\n').slice(-3).join(' ')}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const env = process.argv[process.argv.indexOf('--env') + 1];
	if (env !== 'stage' && env !== 'production') {
		process.stderr.write('usage: d1-migrate.ts --env stage|production\n');
		process.exit(2);
	}
	migrateAuthDb(env);
}
