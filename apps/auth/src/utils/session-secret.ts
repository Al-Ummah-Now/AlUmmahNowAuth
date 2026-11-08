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
