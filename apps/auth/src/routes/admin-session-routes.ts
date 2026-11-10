/**
 * @fileoverview Admin Session Management Routes (Lane 6)
 *
 * Implements administrative controls for session management:
 * - View all sessions for a user
 * - Terminate specific session
 * - Terminate all sessions for a user
 * - Force logout user (revokes all sessions and tokens)
 * - List all active sessions with filtering
 * - Session statistics
 * - Suspicious session detection
 *
 * SECURITY: All operations require admin role and specific permissions
 * AUDIT: All operations emit audit events with warning/critical severity
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { revokeSessionTokens, revokeUserTokens } from '../custom/token-revocation';
import { revokeUser } from '../revocation/revocation-list';
import { endBrowserSignIns } from '../revocation/lifecycle';
import { requireAdmin, requirePermission } from '../middleware/admin-auth';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventType, AuditEventSeverity } from '../audit-events';
import { rateLimit } from '../middleware/rate-limit';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Schema for validating session list query parameters
 * - limit: 1-100, defaults to 50
 * - offset: non-negative integer, defaults to 0
 * - ip_address: valid IPv4 or IPv6 format if provided
 * - user_id: valid UUID format if provided
 */
const SessionListQuerySchema = v.object({
	limit: v.optional(
		v.pipe(
			v.string(),
			v.transform((s) => parseInt(s, 10)),
			v.integer('Limit must be an integer'),
			v.minValue(1, 'Limit must be at least 1'),
			v.maxValue(100, 'Limit cannot exceed 100')
		)
	),
	offset: v.optional(
		v.pipe(
			v.string(),
			v.transform((s) => parseInt(s, 10)),
			v.integer('Offset must be an integer'),
			v.minValue(0, 'Offset cannot be negative')
		)
	),
	ip_address: v.optional(v.pipe(v.string(), v.ip('Invalid IP address format'))),
	user_id: v.optional(v.pipe(v.string(), v.uuid('Invalid user ID format'))),
});

// Define Hono app with admin variables
type AdminVariables = {
	browserSession: unknown;
	activeAccount: unknown;
	tenantId: string;
	adminUser: { userId: string; email: string; roles: string[] } | null;
};

const adminSessionRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>().basePath('/admin');

/**
 * Rate Limiting Configuration for Admin Session Endpoints
 *
 * Admin operations need protection against abuse while allowing legitimate admin activity
 */
const adminRateLimit = {
	view: rateLimit({ keyPrefix: 'admin:sessions:view' }),
	terminate: rateLimit({ keyPrefix: 'admin:sessions:terminate', sensitive: true }),
	stats: rateLimit({ keyPrefix: 'admin:sessions:stats' }),
};

// Apply admin role check to all routes
adminSessionRoutes.use('*', requireAdmin());

/**
 * GET /admin/users/:userId/sessions
 * List all sessions for a specific user
 */
