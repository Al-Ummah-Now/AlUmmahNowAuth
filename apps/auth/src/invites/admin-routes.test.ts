import { env } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setupDatabase } from '../test-setup';
import { AuditEventType } from '../audit-events';
import { inviteAdminRoutes } from './admin-routes';

const { key, emitAuditEvent } = vi.hoisted(() => ({
	key: new Uint8Array(32).fill(7),
	emitAuditEvent: vi.fn(async () => {}),
}));
vi.mock('../utils/jwks-cache', () => ({ issuerKeySet: () => async () => key }));
vi.mock('../audit-emitter', async (original) => ({
	...(await original<typeof import('../audit-emitter')>()),
	emitAuditEvent,
}));

const issuer = 'https://auth.test';
const db = env.AUTH_DB;
const now = Date.now();
const pending = `inv_${'a'.repeat(32)}`;
const accepted = `inv_${'b'.repeat(32)}`;
const expired = `inv_${'c'.repeat(32)}`;
const otherTenant = `inv_${'d'.repeat(32)}`;
const revokeTarget = `inv_${'e'.repeat(32)}`;

async function request(path = '', options: { as?: string; method?: string; scope?: string; limited?: boolean; anonymous?: boolean } = {}) {
	const headers = new Headers();
	if (!options.anonymous) {
		const token = await new SignJWT({ client_id: 'admin-client', mode: 'm2m', scope: options.scope ?? 'admin' })
			.setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setExpirationTime('5m').sign(key);
		headers.set('Authorization', `Bearer ${token}`);
	}
	if (options.as) headers.set('X-Acting-User-Id', options.as);
	headers.set('X-Acting-User-Email', 'untrusted@example.com');
	const limiter = { limit: vi.fn(async () => ({ success: !options.limited })) };
	return inviteAdminRoutes('test-request').fetch(
		new Request(`${issuer}/admin/invites${path}`, { headers, method: options.method }),
		{ ...env, OPENAUTH_ISSUER: issuer, ADMIN_SENSITIVE_LIMITER: limiter, ADMIN_LIMITER: limiter } as unknown as Env,
		{ waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
	);
}

describe('Auth admin invites API', () => {
	beforeAll(async () => {
		await setupDatabase();
		await db.batch([
			db.prepare("INSERT INTO oauth_clients (id, tenant_id, name, created_at, updated_at) VALUES ('videos', 'default', 'Videos', 0, 0)"),
			db.prepare("INSERT INTO users (id, email, status, created_at, updated_at) VALUES ('usr_invite_admin', 'admin@example.com', 'active', 0, 0), ('usr_invite_member', 'member@example.com', 'active', 0, 0), ('usr_target', 'target@example.com', 'invited', 0, 0)"),
			db.prepare("INSERT INTO rbac_roles (id, tenant_id, name, created_at, updated_at) VALUES ('test_invite_admin', 'default', 'Admin', 0, 0)"),
			db.prepare("INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('usr_invite_admin', 'test_invite_admin', 'default', 0, 'test')"),
		]);
		for (const [id, tenant, userId, expiresAt, acceptedAt] of [
			[pending, 'default', 'usr_pending', now + 600_000, null],
			[accepted, 'default', 'usr_accepted', now + 600_000, now],
			[expired, 'default', 'usr_expired', now - 1, null],
			[revokeTarget, 'default', 'usr_target', now + 600_000, null],
			[otherTenant, 'other', 'usr_other', now + 600_000, null],
		]) {
			await db.prepare(`INSERT INTO user_invites
				(id, tenant_id, user_id, email, name, client_id, token_hash, invited_by, invited_by_email, created_at, updated_at, expires_at, accepted_at)
				VALUES (?, ?, ?, ?, 'Invitee', 'videos', ?, 'usr_inviter', 'inviter@example.com', ?, ?, ?, ?)`)
				.bind(id, tenant, userId, `${userId}@example.com`, `private-hash-${id}`, now, now, expiresAt, acceptedAt).run();
		}
	});

	it('requires a valid M2M token, an acting user, admin scope and a database-backed admin role', async () => {
		expect((await request('', { anonymous: true })).status).toBe(401);
		expect((await request()).status).toBe(401);
		expect((await request('', { as: 'usr_invite_admin', scope: 'invites:provision' })).status).toBe(403);
		expect((await request('', { as: 'usr_invite_member' })).status).toBe(403);
		expect((await request(`/${pending}/revoke`, { as: 'usr_invite_member', method: 'POST' })).status).toBe(403);
	});

	it('lists tenant-scoped summaries, supports search and cursor pagination, and omits token material', async () => {
		const admin = { as: 'usr_invite_admin' };
		const response = await request('?status=pending&search=INVITEE&limit=1', admin);
		expect(response.status).toBe(200);
		const body = await response.json<{ invites: unknown[]; nextCursor: string }>();
		expect(body.invites).toEqual([{
			id: revokeTarget, email: 'usr_target@example.com', name: 'Invitee', clientId: 'videos',
			clientName: 'Videos', status: 'pending', invitedByUserId: 'usr_inviter',
			invitedByEmail: 'inviter@example.com', createdAt: now, expiresAt: now + 600_000,
		}]);
		const next = await request(`?status=pending&limit=1&cursor=${encodeURIComponent(body.nextCursor)}`, admin);
		expect(await next.json()).toMatchObject({ invites: [{ id: pending }], nextCursor: null });
		expect(await (await request('?status=accepted', admin)).json()).toMatchObject({ invites: [{ id: accepted, status: 'accepted' }] });
		expect(await (await request('?status=expired', admin)).json()).toMatchObject({ invites: [{ id: expired, status: 'expired' }] });
		expect(await (await request('?search=usr_other', admin)).json()).toEqual({ invites: [], nextCursor: null });
		expect((await request('?status=unknown', admin)).status).toBe(400);
		expect((await request('', { ...admin, limited: true })).status).toBe(429);
	});

	it('revokes an unused account into Recently deleted and audits the verified actor', async () => {
		const admin = { as: 'usr_invite_admin', method: 'POST' };
		expect((await request(`/${revokeTarget}/revoke`, { ...admin, limited: true })).status).toBe(429);
		expect((await request(`/${otherTenant}/revoke`, admin)).status).toBe(404);
		expect((await request(`/${accepted}/revoke`, admin)).status).toBe(409);
		const responses = await Promise.all([request(`/${revokeTarget}/revoke`, admin), request(`/${revokeTarget}/revoke`, admin)]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(await db.prepare("SELECT status FROM users WHERE id = 'usr_target'").first('status')).toBe('deleted');
		expect(await db.prepare("SELECT deleted_by_email FROM admin_deletions WHERE kind = 'user' AND item_id = 'usr_target'").first('deleted_by_email')).toBe('admin@example.com');
		expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
			eventType: AuditEventType.USER_INVITE_REVOKED,
			userId: 'usr_invite_admin',
			metadata: expect.objectContaining({ inviteId: revokeTarget, actorEmail: 'admin@example.com' }),
		}));
		expect(await (await request('?status=revoked', { as: admin.as })).json()).toMatchObject({ invites: [{ id: revokeTarget, status: 'revoked' }] });
	});
});
