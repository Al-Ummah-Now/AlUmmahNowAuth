/**
 * @fileoverview Single sign-out.
 *
 * One sign-in covers every app (web, profile, admin) through the shared
 * browser session (`__session`, D1 browser_sessions). Signing out of any app
 * therefore has to end that session, and also the local session each app
 * keeps (their access tokens live up to 30 days):
 *
 *   app /logout  -> clears its own session -> auth /logout?return=<app>/
 *   auth /logout -> revokes the D1 browser session, clears __session and the
 *                   legacy auth_session, then walks FRONTCHANNEL_LOGOUT_URLS:
 *                   <url>?next=<auth>/logout?step=i+1&return=...  (each app
 *                   clears its session and follows `next` back here)
 *                -> finally redirects to `return` when its origin is one of
 *                   our apps, otherwise to SIGN_IN_FALLBACK_URL.
 *
 * Logout CSRF: a request that did not come from one of our apps (another
 * site's link, image, script or frame: Sec-Fetch-Site cross-site, or a
 * Sec-Fetch-Dest other than document) gets the "Sign out?" page instead, and
 * only that page's same-origin POST signs out.
 */

import { logger } from '../logger';
import { getUserSession, deleteSession, clearSessionCookie } from '../session';
import { getClientIP } from '../rate-limit';
import { getAuditEmitter } from '../audit-emitter';
import { createLogoutEvent } from '../audit-events';
import { trackEvent } from '../utils/analytics';
import { addSecurityHeaders } from '../utils/security-headers';
import { sessionCookieKey } from '../utils/session-secret';
import { signInFallbackUrl } from '../utils/sign-in-restart';
import { D1SessionAdapter } from '../adapters/session-adapter';
import { parseCookie, decryptSessionCookie } from '@al-ummah-now/openauth/session/cookie';
import { clearSessionCookieHeader } from '@al-ummah-now/openauth/session/middleware';
import { getLocaleFromRequest } from '@al-ummah-now/openauth/ui/i18n';
import { renderSignOutConfirmPage } from '../ui/sign-out-confirm-page';

const SESSION_COOKIE = '__session';
const MAX_STEPS = 10;

interface LogoutEnv {
	AUTH_STORAGE: KVNamespace;
	AUTH_DB?: D1Database;
	AUTH_ANALYTICS?: AnalyticsEngineDataset;
	SESSION_SECRET?: string;
	FRONTCHANNEL_LOGOUT_URLS?: string;
	SIGN_IN_FALLBACK_URL?: string;
	PROFILE_APP_URL?: string;
}

interface LogoutContext {
	waitUntil: (promise: Promise<unknown>) => void;
}

function httpUrl(value: string): URL | null {
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
	} catch {
		return null;
	}
}

/** Each app's front-channel logout endpoint, in order. */
export function frontChannelLogoutUrls(env: Pick<LogoutEnv, 'FRONTCHANNEL_LOGOUT_URLS'>): URL[] {
	return (env.FRONTCHANNEL_LOGOUT_URLS ?? '')
		.split(',')
		.map((s) => (s.trim() ? httpUrl(s) : null))
		.filter((u): u is URL => u !== null)
		.slice(0, MAX_STEPS);
}

/** Where sign-out ends: `return` if it is one of our apps, else the fallback. */
export function logoutReturnUrl(env: LogoutEnv, requested: string | null, authOrigin: string): string {
	const fallback = signInFallbackUrl(env);
	const target = requested ? httpUrl(requested) : null;
	if (!target) return fallback;
	const allowed = new Set<string>([authOrigin]);
	for (const u of frontChannelLogoutUrls(env)) allowed.add(u.origin);
	for (const v of [env.SIGN_IN_FALLBACK_URL, env.PROFILE_APP_URL]) {
		const u = v ? httpUrl(v) : null;
		if (u) allowed.add(u.origin);
	}
	return allowed.has(target.origin) ? target.toString() : fallback;
}

/**
 * Whether a GET /logout must be confirmed on the page first: it was not a
 * top-level navigation started from our own sites. Browsers without
 * Fetch Metadata (no headers) are let through, as before.
 */
export function needsSignOutConfirmation(request: Request): boolean {
	const dest = request.headers.get('Sec-Fetch-Dest');
	if (dest && dest !== 'document') return true;
	return request.headers.get('Sec-Fetch-Site') === 'cross-site';
}

