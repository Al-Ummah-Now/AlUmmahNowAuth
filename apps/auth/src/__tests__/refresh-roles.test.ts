/**
 * Refreshed access tokens carry the user's CURRENT roles (real worker).
 *
 * Before: the refresh grant re-signed the roles stored at sign-in, so a role
 * granted afterwards never reached refreshed tokens and a revoked Admin or
 * Super Admin stayed for the refresh token's whole life (1 year).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { createRefreshCheck } from '../handlers/refresh-check';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'refresh-roles@example.com';
const PASSWORD = 'Refresh-Roles-123!';
const E = env as unknown as Env;

class Browser {
	jar = new Map<string, string>();
	async fetch(path: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set('host', new URL(ISSUER).host);
		headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(new URL(path, ISSUER), { ...init, headers, redirect: 'manual' }), E, ctx);
		await waitOnExecutionContext(ctx);
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			const i = pair.indexOf('=');
			const value = pair.slice(i + 1);
			if (!value || /max-age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
			else this.jar.set(pair.slice(0, i), value);
		}
		return res;
	}
	async token(form: Record<string, string>) {
		const res = await this.fetch('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form).toString(),
		});
		return { status: res.status, body: (await res.json()) as any };
	}
	/** Password sign-in to profile (PKCE) and the code exchange. */
	async signIn() {
		const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
		const challenge = btoa(String.fromCharCode(...digest))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const start = await this.fetch(
			`/authorize?client_id=${PROFILE.id}&response_type=code&provider=password&state=s&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&code_challenge=${challenge}&code_challenge_method=S256`
		);
		const login = start.headers.get('location')!;
		expect(login).toContain('/password/authorize');
		const res = await this.fetch(login, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
		});
		expect(res.status).toBe(302);
		const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
		const exchanged = await this.token({
			grant_type: 'authorization_code',
			code,
			redirect_uri: PROFILE.redirect,
			client_id: PROFILE.id,
			code_verifier: verifier,
		});
		expect(exchanged.status).toBe(200);
		return exchanged.body as { access_token: string; refresh_token: string };
	}
	refresh(refreshToken: string) {
		return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: PROFILE.id });
	}
}

const roles = (accessToken: string) => (decodeJwt(accessToken) as any).properties.roles as string[];

async function userId() {
	const row = await E.AUTH_DB.prepare('SELECT id FROM users WHERE email = ?').bind(EMAIL).first<{ id: string }>();
	return row!.id;
}

async function grant(user: string, roleId: string, tenantId = 'default') {
	await E.AUTH_DB.prepare(
		`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?, 'test')`
	)
		.bind(user, roleId, tenantId, Date.now())
		.run();
}

async function revoke(user: string, roleId: string) {
	await E.AUTH_DB.prepare('DELETE FROM rbac_user_roles WHERE user_id = ? AND role_id = ?').bind(user, roleId).run();
}

describe('refresh recomputes roles (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const now = Date.now();
		for (const [id, name, tenant] of [
			['role_member', 'Member', 'default'],
			['role_admin', 'Admin', 'default'],
			['role_super_admin', 'Super Admin', 'default'],
		]) {
			await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
				.bind(id, name, tenant, now, now)
				.run();
		}
		await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES ('other', 'Other', 'active', ?, ?)`)
			.bind(now, now)
			.run()
			.catch(() => undefined);
		await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES ('role_other_admin', 'Other Admin', 'other', ?, ?)`)
			.bind(now, now)
			.run();
		const storage = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
		await Storage.set(storage, ['email', EMAIL, 'password'], await ScryptHasher().hash(PASSWORD));
	});

	it('a role granted after sign-in arrives on the next refresh; a revoked one goes', async () => {
		const browser = new Browser();
		const first = await browser.signIn();
		const id = await userId();
		expect(roles(first.access_token)).toEqual(['Member']);

		await grant(id, 'role_super_admin');
		const granted = await browser.refresh(first.refresh_token);
		expect(granted.status).toBe(200);
		expect([...roles(granted.body.access_token)].sort()).toEqual(['Member', 'Super Admin']);
		expect((decodeJwt(granted.body.access_token) as any).properties.tenantId).toBe('default');

		// The browser's account session shows the current roles too
		const account = await E.AUTH_DB.prepare('SELECT subject_properties FROM account_sessions WHERE user_id = ? ORDER BY authenticated_at DESC LIMIT 1')
			.bind(id)
			.first<{ subject_properties: string }>();
		expect([...JSON.parse(account!.subject_properties).roles].sort()).toEqual(['Member', 'Super Admin']);

		await revoke(id, 'role_super_admin');
		const revoked = await browser.refresh(granted.body.refresh_token);
		expect(revoked.status).toBe(200);
		expect(roles(revoked.body.access_token)).toEqual(['Member']);
	});

	it("another tenant's roles never reach this tenant's token", async () => {
		const browser = new Browser();
		const first = await browser.signIn();
		const id = await userId();
		await grant(id, 'role_other_admin', 'other');
		const res = await browser.refresh(first.refresh_token);
		expect(res.status).toBe(200);
		expect(roles(res.body.access_token)).toEqual(['Member']);
		await revoke(id, 'role_other_admin');
	});

	it('a suspended user is refused (invalid_grant), and stays refused after reinstatement', async () => {
		const browser = new Browser();
		const first = await browser.signIn();
		const id = await userId();
		await E.AUTH_DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(id).run();
		try {
			const res = await browser.refresh(first.refresh_token);
			expect(res.status).toBe(400);
			expect(res.body.error).toBe('invalid_grant');
			expect(res.body.access_token).toBeUndefined();
		} finally {
			await E.AUTH_DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(id).run();
		}
		expect((await browser.refresh(first.refresh_token)).status).toBe(400);
	});
});

describe('createRefreshCheck', () => {
	const check = (user: { status: string; deleted_at: number | null } | null | Error) =>
		createRefreshCheck({
			getUser: async () => {
				if (user instanceof Error) throw user;
				return user;
			},
		})({ tenantId: 'default', userId: 'usr_1', clientID: 'web' });

	it('lets an active user refresh', async () => {
		expect(await check({ status: 'active', deleted_at: null })).toBeUndefined();
	});

	it('refuses a suspended, deleted or missing user', async () => {
		expect(await check({ status: 'suspended', deleted_at: null })).toEqual({ revoke: true, reason: 'user_suspended' });
		expect(await check({ status: 'deleted', deleted_at: 1 })).toEqual({ revoke: true, reason: 'user_deleted' });
		expect(await check({ status: 'active', deleted_at: 1 })).toEqual({ revoke: true, reason: 'user_deleted' });
		expect(await check(null)).toEqual({ revoke: true, reason: 'user_deleted' });
	});

	it('a failed lookup propagates (the issuer answers a retryable 503, never stale roles)', async () => {
		await expect(check(new Error('D1 unavailable'))).rejects.toThrow('D1 unavailable');
	});

	it('a subject without a user id is not checked', async () => {
		const res = await createRefreshCheck({
			getUser: async () => {
				throw new Error('not called');
			},
		})({ tenantId: 'default', clientID: 'm2m' });
		expect(res).toBeUndefined();
	});
});
