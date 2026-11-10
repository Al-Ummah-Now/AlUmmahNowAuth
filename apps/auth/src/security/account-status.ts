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
 * D1, never KV: a KV read can serve a stale copy for up to a minute.
 */

/** `missing`: no D1 row (a legacy KV-only user, copied to D1 on its next read). */
export type AccountState = 'active' | 'suspended' | 'deleted' | 'missing';

/** Only an active account (or one D1 has not copied yet) may sign in or get tokens. */
export function isRefusedAccountState(state: AccountState): boolean {
	return state === 'suspended' || state === 'deleted';
}

/**
 * Maps a `users` row to its state. Any status other than `active` (suspended,
 * deleted, or a value added later such as banned) is refused, as is a set
 * `deleted_at`.
 */
export function accountStateOf(row: { status?: string | null; deleted_at?: number | null } | null | undefined): AccountState {
	if (!row) return 'missing';
	if (row.deleted_at !== null && row.deleted_at !== undefined) return 'deleted';
	if (row.status === 'active') return 'active';
	return row.status === 'deleted' ? 'deleted' : 'suspended';
}

/** The account's state from D1. A failed read throws, so nobody is let in on an error. */
export async function readAccountState(db: D1Database, userId: string): Promise<AccountState> {
	const row = await db
		.prepare('SELECT status, deleted_at FROM users WHERE id = ?')
		.bind(userId)
		.first<{ status: string | null; deleted_at: number | null }>();
	return accountStateOf(row);
}
