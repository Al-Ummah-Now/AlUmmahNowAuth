/**
 * @fileoverview Key of the shared browser-session cookie (`__session`).
 *
 * Same rule as the issuer in index.ts (SESSION_SECRET, required in production
 * since #200), so /logout can read the cookie it has to revoke.
 */
import { hexToSecret } from './crypto';

export function sessionCookieKey(env: { SESSION_SECRET?: string }): Uint8Array {
	return hexToSecret(env.SESSION_SECRET || '0'.repeat(64));
}

/**
 * Without SESSION_SECRET the key above is all zeros, which is public: a forged __session cookie
 * would sign anyone in as any account. Only a local development worker (ENVIRONMENT exactly
 * "development": the local stack and `wrangler dev`) may run on it; QA, stage and production must
 * have the secret (index.ts refuses to serve sign-in without it).
 */
export function sessionSecretUsable(env: { SESSION_SECRET?: string; ENVIRONMENT?: string }): boolean {
	return Boolean(env.SESSION_SECRET) || env.ENVIRONMENT === 'development';
}
