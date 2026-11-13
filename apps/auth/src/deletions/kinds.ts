/**
 * What deleting, restoring and purging means for each kind of item.
 *
 *   user    delete: users.status = 'deleted' + deleted_at (sign-in, refresh and
 *           every listing already refuse such a user), signed out everywhere.
 *           restore: the status before deletion, unless another live account
 *           has taken the email since. purge: the users row and everything
 *           keyed by the user (identities, role links, sessions, codes,
 *           refresh tokens, the password credential, old KV copies).
 *   client  delete: enabled = 0 (/authorize and client credentials refuse
 *           disabled clients). restore: the enabled flag it had. purge: the
 *           oauth_clients row (its permissions cascade) and its theme default.
 *   role    delete: its user and permission links move into the snapshot, so
 *           nobody holds the role any more. restore: the links come back
 *           (those whose permission still exists). purge: the rbac_roles row.
 *   theme   delete: hidden from the admin list, the public theme list and page
 *           rendering (ThemeStore leaves deleted themes out). purge: the row
 *           and its stored packages and files no other theme uses.
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
import { logger } from '../logger';
import type { DeletionKind, DeletionRow } from './store';


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

export type DeletionEnv = Pick<Env, 'AUTH_DB' | 'AUTH_STORAGE' | 'TOKEN_REVOCATIONS' | 'AUTH_THEMES'>;

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
	/** Removes the item for good. Idempotent: a retry after a partial run finishes the job. */
	purge(env: DeletionEnv, row: DeletionRow): Promise<void>;
}

const snapshotOf = <T>(row: DeletionRow): Partial<T> => {
	try {
		return row.snapshot ? (JSON.parse(row.snapshot) as Partial<T>) : {};
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
}

const user: KindHandler = {
	async prepare(env, userId, { tenantId, actorId, now }) {
		const row = await env.AUTH_DB.prepare('SELECT id, email, status FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL')
			.bind(userId, tenantId)
			.first<{ id: string; email: string; status: string }>();
		if (!row) throw new DeletionError(404, 'user_not_found', `User '${userId}' not found`);
		if (userId === actorId) throw new DeletionError(409, 'cannot_delete_self', 'You cannot delete your own account here');
		return {
			label: row.email,
			snapshot: { status: row.status, email: row.email } satisfies UserSnapshot,
			statements: [
				env.AUTH_DB.prepare(
					`UPDATE users SET status = 'deleted', deleted_at = ?3, updated_at = ?3 WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`
				).bind(userId, tenantId, now),
			],
			// No token minted before now works any more, and no browser signs the user back in
			after: async () => {
				await revokeUser({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, userId, 'admin_deleted');
				await revokeUserTokens(userId, env.AUTH_DB);
				await endBrowserSignIns(env.AUTH_DB, userId);
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
		return {
			statements: [
				env.AUTH_DB.prepare('UPDATE users SET status = ?2, deleted_at = NULL, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NOT NULL').bind(
					row.item_id,
					status,
					now
				),
			],
		};
	},

	async purge(env, row) {
		const db = env.AUTH_DB;
		const userId = row.item_id;
		const found = await db.prepare('SELECT email, tenant_id, deleted_at FROM users WHERE id = ?').bind(userId).first<{ email: string; tenant_id: string; deleted_at: number | null }>();
		// Restored behind the cleanup's back (or re-created): never purge a live account
		if (found && found.deleted_at === null) throw new DeletionError(409, 'user_live', 'The account is not deleted');
		const email = (found?.email ?? snapshotOf<UserSnapshot>(row).email ?? row.label ?? '').toLowerCase();
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
			db.prepare('DELETE FROM user_invites WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM authorization_codes WHERE user_id = ?').bind(userId),
			db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId),
			// Profile/admin sessions of the user; idx_app_sessions_user (migration 0032) serves this
			db.prepare(`DELETE FROM app_sessions WHERE json_extract(user_json, '$.id') = ?`).bind(userId),
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
		for (const stmt of statements) await run(stmt);
		await run(db.prepare('DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL').bind(userId));
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

export const HANDLERS: Record<DeletionKind, KindHandler> = { user, client, role, theme };
