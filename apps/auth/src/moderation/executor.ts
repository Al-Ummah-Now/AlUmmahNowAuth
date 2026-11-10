/**
 * Runs an approved moderation request's action through auth's existing admin
 * user routes, as the deciding admin (their own Authorization and
 * X-Acting-User-Id headers). Nothing is reimplemented: suspend, delete,
 * forced reset and ending every session keep their guards, sign-out-everywhere
 * (revocation/lifecycle.ts) and audit events.
 */
import type { ExecutionResult, ModerationExecutor } from './admin-routes';
import type { ModerationAction } from './model';

/** The existing admin route for each automatic action. */
export function actionRoute(action: Exclude<ModerationAction, 'other'>, userId: string): { method: string; path: string } {
	const id = encodeURIComponent(userId);
	switch (action) {
		case 'suspend_account':
			return { method: 'POST', path: `/admin/users/${id}/suspend` };
		case 'delete_account':
			return { method: 'DELETE', path: `/admin/users/${id}` };
		case 'revoke_sessions':
			// The Sessions page's "terminate all sessions" (admin-session-routes.ts)
			return { method: 'DELETE', path: `/admin/users/${id}/sessions` };
		case 'require_password_reset':
			return { method: 'POST', path: `/admin/users/${id}/force-password-reset` };
	}
}

/** Headers of the admin's request that carry their identity to the inner call. */
const FORWARDED = ['authorization', 'x-acting-user-id', 'x-acting-user-email', 'x-acting-user-roles', 'x-forwarded-host', 'x-forwarded-proto', 'cookie', 'cf-connecting-ip', 'user-agent'];

export function createRouteExecutor(original: Request, dispatch: (request: Request) => Promise<Response | null>): ModerationExecutor {
	return async (action, userId, { requestId, note }): Promise<ExecutionResult> => {
		const { method, path } = actionRoute(action, userId);
		const headers = new Headers();
		for (const name of FORWARDED) {
			const value = original.headers.get(name);
			if (value) headers.set(name, value);
		}
		headers.set('Content-Type', 'application/json');
		const body = method === 'DELETE' ? undefined : JSON.stringify({ reason: note ?? `Moderation request ${requestId}` });
		const response = await dispatch(new Request(new URL(path, original.url), { method, headers, body }));
		if (!response) return { ok: false, status: 404, body: { error: 'route not found' } };
		let parsed: unknown = null;
		const text = await response.text();
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = text.slice(0, 500);
		}
		return { ok: response.status >= 200 && response.status < 300, status: response.status, body: parsed };
	};
}
