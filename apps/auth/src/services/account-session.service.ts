/**
 * @fileoverview Account Session Service for managing account sessions within browser sessions
 *
 * This service manages individual account sessions within a browser session:
 * - Adds accounts to browser sessions (max 3 accounts)
 * - Switches active account
 * - Removes accounts from sessions
 * - Tracks account session usage
 */

import { generateId } from '../utils/id';
import type { D1Database } from '@cloudflare/workers-types';
import type { AccountSession } from '../types/sessions';

export class AccountSessionService {
	constructor(private db: D1Database) {}

	/**
	 * Add an account to browser session
	 * Enforces max 3 accounts constraint (only counts non-expired sessions)
	 *
	 * @param params - Account session parameters
	 * @returns The created or reactivated account session
	 * @throws Error if max accounts limit reached
	 */
	async addAccountToSession(params: {
		browserSessionId: string;
		userId: string;
		authMethod?: string;
		setActive?: boolean;
		// OpenAuth enterprise fields
		refreshToken?: string;
		clientId?: string;
		subjectType?: string;
		subjectProperties?: Record<string, unknown>;
	}): Promise<AccountSession> {
		// Check account limit - only count non-expired, non-revoked sessions
		const count = await this.db
			.prepare(
				`SELECT COUNT(*) as count FROM account_sessions
      WHERE browser_session_id = ?
        AND is_revoked = 0
        AND expires_at > datetime('now')`
			)
			.bind(params.browserSessionId)
			.first<{ count: number }>();

		const maxAccounts = 3; // SESSION_CONSTRAINTS.MAX_ACCOUNTS_PER_BROWSER
		if (count && count.count >= maxAccounts) {
			throw new Error(`Maximum ${maxAccounts} accounts per browser session`);
		}

		// Check if user already has session in this browser
		const existing = await this.db
			.prepare(
				`SELECT id FROM account_sessions
      WHERE browser_session_id = ? AND user_id = ? AND is_revoked = 0`
			)
			.bind(params.browserSessionId, params.userId)
			.first();

		if (existing) {
			// Reactivate existing session and update OpenAuth fields
			if (params.setActive !== false) {
				await this.setActiveAccount(params.browserSessionId, existing.id as string);
			}
			// Update OpenAuth fields if provided (refresh_token, client_id, etc.)
			if (params.refreshToken || params.clientId || params.subjectType || params.subjectProperties) {
				await this.db
					.prepare(
						`UPDATE account_sessions SET
						refresh_token = COALESCE(?, refresh_token),
						client_id = COALESCE(?, client_id),
						subject_type = COALESCE(?, subject_type),
						subject_properties = COALESCE(?, subject_properties)
						WHERE id = ?`
					)
					.bind(
						params.refreshToken || null,
						params.clientId || null,
						params.subjectType || null,
						params.subjectProperties ? JSON.stringify(params.subjectProperties) : null,
						existing.id
					)
					.run();
			}
			const session = await this.getAccountSessionById(existing.id as string);
			if (!session) {
				throw new Error('Failed to retrieve account session');
			}
			return session;
		}

		const id = generateId('as');
		const expiresAt = new Date();
		const sessionLifetimeDays = 7; // SESSION_CONSTRAINTS.SESSION_LIFETIME_DAYS
		expiresAt.setDate(expiresAt.getDate() + sessionLifetimeDays);

		// If setActive, deactivate others first
		if (params.setActive !== false) {
			await this.db.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ?`).bind(params.browserSessionId).run();
		}

		await this.db
			.prepare(
				`INSERT INTO account_sessions (id, browser_session_id, user_id, auth_method, is_active, expires_at, refresh_token, client_id, subject_type, subject_properties)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				params.browserSessionId,
				params.userId,
				params.authMethod || 'email',
				params.setActive !== false ? 1 : 0,
				expiresAt.toISOString(),
				params.refreshToken || null,
				params.clientId || 'profile-app',
				params.subjectType || 'user',
				params.subjectProperties ? JSON.stringify(params.subjectProperties) : '{}'
			)
			.run();

		const session = await this.getAccountSessionById(id);
		if (!session) {
			throw new Error('Failed to create account session');
		}
		return session;
	}

