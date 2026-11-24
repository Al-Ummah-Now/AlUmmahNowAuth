/**
 * Dates of birth (E20-P1, wiki E20 §5.1): encrypted at rest with a key of their own, read and written by the
 * person through the Profile app alone, never made older by them, exported, and gone with the account.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { decrypt, encrypt } from '../services/encryption';
import { ageOf, bandOf, isOlderBand, isPlausible, parseBirthDate } from '../birth-date/date';
import { keyIdOf } from '../birth-date/key';
import { readBirthDate, writeBirthDate, type BirthDateEnv } from '../birth-date/store';
import { clearBirthDateSettingCache, writeBirthDateSetting } from '../birth-date/setting';
import { HANDLERS, type DeletionEnv } from '../deletions/kinds';
import { redactLogValue } from '../logger';

const ISSUER = 'http://localhost:3301';
const E = env as unknown as Env;
const PROFILE = '109a1087-6626-40f7-8a7f-7f42f83f4f30';
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const EXTRA_TABLES = [
	"CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp TEXT NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', user_id TEXT, ip_address TEXT, user_agent TEXT, request_id TEXT, metadata TEXT, success INTEGER NOT NULL DEFAULT 1, error_message TEXT, tenant_id TEXT NOT NULL DEFAULT 'default', FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE);",
	'CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, provider_data TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);',
];

let privateKey: CryptoKey;
let previousKey: string | null;
const seconds = () => Math.floor(Date.now() / 1000);

async function token(id: string, opts: { aud?: string; authAgo?: number; type?: string } = {}) {
	return new SignJWT({ mode: 'access', type: opts.type ?? 'user', properties: { id, email: `${id}@example.com`, roles: [] }, auth_time: seconds() - (opts.authAgo ?? 60) })
		.setProtectedHeader({ alg: 'ES256', kid: 'birth-kid' })
		.setIssuer(ISSUER)
		.setAudience(opts.aud ?? PROFILE)
		.setSubject('user:abc')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
}

async function call(path: string, method: string, bearer: string | null, body?: unknown) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`${ISSUER}${path}`, {
			method,
			headers: { host: 'localhost:3301', 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
			...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
		}),
		E,
		ctx
	);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	return { status: res.status, headers: res.headers, text, body: JSON.parse(text || '{}') as Record<string, any> };
}
const get = async (id: string, opts = {}) => call('/account/birth-date', 'GET', await token(id, opts));
const put = async (id: string, birthDate: unknown, opts = {}) => call('/account/birth-date', 'PUT', await token(id, opts), { birthDate });
const row = (id: string) => E.AUTH_DB.prepare('SELECT * FROM user_birth_dates WHERE user_id = ?').bind(id).first<{ birth_date_enc: string; key_id: string; changed_at: number }>();

/** A date `years` before today at UTC−12, `days` days away from the birthday (negative: not reached yet). */
function bornYearsAgo(years: number, days = 0): string {
	const d = new Date(Date.now() - 12 * 3_600_000 - days * 86_400_000);
	return `${d.getUTCFullYear() - years}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d.getUTCDate(), 28)).padStart(2, '0')}`;
}

async function seedUser(id: string, status = 'active') {
	const ts = Date.now();
	await E.AUTH_DB.prepare(`INSERT OR REPLACE INTO users (id, tenant_id, email, name, status, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, ?, ?)`)
		.bind(id, `${id}@example.com`, id, status, ts, ts)
		.run();
	await E.AUTH_DB.prepare('DELETE FROM user_birth_dates WHERE user_id = ?').bind(id).run();
}

