import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.server', () => ({
  getAuthenticatedUser: vi.fn(async () => ({ user: { id: 'usr_admin1', email: 'admin@example.test', roles: ['admin'] } })),
}));

import { clearTokenCache } from './admin-api.server';
import { getAllPermissions, getRoleById, removeUserFromRole } from './rbac-api.server';

const env = { AUTH_SERVER_URL: 'https://auth.test', ADMIN_CLIENT_ID: 'admin-client', ADMIN_CLIENT_SECRET: 'secret' };
const request = new Request('https://admin.auth.test/roles/role_content_reviewer', { headers: { Cookie: 'admin_session=x' } });

function mockAuth(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/token')) return Response.json({ access_token: 'm2m-token', expires_in: 3600 });
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTokenCache();
});

describe('rbac-api.server (QA 2026-11-18: role pages answered 404)', () => {
  it('calls Auth with the M2M token acting as the signed-in admin, never with cookies', async () => {
    const calls = mockAuth(() => Response.json({ role: { id: 'role_content_reviewer', name: 'Content reviewer', is_system_role: false }, permissions: [] }));
    await getRoleById(request, env, 'role_content_reviewer');
    expect(calls).toHaveLength(1);
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get('Authorization')).toBe('Bearer m2m-token');
    expect(h.get('X-Acting-User-Id')).toBe('usr_admin1');
    expect(h.get('Cookie')).toBeNull();
  });

  it("unwraps Auth's { role, permissions } into the role with its permissions", async () => {
    mockAuth(() => Response.json({ role: { id: 'r1', name: 'Writer', is_system_role: false }, permissions: [{ id: 'p1', name: 'posts:write' }] }));
    const role = await getRoleById(request, env, 'r1');
    expect(role).toMatchObject({ id: 'r1', name: 'Writer', permissions: [{ id: 'p1' }] });
  });

  it('reads permissions from /admin/permissions and removes a user through the user-role route', async () => {
    const calls = mockAuth((url) => (url.endsWith('/admin/permissions') ? Response.json({ total: 0, permissions: {} }) : Response.json({ success: true })));
    await getAllPermissions(request, env);
    await removeUserFromRole(request, env, 'role_writer', 'usr_9');
    expect(calls.map((c) => [c.init.method ?? 'GET', new URL(c.url).pathname])).toEqual([
      ['GET', '/admin/permissions'],
      ['DELETE', '/admin/users/usr_9/roles/role_writer'],
    ]);
  });
});