adminSessionRoutes.get(
	'/users/:userId/sessions',
	adminRateLimit.view,
	requirePermission('users:read'),
	async (c) => {
		const userId = c.req.param('userId');
		const tenantId = c.get('tenantId');
		const adminUser = c.get('adminUser');

		// Verify user exists and belongs to tenant
		const user = await c.env.AUTH_DB.prepare(`
			SELECT id, email FROM users WHERE id = ? AND tenant_id = ?
		`)
			.bind(userId, tenantId)
			.first<{ id: string; email: string }>();

		if (!user) {
			return c.json({ error: 'User not found' }, 404);
		}

		// Get all account sessions for user
		const sessions = await c.env.AUTH_DB.prepare(`
			SELECT
				a.id as session_id,
				a.authenticated_at,
				a.is_active,
				a.expires_at,
				a.client_id,
				b.id as browser_session_id,
				b.ip_address,
				b.user_agent,
				b.created_at as browser_created_at,
				b.last_activity
			FROM account_sessions a
			JOIN browser_sessions b ON a.browser_session_id = b.id
			WHERE a.user_id = ?
				AND a.is_active = 1
				AND a.expires_at > datetime('now')
			ORDER BY b.last_activity DESC
		`)
			.bind(userId)
			.all();

		// Emit audit event
		await emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.ADMIN_SESSION_VIEWED,
			severity: AuditEventSeverity.INFO,
			userId: adminUser?.userId || null,
			ipAddress: c.req.header('CF-Connecting-IP') || null,
			userAgent: c.req.header('User-Agent') || null,
			requestId: null,
			metadata: {
				action: 'admin.view_user_sessions',
				targetUserId: userId,
				targetEmail: user.email,
				sessionCount: sessions.results.length,
			},
			success: true,
			errorMessage: null,
		});

		return c.json({
			userId,
			email: user.email,
			sessions: sessions.results.map((s) => ({
				id: s.session_id,
				browserSessionId: s.browser_session_id,
				authenticatedAt: s.authenticated_at,
				clientId: s.client_id,
				lastUsed: s.last_activity,
				isActive: Boolean(s.is_active),
				expiresAt: s.expires_at,
				device: {
					ipAddress: s.ip_address,
					userAgent: s.user_agent,
				},
				browserCreatedAt: s.browser_created_at,
				lastActivity: s.last_activity,
			})),
			totalSessions: sessions.results.length,
		});
	}
);

/**
 * DELETE /admin/users/:userId/sessions/:sessionId
 * Terminate a specific session for a user
 */
adminSessionRoutes.delete(
	'/users/:userId/sessions/:sessionId',
	adminRateLimit.terminate,
	requirePermission('users:manage'),
	async (c) => {
		const userId = c.req.param('userId');
		const sessionId = c.req.param('sessionId');
		const adminUser = c.get('adminUser');

		// Verify session belongs to user
		const session = await c.env.AUTH_DB.prepare(`
			SELECT a.id, a.browser_session_id, b.user_agent
			FROM account_sessions a
			JOIN browser_sessions b ON a.browser_session_id = b.id
			WHERE a.id = ? AND a.user_id = ?
		`)
			.bind(sessionId, userId)
			.first<{ id: string; browser_session_id: string; user_agent: string }>();

		if (!session) {
			return c.json({ error: 'Session not found' }, 404);
		}

		// Revoke the account session
		await c.env.AUTH_DB.prepare(`
			UPDATE account_sessions SET is_active = 0 WHERE id = ?
		`)
			.bind(sessionId)
			.run();

		// Revoke associated tokens
		const revokedTokens = await revokeSessionTokens(sessionId, c.env.AUTH_DB);

		// Emit audit event
		await emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.ADMIN_SESSION_TERMINATED,
			severity: AuditEventSeverity.WARNING,
			userId: adminUser?.userId || null,
			ipAddress: c.req.header('CF-Connecting-IP') || null,
			userAgent: c.req.header('User-Agent') || null,
			requestId: null,
			metadata: {
				action: 'admin.terminate_session',
				targetUserId: userId,
				sessionId: sessionId,
				userAgent: session.user_agent,
				tokensRevoked: revokedTokens.revoked,
			},
			success: true,
			errorMessage: null,
		});

		return c.json({
			success: true,
			message: `Session ${sessionId} terminated`,
			tokensRevoked: revokedTokens.revoked,
		});
	}
);

/**
 * DELETE /admin/users/:userId/sessions
 * Terminate all sessions for a user
 */
