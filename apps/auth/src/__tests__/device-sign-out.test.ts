/**
 * Signing out ONE device or install (real worker, openauth sid/install_id):
 *
 * - AlUmmahNow#442 / #277: every browser sign-in's tokens carry `sid`; ending that
 *   browser's account session (admin "terminate session") refuses its refresh token
 *   and lists `s:<sid>` for the resource servers, while the user's other browser
 *   keeps working and a fresh sign-in in the same browser works again.
 * - #363: POST /internal/token-revocations (tokens:revoke clients) ends one native
 *   install's refresh tokens (or a user's at one client); a native Admin app's
 *   refresh is refused once the user holds no staff role.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { hashClientSecret } from '@al-ummah-now/openauth';
import { sessionTokenId } from '@al-ummah-now/openauth/session/token-id';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import worker from '../index';
import { setupDatabase, sqlStatements } from '../test-setup';
import { PROFILE, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { endOneSession } from '../revocation/lifecycle';
import { parseRevocationTarget } from '../revocation/install-routes';
import migration0022 from '../../migrations/0022_moderation_requests.sql?raw';
import migration0042 from '../../migrations/0042_scoped_revocations.sql?raw';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'device-signout@example.com';
const PASSWORD = 'Device-Signout-123!';
const E = env as unknown as Env;
/** The QA "Admin (iOS)" app: public native PKCE client (migrations-qa/0036). */
const ADMIN_APP = { id: '77330b47-5747-4058-ba00-921e159f1ced', redirect: 'alummahnow-admin://auth/callback' };
/** The videos admin's M2M client (0022), given tokens:revoke by 0042. */
const VIDEOS = { id: 'd7464de8-363d-4fc1-b1af-7c71653f0afc', secret: 'videos-admin-test-secret' };
const NO_SCOPE = { id: 'no-revoke-scope', secret: 'no-scope-secret' };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
	/** Password sign-in (PKCE) at `client` and the code exchange (`extra` goes to /token). */
	async signIn(client = PROFILE, extra: Record<string, string> = {}) {
		const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
		const start = await this.fetch(
			`/authorize?client_id=${client.id}&response_type=code&provider=password&state=s&redirect_uri=${encodeURIComponent(client.redirect)}&code_challenge=${challenge}&code_challenge_method=S256`
		);
		let location = start.headers.get('location')!;
		if (!location.startsWith(client.redirect)) {
			expect(location).toContain('/password/authorize');
			const res = await this.fetch(location, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
			});
			expect(res.status).toBe(302);
			location = res.headers.get('location')!;
		}
		const code = new URL(location).searchParams.get('code')!;
		const exchanged = await this.token({ grant_type: 'authorization_code', code, redirect_uri: client.redirect, client_id: client.id, code_verifier: verifier, ...extra });
		expect(exchanged.status).toBe(200);
		return exchanged.body as { access_token: string; refresh_token: string };
	}
	refresh(refreshToken: string, client = PROFILE) {
		return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.id });
	}
}

async function userId() {
	return (await E.AUTH_DB.prepare('SELECT id FROM users WHERE email = ?').bind(EMAIL).first<{ id: string }>())!.id;
}

/** The account session of `user` in the browser whose access token is `accessToken`. */
async function accountSessionOf(user: string, accessToken: string) {
	const sid = (decodeJwt(accessToken) as { sid?: string }).sid;
	const { results } = await E.AUTH_DB.prepare('SELECT id, browser_session_id FROM account_sessions WHERE user_id = ?')
		.bind(user)
		.all<{ id: string; browser_session_id: string }>();
	for (const row of results ?? []) if ((await sessionTokenId(row.browser_session_id, user)) === sid) return row;
	return undefined;
}

const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;
async function revokeCall(body: unknown, auth = basic(VIDEOS.id, VIDEOS.secret)) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`${ISSUER}/internal/token-revocations`, {
			method: 'POST',
			headers: { host: new URL(ISSUER).host, 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
			body: JSON.stringify(body),
		}),
		E,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

beforeAll(async () => {
	await setupDatabase();
	await registerTestClients();
	const db = E.AUTH_DB;
	const now = Date.now();
	await db
		.prepare(
			`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
			 VALUES (?, 'default', 'Admin (iOS)', NULL, '["authorization_code","refresh_token"]', '[]', ?, '{"type":"native","pkce":"required"}', 1, ?, ?)`
		)
		.bind(ADMIN_APP.id, JSON.stringify([ADMIN_APP.redirect]), now, now)
		.run();
	for (const [id, name] of [
		['role_member', 'Member'],
		['role_admin', 'Admin'],
	]) {
		await db.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES (?, ?, 'default', ?, ?)`).bind(id, name, now, now).run();
	}
	// The migrations under test: the videos admin M2M client, then its tokens:revoke scope (twice: idempotent)
	for (const stmt of [...sqlStatements(migration0022), ...sqlStatements(migration0042), ...sqlStatements(migration0042)]) await db.prepare(stmt).run();
	await db.prepare('UPDATE oauth_clients SET client_secret_hash = ? WHERE id = ?').bind(await hashClientSecret(VIDEOS.secret), VIDEOS.id).run();
	await db
		.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, scopes, created_at, updated_at) VALUES (?, 'default', ?, ?, '["moderation:request"]', ?, ?)`)
		.bind(NO_SCOPE.id, NO_SCOPE.id, await hashClientSecret(NO_SCOPE.secret), now, now)
		.run();
	await Storage.set(CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE }), ['email', EMAIL, 'password'], await ScryptHasher().hash(PASSWORD));
});

