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

/** Ends the shared browser session (all accounts in it) in D1. */
async function revokeBrowserSession(request: Request, env: LogoutEnv): Promise<boolean> {
	const cookie = parseCookie(request.headers.get('Cookie'), SESSION_COOKIE);
	if (!cookie || !env.AUTH_DB) return false;
	const payload = await decryptSessionCookie(cookie, sessionCookieKey(env));
	if (!payload) return false;
	return new D1SessionAdapter(env.AUTH_DB).revokeSpecificSession(payload.sid, payload.tid);
}

export async function handleLogout(
	request: Request,
	env: LogoutEnv,
	ctx: LogoutContext,
	requestId: string,
	isProduction: boolean
): Promise<Response> {
	const url = new URL(request.url);
	const step = Math.min(Math.max(parseInt(url.searchParams.get('step') ?? '0', 10) || 0, 0), MAX_STEPS);
	const returnTo = logoutReturnUrl(env, url.searchParams.get('return'), url.origin);

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
	headers.append('Set-Cookie', clearSessionCookieHeader(SESSION_COOKIE));
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
