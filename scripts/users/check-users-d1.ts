/**
 * Read-only check for AU-3 (D1 is the source of truth for users).
 *
 *   node --experimental-strip-types scripts/users/check-users-d1.ts --env production|stage|qa [--json]
 *
 * Compares OpenAuth's old KV user copy (`user::<tenant>::<id>` records and
 * `user::email::<tenant>::<email>` index entries) with the D1 `users` table and
 * reports:
 *   - kvOnly: users with a KV record and no D1 row. The auth Worker still finds
 *     them (by email or id) and copies them into D1 on first read.
 *   - ghosts: kvOnly users whose address belongs to another live D1 user; they are
 *     not served (the D1 account owns the address), as intended.
 *   - drift: users whose KV record disagrees with D1 on email, status or deletion.
 *     D1 wins; this shows what the old KV-first code would have got wrong.
 *   - staleEmailIndex: KV email entries that no longer match a live D1 user with
 *     that address (ignored by the Worker).
 * Prints user ids and counts, never emails. Only reads (KV list/get, D1 SELECT).
 *
 * Needs CLOUDFLARE_API_TOKEN with Workers KV Storage:Read and D1:Read (locally,
 * `wrangler login` is enough).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCfClient, d1Query, kvGetJson, kvListKeys, type CfClient } from '../release/cf-api.ts';
import { parseJsonc } from '../release/jsonc.ts';
import { resolveEnv, type WranglerConfig } from '../release/wrangler-config.ts';

const SEPARATORS = ['::', String.fromCharCode(0x1f)];

export type ParsedKey =
	| { kind: 'user'; tenant: string; id: string }
	| { kind: 'email'; tenant: string; email: string }
	| { kind: 'other' };

/** Classifies an OpenAuth user-storage KV key (current `::` or legacy 0x1f separator). */
export function parseUserKey(name: string): ParsedKey {
	const sep = SEPARATORS.find((s) => name.startsWith(`user${s}`));
	if (!sep) return { kind: 'other' };
	const parts = name.split(sep);
	if (parts[1] === 'email' && parts.length >= 4) return { kind: 'email', tenant: parts[2], email: parts.slice(3).join(sep) };
	if (parts[1] === 'identity' || parts[1] === 'email') return { kind: 'other' };
	if (parts.length === 3) return { kind: 'user', tenant: parts[1], id: parts[2] };
	return { kind: 'other' };
}

export interface KvUser {
	id: string;
	tenant_id: string;
	email?: string;
	status?: string;
	deleted_at?: number | null;
}

export interface D1User {
	id: string;
	tenant_id: string;
	email: string;
	status: string;
	deleted_at: number | null;
}

export interface EmailEntry {
	tenant: string;
	email: string;
	userId?: string;
}

export interface UsersReport {
	kvUserRecords: number;
	kvEmailEntries: number;
	d1Users: number;
	kvOnly: { id: string; tenant: string; status: string }[];
	ghosts: { id: string; tenant: string; ownedBy: string }[];
	drift: { id: string; tenant: string; fields: string[] }[];
	staleEmailIndex: number;
}

const norm = (email: string | undefined) => (email ?? '').toLowerCase().trim();
const isDeleted = (u: { status?: string; deleted_at?: number | null }) => u.status === 'deleted' || (u.deleted_at ?? null) !== null;

export function compareUsers(kvUsers: KvUser[], emailEntries: EmailEntry[], d1Users: D1User[]): UsersReport {
	const byId = new Map(d1Users.map((u) => [`${u.tenant_id}\n${u.id}`, u]));
	const liveByEmail = new Map(d1Users.filter((u) => u.deleted_at === null).map((u) => [`${u.tenant_id}\n${norm(u.email)}`, u]));
	const report: UsersReport = {
		kvUserRecords: kvUsers.length,
		kvEmailEntries: emailEntries.length,
		d1Users: d1Users.length,
		kvOnly: [],
		ghosts: [],
		drift: [],
		staleEmailIndex: 0,
	};
	for (const kv of kvUsers) {
		const d1 = byId.get(`${kv.tenant_id}\n${kv.id}`);
		if (!d1) {
			const owner = isDeleted(kv) ? undefined : liveByEmail.get(`${kv.tenant_id}\n${norm(kv.email)}`);
			if (owner) report.ghosts.push({ id: kv.id, tenant: kv.tenant_id, ownedBy: owner.id });
			else report.kvOnly.push({ id: kv.id, tenant: kv.tenant_id, status: kv.status ?? 'active' });
			continue;
		}
		const fields: string[] = [];
		if (norm(kv.email) !== norm(d1.email)) fields.push('email');
		if ((kv.status ?? 'active') !== d1.status) fields.push('status');
		if (isDeleted(kv) !== (d1.deleted_at !== null)) fields.push('deleted');
		if (fields.length) report.drift.push({ id: kv.id, tenant: kv.tenant_id, fields });
	}
	for (const entry of emailEntries) {
		const live = liveByEmail.get(`${entry.tenant}\n${norm(entry.email)}`);
		if (!live || live.id !== entry.userId) report.staleEmailIndex++;
	}
	return report;
}

