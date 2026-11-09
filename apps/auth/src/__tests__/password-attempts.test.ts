/**
 * AU-2: attempt counters for email codes and password sign-in, against the real
 * (miniflare) D1 with the real migration. The concurrency tests fire hundreds of
 * attempts at once and assert that no more than the limit get through.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import {
	checkCode,
	recordCode,
	reserveLoginAttempt,
	releaseLoginAttempt,
	purgeExpiredAttempts,
	MAX_CODE_ATTEMPTS,
	MAX_CODE_ATTEMPTS_PER_HOUR,
	MAX_LOGIN_FAILURES,
	CODE_TTL_SECONDS,
	LOGIN_WINDOW_SECONDS,
} from '../security/password-attempts';

const db = () => env.AUTH_DB;
const RIGHT = '314159';
const WRONG = '000000';

beforeEach(async () => {
	await db().prepare('DELETE FROM password_codes').run();
	await db().prepare('DELETE FROM password_login_attempts').run();
});

describe('email codes', () => {
	it('accepts the right code once (single use)', async () => {
		await recordCode(db(), 'a@example.com', RIGHT);
		expect(await checkCode(db(), 'a@example.com', RIGHT)).toBe('ok');
		expect(await checkCode(db(), 'a@example.com', RIGHT)).toBe('locked');
	});

	it('is case-insensitive on the email', async () => {
		await recordCode(db(), 'Mixed@Example.com', RIGHT);
		expect(await checkCode(db(), 'mixed@example.com', RIGHT)).toBe('ok');
	});

	it(`locks after ${MAX_CODE_ATTEMPTS} wrong guesses, even for the right code`, async () => {
		await recordCode(db(), 'b@example.com', RIGHT);
		for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) expect(await checkCode(db(), 'b@example.com', WRONG)).toBe('wrong');
		expect(await checkCode(db(), 'b@example.com', RIGHT)).toBe('locked');
	});

	it('expires after 15 minutes', async () => {
		const t = 1_800_000_000;
		await recordCode(db(), 'c@example.com', RIGHT, t);
		expect(CODE_TTL_SECONDS).toBe(900);
		expect(await checkCode(db(), 'c@example.com', RIGHT, t + CODE_TTL_SECONDS)).toBe('locked');
	});

	it('rejects a code that was never sent, without telling unknown emails apart', async () => {
		// 'wrong' (not 'locked'): an unknown account answers like a known one with a wrong guess
		expect(await checkCode(db(), 'never@example.com', RIGHT)).toBe('wrong');
	});

	it('a new code resets the per-code attempts but not the hourly cap', async () => {
		const t = 1_800_000_000;
		let guesses = 0;
		for (let round = 0; round < 10; round++) {
			await recordCode(db(), 'd@example.com', RIGHT, t + round);
			for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
				if ((await checkCode(db(), 'd@example.com', WRONG, t + round)) !== 'locked') guesses++;
			}
		}
		expect(guesses).toBe(MAX_CODE_ATTEMPTS_PER_HOUR);
		// An hour later the cap is open again
		await recordCode(db(), 'd@example.com', RIGHT, t + 3601);
		expect(await checkCode(db(), 'd@example.com', RIGHT, t + 3601)).toBe('ok');
	});

	it(`500 parallel wrong guesses: exactly ${MAX_CODE_ATTEMPTS} are counted, the rest locked, and the code dies`, async () => {
		await recordCode(db(), 'e@example.com', RIGHT);
		const results = await Promise.all(Array.from({ length: 500 }, () => checkCode(db(), 'e@example.com', WRONG)));
		expect(results.filter((r) => r === 'wrong').length).toBe(MAX_CODE_ATTEMPTS);
		expect(results.filter((r) => r === 'locked').length).toBe(500 - MAX_CODE_ATTEMPTS);
		expect(await checkCode(db(), 'e@example.com', RIGHT)).toBe('locked');
	});

	it('500 parallel guesses that include the right code many times: at most one ok, at most 5 checked', async () => {
		await recordCode(db(), 'f@example.com', RIGHT);
		const guesses = Array.from({ length: 500 }, (_, i) => (i % 7 === 0 ? RIGHT : WRONG));
		const results = await Promise.all(guesses.map((g) => checkCode(db(), 'f@example.com', g)));
		expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(1);
		expect(results.filter((r) => r !== 'locked').length).toBeLessThanOrEqual(MAX_CODE_ATTEMPTS);
	});
});

describe('password sign-in slots', () => {
	it(`300 parallel sign-ins for one email: exactly ${MAX_LOGIN_FAILURES} get a slot`, async () => {
		const results = await Promise.all(Array.from({ length: 300 }, () => reserveLoginAttempt(db(), 'g@example.com')));
		expect(results.filter(Boolean).length).toBe(MAX_LOGIN_FAILURES);
	});

	it('a successful sign-in gives its slot back; failures stay counted', async () => {
		for (let i = 0; i < MAX_LOGIN_FAILURES - 1; i++) expect(await reserveLoginAttempt(db(), 'h@example.com')).toBe(true);
		expect(await reserveLoginAttempt(db(), 'h@example.com')).toBe(true);
		await releaseLoginAttempt(db(), 'h@example.com');
		expect(await reserveLoginAttempt(db(), 'h@example.com')).toBe(true);
		expect(await reserveLoginAttempt(db(), 'h@example.com')).toBe(false);
	});

	it('the window reopens after 15 minutes', async () => {
		const t = 1_800_000_000;
		for (let i = 0; i < MAX_LOGIN_FAILURES; i++) await reserveLoginAttempt(db(), 'i@example.com', t);
		expect(await reserveLoginAttempt(db(), 'i@example.com', t + 1)).toBe(false);
		expect(await reserveLoginAttempt(db(), 'i@example.com', t + LOGIN_WINDOW_SECONDS)).toBe(true);
	});

	it('emails are limited independently', async () => {
		for (let i = 0; i < MAX_LOGIN_FAILURES; i++) await reserveLoginAttempt(db(), 'j@example.com');
		expect(await reserveLoginAttempt(db(), 'j@example.com')).toBe(false);
		expect(await reserveLoginAttempt(db(), 'k@example.com')).toBe(true);
	});
});

describe('purge', () => {
	it('drops rows that no longer limit anything and keeps live ones', async () => {
		const t = 1_800_000_000;
		await recordCode(db(), 'old@example.com', RIGHT, t - 7200);
		await checkCode(db(), 'old@example.com', WRONG, t - 7200);
		await recordCode(db(), 'live@example.com', RIGHT, t);
		await reserveLoginAttempt(db(), 'old@example.com', t - 3600);
		await reserveLoginAttempt(db(), 'live@example.com', t);
		await purgeExpiredAttempts(db(), t);
		const codes = await db().prepare('SELECT email FROM password_codes ORDER BY email').all();
		const logins = await db().prepare('SELECT email FROM password_login_attempts ORDER BY email').all();
		expect(codes.results.map((r) => r.email)).toEqual(['live@example.com']);
		expect(logins.results.map((r) => r.email)).toEqual(['live@example.com']);
	});
});
