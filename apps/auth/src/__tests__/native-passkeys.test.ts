/**
 * Native passkey sign-in and registration through the real worker (wiki
 * AUTH-PASSKEYS "Native apps"): /native/passkey/options + /verify give a code
 * that /token exchanges with PKCE on the client's native redirect; the Bearer
 * registration routes add a passkey. A software ES256 authenticator stands in
 * for the platform passkey API.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { authStorage } from '../storage/auth-storage';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { nativeChallengeKey } from '@al-ummah-now/openauth/native-passkey';
import {
	androidOrigins,
	apkKeyHash,
	handleNativeRegisterOptions,
	nativeOrigins,
	nativeRedirect,
	nativeRegistrationKey,
	NATIVE_PASSKEY_CLIENT_IDS,
} from '../passkeys/native';
import qaNativeClients from '../../migrations-qa/0013_native_clients.sql?raw';
import qaAdminClients from '../../migrations-qa/0036_admin_native_clients.sql?raw';

const ISSUER = 'http://localhost:3301';
const PASSWORD = 'Native-Passkeys-123!';
const E = env as unknown as Env & Record<string, unknown>;
const STUDIO = { id: '45364a42-21f4-4359-a76c-0a1e6615fd7b', redirect: 'alummahnow-studio://auth/callback' };
const ADMIN_IOS = { id: '77330b47-5747-4058-ba00-921e159f1ced', redirect: 'alummahnow-admin://auth/callback' };
const VIEWER = '31389afb-d4f8-4c26-9492-4c77f4d07e65';
const FINGERPRINT = '5A:1B:3D:2B:57:6E:9A:2D:F0:BF:1B:E3:F1:8C:40:20:13:F9:5C:09:EA:EE:7C:F7:31:10:C4:2F:B5:69:DD:C0';
const APK_ORIGIN = 'android:apk-key-hash:Whs9K1dumi3wvxvj8YxAIBP5XAnq7nz3MRDEL7Vp3cA';

// ---------- software authenticator ----------
function cborHead(major: number, n: number): number[] {
	if (n < 24) return [(major << 5) | n];
	if (n < 256) return [(major << 5) | 24, n];
	return [(major << 5) | 25, n >> 8, n & 255];
}
function cbor(v: unknown): number[] {
	if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
	if (typeof v === 'string') {
		const b = [...new TextEncoder().encode(v)];
		return [...cborHead(3, b.length), ...b];
	}
	if (v instanceof Uint8Array) return [...cborHead(2, v.length), ...v];
	if (v instanceof Map) {
		const out = cborHead(5, v.size);
		for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
		return out;
	}
	throw new Error('cbor: unsupported');
}
const b64url = (b: Uint8Array | ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
function der(raw: Uint8Array) {
	const int = (x: Uint8Array) => {
		let i = 0;
		while (i < x.length - 1 && x[i] === 0) i++;
		let v = [...x.slice(i)];
		if (v[0] & 0x80) v = [0, ...v];
		return [0x02, v.length, ...v];
	};
	const r = int(raw.slice(0, 32));
	const s = int(raw.slice(32));
	return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

class SoftAuthenticator {
	id = crypto.getRandomValues(new Uint8Array(16));
	counter = 0;
	keys!: CryptoKeyPair;
	async init() {
		this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
		return this;
	}
	get credentialId() {
		return b64url(this.id);
	}
	async cose() {
		const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
		return new Uint8Array(cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]])));
	}
	async create(options: any, origin = ISSUER) {
		const rpHash = await sha256(new TextEncoder().encode(options.rp.id));
		const authData = new Uint8Array([...rpHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, this.id.length, ...this.id, ...(await this.cose())]);
		const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
		const attestationObject = new Uint8Array(cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])));
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: 'public-key',
			clientExtensionResults: {},
			response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
		};
	}
	async get(options: any, origin = ISSUER, userHandle?: string) {
		this.counter++;
		const rpHash = await sha256(new TextEncoder().encode(options.rpId));
		const authData = new Uint8Array(37);
		authData.set(rpHash);
		authData[32] = 0x05;
		new DataView(authData.buffer).setUint32(33, this.counter);
		const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
		const signed = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
		const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: 'public-key',
			clientExtensionResults: {},
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authData),
				signature: b64url(der(raw)),
				...(userHandle ? { userHandle: b64url(new TextEncoder().encode(userHandle)) } : {}),
			},
		};
	}
}

// ---------- the native app against the worker ----------
async function call(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set('host', new URL(ISSUER).host);
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(new URL(path, ISSUER), { ...init, headers, redirect: 'manual' }), E as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

class NativeApp {
	verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	constructor(public client = STUDIO) {}
	async options() {
		const challenge = b64url(await sha256(new TextEncoder().encode(this.verifier)));
		const res = await post('/native/passkey/options', { client_id: this.client.id, code_challenge: challenge, code_challenge_method: 'S256' });
		expect(res.status).toBe(200);
		return (await res.json()) as { challenge_id: string; publicKey: any };
	}
	verify(challenge_id: string, credential: unknown, clientId = this.client.id) {
		return post('/native/passkey/verify', { challenge_id, client_id: clientId, credential });
	}
	async token(code: string) {
		return call('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.client.id, code_verifier: this.verifier, redirect_uri: this.client.redirect }).toString(),
		});
	}
	/** Passkey sign-in end to end; returns the tokens. */
	async signIn(a: SoftAuthenticator, origin = ISSUER) {
		const { challenge_id, publicKey } = await this.options();
		const res = await this.verify(challenge_id, await a.get(publicKey, origin));
		expect(res.status).toBe(200);
		const { code } = (await res.json()) as { code: string };
		const token = await this.token(code);
		expect(token.status).toBe(200);
		return (await token.json()) as { access_token: string; refresh_token: string };
	}
}

