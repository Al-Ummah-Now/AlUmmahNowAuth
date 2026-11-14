/**
 * Whether an account may get tokens, read from D1 (`users`, the source of truth).
 *
 * Suspending a user writes a revocation entry and ends their browser sessions,
 * but that only stops sign-ins made BEFORE the suspension. Every way to get new
 * tokens checks this as well (#662):
 * - sign-in (password, email code, silent single sign-on, device /activate):
 *   the issuer's onSuccess (handlers/auth-handlers.ts)
 * - the authorization code and device code grants: the issuer storage guard
 *   (revocation/token-gate.ts), when it reads the code or approved device grant
 * - the refresh grant: onRefresh (handlers/refresh-check.ts)
 *
 * System accounts (security/system-accounts.ts) are refused by all of these too.
 *
 * D1, never KV: a KV read can serve a stale copy for up to a minute.
 */
import { isSystemUser, isSystemUserId } from './system-accounts';

/**
 * `missing`: no D1 row (a legacy KV-only user, copied to D1 on its next read).
 * `system`: a system account (id or metadata.type "system"), which never signs in.
 */
export type AccountState = 'active' | 'suspended' | 'deleted' | 'missing' | 'system';

/** Only an active account (or one D1 has not copied yet) may sign in or get tokens. */
export function isRefusedAccountState(state: AccountState): boolean {
	return state === 'suspended' || state === 'deleted' || state === 'system';
}

/**
 * Maps a `users` row to its state. Any status other than `active` (suspended,
 * deleted, or a value added later such as banned) is refused, as is a set
 * `deleted_at`.
 */
export function accountStateOf(
	row: { id?: string | null; metadata?: unknown; status?: string | null; deleted_at?: number | null } | null | undefined
): AccountState {
	if (!row) return 'missing';
	if (isSystemUser(row)) return 'system';
	if (row.deleted_at !== null && row.deleted_at !== undefined) return 'deleted';
	if (row.status === 'active') return 'active';
	return row.status === 'deleted' ? 'deleted' : 'suspended';
}

/** The account's state from D1. A failed read throws, so nobody is let in on an error. */
export async function readAccountState(db: D1Database, userId: string): Promise<AccountState> {
	// A system account id is refused even without its row
	if (isSystemUserId(userId)) return 'system';
	const row = await db
		.prepare('SELECT id, metadata, status, deleted_at FROM users WHERE id = ?')
		.bind(userId)
		.first<{ id: string; metadata: string | null; status: string | null; deleted_at: number | null }>();
	return accountStateOf(row);
}