adminSessionRoutes.delete(
	'/users/:userId/sessions',
	adminRateLimit.terminate,
	requirePermission('users:manage'),
	async (c) => {
		const userId = c.req.param('userId');
		const adminUser = c.get('adminUser');

		// Get count of sessions before deletion
		const countResult = await c.env.AUTH_DB.prepare(`
			SELECT COUNT(*) as count FROM account_sessions
			WHERE user_id = ? AND is_active = 1
		`)
			.bind(userId)
			.first<{ count: number }>();

		const sessionCount = countResult?.count || 0;

		// refresh_tokens has no session link (no session_id column), so the user's
		// tokens are revoked by user: this used to 500 for any user with a session.
		const { revoked: totalTokensRevoked } = await revokeUserTokens(userId, c.env.AUTH_DB);
		// OpenAuth refresh tokens and access tokens already out (#437)
		await revokeUser(c.env.TOKEN_REVOCATIONS, userId, 'admin_sessions_revoked');
		// End the sign-in in every browser too, or /authorize (prompt=none) would sign
		// the user straight back in from the SSO session (revocation/lifecycle.ts)
		await endBrowserSignIns(c.env.AUTH_DB, userId);

		// Emit audit event
		await emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.ADMIN_SESSIONS_TERMINATED_ALL,
			severity: AuditEventSeverity.WARNING,
			userId: adminUser?.userId || null,
			ipAddress: c.req.header('CF-Connecting-IP') || null,
			userAgent: c.req.header('User-Agent') || null,
			requestId: null,
			metadata: {
				action: 'admin.terminate_all_sessions',
				targetUserId: userId,
				sessionsTerminated: sessionCount,
				tokensRevoked: totalTokensRevoked,
			},
			success: true,
			errorMessage: null,
		});

		return c.json({
			success: true,
			sessionsTerminated: sessionCount,
			tokensRevoked: totalTokensRevoked,
		});
	}
);

/**
 * POST /admin/users/:userId/force-logout
 * Force logout user everywhere - terminates all sessions and revokes all tokens
 */
adminSessionRoutes.post(
	'/users/:userId/force-logout',
	adminRateLimit.terminate,
	requirePermission('users:manage'),
	async (c) => {
		const userId = c.req.param('userId');
		const adminUser = c.get('adminUser');

		let reason: string | undefined;
		try {
			const body = await c.req.json<{ reason?: string }>();
			reason = body.reason;
		} catch {
			// No body or invalid JSON - use default reason
		}

		// Get user info
		const user = await c.env.AUTH_DB.prepare(`
			SELECT id, email FROM users WHERE id = ?
		`)
			.bind(userId)
			.first<{ id: string; email: string }>();

		if (!user) {
			return c.json({ error: 'User not found' }, 404);
		}

		// Clear active user from all browser sessions for this user
		const browserSessions = await c.env.AUTH_DB.prepare(`
			SELECT DISTINCT b.id
			FROM browser_sessions b
			JOIN account_sessions a ON b.id = a.browser_session_id
			WHERE a.user_id = ?
		`)
			.bind(userId)
			.all<{ id: string }>();

		for (const bs of browserSessions.results || []) {
			await c.env.AUTH_DB.prepare(`
				UPDATE browser_sessions SET active_user_id = NULL WHERE id = ?
			`)
				.bind(bs.id)
				.run();
		}

		// Revoke all account sessions
		const accountSessionsResult = await c.env.AUTH_DB.prepare(`
			UPDATE account_sessions SET is_active = 0 WHERE user_id = ?
		`)
			.bind(userId)
			.run();

		// Revoke all refresh tokens
		const refreshResult = await c.env.AUTH_DB.prepare(`
			UPDATE refresh_tokens
			SET revoked = 1, revoked_at = ?, revoked_reason = 'admin_force_logout'
			WHERE user_id = ? AND revoked = 0
		`)
			.bind(Math.floor(Date.now() / 1000), userId)
			.run();

		// Revoke all app tokens via user tokens method
		const tokenResult = await revokeUserTokens(userId, c.env.AUTH_DB);
		// OpenAuth refresh tokens and access tokens already out (#437)
		await revokeUser(c.env.TOKEN_REVOCATIONS, userId, 'admin_force_logout');

		// Emit critical audit event
		await emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.ADMIN_FORCE_LOGOUT,
			severity: AuditEventSeverity.CRITICAL,
			userId: adminUser?.userId || null,
			ipAddress: c.req.header('CF-Connecting-IP') || null,
			userAgent: c.req.header('User-Agent') || null,
			requestId: null,
			metadata: {
				action: 'admin.force_logout',
				targetUserId: userId,
				targetEmail: user.email,
				reason: reason || 'Admin initiated',
				browserSessionsRevoked: browserSessions.results?.length || 0,
				accountSessionsRevoked: accountSessionsResult.meta?.changes || 0,
				refreshTokensRevoked: refreshResult.meta?.changes || 0,
				appTokensRevoked: tokenResult.revoked,
			},
			success: true,
			errorMessage: null,
		});

		return c.json({
			success: true,
			message: `User ${user.email} has been logged out from all devices`,
			stats: {
				browserSessionsRevoked: browserSessions.results?.length || 0,
				accountSessionsRevoked: accountSessionsResult.meta?.changes || 0,
				refreshTokensRevoked: refreshResult.meta?.changes || 0,
				appTokensRevoked: tokenResult.revoked,
			},
		});
	}
);

