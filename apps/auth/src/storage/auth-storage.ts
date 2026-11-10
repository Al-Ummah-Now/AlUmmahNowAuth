/**
 * The storage the OpenAuth issuer and the account routes share: KV for
 * ordinary state, D1 (openauth_atomic) for everything that must be atomic or
 * strongly consistent (codes, refresh tokens, device flow, keys, counters).
 * `scope` lets the issuer cache imported keys across requests in an isolate.
 */
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { CloudflarePatchedStorage } from './cloudflare-patched';
import { D1AtomicStorage } from './d1-atomic';

export function authStorage(env: { AUTH_STORAGE: KVNamespace; AUTH_DB: D1Database }): StorageAdapter {
	return CloudflarePatchedStorage({
		namespace: env.AUTH_STORAGE,
		atomic: D1AtomicStorage(env.AUTH_DB),
		scope: 'AUTH_STORAGE',
	});
}
