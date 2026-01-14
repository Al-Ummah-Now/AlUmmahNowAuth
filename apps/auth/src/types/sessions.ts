/**
 * @fileoverview Type definitions for multi-account browser sessions
 *
 * This module defines the core types for managing multiple accounts
 * logged in simultaneously per browser/device (up to 3 accounts).
 */

/**
 * Browser Session - represents a single browser/device
 * One browser session can have multiple account sessions (max 3)
 */
export interface BrowserSession {
	id: string;
	tenantId: string;
	sessionTokenHash: string;
	userAgent: string | null;
	ipAddress: string | null;
	deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
	deviceName: string | null;
	createdAt: string;
	lastActivity: string;
	expiresAt: string;
	isRevoked: boolean;
}

/**
 * Account Session - represents one logged-in account within a browser session
 * Only one account can be active at a time per browser session
 */
export interface AccountSession {
	id: string;
	browserSessionId: string;
	userId: string;
	isActive: boolean;
	authenticatedAt: string;
	authMethod: 'email' | 'google' | 'mfa' | 'password';
	lastUsed: string;
	expiresAt: string;
	isRevoked: boolean;
	// OpenAuth enterprise fields
	refreshToken?: string;
	clientId?: string;
	subjectType?: string;
	subjectProperties?: Record<string, unknown>;
}

/**
 * Account Session with associated user information
 * Used when returning account lists to display user details
 */
export interface AccountSessionWithUser extends AccountSession {
	user: {
		id: string;
		email: string;
		name?: string;
		avatarUrl?: string;
	};
}

/**
 * Browser Session with all associated account sessions
 * Used when displaying the full session state including all accounts
 */
export interface BrowserSessionWithAccounts extends BrowserSession {
	accounts: AccountSessionWithUser[];
	activeAccount: AccountSessionWithUser | null;
}

/**
 * Complete session context for the current request
 * Includes browser session, active account, and all accounts
 */
export interface SessionContext {
	browserSession: BrowserSession;
	activeAccount: AccountSession | null;
	accounts: AccountSession[];
}

/**
 * Session constraints and configuration
 */
export const SESSION_CONSTRAINTS = {
	/** Maximum number of accounts per browser session */
	MAX_ACCOUNTS_PER_BROWSER: 3,
	/** Maximum number of sessions per user across all browsers */
	MAX_SESSIONS_PER_USER: 10,
	/** Session lifetime in days (sliding window) */
	SESSION_LIFETIME_DAYS: 7,
	/** Idle timeout in hours (for future use) */
	IDLE_TIMEOUT_HOURS: 24,
} as const;

/**
 * Session operation error codes
 */
export const SESSION_ERRORS = {
	MAX_ACCOUNTS_REACHED: 'MAX_ACCOUNTS_REACHED',
	SESSION_EXPIRED: 'SESSION_EXPIRED',
	SESSION_REVOKED: 'SESSION_REVOKED',
	INVALID_SESSION: 'INVALID_SESSION',
} as const;

export type SessionError = (typeof SESSION_ERRORS)[keyof typeof SESSION_ERRORS];
