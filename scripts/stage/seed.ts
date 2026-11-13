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
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonc } from '../release/jsonc.ts';
import { AUTH_DIR, execSqlFile, migrateAuthDb, query as dbQuery, sqlString } from '../release/d1-migrate.ts';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ENV = 'stage';

/** Prod host → stage host, for client redirect URIs. */
export const STAGE_HOSTS: Record<string, string> = {
	'videos.alummahnow.net': 'videos.stage.alummahnow.net',
	'admin.alummahnow.net': 'admin.stage.alummahnow.net',
	'profile.auth.alummahnow.net': 'profile.auth.stage.alummahnow.net',
	'admin.auth.alummahnow.net': 'admin.auth.stage.alummahnow.net',
	'www.alummahnow.net': 'www.stage.alummahnow.net',
	'cms.alummahnow.net': 'cms.stage.alummahnow.net',
};

/** The native apps' private-use URI schemes (Epic 9.1): the same on every environment. */
export const NATIVE_SCHEMES = new Set(['alummahnow:', 'alummahnow-studio:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const STAGE_HOST_SET = new Set(Object.values(STAGE_HOSTS));

/**
 * Rewrites prod redirect URIs to stage; drops localhost and unknown hosts.
 * Native app redirects (our custom schemes, loopback http://127.0.0.1) are kept as they are.
 */
export function toStageRedirectUris(uris: string[]): string[] {
	const out: string[] = [];
	for (const uri of uris) {
		let url: URL;
		try {
			url = new URL(uri);
		} catch {
			continue;
		}
		if (NATIVE_SCHEMES.has(url.protocol) || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
			out.push(uri);
			continue;
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
		// Already rewritten (a row seeded before prod has it): no change
		if (STAGE_HOST_SET.has(url.hostname)) return [];
		const stageHost = STAGE_HOSTS[url.hostname];
		if (!stageHost) continue;
		url.hostname = stageHost;
		out.push(url.toString());
	}
	return [...new Set(out)];
}

/**
 * Stage redirect URIs for one client: prod's live values when the client exists
 * in prod, else its seeded (prod-host) values. Stage releases before prod, so a
 * client added by a new migration reaches stage first; rewriting its seed lets
 * stage test it in the same release. Already-rewritten rows yield [] (no change).
 */
export function stageRedirectUrisFor(prodUris: string[] | undefined, seeded: string[]): string[] {
	return toStageRedirectUris(prodUris ?? seeded);
}

/** Same format as @al-ummah-now/openauth's hashClientSecret (PBKDF2-SHA256, 100k). */
export function hashClientSecret(secret: string, salt: Buffer = randomBytes(16)): string {
	const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	const hash = pbkdf2Sync(Buffer.from(secret, 'utf8'), salt, 100000, 32, 'sha256');
	return `$pbkdf2-sha256$100000$${b64url(salt)}$${b64url(hash)}`;
}

const query = <T>(sql: string, env: 'stage' | 'production' = ENV) => dbQuery<T>(sql, env);
const execFile = (path: string) => execSqlFile(path, ENV);

function assertStageTarget(): void {
	const config = parseJsonc(readFileSync(join(AUTH_DIR, 'wrangler.json'), 'utf8')) as {
		env: Record<string, { d1_databases: { database_name: string }[] }>;
	};
	const db = config.env[ENV]?.d1_databases?.[0]?.database_name ?? '';
	if (!db.endsWith('-stage')) throw new Error(`refusing to seed: env.${ENV} AUTH_DB is "${db}", not a -stage database`);
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
		const stage = stageRedirectUrisFor(prod.get(client.id), current);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	assertStageTarget();
	process.stdout.write('1-2/5 openauth and app migrations\n');
	migrateAuthDb(ENV);
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
