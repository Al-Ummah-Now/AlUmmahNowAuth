/**
 * Token revocation list (#437): how a revoked session or deleted account stops
 * working everywhere within a short bound.
 *
 * One KV entry per user in TOKEN_REVOCATIONS, key `u:<usr_id>`:
 *   { v: 1, before: unix_s, reason, updatedAt }
 *
 * Every token of a sign-in that happened before `before` is dead. The auth
 * worker refuses refresh grants whose sign-in (`authTime`) predates it;
 * resource servers (api-videos, admin-api, websocket) reject access tokens
 * whose `auth_time` (or `iat`) predates it.
 *
 * KV has no compare-and-swap and is eventually consistent, so the entry holds
 * only a value that grows with time and is only written by revokeUser
 * (`max(existing, now)`): a stale read can lose an older `before`, never a
 * newer one. Single sign-out (/token/revoke) deletes the refresh token and
 * lets the short-lived access token expire instead of listing it here.
 *
 * The entry outlives every refresh token (1 year) so a revoked sign-in can't
 * come back. The same layout is read by the resource servers in the monorepo
 * (packages that share this contract must keep the key and field names).
 *
 * AU-4: KV lags about 60 s between locations (and caches misses), so a refresh
 * served elsewhere right after a revocation could still mint a new access
 * token. The auth worker's own check (the refresh path) therefore reads the
 * D1 copy (`user_revocations`, migration 0022), which is current everywhere;
 * revokeUser writes both. Entries written to KV before D1 existed still count:
 * the refresh path takes the later `before` of the two.
 */
import { logger } from '../logger';

export const REVOCATION_ENTRY_VERSION = 1;
/** Longer than the 1-year refresh token lifetime. */
export const REVOCATION_TTL_SECONDS = 400 * 24 * 60 * 60;

export type RevocationReason =
	| 'account_deleted'
	| 'sign_out_all'
	| 'password_changed'
	| 'admin_suspended'
	| 'admin_deleted'
	| 'admin_sessions_revoked'
	| 'admin_force_logout'
	| 'admin_password_reset';

export interface RevocationEntry {
	v: number;
	before?: number;
	reason?: RevocationReason;
	updatedAt: number;
}

export const revocationKey = (userId: string) => `u:${userId}`;

/** Where revocations live: D1 for the auth worker's own checks, KV for the resource servers. */
export interface RevocationStores {
	/** TOKEN_REVOCATIONS (the shared contract with the resource servers). */
	kv?: KVNamespace;
	/** AUTH_DB (`user_revocations`): read by the refresh path. */
	db?: D1Database;
}

const nowSeconds = (now: number) => Math.floor(now / 1000);

export async function readRevocation(kv: KVNamespace | undefined, userId: string): Promise<RevocationEntry | null> {
	if (!kv || !userId) return null;
	const entry = await kv.get<RevocationEntry>(revocationKey(userId), 'json');
	return entry && typeof entry === 'object' ? entry : null;
}

async function write(kv: KVNamespace, userId: string, entry: RevocationEntry): Promise<void> {
	await kv.put(revocationKey(userId), JSON.stringify(entry), { expirationTtl: REVOCATION_TTL_SECONDS });
}

/**
 * Kill every sign-in of the user made up to now. `before` is the next whole
 * second, so a token issued in the same second as the revocation is covered;
 * a fresh sign-in a moment later is not.
 */
export async function revokeUser(
	stores: RevocationStores,
	userId: string,
	reason: RevocationReason,
	now = Date.now(),
): Promise<RevocationEntry | null> {
	if (!userId) return null;
	if (!stores.kv && !stores.db) {
		logger.warn('[revocation] No revocation store is bound; user revocation skipped', { userId, reason });
		return null;
	}
	let before = nowSeconds(now) + 1;
	if (stores.db) {
		// One statement, monotonic: concurrent revocations keep the latest `before`
		const row = await stores.db
			.prepare(
				`INSERT INTO user_revocations (user_id, revoked_before, reason, updated_at) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(user_id) DO UPDATE SET
				   revoked_before = MAX(revoked_before, excluded.revoked_before),
				   reason = excluded.reason,
				   updated_at = excluded.updated_at
				 RETURNING revoked_before`
			)
			.bind(userId, before, reason, now)
			.first<{ revoked_before: number }>();
		if (row) before = row.revoked_before;
	}
	if (stores.kv) {
		const existing = await readRevocation(stores.kv, userId);
		before = Math.max(existing?.before ?? 0, before);
		await write(stores.kv, userId, { v: REVOCATION_ENTRY_VERSION, before, reason, updatedAt: now });
	} else {
		logger.warn('[revocation] TOKEN_REVOCATIONS is not bound; resource servers will not see this revocation', { userId, reason });
	}
	const entry: RevocationEntry = { v: REVOCATION_ENTRY_VERSION, before, reason, updatedAt: now };
	logger.info('[revocation] User sign-ins revoked', { userId, reason, before });
	return entry;
}

/**
 * The revocation the refresh path must honour: the D1 entry (current in every
 * location), or the KV entry when it is later (written before D1 had one).
 */