describe('dates, ages and bands', () => {
	it('only a real Gregorian day is a date', () => {
		expect(parseBirthDate('2001-05-04')).toEqual({ year: 2001, month: 5, day: 4 });
		expect(parseBirthDate('2004-02-29')).not.toBeNull();
		for (const bad of ['2001-02-29', '1900-02-29', '2001-13-01', '2001-00-10', '2001-04-31', '2001-4-5', '04/05/2001', '2001-05-04T00:00', ' 2001-05-04', '٢٠٠١-٠٥-٠٤', '', null, 20010504, {}]) expect(parseBirthDate(bad)).toBeNull();
	});

	it('a birthday counts from the date at UTC−12', () => {
		const date = parseBirthDate('2010-06-15')!;
		expect(ageOf(date, Date.parse('2028-06-15T11:59:59Z'))).toBe(17);
		expect(ageOf(date, Date.parse('2028-06-15T12:00:00Z'))).toBe(18);
	});

	it('29 February counts on 1 March of a common year', () => {
		const date = parseBirthDate('2008-02-29')!;
		expect(ageOf(date, Date.parse('2026-02-28T23:00:00Z'))).toBe(17);
		expect(ageOf(date, Date.parse('2026-03-01T13:00:00Z'))).toBe(18);
		expect(ageOf(date, Date.parse('2028-02-29T13:00:00Z'))).toBe(20);
	});

	it('bands at each boundary', () => {
		const now = Date.parse('2026-11-24T13:00:00Z');
		const at = (value: string) => bandOf(parseBirthDate(value)!, now);
		expect([at('2013-11-25'), at('2013-11-24'), at('2010-11-25'), at('2010-11-24'), at('2008-11-25'), at('2008-11-24')]).toEqual([null, '13_15', '13_15', '16_17', '16_17', '18_plus']);
	});

	it('a future date and an age under 3 or over 120 are typing mistakes', () => {
		const now = Date.parse('2026-11-24T13:00:00Z');
		expect(['2030-01-01', '2024-01-01', '1900-01-01'].map((v) => isPlausible(parseBirthDate(v)!, now))).toEqual([false, false, false]);
		expect(['2023-11-24', '1906-11-24'].map((v) => isPlausible(parseBirthDate(v)!, now))).toEqual([true, true]);
	});

	it('older is older', () => {
		expect([isOlderBand('13_15', '16_17'), isOlderBand(null, '13_15'), isOlderBand('18_plus', '16_17'), isOlderBand('16_17', '16_17')]).toEqual([true, true, false, false]);
	});
});

describe('encryption keys', () => {
	it('two keys in one isolate never mix, by id and by material', async () => {
		const [a, b] = [{ id: 'a', material: KEY_A }, { id: 'b', material: KEY_B }];
		const [sealedA, sealedB] = [await encrypt('one', a), await encrypt('two', b)];
		expect([await decrypt(sealedA, a), await decrypt(sealedB, b)]).toEqual(['one', 'two']);
		await expect(decrypt(sealedA, b)).rejects.toThrow();
		await expect(decrypt(sealedB, a)).rejects.toThrow();
		// The same id with another material is another key, not the cached one
		await expect(decrypt(sealedA, { id: 'a', material: KEY_B })).rejects.toThrow();
		expect(await decrypt(sealedA, a)).toBe('one');
	});

	it('a plain master key still works, and is not whatever key was used last', async () => {
		const sealed = await encrypt('x', KEY_A);
		await encrypt('y', { id: 'other', material: KEY_B });
		expect(await decrypt(sealed, KEY_A)).toBe('x');
		await expect(decrypt(sealed, KEY_B)).rejects.toThrow();
	});

	it('a value is bound to its owner', async () => {
		const key = { id: 'a', material: KEY_A };
		const sealed = await encrypt('x', key, 'user-1');
		expect(await decrypt(sealed, key, 'user-1')).toBe('x');
		await expect(decrypt(sealed, key, 'user-2')).rejects.toThrow();
		await expect(decrypt(sealed, key)).rejects.toThrow();
	});

	it('a missing or short key fails, and is not remembered', async () => {
		await expect(encrypt('x', { id: 'z', material: '' })).rejects.toThrow(/not defined/);
		await expect(encrypt('x', { id: 'z', material: btoa('short') })).rejects.toThrow();
		expect(await decrypt(await encrypt('x', { id: 'z', material: KEY_A }), { id: 'z', material: KEY_A })).toBe('x');
	});
});