/** KV namespace id (AUTH_STORAGE) and D1 database id (AUTH_DB) of an auth environment. */
export function authStores(env: string, repoRoot: string): { kv: string; db: string } {
	const file = env === 'qa' ? 'apps/auth/wrangler.qa.json' : 'apps/auth/wrangler.json';
	const config = parseJsonc(readFileSync(resolve(repoRoot, file), 'utf8')) as WranglerConfig;
	const { config: effective } = resolveEnv(config, env === 'qa' ? null : env);
	const kv = (effective.kv_namespaces as { binding: string; id: string }[] | undefined)?.find((b) => b.binding === 'AUTH_STORAGE')?.id;
	const db = (effective.d1_databases as { binding: string; database_id: string }[] | undefined)?.find((b) => b.binding === 'AUTH_DB')?.database_id;
	if (!kv || !db) throw new Error(`${file} (${env}) has no AUTH_STORAGE / AUTH_DB binding`);
	return { kv, db };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		})
	);
	return out;
}

export async function collect(cf: CfClient, stores: { kv: string; db: string }): Promise<UsersReport> {
	const names = (await Promise.all(SEPARATORS.map((sep) => kvListKeys(cf, stores.kv, `user${sep}`)))).flat();
	const parsed = names.map((name) => ({ name, key: parseUserKey(name) }));
	const userKeys = parsed.filter((p) => p.key.kind === 'user');
	const emailKeys = parsed.filter((p) => p.key.kind === 'email');
	const kvUsers = (
		await mapLimit(userKeys, 8, async ({ name, key }) => {
			const value = (await kvGetJson(cf, stores.kv, name)) as Partial<KvUser> | undefined;
			const k = key as { tenant: string; id: string };
			return value ? ({ ...value, id: k.id, tenant_id: k.tenant } as KvUser) : undefined;
		})
	).filter((u): u is KvUser => !!u);
	const emailEntries = await mapLimit(emailKeys, 8, async ({ name, key }) => {
		const value = (await kvGetJson(cf, stores.kv, name)) as { userId?: string } | undefined;
		const k = key as { tenant: string; email: string };
		return { tenant: k.tenant, email: k.email, userId: value?.userId };
	});
	const d1Users = await d1Query<D1User>(cf, stores.db, 'SELECT id, tenant_id, email, status, deleted_at FROM users');
	return compareUsers(kvUsers, emailEntries, d1Users);
}

function printReport(env: string, r: UsersReport) {
	console.info(`AU-3 users check (${env}): ${r.d1Users} D1 users, ${r.kvUserRecords} KV user records, ${r.kvEmailEntries} KV email entries`);
	console.info(`  KV-only (served from KV, copied to D1 on first read): ${r.kvOnly.length}`);
	for (const u of r.kvOnly) console.info(`    ${u.tenant}/${u.id} (${u.status})`);
	console.info(`  KV ghosts (address owned by another D1 user, not served): ${r.ghosts.length}`);
	for (const u of r.ghosts) console.info(`    ${u.tenant}/${u.id} -> ${u.ownedBy}`);
	console.info(`  KV records that disagree with D1 (D1 wins): ${r.drift.length}`);
	for (const u of r.drift) console.info(`    ${u.tenant}/${u.id}: ${u.fields.join(', ')}`);
	console.info(`  Stale KV email entries (ignored): ${r.staleEmailIndex}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const env = argv[argv.indexOf('--env') + 1];
	if (!argv.includes('--env') || !['production', 'stage', 'qa'].includes(env)) {
		console.error('Usage: check-users-d1.ts --env production|stage|qa [--json]');
		process.exit(2);
	}
	const report = await collect(createCfClient(), authStores(env, resolve(import.meta.dirname, '../..')));
	if (argv.includes('--json')) console.info(JSON.stringify(report, null, 2));
	else printReport(env, report);
}
