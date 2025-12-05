/**
 * @fileoverview Account Session Service for managing account sessions within browser sessions
 *
 * This service manages individual account sessions within a browser session.
 * Updated to work with OpenAuth's schema (003_session_management.sql):
 * - account_sessions: id, browser_session_id, user_id, is_active, authenticated_at, expires_at,
 *                     subject_type, subject_properties, refresh_token, client_id
 *
 * Note: OpenAuth uses hard deletes instead of soft-deletes (no is_revoked column).
 * Timestamps are stored as INTEGER (Unix epoch milliseconds).
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AccountSession } from '../types/sessions';
import { parseUserAgent } from '../utils/user-agent';

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
		const now = Date.now();

		// Check account limit - only count non-expired sessions
		const count = await this.db
			.prepare(
				`SELECT COUNT(*) as count FROM account_sessions
				WHERE browser_session_id = ?
				AND expires_at > ?`
			)
			.bind(params.browserSessionId, now)
			.first<{ count: number }>();

		const maxAccounts = 3; // SESSION_CONSTRAINTS.MAX_ACCOUNTS_PER_BROWSER
		if (count && count.count >= maxAccounts) {
			throw new Error(`Maximum ${maxAccounts} accounts per browser session`);
		}

		// Check if user already has session in this browser
		const existing = await this.db
			.prepare(
				`SELECT id FROM account_sessions
				WHERE browser_session_id = ? AND user_id = ?`
			)
			.bind(params.browserSessionId, params.userId)
			.first();

		if (existing) {
			// Reactivate existing session and update fields
			if (params.setActive !== false) {
				await this.setActiveAccount(params.browserSessionId, existing.id as string);
			}
			// Update OpenAuth fields if provided
			const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days
			await this.db
				.prepare(
					`UPDATE account_sessions SET
					authenticated_at = ?,
					expires_at = ?,
					refresh_token = COALESCE(?, refresh_token),
					client_id = COALESCE(?, client_id),
					subject_type = COALESCE(?, subject_type),
					subject_properties = COALESCE(?, subject_properties)
					WHERE id = ?`
				)
				.bind(
					now,
					expiresAt,
					params.refreshToken || null,
					params.clientId || null,
					params.subjectType || null,
					params.subjectProperties ? JSON.stringify(params.subjectProperties) : null,
					existing.id
				)
				.run();

			const session = await this.getAccountSessionById(existing.id as string);
			if (!session) {
				throw new Error('Failed to retrieve account session');
			}
			return session;
		}

		const id = `as_${crypto.randomUUID().replace(/-/g, '')}`;
		const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days

		// If setActive, deactivate others first
		if (params.setActive !== false) {
			await this.db
				.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ?`)
				.bind(params.browserSessionId)
				.run();
		}

		await this.db
			.prepare(
				`INSERT INTO account_sessions (id, browser_session_id, user_id, is_active, authenticated_at, expires_at, refresh_token, client_id, subject_type, subject_properties)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				params.browserSessionId,
				params.userId,
				params.setActive !== false ? 1 : 0,
				now,
				expiresAt,
				params.refreshToken || '',
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
		const now = Date.now();
		await this.db.batch([
			// Deactivate all accounts in this browser session
			this.db.prepare(`UPDATE account_sessions SET is_active = 0 WHERE browser_session_id = ?`).bind(browserSessionId),
			// Activate the specified account and update authenticated_at
			this.db
				.prepare(
					`UPDATE account_sessions SET is_active = 1, authenticated_at = ?
					WHERE id = ? AND browser_session_id = ?`
				)
				.bind(now, accountSessionId, browserSessionId),
		]);

		// Also update browser_sessions.active_user_id
		const account = await this.getAccountSessionById(accountSessionId);
		if (account) {
			await this.db
				.prepare(`UPDATE browser_sessions SET active_user_id = ? WHERE id = ?`)
				.bind(account.userId, browserSessionId)
				.run();
		}
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
				WHERE browser_session_id = ? AND user_id = ?`
			)
			.bind(browserSessionId, userId)
			.first();

		if (!account) return null;

		await this.setActiveAccount(browserSessionId, account.id as string);
		return this.getAccountSessionById(account.id as string);
	}

	/**
	 * Remove account from browser session (hard delete)
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

		// Delete the account session (hard delete - OpenAuth style)
		await this.db
			.prepare(`DELETE FROM account_sessions WHERE id = ?`)
			.bind(account.id)
			.run();

		let newActiveId: string | null = null;

		// If was active, make another account active
		if (wasActive) {
			const nextAccount = await this.db
				.prepare(
					`SELECT id, user_id FROM account_sessions
					WHERE browser_session_id = ?
					ORDER BY authenticated_at DESC
					LIMIT 1`
				)
				.bind(browserSessionId)
				.first();

			if (nextAccount) {
				newActiveId = nextAccount.id as string;
				await this.db.prepare(`UPDATE account_sessions SET is_active = 1 WHERE id = ?`).bind(newActiveId).run();
				// Update browser_sessions.active_user_id
				await this.db
					.prepare(`UPDATE browser_sessions SET active_user_id = ? WHERE id = ?`)
					.bind(nextAccount.user_id, browserSessionId)
					.run();
			} else {
				// No more accounts, clear active_user_id
				await this.db
					.prepare(`UPDATE browser_sessions SET active_user_id = NULL WHERE id = ?`)
					.bind(browserSessionId)
					.run();
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
	 *
	 * @param browserSessionId - The browser session ID
	 * @param userId - The user ID
	 * @returns The account session or null if not found
	 */
	async getAccountSessionByUserId(browserSessionId: string, userId: string): Promise<AccountSession | null> {
		const now = Date.now();
		const result = await this.db
			.prepare(
				`SELECT * FROM account_sessions
				WHERE browser_session_id = ?
				AND user_id = ?
				AND expires_at > ?`
			)
			.bind(browserSessionId, userId, now)
			.first();

		return result ? this.mapAccountSession(result) : null;
	}

	/**
	 * Get all accounts for a browser session
	 *
	 * @param browserSessionId - The browser session ID
	 * @returns Array of account sessions
	 */
	async getAccountsForBrowserSession(browserSessionId: string): Promise<AccountSession[]> {
		const now = Date.now();
		const results = await this.db
			.prepare(
				`SELECT * FROM account_sessions
				WHERE browser_session_id = ?
				AND expires_at > ?
				ORDER BY is_active DESC, authenticated_at DESC`
			)
			.bind(browserSessionId, now)
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
					b.user_agent,
					b.ip_address,
					b.last_activity as browser_last_activity,
					b.created_at as browser_created_at
				FROM account_sessions a
				JOIN browser_sessions b ON a.browser_session_id = b.id
				WHERE a.user_id = ?
				ORDER BY a.authenticated_at DESC`
			)
			.bind(userId)
			.all();

		return (results.results || []).map((row) => {
			const { deviceType, deviceName } = parseUserAgent((row.user_agent as string) || '');
			return {
				...this.mapAccountSession(row),
				browserSession: {
					deviceType: deviceType || 'unknown',
					deviceName: deviceName || 'Unknown Device',
					ipAddress: (row.ip_address as string) || '',
					lastActivity: new Date(row.browser_last_activity as number).toISOString(),
					createdAt: new Date(row.browser_created_at as number).toISOString(),
				},
			};
		});
	}

	/**
	 * Revoke all sessions for a user (hard delete)
	 *
	 * @param userId - The user ID
	 * @returns Number of sessions deleted
	 */
	async revokeAllUserSessions(userId: string): Promise<{ revoked: number }> {
		const result = await this.db
			.prepare(`DELETE FROM account_sessions WHERE user_id = ?`)
			.bind(userId)
			.run();

		// Clear active_user_id for any browser sessions that had this user active
		await this.db
			.prepare(`UPDATE browser_sessions SET active_user_id = NULL WHERE active_user_id IN (SELECT id FROM user WHERE id = ?)`)
			.bind(userId)
			.run();

		return { revoked: result.meta?.changes || 0 };
	}

	/**
	 * Touch session (update authenticated_at)
	 *
	 * @param accountSessionId - The account session ID
	 */
	async touchAccountSession(accountSessionId: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(`UPDATE account_sessions SET authenticated_at = ? WHERE id = ?`)
			.bind(now, accountSessionId)
			.run();
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
				WHERE browser_session_id = ? AND is_active = 1`
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
			authenticatedAt: new Date(row.authenticated_at as number).toISOString(),
			authMethod: 'email', // Default - OpenAuth doesn't track auth method
			lastUsed: new Date(row.authenticated_at as number).toISOString(), // Use authenticated_at
			expiresAt: new Date(row.expires_at as number).toISOString(),
			isRevoked: false, // OpenAuth uses hard deletes
			// OpenAuth enterprise fields
			refreshToken: (row.refresh_token as string) || undefined,
			clientId: (row.client_id as string) || undefined,
			subjectType: (row.subject_type as string) || 'user',
			subjectProperties,
		};
	}
}
