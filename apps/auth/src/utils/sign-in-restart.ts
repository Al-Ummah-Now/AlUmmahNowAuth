/**
 * @fileoverview Where a sign-in that can't be resumed starts over.
 *
 * OpenAuth renders a friendly "Start sign-in again" page (en/ar) instead of the
 * raw UnknownStateError. That page links back to the app that started the
 * sign-in (origin of its redirect_uri). When that app is unknown (for example a
 * bookmarked /password/authorize), it links to this fallback: the main web app.
 */

type RestartEnv = Pick<Env, 'PROFILE_APP_URL'> & { SIGN_IN_FALLBACK_URL?: string };

function httpUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** SIGN_IN_FALLBACK_URL, else PROFILE_APP_URL, else the auth server root. */
export function signInFallbackUrl(env: RestartEnv): string {
	return httpUrl(env.SIGN_IN_FALLBACK_URL) ?? httpUrl(env.PROFILE_APP_URL) ?? '/';
}
