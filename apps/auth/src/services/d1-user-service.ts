/**
 * User records with D1 as the source of truth (AU-3).
 *
 * OpenAuth's UserServiceImpl kept a full copy of every user in KV and read only
 * that copy: each mutation read the KV record, changed it and wrote the whole
 * record back to KV and then to D1. KV reads can be about 60 s stale in another
 * location, so an admin suspension followed by a sign-in elsewhere (which wrote
 * last_login_at back over the record) could undo the suspension in both stores,
 * and two concurrent mutations always lost one of them.
 *
 * Here every read comes from D1 and every mutation is one conditional SQL
 * statement, so concurrent writers each apply their own column change and none
 * overwrites another. Email uniqueness is enforced by the partial unique index
 * idx_users_tenant_email, not by a read-then-write check.
 *
 * Existing data: a user the old code wrote to KV but not to D1 (its KV write
 * came first, so a failed D1 insert left one) is still found: when D1 has no
 * row, the KV record is copied into D1 (INSERT OR IGNORE, so an existing row or
 * email always wins) and the D1 row is returned. Nothing writes the KV copy any
 * more; deleting a user removes the old KV record and email index so a stale
 * copy can never be brought back. scripts/check-users-d1.ts reports KV records
 * that D1 lacks or disagrees with (read-only).
 */
import type {
	CreateUserParams,
	D1UserAdapter,
	ListUsersParams,
	ListUsersResponse,
	UpdateUserParams,
	User,
	UserIdentity,
	UserService,
	UserWithIdentities,
} from '@al-ummah-now/openauth';
import { UserError } from '@al-ummah-now/openauth';

/** The subset of OpenAuth's StorageAdapter this service uses (the legacy KV copy). */
export interface LegacyUserStorage {
	get(key: string[]): Promise<Record<string, unknown> | undefined>;
	remove(key: string[]): Promise<void>;
}

type SuspendUserResponse = Awaited<ReturnType<UserService['suspendUser']>>;
type RevokeSessionsResponse = Awaited<ReturnType<UserService['revokeUserSessions']>>;
type NewIdentity = Parameters<UserService['linkIdentity']>[2];

/** OpenAuth's KV keys for users (USER_STORAGE_KEYS); read and removed, never written. */
export const LEGACY_USER_KEYS = {
	user: (tenantId: string, userId: string) => ['user', tenantId, userId],
	email: (tenantId: string, email: string) => ['user', 'email', tenantId, email],
	identity: (tenantId: string, provider: string, providerUserId: string) => ['user', 'identity', tenantId, provider, providerUserId],
};

interface UserRow {
	id: string;
	tenant_id: string;
	email: string;
	name: string | null;
	metadata: string | null;
	status: string;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
	deleted_at: number | null;
	password_reset_required: number | null;
}

const USER_COLUMNS =
	'id, tenant_id, email, name, metadata, status, created_at, updated_at, last_login_at, deleted_at, password_reset_required';

export function rowToUser(row: UserRow): User {
	return {
		id: row.id,
		tenant_id: row.tenant_id,
		email: row.email,
		name: row.name,
		metadata: row.metadata ? JSON.parse(row.metadata) : null,
		status: row.status as User['status'],
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_login_at: row.last_login_at,
		deleted_at: row.deleted_at,
		password_reset_required: row.password_reset_required === 1,
	};
}

const normalizeEmail = (email: string) => email.toLowerCase().trim();