describe('/account/birth-date', () => {
	const saved = { key: E.PROFILE_DATA_KEY, limiter: E.BIRTH_DATE_LIMITER };
	beforeAll(async () => {
		await setupDatabase();
		for (const ddl of EXTRA_TABLES) await E.AUTH_DB.prepare(ddl).run();
		const pair = await generateKeyPair('ES256', { extractable: true });
		privateKey = pair.privateKey as CryptoKey;
		previousKey = await E.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
		await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, JSON.stringify({ id: 'birth-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() }));
		clearJWKSCache();
	});
	beforeEach(async () => {
		E.PROFILE_DATA_KEY = KEY_A;
		E.PROFILE_DATA_KEY_PREVIOUS = undefined;
		E.BIRTH_DATE_LIMITER = saved.limiter;
		await writeBirthDateSetting(E.AUTH_DB, true, 'test');
		await seedUser('bd1');
	});
	afterAll(async () => {
		E.PROFILE_DATA_KEY = saved.key;
		E.BIRTH_DATE_LIMITER = saved.limiter;
		await E.AUTH_DB.prepare(`DELETE FROM auth_settings WHERE key = 'birth_date'`).run();
		clearBirthDateSettingCache();
		if (previousKey) await E.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previousKey);
		else await E.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
		clearJWKSCache();
	});

	it('off by default and while the setting is off: 404 feature_off, nothing stored', async () => {
		await E.AUTH_DB.prepare(`DELETE FROM auth_settings WHERE key = 'birth_date'`).run();
		clearBirthDateSettingCache();
		for (const r of [await get('bd1'), await put('bd1', '1990-01-02')]) expect([r.status, r.body.error]).toEqual([404, 'feature_off']);
		expect(await row('bd1')).toBeNull();
	});

	it('the person saves and reads their own date; D1 holds only ciphertext', async () => {
		expect((await get('bd1')).body).toEqual({ birthDate: null });
		const r = await put('bd1', '1990-01-02');
		expect([r.status, r.body]).toEqual([200, { birthDate: '1990-01-02' }]);
		expect(r.headers.get('Cache-Control')).toBe('private, no-store');
		expect((await get('bd1')).body).toEqual({ birthDate: '1990-01-02' });
		const stored = (await row('bd1'))!;
		expect(JSON.stringify(stored)).not.toMatch(/1990|01-02/);
		expect(atob(stored.birth_date_enc)).not.toContain('1990');
		expect(stored.key_id).toBe(await keyIdOf(KEY_A));
	});

	it('only a token of the Profile app, from this person, still signed in', async () => {
		await put('bd1', '1990-01-02');
		for (const r of [await get('bd1', { aud: 'videos-web' }), await put('bd1', '1991-01-02', { aud: 'videos-web' })]) {
			expect(r.status).toBe(403);
			expect(r.text).not.toContain('1990');
		}
		expect((await call('/account/birth-date', 'GET', null)).status).toBe(401);
		expect((await get('bd1', { type: 'admin' })).status).toBe(401);
		// Another person reads only their own
		await seedUser('bd2');
		expect((await get('bd2')).body).toEqual({ birthDate: null });
		expect((await call('/account/birth-date', 'DELETE', await token('bd1'))).status).toBe(405);
		// Signed out of all devices since, suspended, or gone
		await E.AUTH_DB.prepare('INSERT OR REPLACE INTO user_revocations (user_id, revoked_before, reason, updated_at) VALUES (?, ?, ?, ?)').bind('bd2', seconds() - 1, 'sign_out_all', Date.now()).run();
		expect((await get('bd2')).status).toBe(401);
		await seedUser('bd3', 'suspended');
		expect([(await get('bd3')).status, (await put('bd3', '1990-01-02')).status, (await get('nobody')).status]).toEqual([401, 401, 401]);
	});

	it('a change needs a sign-in under 10 minutes old; reading doesn’t', async () => {
		const r = await put('bd1', '1990-01-02', { authAgo: 700 });
		expect([r.status, r.body.error, r.body.max_age]).toEqual([401, 'insufficient_user_authentication', 600]);
		expect(r.body.error_description).not.toContain('delete');
		expect((await get('bd1', { authAgo: 700 })).status).toBe(200);
		expect(await row('bd1')).toBeNull();
	});

	it('refuses what is not a date of birth', async () => {
		for (const bad of ['1990-02-30', '2999-01-01', bornYearsAgo(2), '1850-01-01', '01/02/1990', 5, null]) {
			const r = await put('bd1', bad);
			expect([r.status, r.body.error], String(bad)).toEqual([400, 'invalid_birth_date']);
		}
		const t = await token('bd1');
		for (const body of ['', 'null', '[]', '{"birthDate":', `{"birthDate":"1990-01-02","pad":"${'x'.repeat(300)}"}`]) expect((await call('/account/birth-date', 'PUT', t, body)).status).toBe(400);
		expect(await row('bd1')).toBeNull();
	});

	it('under 13: refused, and nothing is stored or changed', async () => {
		const r = await put('bd1', bornYearsAgo(10));
		expect([r.status, r.body.error]).toEqual([403, 'under_minimum_age']);
		expect(await row('bd1')).toBeNull();
		await put('bd1', bornYearsAgo(20));
		expect((await put('bd1', bornYearsAgo(10))).status).toBe(403);
		expect((await get('bd1')).body.birthDate).toBe(bornYearsAgo(20));
	});

	it('the same band or a younger one; never an older one', async () => {
		expect((await put('bd1', bornYearsAgo(14, 40))).status).toBe(200);
		expect((await put('bd1', bornYearsAgo(15, 40))).status).toBe(200);
		for (const older of [16, 17, 18, 40]) {
			const r = await put('bd1', bornYearsAgo(older, 40));
			expect([r.status, r.body.error]).toEqual([409, 'older_age_refused']);
			expect(r.text).not.toMatch(/\d{4}-\d\d/);
		}
		expect((await get('bd1')).body.birthDate).toBe(bornYearsAgo(15, 40));
		await seedUser('bd4');
		expect((await put('bd4', bornYearsAgo(30))).status).toBe(200);
		expect((await put('bd4', bornYearsAgo(17, 40))).status).toBe(200);
		expect((await put('bd4', bornYearsAgo(30))).status).toBe(409);
	});

	it('two first entries at once: one wins, and the other can’t use it to become older', async () => {
		const results = await Promise.all([put('bd1', bornYearsAgo(14, 40)), put('bd1', bornYearsAgo(30))]);
		const kept = (await get('bd1')).body.birthDate;
		expect(results.filter((r) => r.status === 200 || r.status === 409)).toHaveLength(2);
		if (results[0]!.status === 200) expect(kept).toBe(bornYearsAgo(14, 40));
		// A write against a row that has changed since it was read does nothing
		const now = await readBirthDate(E as unknown as BirthDateEnv, 'bd1');
		expect(await writeBirthDate(E as unknown as BirthDateEnv, 'bd1', '1990-01-02', { ...now!, changedAt: now!.changedAt - 1 })).toBe(false);
		expect(await writeBirthDate(E as unknown as BirthDateEnv, 'bd1', '1990-01-02', null)).toBe(false);
		expect((await get('bd1')).body.birthDate).toBe(kept);
	});

	it('a missing key fails every request that needs it, and never reads as "no date"', async () => {
		await put('bd1', '1990-01-02');
		E.PROFILE_DATA_KEY = undefined;
		for (const r of [await get('bd1'), await put('bd1', '1991-01-02')]) expect([r.status, r.body.error]).toEqual([503, 'temporarily_unavailable']);
		const exported = await call('/account/export', 'GET', await token('bd1'));
		expect(exported.status).toBe(503);
		E.PROFILE_DATA_KEY = KEY_B;
		expect((await get('bd1')).status).toBe(503);
		// Replacing the key: the old one reads, the new one writes
		E.PROFILE_DATA_KEY_PREVIOUS = KEY_A;
		expect((await get('bd1')).body.birthDate).toBe('1990-01-02');
		expect((await put('bd1', '1991-01-02')).status).toBe(200);
		expect((await row('bd1'))!.key_id).toBe(await keyIdOf(KEY_B));
		E.PROFILE_DATA_KEY_PREVIOUS = undefined;
		expect((await get('bd1')).body.birthDate).toBe('1991-01-02');
	});

	it('a row moved to another account doesn’t open there', async () => {
		await put('bd1', '1990-01-02');
		const r = (await row('bd1'))!;
		await seedUser('bd5');
		await E.AUTH_DB.prepare('INSERT INTO user_birth_dates (user_id, birth_date_enc, key_id, changed_at) VALUES (?, ?, ?, ?)').bind('bd5', r.birth_date_enc, r.key_id, r.changed_at).run();
		expect((await get('bd5')).status).toBe(503);
	});

	it('is rate limited per person', async () => {
		const keys: string[] = [];
		E.BIRTH_DATE_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as RateLimit;
		const r = await put('bd1', '1990-01-02');
		expect([r.status, r.body.error, r.headers.get('Retry-After')]).toEqual([429, 'rate_limited', '60']);
		expect(keys).toEqual(['birth-date:bd1']);
		expect(await row('bd1')).toBeNull();
	});

	it('no date, age or band in any log line', async () => {
		const lines: string[] = [];
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args))));
		try {
			await put('bd1', '1987-06-05');
			await put('bd1', '1986-06-05');
			await put('bd1', bornYearsAgo(10));
			E.PROFILE_DATA_KEY = undefined;
			await get('bd1');
		} finally {
			for (const s of spies) s.mockRestore();
		}
		expect(lines.join('\n')).not.toMatch(/1987|1986|06-05|18_plus|13_15/);
		expect(redactLogValue({ birth_date: '1987-06-05', dob: 'x', age_band: '18_plus', birthDate: 'y' })).toEqual({ birth_date: '[redacted]', dob: '[redacted]', age_band: '[redacted]', birthDate: '[redacted]' });
	});

	it('the export has it; DELETE /account removes it at once', async () => {
		await put('bd1', '1990-01-02');
		const exported = await call('/account/export', 'GET', await token('bd1'));
		expect([exported.status, exported.body.birthDate]).toEqual([200, '1990-01-02']);
		await seedUser('bd6');
		expect((await call('/account/export', 'GET', await token('bd6'))).body.birthDate).toBeNull();
		expect((await call('/account', 'DELETE', await token('bd1'))).status).toBe(200);
		expect(await row('bd1')).toBeNull();
		expect((await put('bd1', '1990-01-02')).status).toBe(401);
		expect(await writeBirthDate(E as unknown as BirthDateEnv, 'bd1', '1990-01-02', null)).toBe(false);
	});

	it('the admin purge removes it', async () => {
		await seedUser('bd7');
		await put('bd7', '1990-01-02');
		await E.AUTH_DB.prepare(`UPDATE users SET status = 'deleted', deleted_at = ? WHERE id = 'bd7'`).bind(Date.now()).run();
		await HANDLERS.user.purge(E as DeletionEnv, { kind: 'user', item_id: 'bd7', tenant_id: 'default', label: 'bd7@example.com', deleted_at: Date.now(), deleted_by: 'test', reason: null, snapshot: null } as never);
		expect(await row('bd7')).toBeNull();
	});
});
