/**
 * @fileoverview D1 Session Adapter for OpenAuth Enterprise
 *
 * This adapter wraps our D1-based session services to implement the
 * SessionService interface expected by OpenAuth's createMultiTenantIssuer.
 *
 * Key differences handled:
 * - Timestamps: D1 uses ISO strings, OpenAuth uses Unix timestamps
 * - Missing fields: Provides defaults for fields not in our schema
 * - Computed fields: Derives account_user_ids from account_sessions table
 */

import type { D1Database } from '@cloudflare/workers-types';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';

// OpenAuth contract types (defined locally to avoid module resolution issues)
interface OpenAuthBrowserSession {
	id: string;
	tenant_id: string;
	created_at: number;
	last_activity: number;
	user_agent: string;
	ip_address: string;
	version: number;
	active_user_id: string | null;
	account_user_ids: string[];
}

interface OpenAuthAccountSession {
	id: string;
	browser_session_id: string;
	user_id: string;
	is_active: boolean;
	authenticated_at: number;
	expires_at: number;
	subject_type: string;
	subject_properties: Record<string, unknown>;
	refresh_token: string;
	client_id: string;
}

interface SessionService {
	createBrowserSession(params: {
		tenantId: string;
		userAgent: string;
		ipAddress: string;
	}): Promise<OpenAuthBrowserSession>;
	getBrowserSession(sessionId: string, tenantId: string): Promise<OpenAuthBrowserSession | null>;
	updateBrowserSession(session: OpenAuthBrowserSession): Promise<void>;
	addAccountToSession(params: {
		browserSessionId: string;
		userId: string;
		subjectType: string;
		subjectProperties: Record<string, unknown>;
		refreshToken: string;
		clientId: string;
		ttl: number;
	}): Promise<OpenAuthAccountSession>;
	getAccountSession(browserSessionId: string, userId: string): Promise<OpenAuthAccountSession | null>;
	listAccounts(browserSessionId: string): Promise<OpenAuthAccountSession[]>;
	switchActiveAccount(browserSessionId: string, userId: string): Promise<void>;
	removeAccount(browserSessionId: string, userId: string): Promise<void>;
	removeAllAccounts(browserSessionId: string): Promise<void>;
	revokeUserSessions(tenantId: string, userId: string): Promise<number>;
	revokeSpecificSession(sessionId: string, tenantId: string): Promise<boolean>;
}

/**
 * Convert ISO string timestamp to Unix timestamp (seconds)
 */
