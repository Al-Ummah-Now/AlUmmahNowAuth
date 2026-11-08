/**
 * Token revocation list (#437): how a revoked session or deleted account stops
 * working everywhere within a short bound.
 *
 * One KV entry per user in TOKEN_REVOCATIONS, key `u:<usr_id>`:
 *   { v: 1, before?: unix_s, jtis?: { [jti]: exp_unix_s }, reason?, updatedAt }
 *
 * - `before`: every token of a sign-in that happened before this instant is
 *   dead. The auth worker refuses refresh grants whose sign-in (`authTime`)
 *   predates it; resource servers (api-videos, admin-api, websocket) reject
 *   access tokens whose `auth_time` (or `iat`) predates it.
 * - `jtis`: single access tokens revoked by `/token/revoke` (single sign-out);
 *   each kept only until the token would have expired anyway.
 *
 * The entry outlives every refresh token (1 year) so a revoked sign-in can't
 * come back. The same layout is read by the resource servers in the monorepo
 * (packages that share this contract must keep the key and field names).
 */
import { logger } from '../logger';

export const REVOCATION_ENTRY_VERSION = 1;
/** Longer than the 1-year refresh token lifetime. */
export const REVOCATION_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Cap on remembered single-token revocations per user (oldest-expiring dropped first). */
export const MAX_REVOKED_JTIS = 100;

export type RevocationReason =
	| 'account_deleted'
	| 'sign_out_all'
	| 'password_changed'
	| 'admin_suspended'
	| 'admin_deleted'
	| 'admin_sessions_revoked'
	| 'admin_force_logout'
	| 'admin_password_reset'
	| 'token_revoked';

export interface RevocationEntry {
	v: number;
	before?: number;
	jtis?: Record<string, number>;
	reason?: RevocationReason;
	updatedAt: number;
}

export const revocationKey = (userId: string) => `u:${userId}`;

const nowSeconds = (now: number) => Math.floor(now / 1000);

export async function readRevocation(kv: KVNamespace | undefined, userId: string): Promise<RevocationEntry | null> {
	if (!kv || !userId) return null;
	const entry = await kv.get<RevocationEntry>(revocationKey(userId), 'json');
	return entry && typeof entry === 'object' ? entry : null;
}

function prunedJtis(jtis: Record<string, number> | undefined, now: number): Record<string, number> | undefined {
	if (!jtis) return undefined;
	const live = Object.entries(jtis)
		.filter(([, exp]) => exp > nowSeconds(now))
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_REVOKED_JTIS);
	return live.length ? Object.fromEntries(live) : undefined;
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
	kv: KVNamespace | undefined,
	userId: string,
	reason: RevocationReason,
	now = Date.now(),
): Promise<RevocationEntry | null> {
	if (!kv) {
		logger.warn('[revocation] TOKEN_REVOCATIONS is not bound; user revocation skipped', { userId, reason });
		return null;
	}
	if (!userId) return null;
	const existing = await readRevocation(kv, userId);
	const entry: RevocationEntry = {
		v: REVOCATION_ENTRY_VERSION,
		before: Math.max(existing?.before ?? 0, nowSeconds(now) + 1),
		jtis: prunedJtis(existing?.jtis, now),
		reason,
		updatedAt: now,
	};
	await write(kv, userId, entry);
	logger.info('[revocation] User sign-ins revoked', { userId, reason, before: entry.before });
	return entry;
}

/** Revoke one access token (single sign-out) until it would have expired. */
export async function revokeAccessToken(
	kv: KVNamespace | undefined,
	userId: string,
	jti: string,
	exp: number,
	now = Date.now(),
): Promise<RevocationEntry | null> {
	if (!kv || !userId || !jti || exp <= nowSeconds(now)) return null;
	const existing = await readRevocation(kv, userId);
	const entry: RevocationEntry = {
		v: REVOCATION_ENTRY_VERSION,
		before: existing?.before,
		jtis: prunedJtis({ ...existing?.jtis, [jti]: exp }, now),
		reason: existing?.reason ?? 'token_revoked',
		updatedAt: now,
	};
	await write(kv, userId, entry);
	return entry;
}

export interface TokenTimes {
	/** Unix seconds of the original sign-in (JWT `auth_time`). */
	authTime?: number;
	/** Unix seconds the token was issued (JWT `iat`). */
	iat?: number;
	jti?: string;
}

/**
 * Whether a token is revoked by the entry. The sign-in time decides (a token
 * refreshed after the revocation still belongs to the revoked sign-in); `iat`
 * stands in for tokens without `auth_time`.
 */
export function isRevoked(entry: RevocationEntry | null | undefined, token: TokenTimes): boolean {
	if (!entry) return false;
	if (token.jti && entry.jtis?.[token.jti] !== undefined) return true;
	if (entry.before === undefined) return false;
	const signedInAt = token.authTime ?? token.iat;
	// No timestamps at all: can't prove the token is newer than the revocation
	if (signedInAt === undefined) return true;
	return signedInAt < entry.before;
}
