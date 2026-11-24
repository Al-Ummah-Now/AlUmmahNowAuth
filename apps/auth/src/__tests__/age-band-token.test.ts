/**
 * E20-P2 (wiki E20 §5.1), through the real worker: `age_band` is on the access tokens of our own apps, at sign-in
 * and at each refresh, only while `birth_date` is on. Nowhere else: no other client, no machine, no /userinfo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { hashClientSecret } from '@al-ummah-now/openauth';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { readBirthDate, writeBirthDate, type BirthDateEnv } from '../birth-date/store';
import { writeBirthDateSetting } from '../birth-date/setting';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { PROFILE, registerTestClients } from './helpers/clients';

const ISSUER = 'http://localhost:3301';
const EMAIL = 'age-band@example.com';
const PASSWORD = 'Age-Band-123!';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const SECRET = 'age-band-machine-secret';
const E = env as unknown as Env;
/** Videos web: one of AGE_BAND_CLIENTS. */
const VIDEOS = { id: 'f0de3c30-0304-4ac4-86d6-1e185dec0439', redirect: 'http://localhost:3000/callback' };

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
			this.jar.set(pair.slice(0, i), pair.slice(i + 1));
		}
		return res;
	}
	async token(form: Record<string, string>) {
		const res = await this.fetch('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
		return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token: string } };
	}
	async signIn(client: { id: string; redirect: string }) {
		const url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const verifier = url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
		const start = await this.fetch(`/authorize?client_id=${client.id}&response_type=code&provider=password&state=s&redirect_uri=${encodeURIComponent(client.redirect)}&code_challenge=${challenge}&code_challenge_method=S256`);
		const res = await this.fetch(start.headers.get('location')!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString() });
		expect(res.status).toBe(302);
		const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
		const out = await this.token({ grant_type: 'authorization_code', code, redirect_uri: client.redirect, client_id: client.id, code_verifier: verifier });
		expect(out.status).toBe(200);
		return out.body;
	}
	async refresh(client: { id: string }, refresh_token: string) {
		const out = await this.token({ grant_type: 'refresh_token', refresh_token, client_id: client.id });
		expect(out.status).toBe(200);
		return out.body;
	}
}

/** The document the Videos admin's check reads. */
const supported = async () => (await (await new Browser().fetch('/.well-known/openid-configuration')).json<{ claims_supported: string[] }>()).claims_supported;
const claims = (token: string) => decodeJwt(token) as Record<string, any>;
const setOn = (on: boolean) => writeBirthDateSetting(E.AUTH_DB, on, 'test');
const setDate = async (date: string | null) => {
	const user = (await E.AUTH_DB.prepare('SELECT id FROM users WHERE email = ?').bind(EMAIL).first<{ id: string }>())!.id;
	if (date === null) await E.AUTH_DB.prepare('DELETE FROM user_birth_dates WHERE user_id = ?').bind(user).run();
	else expect(await writeBirthDate(E as unknown as BirthDateEnv, user, date, await readBirthDate(E as unknown as BirthDateEnv, user))).toBe(true);
};
/** Clearly inside each band whatever today's date is. */
const born = (years: number) => `${new Date().getUTCFullYear() - years}-01-01`;

describe('age_band on tokens (worker)', () => {
	const savedKey = E.PROFILE_DATA_KEY;
	const refresh: Record<string, string> = {};
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const now = Date.now();
		await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES ('role_member', 'Member', 'default', ?, ?)`).bind(now, now).run();
		for (const [id, secret, grants, redirects] of [
			[VIDEOS.id, 'test-hash', '["authorization_code","refresh_token"]', JSON.stringify([VIDEOS.redirect])],
			['age-band-machine', await hashClientSecret(SECRET), '["client_credentials"]', '[]'],
		])
			await E.AUTH_DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, '[]', ?, '{}', 1, ?, ?)`).bind(id, id, secret, grants, redirects, now, now).run();
		await Storage.set(CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE }), ['email', EMAIL, 'password'], await ScryptHasher().hash(PASSWORD));
	});
	beforeEach(() => {
		E.PROFILE_DATA_KEY = KEY;
	});
	afterAll(async () => {
		await setOn(false);
		E.PROFILE_DATA_KEY = savedKey;
	});

	it('off: no claim at sign-in or refresh, and discovery does not list it', async () => {
		await setOn(false);
		const first = await new Browser().signIn(VIDEOS);
		expect(claims(first.access_token)).not.toHaveProperty('age_band');
		await setDate(born(30));
		const next = await new Browser().refresh(VIDEOS, first.refresh_token);
		expect(claims(next.access_token)).not.toHaveProperty('age_band');
		refresh.videos = next.refresh_token;
		expect(await supported()).not.toContain('age_band');
	});

	it('on: at sign-in and at each refresh, following the date; a top-level claim, never in properties', async () => {
		await setOn(true);
		const first = claims((await new Browser().signIn(VIDEOS)).access_token);
		expect(first.age_band).toBe('18_plus');
		expect(JSON.stringify(first.properties)).not.toMatch(/age_band|birth/i);
		expect(JSON.stringify(first)).not.toContain(born(30));

		// The sign-in from while the setting was off gets it at its next refresh, with the same subject
		let token = refresh.videos;
		const bands: unknown[] = [];
		for (const years of [30, 17, 14, 11, null]) {
			await setDate(years === null ? null : born(years));
			const out = await new Browser().refresh(VIDEOS, token);
			token = out.refresh_token;
			const c = claims(out.access_token);
			bands.push(c.age_band);
			expect(c.sub).toBe(first.sub);
		}
		expect(bands).toEqual(['18_plus', '16_17', '13_15', undefined, undefined]);

		await setDate(born(30));
		await setOn(false);
		expect(claims((await new Browser().refresh(VIDEOS, token)).access_token)).not.toHaveProperty('age_band');
	});

	it('never for another client, a machine or /userinfo', async () => {
		await setOn(true);
		await setDate(born(30));
		const profile = await new Browser().signIn(PROFILE);
		expect(claims(profile.access_token)).not.toHaveProperty('age_band');
		expect(claims((await new Browser().refresh(PROFILE, profile.refresh_token)).access_token)).not.toHaveProperty('age_band');

		const machine = await new Browser().token({ grant_type: 'client_credentials', client_id: 'age-band-machine', client_secret: SECRET });
		expect(machine.status).toBe(200);
		expect(claims(machine.body.access_token)).not.toHaveProperty('age_band');

		const videos = await new Browser().signIn(VIDEOS);
		expect(claims(videos.access_token).age_band).toBe('18_plus');
		const info = await new Browser().fetch('/userinfo', { headers: { authorization: `Bearer ${videos.access_token}` } });
		expect(info.status).toBe(200);
		expect(await info.text()).not.toMatch(/age_band|birth/i);
	});

	it('discovery lists it while on', async () => {
		await setOn(true);
		expect(await supported()).toContain('age_band');
	});

	it('a key that cannot be read stops no sign-in', async () => {
		await setOn(true);
		E.PROFILE_DATA_KEY = undefined;
		expect(claims((await new Browser().signIn(VIDEOS)).access_token)).not.toHaveProperty('age_band');
	});
});
