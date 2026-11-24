/**
 * QA's cleanup of old test accounts (#312, AUTH-R6 R6-8). The owner approved it on 2026-11-23,
 * after a dry run.
 *
 *   POST /test/run-users/disposable?after=<user id>&dryRun=1|0&limit=<n>&parallel=<n>
 *
 * One call walks at most SCAN_PAGE accounts by primary key and, with dryRun=0, deletes at most
 * DELETE_PER_CALL of them (fewer with limit). It returns counts and the user id to go on from, never an address.
 * Deleted accounts are gone, so starting again from the beginning is always safe.
 *
 * Deletes an account only when ALL of these hold (disposable()), read from the row and checked
 * again by the UPDATE that marks it deleted:
 *   - its address has one of the old E2E suites' patterns (utils/e2e-accounts.ts "disposable"):
 *     seeded, pinned, run, unrecognised and other-domain accounts never match;
 *   - created more than 24 hours ago;
 *   - no sign-in within 48 hours;
 *   - no run marker (the run routes delete those).
 *
 * Runs only where every one of these says QA: the environment, the issuer, the host asked for, the
 * E2E_DISPOSABLE_DELETE var (QA's config only) and the database itself (database_identity, created
 * by a migration that only QA's database has).
 */
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { HANDLERS, type DeletionEnv } from '../deletions/kinds';
import { auditDeletion } from '../deletions/service';
import { DeletionStore, type DeletionRow } from '../deletions/store';
import { logger } from '../logger';
import { e2eAccountKind } from '../utils/e2e-accounts';
import { RUN_USER_MARKER } from '../utils/e2e-sink';

export const SCAN_PAGE = 200;
export const DELETE_PER_CALL = 10;
/** Erases side by side within a call, at most */
export const MAX_PARALLEL = 5;
export const QA_DATABASE = 'al-ummah-now-d1-qa';
export const DISPOSABLE_FLAG = 'enabled';
const QA_HOST = 'auth.qa.alummahnow.net';
const HOUR = 60 * 60 * 1000;
const ACTOR = 'e2e-disposable-cleanup';

export interface DisposableEnv {
	AUTH_DB: D1Database;
	ENVIRONMENT?: string;
	OPENAUTH_ISSUER?: string;
	E2E_DISPOSABLE_DELETE?: string;
}

/** Every sign that this is QA, ending with the database's own name. */
export async function isQaDatabase(env: DisposableEnv, host: string): Promise<boolean> {
	if (env.ENVIRONMENT !== 'qa') return false;
	if (env.OPENAUTH_ISSUER !== `https://${QA_HOST}`) return false;
	if (host !== QA_HOST) return false;
	if (env.E2E_DISPOSABLE_DELETE !== DISPOSABLE_FLAG) return false;
	try {
		const { results } = await env.AUTH_DB.prepare('SELECT name FROM database_identity LIMIT 2').all<{ name: string }>();
		return results.length === 1 && results[0].name === QA_DATABASE;
	} catch {
		return false; // no such table: not QA's database
	}
}

export interface AccountRow {
	id: string;
	email: string;
	tenant_id: string;
	created_at: number;
	deleted_at: number | null;
	last_login_at: number | null;
	marked: number;
	admin: number;
}

/** The run marker; metadata that cannot be read counts as marked, so the account is kept. */
const MARKED = `(CASE WHEN metadata IS NULL THEN 0 WHEN json_valid(metadata) THEN json_extract(metadata, '$.${RUN_USER_MARKER}') IS NOT NULL ELSE 1 END)`;

export const DISPOSABLE_SQL = `SELECT id, email, tenant_id, created_at, deleted_at, last_login_at,
	${MARKED} AS marked,
	EXISTS (SELECT 1 FROM rbac_user_roles ur JOIN rbac_roles r ON r.id = ur.role_id
		WHERE ur.user_id = users.id AND lower(r.name) IN ('admin', 'super admin', 'super_admin')) AS admin
	FROM users WHERE id > ? ORDER BY id LIMIT ?`;

export function disposable(row: AccountRow, now: number): boolean {
	return (
		e2eAccountKind(row.email) === 'disposable' &&
		!row.marked &&
		row.created_at < now - 24 * HOUR &&
		(row.last_login_at === null || row.last_login_at < now - 48 * HOUR)
	);
}

/** The same rules at the moment of writing: an account used since it was read is left alone. */
export const MARK_DELETED_SQL = `UPDATE users SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?2), updated_at = ?2
	WHERE id = ?1 AND email = ?3 AND created_at < ?4 AND (last_login_at IS NULL OR last_login_at < ?5)
	AND ${MARKED} = 0`;

