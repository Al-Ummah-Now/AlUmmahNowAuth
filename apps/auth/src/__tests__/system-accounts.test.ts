/**
 * System accounts (security/system-accounts.ts): user_system and any user with
 * metadata.type "system" can never sign in, act as an admin or hold a role, are
 * hidden from the admin lists and counts, and every refused attempt is audited
 * and raises a needs-action item on the admin Errors page.
 *
 * One test per way in: password, email code, password reset, registration,
 * passkey, silent single sign-on, device, a magic-link style provider, the code
 * grant, token refresh, admin "set password" (forced reset), impersonation
 * (X-Acting-User-Id and an admin session); then role grants (API and the D1
 * trigger), the admin views and the flag itself.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';
import { setupDatabase } from '../test-setup';
import { authStorage } from '../storage/auth-storage';
import { guardIssuerStorage } from '../revocation/token-gate';
import { accountStateOf, isRefusedAccountState, readAccountState } from '../security/account-status';
import { createOnSuccessHandler, createSendCodeHandler, type UserServiceLike } from '../handlers/auth-handlers';
import { createRefreshCheck } from '../handlers/refresh-check';
import { systemAccountGuard } from '../custom/system-account-guard';
import { userListRoutes } from '../custom/user-list-routes';
import { requireAdmin } from '../middleware/admin-auth';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { resetErrorReporter } from '../errors/report';
import { getAuditEmitter } from '../audit-emitter';
import { flagSystemAccountAttempt, isSystemUser, SYSTEM_USER_ID, systemAccountsAdminUrl } from '../security/system-accounts';

const E = env as unknown as Env;
const ISSUER = 'http://localhost:3301';
const INGEST = 'https://admin.api.test.alummahnow.net/internal/errors';
/** Error reporting on, so each flag is a POST we can see */
const REPORTING = { ERRORS_INGEST_URL: INGEST, INTERNAL_API_KEY: 'test-internal-key', ENVIRONMENT: 'test', OPENAUTH_ISSUER: 'https://auth.qa.alummahnow.net' };
const SYSTEM_EMAIL = 'system@openauth.local';
/** A second system account, marked only by metadata.type */
const META_SYSTEM = 'usr_meta_system';
const PERSON = 'usr_sys_person';
const ADMIN = 'usr_sys_admin';
const SUPER = 'usr_sys_super';

// Other files replace globalThis.fetch with their own mock at import time (all files are
// imported into one isolate first), so it is swapped and put back as the same object,
// never spied on and restored to the real fetch.
const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;
let auditSpy: ReturnType<typeof vi.spyOn>;

/** The needs-action items posted to the Errors page ingest since the last reset. */
function flaggedItems(): Array<{ key: string; title: string; itemUrl?: string }> {
	const out: Array<{ key: string; title: string; itemUrl?: string }> = [];
	for (const call of fetchSpy.mock.calls) {
		const [url, init] = call as [string, RequestInit | undefined];
		if (String(url) !== INGEST || !init?.body) continue;
		const body = JSON.parse(String(init.body)) as { events: Array<{ kind: string; action?: { key: string; title: string; itemUrl?: string } }> };
		for (const event of body.events) if (event.kind === 'action' && event.action) out.push(event.action);
	}
	return out;
}

/** The audit events emitted since the last reset. */
function auditTypes(): string[] {
	return auditSpy.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
}

async function putUser(id: string, email: string, metadata: string | null) {
	const ts = Date.now();
	await E.AUTH_DB.prepare(
		`INSERT OR REPLACE INTO users (id, tenant_id, email, name, metadata, status, created_at, updated_at, last_login_at, deleted_at, password_reset_required)
		 VALUES (?, 'default', ?, ?, ?, 'active', ?, ?, NULL, NULL, 0)`
	)
		.bind(id, email, id === SYSTEM_USER_ID ? 'System' : null, metadata, ts, ts)
		.run();
}

async function grant(userId: string, roleId: string) {
	await E.AUTH_DB.prepare(
		`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, ?, 'default', ?, 'test')`
	)
		.bind(userId, roleId, Date.now())
		.run();
}