function isUniqueViolation(error: unknown): boolean {
	return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

export interface D1UserServiceConfig {
	db: D1Database;
	/** OpenAuth's D1 adapter: listing, identities and session revocation (already D1-only). */
	adapter: D1UserAdapter;
	/** The legacy KV copy, read only for users D1 does not have yet. */
	legacy?: LegacyUserStorage;
	now?: () => number;
}

export class D1UserService implements UserService {
	private readonly db: D1Database;
	private readonly adapter: D1UserAdapter;
	private readonly legacy?: LegacyUserStorage;
	private readonly now: () => number;

	constructor(config: D1UserServiceConfig) {
		this.db = config.db;
		this.adapter = config.adapter;
		this.legacy = config.legacy;
		this.now = config.now ?? Date.now;
	}

	/** The D1 row in any state (deleted included), copying a KV-only user into D1 first. */
	private async row(tenantId: string, userId: string): Promise<User | null> {
		const row = await this.db
			.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND id = ?2`)
			.bind(tenantId, userId)
			.first<UserRow>();
		if (row) return rowToUser(row);
		return this.backfill(tenantId, userId);
	}

	/** Copies the old KV record of a user D1 lacks; an existing D1 row or email wins. */
	private async backfill(tenantId: string, userId: string): Promise<User | null> {
		if (!this.legacy) return null;
		const kv = (await this.legacy.get(LEGACY_USER_KEYS.user(tenantId, userId))) as Partial<User> | undefined;
		if (!kv || kv.id !== userId || typeof kv.email !== 'string') return null;
		const created = typeof kv.created_at === 'number' ? kv.created_at : this.now();
		const row = await this.db
			.prepare(
				`INSERT OR IGNORE INTO users (${USER_COLUMNS})
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
				 RETURNING ${USER_COLUMNS}`
			)
			.bind(
				userId,
				tenantId,
				normalizeEmail(kv.email),
				kv.name ?? null,
				kv.metadata ? JSON.stringify(kv.metadata) : null,
				kv.status ?? 'active',
				created,
				typeof kv.updated_at === 'number' ? kv.updated_at : created,
				kv.last_login_at ?? null,
				kv.deleted_at ?? null,
				kv.password_reset_required ? 1 : 0
			)
			.first<UserRow>();
		if (row) return rowToUser(row);
		// Ignored: a concurrent backfill won (read it), or another D1 user owns the email (stale copy)
		const existing = await this.db
			.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND id = ?2`)
			.bind(tenantId, userId)
			.first<UserRow>();
		return existing ? rowToUser(existing) : null;
	}

	/**
	 * The live user (copied from KV first if needed). UserServiceImpl hid deleted
	 * users from reads, so a mutation on one has always answered user_not_found.
	 */
	private async requireLive(tenantId: string, userId: string): Promise<User> {
		const user = await this.row(tenantId, userId);
		if (!user || user.deleted_at !== null || user.status === 'deleted') {
			throw new UserError('user_not_found', `User '${userId}' not found`);
		}
		return user;
	}

	/** Runs one `UPDATE ... RETURNING` on a live user; null when no row matched. */
	private async update(sql: string, binds: unknown[]): Promise<User | null> {
		const row = await this.db
			.prepare(sql)
			.bind(...binds)
			.first<UserRow>();
		return row ? rowToUser(row) : null;
	}

	async createUser(tenantId: string, params: CreateUserParams): Promise<User> {
		const email = normalizeEmail(params.email);
		// A KV-only account with this email must be found (and copied) before a new one is made
		if (await this.getUserByEmail(tenantId, email)) {
			throw new UserError('email_already_exists', `Email '${email}' is already registered`);
		}
		const now = this.now();
		const user: User = {
			id: `usr_${crypto.randomUUID().replace(/-/g, '')}`,
			tenant_id: tenantId,
			email,
			name: params.name?.trim() || null,
			metadata: params.metadata || null,
			status: 'active',
			created_at: now,
			updated_at: now,
			last_login_at: null,
			deleted_at: null,
			password_reset_required: false,
		};
		try {
			await this.db
				.prepare(
					`INSERT INTO users (${USER_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, NULL, NULL, 0)`
				)
				.bind(user.id, tenantId, email, user.name, user.metadata ? JSON.stringify(user.metadata) : null, now)
				.run();
		} catch (error) {
			// Two sign-ups for one address at once: the unique index lets exactly one in
			if (isUniqueViolation(error)) throw new UserError('email_already_exists', `Email '${email}' is already registered`);
			throw error;
		}
		return user;
	}

	async getUser(tenantId: string, userId: string): Promise<User | null> {
		const user = await this.row(tenantId, userId);
		return user && user.deleted_at === null ? user : null;
	}

	async getUserWithIdentities(tenantId: string, userId: string): Promise<UserWithIdentities | null> {
		const user = await this.getUser(tenantId, userId);
		if (!user) return null;
		return { ...user, identities: await this.getUserIdentities(tenantId, userId) };
	}

	async getUserByEmail(tenantId: string, email: string): Promise<User | null> {
		const normalized = normalizeEmail(email);
		const row = await this.db
			.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND email = ?2 AND deleted_at IS NULL`)
			.bind(tenantId, normalized)
			.first<UserRow>();
		if (row) return rowToUser(row);
		if (!this.legacy) return null;
		const lookup = (await this.legacy.get(LEGACY_USER_KEYS.email(tenantId, normalized))) as { userId?: string } | undefined;
		if (!lookup?.userId) return null;
		const user = await this.getUser(tenantId, lookup.userId);
		// The KV index can point at a user whose email has since changed in D1
		return user && user.email === normalized ? user : null;
	}

	async updateUser(tenantId: string, userId: string, params: UpdateUserParams): Promise<User> {
		await this.requireLive(tenantId, userId);
		const email = params.email !== undefined ? normalizeEmail(params.email) : null;
		try {
			const user = await this.update(
				`UPDATE users SET
				   email = COALESCE(?3, email),
				   name = CASE WHEN ?4 THEN ?5 ELSE name END,
				   metadata = CASE WHEN ?6 THEN ?7 ELSE metadata END,
				   updated_at = ?8
				 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL
				 RETURNING ${USER_COLUMNS}`,
				[
					tenantId,
					userId,
					email,
					params.name !== undefined ? 1 : 0,
					params.name ?? null,
					params.metadata !== undefined ? 1 : 0,
					params.metadata ? JSON.stringify(params.metadata) : null,
					this.now(),
				]
			);
			if (!user) throw new UserError('user_deleted', 'Cannot update a deleted user');
			return user;
		} catch (error) {
			if (isUniqueViolation(error)) throw new UserError('email_already_exists', `Email '${email}' is already registered`);
			throw error;
		}
	}

	async deleteUser(tenantId: string, userId: string): Promise<void> {
		const existing = await this.requireLive(tenantId, userId);
		const now = this.now();
		await this.update(
			`UPDATE users SET status = 'deleted', deleted_at = ?3, updated_at = ?3
			 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL
			 RETURNING ${USER_COLUMNS}`,
			[tenantId, userId, now]
		);
		await this.adapter.revokeAllUserSessions(tenantId, userId);
		await this.removeLegacy(tenantId, userId, existing.email);
	}

	/** Drops the old KV record and email index, so a stale copy can never be read back. */
	async removeLegacy(tenantId: string, userId: string, email: string): Promise<void> {
		if (!this.legacy) return;
		const lookup = (await this.legacy.get(LEGACY_USER_KEYS.email(tenantId, email))) as { userId?: string } | undefined;
		if (lookup?.userId === userId) await this.legacy.remove(LEGACY_USER_KEYS.email(tenantId, email));
		await this.legacy.remove(LEGACY_USER_KEYS.user(tenantId, userId));
	}

	async listUsers(tenantId: string, params?: ListUsersParams): Promise<ListUsersResponse> {
		return this.adapter.listUsers(tenantId, params || {});
	}

	async suspendUser(tenantId: string, userId: string): Promise<SuspendUserResponse> {
		await this.requireLive(tenantId, userId);
		const user = await this.update(
			`UPDATE users SET status = 'suspended', updated_at = ?3
			 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL AND status = 'active'
			 RETURNING ${USER_COLUMNS}`,
			[tenantId, userId, this.now()]
		);
		if (!user) {
			const current = await this.row(tenantId, userId);
			if (!current || current.deleted_at !== null) throw new UserError('user_deleted', 'Cannot suspend a deleted user');
			return { user: current, revoked_sessions: 0 };
		}
		const { deletedCount } = await this.adapter.revokeAllUserSessions(tenantId, userId);
		return { user, revoked_sessions: deletedCount };
	}

	async unsuspendUser(tenantId: string, userId: string): Promise<User> {
		await this.requireLive(tenantId, userId);
		const user = await this.update(
			`UPDATE users SET status = 'active', updated_at = ?3
			 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL AND status = 'suspended'
			 RETURNING ${USER_COLUMNS}`,
			[tenantId, userId, this.now()]
		);
		if (!user) throw new UserError('user_not_found', 'User is not suspended');
		return user;
	}

	async revokeUserSessions(tenantId: string, userId: string): Promise<RevokeSessionsResponse> {
		await this.requireLive(tenantId, userId);
		const { deletedCount } = await this.adapter.revokeAllUserSessions(tenantId, userId);
		return { revoked_count: deletedCount };
	}

	async getUserIdentities(tenantId: string, userId: string): Promise<UserIdentity[]> {
		return this.adapter.getUserIdentities(tenantId, userId);
	}

	async linkIdentity(tenantId: string, userId: string, identity: NewIdentity): Promise<UserIdentity> {
		await this.requireLive(tenantId, userId);
		const created: UserIdentity = {
			id: `idt_${crypto.randomUUID().replace(/-/g, '')}`,
			user_id: userId,
			tenant_id: tenantId,
			provider: identity.provider,
			provider_user_id: identity.provider_user_id,
			provider_data: identity.provider_data,
			created_at: this.now(),
		};
		try {
			await this.adapter.createIdentity(created);
		} catch (error) {
			// idx_identities_provider: one link per provider account, even under concurrent links
			if (isUniqueViolation(error)) {
				throw new UserError('identity_already_linked', `Identity ${identity.provider}:${identity.provider_user_id} is already linked`);
			}
			throw error;
		}
		return created;
	}

	async unlinkIdentity(tenantId: string, userId: string, identityId: string): Promise<void> {
		const identity = await this.adapter.getIdentity(tenantId, identityId);
		if (!identity || identity.user_id !== userId) {
			throw new UserError('identity_not_found', `Identity '${identityId}' not found`);
		}
		await this.adapter.deleteIdentity(tenantId, identityId);
		await this.legacy?.remove(LEGACY_USER_KEYS.identity(tenantId, identity.provider, identity.provider_user_id));
	}

	/** One statement; the sign-in path has already found (and, if needed, copied) the user. */
	async updateLastLogin(tenantId: string, userId: string): Promise<void> {
		await this.db
			.prepare(`UPDATE users SET last_login_at = ?3 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL`)
			.bind(tenantId, userId, this.now())
			.run();
	}

	async forcePasswordReset(tenantId: string, userId: string): Promise<User> {
		await this.requireLive(tenantId, userId);
		const user = await this.update(
			`UPDATE users SET password_reset_required = 1, updated_at = ?3
			 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL
			 RETURNING ${USER_COLUMNS}`,
			[tenantId, userId, this.now()]
		);
		if (!user) throw new UserError('user_deleted', 'Cannot force password reset for a deleted user');
		return user;
	}

	async clearPasswordResetRequired(tenantId: string, userId: string): Promise<User> {
		await this.requireLive(tenantId, userId);
		const user = await this.update(
			`UPDATE users SET password_reset_required = 0, updated_at = ?3
			 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL
			 RETURNING ${USER_COLUMNS}`,
			[tenantId, userId, this.now()]
		);
		if (!user) throw new UserError('user_not_found', `User '${userId}' not found`);
		return user;
	}
}
