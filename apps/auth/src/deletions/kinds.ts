/**
 * What deleting, restoring and purging means for each kind of item.
 *
 *   user    delete: users.status = 'deleted' + deleted_at (sign-in, refresh and
 *           every listing already refuse such a user), signed out everywhere.
 *           restore: the status before deletion, unless another live account
 *           has taken the email since. purge: the users row and everything
 *           keyed by the user (identities, role links, sessions, codes,
 *           refresh tokens, the password credential, old KV copies). Subscribed
 *           apps are told of each (account-events/): hide, show again, erase.
 *   client  delete: enabled = 0 (/authorize and client credentials refuse
 *           disabled clients). restore: the enabled flag it had. purge: the
 *           oauth_clients row (its permissions cascade) and its theme default.
 *   role    delete: its user and permission links move into the snapshot, so
 *           nobody holds the role any more. restore: the links come back
 *           (those whose permission still exists). purge: the rbac_roles row.
 *   theme   delete: hidden from the admin list, the public theme list and page
 *           rendering (ThemeStore leaves deleted themes out). purge: the row
 *           and its stored packages and files no other theme uses.
 *   tenant  delete: status = 'deleted'. Restore reactivates the tenant. Purge
 *           removes the tenant and its tenant-scoped rows in one transaction.
 *
 * Only purge() removes data, and only the cleanup (purge.ts) calls it.
 */
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { authStorage } from '../storage/auth-storage';
import { CODE_RANGE, CODE_USED_RANGE, DEVICE_RANGE } from '../storage/atomic-ranges';
import { LEGACY_USER_KEYS } from '../services/d1-user-service';
import { revokeUser } from '../revocation/revocation-list';
import { endBrowserSignIns } from '../revocation/lifecycle';
import { revokeUserTokens } from '../custom/token-revocation';
import { ThemeStore } from '../themes/store';
import { ThemeService } from '../themes/service';
import { invalidateThemeSettings } from '../themes/runtime';
import { deleteBirthDate } from '../birth-date/store';
import { clearTenantCache } from '../services/tenant-cache';
import { DEFAULT_TENANT_ID } from '../types/tenant';
import { logger } from '../logger';
import { enqueue, recordAccountEvent } from '../account-events/record';
import { withoutAccountEvents } from '../account-events/types';
import { generateErasedSubject, redactUserAuditEvents, type AuditRedactionOptions } from './audit-redaction';
import { DeletionStore, userPurgeClaimed, type DeletionKind, type DeletionRow } from './store';

export class DeletionError extends Error {
	constructor(
		public status: 400 | 403 | 404 | 409 | 503,
		public code: string,
		message: string
	) {
		super(message);
		this.name = 'DeletionError';
	}
}

export type DeletionEnv = Pick<Env, 'AUTH_DB' | 'AUTH_STORAGE' | 'TOKEN_REVOCATIONS' | 'AUTH_THEMES' | 'ACCOUNT_EVENTS' | 'ACCOUNT_EVENTS_QUEUE'>;

export const PURGE_TIME_BUDGET_MS = 1_500;
export const DISPOSABLE_CLEANUP_ACTOR = 'e2e-disposable-cleanup';

export interface PurgeOptions {
	/** Overrides for batched audit_events redaction (tests / tuning). */
	auditRedaction?: Omit<AuditRedactionOptions, 'deadline'>;
	deadline?: number;
}

export type PurgeOutcome = 'done' | 'deferred' | void;

/** The item as it is before deletion: its label and what restore needs. */
export interface Prepared {
	label: string | null;
	snapshot?: unknown;
	/** Statements that hide the item, run in one batch with the admin_deletions insert. */
	statements: D1PreparedStatement[];
	/** Work after the batch (sign-outs, cache invalidation). */
	after?: () => Promise<void>;
}

export interface KindHandler {
	prepare(env: DeletionEnv, itemId: string, ctx: { tenantId: string; actorId: string; now: number }): Promise<Prepared>;
	/** Statements that un-hide the item, run in one batch with the admin_deletions delete. */
	restore(env: DeletionEnv, row: DeletionRow, now: number): Promise<{ statements: D1PreparedStatement[]; after?: () => Promise<void> }>;
	/**
	 * Removes the item for good. Idempotent: a retry after a partial run finishes the job.
	 * Returns `'deferred'` when bounded batch work needs another run (not a failure).
	 */
	purge(env: DeletionEnv, row: DeletionRow, opts?: PurgeOptions): Promise<PurgeOutcome>;
}

