/**
 * The openauth issuer mounts permission routes at /rbac and /rbac/admin, outside
 * the /admin guard, and the router mounts the user ones at /api/permissions. They
 * act only for a user or admin the host put on the request, and Auth never does:
 * every caller gets 401, whatever token or header it sends (AUTH-R4).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';

const ORIGIN = 'http://localhost:3301';
const HEADERS: Record<string, Record<string, string>> = {
	anonymous: {},
	'a made-up token and headers': { Authorization: 'Bearer x.y.z', 'X-Acting-User-Id': 'usr_admin', 'X-Tenant-Id': 'default', 'X-Admin-Id': 'usr_admin' },
};
const ROUTES: [string, string][] = [
	['GET', '/rbac/admin/roles'],
	['POST', '/rbac/admin/roles'],
	['PATCH', '/rbac/admin/roles/admin'],
	['DELETE', '/rbac/admin/roles/admin'],
	['GET', '/rbac/admin/roles/admin/permissions'],
	['POST', '/rbac/admin/roles/admin/permissions'],
	['GET', '/rbac/admin/users/usr_1/roles'],
	['POST', '/rbac/admin/users/usr_1/roles'],
	['DELETE', '/rbac/admin/users/usr_1/roles/admin'],
	['GET', '/rbac/admin/clients/web/permissions'],
	['POST', '/rbac/admin/clients/web/permissions'],
	['POST', '/rbac/check'],
	['POST', '/rbac/check/batch'],
	['GET', '/rbac/permissions'],
	['GET', '/rbac/roles'],
	['POST', '/api/permissions/check'],
	['POST', '/api/permissions/check/batch'],
	['GET', '/api/permissions/roles'],
];

describe('permission routes outside /admin act for nobody', () => {
	beforeAll(async () => {
		await setupDatabase();
	});

	for (const [who, headers] of Object.entries(HEADERS)) {
		for (const [method, path] of ROUTES) {
			it(`${method} ${path}, ${who}: 401`, async () => {
				const ctx = createExecutionContext();
				const body = method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ roleId: 'admin', name: 'x', permission: 'users:write', permissionId: 'p', permissions: ['users:write'] });
				const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, body, headers: { host: 'localhost:3301', 'content-type': 'application/json', ...headers } }), env as unknown as Env, ctx);
				await waitOnExecutionContext(ctx);
				expect(res.status).toBe(401);
			});
		}
	}
});
