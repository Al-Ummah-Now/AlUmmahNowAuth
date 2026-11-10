/**
 * Account lifecycle events that end every sign-in of a user (#437).
 */
import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger';
import { revokeUser, type RevocationReason } from './revocation-list';

/**
 * Admin user API actions that must sign the user out everywhere. The router
 * strips `/admin/users` before the admin user app sees the request, so the
 * app's paths are `/:id/suspend`; the full path is accepted too.
 */
const ADMIN_USER_ACTIONS: Array<{ method: string; pattern: RegExp; reason: RevocationReason }> = [
	{ method: 'POST', pattern: /^(?:\/admin\/users)?\/([^/]+)\/suspend$/, reason: 'admin_suspended' },
	{ method: 'POST', pattern: /^(?:\/admin\/users)?\/([^/]+)\/force-password-reset$/, reason: 'admin_password_reset' },
	{ method: 'DELETE', pattern: /^(?:\/admin\/users)?\/([^/]+)$/, reason: 'admin_deleted' },
];

export function adminUserActionReason(method: string, pathname: string): { userId: string; reason: RevocationReason } | null {
	for (const action of ADMIN_USER_ACTIONS) {
		if (action.method !== method) continue;
		const match = action.pattern.exec(pathname);
		if (match?.[1] && match[1] !== 'tokens' && match[1] !== 'admin') return { userId: decodeURIComponent(match[1]), reason: action.reason };
	}
	return null;
}

/** After a successful admin suspend/delete/session wipe/forced reset: revoke the user's sign-ins. */
export function revokeOnAdminUserAction(kv: KVNamespace | undefined, db?: D1Database): MiddlewareHandler {
	return async (c, next) => {
		await next();
		if (c.res.status >= 300) return;
		const action = adminUserActionReason(c.req.method, new URL(c.req.url).pathname);
		if (!action) return;
		await revokeUser(kv, action.userId, action.reason);
		await endBrowserSignIns(db, action.userId);
	};
}

/**
 * Ends the user's sign-in in every browser. The revocation entry only stops tokens
 * issued before it; an auth browser session (account_sessions) would let /authorize
 * sign the user in again silently (prompt=none) with fresh tokens. Returns the number
 * of account sessions removed.
 */
export async function endBrowserSignIns(db: D1Database | undefined, userId: string): Promise<number> {
	if (!db || !userId) return 0;
	const removed = await db.prepare('DELETE FROM account_sessions WHERE user_id = ?').bind(userId).run();
	await db.prepare('UPDATE browser_sessions SET active_user_id = NULL WHERE active_user_id = ?').bind(userId).run();
	return removed.meta?.changes ?? 0;
}

/** Password reset/change (PasswordProvider onPasswordChanged): every account with that email. */
export async function revokeOnPasswordChange(db: D1Database, kv: KVNamespace | undefined, email: string): Promise<number> {
	const { results } = await db
		.prepare('SELECT id FROM users WHERE lower(email) = lower(?)')
		.bind(email)
		.all<{ id: string }>();
	for (const { id } of results ?? []) {
		await revokeUser(kv, id, 'password_changed');
		await endBrowserSignIns(db, id);
	}
	if (!results?.length) logger.warn('[revocation] Password changed for an email with no D1 user');
	return results?.length ?? 0;
}