const unique = () => crypto.randomUUID().slice(0, 8);
const statements = (sql: string) =>
	sql
		.split('\n')
		.filter((l) => !l.startsWith('--'))
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);

/** A user in D1 (created by a password sign-in through the worker) with one passkey. */
async function userWithPasskey(): Promise<{ email: string; userId: string; a: SoftAuthenticator }> {
	const email = `native-pk-${unique()}@example.com`;
	await Storage.set(CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE }), ['email', email, 'password'], await ScryptHasher().hash(PASSWORD));
	const userId = crypto.randomUUID();
	const now = Date.now();
	await E.AUTH_DB.prepare(`INSERT INTO users (id, email, tenant_id, status, created_at, updated_at) VALUES (?1, ?2, 'default', 'active', ?3, ?3)`)
		.bind(userId, email, now)
		.run();
	const a = await new SoftAuthenticator().init();
	await E.AUTH_DB.prepare(
		`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at) VALUES (?1, ?2, ?3, 0, '["internal"]', 'multiDevice', 1, NULL, 'Passkey', ?4)`
	)
		.bind(a.credentialId, userId, b64url(await a.cose()), now)
		.run();
	return { email, userId, a };
}
/** The browser flow ("Sign in another way") for a native client: /authorize, password, code, /token. */
async function passwordSignIn(app: NativeApp, email: string) {
	const challenge = b64url(await sha256(new TextEncoder().encode(app.verifier)));
	const start = await call(
		`/authorize?client_id=${app.client.id}&response_type=code&state=s&redirect_uri=${encodeURIComponent(app.client.redirect)}&code_challenge=${challenge}&code_challenge_method=S256&prompt=login`
	);
	const login = start.headers.get('location')!;
	expect(login).toContain('/password/authorize');
	const jar = start.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
	const page = await call(login, { headers: { cookie: jar } });
	const jar2 = [jar, ...page.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
	const res = await call(login, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar2 },
		body: new URLSearchParams({ email, password: PASSWORD }).toString(),
	});
	let location = res.headers.get('location');
	if (!location) {
		const m = (await res.text()).match(/"continueUrl":"([^"]+)"/);
		expect(m).toBeTruthy();
		location = JSON.parse(`"${m![1]}"`) as string;
	}
	const code = new URL(location).searchParams.get('code')!;
	expect(code).toBeTruthy();
	const token = await app.token(code);
	expect(token.status).toBe(200);
	return (await token.json()) as { access_token: string };
}
async function expectRefused(res: Response) {
	expect(res.status).toBe(401);
	expect(await res.json()).toEqual({ error: 'invalid_credential', error_description: 'The passkey was not accepted.' });
}

