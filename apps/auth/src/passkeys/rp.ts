/**
 * WebAuthn relying party for this environment (AUTH-PASSKEYS).
 *
 * RP id = the issuer host without `auth.` (alummahnow.net, stage.alummahnow.net,
 * qa.alummahnow.net, localhost), so QA and stage passkeys never show up on
 * production. Ceremonies run only on the issuer's own pages (the sign-in page,
 * the after-sign-in card and /passkeys/setup); the account hub links there.
 */
import { rpIdForHost } from '@al-ummah-now/openauth/passkey';

export interface RpEnv {
	OPENAUTH_ISSUER?: string;
	WEBAUTHN_RP_ID?: string;
	ENVIRONMENT?: string;
	PROFILE_APP_URL?: string;
}

export function issuerOrigin(env: RpEnv, request: Request): string {
	try {
		if (env.OPENAUTH_ISSUER) return new URL(env.OPENAUTH_ISSUER).origin;
	} catch {
		/* fall through */
	}
	return new URL(request.url).origin;
}

export function rpId(env: RpEnv, request: Request): string {
	return env.WEBAUTHN_RP_ID || rpIdForHost(new URL(issuerOrigin(env, request)).host);
}

export function rpOrigins(env: RpEnv, request: Request): string[] {
	return [issuerOrigin(env, request)];
}

export function rpName(env: RpEnv): string {
	if (env.ENVIRONMENT === 'qa') return 'Al Ummah Now QA';
	if (env.ENVIRONMENT === 'stage') return 'Al Ummah Now Stage';
	if (env.ENVIRONMENT === 'development') return 'Al Ummah Now Local';
	return 'Al Ummah Now';
}

/** The account hub's passkeys section. */
export function hubUrl(env: RpEnv): string {
	return `${(env.PROFILE_APP_URL || 'https://profile.auth.alummahnow.net/').replace(/\/$/, '')}/#passkeys`;
}
