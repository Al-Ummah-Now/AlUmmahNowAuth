/**
 * PROFILE_DATA_KEY: encrypts profile data the operators of the database must not read (wiki E20 §5.1). Its id is
 * a fingerprint of the key, stored beside each value, so a key can be replaced: set the new one as
 * PROFILE_DATA_KEY and the old one as PROFILE_DATA_KEY_PREVIOUS until every row has been written again.
 */
import type { EncryptionKey } from '../services/encryption';
import { getSecret } from '../utils/secrets';

export interface ProfileKeyEnv {
	PROFILE_DATA_KEY?: unknown;
	PROFILE_DATA_KEY_PREVIOUS?: unknown;
}

export class ProfileKeyMissingError extends Error {
	constructor(message = 'PROFILE_DATA_KEY is not configured') {
		super(message);
		this.name = 'ProfileKeyMissingError';
	}
}

export async function keyIdOf(material: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
	return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A key as it must be stored: base64 of exactly 32 bytes. */
export function isProfileKey(material: string): boolean {
	try {
		return atob(material.trim()).length === 32;
	} catch {
		return false;
	}
}

async function load(binding: unknown, name: string): Promise<EncryptionKey | null> {
	const material = binding ? (await getSecret(binding, name)).trim() : '';
	if (!material) return null;
	if (!isProfileKey(material)) throw new ProfileKeyMissingError(`${name} is not base64 of 32 bytes`);
	return { id: await keyIdOf(material), material };
}

/** The key new values are written with. */
export async function currentProfileKey(env: ProfileKeyEnv): Promise<EncryptionKey> {
	const key = await load(env.PROFILE_DATA_KEY, 'PROFILE_DATA_KEY');
	if (!key) throw new ProfileKeyMissingError();
	return key;
}

/** The key a stored value was written with. */
export async function profileKeyById(env: ProfileKeyEnv, keyId: string): Promise<EncryptionKey> {
	for (const name of ['PROFILE_DATA_KEY', 'PROFILE_DATA_KEY_PREVIOUS'] as const) {
		const key = await load(env[name], name);
		if (key?.id === keyId) return key;
	}
	throw new ProfileKeyMissingError(`No profile data key with id ${keyId}`);
}
