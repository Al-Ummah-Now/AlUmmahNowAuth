/**
 * @fileoverview Session Management Routes (Lane 3)
 *
 * Implements comprehensive session management APIs for multi-account browser sessions:
 * - List all logged-in accounts in browser
 * - Switch active account
 * - Sign out individual accounts (HARD sign-out with token revocation)
 * - Sign out all accounts (HARD sign-out)
 * - Check current session status
 * - List sessions across devices
 * - Revoke sessions on other devices (remote logout)
 *
 * SECURITY: All sign-out operations perform HARD sign-out (revoke sessions AND tokens)
 */

import { Hono } from 'hono';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';
import { TokenService } from '../services/token-service';
import { requireSession } from '../middleware/session';
import { clearSessionCookie } from '../utils/session-cookie';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventType, AuditEventSeverity } from '../audit-events';
import { rateLimit } from '../middleware/rate-limit';
import type { BrowserSession, AccountSession } from '../types/sessions';

// Define Hono app with session variables
type SessionVariables = {
	browserSession: BrowserSession;
	activeAccount: AccountSession | null;
};

const sessionRoutes = new Hono<{ Bindings: Env; Variables: SessionVariables }>().basePath('/session');

/**
 * Rate Limiting Configuration for Session Endpoints
 *
 * Session operations can be abuse vectors (enumeration, DoS, session hijacking attempts).
 * Apply appropriate rate limits based on operation sensitivity.
 *
 * | Endpoint                    | Limit        | Window  | Reason                          |
 * |-----------------------------|--------------|---------|----------------------------------|
 * | GET /session/accounts       | 30 req       | 1 min   | Read-only, moderate limit        |
 * | POST /session/switch        | 10 req       | 1 min   | Abuse potential for testing IDs  |
 * | DELETE /session/accounts/*  | 5 req        | 1 min   | Sign-out should be infrequent    |
 * | DELETE /session/all         | 3 req        | 1 min   | Full logout is rare              |
 * | GET /session/check          | 60 req       | 1 min   | Silent check, needs to be fast   |
 * | GET /session/devices        | 20 req       | 1 min   | Read-only device list            |
 * | DELETE /session/devices/*   | 5 req        | 1 min   | Remote logout should be rare     |
 */

import { parseSessionCookie } from '../utils/session-cookie';

const sessionRateLimit = {
	accounts: rateLimit({ limit: 30, window: 60, keyPrefix: 'session:accounts' }),
	switch: rateLimit({ limit: 10, window: 60, keyPrefix: 'session:switch' }),
	signOut: rateLimit({ limit: 5, window: 60, keyPrefix: 'session:signout' }),
	signOutAll: rateLimit({ limit: 3, window: 60, keyPrefix: 'session:signoutall' }),
	check: rateLimit({ limit: 60, window: 60, keyPrefix: 'session:check' }),
	devices: rateLimit({ limit: 20, window: 60, keyPrefix: 'session:devices' }),
	remoteLogout: rateLimit({ limit: 5, window: 60, keyPrefix: 'session:remote' }),
};

// Load browser session from cookie for all routes
sessionRoutes.use('*', async (c, next) => {
	const sessionToken = parseSessionCookie(c.req.header('Cookie') || '');
	if (sessionToken) {
		const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
		const browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);
		if (browserSession) {
			c.set('browserSession', browserSession);
			const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
			const activeAccount = await accountSessionService.getActiveAccount(browserSession.id);
			c.set('activeAccount', activeAccount);
		}
	}
	await next();
});

/**
 * GET /session/accounts
 * List all logged-in accounts in current browser session
 */
sessionRoutes.get('/accounts', sessionRateLimit.accounts, requireSession, async (c) => {
	const browserSession = c.get('browserSession');
	const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);

	const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(browserSession.id);

	if (!sessionWithAccounts) {
		return c.json({ accounts: [], activeAccount: null });
	}

	return c.json({
		accounts: sessionWithAccounts.accounts.map((account) => ({
			userId: account.userId,
			email: account.user.email,
			name: account.user.name,
			avatarUrl: account.user.avatarUrl,
			isActive: account.isActive,
			authenticatedAt: account.authenticatedAt,
			lastUsed: account.lastUsed,
		})),
		activeAccount: sessionWithAccounts.activeAccount
			? {
					userId: sessionWithAccounts.activeAccount.userId,
					email: sessionWithAccounts.activeAccount.user.email,
			  }
			: null,
	});
});

/**
 * POST /session/switch
 * Switch active account in current browser session
 * Body: { userId: string }
 */
