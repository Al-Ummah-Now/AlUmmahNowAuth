/**
 * @fileoverview D1 Session Adapter for OpenAuth Enterprise
 *
 * This adapter implements OpenAuth's SessionService interface using D1 storage.
 * All timestamps are stored as INTEGER (Unix epoch milliseconds) to match
 * OpenAuth's schema (003_session_management.sql).
 *
 * Note: Uses direct D1 queries - no dependency on BrowserSessionService/AccountSessionService
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
	BrowserSession,
	AccountSession,
	SessionService,
} from '@al-ummah-now/openauth/contracts/types';

/**
 * D1 Session Adapter implementing OpenAuth's SessionService interface
 */
export class D1SessionAdapter implements SessionService {
	constructor(private db: D1Database) {}

	/**
	 * Create a new browser session
	 */
	async createBrowserSession(params: {
		tenantId: string;
		userAgent: string;
		ipAddress: string;
	}): Promise<BrowserSession> {
		const id = `bs_${crypto.randomUUID().replace(/-/g, '')}`;
		const now = Date.now();

		await this.db
			.prepare(
				`INSERT INTO browser_sessions
				(id, tenant_id, user_agent, ip_address, created_at, last_activity, version, active_user_id)
				VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`
			)
			.bind(id, params.tenantId, params.userAgent, params.ipAddress, now, now)
			.run();

		return {
			id,
			tenant_id: params.tenantId,
			created_at: now,
			last_activity: now,
			user_agent: params.userAgent,
			ip_address: params.ipAddress,
			version: 1,
			active_user_id: null,
			account_user_ids: [],
		};
	}

	/**
	 * Get a browser session by ID and tenant ID
	 */
	async getBrowserSession(sessionId: string, tenantId: string): Promise<BrowserSession | null> {
		const row = await this.db
			.prepare(
				`SELECT id, tenant_id, created_at, last_activity, user_agent, ip_address, version, active_user_id
				FROM browser_sessions
				WHERE id = ? AND tenant_id = ?`
			)
			.bind(sessionId, tenantId)
			.first<{
				id: string;
				tenant_id: string;
				created_at: number;
				last_activity: number;
				user_agent: string | null;
				ip_address: string | null;
				version: number;
				active_user_id: string | null;
			}>();

		if (!row) return null;

		// Get account user IDs
		const accounts = await this.db
			.prepare(`SELECT user_id FROM account_sessions WHERE browser_session_id = ? ORDER BY authenticated_at ASC`)
			.bind(sessionId)
			.all<{ user_id: string }>();

		const accountUserIds = (accounts.results || []).map((a) => a.user_id);

		return {
			id: row.id,
			tenant_id: row.tenant_id,
			created_at: row.created_at,
			last_activity: row.last_activity,
			user_agent: row.user_agent || '',
			ip_address: row.ip_address || '',
			version: row.version || 1,
			active_user_id: row.active_user_id,
			account_user_ids: accountUserIds,
		};
	}

