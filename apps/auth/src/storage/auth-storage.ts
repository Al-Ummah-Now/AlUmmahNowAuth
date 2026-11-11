/**
 * The storage the OpenAuth issuer and the account routes share: KV for
 * ordinary state, D1 (openauth_atomic) for everything that must be atomic or
 * strongly consistent (codes, refresh tokens, device flow, keys, counters).
 * `scope` lets the issuer cache imported keys across requests in an isolate.
 */
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { CloudflarePatchedStorage } from './cloudflare-patched';
import { D1AtomicStorage } from './d1-atomic';
import { kvMayHoldRefreshTokens } from './legacy-refresh';

export function authStorage(
	env: { AUTH_STORAGE: KVNamespace; AUTH_DB: D1Database },
	options: { waitUntil?: (promise: Promise<unknown>) => void } = {}
): StorageAdapter {
	return CloudflarePatchedStorage({
		namespace: env.AUTH_STORAGE,
		atomic: D1AtomicStorage(env.AUTH_DB),
		scope: 'AUTH_STORAGE',
		...(options.waitUntil ? { waitUntil: options.waitUntil, deferWrite: isSubjectRecord } : {}),
		// The subject of an email never changes: skip the KV write when it is already there
		skipUnchanged: isSubjectRecord,
		kvMayHoldRefreshTokens: () => kvMayHoldRefreshTokens(env.AUTH_DB),
	});
}

/**
 * ["email", <email>, "subject"]: the password provider writes it on EVERY password
 * sign-in, before the redirect (a KV write, ~250 ms), and reads it only on a
 * password change to revoke that subject's refresh tokens. The write can finish
 * after the response (#804); auth's own revokeOnPasswordChange revokes by user.
 */
export function isSubjectRecord(key: string[]): boolean {
	return key.length === 3 && key[0] === 'email' && key[2] === 'subject';
}
