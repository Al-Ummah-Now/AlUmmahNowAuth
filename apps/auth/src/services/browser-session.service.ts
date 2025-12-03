/**
 * @fileoverview Browser Session Service for managing browser/device sessions
 *
 * This service manages browser-level sessions that can contain multiple account sessions:
 * - Creates and validates browser sessions
 * - Tracks device information (UA, IP, device type)
 * - Implements sliding window expiration
 * - Provides session cleanup and revocation
 */

import { generateId } from '../utils/id';
import { hashToken } from '../utils/crypto';
import { parseUserAgent } from '../utils/user-agent';
import type { D1Database } from '@cloudflare/workers-types';
import type { BrowserSession, BrowserSessionWithAccounts, AccountSessionWithUser } from '../types/sessions';

export class BrowserSessionService {
	constructor(private db: D1Database) {}

	/**
	 * Create a new browser session
	 *
	 * @param params - Session creation parameters
	 * @returns The created browser session and its token
	 */
	async createBrowserSession(params: {
		tenantId?: string;
		userAgent: string;
		ipAddress: string;
	}): Promise<{ session: BrowserSession; token: string }> {
		const id = generateId('bs');
		const token = generateId('bst', 32); // Browser session token
		const tokenHash = await hashToken(token);
		const { deviceType, deviceName } = parseUserAgent(params.userAgent);

		const expiresAt = new Date();
		const sessionLifetimeDays = 7; // SESSION_CONSTRAINTS.SESSION_LIFETIME_DAYS
		expiresAt.setDate(expiresAt.getDate() + sessionLifetimeDays);

		await this.db
			.prepare(
				`INSERT INTO browser_sessions (id, tenant_id, session_token_hash, user_agent, ip_address, device_type, device_name, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(id, params.tenantId || 'default', tokenHash, params.userAgent, params.ipAddress, deviceType, deviceName, expiresAt.toISOString())
			.run();

		const session = await this.getBrowserSessionById(id);
		if (!session) {
			throw new Error('Failed to create browser session');
		}

		return { session, token };
	}

	/**
	 * Get browser session by token
	 *
	 * @param token - The browser session token
	 * @returns The browser session or null if not found/expired/revoked
	 */
	async getBrowserSessionByToken(token: string): Promise<BrowserSession | null> {
		const tokenHash = await hashToken(token);
		const result = await this.db
			.prepare(
				`SELECT * FROM browser_sessions
      WHERE session_token_hash = ?
      AND is_revoked = 0
      AND expires_at > datetime('now')`
			)
			.bind(tokenHash)
			.first();

		return result ? this.mapBrowserSession(result) : null;
	}

	/**
	 * Get browser session by ID
	 *
	 * @param id - The browser session ID
	 * @returns The browser session or null if not found
	 */
	async getBrowserSessionById(id: string): Promise<BrowserSession | null> {
		const result = await this.db.prepare(`SELECT * FROM browser_sessions WHERE id = ?`).bind(id).first();

		return result ? this.mapBrowserSession(result) : null;
	}

	/**
	 * Get browser session with all accounts
	 *
	 * @param sessionId - The browser session ID
	 * @returns Browser session with accounts array or null if not found
	 */
	async getBrowserSessionWithAccounts(sessionId: string): Promise<BrowserSessionWithAccounts | null> {
		const session = await this.getBrowserSessionById(sessionId);
		if (!session) return null;

		const accounts = await this.db
			.prepare(
				`SELECT
        a.*,
        u.id as user_id,
        u.email as user_email,
        u.name as user_name,
        u.avatar_url as user_avatar_url
      FROM account_sessions a
      JOIN user u ON a.user_id = u.id
      WHERE a.browser_session_id = ?
      AND a.is_revoked = 0
      AND a.expires_at > datetime('now')
      ORDER BY a.is_active DESC, a.last_used DESC`
			)
			.bind(sessionId)
			.all();

		const mappedAccounts = (accounts.results || []).map((row) => this.mapAccountSessionWithUser(row));

		return {
			...session,
			accounts: mappedAccounts,
			activeAccount: mappedAccounts.find((a) => a.isActive) || null,
		};
	}

	/**
	 * Update last activity timestamp with write throttling
	 * Only updates DB if more than 5 minutes since last stored activity
	 * Uses sliding window: extends expires_at on activity
	 *
	 * @param sessionId - The browser session ID
	 * @param currentLastActivity - Current last_activity timestamp for throttle check
	 */
	async touchBrowserSession(sessionId: string, currentLastActivity?: string): Promise<void> {
		// Write throttle: skip DB write if touched recently
		const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
		if (currentLastActivity) {
			const lastUpdate = new Date(currentLastActivity).getTime();
			const now = Date.now();
			if (now - lastUpdate < THROTTLE_MS) {
				return; // Skip DB write - too recent
			}
		}

		// Sliding window: extend expiration on activity
		const newExpiresAt = new Date();
		const sessionLifetimeDays = 7; // SESSION_CONSTRAINTS.SESSION_LIFETIME_DAYS
		newExpiresAt.setDate(newExpiresAt.getDate() + sessionLifetimeDays);

		await this.db
			.prepare(
				`UPDATE browser_sessions
      SET last_activity = datetime('now'),
          expires_at = ?
      WHERE id = ?`
			)
			.bind(newExpiresAt.toISOString(), sessionId)
			.run();
	}

	/**
	 * Revoke browser session (logs out all accounts)
	 *
	 * @param sessionId - The browser session ID to revoke
	 */
	async revokeBrowserSession(sessionId: string): Promise<void> {
		await this.db.batch([
			this.db.prepare(`UPDATE browser_sessions SET is_revoked = 1 WHERE id = ?`).bind(sessionId),
			this.db.prepare(`UPDATE account_sessions SET is_revoked = 1 WHERE browser_session_id = ?`).bind(sessionId),
		]);
	}

	/**
	 * Clean up expired sessions with batching and time-boxing
	 *
	 * @param batchSize - Maximum number of sessions to delete per call (default: 100)
	 * @returns Number of sessions deleted
	 */
	async cleanupExpiredSessions(batchSize: number = 100): Promise<{ deleted: number }> {
		// Delete expired or revoked sessions with LIMIT for time-boxing
		const result = await this.db
			.prepare(
				`DELETE FROM browser_sessions
      WHERE (expires_at < datetime('now') OR is_revoked = 1)
      AND id IN (
        SELECT id FROM browser_sessions
        WHERE expires_at < datetime('now') OR is_revoked = 1
        LIMIT ?
      )`
			)
			.bind(batchSize)
			.run();

		return { deleted: result.meta?.changes || 0 };
	}

	/**
	 * Map database row to BrowserSession object
	 */
	private mapBrowserSession(row: Record<string, unknown>): BrowserSession {
		return {
			id: row.id as string,
			tenantId: row.tenant_id as string,
			sessionTokenHash: row.session_token_hash as string,
			userAgent: (row.user_agent as string) || null,
			ipAddress: (row.ip_address as string) || null,
			deviceType: (row.device_type as 'desktop' | 'mobile' | 'tablet' | 'unknown') || 'unknown',
			deviceName: (row.device_name as string) || null,
			createdAt: row.created_at as string,
			lastActivity: row.last_activity as string,
			expiresAt: row.expires_at as string,
			isRevoked: Boolean(row.is_revoked),
		};
	}

	/**
	 * Map database row to AccountSessionWithUser object
	 */
	private mapAccountSessionWithUser(row: Record<string, unknown>): AccountSessionWithUser {
		return {
			id: row.id as string,
			browserSessionId: row.browser_session_id as string,
			userId: row.user_id as string,
			isActive: Boolean(row.is_active),
			authenticatedAt: row.authenticated_at as string,
			authMethod: (row.auth_method as 'email' | 'google' | 'mfa' | 'password') || 'email',
			lastUsed: row.last_used as string,
			expiresAt: row.expires_at as string,
			isRevoked: Boolean(row.is_revoked),
			user: {
				id: row.user_id as string,
				email: row.user_email as string,
				name: (row.user_name as string) || undefined,
				avatarUrl: (row.user_avatar_url as string) || undefined,
			},
		};
	}
}
