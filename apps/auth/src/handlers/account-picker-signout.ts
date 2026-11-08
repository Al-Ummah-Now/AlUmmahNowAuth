/**
 * @fileoverview "Sign out" on the account picker is single sign-out once the
 * last account is gone (#219).
 *
 * The picker's Sign out posts to the issuer's /account-picker/remove, which
 * drops that account from the shared browser session and sends the browser
 * back to /authorize?prompt=select_account. With accounts left that is right
 * (the picker shows the others). With none left the user has signed out, but
 * every app (videos, profile, admin) still held its own session, so "Sign out"
 * did not sign them out anywhere. In that case the browser goes through
 * /logout instead: it ends the browser session, walks every app's front-channel
 * logout and returns to the app the user was signing in to.
 */

import { D1SessionAdapter } from '../adapters/session-adapter';
import { logger } from '../logger';
import { browserSessionRef } from './logout-handler';

interface PickerSignOutEnv {
	AUTH_DB?: D1Database;
	SESSION_SECRET?: string;
}

export const ACCOUNT_PICKER_REMOVE_PATH = '/account-picker/remove';

/**
 * Where the browser goes after the issuer removed an account from the picker:
 * the issuer's own redirect while accounts remain, otherwise the auth server's
 * single sign-out, returning to the origin of the client's redirect_uri
 * (/logout only returns to our own apps, falling back to SIGN_IN_FALLBACK_URL).
 */
export async function afterAccountPickerRemove(request: Request, env: PickerSignOutEnv, issuerResponse: Response): Promise<Response> {
	const location = issuerResponse.headers.get('Location');
	if (issuerResponse.status < 300 || issuerResponse.status >= 400 || !location || !env.AUTH_DB) return issuerResponse;

	const authOrigin = new URL(request.url).origin;
	const ref = await browserSessionRef(request, env).catch(() => null);
	const remaining = ref ? (await new D1SessionAdapter(env.AUTH_DB).listAccounts(ref.sid)).length : 0;
	if (remaining > 0) return issuerResponse;

	let returnTo = `${authOrigin}/`;
	try {
		const redirectUri = new URL(location, authOrigin).searchParams.get('redirect_uri');
		if (redirectUri) returnTo = `${new URL(redirectUri).origin}/`;
	} catch {
		// malformed redirect_uri: return to the auth server, /logout picks the fallback
	}
	const logout = new URL('/logout', authOrigin);
	logout.searchParams.set('return', returnTo);
	logger.info('Last account removed on the account picker, starting single sign-out');

	const headers = new Headers(issuerResponse.headers);
	headers.set('Location', logout.toString());
	headers.set('Cache-Control', 'no-store');
	return new Response(null, { status: 302, headers });
}