describe('native passkeys (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		for (const s of [...statements(qaNativeClients), ...statements(qaAdminClients)]) await E.AUTH_DB.prepare(s).run();
		E.ANDROID_APP_CERTS = JSON.stringify({ 'net.alummahnow.studio.qa': [FINGERPRINT] });
	});

	it('sign-in: options → verify → /token gives passkey tokens for the native client', async () => {
		const { userId, a } = await userWithPasskey();
		const app = new NativeApp();
		const { challenge_id, publicKey } = await app.options();
		expect(publicKey).toMatchObject({ rpId: 'localhost', allowCredentials: [], userVerification: 'required', timeout: 120000 });
		const res = await app.verify(challenge_id, await a.get(publicKey, ISSUER, userId));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.getSetCookie()).toEqual([]);
		const { code } = (await res.json()) as { code: string };
		const token = await app.token(code);
		expect(token.status).toBe(200);
		const tokens = (await token.json()) as { access_token: string; refresh_token: string };
		const claims = decodeJwt(tokens.access_token) as any;
		expect(claims.amr).toEqual(['passkey']);
		expect(claims.properties.id).toBe(userId);
		expect(claims.aud).toBe(STUDIO.id);
		expect(Math.abs(claims.auth_time - Date.now() / 1000)).toBeLessThan(60);
		expect(tokens.refresh_token).toBeTruthy();
		const row = await E.AUTH_DB.prepare('SELECT counter, last_used_at FROM webauthn_credentials WHERE id = ?').bind(a.credentialId).first<any>();
		expect(row.counter).toBe(1);
		expect(row.last_used_at).toBeGreaterThan(0);
	});

	it('the code is bound to the native redirect and the verifier', async () => {
		const { a } = await userWithPasskey();
		const app = new NativeApp();
		const { challenge_id, publicKey } = await app.options();
		const { code } = (await (await app.verify(challenge_id, await a.get(publicKey))).json()) as { code: string };
		const wrongRedirect = await call('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: STUDIO.id, code_verifier: app.verifier, redirect_uri: 'https://videos.qa.alummahnow.net/app/studio/auth/callback' }).toString(),
		});
		expect(wrongRedirect.status).toBe(400);
	});

	it('an Android app signed with a configured certificate is accepted; another is not', async () => {
		const { a } = await userWithPasskey();
		await new NativeApp().signIn(a, APK_ORIGIN);
		const app = new NativeApp();
		const { challenge_id, publicKey } = await app.options();
		await expectRefused(await app.verify(challenge_id, await a.get(publicKey, 'android:apk-key-hash:' + 'A'.repeat(43))));
	});

	it('a replayed challenge, another client, a wrong origin and an expired challenge all get the same 401', async () => {
		const { a } = await userWithPasskey();
		const app = new NativeApp();
		const first = await app.options();
		expect((await app.verify(first.challenge_id, await a.get(first.publicKey))).status).toBe(200);
		await expectRefused(await app.verify(first.challenge_id, await a.get(first.publicKey)));

		const other = await app.options();
		await expectRefused(await app.verify(other.challenge_id, await a.get(other.publicKey), ADMIN_IOS.id));

		const origin = await app.options();
		await expectRefused(await app.verify(origin.challenge_id, await a.get(origin.publicKey, 'https://evil.example')));

		const expired = await app.options();
		const atomic = Storage.atomic(authStorage(E as unknown as Env));
		const key = nativeChallengeKey(expired.challenge_id);
		const record = await atomic.get(key);
		expect(record.clientID).toBe(STUDIO.id);
		await atomic.set(key, { ...record, expires: Date.now() - 1 });
		await expectRefused(await app.verify(expired.challenge_id, await a.get(expired.publicKey)));
	});

	it('an unknown passkey, another user handle and a suspended account read the same', async () => {
		const { userId, a } = await userWithPasskey();
		const app = new NativeApp();
		const stranger = await new SoftAuthenticator().init();
		let o = await app.options();
		await expectRefused(await app.verify(o.challenge_id, await stranger.get(o.publicKey)));
		o = await app.options();
		await expectRefused(await app.verify(o.challenge_id, await a.get(o.publicKey, ISSUER, 'someone-else')));
		await E.AUTH_DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(userId).run();
		o = await app.options();
		await expectRefused(await app.verify(o.challenge_id, await a.get(o.publicKey)));
	});

	it('Windows Studio: a loopback redirect_uri on options binds the code to that redirect', async () => {
		const { a } = await userWithPasskey();
		const desktop = new NativeApp({ id: '29b4792a-caad-4814-a83f-4337bc6a1aeb', redirect: 'http://127.0.0.1:51234/auth/callback' });
		const challenge = b64url(await sha256(new TextEncoder().encode(desktop.verifier)));
		const opts = await post('/native/passkey/options', { client_id: desktop.client.id, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: desktop.client.redirect });
		expect(opts.status).toBe(200);
		const { challenge_id, publicKey } = (await opts.json()) as any;
		const res = await desktop.verify(challenge_id, await a.get(publicKey));
		expect(res.status).toBe(200);
		const { code } = (await res.json()) as { code: string };
		expect((await desktop.token(code)).status).toBe(200);

		const bad = await post('/native/passkey/options', { client_id: desktop.client.id, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'http://127.0.0.1:51234/other' });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as any).error).toBe('invalid_request');
	});

	it('only Studio and Admin native clients: viewer and web clients get invalid_client', async () => {
		for (const client_id of [VIEWER, '109a1087-6626-40f7-8a7f-7f42f83f4f30', 'nope']) {
			const res = await post('/native/passkey/options', {
				client_id,
				code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
				code_challenge_method: 'S256',
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).error).toBe('invalid_client');
		}
	});

	it('bad bodies get invalid_request; a refused rate limit gets 429 with Retry-After', async () => {
		const res = await post('/native/passkey/options', { client_id: STUDIO.id, code_challenge: 'x', code_challenge_method: 'S256' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('invalid_request');
		const saved = E.NATIVE_PASSKEY_LIMITER;
		E.NATIVE_PASSKEY_LIMITER = { limit: async () => ({ success: false }) };
		try {
			for (const path of ['/native/passkey/options', '/native/passkey/verify']) {
				const limited = await post(path, { client_id: STUDIO.id });
				expect(limited.status).toBe(429);
				expect(limited.headers.get('retry-after')).toBe('60');
				expect(((await limited.json()) as any).error).toBe('rate_limited');
			}
		} finally {
			E.NATIVE_PASSKEY_LIMITER = saved;
		}
	});

	it('register: options and verify add a passkey with a fresh native token', async () => {
		const { userId, a } = await userWithPasskey();
		const { access_token } = await new NativeApp().signIn(a);
		const auth = { authorization: `Bearer ${access_token}` };
		const opts = await post('/native/passkey/register/options', {}, auth);
		expect(opts.status).toBe(200);
		const { challenge_id, publicKey } = (await opts.json()) as any;
		expect(publicKey.rp.id).toBe('localhost');
		expect(publicKey.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
		expect(publicKey.timeout).toBe(120000);
		expect(publicKey.excludeCredentials.map((c: any) => c.id)).toEqual([a.credentialId]);

		const second = await new SoftAuthenticator().init();
		const credential = await second.create(publicKey);
		const res = await post('/native/passkey/register/verify', { challenge_id, credential, name: 'Work iPhone' }, auth);
		expect(res.status).toBe(200);
		const added = (await res.json()) as any;
		expect(added).toEqual({ id: second.credentialId, name: 'Work iPhone', created_at: expect.any(Number) });
		const row = await E.AUTH_DB.prepare('SELECT user_id, name FROM webauthn_credentials WHERE id = ?').bind(second.credentialId).first<any>();
		expect(row).toEqual({ user_id: userId, name: 'Work iPhone' });

		// Single use
		const again = await post('/native/passkey/register/verify', { challenge_id, credential, name: 'x' }, auth);
		expect(again.status).toBe(400);
		expect(((await again.json()) as any).error).toBe('invalid_credential');
		expect(await Storage.atomic(authStorage(E as unknown as Env)).get(nativeRegistrationKey(challenge_id))).toBeUndefined();

		// The new passkey signs in natively
		await new NativeApp().signIn(second);
	});

	it('register: no token is invalid_token', async () => {
		const res = await post('/native/passkey/register/options', {});
		expect(res.status).toBe(401);
		expect(((await res.json()) as any).error).toBe('invalid_token');
	});

	it("register: a staff member's first passkey needs the web (email code); a non-native token is invalid_client", async () => {
		const { email, userId } = await userWithPasskey();
		await E.AUTH_DB.prepare(`DELETE FROM webauthn_credentials WHERE user_id = ?`).bind(userId).run();
		const now = Date.now();
		await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES ('role_admin', 'Admin', 'default', ?1, ?1)`).bind(now).run();
		await E.AUTH_DB.prepare(`INSERT OR REPLACE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?1, 'role_admin', 'default', ?2, 'test')`)
			.bind(userId, now)
			.run();
		const app = new NativeApp();
		const { access_token } = await passwordSignIn(app, email);
		expect((decodeJwt(access_token) as any).amr).toEqual(['pwd']);
		const res = await post('/native/passkey/register/options', {}, { authorization: `Bearer ${access_token}` });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: 'email_code_required', setup_url: `${ISSUER}/passkeys/setup` });

		// The Viewer app's token: a native client, but not one that may add passkeys here
		const viewer = await passwordSignIn(new NativeApp({ id: VIEWER, redirect: 'alummahnow://auth/callback' }), email);
		const refused = await post('/native/passkey/register/options', {}, { authorization: `Bearer ${viewer.access_token}` });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as any).error).toBe('invalid_client');
	});

	it('register: a revoked sign-in or a suspended account is invalid_token', async () => {
		const { userId, a } = await userWithPasskey();
		const { access_token } = await new NativeApp().signIn(a);
		const auth = { authorization: `Bearer ${access_token}` };
		expect((await post('/native/passkey/register/options', {}, auth)).status).toBe(200);
		await E.AUTH_DB.prepare(`INSERT OR REPLACE INTO user_revocations (user_id, revoked_before, reason, updated_at) VALUES (?1, ?2, 'sign_out_everywhere', ?3)`)
			.bind(userId, Math.floor(Date.now() / 1000) + 5, Date.now())
			.run();
		const revoked = await post('/native/passkey/register/options', {}, auth);
		expect(revoked.status).toBe(401);
		expect(((await revoked.json()) as any).error).toBe('invalid_token');

		const other = await userWithPasskey();
		const tokens = await new NativeApp().signIn(other.a);
		await E.AUTH_DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(other.userId).run();
		const suspended = await post('/native/passkey/register/options', {}, { authorization: `Bearer ${tokens.access_token}` });
		expect(suspended.status).toBe(401);
		expect(((await suspended.json()) as any).error).toBe('invalid_token');
	});

	it('register: the web codes exists (409) and limit (403)', async () => {
		const { userId, a } = await userWithPasskey();
		const { access_token } = await new NativeApp().signIn(a);
		const auth = { authorization: `Bearer ${access_token}` };
		// The same authenticator again: excludeCredentials would stop a real one; the server says exists
		const { challenge_id, publicKey } = (await (await post('/native/passkey/register/options', {}, auth)).json()) as any;
		const exists = await post('/native/passkey/register/verify', { challenge_id, credential: await a.create(publicKey) }, auth);
		expect(exists.status).toBe(409);
		expect(((await exists.json()) as any).error).toBe('exists');

		const now = Date.now();
		for (let i = 0; i < 9; i++) {
			await E.AUTH_DB.prepare(
				`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?1, ?2, 'x', 0, '[]', 'multiDevice', 1, 'P', ?3)`
			)
				.bind(`filler-${userId}-${i}`, userId, now)
				.run();
		}
		const limit = await post('/native/passkey/register/options', {}, auth);
		expect(limit.status).toBe(403);
		expect(((await limit.json()) as any).error).toBe('limit');
	});

	it('register: a sign-in older than 15 minutes is step_up_required', async () => {
		const { a } = await userWithPasskey();
		const { access_token } = await new NativeApp().signIn(a);
		const ctx = createExecutionContext();
		const res = await handleNativeRegisterOptions({
			request: new Request(`${ISSUER}/native/passkey/register/options`, { method: 'POST', headers: { authorization: `Bearer ${access_token}` }, body: '{}' }),
			env: E as never,
			ctx,
			requestId: 'test',
			storage: authStorage(E as unknown as Env),
			now: Date.now() + 16 * 60 * 1000,
		});
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: 'step_up_required', max_age: 900 });
	});

	it('register: a wrong origin attestation is refused', async () => {
		const { a } = await userWithPasskey();
		const { access_token } = await new NativeApp().signIn(a);
		const auth = { authorization: `Bearer ${access_token}` };
		const { challenge_id, publicKey } = (await (await post('/native/passkey/register/options', {}, auth)).json()) as any;
		const other = await new SoftAuthenticator().init();
		const res = await post('/native/passkey/register/verify', { challenge_id, credential: await other.create(publicKey, 'https://evil.example') }, auth);
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toBe('invalid_credential');
	});
});

describe('native passkey config', () => {
	it('Android fingerprints become apk-key-hash origins; malformed ones are skipped', () => {
		expect(apkKeyHash(FINGERPRINT)).toBe('Whs9K1dumi3wvxvj8YxAIBP5XAnq7nz3MRDEL7Vp3cA');
		expect(apkKeyHash(FINGERPRINT.replace(/:/g, '').toLowerCase())).toBe('Whs9K1dumi3wvxvj8YxAIBP5XAnq7nz3MRDEL7Vp3cA');
		expect(apkKeyHash('AB:CD')).toBeUndefined();
		expect(androidOrigins({ ANDROID_APP_CERTS: JSON.stringify({ a: [FINGERPRINT, 'bad'], b: [FINGERPRINT] }) })).toEqual([APK_ORIGIN]);
		expect(androidOrigins({ ANDROID_APP_CERTS: 'not json' })).toEqual([]);
		expect(androidOrigins({})).toEqual([]);
	});

	it('per env: the web origin, https://<RP id> for Apple and Windows, and Android apps', () => {
		const req = new Request('https://auth.qa.alummahnow.net/native/passkey/verify');
		expect(nativeOrigins({ AUTH_DB: E.AUTH_DB, OPENAUTH_ISSUER: 'https://auth.qa.alummahnow.net', ANDROID_APP_CERTS: JSON.stringify({ x: [FINGERPRINT] }) }, req)).toEqual([
			'https://auth.qa.alummahnow.net',
			'https://qa.alummahnow.net',
			APK_ORIGIN,
		]);
		expect(nativeOrigins({ AUTH_DB: E.AUTH_DB, OPENAUTH_ISSUER: 'https://auth.alummahnow.net' }, req)).toEqual(['https://auth.alummahnow.net', 'https://alummahnow.net']);
	});

	it('the native redirect is the private-use scheme, never https or loopback', () => {
		expect(nativeRedirect(['alummahnow-studio://auth/callback', 'https://videos.alummahnow.net/app/studio/auth/callback'])).toBe('alummahnow-studio://auth/callback');
		expect(nativeRedirect(['https://x.example/cb', 'http://127.0.0.1/auth/callback'])).toBeUndefined();
		expect(nativeRedirect('nope')).toBeUndefined();
	});

	it('accepts the Studio and Admin clients of every env and nothing else', () => {
		expect(NATIVE_PASSKEY_CLIENT_IDS.size).toBe(12);
		expect(NATIVE_PASSKEY_CLIENT_IDS.has(VIEWER)).toBe(false);
	});
});
