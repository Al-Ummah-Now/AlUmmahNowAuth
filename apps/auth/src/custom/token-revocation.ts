/**
 * @fileoverview Token revocation utilities for session and user logout
 *
 * Extracted from token-service.ts to handle token revocation during logout.
 * OpenAuth handles token generation/verification, but we need custom revocation
 * logic for refresh tokens.
 */

/**
 * Revokes all refresh tokens for a session
 *
 * Used when a user logs out of a specific session.
 *
 * @param sessionId - The account session ID
 * @param db - D1 database binding
 * @returns Number of tokens revoked
 */
export async function revokeSessionTokens(
	sessionId: string,
	db: D1Database
): Promise<{ revoked: number }> {
	const nowUnix = Math.floor(Date.now() / 1000);

	const result = await db
		.prepare(
			`UPDATE refresh_tokens
			SET revoked = 1, revoked_at = ?, revoked_reason = 'session_revoked'
			WHERE session_id = ? AND revoked = 0`
		)
		.bind(nowUnix, sessionId)
		.run();

	return { revoked: result.meta?.changes || 0 };
}

/**
 * Revokes all refresh tokens for a user across all sessions
 *
 * Used when a user logs out globally or account is disabled.
 *
 * @param userId - The user ID
 * @param db - D1 database binding
 * @returns Number of tokens revoked
 */
export async function revokeUserTokens(
	userId: string,
	db: D1Database
): Promise<{ revoked: number }> {
	const nowUnix = Math.floor(Date.now() / 1000);

	const result = await db
		.prepare(
			`UPDATE refresh_tokens
			SET revoked = 1, revoked_at = ?, revoked_reason = 'user_logout'
			WHERE user_id = ? AND revoked = 0`
		)
		.bind(nowUnix, userId)
		.run();

	return { revoked: result.meta?.changes || 0 };
}