/** The shared browser session (`__session`) this request carries, if any. */
export async function browserSessionRef(
	request: Request,
	env: Pick<LogoutEnv, 'SESSION_SECRET'>
): Promise<{ sid: string; tid: string } | null> {
	const cookie = parseCookie(request.headers.get('Cookie'), SESSION_COOKIE);
	if (!cookie) return null;
	const payload = await decryptSessionCookie(cookie, sessionCookieKey(env));
	return payload ? { sid: payload.sid, tid: payload.tid } : null;
}

/** Ends the shared browser session (all accounts in it) in D1. */
async function revokeBrowserSession(request: Request, env: LogoutEnv): Promise<boolean> {
	if (!env.AUTH_DB) return false;
	const ref = await browserSessionRef(request, env);
	if (!ref) return false;
	return new D1SessionAdapter(env.AUTH_DB).revokeSpecificSession(ref.sid, ref.tid);
}

export async function handleLogout(
	request: Request,
	env: LogoutEnv,
	ctx: LogoutContext,
	requestId: string,
	isProduction: boolean
): Promise<Response> {
	const url = new URL(request.url);
	let step = Math.min(Math.max(parseInt(url.searchParams.get('step') ?? '0', 10) || 0, 0), MAX_STEPS);
	let requestedReturn = url.searchParams.get('return');

	if (request.method === 'POST') {
		// Only the confirmation page's own form (same origin) may sign out with a POST
		if (request.headers.get('Origin') !== url.origin) {
			ctx.waitUntil(logger.finalizeRequest());
			return addSecurityHeaders(new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } }), isProduction);
		}
		const form = await request.formData().catch(() => null);
		requestedReturn = form?.get('return')?.toString() ?? null;
		step = 0;
	} else if (request.method !== 'GET' && request.method !== 'HEAD') {
		ctx.waitUntil(logger.finalizeRequest());
		return addSecurityHeaders(new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } }), isProduction);
	} else if (needsSignOutConfirmation(request)) {
		logger.info('Sign-out not started by our apps: asking on the page', {
			site: request.headers.get('Sec-Fetch-Site'),
			dest: request.headers.get('Sec-Fetch-Dest'),
		});
		ctx.waitUntil(logger.finalizeRequest());
		const page = await renderSignOutConfirmPage(getLocaleFromRequest(request), logoutReturnUrl(env, requestedReturn, url.origin));
		return addSecurityHeaders(page, isProduction);
	}
	const returnTo = logoutReturnUrl(env, requestedReturn, url.origin);

	const headers = new Headers();
	if (step === 0) {
		// Legacy auth_session (KV) + audit
		const session = await getUserSession(request, env.AUTH_STORAGE);
		const userId = session?.user?.id;
		await deleteSession(request, env.AUTH_STORAGE);

		let revoked = false;
		try {
			revoked = await revokeBrowserSession(request, env);
		} catch (error) {
			logger.error('Could not revoke the browser session on logout', { error: String(error) });
		}
		logger.info('User logged out', { browserSessionRevoked: revoked });

		if (userId) {
			const clientIP = getClientIP(request);
			ctx.waitUntil(
				getAuditEmitter().emit(
					createLogoutEvent(userId, {
						ipAddress: clientIP,
						userAgent: request.headers.get('User-Agent') ?? undefined,
						requestId,
					})
				)
			);
			trackEvent(env, {
				event: 'logout',
				userId,
				ipAddress: clientIP,
				userAgent: request.headers.get('User-Agent') ?? undefined,
				success: true,
			});
		}
	}
	// Clear the cookies on every step (cheap, and covers a cookie re-set mid-chain)
	const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	// Not Secure on localhost, matching how the issuer set it there (WebKit ignores Secure cookies over http)
	headers.append('Set-Cookie', clearSessionCookieHeader(SESSION_COOKIE, undefined, !isLocalhost));
	headers.append('Set-Cookie', clearSessionCookie(isLocalhost));
	headers.set('Cache-Control', 'no-store');

	// Front-channel: let the next app clear its own session, then come back
	const apps = frontChannelLogoutUrls(env);
	let location = returnTo;
	if (step < apps.length) {
		const next = new URL('/logout', url.origin);
		next.searchParams.set('step', String(step + 1));
		next.searchParams.set('return', returnTo);
		const app = new URL(apps[step]);
		app.searchParams.set('next', next.toString());
		location = app.toString();
	}
	headers.set('Location', location);

	ctx.waitUntil(logger.finalizeRequest());
	return addSecurityHeaders(new Response(null, { status: 302, headers }), isProduction);
}
