/**
 * The account actions an approved moderation request runs (from the queue,
 * moderation/queue.ts). Each is the same code as the admin's own action:
 *   suspend_account         userService.suspendUser + sign-out everywhere   (POST /admin/users/:id/suspend)
 *   delete_account          userService.deleteUser + sign-out everywhere    (DELETE /admin/users/:id)
 *   require_password_reset  userService.forcePasswordReset + sign-out       (POST /admin/users/:id/force-password-reset)
 *   revoke_sessions         endAllSessions                                  (DELETE /admin/users/:id/sessions)
 * The admin routes sign the user out in revokeOnAdminUserAction; here the same
 * revokeUser + endBrowserSignIns pair runs directly.
 */
import { createUserService, D1UserAdapter } from '@al-ummah-now/openauth';
import { authStorage } from '../storage/auth-storage';
import { revokeUser, type RevocationReason } from '../revocation/revocation-list';
import { endAllSessions, endBrowserSignIns } from '../revocation/lifecycle';
import type { ModerationAction } from './model';

export type AutomaticAction = Exclude<ModerationAction, 'other'>;

/** ok, or failed: permanent failures are not retried (the request is flagged at once). */
export type ActionOutcome = { ok: true; result: unknown } | { ok: false; permanent: boolean; error: string };

export type ActionRunner = (action: AutomaticAction, userId: string, tenantId: string) => Promise<ActionOutcome>;

const REASON: Record<Exclude<AutomaticAction, 'revoke_sessions'>, RevocationReason> = {
	suspend_account: 'admin_suspended',
	delete_account: 'admin_deleted',
	require_password_reset: 'admin_password_reset',
};

/** Errors that will not go away by retrying. */
function classify(action: AutomaticAction, error: unknown): ActionOutcome {
	const code = (error as { code?: string } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	// Deleting an account that is already gone is done, not failed (a retry after a timeout)
	if (action === 'delete_account' && (code === 'user_not_found' || code === 'user_deleted')) return { ok: true, result: { alreadyDeleted: true } };
	if (code === 'user_not_found' || code === 'user_deleted' || (error as Error)?.name === 'UserValidationError') {
		return { ok: false, permanent: true, error: `${code ?? 'invalid'}: ${message}` };
	}
	return { ok: false, permanent: false, error: message };
}

export function createActionRunner(env: Env): ActionRunner {
	const userService = createUserService({
		storage: authStorage(env),
		d1Adapter: new D1UserAdapter({ db: env.AUTH_DB, usersTable: 'users' }),
	});
	return async (action, userId, tenantId) => {
		try {
			if (action === 'revoke_sessions') return { ok: true, result: await endAllSessions(env.AUTH_DB, env.TOKEN_REVOCATIONS, userId) };
			let result: unknown;
			if (action === 'suspend_account') result = await userService.suspendUser(tenantId, userId);
			else if (action === 'delete_account') result = (await userService.deleteUser(tenantId, userId), { deleted: true });
			else result = { passwordResetRequired: !!(await userService.forcePasswordReset(tenantId, userId)) };
			await revokeUser(env.TOKEN_REVOCATIONS, userId, REASON[action]);
			await endBrowserSignIns(env.AUTH_DB, userId);
			return { ok: true, result };
		} catch (error) {
			return classify(action, error);
		}
	};
}

export { classify as classifyActionError };
