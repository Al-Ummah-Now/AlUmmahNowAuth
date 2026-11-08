/**
 * Brings the stage auth database to the prod schema and seeds what stage needs.
 * Idempotent: safe to run before every stage deploy.
 *
 *   node --experimental-strip-types scripts/stage/seed.ts
 *   ADMIN_CLIENT_SECRET=<secret> node --experimental-strip-types scripts/stage/seed.ts --set-admin-secret
 *
 * Steps (all against env.stage of apps/auth/wrangler.json, never production):
 *   1. openauth's own migrations, tracked in _openauth_migrations (as `openauth migrate` does)
 *   2. app migrations from apps/auth/migrations (the prod history)
 *   3. RBAC roles and client tenant fix (same scripts QA uses)
 *   4. client redirect URIs: prod's live values (read-only) with stage hosts
 *   5. optionally: the admin dashboard's M2M client secret (hash stored in D1)
 */
import { execFileSync } from 'node:child_process';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonc } from '../release/jsonc.ts';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const AUTH_DIR = join(ROOT, 'apps/auth');
const ENV = 'stage';
const OPENAUTH_MIGRATIONS = join(AUTH_DIR, 'node_modules/@al-ummah-now/openauth/src/migrations');

/** Prod host → stage host, for client redirect URIs. */
export const STAGE_HOSTS: Record<string, string> = {
	'videos.alummahnow.net': 'videos.stage.alummahnow.net',
	'admin.alummahnow.net': 'admin.stage.alummahnow.net',
	'profile.auth.alummahnow.net': 'profile.auth.stage.alummahnow.net',
	'admin.auth.alummahnow.net': 'admin.auth.stage.alummahnow.net',
};

/** Rewrites prod redirect URIs to stage; drops localhost and unknown hosts. */
export function toStageRedirectUris(uris: string[]): string[] {
	const out: string[] = [];
	for (const uri of uris) {
		let url: URL;
		try {
			url = new URL(uri);
		} catch {
			continue;
		}
		const stageHost = STAGE_HOSTS[url.hostname];
		if (!stageHost) continue;
		url.hostname = stageHost;
		out.push(url.toString());
	}
	return [...new Set(out)];
}

/** Same format as @al-ummah-now/openauth's hashClientSecret (PBKDF2-SHA256, 100k). */
export function hashClientSecret(secret: string, salt: Buffer = randomBytes(16)): string {
	const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	const hash = pbkdf2Sync(Buffer.from(secret, 'utf8'), salt, 100000, 32, 'sha256');
	return `$pbkdf2-sha256$100000$${b64url(salt)}$${b64url(hash)}`;
}

