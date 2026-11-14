/**
 * `/password/change?redirect_uri=` (forgot password) is where OpenAuth's password
 * provider sends the browser once the new password is saved. The provider takes the
 * parameter as given, so on its own it is an open redirect (AlUmmahNowAuth#206).
 *
 * Before the issuer sees the request, the parameter is kept only when it is:
 * - a same-origin path ("/authorize?...", never "//host" or "/\host"), or
 * - exactly a registered redirect_uri of the enabled client named by `client_id`
 *   (the same exact-match rule /authorize applies).
 * Anything else is replaced with the sign-in fallback (the Profile app).
 */
import { signInFallbackUrl } from '../utils/sign-in-restart';

export const PASSWORD_CHANGE_PATH = '/password/change';

type RedirectEnv = { AUTH_DB: D1Database; SIGN_IN_FALLBACK_URL?: string; PROFILE_APP_URL?: string };

/** A path on this origin: starts with one "/", no backslash, no control characters. */
export function isSameOriginPath(value: string): boolean {
	if (!value.startsWith('/') || value.startsWith('//')) return false;
	// Browsers read "\" as "/" ("/\evil.example" is protocol-relative) and drop tabs/newlines
	if (value.includes('\\')) return false;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return false;
	}
	return true;
}

/**
 * The router decodes percent-escapes and ignores a trailing slash, so
 * "/password/%63hange/" reaches the same page: compare the path the way it does
 * (decoded, repeated and trailing slashes collapsed, any case).
 */
export function isPasswordChangePath(pathname: string): boolean {
	let path = pathname;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		// Malformed escapes: compare as given
	}
	path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
	return path === PASSWORD_CHANGE_PATH;
}

/** Whether the change-password page may send the browser to `redirectUri` afterwards. */
export async function isAllowedPasswordChangeRedirect(
	db: D1Database,
	redirectUri: string,
	clientId: string | null,
): Promise<boolean> {
	if (isSameOriginPath(redirectUri)) return true;
	if (!clientId) return false;
	const row = await db
		.prepare('SELECT redirect_uris FROM oauth_clients WHERE id = ? AND enabled = 1')
		.bind(clientId)
		.first<{ redirect_uris: string | null }>();
	return registeredRedirects(row?.redirect_uris).includes(redirectUri);
}

/** oauth_clients.redirect_uris: a JSON array (or, in old rows, comma-separated). */
function registeredRedirects(raw: string | null | undefined): string[] {
	if (!raw) return [];
	if (raw.trim().startsWith('[')) {
		try {
			const list = JSON.parse(raw);
			return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string') : [];
		} catch {
			return [];
		}
	}
	return raw.split(',').map((u) => u.trim()).filter(Boolean);
}

/**
 * The request the issuer should see: unchanged unless it is a GET of
 * /password/change carrying a redirect_uri that is not allowed, which is
 * replaced with the sign-in fallback.
 */
export async function safePasswordChangeRequest(request: Request, env: RedirectEnv): Promise<Request> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return request;
	const url = new URL(request.url);
	if (!isPasswordChangePath(url.pathname)) return request;
	const redirectUri = url.searchParams.get('redirect_uri');
	if (redirectUri === null) return request;
	if (await isAllowedPasswordChangeRedirect(env.AUTH_DB, redirectUri, url.searchParams.get('client_id'))) {
		return request;
	}
	url.searchParams.set('redirect_uri', signInFallbackUrl(env));
	return new Request(url.toString(), request);
}