beforeAll(async () => {
	await setupDatabase();
	await putUser(SYSTEM_USER_ID, SYSTEM_EMAIL, '{"type": "system", "description": "Automated system operations"}');
	await putUser(META_SYSTEM, 'meta-system@openauth.local', '{"type":"system"}');
	await putUser(PERSON, 'person@example.com', null);
	await putUser(ADMIN, 'sys-admin@example.com', null);
	await putUser(SUPER, 'sys-super@example.com', null);
	await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_sys_admin', 'Admin', 'default')`).run();
	await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_sys_super', 'Super Admin', 'default')`).run();
	await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_sys_member', 'Member', 'default')`).run();
	await grant(ADMIN, 'role_sys_admin');
	await grant(SUPER, 'role_sys_super');
});

beforeEach(() => {
	resetErrorReporter();
	auditSpy?.mockRestore();
	fetchSpy = vi.fn(async () => new Response(null, { status: 202 }));
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
	auditSpy = vi.spyOn(getAuditEmitter(), 'emit').mockResolvedValue(undefined);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	auditSpy?.mockRestore();
});

describe('who is a system account', () => {
	it('user_system by id, anyone else by metadata.type "system"', () => {
		expect(isSystemUser({ id: SYSTEM_USER_ID })).toBe(true);
		expect(isSystemUser({ id: META_SYSTEM, metadata: '{"type":"system"}' })).toBe(true);
		expect(isSystemUser({ id: PERSON, metadata: null })).toBe(false);
		expect(accountStateOf({ id: SYSTEM_USER_ID, status: 'active', deleted_at: null })).toBe('system');
		expect(accountStateOf({ id: META_SYSTEM, metadata: { type: 'system' }, status: 'active', deleted_at: null })).toBe('system');
		expect(isRefusedAccountState('system')).toBe(true);
	});

	it('reads it from D1; the user_system id is refused even without its row', async () => {
		expect(await readAccountState(E.AUTH_DB, SYSTEM_USER_ID)).toBe('system');
		expect(await readAccountState(E.AUTH_DB, META_SYSTEM)).toBe('system');
		expect(await readAccountState(E.AUTH_DB, PERSON)).toBe('active');
		const empty = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
		expect(await readAccountState(empty, SYSTEM_USER_ID)).toBe('system');
	});
});