/**
 * GET /admin/sessions
 * List all active sessions with filtering
 */
adminSessionRoutes.get(
	'/sessions',
	adminRateLimit.view,
	requirePermission('users:read'),
	async (c) => {
		const tenantId = c.get('tenantId');

		// Validate query parameters
		const queryParams = {
			limit: c.req.query('limit'),
			offset: c.req.query('offset'),
			ip_address: c.req.query('ip_address'),
			user_id: c.req.query('user_id'),
		};

		// Filter out undefined values before validation
		const filteredParams = Object.fromEntries(
			Object.entries(queryParams).filter(([, v]) => v !== undefined)
		);

		let validatedParams: v.InferOutput<typeof SessionListQuerySchema>;
		try {
			validatedParams = v.parse(SessionListQuerySchema, filteredParams);
		} catch (error) {
			if (error instanceof v.ValiError) {
				return c.json(
					{
						error: 'Invalid query parameters',
						details: error.issues.map((issue) => ({
							field: issue.path?.map((p: { key: string | number }) => p.key).join('.') || 'unknown',
							message: issue.message,
						})),
					},
					400
				);
			}
			throw error;
		}

		const limit = validatedParams.limit ?? 50;
		const offset = validatedParams.offset ?? 0;
		const ipAddress = validatedParams.ip_address;
		const queryUserId = validatedParams.user_id;

		const whereConditions = ['b.tenant_id = ?', 'a.is_active = 1'];
		const bindings: (string | number)[] = [tenantId];

		if (ipAddress) {
			whereConditions.push('b.ip_address = ?');
			bindings.push(ipAddress);
		}

		if (queryUserId) {
			whereConditions.push('a.user_id = ?');
			bindings.push(queryUserId);
		}

		const whereClause = whereConditions.join(' AND ');

		// Get total count
		const countResult = await c.env.AUTH_DB.prepare(`
			SELECT COUNT(*) as count
			FROM account_sessions a
			JOIN browser_sessions b ON a.browser_session_id = b.id
			WHERE ${whereClause}
		`)
			.bind(...bindings)
			.first<{ count: number }>();

		// Get sessions
		const sessions = await c.env.AUTH_DB.prepare(`
			SELECT
				a.id as session_id,
				a.user_id,
				u.email,
				a.authenticated_at,
				a.is_active,
				b.ip_address,
				b.user_agent,
				b.last_activity
			FROM account_sessions a
			JOIN browser_sessions b ON a.browser_session_id = b.id
			JOIN users u ON a.user_id = u.id
			WHERE ${whereClause}
			ORDER BY b.last_activity DESC
			LIMIT ? OFFSET ?
		`)
			.bind(...bindings, limit, offset)
			.all();

		return c.json({
			sessions: sessions.results.map((s) => ({
				id: s.session_id,
				userId: s.user_id,
				email: s.email,
				authenticatedAt: s.authenticated_at,
				lastUsed: s.last_activity,
				isActive: Boolean(s.is_active),
				device: {
					ipAddress: s.ip_address,
					userAgent: s.user_agent,
				},
				lastActivity: s.last_activity,
			})),
			total: countResult?.count || 0,
			limit,
			offset,
		});
	}
);

