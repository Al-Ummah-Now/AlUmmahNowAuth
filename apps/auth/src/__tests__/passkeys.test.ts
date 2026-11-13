/**
 * Passkeys end to end through the real worker (AUTH-PASSKEYS): the
 * after-sign-in card, adding a passkey, signing in with it (amr passkey),
 * the account hub API, staff rules (first passkey needs an emailed code, last
 * passkey can't be removed), the enforcement deadline, setup links, CSRF.
 *
 * A software ES256 authenticator stands in for the browser and device.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, registerTestClients } from './helpers/clients';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { clearPolicyCache, deadlineFor, isStaff, passkeyBlocked, writeStaffPasskeySetting } from '../passkeys/policy';
import { createSetupTicket, peekSetupTicket, useSetupTicket, defaultPasskeyName, cleanPasskeyName } from '../passkeys/store';
import { cardEnabledFor } from '../passkeys/card';
import { safeReturnTo, signRegistration, readRegistration } from '../passkeys/routes';

const ISSUER = 'http://localhost:3301';
const RP_ID = 'localhost';
const PASSWORD = 'Passkeys-Test-123!';
const E = env as unknown as Env;

// ---------- minimal CBOR (maps, ints, byte and text strings) ----------
function cborHead(major: number, n: number): number[] {
	if (n < 24) return [(major << 5) | n];
	if (n < 256) return [(major << 5) | 24, n];
	if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
	return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
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
	async create(options: any, origin = ISSUER) {
		const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
		const cose = new Map<number, unknown>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, fromB64url(jwk.x!)],
			[-3, fromB64url(jwk.y!)],
		]);
		const rpHash = await sha256(new TextEncoder().encode(options.rp.id));
		const authData = new Uint8Array([
			...rpHash,
			0x45, // UP + UV + AT
			0, 0, 0, 0,
			...new Uint8Array(16), // aaguid
			0, this.id.length,
			...this.id,
			...cbor(cose),
		]);
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
	async get(options: any, origin = ISSUER) {
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
			response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(der(raw)) },
		};
	}
}

// ---------- a browser against the worker ----------
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
	api(path: string, body: unknown = {}, origin: string | null = ISSUER) {
		return this.fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
			body: JSON.stringify(body),
		});
	}
	form(path: string, body: Record<string, string>) {
		return this.fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body).toString(),
		});
	}
	verifier = '';
	async startSignIn() {
		this.verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = b64url(await sha256(new TextEncoder().encode(this.verifier)));
		const start = await this.fetch(
			`/authorize?client_id=${PROFILE.id}&response_type=code&state=s&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&code_challenge=${challenge}&code_challenge_method=S256&prompt=login`
		);
		const login = start.headers.get('location')!;
		expect(login).toContain('/password/authorize');
		return login;
	}
	async exchange(location: string) {
		const code = new URL(location).searchParams.get('code')!;
		const res = await this.fetch('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: PROFILE.redirect, client_id: PROFILE.id, code_verifier: this.verifier }).toString(),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as { access_token: string; refresh_token: string };
	}
	/** Password sign-in; returns the response (card page or redirect). */
	async passwordSignIn(email: string) {
		const login = await this.startSignIn();
		return this.form(login, { email, password: PASSWORD });
	}
	async passkeySignIn(a: SoftAuthenticator) {
		const login = await this.startSignIn();
		const search = new URL(login, ISSUER).search;
		const opts = await this.fetch(`/passkey/options${search}`, { method: 'POST' });
		expect(opts.status).toBe(200);
		const assertion = await a.get(await opts.json());
		return this.form(`/passkey/verify${search}`, { credential: JSON.stringify(assertion) });
	}
	async addPasskey(a: SoftAuthenticator, body: Record<string, unknown> = {}) {
		const res = await this.api('/passkeys/register/options', body);
		const j = (await res.json()) as any;
		if (!j.options) return j;
		const cred = await a.create(j.options);
		return (await (await this.api('/passkeys/register/verify', { credential: cred, token: j.token })).json()) as any;
	}
}

/** The continue URL inside a card page. */
async function cardContinue(res: Response) {
	expect(res.status).toBe(200);
	const html = await res.text();
	const m = html.match(/"continueUrl":"([^"]+)"/);
	expect(m).toBeTruthy();
	return { html, location: JSON.parse(`"${m![1]}"`) as string };
}