describe('one browser signed out (#442, #277)', () => {
	it('access tokens carry the sid of their browser sign-in', async () => {
		const browser = new Browser();
		const tokens = await browser.signIn();
		const user = await userId();
		const row = await accountSessionOf(user, tokens.access_token);
		expect(row).toBeDefined();
		const refreshed = await browser.refresh(tokens.refresh_token);
		expect(refreshed.status).toBe(200);
		expect((decodeJwt(refreshed.body.access_token) as { sid?: string }).sid).toBe((decodeJwt(tokens.access_token) as { sid?: string }).sid);
	});

	it("ending one browser's session refuses its refresh token, not the other browser's", async () => {
		const laptop = new Browser();
		const phone = new Browser();
		const a = await laptop.signIn();
		const b = await phone.signIn();
		const user = await userId();
		const row = (await accountSessionOf(user, a.access_token))!;

		const result = await endOneSession(E.AUTH_DB, E.TOKEN_REVOCATIONS, user, row.id, 'admin_session_terminated');
		expect(result.ended).toBe(true);

		const refused = await laptop.refresh(a.refresh_token);
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('invalid_grant');
		expect((await phone.refresh(b.refresh_token)).status).toBe(200);

		// Gone from the browser, listed for the resource servers
		expect(await E.AUTH_DB.prepare('SELECT id FROM account_sessions WHERE id = ?').bind(row.id).first()).toBeNull();
		const sid = (decodeJwt(a.access_token) as { sid: string }).sid;
		const listed = await E.TOKEN_REVOCATIONS.get<{ before: number }>(`s:${sid}`, 'json');
		expect(listed?.before).toBeGreaterThan(0);

		// Signing in again on the laptop works
		await new Promise((r) => setTimeout(r, 1100));
		const again = await laptop.signIn();
		expect((await laptop.refresh(again.refresh_token)).status).toBe(200);
	});

	it("is a 'not found' for a session that is not the user's", async () => {
		expect((await endOneSession(E.AUTH_DB, E.TOKEN_REVOCATIONS, 'usr_nobody', 'as_missing', 'admin_session_terminated')).ended).toBe(false);
	});
});

describe('one native install signed out (#363)', () => {
	it('0042 gives the videos admin client tokens:revoke once', async () => {
		const row = await E.AUTH_DB.prepare('SELECT scopes FROM oauth_clients WHERE id = ?').bind(VIDEOS.id).first<{ scopes: string }>();
		expect(JSON.parse(row!.scopes)).toEqual(['moderation:request', 'tokens:revoke']);
	});

	it('revokes that install only; another install and the web keep working', async () => {
		const user = await userId();
		await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, 'role_admin', 'default', ?, 'test')`)
			.bind(user, Date.now())
			.run();
		const lost = new Browser();
		const kept = new Browser();
		const web = new Browser();
		const lostTokens = await lost.signIn(ADMIN_APP, { install_id: 'ins_lost' });
		const keptTokens = await kept.signIn(ADMIN_APP, { install_id: 'ins_kept' });
		const webTokens = await web.signIn();

		expect((await revokeCall({ user_id: user, install_id: 'ins_lost' })).status).toBe(204);

		expect((await lost.refresh(lostTokens.refresh_token, ADMIN_APP)).status).toBe(400);
		expect((await kept.refresh(keptTokens.refresh_token, ADMIN_APP)).status).toBe(200);
		expect((await web.refresh(webTokens.refresh_token)).status).toBe(200);
	});

	it("client_id revokes the user's refresh tokens at that client only", async () => {
		const user = await userId();
		const app = new Browser();
		const web = new Browser();
		const appTokens = await app.signIn(ADMIN_APP, { install_id: 'ins_c' });
		const webTokens = await web.signIn();
		expect((await revokeCall({ user_id: user, client_id: ADMIN_APP.id })).status).toBe(204);
		expect((await app.refresh(appTokens.refresh_token, ADMIN_APP)).status).toBe(400);
		expect((await web.refresh(webTokens.refresh_token)).status).toBe(200);
	});

	it('needs client authentication and the tokens:revoke scope', async () => {
		const body = { user_id: 'usr_x', install_id: 'ins_x' };
		expect((await revokeCall(body, '')).status).toBe(401);
		expect((await revokeCall(body, basic(VIDEOS.id, 'wrong'))).status).toBe(401);
		expect((await revokeCall(body, basic(NO_SCOPE.id, NO_SCOPE.secret))).status).toBe(403);
		expect((await revokeCall({ user_id: 'usr_x' })).status).toBe(400);
	});

	it('parseRevocationTarget', () => {
		expect(parseRevocationTarget({ user_id: 'u', install_id: 'i' })).toEqual({ userId: 'u', installId: 'i' });
		expect(parseRevocationTarget({ user_id: 'u', client_id: 'c' })).toEqual({ userId: 'u', clientId: 'c' });
		for (const bad of [null, {}, { user_id: 'u' }, { user_id: 'u', install_id: 'i', client_id: 'c' }, { user_id: 'u', install_id: 'a b' }, { user_id: '', install_id: 'i' }]) {
			expect(typeof parseRevocationTarget(bad)).toBe('string');
		}
	});

	it("losing the staff role ends the Admin app's refreshes, not the web's", async () => {
		const user = await userId();
		await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, 'role_admin', 'default', ?, 'test')`)
			.bind(user, Date.now())
			.run();
		const app = new Browser();
		const web = new Browser();
		const appTokens = await app.signIn(ADMIN_APP, { install_id: 'ins_staff' });
		const webTokens = await web.signIn();
		await E.AUTH_DB.prepare(`DELETE FROM rbac_user_roles WHERE user_id = ? AND role_id = 'role_admin'`).bind(user).run();
		const refused = await app.refresh(appTokens.refresh_token, ADMIN_APP);
		expect(refused.status).toBe(400);
		expect((await web.refresh(webTokens.refresh_token)).status).toBe(200);
	});
});
