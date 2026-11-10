/**
 * The user check of every refresh grant (openauth `onRefresh`).
 *
 * A refreshed access token is re-issued with the user's CURRENT roles (the
 * enterprise issuer recomputes them from RBAC after this check). Before that,
 * a user who was deleted or suspended may no longer refresh at all: the issuer
 * then revokes the refresh token's family and answers invalid_grant, as for a
 * revoked sign-in.
 *
 * A failure to read the user propagates: the issuer answers a retryable
 * 503 temporarily_unavailable and keeps the refresh token unspent, so a D1
 * blip neither signs anyone out nor serves stale (possibly elevated) roles.
 */
import { logger } from '../logger';

export interface RefreshUserLookup {
	getUser(tenantId: string, userId: string): Promise<{ status: string; deleted_at: number | null } | null>;
}

export function createRefreshCheck(users: RefreshUserLookup) {
	return async (input: { tenantId: string; userId?: string; clientID: string }): Promise<void | { revoke: true; reason: string }> => {
		// Not a user (no id in the token): nothing to check
		if (!input.userId) return;
		const user = await users.getUser(input.tenantId, input.userId);
		if (!user || user.deleted_at !== null || user.status === 'deleted') {
			logger.info('[refresh] Refused: the user no longer exists', { userId: input.userId, clientId: input.clientID });
			return { revoke: true, reason: 'user_deleted' };
		}
		if (user.status !== 'active') {
			logger.info('[refresh] Refused: the user is not active', { userId: input.userId, status: user.status, clientId: input.clientID });
			return { revoke: true, reason: `user_${user.status}` };
		}
	};
}