const snapshotOf = <T>(row: DeletionRow): Partial<T> => {
	try {
		return row.snapshot ? ((JSON.parse(row.snapshot) as Partial<T> | null) ?? {}) : {};
	} catch {
		return {};
	}
};

/** Runs one cleanup statement; a table this environment never created has nothing to remove. */
async function run(stmt: D1PreparedStatement): Promise<number> {
	try {
		return (await stmt.run()).meta?.changes ?? 0;
	} catch (error) {
		if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return 0;
		throw error;
	}
}

// ------------------------------------------------------------------ users

interface UserSnapshot {
	status: string;
	email: string;
	/** The irreversible purge claim and its random subject, removed when the purge finishes. */
	erased_audit_id?: string;
}

const user: KindHandler = {
	async prepare(env, userId, { tenantId, actorId, now }) {
		const row = await env.AUTH_DB.prepare('SELECT id, email, status FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL')
			.bind(userId, tenantId)
			.first<{ id: string; email: string; status: string }>();
		if (!row) throw new DeletionError(404, 'user_not_found', `User '${userId}' not found`);
		if (userId === actorId) throw new DeletionError(409, 'cannot_delete_self', 'You cannot delete your own account here');
		// Apps hide its content now; they erase it when it is purged
		const event = await recordAccountEvent(env, { type: 'account-disabled', userId, reason: 'deleted' }, { now, onlyIf: 'live' });
		return {
			label: row.email,
			snapshot: { status: row.status, email: row.email } satisfies UserSnapshot,
			statements: [
				...event.statements,
				env.AUTH_DB.prepare(
					`UPDATE users SET status = 'deleted', deleted_at = ?3, updated_at = ?3 WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`
				).bind(userId, tenantId, now),
			],
			// No token minted before now works any more, and no browser signs the user back in
			after: async () => {
				await revokeUser({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, userId, 'admin_deleted');
				await revokeUserTokens(userId, env.AUTH_DB);
				await endBrowserSignIns(env.AUTH_DB, userId);
				await enqueue(env, event.jtis, now);
			},
		};
	},

	async restore(env, row, now) {
		const snap = snapshotOf<UserSnapshot>(row);
		// An invited account (docs/USER_INVITES.md) comes back invited: only a sign-in claims it
		const status = snap.status === 'suspended' || snap.status === 'invited' ? snap.status : 'active';
		const current = await env.AUTH_DB.prepare('SELECT email, tenant_id FROM users WHERE id = ?').bind(row.item_id).first<{ email: string; tenant_id: string }>();
		if (!current) throw new DeletionError(404, 'user_not_found', 'The account no longer exists');
		const taken = await env.AUTH_DB.prepare('SELECT id FROM users WHERE tenant_id = ? AND email = ? AND deleted_at IS NULL AND id != ?')
			.bind(current.tenant_id, current.email, row.item_id)
			.first();
		if (taken) throw new DeletionError(409, 'email_in_use', `Another account now uses ${current.email}; it can't be restored`);
		const event = await recordAccountEvent(env, { type: 'account-enabled', userId: row.item_id }, { now, onlyIf: 'restorable' });
		return {
			statements: [
				...event.statements,
				env.AUTH_DB.prepare(`UPDATE users SET status = ?2, deleted_at = NULL, updated_at = ?3
					WHERE id = ?1 AND deleted_at IS NOT NULL AND NOT ${userPurgeClaimed('users.id')}`).bind(
					row.item_id,
					status,
					now
				),
			],
			after: () => enqueue(env, event.jtis, now).then(() => undefined),
		};
	},

	async purge(env, row, opts) {
		const db = env.AUTH_DB;
		const userId = row.item_id;
		const deadline = opts?.deadline ?? Date.now() + PURGE_TIME_BUDGET_MS;
		const found = await db.prepare('SELECT email, tenant_id, deleted_at FROM users WHERE id = ?').bind(userId).first<{ email: string; tenant_id: string; deleted_at: number | null }>();
		// Restored behind the cleanup's back (or re-created): never purge a live account
		if (found && found.deleted_at === null) throw new DeletionError(409, 'user_live', 'The account is not deleted');
		if (Date.now() >= deadline) return 'deferred';

		// Whoever claims the snapshot first fixes the subject for all retries and overlapping runs.
		// A restore that already removed the snapshot wins instead, and the purge stops.
		const store = new DeletionStore(db);
		const snap = snapshotOf<UserSnapshot>(row);
		let claimed: DeletionRow | null = row;
		if (!snap.erased_audit_id) {
			const snapshot = JSON.stringify({ ...snap, erased_audit_id: generateErasedSubject() });
			claimed = await store.claimUserPurge(row, snapshot);
			claimed ??= await store.get('user', userId);
		}
		if (!claimed || claimed.deleted_at !== row.deleted_at) return 'deferred';
		const erasedSubject = snapshotOf<UserSnapshot>(claimed).erased_audit_id;
		if (!erasedSubject) return 'deferred';

		const auditRedaction = await redactUserAuditEvents(db, userId, erasedSubject, { ...opts?.auditRedaction, deadline });
		if (auditRedaction.remaining || Date.now() >= deadline) {
			logger.info('[deletions] Audit event redaction deferred to next run', {
				userId,
				redacted: auditRedaction.redacted,
				batches: auditRedaction.batches,
			});
			return 'deferred';
		}

		const email = (found?.email ?? snap.email ?? row.label ?? '').toLowerCase();
		const tenantId = found?.tenant_id ?? row.tenant_id;
		const { results: identities } = await db
			.prepare('SELECT provider, provider_user_id FROM user_identities WHERE user_id = ?')
			.bind(userId)
			.all<{ provider: string; provider_user_id: string }>()
			.catch(() => ({ results: [] as { provider: string; provider_user_id: string }[] }));

		// KV: the old user copies, the password credential, the email -> subject record and the
		// cached permissions
		const storage = authStorage(env);
		await Storage.remove(storage, LEGACY_USER_KEYS.user(tenantId, userId));
		for (const id of identities ?? []) await Storage.remove(storage, LEGACY_USER_KEYS.identity(tenantId, id.provider, id.provider_user_id));
		if (email) {
			const lookup = (await Storage.get<{ userId?: string }>(storage, LEGACY_USER_KEYS.email(tenantId, email))) as { userId?: string } | undefined;
			if (!lookup || lookup.userId === userId) await Storage.remove(storage, LEGACY_USER_KEYS.email(tenantId, email));
			// The credential belongs to the email; another live account with it keeps it
			const live = await db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND deleted_at IS NULL').bind(email).first();
			if (!live) {
				for (const e of new Set([email, found?.email ?? email])) {
					await Storage.remove(storage, ['email', e, 'password']);
					// The password provider writes it on every password sign-in (auth-storage.ts
					// isSubjectRecord): left behind, the deleted person's email stayed in AUTH_STORAGE
					await Storage.remove(storage, ['email', e, 'subject']);
				}
			}
		}
		await env.AUTH_STORAGE.delete(`permissions:${userId}`);

		// The user's OpenAuth subjects (type:<hash of properties>): used-code markers name only the
		// subject. Read from the codes and refresh tokens before they are deleted below (#348).
		const { results: subjectRows } = await db
			.prepare(
				`SELECT DISTINCT json_extract(value, '$.subject') AS subject FROM openauth_atomic
				 WHERE ((key >= '${CODE_RANGE[0]}' AND key < '${CODE_RANGE[1]}') OR (key >= 'oauth:refresh' AND key < 'oauth:refresi'))
				   AND json_extract(value, '$.properties.id') = ?`
			)
			.bind(userId)
			.all<{ subject: string | null }>()
			.catch(() => ({ results: [] as { subject: string | null }[] }));
		const subjects = subjectRows.map((r) => r.subject).filter((s): s is string => typeof s === 'string' && s.length > 0);

		// D1: every row keyed by the user, then the user (FK cascades cover the rest)
		const statements = [
			db.prepare('DELETE FROM rbac_user_roles WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM account_sessions WHERE user_id = ?').bind(userId),
			db.prepare('UPDATE browser_sessions SET active_user_id = NULL WHERE active_user_id = ?').bind(userId),
			db.prepare('DELETE FROM tenant_admins WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM tenant_invitations WHERE invited_by = ?').bind(userId),
			db.prepare('DELETE FROM user_identities WHERE user_id = ?').bind(userId),
			// The invites that pre-provisioned the account hold its email (migration 0030; no cascade)
			db.prepare('DELETE FROM user_invite_superseded_tokens WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM user_invites WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM authorization_codes WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId),
			// Profile/admin sessions of the user; idx_app_sessions_user (migration 0032) serves this
			db.prepare(`DELETE FROM app_sessions WHERE json_extract(user_json, '$.id') = ?`).bind(userId),
			// What the profile app kept while the account was being deleted (apps/profile/src/delete-progress.ts progressKey)
			db.prepare('DELETE FROM openauth_atomic WHERE key = ?').bind(`profile:delete-account::${userId}`),
			// OpenAuth refresh tokens (key oauth:refresh/<subject>/<token>); the value names the user.
			// idx_openauth_atomic_refresh_user (migration 0031) serves this; it was a scan of every token (#804)
			db.prepare(
				`DELETE FROM openauth_atomic WHERE key >= 'oauth:refresh' AND key < 'oauth:refresi' AND json_extract(value, '$.properties.id') = ?`
			).bind(userId),
			// Authorization codes issued but never exchanged (#348): they carry the user's properties
			// until they expire (10 min). A key range of short-lived rows, never a table scan.
			db.prepare(
				`DELETE FROM openauth_atomic WHERE key >= '${CODE_RANGE[0]}' AND key < '${CODE_RANGE[1]}' AND json_extract(value, '$.properties.id') = ?`
			).bind(userId),
			// Device-flow approvals waiting for the TV to poll: the grant carries the user's properties
			db.prepare(
				`DELETE FROM openauth_atomic WHERE key >= '${DEVICE_RANGE[0]}' AND key < '${DEVICE_RANGE[1]}' AND json_extract(value, '$.grant.properties.id') = ?`
			).bind(userId),
		];
		// Used-code markers (24 h) name the user's subject and what the code was exchanged for
		for (const subject of subjects) {
			statements.push(
				db
					.prepare(`DELETE FROM openauth_atomic WHERE key >= '${CODE_USED_RANGE[0]}' AND key < '${CODE_USED_RANGE[1]}' AND json_extract(value, '$.subject') = ?`)
					.bind(subject)
			);
		}
		if (email && !(await db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id != ?').bind(email, userId).first())) {
			statements.push(db.prepare('DELETE FROM password_codes WHERE email = ?').bind(email));
			statements.push(db.prepare('DELETE FROM password_login_attempts WHERE email = ?').bind(email));
		}
		// Passkeys, the after-sign-in card's snooze and setup links (AUTH-PASSKEYS), by user id
		statements.push(db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').bind(userId));
		statements.push(db.prepare('DELETE FROM webauthn_prompts WHERE user_id = ?').bind(userId));
		statements.push(db.prepare('DELETE FROM passkey_setup_tickets WHERE user_id = ?').bind(userId));
		statements.push(deleteBirthDate(db, userId));
		for (const stmt of statements) await run(stmt);
		// Apps erase the account's data, told exactly when the row goes: not for a retry that finds it
		// gone, nor for an account restored meanwhile
		// A QA disposable purge that deferred still suppresses account events when cron resumes it.
		const eventEnv = claimed.deleted_by === DISPOSABLE_CLEANUP_ACTOR ? withoutAccountEvents(env) : env;
		const event = await recordAccountEvent(eventEnv, { type: 'account-purged', userId }, { onlyIf: 'deleted' });
		const results = await db.batch([
			...event.statements,
			db.prepare('DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL').bind(userId),
			store.finishUserPurgeStatement(claimed),
		]);
		if (!results.at(-1)?.meta.changes) return 'deferred';
		await enqueue(eventEnv, event.jtis);
		return 'done';
		// user_revocations / TOKEN_REVOCATIONS stay: they hold only the id, a time and a reason
		// code (never the email) and keep any token still in flight dead until the entry expires
	},
};

// ---------------------------------------------------------------- clients

const client: KindHandler = {
	async prepare(env, clientId, { tenantId }) {
		const row = await env.AUTH_DB.prepare('SELECT id, name, enabled FROM oauth_clients WHERE id = ? AND tenant_id = ?')
			.bind(clientId, tenantId)
			.first<{ id: string; name: string; enabled: number | null }>();
		if (!row) throw new DeletionError(404, 'client_not_found', `Client '${clientId}' not found`);
		return {
			label: row.name,
			snapshot: { enabled: row.enabled !== 0 },
			statements: [
				env.AUTH_DB.prepare('UPDATE oauth_clients SET enabled = 0, updated_at = ? WHERE id = ? AND tenant_id = ?').bind(Date.now(), clientId, tenantId),
			],
			after: async () => invalidateThemeSettings(),
		};
	},

	async restore(env, row, now) {
		const exists = await env.AUTH_DB.prepare('SELECT 1 FROM oauth_clients WHERE id = ?').bind(row.item_id).first();
		if (!exists) throw new DeletionError(404, 'client_not_found', 'The client no longer exists');
		const enabled = snapshotOf<{ enabled: boolean }>(row).enabled !== false ? 1 : 0;
		return { statements: [env.AUTH_DB.prepare('UPDATE oauth_clients SET enabled = ?, updated_at = ? WHERE id = ?').bind(enabled, now, row.item_id)] };
	},

	async purge(env, row) {
		const db = env.AUTH_DB;
		await run(db.prepare('DELETE FROM auth_theme_client_defaults WHERE client_id = ?').bind(row.item_id));
		await run(db.prepare('DELETE FROM oauth_clients WHERE id = ? AND tenant_id = ?').bind(row.item_id, row.tenant_id));
		invalidateThemeSettings();
	},
};

// ------------------------------------------------------------------ roles

interface RoleSnapshot {
	users: { user_id: string; tenant_id: string; assigned_at: number; expires_at: number | null; assigned_by: string }[];
	permissions: { permission_id: string; granted_at: number; granted_by: string }[];
}

async function forgetPermissions(env: DeletionEnv, userIds: string[]): Promise<void> {
	for (const id of new Set(userIds)) await env.AUTH_STORAGE.delete(`permissions:${id}`);
}

const role: KindHandler = {
	async prepare(env, roleId, { tenantId }) {
		const db = env.AUTH_DB;
		const row = await db.prepare('SELECT id, name, is_system_role FROM rbac_roles WHERE id = ? AND tenant_id = ?')
			.bind(roleId, tenantId)
			.first<{ id: string; name: string; is_system_role: number }>();
		if (!row) throw new DeletionError(404, 'role_not_found', `Role '${roleId}' not found`);
		if (row.is_system_role) throw new DeletionError(403, 'cannot_delete_system_role', 'System roles cannot be deleted');
		const [users, permissions] = await Promise.all([
			db.prepare('SELECT user_id, tenant_id, assigned_at, expires_at, assigned_by FROM rbac_user_roles WHERE role_id = ?').bind(roleId).all<RoleSnapshot['users'][number]>(),
			db.prepare('SELECT permission_id, granted_at, granted_by FROM rbac_role_permissions WHERE role_id = ?').bind(roleId).all<RoleSnapshot['permissions'][number]>(),
		]);
		const snapshot: RoleSnapshot = { users: users.results ?? [], permissions: permissions.results ?? [] };
		return {
			label: row.name,
			snapshot,
			statements: [
				db.prepare('DELETE FROM rbac_user_roles WHERE role_id = ?').bind(roleId),
				db.prepare('DELETE FROM rbac_role_permissions WHERE role_id = ?').bind(roleId),
			],
			after: () => forgetPermissions(env, snapshot.users.map((u) => u.user_id)),
		};
	},

	async restore(env, row) {
		const db = env.AUTH_DB;
		const exists = await db.prepare('SELECT 1 FROM rbac_roles WHERE id = ?').bind(row.item_id).first();
		if (!exists) throw new DeletionError(404, 'role_not_found', 'The role no longer exists');
		const snap = snapshotOf<RoleSnapshot>(row);
		const users = snap.users ?? [];
		return {
			statements: [
				...users.map((u) =>
					db
						.prepare(
							`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, expires_at, assigned_by)
							 SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)`
						)
						.bind(u.user_id, row.item_id, u.tenant_id, u.assigned_at, u.expires_at, u.assigned_by)
				),
				...(snap.permissions ?? []).map((p) =>
					db
						.prepare(
							`INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id, granted_at, granted_by)
							 SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM rbac_permissions WHERE id = ?2)`
						)
						.bind(row.item_id, p.permission_id, p.granted_at, p.granted_by)
				),
			],
			after: () => forgetPermissions(env, users.map((u) => u.user_id)),
		};
	},

	async purge(env, row) {
		const db = env.AUTH_DB;
		await run(db.prepare('DELETE FROM rbac_user_roles WHERE role_id = ?').bind(row.item_id));
		await run(db.prepare('DELETE FROM rbac_role_permissions WHERE role_id = ?').bind(row.item_id));
		await run(db.prepare('DELETE FROM rbac_roles WHERE id = ? AND tenant_id = ?').bind(row.item_id, row.tenant_id));
	},
};

// ----------------------------------------------------------------- themes

const theme: KindHandler = {
	async prepare(env, themeId) {
		const store = new ThemeStore(env.AUTH_DB, env.AUTH_THEMES);
		const found = await new ThemeService(store).assertRemovable(themeId);
		return { label: found.name_en, statements: [], after: async () => invalidateThemeSettings() };
	},

	async restore(env, row) {
		const exists = await new ThemeStore(env.AUTH_DB, env.AUTH_THEMES).rawRow(row.item_id);
		if (!exists) throw new DeletionError(404, 'theme_not_found', 'The theme no longer exists');
		return { statements: [], after: async () => invalidateThemeSettings() };
	},

	async purge(env, row) {
		const store = new ThemeStore(env.AUTH_DB, env.AUTH_THEMES);
		const removed = await store.purgeRow(row.item_id);
		invalidateThemeSettings();
		if (removed) logger.info('[deletions] Theme files removed', { themeId: row.item_id, ...removed });
	},
};

// ------------------------------------------------------------------ tenants

function protectDefaultTenant(id: string): void {
	if (id === DEFAULT_TENANT_ID) throw new DeletionError(400, 'cannot_delete_default_tenant', 'Cannot delete default tenant');
}

const tenant: KindHandler = {
	async prepare(env, id, { now }) {
		protectDefaultTenant(id);
		const row = await env.AUTH_DB.prepare('SELECT name FROM tenants WHERE id = ?').bind(id).first<{ name: string }>();
		if (!row) throw new DeletionError(404, 'tenant_not_found', 'Tenant not found');
		return {
			label: row.name,
			statements: [env.AUTH_DB.prepare("UPDATE tenants SET status = 'deleted', updated_at = ? WHERE id = ?").bind(now, id)],
			after: async () => clearTenantCache(),
		};
	},

	async restore(env, row, now) {
		protectDefaultTenant(row.item_id);
		// The globally unique domain stays reserved until the tenant is purged.
		return {
			statements: [
				env.AUTH_DB.prepare("UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ? AND status = 'deleted' AND EXISTS (SELECT 1 FROM admin_deletions WHERE kind = 'tenant' AND item_id = tenants.id AND deleted_at = ?)")
					.bind(now, row.item_id, row.deleted_at),
			],
			after: async () => clearTenantCache(),
		};
	},

	async purge(env, row) {
		protectDefaultTenant(row.item_id);
		const db = env.AUTH_DB;
		// The generation check prevents an old cleanup from purging a restored or re-deleted tenant.
		const eligible = `EXISTS (SELECT 1 FROM admin_deletions WHERE kind = 'tenant' AND item_id = ?1 AND deleted_at = ?2)
			AND EXISTS (SELECT 1 FROM tenants WHERE id = ?1 AND status = 'deleted')`;
		const prepare = (sql: string) => db.prepare(sql).bind(row.item_id, row.deleted_at);
		// Direct tenant foreign keys cascade. These tenant-scoped tables lack that FK.
		const results = await db.batch([
			prepare(`DELETE FROM auth_theme_client_defaults WHERE client_id IN (SELECT id FROM oauth_clients WHERE tenant_id = ?1) AND ${eligible}`),
			...['user_identities', 'user_invites', 'user_invite_superseded_tokens', 'moderation_requests', 'admin_deletions'].map((table) =>
				prepare(`DELETE FROM ${table} WHERE tenant_id = ?1 AND ${eligible}`)),
			prepare(`DELETE FROM tenants WHERE id = ?1 AND ${eligible}`),
			prepare("DELETE FROM admin_deletions WHERE kind = 'tenant' AND item_id = ?1 AND deleted_at = ?2 AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = ?1)"),
		]);
		if (!results.at(-1)?.meta.changes) return 'deferred';
		clearTenantCache();
		return 'done';
	},
};

export const HANDLERS: Record<DeletionKind, KindHandler> = { user, client, role, theme, tenant };
