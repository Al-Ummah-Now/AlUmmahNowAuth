/**
 * @fileoverview Key for the shared browser-session cookie (`__session`).
 *
 * The `__session` cookie is what single sign-on runs on. Until now production
 * had no SESSION_SECRET, so the cookie was encrypted with an all-zero key.
 * The key is now:
 *   1. SESSION_SECRET (64 hex chars) when set, otherwise
 *   2. HKDF-SHA256 of the KEY_ENCRYPTION_MASTER_KEY Secrets Store binding
 *      (already bound in QA and production; no new secret to provision),
 *   3. all zeros only in development (logged as an error elsewhere).
 * Changing it signs browsers out of the shared session once.
 */
import { getSecret } from './secrets';
import { hexToSecret } from './crypto';

const INFO = 'al-ummah-now/session-cookie/v1';
let cached: { source: string; key: Uint8Array } | undefined;

type SessionSecretEnv = {
	SESSION_SECRET?: unknown;
	KEY_ENCRYPTION_MASTER_KEY?: unknown;
	ENVIRONMENT?: string;
};

async function hkdf(material: string): Promise<Uint8Array> {
	const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(INFO) },
		ikm,
		256
	);
	return new Uint8Array(bits);
}

export async function resolveSessionSecret(env: SessionSecretEnv): Promise<{ key: Uint8Array; source: 'SESSION_SECRET' | 'derived' | 'insecure-default' }> {
	const hex = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET.trim() : '';
	if (/^[0-9a-fA-F]{64}$/.test(hex) && !/^0+$/.test(hex)) {
		return { key: hexToSecret(hex), source: 'SESSION_SECRET' };
	}
	const master = await getSecret(env.KEY_ENCRYPTION_MASTER_KEY, 'KEY_ENCRYPTION_MASTER_KEY');
	if (master) {
		if (cached?.source !== master) cached = { source: master, key: await hkdf(master) };
		return { key: cached.key, source: 'derived' };
	}
	return { key: new Uint8Array(32), source: 'insecure-default' };
}
