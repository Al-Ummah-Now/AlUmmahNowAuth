/**
 * Owner break-glass for staff passkeys (wiki epics/AUTH-PASSKEYS, "Recovery"):
 * mints the same single-use, 24-hour passkey setup link an admin sends from the
 * auth admin (POST /admin/users/:id/passkeys/setup-link), straight into D1, so
 * the owner is never locked out, even as the only Super Admin.
 *
 *   node --experimental-strip-types scripts/passkeys/setup-link.ts <email> --env <qa|stage|production>
 *
 * The person signs in (password or email code), opens the link and adds a
 * passkey with no extra email code. Only the SHA-256 of the token is stored;
 * the link is printed once, to this terminal, and nowhere else.
 *
 * D1 by key only (users by lower(email), index idx_users_email_lower; one
 * INSERT by primary key). Needs CLOUDFLARE_API_TOKEN with D1:Edit, or
 * `wrangler login`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCfClient, d1Query, type CfClient } from '../release/cf-api.ts';
import { parseJsonc } from '../release/jsonc.ts';
import { resolveEnv, type WranglerConfig } from '../release/wrangler-config.ts';

/** Same lifetime as SETUP_TICKET_TTL_MS in apps/auth/src/passkeys/store.ts. */
export const SETUP_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
export const ENVS = ['qa', 'stage', 'production'] as const;
export type AuthEnv = (typeof ENVS)[number];

/** Raw token (base64url of 32 random bytes) and the hex SHA-256 that D1 stores, as createSetupTicket does. */
export function newTicket(): { token: string; hash: string } {
	const token = randomBytes(32).toString('base64url');
	return { token, hash: createHash('sha256').update(token).digest('hex') };
}

/** AUTH_DB database id and the public host of an auth environment. */
export function authTarget(env: AuthEnv, repoRoot: string): { db: string; host: string } {
	const file = env === 'qa' ? 'apps/auth/wrangler.qa.json' : 'apps/auth/wrangler.json';
	const config = parseJsonc(readFileSync(resolve(repoRoot, file), 'utf8')) as WranglerConfig;
	const resolved = resolveEnv(config, env === 'qa' ? null : env);
	const db = (resolved.config.d1_databases as { binding: string; database_id: string }[] | undefined)?.find((b) => b.binding === 'AUTH_DB')
		?.database_id;
	const host = resolved.hosts.find((h) => h.startsWith('auth.'));
	if (!db || !host) throw new Error(`${file} (${env}) has no AUTH_DB binding or auth host`);
	return { db, host };
}

export function setupLink(host: string, token: string, lang?: string): string {
	const url = new URL('/passkeys/setup', `https://${host}`);
	url.searchParams.set('ticket', token);
	if (lang === 'ar') url.searchParams.set('lang', 'ar');
	return url.toString();
}

export async function mintSetupLink(
	cf: CfClient,
	target: { db: string; host: string },
	email: string,
	now = Date.now(),
): Promise<{ link: string; userId: string; expiresAt: number }> {
	const rows = await d1Query<{ id: string; status: string }>(
		cf,
		target.db,
		'SELECT id, status FROM users WHERE lower(email) = ?1 AND deleted_at IS NULL LIMIT 2',
		[email.trim().toLowerCase()],
	);
	if (rows.length !== 1) throw new Error(rows.length === 0 ? 'No live account with that email' : 'More than one live account with that email');
	const { id: userId, status } = rows[0];
	if (status !== 'active') throw new Error(`The account is ${status}; reactivate it first`);
	const { token, hash } = newTicket();
	const expiresAt = now + SETUP_TICKET_TTL_MS;
	await d1Query(
		cf,
		target.db,
		'INSERT INTO passkey_setup_tickets (token_hash, user_id, created_by, created_at, expires_at, used_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)',
		[hash, userId, 'break-glass', now, expiresAt],
	);
	return { link: setupLink(target.host, token), userId, expiresAt };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const env = argv[argv.indexOf('--env') + 1] as AuthEnv;
	const email = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--env');
	if (!email || !argv.includes('--env') || !ENVS.includes(env)) {
		console.error('Usage: setup-link.ts <email> --env <qa|stage|production>');
		process.exit(2);
	}
	const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');
	mintSetupLink(createCfClient(), authTarget(env, repoRoot), email)
		.then(({ link, userId, expiresAt }) => {
			console.info(`Setup link for ${userId} (${env}), single use, until ${new Date(expiresAt).toISOString()}:`);
			console.info(link);
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