sessionRoutes.post('/switch', sessionRateLimit.switch, requireSession, async (c) => {
	const browserSession = c.get('browserSession');
	const activeAccount = c.get('activeAccount');

	let userId: string;
	try {
		const body = await c.req.json<{ userId: string }>();
		userId = body.userId;
	} catch (_error) {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (!userId) {
		return c.json({ error: 'userId is required' }, 400);
	}

	const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
	const newActiveAccount = await accountSessionService.setActiveAccountByUserId(browserSession.id, userId);

	if (!newActiveAccount) {
		return c.json({ error: 'Account not found in session' }, 404);
	}

	// Emit audit event
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.LOGIN_SUCCESS, // Closest existing type for account switch
		severity: AuditEventSeverity.INFO,
		userId: newActiveAccount.userId,
		ipAddress: c.req.header('CF-Connecting-IP') || null,
		userAgent: c.req.header('User-Agent') || null,
		requestId: null,
		metadata: {
			action: 'session.switch_account',
			browserSessionId: browserSession.id,
			previousUserId: activeAccount?.userId,
		},
		success: true,
		errorMessage: null,
	});

	return c.json({
		success: true,
		activeAccount: {
			userId: newActiveAccount.userId,
		},
	});
});

/**
 * DELETE /session/accounts/:userId
 * Sign out one account from current browser session
 * IMPORTANT: This performs a HARD sign out - revokes session AND all tokens
 */
sessionRoutes.delete('/accounts/:userId', sessionRateLimit.signOut, requireSession, async (c) => {
	const browserSession = c.get('browserSession');
	const userId = c.req.param('userId');

	const accountSessionService = new AccountSessionService(c.env.AUTH_DB);

	// Get the account session ID before removing (needed for token revocation)
	const accountSession = await accountSessionService.getAccountSessionByUserId(browserSession.id, userId);

	if (!accountSession) {
		return c.json({ error: 'Account not found in session' }, 404);
	}

	// Remove account from session (marks as revoked)
	const result = await accountSessionService.removeAccountFromSession(browserSession.id, userId);

	// CRITICAL: Revoke all tokens for this account session
	const revokedTokens = await TokenService.revokeSessionTokens(accountSession.id, c.env);

	// Emit audit event
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.LOGOUT,
		severity: AuditEventSeverity.INFO,
		userId: userId,
		ipAddress: c.req.header('CF-Connecting-IP') || null,
		userAgent: c.req.header('User-Agent') || null,
		requestId: null,
		metadata: {
			action: 'session.signout_account',
			browserSessionId: browserSession.id,
			accountSessionId: accountSession.id,
			wasActive: result.wasActive,
			newActiveUserId: result.newActiveId,
			tokensRevoked: revokedTokens.revoked,
		},
		success: true,
		errorMessage: null,
	});

	// Check if any accounts remain
	const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
	const sessionWithAccounts = await browserSessionService.getBrowserSessionWithAccounts(browserSession.id);

	const remainingAccounts = sessionWithAccounts?.accounts.length || 0;

	// If no accounts remain, clear the session cookie
	if (remainingAccounts === 0) {
		c.header('Set-Cookie', clearSessionCookie());
	}

	return c.json({
		success: true,
		wasActive: result.wasActive,
		newActiveUserId: result.newActiveId,
		remainingAccounts,
		tokensRevoked: revokedTokens.revoked,
	});
});

/**
 * DELETE /session/all
 * Sign out all accounts and destroy browser session
 * IMPORTANT: This performs a HARD sign out - revokes all sessions AND all tokens
 */
sessionRoutes.delete('/all', sessionRateLimit.signOutAll, requireSession, async (c) => {
	const browserSession = c.get('browserSession');
	const activeAccount = c.get('activeAccount');

	// Get all account sessions in this browser before revoking
	const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
	const accountSessions = await accountSessionService.getAccountsForBrowserSession(browserSession.id);

	// CRITICAL: Revoke all tokens for all account sessions in this browser
	let totalTokensRevoked = 0;

	for (const accountSession of accountSessions) {
		const result = await TokenService.revokeSessionTokens(accountSession.id, c.env);
		totalTokensRevoked += result.revoked;
	}

	// Revoke browser session (cascades to account sessions)
	const browserSessionService = new BrowserSessionService(c.env.AUTH_DB);
	await browserSessionService.revokeBrowserSession(browserSession.id);

	// Emit audit event
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.LOGOUT,
		severity: AuditEventSeverity.INFO,
		userId: activeAccount?.userId || null,
		ipAddress: c.req.header('CF-Connecting-IP') || null,
		userAgent: c.req.header('User-Agent') || null,
		requestId: null,
		metadata: {
			action: 'session.signout_all',
			browserSessionId: browserSession.id,
			accountsSignedOut: accountSessions.length,
			tokensRevoked: totalTokensRevoked,
		},
		success: true,
		errorMessage: null,
	});

	// Clear session cookie
	c.header('Set-Cookie', clearSessionCookie());

	return c.json({
		success: true,
		accountsSignedOut: accountSessions.length,
		tokensRevoked: totalTokensRevoked,
	});
});

