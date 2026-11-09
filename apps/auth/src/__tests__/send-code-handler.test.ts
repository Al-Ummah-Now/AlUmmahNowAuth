/**
 * Tests for the password provider's sendCode callback (createSendCodeHandler).
 *
 * Regression coverage for the "Forgot password?" bug: submitting an unknown
 * email on /password/change used to throw, which escaped the provider and
 * bounced the browser to the client app with server_error (and enumerated
 * accounts). An unknown email must now be a silent no-op so the provider
 * moves to the "enter code" screen exactly as it does for a real account.
 *
 * Delivery failures (Resend error, invalid address, missing secret, rate limit)
 * must return { type: 'code_send_failed' } instead of throwing, so the provider
 * re-renders the same form with a localized error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { fakeLimiter } from './helpers/fake-limiter';
import { MemoryStorage } from '@al-ummah-now/openauth/storage/memory';
import { Storage } from '@al-ummah-now/openauth/storage/storage';

const sendEmailMock = vi.fn();
vi.mock('../email', () => ({
	default: (...args: unknown[]) => sendEmailMock(...args),
}));

import { createSendCodeHandler, type UserServiceLike } from '../handlers/auth-handlers';

const KNOWN_USER_EMAIL = 'known-user@example.com';
const PASSWORD_ONLY_EMAIL = 'password-only@example.com';
const UNKNOWN_EMAIL = 'nobody@example.com';

function makeUserService(): UserServiceLike {
	return {
		getUserByEmail: vi.fn(async (_tenantId: string, email: string) =>
			email === KNOWN_USER_EMAIL ? { id: 'user-1', email } : null
		),
		createUser: vi.fn(),
		updateLastLogin: vi.fn(),
	};
}

let ipCounter = 0;

function makeHandler(
	pathname: string,
	userService: UserServiceLike,
	storage?: ReturnType<typeof MemoryStorage>,
	options: { resendApiKey?: string; ip?: string; limiter?: RateLimit } = { resendApiKey: 'test-resend-key' }
) {
	// Unique IP per handler, so a limiter shared between handlers never carries over
	ipCounter += 1;
	const url = new URL(`https://auth.example.com${pathname}`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'CF-Connecting-IP': options.ip ?? `203.0.113.${ipCounter}` },
	});
	const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
	return createSendCodeHandler(
		userService,
		{
			request,
			env: {
				AUTH_STORAGE: env.AUTH_STORAGE,
				AUTH_DB: env.AUTH_DB,
				SEND_CODE_LIMITER: options.limiter,
				RESEND_API_KEY: options.resendApiKey,
				ENVIRONMENT: 'test',
			},
			ctx,
			requestId: 'test-request',
			url,
		},
		storage
	);
}

describe('createSendCodeHandler', () => {
	let storage: ReturnType<typeof MemoryStorage>;

	beforeEach(async () => {
		sendEmailMock.mockReset();
		sendEmailMock.mockResolvedValue({ success: true, emailId: 'email-123' });
		storage = MemoryStorage();
		await Storage.set(storage, ['email', PASSWORD_ONLY_EMAIL, 'password'], {
			hash: 'h',
			salt: 's',
			iterations: 1,
		});
	});

	describe('password change flow (/password/change)', () => {
		it('does not throw and sends no email for an unknown email', async () => {
			const sendCode = makeHandler('/password/change', makeUserService(), storage);

			await expect(sendCode(UNKNOWN_EMAIL, '123456')).resolves.toBeUndefined();
			expect(sendEmailMock).not.toHaveBeenCalled();
		});

		it('sends a code to a user that exists in UserService', async () => {
			const sendCode = makeHandler('/password/change', makeUserService(), storage);

			await sendCode(KNOWN_USER_EMAIL, '123456');

			expect(sendEmailMock).toHaveBeenCalledTimes(1);
			expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: KNOWN_USER_EMAIL });
		});

		it('sends a code to an account that only has a password record', async () => {
			const userService = makeUserService();
			const sendCode = makeHandler('/password/change', userService, storage);

			await sendCode(PASSWORD_ONLY_EMAIL, '123456');

			expect(userService.getUserByEmail).toHaveBeenCalledWith('default', PASSWORD_ONLY_EMAIL);
			expect(sendEmailMock).toHaveBeenCalledTimes(1);
			expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: PASSWORD_ONLY_EMAIL });
		});

		it('still treats an unknown email as a no-op when no password storage is passed', async () => {
			const sendCode = makeHandler('/password/change', makeUserService());

			await expect(sendCode(UNKNOWN_EMAIL, '123456')).resolves.toBeUndefined();
			expect(sendEmailMock).not.toHaveBeenCalled();
		});

		it('returns code_send_failed (does not throw) when delivery fails for a real account', async () => {
			sendEmailMock.mockRejectedValueOnce(new Error('Resend down'));
			const sendCode = makeHandler('/password/change', makeUserService(), storage);

			await expect(sendCode(KNOWN_USER_EMAIL, '123456')).resolves.toEqual({
				type: 'code_send_failed',
			});
		});

		it('keeps an unknown email a silent no-op even when delivery would fail', async () => {
			sendEmailMock.mockRejectedValue(new Error('Resend down'));
			const sendCode = makeHandler('/password/change', makeUserService(), storage);

			await expect(sendCode(UNKNOWN_EMAIL, '123456')).resolves.toBeUndefined();
			expect(sendEmailMock).not.toHaveBeenCalled();
		});
	});

	describe('registration flow (/password/register)', () => {
		it('sends a code to a brand new email without any existence check', async () => {
			const userService = makeUserService();
			const sendCode = makeHandler('/password/register', userService, storage);

			await sendCode(UNKNOWN_EMAIL, '123456');

			expect(userService.getUserByEmail).not.toHaveBeenCalled();
			expect(sendEmailMock).toHaveBeenCalledTimes(1);
			expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: UNKNOWN_EMAIL });
		});

		it('returns code_send_failed when Resend rejects the address', async () => {
			sendEmailMock.mockRejectedValueOnce(
				new Error('Unable to send email after 3 attempts. Please try again later.')
			);
			const sendCode = makeHandler('/password/register', makeUserService(), storage);

			await expect(sendCode('x@example.com', '123456')).resolves.toEqual({
				type: 'code_send_failed',
			});
		});

		it('returns code_send_failed when RESEND_API_KEY is missing', async () => {
			const sendCode = makeHandler('/password/register', makeUserService(), storage, {
				resendApiKey: undefined,
			});

			await expect(sendCode(UNKNOWN_EMAIL, '123456')).resolves.toEqual({
				type: 'code_send_failed',
			});
			expect(sendEmailMock).not.toHaveBeenCalled();
		});

		it('returns code_send_failed once the rate limit is exceeded', async () => {
			const ip = '198.51.100.77';
			const limiter = fakeLimiter(5);
			const sendCode = makeHandler('/password/register', makeUserService(), storage, {
				resendApiKey: 'test-resend-key',
				ip,
				limiter: limiter as unknown as RateLimit,
			});

			// SEND_CODE_LIMITER (Workers Rate Limiting), keyed by client IP
			for (let i = 0; i < 5; i++) {
				await expect(sendCode(`user${i}@example.com`, '123456')).resolves.toBeUndefined();
			}
			await expect(sendCode('one-more@example.com', '123456')).resolves.toEqual({
				type: 'code_send_failed',
			});
			expect(sendEmailMock).toHaveBeenCalledTimes(5);
			expect([...limiter.counts.keys()]).toEqual([`ip:${ip}`]);
		});
	});
});

describe('createSendCodeHandler: code attempt record (AU-2)', () => {
	it('records the sent code so checkCode accepts it, and says 15 minutes in the email', async () => {
		const { checkCode } = await import('../security/password-attempts');
		sendEmailMock.mockReset();
		sendEmailMock.mockResolvedValue({ success: true, emailId: 'email-123' });
		const sendCode = makeHandler('/password/register', makeUserService());
		await sendCode('record-me@example.com', '424242');
		expect(sendEmailMock.mock.calls[0][0].text).toContain('15');
		expect(await checkCode(env.AUTH_DB, 'record-me@example.com', '111111')).toBe('wrong');
		expect(await checkCode(env.AUTH_DB, 'record-me@example.com', '424242')).toBe('ok');
		expect(await checkCode(env.AUTH_DB, 'record-me@example.com', '424242')).toBe('locked');
	});

	it('records nothing for an unknown account on password change', async () => {
		const { checkCode } = await import('../security/password-attempts');
		const sendCode = makeHandler('/password/change', makeUserService(), MemoryStorage());
		await sendCode('nobody-here@example.com', '424242');
		expect(await checkCode(env.AUTH_DB, 'nobody-here@example.com', '424242')).toBe('wrong');
	});
});