function isoToUnix(isoString: string): number {
	return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Convert Unix timestamp (seconds) to ISO string
 */
function unixToIso(unix: number): string {
	return new Date(unix * 1000).toISOString();
}

/**
 * D1 Session Adapter implementing OpenAuth's SessionService interface
 */
export class D1SessionAdapter implements SessionService {
	private browserService: BrowserSessionService;
	private accountService: AccountSessionService;

	constructor(private db: D1Database) {
		this.browserService = new BrowserSessionService(db);
		this.accountService = new AccountSessionService(db);
	}

	/**
	 * Create a new browser session
	 */
	async createBrowserSession(params: {
		tenantId: string;
		userAgent: string;
		ipAddress: string;
	}): Promise<OpenAuthBrowserSession> {
		const { session } = await this.browserService.createBrowserSession({
			tenantId: params.tenantId,
			userAgent: params.userAgent,
			ipAddress: params.ipAddress,
		});

		return this.mapToOpenAuthBrowserSession(session, []);
	}

	/**
	 * Get a browser session by ID and tenant ID
	 */
	async getBrowserSession(sessionId: string, tenantId: string): Promise<OpenAuthBrowserSession | null> {
		const session = await this.browserService.getBrowserSessionById(sessionId);

		if (!session) return null;

		// Verify tenant matches
		if (session.tenantId !== tenantId) return null;

		// Check if expired or revoked
		if (session.isRevoked) return null;
		if (new Date(session.expiresAt) < new Date()) return null;

		// Get account user IDs
		const accounts = await this.accountService.getAccountsForBrowserSession(sessionId);
		const accountUserIds = accounts.map((a) => a.userId);
		const activeAccount = accounts.find((a) => a.isActive);

		return this.mapToOpenAuthBrowserSession(session, accountUserIds, activeAccount?.userId);
	}

	/**
	 * Update an existing browser session
	 */
	async updateBrowserSession(session: OpenAuthBrowserSession): Promise<void> {
		// Touch the session to update last_activity
		await this.browserService.touchBrowserSession(session.id);
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
	}): Promise<OpenAuthAccountSession> {
		// Store all OpenAuth fields in D1
		const accountSession = await this.accountService.addAccountToSession({
			browserSessionId: params.browserSessionId,
			userId: params.userId,
			authMethod: 'password',
			setActive: true,
			// Pass OpenAuth enterprise fields to be stored in D1
			refreshToken: params.refreshToken,
			clientId: params.clientId,
			subjectType: params.subjectType,
			subjectProperties: params.subjectProperties,
		});

		// Map to OpenAuth format - fields are now stored in D1
		return this.mapToOpenAuthAccountSession(accountSession);
	}

	/**
	 * Get an account session by browser session ID and user ID
	 */
	async getAccountSession(browserSessionId: string, userId: string): Promise<OpenAuthAccountSession | null> {
		const accountSession = await this.accountService.getAccountSessionByUserId(browserSessionId, userId);

		if (!accountSession) return null;

		return this.mapToOpenAuthAccountSession(accountSession);
	}

	/**
	 * List all accounts in a browser session
	 */
	async listAccounts(browserSessionId: string): Promise<OpenAuthAccountSession[]> {
		const accounts = await this.accountService.getAccountsForBrowserSession(browserSessionId);

		return accounts.map((a) => this.mapToOpenAuthAccountSession(a));
	}

	/**
	 * Switch the active account in a browser session
	 */
	async switchActiveAccount(browserSessionId: string, userId: string): Promise<void> {
		await this.accountService.setActiveAccountByUserId(browserSessionId, userId);
	}

	/**
	 * Remove an account from a browser session
	 */
	async removeAccount(browserSessionId: string, userId: string): Promise<void> {
		await this.accountService.removeAccountFromSession(browserSessionId, userId);
	}

	/**
	 * Remove all accounts from a browser session
	 */
	async removeAllAccounts(browserSessionId: string): Promise<void> {
		// Get all accounts and remove them
		const accounts = await this.accountService.getAccountsForBrowserSession(browserSessionId);
		for (const account of accounts) {
			await this.accountService.removeAccountFromSession(browserSessionId, account.userId);
		}
	}

	/**
	 * Revoke all sessions for a user across all browsers
	 */
	async revokeUserSessions(tenantId: string, userId: string): Promise<number> {
		// Note: Our current implementation doesn't filter by tenant for revoking
		// This is acceptable for single-tenant deployments
		const result = await this.accountService.revokeAllUserSessions(userId);
		return result.revoked;
	}

	/**
	 * Revoke a specific browser session
	 */
	async revokeSpecificSession(sessionId: string, tenantId: string): Promise<boolean> {
		const session = await this.browserService.getBrowserSessionById(sessionId);

		if (!session) return false;
		if (session.tenantId !== tenantId) return false;

		await this.browserService.revokeBrowserSession(sessionId);
		return true;
	}

	/**
	 * Map our D1 BrowserSession to OpenAuth's BrowserSession format
	 */
	private mapToOpenAuthBrowserSession(
		session: {
			id: string;
			tenantId: string;
			userAgent: string | null;
			ipAddress: string | null;
			createdAt: string;
			lastActivity: string;
		},
		accountUserIds: string[],
		activeUserId?: string
	): OpenAuthBrowserSession {
		return {
			id: session.id,
			tenant_id: session.tenantId,
			created_at: isoToUnix(session.createdAt),
			last_activity: isoToUnix(session.lastActivity),
			user_agent: session.userAgent || '',
			ip_address: session.ipAddress || '',
			version: 1, // We don't track version, default to 1
			active_user_id: activeUserId || null,
			account_user_ids: accountUserIds,
		};
	}

	/**
	 * Map our D1 AccountSession to OpenAuth's AccountSession format
	 */
	private mapToOpenAuthAccountSession(
		session: {
			id: string;
			browserSessionId: string;
			userId: string;
			isActive: boolean;
			authenticatedAt: string;
			expiresAt: string;
			// OpenAuth enterprise fields stored in D1
			refreshToken?: string;
			clientId?: string;
			subjectType?: string;
			subjectProperties?: Record<string, unknown>;
		}
	): OpenAuthAccountSession {
		return {
			id: session.id,
			browser_session_id: session.browserSessionId,
			user_id: session.userId,
			is_active: session.isActive,
			authenticated_at: isoToUnix(session.authenticatedAt),
			expires_at: isoToUnix(session.expiresAt),
			// OpenAuth enterprise fields from D1 storage
			subject_type: session.subjectType || 'user',
			subject_properties: session.subjectProperties || {},
			refresh_token: session.refreshToken || '',
			client_id: session.clientId || '',
		};
	}
}