async function makeUser(email: string) {
	const storage = CloudflarePatchedStorage({ namespace: E.AUTH_STORAGE });
	await Storage.set(storage, ['email', email, 'password'], await ScryptHasher().hash(PASSWORD));
}
async function userIdOf(email: string) {
	return (await E.AUTH_DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id;
}
async function grant(user: string, roleId: string, assignedAt = Date.now()) {
	await E.AUTH_DB.prepare(`INSERT OR REPLACE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, ?, 'default', ?, 'test')`)
		.bind(user, roleId, assignedAt)
		.run();
}
const unique = () => crypto.randomUUID().slice(0, 8);

describe('passkeys (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const now = Date.now();
		for (const [id, name] of [
			['role_member', 'Member'],
			['role_admin', 'Admin'],
			['role_super_admin', 'Super Admin'],
		]) {
			await E.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, created_at, updated_at) VALUES (?, ?, 'default', ?, ?)`)
				.bind(id, name, now, now)
				.run();
		}
	});
	beforeEach(async () => {
		await E.AUTH_DB.prepare(`DELETE FROM auth_settings`).run();
		clearPolicyCache();
	});

	it('card after sign-in, add a passkey, then sign in with it (amr passkey, no card)', async () => {
		const email = `pk-user-${unique()}@example.com`;
		await makeUser(email);
		const browser = new Browser();
		const card = await cardContinue(await browser.passwordSignIn(email));
		expect(card.html).toContain('Sign in faster next time');
		expect(card.location.startsWith(PROFILE.redirect)).toBe(true);
		// The code behind the card is still redeemable, with amr pwd
		const first = await browser.exchange(card.location);
		expect(decodeJwt(first.access_token).amr).toEqual(['pwd']);

		const a = await new SoftAuthenticator().init();
		const added = await browser.addPasskey(a);
		expect(added.ok).toBe(true);
		const row = await E.AUTH_DB.prepare('SELECT user_id, device_type, name FROM webauthn_credentials WHERE id = ?').bind(a.credentialId).first<any>();
		expect(row.user_id).toBe(await userIdOf(email));

		const fresh = new Browser();
		const res = await fresh.passkeySignIn(a);
		expect(res.status).toBe(302);
		const tokens = await fresh.exchange(res.headers.get('location')!);
		const claims = decodeJwt(tokens.access_token) as any;
		expect(claims.amr).toEqual(['passkey']);
		expect(claims.properties.email).toBe(email);
		expect(typeof claims.auth_time).toBe('number');
	});

	it('the sign-in page offers the passkey button; an unknown passkey goes back with an error', async () => {
		const browser = new Browser();
		const login = await browser.startSignIn();
		const page = await (await browser.fetch(login)).text();
		expect(page).toContain('Sign in with a passkey');
		const stranger = await new SoftAuthenticator().init();
		const res = await browser.passkeySignIn(stranger);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toContain('passkey_error=1');
	});

	it('"Not now" hides the card for 30 days', async () => {
		const email = `pk-later-${unique()}@example.com`;
		await makeUser(email);
		const browser = new Browser();
		await cardContinue(await browser.passwordSignIn(email));
		expect((await browser.api('/passkeys/prompt/dismiss')).status).toBe(204);
		const again = await new Browser().passwordSignIn(email);
		expect(again.status).toBe(302);
	});

	it('account hub: list, rename, remove and undo', async () => {
		const email = `pk-hub-${unique()}@example.com`;
		await makeUser(email);
		const browser = new Browser();
		const card = await cardContinue(await browser.passwordSignIn(email));
		const { access_token } = await browser.exchange(card.location);
		const a = await new SoftAuthenticator().init();
		expect((await browser.addPasskey(a)).ok).toBe(true);
		const auth = { authorization: `Bearer ${access_token}` };

		const list = (await (await browser.fetch('/account/passkeys', { headers: auth })).json()) as any;
		expect(list.passkeys).toHaveLength(1);
		expect(list.passkeys[0].id).toBe(a.credentialId);
		expect(list.passkeys[0]).not.toHaveProperty('publicKey');

		const renamed = await browser.fetch(`/account/passkeys/${a.credentialId}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: '  Work laptop  ' }) });
		expect(((await renamed.json()) as any).name).toBe('Work laptop');

		expect((await browser.fetch(`/account/passkeys/${a.credentialId}`, { method: 'DELETE', headers: auth })).status).toBe(200);
		expect(((await (await browser.fetch('/account/passkeys', { headers: auth })).json()) as any).passkeys).toHaveLength(0);
		// A removed passkey can't sign in
		expect((await new Browser().passkeySignIn(a)).status).toBe(303);
		// Undo
		expect((await browser.fetch(`/account/passkeys/${a.credentialId}/restore`, { method: 'POST', headers: auth })).status).toBe(200);
		expect((await new Browser().passkeySignIn(a)).status).toBe(302);
	});

	it('staff: the first passkey needs the emailed code; the last one cannot be removed', async () => {
		const email = `pk-staff-${unique()}@example.com`;
		await makeUser(email);
		// First sign-in creates the account; then make them an admin
		const first = new Browser();
		await first.exchange((await cardContinue(await first.passwordSignIn(email))).location);
		await grant(await userIdOf(email), 'role_admin');

		const browser = new Browser();
		const card = await cardContinue(await browser.passwordSignIn(email));
		expect(card.html).toContain('Your role needs a passkey');
		const { access_token } = await browser.exchange(card.location);
		const a = await new SoftAuthenticator().init();
		expect((await browser.addPasskey(a)).error).toBe('wrong_code');
		expect((await browser.addPasskey(a, { code: '000000' })).error).toBe('wrong_code');

		// The code (development: logged, not emailed): set a known one the way the route does
		const { recordCode } = await import('../security/password-attempts');
		await recordCode(E.AUTH_DB, email, '424242');
		expect((await browser.addPasskey(a, { code: '424242' })).ok).toBe(true);

		const auth = { authorization: `Bearer ${access_token}` };
		const del = await browser.fetch(`/account/passkeys/${a.credentialId}`, { method: 'DELETE', headers: auth });
		expect(del.status).toBe(409);
		expect(((await del.json()) as any).error).toBe('last_staff_passkey');
	});

	it('enforcement: staff tokens carry passkey_deadline; existing staff get 7 days', async () => {
		const email = `pk-deadline-${unique()}@example.com`;
		await makeUser(email);
		const b0 = new Browser();
		await b0.exchange((await cardContinue(await b0.passwordSignIn(email))).location);
		const id = await userIdOf(email);
		const enforcedAt = Date.now();
		await grant(id, 'role_admin', enforcedAt - 86_400_000);
		await writeStaffPasskeySetting(E.AUTH_DB, { enforced: true, enforcedAt, graceDays: 7 }, 'test');

		const browser = new Browser();
		const card = await cardContinue(await browser.passwordSignIn(email));
		const tokens = await browser.exchange(card.location);
		const claims = decodeJwt(tokens.access_token) as any;
		expect(claims.properties.passkey_deadline).toBe(Math.floor((enforcedAt + 7 * 86_400_000) / 1000));
		expect(passkeyBlocked(claims)).toBe(false); // grace
		expect(passkeyBlocked(claims, claims.properties.passkey_deadline)).toBe(true);

		// Switched off: the next refresh drops the deadline
		await writeStaffPasskeySetting(E.AUTH_DB, { enforced: false, enforcedAt: null, graceDays: 7 }, 'test');
		const refreshed = await browser.fetch('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: PROFILE.id }).toString(),
		});
		expect(refreshed.status).toBe(200);
		const r = decodeJwt(((await refreshed.json()) as any).access_token) as any;
		expect(r.properties.passkey_deadline).toBeUndefined();
		expect(r.amr).toEqual(['pwd']);
	});

	it('ceremonies refuse other origins (CSRF) and signed-out browsers', async () => {
		const browser = new Browser();
		expect((await browser.api('/passkeys/register/options', {}, 'https://evil.example')).status).toBe(403);
		expect((await browser.api('/passkeys/register/options', {}, null)).status).toBe(403);
		const signedOut = await browser.api('/passkeys/register/options');
		expect(signedOut.status).toBe(401);
		const page = await browser.fetch('/passkeys/setup');
		expect(await page.text()).toContain('Sign in first');
	});

	it('setup links are single use and per user', async () => {
		const { token } = await createSetupTicket(E.AUTH_DB, 'usr_a', 'usr_admin');
		expect(await peekSetupTicket(E.AUTH_DB, token)).toBe('usr_a');
		expect(await useSetupTicket(E.AUTH_DB, token, 'usr_b')).toBe(false);
		expect(await useSetupTicket(E.AUTH_DB, token, 'usr_a')).toBe(true);
		expect(await useSetupTicket(E.AUTH_DB, token, 'usr_a')).toBe(false);
		expect(await peekSetupTicket(E.AUTH_DB, token)).toBeNull();
	});

	it('registration tokens are signed and expire', async () => {
		const tok = await signRegistration(E as never, { u: 'u', s: 's', c: 'c', e: Date.now() + 1000 });
		expect((await readRegistration(E as never, tok))?.u).toBe('u');
		expect(await readRegistration(E as never, tok.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
		expect(await readRegistration(E as never, tok, Date.now() + 5000)).toBeNull();
	});
});

