/**
 * @fileoverview Session UI handlers
 *
 * Handles session management UI pages:
 * - /settings/sessions - User's session management page
 * - /ui/account-switcher - Account switcher component
 * - /admin/sessions/dashboard - Admin sessions dashboard
 */

import { logger } from '../logger';
import { getUserSession } from '../session';
import { parseSessionCookie } from '../utils/session-cookie';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';
import { renderSessionList } from '../ui/session-list';
import { renderAccountSwitcher } from '../ui/account-switcher';
import { renderAdminSessionsDashboard } from '../ui/admin-sessions';
import { addSecurityHeaders } from '../utils/security-headers';
import { uiLocale } from '../ui/confirm-dialog';

interface SessionUIEnv {
	AUTH_DB: D1Database;
	AUTH_STORAGE: KVNamespace;
	PROFILE_APP_URL?: string;
}

/**
 * Handle /settings/sessions - User's session management page
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param isProduction - Whether running in production
 * @returns HTML response with session list
 */
export async function handleSettingsSessions(
	request: Request,
	env: SessionUIEnv,
	isProduction: boolean
): Promise<Response> {
	const url = new URL(request.url);

	// Use browser session (multi-account) instead of OpenAuth session
	const sessionToken = parseSessionCookie(request.headers.get('Cookie') || '');
	if (!sessionToken) {
		// Redirect to profile app to login
		return Response.redirect(env.PROFILE_APP_URL || `${url.origin}/`, 302);
	}

	const browserSessionService = new BrowserSessionService(env.AUTH_DB);
	const accountSessionService = new AccountSessionService(env.AUTH_DB);

	// Get browser session
	const browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);
	if (!browserSession) {
		return Response.redirect(env.PROFILE_APP_URL || `${url.origin}/`, 302);
	}

	// Get active account from browser session
	const activeAccount = await accountSessionService.getActiveAccount(browserSession.id);
	if (!activeAccount) {
		return Response.redirect(env.PROFILE_APP_URL || `${url.origin}/`, 302);
	}

	// Get user's sessions across devices
	const userSessions = await accountSessionService.getUserSessions(activeAccount.userId);

	// Transform to UI format (DeviceSession interface)
	const sessions = await Promise.all(
		userSessions.map(async (s) => {
			const browser = await browserSessionService.getBrowserSessionById(s.browserSessionId);
			return {
				id: s.id,
				browserSessionId: s.browserSessionId,
				deviceType: (browser?.deviceType || 'unknown') as
					| 'desktop'
					| 'mobile'
					| 'tablet'
					| 'unknown',
				deviceName: browser?.deviceName || 'Unknown Device',
				ipAddress: browser?.ipAddress || null,
				lastActivity: s.lastUsed,
				createdAt: s.authenticatedAt,
				isCurrentSession: s.browserSessionId === browserSession.id,
			};
		})
	);

	const html = renderSessionList({
		sessions,
		actionBaseUrl: '/session/devices',
		showRevokeAll: true,
		locale: uiLocale(request),
	});

	return addSecurityHeaders(
		new Response(html, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}),
		isProduction
	);
}

/**
 * Handle /ui/account-switcher - Account switcher component
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param isProduction - Whether running in production
 * @returns HTML response with account switcher or 204 if no session
 */
export async function handleAccountSwitcher(
	request: Request,
	env: SessionUIEnv,
	isProduction: boolean
): Promise<Response> {
	// Use browser session (multi-account) instead of OpenAuth session
	const sessionToken = parseSessionCookie(request.headers.get('Cookie') || '');
	if (!sessionToken) {
		return addSecurityHeaders(new Response('', { status: 204 }), isProduction);
	}

	const browserSessionService = new BrowserSessionService(env.AUTH_DB);

	// First get the session by token to get the ID
	const session = await browserSessionService.getBrowserSessionByToken(sessionToken);
	if (!session) {
		return addSecurityHeaders(new Response('', { status: 204 }), isProduction);
	}

	// Then get the session with accounts using the ID
	const browserSession = await browserSessionService.getBrowserSessionWithAccounts(session.id);

	if (!browserSession) {
		return addSecurityHeaders(new Response('', { status: 204 }), isProduction);
	}

	// Transform to AccountSwitcherAccount interface
	const accounts = browserSession.accounts.map((a) => ({
		userId: a.userId,
		email: a.user.email,
		name: a.user.name,
		avatarUrl: a.user.avatarUrl,
		lastUsed: a.lastUsed,
		isActive: a.isActive,
	}));

	const html = renderAccountSwitcher({
		accounts,
		actionBaseUrl: '/session',
		showAccountCount: true,
		locale: uiLocale(request),
	});

	return addSecurityHeaders(
		new Response(html, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}),
		isProduction
	);
}

/**
 * Handle /admin/sessions/dashboard - Admin sessions dashboard
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param isProduction - Whether running in production
 * @returns HTML response with admin dashboard
 */
export async function handleAdminSessionsDashboard(
	request: Request,
	env: SessionUIEnv,
	isProduction: boolean
): Promise<Response> {
	const url = new URL(request.url);

	// Verify admin access
	const session = await getUserSession(request, env.AUTH_STORAGE);
	if (!session?.user) {
		return Response.redirect(`${url.origin}/`, 302);
	}

	// TODO: Check admin role properly
	// For now, render the dashboard with empty data (API endpoint populates real data)
	const html = renderAdminSessionsDashboard({
		stats: {
			totalSessions: 0,
			activeSessions: 0,
			loginsLast24h: 0,
			deviceBreakdown: { desktop: 0, mobile: 0, tablet: 0, unknown: 0 },
		},
		suspicious: { multipleIPsInShortTime: [], failedThenSuccessfulLogins: [] },
		sessions: [],
		filters: {},
		userBaseUrl: '/admin/users',
		actionBaseUrl: '/admin/sessions',
	});

	return addSecurityHeaders(
		new Response(html, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}),
		isProduction
	);
}
