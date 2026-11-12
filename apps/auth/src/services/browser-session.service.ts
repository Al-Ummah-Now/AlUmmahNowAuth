/**
 * @fileoverview Browser Session Service for managing browser/device sessions
 *
 * This service manages browser-level sessions that can contain multiple account sessions.
 * Updated to work with OpenAuth's schema (003_session_management.sql):
 * - browser_sessions: id, tenant_id, created_at, last_activity, user_agent, ip_address, version, active_user_id
 * - account_sessions: id, browser_session_id, user_id, is_active, authenticated_at, expires_at, subject_type, subject_properties, refresh_token, client_id
 *
 * Note: OpenAuth uses JWE-encrypted cookies containing the session ID directly.
 * The session ID is extracted by OpenAuth middleware and passed to these services.
 */

import { parseUserAgent } from '../utils/user-agent';
import { resolveUserDisplayName } from '../../../../packages/ui/src/display-name.ts';
import type { D1Database } from '@cloudflare/workers-types';
import type { BrowserSession, BrowserSessionWithAccounts, AccountSessionWithUser } from '../types/sessions';

export class BrowserSessionService {
	constructor(private db: D1Database) {}

	/**
	 * Create a new browser session (for OpenAuth middleware use)
	 *
	 * @param params - Session creation parameters
	 * @returns The created browser session
	 */
	async createBrowserSession(params: {
		id: string;
		tenantId?: string;
		userAgent: string;
		ipAddress: string;
	}): Promise<BrowserSession> {
		const now = Date.now();

		await this.db
			.prepare(
				`INSERT INTO browser_sessions (id, tenant_id, user_agent, ip_address, created_at, last_activity, version, active_user_id)
				VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`
			)
			.bind(params.id, params.tenantId || 'default', params.userAgent, params.ipAddress, now, now)
			.run();

		const session = await this.getBrowserSessionById(params.id);
		if (!session) {
			throw new Error('Failed to create browser session');
		}

		return session;
	}

	/**
	 * Get browser session by token (session ID from JWE cookie)
	 * OpenAuth extracts the session ID from the JWE cookie and passes it here.
	 *
	 * @param sessionId - The browser session ID (from JWE cookie)
	 * @returns The browser session or null if not found
	 */
	async getBrowserSessionByToken(sessionId: string): Promise<BrowserSession | null> {
		// In OpenAuth, the "token" is the session ID itself (extracted from JWE cookie)
		return this.getBrowserSessionById(sessionId);
	}

	/**
	 * Get browser session by ID
	 *
	 * @param id - The browser session ID
	 * @returns The browser session or null if not found
	 */
	async getBrowserSessionById(id: string): Promise<BrowserSession | null> {
		const result = await this.db
			.prepare(`SELECT * FROM browser_sessions WHERE id = ?`)
			.bind(id)
			.first();

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

		const now = Date.now();
		const accounts = await this.db
			.prepare(
				`SELECT
					a.*,
					u.id as user_id,
					u.email as user_email,
					u.name as user_name,
					u.metadata as user_metadata
				FROM account_sessions a
				JOIN users u ON a.user_id = u.id
				WHERE a.browser_session_id = ?
				AND a.expires_at > ?
				ORDER BY a.is_active DESC, a.authenticated_at DESC`
			)
			.bind(sessionId, now)
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
	 *
	 * @param sessionId - The browser session ID
	 * @param currentLastActivity - Current last_activity timestamp for throttle check (Unix ms)
	 */
	async touchBrowserSession(sessionId: string, currentLastActivity?: number): Promise<void> {
		// Write throttle: skip DB write if touched recently
		const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
		if (currentLastActivity) {
			const now = Date.now();
			if (now - currentLastActivity < THROTTLE_MS) {
				return; // Skip DB write - too recent
			}
		}

		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE browser_sessions
				SET last_activity = ?, version = version + 1
				WHERE id = ?`
			)
			.bind(now, sessionId)
			.run();
	}

	/**
	 * Revoke browser session (deletes session and all accounts)
	 * OpenAuth uses hard deletes instead of soft-deletes.
	 *
	 * @param sessionId - The browser session ID to revoke
	 */
	async revokeBrowserSession(sessionId: string): Promise<void> {
		await this.db.batch([
			this.db.prepare(`DELETE FROM account_sessions WHERE browser_session_id = ?`).bind(sessionId),
			this.db.prepare(`DELETE FROM browser_sessions WHERE id = ?`).bind(sessionId),
		]);
	}

	/**
	 * Clean up expired account sessions
	 * Browser sessions don't have expiry in OpenAuth schema, only account sessions do.
	 *
	 * @param batchSize - Maximum number of sessions to delete per call (default: 100)
	 * @returns Number of account sessions deleted
	 */
	async cleanupExpiredSessions(batchSize: number = 100): Promise<{ deleted: number }> {
		const now = Date.now();

		// Delete expired account sessions with LIMIT for time-boxing
		const result = await this.db
			.prepare(
				`DELETE FROM account_sessions
				WHERE expires_at < ?
				AND id IN (
					SELECT id FROM account_sessions
					WHERE expires_at < ?
					LIMIT ?
				)`
			)
			.bind(now, now, batchSize)
			.run();

		return { deleted: result.meta?.changes || 0 };
	}

	/**
	 * Map database row to BrowserSession object
	 */
	private mapBrowserSession(row: Record<string, unknown>): BrowserSession {
		const { deviceType, deviceName } = parseUserAgent((row.user_agent as string) || '');

		return {
			id: row.id as string,
			tenantId: row.tenant_id as string,
			sessionTokenHash: '', // Not used in OpenAuth - session ID is in JWE cookie
			userAgent: (row.user_agent as string) || null,
			ipAddress: (row.ip_address as string) || null,
			deviceType: deviceType || 'unknown',
			deviceName: deviceName || null,
			createdAt: new Date(row.created_at as number).toISOString(),
			lastActivity: new Date(row.last_activity as number).toISOString(),
			expiresAt: '', // Not used in OpenAuth browser_sessions schema
			isRevoked: false, // OpenAuth uses hard deletes
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
			authenticatedAt: new Date(row.authenticated_at as number).toISOString(),
			authMethod: 'email', // Default - OpenAuth doesn't track auth method
			lastUsed: new Date(row.authenticated_at as number).toISOString(), // Use authenticated_at as last_used
			expiresAt: new Date(row.expires_at as number).toISOString(),
			isRevoked: false, // OpenAuth uses hard deletes
			user: {
				id: row.user_id as string,
				email: row.user_email as string,
				// The platform's display-name rule (name, then first + last); never the email
				name: resolveUserDisplayName({ name: row.user_name as string | null, metadata: row.user_metadata }) || undefined,
			},
		};
	}
}
