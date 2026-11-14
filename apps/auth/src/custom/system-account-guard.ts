/**
 * System accounts in the admin user and RBAC APIs (security/system-accounts.ts).
 *
 * Mounted ahead of every route of the admin user app (/admin/users/*) and the
 * admin RBAC app (/admin/rbac/*):
 * - a role grant to a system account (POST .../:userId/roles) is refused with
 *   403 `system_account`, audited and flagged on the admin Errors page. The D1
 *   trigger of migrations/0041_system_accounts.sql refuses it again underneath.
 * - any other change to one (edit, suspend, delete, forced password reset,
 *   sessions, role removal) is refused with 403 `system_account`, audited and flagged:
 *   the row must stay, since `assigned_by` references it.
 * - reading one by id (GET /:id, /:id/roles, ...) answers 404, as for an unknown
 *   user: they are hidden from the admin. The super admin's read-only System
 *   accounts view lists them (GET /admin/users?system=only, user-list-routes.ts).
 * - `metadata.type = "system"` is reserved: creating or editing a user with it is
 *   refused (400), so no other account can be hidden or locked out that way.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { flagSystemAccountAttempt, isSystemMetadata, isSystemUser, isSystemUserId, type SystemAccountEnv } from '../security/system-accounts';

type GuardEnv = SystemAccountEnv & { AUTH_DB: D1Database };

function ctxOf(c: Context): ExecutionContext | undefined {
	try {
		return c.executionCtx;
	} catch {
		return undefined;
	}
}

function actorOf(c: Context): string | undefined {
	const admin = c.get('adminUser') as { userId?: string } | null | undefined;
	return admin?.userId ?? c.req.header('X-Acting-User-Id') ?? undefined;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
	try {
		const body = await c.req.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const systemAccount = (c: Context, status: 403 | 404, message: string) =>
	c.json({ error: status === 404 ? 'Not Found' : 'system_account', message }, status);

/** `users`: the admin user app, where request bodies carry user metadata. */
export function systemAccountGuard(options: { users?: boolean } = {}): MiddlewareHandler {
	return async (c, next) => {
		const env = c.env as GuardEnv;
		const method = c.req.method.toUpperCase();
		const segments = new URL(c.req.url).pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
		const isRoleGrant = method === 'POST' && segments[segments.length - 1] === 'roles' && segments.length >= 2;

		// The account a path names: a system id anywhere in it, or (role grants) the user before /roles
		let target = segments.find((s) => isSystemUserId(s));
		if (!target && isRoleGrant && env?.AUTH_DB) {
			const userId = segments[segments.length - 2];
			const row = await env.AUTH_DB.prepare('SELECT id, metadata FROM users WHERE id = ?').bind(userId).first<{ id: string; metadata: string | null }>();
			if (row && isSystemUser(row)) target = row.id;
		}

		if (target) {
			if (method === 'GET' || method === 'HEAD') return systemAccount(c, 404, 'User not found');
			if (isRoleGrant) {
				const body = await jsonBody(c);
				const roleId = typeof body.roleId === 'string' ? body.roleId : typeof body.role_id === 'string' ? body.role_id : undefined;
				flagSystemAccountAttempt(env, ctxOf(c), { userId: target, attempt: 'role_grant', detail: roleId, request: c.req.raw, actorId: actorOf(c) });
				return systemAccount(c, 403, "System accounts can't hold roles");
			}
			flagSystemAccountAttempt(env, ctxOf(c), {
				userId: target,
				attempt: 'admin_change',
				detail: `${method} ${segments.slice(-2).join('/')}`,
				request: c.req.raw,
				actorId: actorOf(c),
			});
			return systemAccount(c, 403, "System accounts can't be changed");
		}

		// metadata.type "system" is reserved for the seeded system accounts
		if (options.users && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
			const body = await jsonBody(c);
			if (isSystemMetadata(body.metadata)) {
				return c.json({ error: 'invalid_request', message: 'metadata.type "system" is reserved' }, 400);
			}
		}
		await next();
	};
}