async function erase(env: DeletionEnv, row: AccountRow, now: number): Promise<boolean> {
	const marked = await env.AUTH_DB.prepare(MARK_DELETED_SQL)
		.bind(row.id, now, row.email, now - 24 * HOUR, now - 48 * HOUR)
		.run();
	if ((marked.meta?.changes ?? 0) !== 1) return false;
	const deletion: DeletionRow = {
		kind: 'user',
		item_id: row.id,
		tenant_id: row.tenant_id,
		label: row.email,
		deleted_at: row.deleted_at ?? now,
		deleted_by: ACTOR,
		deleted_by_email: null,
		reason: 'QA test account cleanup (#312)',
		purge_requested_at: now,
		purge_requested_by: ACTOR,
		snapshot: null,
		attempts: 0,
		last_error: null,
	};
	// The account's own purge (every statement by index), then its entry in the list of deleted items
	await HANDLERS.user.purge(env, deletion);
	await new DeletionStore(env.AUTH_DB).removeStatement('user', row.id).run();
	return true;
}

const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** The caller has already checked both test secrets and the rate limit (routes/test-run-users.ts). */
export async function disposableUsers(url: URL, env: DisposableEnv, now = Date.now()): Promise<Response | null> {
	if (!(await isQaDatabase(env, url.hostname))) return null;
	const dryRun = url.searchParams.get('dryRun') !== '0'; // anything else is a dry run
	const asked = Number(url.searchParams.get('limit') ?? DELETE_PER_CALL);
	if (!Number.isInteger(asked) || asked < 1) return json({ error: 'limit must be a whole number >= 1' }, 400);
	const limit = Math.min(asked, DELETE_PER_CALL);
	const side = Number(url.searchParams.get('parallel') ?? 1);
	if (!Number.isInteger(side) || side < 1) return json({ error: 'parallel must be a whole number >= 1' }, 400);
	const parallel = Math.min(side, MAX_PARALLEL);
	const { results: rows } = await env.AUTH_DB.prepare(DISPOSABLE_SQL)
		.bind(url.searchParams.get('after') ?? '', SCAN_PAGE)
		.all<AccountRow>();

	const counts = { scanned: 0, eligible: 0, eligibleAdmins: 0, deleted: 0, deletedAdmins: 0, skipped: 0, failed: 0 };
	/** Where accounts made in the last day come from: the part of the address before the timestamp */
	const recentPrefixes: Record<string, number> = {};
	const todo: AccountRow[] = [];
	let next: string | null = rows.length === SCAN_PAGE ? rows[rows.length - 1].id : null;
	for (const row of rows) {
		counts.scanned++;
		if (e2eAccountKind(row.email) === 'disposable' && row.created_at >= now - 24 * HOUR) {
			const prefix = row.email.replace(/-1[789]\d{11}(-[a-z0-9]+)?@.*$/i, '');
			recentPrefixes[prefix] = (recentPrefixes[prefix] ?? 0) + 1;
		}
		if (!disposable(row, now)) continue;
		counts.eligible++;
		if (row.admin) counts.eligibleAdmins++;
		if (dryRun) continue;
		todo.push(row);
		if (todo.length >= limit) {
			next = row.id;
			break;
		}
	}
	// Most of an erase is waiting for the database, so a few run side by side. Each one on its own:
	// a failure never stops or undoes the others.
	for (let i = 0; i < todo.length; i += parallel) {
		await Promise.all(
			todo.slice(i, i + parallel).map(async (row) => {
				try {
					if (await erase(env as unknown as DeletionEnv, row, now)) {
						counts.deleted++;
						if (row.admin) counts.deletedAdmins++;
					} else counts.skipped++;
				} catch (error) {
					counts.failed++;
					logger.error('QA account cleanup failed for one account', { userId: row.id, error: error instanceof Error ? error.message : String(error) });
				}
			})
		);
	}
	if (counts.deleted > 0) {
		// One event per call, not three per account: 47,000 accounts would bury QA's audit log
		await auditDeletion(
			AuditEventType.ADMIN_ITEM_PURGED,
			null,
			{ kind: 'user', trigger: ACTOR, accounts: counts.deleted, admins: counts.deletedAdmins },
			AuditEventSeverity.CRITICAL
		);
	}
	return json({ dryRun, ...counts, recentPrefixes: dryRun ? recentPrefixes : {}, next }, 200);
}
