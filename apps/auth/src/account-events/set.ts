/**
 * A Security Event Token (RFC 8417) for one client, signed with the key that
 * signs access tokens. It is not an access token and can't pass as one: `typ` is
 * secevent+jwt and it has no sub, exp, mode, type or properties.
 */
import { activeSigningKey, signingKeys } from '@al-ummah-now/openauth/keys';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { SignJWT } from 'jose';
import { EVENT_URIS, type AccountEventType } from './types';

export interface SetInput {
	issuer: string;
	clientId: string;
	jti: string;
	seq: number;
	type: AccountEventType;
	userId: string;
	reason?: string | null;
	exportId?: string | null;
	/** When it happened (ms). */
	at: number;
}

export function setClaims(input: SetInput, now = Date.now()) {
	const { issuer, type } = input;
	return {
		iss: issuer,
		aud: input.clientId,
		iat: Math.floor(now / 1000),
		jti: input.jti,
		toe: Math.floor(input.at / 1000),
		seq: input.seq,
		sub_id: type === 'verification' ? { format: 'opaque', id: input.clientId } : { format: 'iss_sub', iss: issuer, sub: input.userId },
		events: {
			[EVENT_URIS[type]]: {
				...(type === 'account-disabled' && input.reason ? { reason: input.reason } : {}),
				...(type === 'account-export-requested' && input.exportId ? { export_id: input.exportId } : {}),
			},
		},
	};
}

export async function signSet(storage: StorageAdapter, input: SetInput, now = Date.now()): Promise<string> {
	const key = activeSigningKey(await signingKeys(storage), now);
	return new SignJWT(setClaims(input, now)).setProtectedHeader({ alg: key.alg, kid: key.id, typ: 'secevent+jwt' }).sign(key.private);
}