	/**
	 * Update an existing browser session
	 */
	async updateBrowserSession(session: BrowserSession): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE browser_sessions
				SET last_activity = ?, version = version + 1, active_user_id = ?
				WHERE id = ?`
			)
			.bind(now, session.active_user_id, session.id)
			.run();
	}

	/**
	 * Add an account to an existing browser session
	 */
	async addAccountToSession(params: {
		browserSessionId: string;
		userId: string;
		subjectType: string;
		subjectProperties: Record<string, unknown>;
		refreshToken: string;
		clientId: string;
		ttl: number;
		/**
		 * When the user authenticated (ms); defaults to now. Silent SSO passes the
		 * session's original time so a silent sign-on never refreshes it: it is the
		 * OIDC auth_time behind "sign in again" checks (account deletion).
		 */
		authenticatedAt?: number;
	}): Promise<AccountSession> {
		const id = `as_${crypto.randomUUID().replace(/-/g, '')}`;
		const now = Date.now();
		const authenticatedAt = params.authenticatedAt ?? now;
		const expiresAt = now + params.ttl * 1000;

		// Check if account already exists for this user in this session
		const existing = await this.db
			.prepare(`SELECT id FROM account_sessions WHERE browser_session_id = ? AND user_id = ?`)
			.bind(params.browserSessionId, params.userId)
			.first<{ id: string }>();

		if (existing) {
			// Update existing account session
			await this.db
				.prepare(
					`UPDATE account_sessions
					SET is_active = 1, authenticated_at = ?, expires_at = ?,
						subject_type = ?, subject_properties = ?, refresh_token = ?, client_id = ?
					WHERE browser_session_id = ? AND user_id = ?`
				)
				.bind(
					authenticatedAt,
					expiresAt,
					params.subjectType,
					JSON.stringify(params.subjectProperties),
					params.refreshToken,
					params.clientId,
					params.browserSessionId,
					params.userId
				)
				.run();

			// Deactivate other accounts
			await this.db
				.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ? AND user_id != ?`)
				.bind(params.browserSessionId, params.userId)
				.run();

			// Update browser session active_user_id
			await this.db
				.prepare(`UPDATE browser_sessions SET active_user_id = ? WHERE id = ?`)
				.bind(params.userId, params.browserSessionId)
				.run();

			return {
				id: existing.id,
				browser_session_id: params.browserSessionId,
				user_id: params.userId,
				is_active: true,
				authenticated_at: authenticatedAt,
				expires_at: expiresAt,
				subject_type: params.subjectType,
				subject_properties: params.subjectProperties,
				refresh_token: params.refreshToken,
				client_id: params.clientId,
			};
		}

		// Check max accounts limit (3)
		const countResult = await this.db
			.prepare(`SELECT COUNT(*) as count FROM account_sessions WHERE browser_session_id = ?`)
			.bind(params.browserSessionId)
			.first<{ count: number }>();

		if (countResult && countResult.count >= 3) {
			throw new Error('max_accounts_exceeded');
		}

		// Deactivate other accounts first
		await this.db
			.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ?`)
			.bind(params.browserSessionId)
			.run();

		// Insert new account session
		await this.db
			.prepare(
				`INSERT INTO account_sessions
				(id, browser_session_id, user_id, is_active, authenticated_at, expires_at,
				 subject_type, subject_properties, refresh_token, client_id)
				VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				params.browserSessionId,
				params.userId,
				authenticatedAt,
				expiresAt,
				params.subjectType,
				JSON.stringify(params.subjectProperties),
				params.refreshToken,
				params.clientId
			)
			.run();

		// Update browser session active_user_id
		await this.db
			.prepare(`UPDATE browser_sessions SET active_user_id = ? WHERE id = ?`)
			.bind(params.userId, params.browserSessionId)
			.run();

		return {
			id,
			browser_session_id: params.browserSessionId,
			user_id: params.userId,
			is_active: true,
			authenticated_at: authenticatedAt,
			expires_at: expiresAt,
			subject_type: params.subjectType,
			subject_properties: params.subjectProperties,
			refresh_token: params.refreshToken,
			client_id: params.clientId,
		};
	}

	/**
	 * Get an account session by browser session ID and user ID
	 */
	async getAccountSession(browserSessionId: string, userId: string): Promise<AccountSession | null> {
		const row = await this.db
			.prepare(
				`SELECT id, browser_session_id, user_id, is_active, authenticated_at, expires_at,
						subject_type, subject_properties, refresh_token, client_id
				FROM account_sessions
				WHERE browser_session_id = ? AND user_id = ?`
			)
			.bind(browserSessionId, userId)
			.first<{
				id: string;
				browser_session_id: string;
				user_id: string;
				is_active: number;
				authenticated_at: number;
				expires_at: number;
				subject_type: string | null;
				subject_properties: string | null;
				refresh_token: string | null;
				client_id: string | null;
			}>();

		if (!row) return null;

		return {
			id: row.id,
			browser_session_id: row.browser_session_id,
			user_id: row.user_id,
			is_active: row.is_active === 1,
			authenticated_at: row.authenticated_at,
			expires_at: row.expires_at,
			subject_type: row.subject_type || 'user',
			subject_properties: row.subject_properties ? JSON.parse(row.subject_properties) : {},
			refresh_token: row.refresh_token || '',
			client_id: row.client_id || '',
		};
	}

	/**
	 * List all accounts in a browser session
	 */
	async listAccounts(browserSessionId: string): Promise<AccountSession[]> {
		const result = await this.db
			.prepare(
				`SELECT id, browser_session_id, user_id, is_active, authenticated_at, expires_at,
						subject_type, subject_properties, refresh_token, client_id
				FROM account_sessions
				WHERE browser_session_id = ?
				ORDER BY authenticated_at DESC`
			)
			.bind(browserSessionId)
			.all<{
				id: string;
				browser_session_id: string;
				user_id: string;
				is_active: number;
				authenticated_at: number;
				expires_at: number;
				subject_type: string | null;
				subject_properties: string | null;
				refresh_token: string | null;
				client_id: string | null;
			}>();

		return (result.results || []).map((row) => ({
			id: row.id,
			browser_session_id: row.browser_session_id,
			user_id: row.user_id,
			is_active: row.is_active === 1,
			authenticated_at: row.authenticated_at,
			expires_at: row.expires_at,
			subject_type: row.subject_type || 'user',
			subject_properties: row.subject_properties ? JSON.parse(row.subject_properties) : {},
			refresh_token: row.refresh_token || '',
			client_id: row.client_id || '',
		}));
	}

	/**
	 * Switch the active account in a browser session
	 */
	async switchActiveAccount(browserSessionId: string, userId: string): Promise<void> {
		// Deactivate all accounts
		await this.db
			.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ?`)
			.bind(browserSessionId)
			.run();

		// Activate the specified account
		await this.db
			.prepare(`UPDATE account_sessions SET is_active = 1 WHERE browser_session_id = ? AND user_id = ?`)
			.bind(browserSessionId, userId)
			.run();

		// Update browser session active_user_id
		await this.db
			.prepare(`UPDATE browser_sessions SET active_user_id = ? WHERE id = ?`)
			.bind(userId, browserSessionId)
			.run();
	}

	/**
	 * Remove an account from a browser session
	 */
	async removeAccount(browserSessionId: string, userId: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM account_sessions WHERE browser_session_id = ? AND user_id = ?`)
			.bind(browserSessionId, userId)
			.run();

		// If this was the active user, clear active_user_id
		await this.db
			.prepare(`UPDATE browser_sessions SET active_user_id = NULL WHERE id = ? AND active_user_id = ?`)
			.bind(browserSessionId, userId)
			.run();
	}

	/**
	 * Remove all accounts from a browser session
	 */
	async removeAllAccounts(browserSessionId: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM account_sessions WHERE browser_session_id = ?`)
			.bind(browserSessionId)
			.run();

		// Clear active_user_id
		await this.db
			.prepare(`UPDATE browser_sessions SET active_user_id = NULL WHERE id = ?`)
			.bind(browserSessionId)
			.run();
	}

	/**
	 * Revoke all sessions for a user across all browsers
	 */
	async revokeUserSessions(tenantId: string, userId: string): Promise<number> {
		// Get count of sessions that will be affected
		const countResult = await this.db
			.prepare(
				`SELECT COUNT(DISTINCT a.browser_session_id) as count
				FROM account_sessions a
				JOIN browser_sessions b ON a.browser_session_id = b.id
				WHERE a.user_id = ? AND b.tenant_id = ?`
			)
			.bind(userId, tenantId)
			.first<{ count: number }>();

		// Delete account sessions for this user
		await this.db
			.prepare(
				`DELETE FROM account_sessions
				WHERE user_id = ? AND browser_session_id IN (
					SELECT id FROM browser_sessions WHERE tenant_id = ?
				)`
			)
			.bind(userId, tenantId)
			.run();

		// Clear active_user_id where this user was active
		await this.db
			.prepare(`UPDATE browser_sessions SET active_user_id = NULL WHERE tenant_id = ? AND active_user_id = ?`)
			.bind(tenantId, userId)
			.run();

		return countResult?.count || 0;
	}

	/**
	 * Revoke a specific browser session
	 */
	async revokeSpecificSession(sessionId: string, tenantId: string): Promise<boolean> {
		// Delete all account sessions for this browser session
		await this.db
			.prepare(`DELETE FROM account_sessions WHERE browser_session_id = ?`)
			.bind(sessionId)
			.run();

		// Delete the browser session itself
		const result = await this.db
			.prepare(`DELETE FROM browser_sessions WHERE id = ? AND tenant_id = ?`)
			.bind(sessionId, tenantId)
			.run();

		return (result.meta?.changes || 0) > 0;
	}
}