describe('sign-in: every provider is refused, audited and flagged', () => {
	let subject: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		subject = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://app.example/cb?code=x' } }));
	});

	function onSuccess(user: { id: string; email: string; status?: string; metadata?: unknown } | null, url = 'https://auth.example/password/authorize') {
		const userService: UserServiceLike = {
			getUserByEmail: vi.fn(async () => user),
			createUser: vi.fn(async () => {
				throw new Error('must not create');
			}),
			updateLastLogin: vi.fn(async () => {}),
		};
		const rbac = { getUserRoles: vi.fn(async () => [{ name: 'Super Admin' }]) } as unknown as RBACServiceImpl;
		return {
			userService,
			handler: createOnSuccessHandler(userService, rbac, {
				request: new Request(url, { method: 'POST' }),
				env: REPORTING,
				ctx: createExecutionContext(),
				requestId: 'req-system',
				db: E.AUTH_DB,
				homeUrl: 'https://alummahnow.net/',
			}),
		};
	}

	// password: the password form, the email-code sign-in and the code flows of
	// register / forgot password all report as "password". session: silent single
	// sign-on. device: /activate. magic-link: any other provider goes through the same gate.
	for (const provider of ['password', 'code', 'session', 'device', 'magic-link']) {
		it(`provider "${provider}": the user_system account gets no tokens`, async () => {
			const { handler, userService } = onSuccess({ id: SYSTEM_USER_ID, email: SYSTEM_EMAIL, status: 'active', metadata: { type: 'system' } });
			const res = await handler(
				{ subject },
				{ provider, properties: { email: SYSTEM_EMAIL, id: SYSTEM_USER_ID }, tenantId: 'default', roles: [] },
				{ id: 'default' }
			);
			expect(res.status).toBe(403);
			expect(subject).not.toHaveBeenCalled();
			expect(userService.updateLastLogin).not.toHaveBeenCalled();
			expect(auditTypes()).toContain('security.system_account.sign_in_refused');
			expect(flaggedItems()).toEqual([
				expect.objectContaining({
					key: `auth-system-account:sign_in:${SYSTEM_USER_ID}`,
					title: 'Sign-in attempt on a system account',
					itemUrl: 'https://admin.auth.qa.alummahnow.net/users?view=system',
				}),
			]);
		});
	}

	it('a metadata.type "system" account is refused too, even when the user service gives a status', async () => {
		const { handler } = onSuccess({ id: META_SYSTEM, email: 'meta-system@openauth.local', status: 'active', metadata: { type: 'system' } });
		const res = await handler({ subject }, { provider: 'password', properties: { email: 'meta-system@openauth.local' }, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(403);
		expect(subject).not.toHaveBeenCalled();
		expect(flaggedItems().map((i) => i.key)).toEqual([`auth-system-account:sign_in:${META_SYSTEM}`]);
	});

	it('passkey: a credential that names user_system is refused, with or without the row', async () => {
		const { handler } = onSuccess(null);
		const res = await handler({ subject }, { provider: 'passkey', userID: SYSTEM_USER_ID, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(403);
		expect(subject).not.toHaveBeenCalled();
		expect(flaggedItems().map((i) => i.key)).toEqual([`auth-system-account:sign_in:${SYSTEM_USER_ID}`]);
	});

	it('passkey: a metadata.type "system" account is refused', async () => {
		const { handler } = onSuccess(null);
		const res = await handler({ subject }, { provider: 'passkey', userID: META_SYSTEM, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(403);
		expect(subject).not.toHaveBeenCalled();
	});

	it('a person still signs in', async () => {
		const { handler } = onSuccess({ id: PERSON, email: 'person@example.com', status: 'active' });
		const res = await handler({ subject }, { provider: 'password', properties: { email: 'person@example.com' }, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(302);
		expect(subject).toHaveBeenCalledOnce();
		expect(flaggedItems()).toEqual([]);
	});
});

describe('email codes: no code for a system account (sign-in code, password reset, registration)', () => {
	function sendCode(pathname: string) {
		const url = new URL(`https://auth.example.com${pathname}`);
		const userService: UserServiceLike = {
			getUserByEmail: vi.fn(async () => ({ id: SYSTEM_USER_ID, email: SYSTEM_EMAIL })),
			createUser: vi.fn(),
			updateLastLogin: vi.fn(),
		};
		return createSendCodeHandler(userService, {
			request: new Request(url, { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.77' } }),
			env: { AUTH_STORAGE: E.AUTH_STORAGE, AUTH_DB: E.AUTH_DB, RESEND_API_KEY: 'test-resend-key', ...REPORTING },
			ctx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
			requestId: 'req-code',
			url,
		});
	}

	for (const [what, path] of [
		['sign-in code', '/password/authorize'],
		['password reset', '/password/change'],
		['registration', '/password/register'],
	] as const) {
		it(`${what}: silent like an unknown email, no code recorded, no email sent, flagged`, async () => {
			await E.AUTH_DB.prepare('DELETE FROM password_codes').run();
			const result = await sendCode(path)(SYSTEM_EMAIL, '123456');
			expect(result).toBeUndefined();
			const codes = await E.AUTH_DB.prepare('SELECT COUNT(*) AS n FROM password_codes').first<{ n: number }>();
			expect(codes?.n).toBe(0);
			// The only request out is the Errors page item, never Resend
			expect(fetchSpy.mock.calls.every((c) => String(c[0]) === INGEST)).toBe(true);
			expect(flaggedItems().map((i) => i.key)).toEqual([`auth-system-account:sign_in:${SYSTEM_USER_ID}`]);
			expect(auditTypes()).toContain('security.system_account.sign_in_refused');
		});
	}
});

describe('token grants', () => {
	it('code grant: a code issued for user_system is refused by the issuer storage guard', async () => {
		await E.AUTH_DB.prepare('CREATE TABLE IF NOT EXISTS openauth_atomic (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)').run();
		const raw = authStorage(E);
		await Storage.atomic(raw).set(['oauth:code', 'c-system'], {
			properties: { id: SYSTEM_USER_ID, email: SYSTEM_EMAIL },
			clientID: 'web',
			authTime: Date.now(),
			ttl: { access: 900, refresh: 3600 },
		});
		expect(await Storage.atomic(guardIssuerStorage(raw, { db: E.AUTH_DB })).get(['oauth:code', 'c-system'])).toBeUndefined();
	});

	it('refresh: refused and the family revoked, for the id and for metadata.type; flagged', async () => {
		const hook = vi.fn();
		const users = { getUser: vi.fn(async (_t: string, id: string) => ({ status: 'active', deleted_at: null, metadata: id === META_SYSTEM ? { type: 'system' } : null })) };
		const check = createRefreshCheck(users, undefined, hook);
		expect(await check({ tenantId: 'default', userId: SYSTEM_USER_ID, clientID: 'web' })).toEqual({ revoke: true, reason: 'system_account' });
		expect(await check({ tenantId: 'default', userId: META_SYSTEM, clientID: 'web' })).toEqual({ revoke: true, reason: 'system_account' });
		expect(await check({ tenantId: 'default', userId: PERSON, clientID: 'web' })).toBeUndefined();
		expect(hook).toHaveBeenCalledWith(SYSTEM_USER_ID, 'web');
		expect(hook).toHaveBeenCalledWith(META_SYSTEM, 'web');
		expect(hook).toHaveBeenCalledTimes(2);
	});
});

describe('admin user and RBAC APIs', () => {
	const env = { ...E, ...REPORTING } as unknown as Env;
	function app() {
		const a = new Hono();
		a.use('*', systemAccountGuard({ users: true }));
		a.all('*', (c) => c.json({ reached: true }));
		return a;
	}
	const call = (method: string, path: string, body?: unknown) =>
		app().fetch(
			new Request(`https://auth.example${path}`, {
				method,
				headers: { 'Content-Type': 'application/json', 'X-Acting-User-Id': ADMIN },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			env,
			createExecutionContext()
		);

	it('a role grant to user_system is refused (403), audited and flagged', async () => {
		const res = await call('POST', `/${SYSTEM_USER_ID}/roles`, { roleId: 'role_sys_super' });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: 'system_account' });
		expect(auditTypes()).toEqual(['security.system_account.role_grant_refused']);
		expect(flaggedItems()).toEqual([
			expect.objectContaining({ key: `auth-system-account:role_grant:${SYSTEM_USER_ID}`, title: 'Role grant attempted on a system account' }),
		]);
	});

	it('the RBAC API path and a metadata.type "system" account are refused the same way', async () => {
		expect((await call('POST', `/users/${SYSTEM_USER_ID}/roles`, { roleId: 'role_sys_member' })).status).toBe(403);
		expect((await call('POST', `/${META_SYSTEM}/roles`, { roleId: 'role_sys_member' })).status).toBe(403);
		expect(flaggedItems().map((i) => i.key)).toEqual([
			`auth-system-account:role_grant:${SYSTEM_USER_ID}`,
			`auth-system-account:role_grant:${META_SYSTEM}`,
		]);
	});

	it('admin "set password" (forced reset), edits, suspension and deletion are refused; the row stays', async () => {
		for (const [method, path] of [
			['POST', `/${SYSTEM_USER_ID}/force-password-reset`],
			['PATCH', `/${SYSTEM_USER_ID}`],
			['POST', `/${SYSTEM_USER_ID}/suspend`],
			['DELETE', `/${SYSTEM_USER_ID}`],
			['DELETE', `/${SYSTEM_USER_ID}/sessions`],
		] as const) {
			const res = await call(method, path, method === 'DELETE' ? undefined : {});
			expect(res.status, `${method} ${path}`).toBe(403);
		}
		expect(auditTypes().every((t) => t === 'security.system_account.sign_in_refused')).toBe(true);
		expect(await E.AUTH_DB.prepare('SELECT id FROM users WHERE id = ?').bind(SYSTEM_USER_ID).first()).toEqual({ id: SYSTEM_USER_ID });
	});

	it('reading it by id answers 404, like an unknown user', async () => {
		expect((await call('GET', `/${SYSTEM_USER_ID}`)).status).toBe(404);
		expect((await call('GET', `/${SYSTEM_USER_ID}/roles`)).status).toBe(404);
	});

	it('metadata.type "system" is reserved on create and edit', async () => {
		expect((await call('POST', '/', { email: 'x@example.com', metadata: { type: 'system' } })).status).toBe(400);
		expect((await call('PATCH', `/${PERSON}`, { metadata: { type: 'system' } })).status).toBe(400);
		expect((await call('PATCH', `/${PERSON}`, { metadata: { type: 'person' } })).status).toBe(200);
		expect((await call('POST', `/${PERSON}/roles`, { roleId: 'role_sys_member' })).status).toBe(200);
	});
});

describe('D1: a system account can never hold a role (migrations/0041_system_accounts.sql)', () => {
	it('an insert for user_system or a metadata.type "system" account is aborted', async () => {
		await expect(grant(SYSTEM_USER_ID, 'role_sys_super')).rejects.toThrow(/system_account_role_refused/);
		await expect(grant(META_SYSTEM, 'role_sys_member')).rejects.toThrow(/system_account_role_refused/);
	});

	it('moving a role row onto one is aborted', async () => {
		await grant(PERSON, 'role_sys_member');
		await expect(
			E.AUTH_DB.prepare(`UPDATE rbac_user_roles SET user_id = ? WHERE user_id = ? AND role_id = 'role_sys_member'`).bind(SYSTEM_USER_ID, PERSON).run()
		).rejects.toThrow(/system_account_role_refused/);
	});

	it('user_system still labels automatic grants (assigned_by) for people', async () => {
		await E.AUTH_DB.prepare(
			`INSERT OR REPLACE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, 'role_sys_member', 'default', ?, 'user_system')`
		)
			.bind(ADMIN, Date.now())
			.run();
		const row = await E.AUTH_DB.prepare(`SELECT assigned_by FROM rbac_user_roles WHERE user_id = ? AND role_id = 'role_sys_member'`).bind(ADMIN).first();
		expect(row).toEqual({ assigned_by: 'user_system' });
	});

	it('no system account holds a role', async () => {
		const rows = await E.AUTH_DB.prepare(
			`SELECT ur.user_id FROM rbac_user_roles ur JOIN users u ON u.id = ur.user_id
			 WHERE ur.user_id = 'user_system' OR (json_valid(u.metadata) AND json_extract(u.metadata, '$.type') = 'system')`
		).all();
		expect(rows.results).toEqual([]);
	});
});

describe('impersonation: a system account never acts as an admin', () => {
	let privateKey: CryptoKey;
	let previousKey: string | null;
	const env = { ...E, ...REPORTING, OPENAUTH_ISSUER: ISSUER } as unknown as Env;

	beforeAll(async () => {
		const pair = await generateKeyPair('ES256', { extractable: true });
		privateKey = pair.privateKey as CryptoKey;
		previousKey = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.put(
			SIGNING_KEY_KV_KEY,
			JSON.stringify({ id: 'system-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() })
		);
		clearJWKSCache();
	});

	afterAll(async () => {
		if (previousKey) await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previousKey);
		else await E.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
		clearJWKSCache();
	});

	const token = () =>
		new SignJWT({ client_id: 'admin-client', scope: 'admin:*', mode: 'access' })
			.setProtectedHeader({ alg: 'ES256', kid: 'system-kid' })
			.setIssuer(ISSUER)
			.setSubject('admin-client')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);

	function adminApp(activeUserId?: string) {
		const a = new Hono();
		if (activeUserId) a.use('*', async (c, next) => { c.set('activeAccount' as never, { userId: activeUserId } as never); await next(); });
		a.use('*', requireAdmin());
		a.get('*', (c) => c.json({ reached: true }));
		return a;
	}

	it('M2M with X-Acting-User-Id: user_system is refused (403) and flagged', async () => {
		const res = await adminApp().fetch(
			new Request(`${ISSUER}/admin/users`, { headers: { Authorization: `Bearer ${await token()}`, 'X-Acting-User-Id': SYSTEM_USER_ID } }),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(403);
		expect(flaggedItems().map((i) => i.key)).toEqual([`auth-system-account:acting_admin:${SYSTEM_USER_ID}`]);
		expect(auditTypes()).toContain('security.system_account.sign_in_refused');
	});

	it('M2M acting as a metadata.type "system" account is refused', async () => {
		const res = await adminApp().fetch(
			new Request(`${ISSUER}/admin/users`, { headers: { Authorization: `Bearer ${await token()}`, 'X-Acting-User-Id': META_SYSTEM } }),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(403);
	});

	it('an admin session of user_system is refused', async () => {
		const res = await adminApp(SYSTEM_USER_ID).fetch(new Request(`${ISSUER}/admin/users`), env, createExecutionContext());
		expect(res.status).toBe(403);
		expect(flaggedItems().map((i) => i.key)).toEqual([`auth-system-account:acting_admin:${SYSTEM_USER_ID}`]);
	});

	it('a real admin still gets through', async () => {
		const res = await adminApp().fetch(
			new Request(`${ISSUER}/admin/users`, { headers: { Authorization: `Bearer ${await token()}`, 'X-Acting-User-Id': ADMIN } }),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(200);
	});
});

describe('admin user list: hidden from lists, search and counts; read-only view for super admins', () => {
	function list(query: string, roles: string[]) {
		const a = new Hono();
		a.use('*', async (c, next) => {
			c.set('tenantId' as never, 'default' as never);
			c.set('adminUser' as never, { userId: SUPER, email: 'sys-super@example.com', roles } as never);
			await next();
		});
		a.route('/', userListRoutes(E.AUTH_DB));
		return a.fetch(new Request(`https://auth.example/${query}`), E);
	}
	type ListBody = { users: Array<{ id: string; roles: unknown[]; can_sign_in?: boolean; status: string }>; total_count: number | null };

	it('the list, a search for it and the counts leave user_system out', async () => {
		const all = (await (await list('?limit=100', ['Admin'])).json()) as ListBody;
		expect(all.users.map((u) => u.id)).not.toContain(SYSTEM_USER_ID);
		const live = await E.AUTH_DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE tenant_id = 'default' AND deleted_at IS NULL AND id != 'user_system'`).first<{ n: number }>();
		expect(all.total_count).toBe(live?.n);
		for (const q of ['system', SYSTEM_USER_ID, 'openauth.local']) {
			const found = (await (await list(`?search=${encodeURIComponent(q)}`, ['Admin'])).json()) as ListBody;
			expect(found.users.map((u) => u.id)).not.toContain(SYSTEM_USER_ID);
		}
		const byEmail = (await (await list(`?email=${encodeURIComponent(SYSTEM_EMAIL)}`, ['Admin'])).json()) as ListBody;
		expect(byEmail.users.map((u) => u.id)).not.toContain(SYSTEM_USER_ID);
		expect(byEmail.total_count).toBe(byEmail.users.length);
	});

	it('hiding never hides a risk: an account marked system only by metadata stays visible (and still cannot sign in)', async () => {
		const found = (await (await list(`?search=${encodeURIComponent('meta-system@openauth.local')}`, ['Admin'])).json()) as ListBody;
		expect(found.users.map((u) => u.id)).toEqual([META_SYSTEM]);
		expect(found.total_count).toBe(1);
	});

	it('?system=only: super admins see it with status and roles, labelled as unable to sign in', async () => {
		const res = await list('?system=only', ['Super Admin']);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListBody;
		expect(body.users).toEqual([expect.objectContaining({ id: SYSTEM_USER_ID, status: 'active', roles: [], can_sign_in: false })]);
	});

	it('?system=only is refused for anyone but a super admin', async () => {
		expect((await list('?system=only', ['Admin'])).status).toBe(403);
	});
});

describe('the flag', () => {
	it('links the Errors page item to the Auth admin System accounts view (alummahnow.net only)', () => {
		expect(systemAccountsAdminUrl('https://auth.alummahnow.net')).toBe('https://admin.auth.alummahnow.net/users?view=system');
		expect(systemAccountsAdminUrl('https://auth.stage.alummahnow.net')).toBe('https://admin.auth.stage.alummahnow.net/users?view=system');
		expect(systemAccountsAdminUrl('http://localhost:3301')).toBeUndefined();
	});

	it('one item per account and kind of attempt; repeats within 10 s are counted into the next report', async () => {
		const ctx = createExecutionContext();
		flagSystemAccountAttempt(REPORTING, ctx, { userId: SYSTEM_USER_ID, attempt: 'sign_in', detail: 'password' });
		flagSystemAccountAttempt(REPORTING, ctx, { userId: SYSTEM_USER_ID, attempt: 'sign_in', detail: 'password' });
		flagSystemAccountAttempt(REPORTING, ctx, { userId: SYSTEM_USER_ID, attempt: 'role_grant', detail: 'role_admin' });
		await waitOnExecutionContext(ctx);
		const items = flaggedItems();
		expect(items.map((i) => i.key)).toEqual([`auth-system-account:sign_in:${SYSTEM_USER_ID}`, `auth-system-account:role_grant:${SYSTEM_USER_ID}`]);
		// Every attempt is audited, even when the item is not re-sent
		expect(auditTypes()).toHaveLength(3);
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(new Headers(init.headers).get('X-API-Key')).toBe('test-internal-key');
		const event = (JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> }).events[0];
		expect(event).toMatchObject({ app: 'auth', kind: 'action', action: { source: 'ops', itemType: 'system-account', itemId: SYSTEM_USER_ID } });
		expect(event).not.toHaveProperty('action.retry');
	});
});