/**
 * GET /admin/sessions/stats
 * Get session statistics
 */
adminSessionRoutes.get(
	'/sessions/stats',
	adminRateLimit.stats,
	requirePermission('analytics:read'),
	async (c) => {
		const tenantId = c.get('tenantId');

		const [totalSessions, activeSessions, deviceBreakdown, recentLogins] =
			await Promise.all([
				// Total active sessions
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(*) as count
					FROM account_sessions a
					JOIN browser_sessions b ON a.browser_session_id = b.id
					WHERE b.tenant_id = ? AND a.is_active = 1
				`)
					.bind(tenantId)
					.first<{ count: number }>(),

				// Currently active (activity in last hour)
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(*) as count
					FROM account_sessions a
					JOIN browser_sessions b ON a.browser_session_id = b.id
					WHERE a.is_active = 1
					AND b.last_activity > unixepoch() - 3600
				`).first<{ count: number }>(),

				// Unique users with active sessions
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(DISTINCT a.user_id) as count
					FROM account_sessions a
					JOIN browser_sessions b ON a.browser_session_id = b.id
					WHERE b.tenant_id = ? AND a.is_active = 1
				`)
					.bind(tenantId)
					.first<{ count: number }>(),

				// Logins in last 24 hours
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(*) as count
					FROM account_sessions a
					JOIN browser_sessions b ON a.browser_session_id = b.id
					WHERE b.tenant_id = ?
					AND a.authenticated_at > unixepoch() - 86400
				`)
					.bind(tenantId)
					.first<{ count: number }>(),
			]);

		return c.json({
			totalSessions: totalSessions?.count || 0,
			activeSessions: activeSessions?.count || 0,
			uniqueUsers: deviceBreakdown?.count || 0,
			loginsLast24h: recentLogins?.count || 0,
		});
	}
);

/**
 * GET /admin/sessions/suspicious
 * Get suspicious session activity
 */
adminSessionRoutes.get(
	'/sessions/suspicious',
	adminRateLimit.view,
	requirePermission('audit:read'),
	async (c) => {
		const tenantId = c.get('tenantId');

		// Find suspicious patterns:
		// 1. Multiple IPs for same user in short time
		// 2. Failed login attempts followed by success

		const multipleIPs = await c.env.AUTH_DB.prepare(`
			SELECT
				a.user_id,
				u.email,
				COUNT(DISTINCT b.ip_address) as ip_count,
				GROUP_CONCAT(DISTINCT b.ip_address) as ip_addresses
			FROM account_sessions a
			JOIN browser_sessions b ON a.browser_session_id = b.id
			JOIN users u ON a.user_id = u.id
			WHERE b.tenant_id = ?
			AND a.authenticated_at > datetime('now', '-24 hours')
			GROUP BY a.user_id
			HAVING ip_count > 3
			ORDER BY ip_count DESC
			LIMIT 20
		`)
			.bind(tenantId)
			.all();

		const failedThenSuccess = await c.env.AUTH_DB.prepare(`
			SELECT
				ae.user_id,
				u.email,
				COUNT(*) as failed_attempts,
				MAX(ae.timestamp) as last_failure
			FROM audit_events ae
			JOIN users u ON ae.user_id = u.id
			WHERE ae.event_type = 'auth.login.failed'
			AND ae.timestamp > datetime('now', '-1 hour')
			AND EXISTS (
				SELECT 1 FROM audit_events ae2
				WHERE ae2.user_id = ae.user_id
				AND ae2.event_type = 'auth.login.success'
				AND ae2.timestamp > ae.timestamp
			)
			GROUP BY ae.user_id
			HAVING failed_attempts >= 3
			ORDER BY failed_attempts DESC
			LIMIT 20
		`).all();

		return c.json({
			multipleIPsInShortTime: multipleIPs.results.map((r) => ({
				userId: r.user_id,
				email: r.email,
				ipCount: r.ip_count,
				ipAddresses: (r.ip_addresses as string).split(','),
			})),
			failedThenSuccessfulLogins: failedThenSuccess.results.map((r) => ({
				userId: r.user_id,
				email: r.email,
				failedAttempts: r.failed_attempts,
				lastFailure: r.last_failure,
			})),
		});
	}
);