function wrangler(args: string[], env: string = ENV): string {
	return execFileSync('npx', ['wrangler', ...args, '--env', env], {
		cwd: AUTH_DIR,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function query<T>(sql: string, env: string = ENV): T[] {
	const out = wrangler(['d1', 'execute', 'AUTH_DB', '--remote', '--json', `--command=${sql}`], env);
	return (JSON.parse(out) as { results: T[] }[])[0].results;
}

/**
 * Runs a SQL file as one --command batch. (--file uses D1's bulk import, which
 * makes the database briefly unavailable and is unnecessary for these small files.)
 */
function execFile(path: string): void {
	wrangler(['d1', 'execute', 'AUTH_DB', '--remote', `--command=${readFileSync(path, 'utf8')}`]);
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function assertStageTarget(): void {
	const config = parseJsonc(readFileSync(join(AUTH_DIR, 'wrangler.json'), 'utf8')) as {
		env: Record<string, { d1_databases: { database_name: string }[] }>;
	};
	const db = config.env[ENV]?.d1_databases?.[0]?.database_name ?? '';
	if (!db.endsWith('-stage')) throw new Error(`refusing to seed: env.${ENV} AUTH_DB is "${db}", not a -stage database`);
}

function applyOpenauthMigrations(): void {
	const tables = query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='_openauth_migrations'");
	const applied = new Set(tables.length ? query<{ name: string }>('SELECT name FROM _openauth_migrations').map((r) => r.name) : []);
	const files = readdirSync(OPENAUTH_MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
	for (const file of files) {
		if (applied.has(file)) continue;
		const path = join(OPENAUTH_MIGRATIONS, file);
		execFile(path);
		const checksum = createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex').slice(0, 16);
		query(
			`INSERT OR REPLACE INTO _openauth_migrations (name, applied_at, checksum) VALUES (${sqlString(file)}, ${Date.now()}, ${sqlString(checksum)})`
		);
		process.stdout.write(`  openauth: applied ${file}\n`);
	}
}

/**
 * Stage clients mirror prod's LIVE redirect URIs (read-only SELECT on prod), not
 * the migration seed: prod rows have been edited by hand (e.g. the web client's
 * /api/callback/multi-account), and stage must test what prod actually accepts.
 */
function rewriteRedirectUris(): void {
	const prod = new Map(
		query<{ id: string; redirect_uris: string }>("SELECT id, redirect_uris FROM oauth_clients WHERE redirect_uris <> '[]'", 'production').map(
			(c) => [c.id, JSON.parse(c.redirect_uris) as string[]]
		)
	);
	const clients = query<{ id: string; redirect_uris: string }>("SELECT id, redirect_uris FROM oauth_clients WHERE redirect_uris <> '[]'");
	for (const client of clients) {
		const current = JSON.parse(client.redirect_uris) as string[];
		const source = prod.get(client.id);
		if (!source) {
			process.stdout.write(`  client ${client.id}: not in prod, left as seeded\n`);
			continue;
		}
		const stage = toStageRedirectUris(source);
		if (stage.length === 0 || JSON.stringify(stage) === JSON.stringify(current)) continue;
		query(`UPDATE oauth_clients SET redirect_uris = ${sqlString(JSON.stringify(stage))}, updated_at = ${Date.now()} WHERE id = ${sqlString(client.id)}`);
		process.stdout.write(`  client ${client.id}: ${stage.join(', ')}\n`);
	}
}

function setAdminSecret(): void {
	const secret = process.env.ADMIN_CLIENT_SECRET;
	if (!secret) throw new Error('--set-admin-secret needs ADMIN_CLIENT_SECRET in the environment');
	const admin = parseJsonc(readFileSync(join(ROOT, 'apps/admin/wrangler.json'), 'utf8')) as {
		env: Record<string, { vars: Record<string, string> }>;
	};
	const clientId = admin.env[ENV].vars.ADMIN_CLIENT_ID;
	if (query(`SELECT id FROM oauth_clients WHERE id = ${sqlString(clientId)}`).length !== 1) {
		throw new Error(`admin client ${clientId} does not exist in the stage database`);
	}
	query(`UPDATE oauth_clients SET client_secret_hash = ${sqlString(hashClientSecret(secret))}, updated_at = ${Date.now()} WHERE id = ${sqlString(clientId)}`);
	process.stdout.write(`  admin client ${clientId}: secret hash updated\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	assertStageTarget();
	process.stdout.write('1/5 openauth migrations\n');
	applyOpenauthMigrations();
	process.stdout.write('2/5 app migrations\n');
	wrangler(['d1', 'migrations', 'apply', 'AUTH_DB', '--remote']);
	process.stdout.write('3/5 roles and client tenants\n');
	execFile(join(AUTH_DIR, 'scripts/seed-openauth-roles.sql'));
	execFile(join(AUTH_DIR, 'scripts/fix-oauth-client-tenant.sql'));
	process.stdout.write('4/5 stage redirect URIs\n');
	rewriteRedirectUris();
	if (process.argv.includes('--set-admin-secret')) {
		process.stdout.write('5/5 admin M2M secret\n');
		setAdminSecret();
	} else {
		process.stdout.write('5/5 admin M2M secret: skipped (pass --set-admin-secret to rotate)\n');
	}
	process.stdout.write('Stage database ready.\n');
}
