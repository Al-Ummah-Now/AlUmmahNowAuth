/**
 * Admin HTTP API for soft delete (Auth admins only: requireAdmin).
 *
 *   DELETE /admin/users/:id, /admin/clients/:id, /admin/roles/:id, /admin/themes/:id
 *       soft delete; optional JSON body { reason }. 200 { deleted: DeletionView }
 *   GET  /admin/deletions[?kind=user|client|role|theme]   "Recently deleted"
 *   POST /admin/deletions/:kind/:id/restore
 *   POST /admin/deletions/:kind/:id/purge   { confirm: <label> }  "Delete permanently now"
 *
 * The DELETE handlers are mounted ahead of OpenAuth's own (which removed the
 * row at once); hideDeleted keeps deleted clients and roles out of OpenAuth's
 * listings and lookups.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { requireAdmin } from '../middleware/admin-auth';
import { getClientIP } from '../rate-limit';
import { DeletionError, listDeleted, requestPurge, restore, softDelete, type DeletionActor } from './service';
import { DeletionStore, RETENTION_DAYS, isDeletionKind, type DeletionKind } from './store';

type AdminVars = { adminUser?: { userId: string; email: string; roles: string[] } | null; tenantId?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = Context<any>;

export function actorOf(c: AnyContext): DeletionActor {
	const admin = (c.get('adminUser') as AdminVars['adminUser']) ?? null;
	return {
		userId: admin?.userId ?? (c.req.header('X-Acting-User-Id') || 'unknown'),
		email: admin?.email ?? null,
		ip: getClientIP(c.req.raw),
		userAgent: c.req.header('User-Agent') ?? null,
		requestId: c.req.header('X-Request-Id') ?? null,
	};
}

function fail(c: AnyContext, error: unknown) {
	if (error instanceof DeletionError) return c.json({ error: error.code, error_description: error.message, message: error.message }, error.status);
	throw error;
}

async function readBody(c: AnyContext): Promise<Record<string, unknown>> {
	try {
		const body = await c.req.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** DELETE handler: soft-deletes the item named by the route parameter. */
export function softDeleteRoute(kind: DeletionKind, param: string) {
	return async (c: AnyContext) => {
		const body = await readBody(c);
		try {
			const deleted = await softDelete(c.env as Env, kind, c.req.param(param), actorOf(c), {
				reason: body.reason ?? c.req.query('reason'),
				tenantId: (c.get('tenantId') as string | undefined) ?? 'default',
			});
			return c.json({ success: true, deleted });
		} catch (error) {
			return fail(c, error);
		}
	};
}

/**
 * Keeps deleted items out of a library's routes: a listing (`listPath`, JSON
 * with an array under `listKey`) loses them, and any path naming one by id
 * (`/<prefix>/:id...`) answers 404 as if it did not exist.
 */
export function hideDeleted(kind: DeletionKind, opts: { prefix: string; listKey: string }): MiddlewareHandler {
	const itemPath = new RegExp(`^/${opts.prefix}/([^/]+)`);
	return async (c, next) => {
		const store = new DeletionStore((c.env as Env).AUTH_DB);
		const path = new URL(c.req.url).pathname;
		const match = itemPath.exec(path);
		if (match && (await store.isDeleted(kind, decodeURIComponent(match[1])))) {
			return c.json({ error: 'Not Found', message: `${kind === 'role' ? 'Role' : 'Client'} not found` }, 404);
		}
		await next();
		if (c.req.method !== 'GET' || path !== `/${opts.prefix}` || c.res.status !== 200) return;
		const body = (await c.res.clone().json().catch(() => null)) as Record<string, unknown> | null;
		const items = body?.[opts.listKey];
		if (!Array.isArray(items)) return;
		const deleted = await store.deletedIds(kind);
		if (!deleted.size) return;
		const kept = items.filter((item) => !deleted.has(String((item as { id?: unknown }).id)));
		const headers = new Headers(c.res.headers);
		headers.delete('Content-Length');
		c.res = new Response(JSON.stringify({ ...body, [opts.listKey]: kept }), { status: 200, headers });
	};
}

/** Refuses to assign a deleted role (its links were moved aside and come back on restore). */
export function refuseDeletedRoleAssignment(): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method === 'POST' && /\/roles$/.test(new URL(c.req.url).pathname)) {
			const body = await readBody(c);
			const roleId = typeof body.roleId === 'string' ? body.roleId : typeof body.role_id === 'string' ? body.role_id : null;
			if (roleId && (await new DeletionStore((c.env as Env).AUTH_DB).isDeleted('role', roleId))) {
				return c.json({ error: 'Not Found', message: 'Role not found' }, 404);
			}
		}
		await next();
	};
}

export const deletionAdminRoutes = new Hono<{ Bindings: Env; Variables: AdminVars }>().basePath('/admin/deletions');
deletionAdminRoutes.use('*', requireAdmin());

deletionAdminRoutes.get('/', async (c) => {
	const kind = c.req.query('kind');
	if (kind !== undefined && !isDeletionKind(kind)) return c.json({ error: 'invalid_request', error_description: 'Unknown kind' }, 400);
	return c.json({ items: await listDeleted(c.env, kind as DeletionKind | undefined), retentionDays: RETENTION_DAYS, now: Date.now() });
});

deletionAdminRoutes.post('/:kind/:id/restore', async (c) => {
	const kind = c.req.param('kind');
	if (!isDeletionKind(kind)) return c.json({ error: 'invalid_request', error_description: 'Unknown kind' }, 400);
	try {
		await restore(c.env, kind, c.req.param('id'), actorOf(c));
		return c.json({ success: true });
	} catch (error) {
		return fail(c, error);
	}
});

deletionAdminRoutes.post('/:kind/:id/purge', async (c) => {
	const kind = c.req.param('kind');
	if (!isDeletionKind(kind)) return c.json({ error: 'invalid_request', error_description: 'Unknown kind' }, 400);
	const body = await readBody(c);
	try {
		return c.json({ success: true, item: await requestPurge(c.env, kind, c.req.param('id'), actorOf(c), body.confirm) });
	} catch (error) {
		return fail(c, error);
	}
});
