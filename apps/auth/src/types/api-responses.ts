/**
 * @fileoverview API response type definitions for session management endpoints
 *
 * Defines the response types for all session management APIs to ensure
 * consistent response structures across the application.
 */

/**
 * Account information returned in session listings
 */
export interface AccountInfo {
	userId: string;
	email: string;
	name?: string;
	avatarUrl?: string;
	isActive: boolean;
	authenticatedAt: string;
	lastUsed: string;
}

/**
 * Response from GET /session/accounts
 * Lists all logged-in accounts in the current browser session.
 * A browser with no session gets 200 `{ "accounts": [] }` (not 401), so the
 * apps' anonymous sign-in probe never logs a failed request.
 */
export interface SessionAccountsResponse {
	accounts: AccountInfo[];
	activeAccount: {
		userId: string;
		email: string;
	} | null;
}

/**
 * Response from POST /session/switch
 * Confirms successful account switch
 */
export interface SwitchAccountResponse {
	success: boolean;
	activeAccount: {
		userId: string;
	};
}

/**
 * Response from DELETE /session/accounts/:userId
 * Provides info about the removed account and remaining state
 */
export interface RemoveAccountResponse {
	success: boolean;
	wasActive: boolean;
	newActiveUserId: string | null;
	remainingAccounts: number;
	tokensRevoked: number;
}

/**
 * Response from DELETE /session/all
 * Confirms all accounts signed out
 */
export interface SignOutAllResponse {
	success: boolean;
	accountsSignedOut: number;
	tokensRevoked: number;
}

/**
 * Response from GET /session/check
 * Returns current session authentication status
 */
export interface SessionCheckResponse {
	authenticated: boolean;
	session: {
		userId: string;
		email: string;
		authenticatedAt: string;
		expiresAt: string;
		deviceType: string;
		deviceName: string | null;
	} | null;
}

/**
 * Device session information
 * Used in device/session listings
 */
export interface DeviceSession {
	id: string;
	deviceType: string;
	deviceName: string | null;
	ipAddress: string | null;
	lastActivity: string;
	createdAt: string;
	isCurrentSession: boolean;
}

/**
 * Response from GET /session/devices
 * Lists all sessions for current user across devices
 */
export interface DeviceSessionsResponse {
	sessions: DeviceSession[];
	total: number;
}

/**
 * Response from DELETE /session/devices/:sessionId
 * Confirms remote session revocation
 */
export interface RevokeDeviceResponse {
	success: boolean;
	tokensRevoked: number;
}