export async function readRevocationForRefresh(stores: RevocationStores, userId: string): Promise<RevocationEntry | null> {
	if (!userId) return null;
	const [row, kvEntry] = await Promise.all([
		stores.db
			?.prepare('SELECT revoked_before, reason, updated_at FROM user_revocations WHERE user_id = ?1')
			.bind(userId)
			.first<{ revoked_before: number; reason: RevocationReason | null; updated_at: number }>() ?? null,
		readRevocation(stores.kv, userId),
	]);
	const d1Entry: RevocationEntry | null = row
		? { v: REVOCATION_ENTRY_VERSION, before: row.revoked_before, reason: row.reason ?? undefined, updatedAt: row.updated_at }
		: null;
	if (!d1Entry) return kvEntry;
	if (!kvEntry || (kvEntry.before ?? 0) <= (d1Entry.before ?? 0)) return d1Entry;
	return kvEntry;
}

export interface TokenTimes {
	/** Unix seconds of the original sign-in (JWT `auth_time`). */
	authTime?: number;
	/** Unix seconds the token was issued (JWT `iat`). */
	iat?: number;
}

/**
 * Whether a token is revoked by the entry. The sign-in time decides (a token
 * refreshed after the revocation still belongs to the revoked sign-in); `iat`
 * stands in for tokens without `auth_time`.
 */
export function isRevoked(entry: RevocationEntry | null | undefined, token: TokenTimes): boolean {
	if (!entry) return false;
	if (entry.before === undefined) return false;
	const signedInAt = token.authTime ?? token.iat;
	// No timestamps at all: can't prove the token is newer than the revocation
	if (signedInAt === undefined) return true;
	return signedInAt < entry.before;
}

/*
 * Scoped revocations (AlUmmahNow#442, #277, #363): end part of a user's sign-ins.
 *
 *   s:<sid>                  one browser sign-in (openauth sessionTokenId(browser session, user));
 *                            access tokens carry `sid`, so the KV copy lets the resource
 *                            servers refuse them too
 *   i:<user_id>:<install_id> one native app install's refresh tokens (D1 only)
 *   c:<user_id>:<client_id>  every refresh token of one user at one client (D1 only)
 *
 * Same rule as `u:`: a token whose sign-in predates `before` is dead; a later
 * sign-in on that device or install works. D1 `scoped_revocations` is read by the
 * refresh path (current everywhere); `s:` entries are also written to KV with the
 * same layout as `u:` for the resource servers.
 */
export type ScopedRevocationReason =
	| 'admin_session_terminated'
	| 'admin_sessions_bulk_terminated'
	| 'device_signed_out'
	| 'install_signed_out'
	| 'client_signed_out';

export const sessionScopeKey = (sid: string) => `s:${sid}`;
export const installScopeKey = (userId: string, installId: string) => `i:${userId}:${installId}`;
export const clientScopeKey = (userId: string, clientId: string) => `c:${userId}:${clientId}`;

/** Ends the sign-ins under `scopeKey` made up to now. Returns the stored `before`. */
export async function revokeScope(
	stores: RevocationStores,
	scopeKey: string,
	reason: ScopedRevocationReason,
	now = Date.now(),
): Promise<number> {
	if (!stores.db) throw new Error('scoped revocation needs AUTH_DB');
	let before = nowSeconds(now) + 1;
	const row = await stores.db
		.prepare(
			`INSERT INTO scoped_revocations (scope_key, revoked_before, reason, updated_at) VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(scope_key) DO UPDATE SET
			   revoked_before = MAX(revoked_before, excluded.revoked_before),
			   reason = excluded.reason,
			   updated_at = excluded.updated_at
			 RETURNING revoked_before`
		)
		.bind(scopeKey, before, reason, now)
		.first<{ revoked_before: number }>();
	if (row) before = row.revoked_before;
	if (scopeKey.startsWith('s:')) {
		if (stores.kv) {
			const existing = await stores.kv.get<RevocationEntry>(scopeKey, 'json');
			before = Math.max(existing?.before ?? 0, before);
			await stores.kv.put(scopeKey, JSON.stringify({ v: REVOCATION_ENTRY_VERSION, before, reason, updatedAt: now }), {
				expirationTtl: REVOCATION_TTL_SECONDS,
			});
		} else {
			logger.warn('[revocation] TOKEN_REVOCATIONS is not bound; resource servers will not see this session revocation', { reason });
		}
	}
	logger.info('[revocation] Scoped sign-ins revoked', { scope: scopeKey.slice(0, 2), reason, before });
	return before;
}

/** The latest `before` among the given scope keys (primary-key lookups), or undefined. */
export async function readScopedRevocation(db: D1Database | undefined, scopeKeys: string[]): Promise<number | undefined> {
	const keys = [...new Set(scopeKeys.filter(Boolean))];
	if (!db || keys.length === 0) return undefined;
	const { results } = await db
		.prepare(`SELECT MAX(revoked_before) AS before FROM scoped_revocations WHERE scope_key IN (${keys.map((_, i) => `?${i + 1}`).join(', ')})`)
		.bind(...keys)
		.all<{ before: number | null }>();
	const before = results?.[0]?.before;
	return typeof before === 'number' ? before : undefined;
}

/** The scope keys a refresh token answers to: its session, its install and its client. */
export function refreshScopeKeys(record: { sid?: unknown; installId?: unknown; clientID?: unknown }, userId: string | undefined): string[] {
	const keys: string[] = [];
	if (typeof record.sid === 'string' && record.sid) keys.push(sessionScopeKey(record.sid));
	if (userId && typeof record.installId === 'string' && record.installId) keys.push(installScopeKey(userId, record.installId));
	if (userId && typeof record.clientID === 'string' && record.clientID) keys.push(clientScopeKey(userId, record.clientID));
	return keys;
}