/**
 * GET /session/check
 * Silent session check - returns current session status
 * Used for checking if user is logged in without redirecting
 */
sessionRoutes.get('/check', sessionRateLimit.check, async (c) => {
	const browserSession = c.get('browserSession');
	const activeAccount = c.get('activeAccount');

	if (!browserSession || !activeAccount) {
		return c.json({
			authenticated: false,
			session: null,
		});
	}

	// Get user details
	const user = await c.env.AUTH_DB.prepare(`SELECT id, email FROM user WHERE id = ?`).bind(activeAccount.userId).first<{ id: string; email: string }>();

	if (!user) {
		return c.json({
			authenticated: false,
			session: null,
		});
	}

	return c.json({
		authenticated: true,
		session: {
			userId: activeAccount.userId,
			email: user.email,
			authenticatedAt: activeAccount.authenticatedAt,
			expiresAt: activeAccount.expiresAt,
			deviceType: browserSession.deviceType,
			deviceName: browserSession.deviceName,
		},
	});
});

/**
 * GET /session/devices
 * List all active sessions for current user across all devices
 * Requires authentication
 */
sessionRoutes.get('/devices', sessionRateLimit.devices, requireSession, async (c) => {
	const activeAccount = c.get('activeAccount');
	const browserSession = c.get('browserSession');

	const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
	const sessions = await accountSessionService.getUserSessions(activeAccount.userId);

	return c.json({
		sessions: sessions.map((session) => ({
			id: session.id,
			deviceType: session.browserSession.deviceType,
			deviceName: session.browserSession.deviceName,
			ipAddress: session.browserSession.ipAddress,
			lastActivity: session.browserSession.lastActivity,
			createdAt: session.browserSession.createdAt,
			isCurrentSession: session.browserSessionId === browserSession.id,
		})),
		total: sessions.length,
	});
});

/**
 * DELETE /session/devices/:sessionId
 * Revoke a specific session (remote logout)
 * IMPORTANT: This performs a HARD sign out - revokes session AND all tokens
 */
sessionRoutes.delete('/devices/:sessionId', sessionRateLimit.remoteLogout, requireSession, async (c) => {
	const activeAccount = c.get('activeAccount');
	const browserSession = c.get('browserSession');
	const sessionId = c.req.param('sessionId');

	// Verify session belongs to current user
	const accountSessionService = new AccountSessionService(c.env.AUTH_DB);
	const targetSession = await accountSessionService.getAccountSessionById(sessionId);

	if (!targetSession || targetSession.userId !== activeAccount.userId) {
		return c.json({ error: 'Session not found' }, 404);
	}

	// Prevent revoking current session via this endpoint
	if (targetSession.browserSessionId === browserSession.id) {
		return c.json({ error: 'Cannot revoke current session. Use /session/all instead.' }, 400);
	}

	// CRITICAL: Revoke all tokens for this session FIRST
	const revokedTokens = await TokenService.revokeSessionTokens(sessionId, c.env);

	// Then revoke the session
	await c.env.AUTH_DB.prepare(`UPDATE account_sessions SET is_revoked = 1 WHERE id = ?`).bind(sessionId).run();

	// Emit audit event
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.USER_FORCE_LOGOUT,
		severity: AuditEventSeverity.WARNING,
		userId: activeAccount.userId,
		ipAddress: c.req.header('CF-Connecting-IP') || null,
		userAgent: c.req.header('User-Agent') || null,
		requestId: null,
		metadata: {
			action: 'session.remote_revoke',
			revokedSessionId: sessionId,
			revokedBrowserSessionId: targetSession.browserSessionId,
			tokensRevoked: revokedTokens.revoked,
		},
		success: true,
		errorMessage: null,
	});

	return c.json({
		success: true,
		tokensRevoked: revokedTokens.revoked,
	});
});

export default sessionRoutes;