/**
 * POST /admin/sessions/bulk-terminate
 * Bulk terminate sessions by filter criteria
 */
adminSessionRoutes.post(
	'/sessions/bulk-terminate',
	adminRateLimit.terminate,
	requirePermission('users:manage'),
	async (c) => {
		const adminUser = c.get('adminUser');
		const tenantId = c.get('tenantId');

		let filters: {
			ipAddress?: string;
			olderThanDays?: number;
		};

		try {
			filters = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		const whereConditions = ['b.tenant_id = ?', 'a.is_active = 1'];
		const bindings: (string | number)[] = [tenantId];

		if (filters.ipAddress) {
			whereConditions.push('b.ip_address = ?');
			bindings.push(filters.ipAddress);
		}

		if (filters.olderThanDays) {
			// Use browser session last_activity to filter old sessions
			const cutoffTime = Math.floor(Date.now() / 1000) - (filters.olderThanDays * 86400);
			whereConditions.push('b.last_activity < ?');
			bindings.push(cutoffTime);
		}

		const whereClause = whereConditions.join(' AND ');

		// Get sessions to terminate
		const sessions = await c.env.AUTH_DB.prepare(`
			SELECT a.id, a.user_id
			FROM account_sessions a
			JOIN browser_sessions b ON a.browser_session_id = b.id
			WHERE ${whereClause}
		`)
			.bind(...bindings)
			.all<{ id: string; user_id: string }>();

		const sessionCount = sessions.results?.length || 0;

		if (sessionCount === 0) {
			return c.json({
				success: true,
				sessionsTerminated: 0,
				tokensRevoked: 0,
			});
		}

		// Revoke all sessions and tokens
		let totalTokensRevoked = 0;
		for (const session of sessions.results || []) {
			const result = await revokeSessionTokens(session.id, c.env.AUTH_DB);
			totalTokensRevoked += result.revoked;
		}

		// Revoke the account sessions
		const sessionIds = sessions.results?.map((s) => s.id) || [];
		const placeholders = sessionIds.map(() => '?').join(',');
		await c.env.AUTH_DB.prepare(`
			UPDATE account_sessions SET is_active = 0
			WHERE id IN (${placeholders})
		`)
			.bind(...sessionIds)
			.run();

		// Emit audit event
		await emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.ADMIN_SESSIONS_TERMINATED_ALL,
			severity: AuditEventSeverity.CRITICAL,
			userId: adminUser?.userId || null,
			ipAddress: c.req.header('CF-Connecting-IP') || null,
			userAgent: c.req.header('User-Agent') || null,
			requestId: null,
			metadata: {
				action: 'admin.bulk_terminate_sessions',
				filters,
				sessionsTerminated: sessionCount,
				tokensRevoked: totalTokensRevoked,
			},
			success: true,
			errorMessage: null,
		});

		return c.json({
			success: true,
			sessionsTerminated: sessionCount,
			tokensRevoked: totalTokensRevoked,
		});
	}
);

export default adminSessionRoutes;