	/**
	 * Switch active account in browser session
	 *
	 * @param browserSessionId - The browser session ID
	 * @param accountSessionId - The account session ID to activate
	 */
	async setActiveAccount(browserSessionId: string, accountSessionId: string): Promise<void> {
		await this.db.batch([
			// Deactivate all accounts in this browser session
			this.db.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ?`).bind(browserSessionId),
			// Activate the specified account
			this.db
				.prepare(
					`UPDATE account_sessions SET is_active = 1, last_used = datetime('now')
        WHERE id = ? AND browser_session_id = ?`
				)
				.bind(accountSessionId, browserSessionId),
		]);
	}

	/**
	 * Switch active account by user ID
	 *
	 * @param browserSessionId - The browser session ID
	 * @param userId - The user ID to activate
	 * @returns The activated account session or null if not found
	 */
	async setActiveAccountByUserId(browserSessionId: string, userId: string): Promise<AccountSession | null> {
		const account = await this.db
			.prepare(
				`SELECT id FROM account_sessions
      WHERE browser_session_id = ? AND user_id = ? AND is_revoked = 0`
			)
			.bind(browserSessionId, userId)
			.first();

		if (!account) return null;

		await this.setActiveAccount(browserSessionId, account.id as string);
		return this.getAccountSessionById(account.id as string);
	}

	/**
	 * Remove account from browser session
	 *
	 * @param browserSessionId - The browser session ID
	 * @param userId - The user ID to remove
	 * @returns Info about whether the account was active and the new active account ID
	 */
	async removeAccountFromSession(browserSessionId: string, userId: string): Promise<{ wasActive: boolean; newActiveId: string | null }> {
		const account = await this.db
			.prepare(
				`SELECT id, is_active FROM account_sessions
      WHERE browser_session_id = ? AND user_id = ?`
			)
			.bind(browserSessionId, userId)
			.first();

		if (!account) {
			return { wasActive: false, newActiveId: null };
		}

		const wasActive = Boolean(account.is_active);

		// Revoke the account session
		await this.db
			.prepare(
				`UPDATE account_sessions SET is_revoked = 1, is_active = 0
      WHERE id = ?`
			)
			.bind(account.id)
			.run();

		let newActiveId: string | null = null;

		// If was active, make another account active
		if (wasActive) {
			const nextAccount = await this.db
				.prepare(
					`SELECT id FROM account_sessions
        WHERE browser_session_id = ? AND is_revoked = 0
        ORDER BY last_used DESC
        LIMIT 1`
				)
				.bind(browserSessionId)
				.first();

			if (nextAccount) {
				newActiveId = nextAccount.id as string;
				await this.db.prepare(`UPDATE account_sessions SET is_active = 1 WHERE id = ?`).bind(newActiveId).run();
			}
		}

		return { wasActive, newActiveId };
	}

	/**
	 * Get account session by ID
	 *
	 * @param id - The account session ID
	 * @returns The account session or null if not found
	 */
	async getAccountSessionById(id: string): Promise<AccountSession | null> {
		const result = await this.db.prepare(`SELECT * FROM account_sessions WHERE id = ?`).bind(id).first();

		return result ? this.mapAccountSession(result) : null;
	}

	/**
	 * Get account session by user ID within a browser session
	 * Required by Lane 3 session management APIs
	 *
	 * @param browserSessionId - The browser session ID
	 * @param userId - The user ID
	 * @returns The account session or null if not found
	 */
	async getAccountSessionByUserId(browserSessionId: string, userId: string): Promise<AccountSession | null> {
		const result = await this.db
			.prepare(
				`SELECT * FROM account_sessions
      WHERE browser_session_id = ?
        AND user_id = ?
        AND is_revoked = 0
        AND expires_at > datetime('now')`
			)
			.bind(browserSessionId, userId)
			.first();

		return result ? this.mapAccountSession(result) : null;
	}

	/**
	 * Get all accounts for a browser session
	 * Required by Lane 3 session management APIs and max-accounts pre-check
	 *
	 * @param browserSessionId - The browser session ID
	 * @returns Array of account sessions
	 */
	async getAccountsForBrowserSession(browserSessionId: string): Promise<AccountSession[]> {
		const results = await this.db
			.prepare(
				`SELECT * FROM account_sessions
      WHERE browser_session_id = ?
        AND is_revoked = 0
        AND expires_at > datetime('now')
      ORDER BY is_active DESC, last_used DESC`
			)
			.bind(browserSessionId)
			.all();

		return (results.results || []).map((row) => this.mapAccountSession(row));
	}

	/**
	 * Get all sessions for a user across all browsers
	 *
	 * @param userId - The user ID
	 * @returns Array of account sessions with browser details
	 */
	async getUserSessions(
		userId: string
	): Promise<
		Array<
			AccountSession & {
				browserSession: {
					deviceType: string;
					deviceName: string;
					ipAddress: string;
					lastActivity: string;
					createdAt: string;
				};
			}
		>
	> {
		const results = await this.db
			.prepare(
				`SELECT
        a.*,
        b.device_type,
        b.device_name,
        b.ip_address,
        b.last_activity as browser_last_activity,
        b.created_at as browser_created_at
      FROM account_sessions a
      JOIN browser_sessions b ON a.browser_session_id = b.id
      WHERE a.user_id = ? AND a.is_revoked = 0 AND b.is_revoked = 0
      ORDER BY a.last_used DESC`
			)
			.bind(userId)
			.all();

		return (results.results || []).map((row) => ({
			...this.mapAccountSession(row),
			browserSession: {
				deviceType: row.device_type as string,
				deviceName: row.device_name as string,
				ipAddress: row.ip_address as string,
				lastActivity: row.browser_last_activity as string,
				createdAt: row.browser_created_at as string,
			},
		}));
	}

	/**
	 * Revoke all sessions for a user
	 *
	 * @param userId - The user ID
	 * @returns Number of sessions revoked
	 */
	async revokeAllUserSessions(userId: string): Promise<{ revoked: number }> {
		const result = await this.db
			.prepare(
				`UPDATE account_sessions SET is_revoked = 1, is_active = 0
      WHERE user_id = ?`
			)
			.bind(userId)
			.run();

		return { revoked: result.meta?.changes || 0 };
	}

	/**
	 * Touch session (update last_used)
	 *
	 * @param accountSessionId - The account session ID
	 */
	async touchAccountSession(accountSessionId: string): Promise<void> {
		await this.db.prepare(`UPDATE account_sessions SET last_used = datetime('now') WHERE id = ?`).bind(accountSessionId).run();
	}

	/**
	 * Get active account for browser session
	 *
	 * @param browserSessionId - The browser session ID
	 * @returns The active account session or null if none active
	 */
	async getActiveAccount(browserSessionId: string): Promise<AccountSession | null> {
		const result = await this.db
			.prepare(
				`SELECT * FROM account_sessions
      WHERE browser_session_id = ? AND is_active = 1 AND is_revoked = 0`
			)
			.bind(browserSessionId)
			.first();

		return result ? this.mapAccountSession(result) : null;
	}

	/**
	 * Map database row to AccountSession object
	 */
	private mapAccountSession(row: Record<string, unknown>): AccountSession {
		let subjectProperties: Record<string, unknown> = {};
		if (row.subject_properties) {
			try {
				subjectProperties = JSON.parse(row.subject_properties as string);
			} catch {
				subjectProperties = {};
			}
		}

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
			// OpenAuth enterprise fields
			refreshToken: (row.refresh_token as string) || undefined,
			clientId: (row.client_id as string) || undefined,
			subjectType: (row.subject_type as string) || 'user',
			subjectProperties,
		};
	}
}