describe('passkey policy and helpers', () => {
	it('staff roles', () => {
		expect(isStaff(['Super Admin'])).toBe(true);
		expect(isStaff(['Content Reviewer'])).toBe(true);
		expect(isStaff(['writer'])).toBe(true);
		expect(isStaff(['Member', 'Scholar'])).toBe(false);
	});
	it('deadlines: off, new staff (none), existing staff (grace)', () => {
		const at = 1_800_000_000_000;
		expect(deadlineFor({ enforced: false, enforcedAt: at, graceDays: 7 }, 0, ['Admin'])).toBeUndefined();
		expect(deadlineFor({ enforced: true, enforcedAt: at, graceDays: 7 }, at + 1, ['Admin'])).toBe(at / 1000);
		expect(deadlineFor({ enforced: true, enforcedAt: at, graceDays: 7 }, at - 1, ['Admin'])).toBe(at / 1000 + 7 * 86400);
		expect(deadlineFor({ enforced: true, enforcedAt: at, graceDays: 7 }, at - 1, ['Member'])).toBeUndefined();
	});
	it('consumer rule', () => {
		const props = { roles: ['Admin'], passkey_deadline: 100 };
		expect(passkeyBlocked({ amr: ['pwd'], properties: props }, 100)).toBe(true);
		expect(passkeyBlocked({ amr: ['pwd'], properties: props }, 99)).toBe(false);
		expect(passkeyBlocked({ amr: ['passkey'], properties: props }, 200)).toBe(false);
		expect(passkeyBlocked({ properties: props }, 200)).toBe(true);
		expect(passkeyBlocked({ amr: ['pwd'], properties: { roles: ['Admin'] } }, 200)).toBe(false);
	});
	it('card: off locally unless the address opts in; never for test domains', () => {
		expect(cardEnabledFor({ PASSKEY_PROMPT: 'off' }, 'a@gmail.com')).toBe(false);
		expect(cardEnabledFor({ PASSKEY_PROMPT: 'on' }, 'a@gmail.com')).toBe(true);
		expect(cardEnabledFor({ PASSKEY_PROMPT: 'on' }, 'e2e+1-1-x@e2e.alummahnow.net')).toBe(false);
		expect(cardEnabledFor({ PASSKEY_PROMPT: 'on' }, 'qa-admin@delivered.resend.dev')).toBe(false);
		expect(cardEnabledFor({ PASSKEY_PROMPT: 'off' }, 'e2e+1-1-pk-x@e2e.alummahnow.net')).toBe(true);
	});
	it('names and return targets', () => {
		expect(defaultPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', true)).toBe('Passkey on iPhone or iPad');
		expect(cleanPasskeyName('  a\u0000b  ')).toBe('ab');
		expect(cleanPasskeyName('   ')).toBeNull();
		const env = { PROFILE_APP_URL: 'https://profile.auth.alummahnow.net/' } as never;
		expect(safeReturnTo('https://admin.alummahnow.net/x', env)).toBe('https://admin.alummahnow.net/x');
		expect(safeReturnTo('https://evil.example/x', env)).toBe('https://profile.auth.alummahnow.net/#passkeys');
		expect(safeReturnTo('javascript:alert(1)', env)).toBe('https://profile.auth.alummahnow.net/#passkeys');
	});
});
