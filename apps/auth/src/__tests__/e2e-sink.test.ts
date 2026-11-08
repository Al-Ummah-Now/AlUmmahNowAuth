/**
 * E2E email-code sink and test-route gate (utils/e2e-sink.ts).
 *
 * The sink must never activate in production: every condition is tested on its
 * own, including "production env with the secret bound by mistake".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isAuthorizedTestRequest, isE2EAddress, shouldSinkCode, sinkKey, type E2ESinkEnv } from '../utils/e2e-sink';
import { routeTestEndpoints } from '../routes/test-routes';

const sendEmailMock = vi.fn();
vi.mock('../email', () => ({
	default: (...args: unknown[]) => sendEmailMock(...args),
}));

import { createSendCodeHandler, type UserServiceLike } from '../handlers/auth-handlers';

const SECRET = 'e2e-secret-for-tests';
const E2E_EMAIL = 'signup-1@e2e.alummahnow.net';

function sinkEnv(overrides: Partial<E2ESinkEnv> = {}): E2ESinkEnv {
	return {
		AUTH_STORAGE: env.AUTH_STORAGE,
		ENVIRONMENT: 'qa',
		OPENAUTH_ISSUER: 'https://auth.qa.alummahnow.net',
		E2E_CODE_SINK_SECRET: { get: async () => SECRET },
		...overrides,
	};
}

describe('isE2EAddress', () => {
	it.each([
		[E2E_EMAIL, true],
		['UPPER@E2E.ALUMMAHNOW.NET', true],
		['user@alummahnow.net', false],
		['user@evil.e2e.alummahnow.net', false],
		['user@e2e.alummahnow.net.evil.com', false],
		['e2e.alummahnow.net', false],
	])('%s → %s', (email, expected) => {
		expect(isE2EAddress(email)).toBe(expected);
	});
});

describe('shouldSinkCode', () => {
	it('sinks E2E addresses on QA and stage', async () => {
		expect(await shouldSinkCode(sinkEnv(), E2E_EMAIL)).toBe(true);
		expect(
			await shouldSinkCode(sinkEnv({ ENVIRONMENT: 'stage', OPENAUTH_ISSUER: 'https://auth.stage.alummahnow.net' }), E2E_EMAIL)
		).toBe(true);
	});

	it('never sinks in production, even with the secret bound', async () => {
		expect(
			await shouldSinkCode(sinkEnv({ ENVIRONMENT: 'production', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' }), E2E_EMAIL)
		).toBe(false);
	});

	it('never sinks when the issuer is the production issuer, whatever ENVIRONMENT says', async () => {
		expect(await shouldSinkCode(sinkEnv({ ENVIRONMENT: 'stage', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' }), E2E_EMAIL)).toBe(false);
	});

	it.each([undefined, '', 'test', 'prod'])('never sinks with ENVIRONMENT=%s', async (environment) => {
		expect(await shouldSinkCode(sinkEnv({ ENVIRONMENT: environment }), E2E_EMAIL)).toBe(false);
	});

	it('does not sink without the secret binding, or when it fails to resolve', async () => {
		expect(await shouldSinkCode(sinkEnv({ E2E_CODE_SINK_SECRET: undefined }), E2E_EMAIL)).toBe(false);
		expect(
			await shouldSinkCode(sinkEnv({ E2E_CODE_SINK_SECRET: { get: async () => { throw new Error('denied'); } } }), E2E_EMAIL)
		).toBe(false);
	});

	it('does not sink real addresses', async () => {
		expect(await shouldSinkCode(sinkEnv(), 'someone@gmail.com')).toBe(false);
	});
});

describe('isAuthorizedTestRequest', () => {
	const req = (secret?: string) => new Request('https://auth.qa.alummahnow.net/test/email/x', { headers: secret ? { 'X-E2E-Secret': secret } : {} });

	it('accepts the right secret and rejects anything else', async () => {
		expect(await isAuthorizedTestRequest(sinkEnv(), req(SECRET))).toBe(true);
		expect(await isAuthorizedTestRequest(sinkEnv(), req('wrong'))).toBe(false);
		expect(await isAuthorizedTestRequest(sinkEnv(), req())).toBe(false);
	});

	it('rejects the right secret in production', async () => {
		const prod = sinkEnv({ ENVIRONMENT: 'production', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' });
		expect(await isAuthorizedTestRequest(prod, req(SECRET))).toBe(false);
	});
});

describe('test routes', () => {
	const ctx = { waitUntil: vi.fn() };
	const routesEnv = () => ({ ...sinkEnv(), AUTH_DB: env.AUTH_DB });

	beforeEach(async () => {
		await env.AUTH_STORAGE.put(sinkKey(E2E_EMAIL), JSON.stringify({ code: '424242', at: Date.now() }));
	});

	it('returns 404 for every /test/* route without the secret (no unauthenticated KV dump)', async () => {
		for (const path of ['/test/email/x', '/test/debug/kv', '/test/debug/roles', '/test/debug/clients']) {
			const res = await routeTestEndpoints(new Request(`https://auth.qa.alummahnow.net${path}`), routesEnv(), ctx, false);
			expect(res?.status, path).toBe(404);
		}
	});

	it('serves the sinked code with the secret', async () => {
		const res = await routeTestEndpoints(
			new Request(`https://auth.qa.alummahnow.net/test/email/${encodeURIComponent(E2E_EMAIL)}`, { headers: { 'X-E2E-Secret': SECRET } }),
			routesEnv(),
			ctx,
			false
		);
		expect(res?.status).toBe(200);
		expect(await res!.json()).toMatchObject({ code: '424242' });
	});

	it('is not routed at all in production', async () => {
		const res = await routeTestEndpoints(
			new Request('https://auth.alummahnow.net/test/email/x', { headers: { 'X-E2E-Secret': SECRET } }),
			routesEnv(),
			ctx,
			true
		);
		expect(res).toBeNull();
	});

	it('ignores non-test paths', async () => {
		expect(await routeTestEndpoints(new Request('https://auth.qa.alummahnow.net/authorize'), routesEnv(), ctx, false)).toBeNull();
	});
});

describe('send-code handler with the sink', () => {
	const userService: UserServiceLike = {
		getUserByEmail: vi.fn(async () => null),
		createUser: vi.fn(),
		updateLastLogin: vi.fn(),
	};
	let ip = 0;

	function handler(overrides: Record<string, unknown> = {}) {
		ip += 1;
		const url = new URL('https://auth.qa.alummahnow.net/password/register');
		const request = new Request(url, { method: 'POST', headers: { 'CF-Connecting-IP': `198.51.100.${ip}` } });
		return createSendCodeHandler(userService, {
			request,
			env: { ...sinkEnv(), RESEND_API_KEY: 're_test_key', ...overrides },
			ctx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
			requestId: 'sink-test',
			url,
		});
	}

	beforeEach(() => {
		sendEmailMock.mockReset();
		sendEmailMock.mockResolvedValue({ success: true, emailId: 'email-1' });
	});

	it('stores the code instead of emailing an E2E address on QA', async () => {
		await expect(handler()(E2E_EMAIL, '135790')).resolves.toBeUndefined();
		expect(sendEmailMock).not.toHaveBeenCalled();
		expect(JSON.parse((await env.AUTH_STORAGE.get(sinkKey(E2E_EMAIL)))!)).toMatchObject({ code: '135790' });
	});

	it('still fails like prod when RESEND_API_KEY is missing (incident 2026-11-07)', async () => {
		await expect(handler({ RESEND_API_KEY: undefined })('missing-key@e2e.alummahnow.net', '111111')).resolves.toEqual({
			type: 'code_send_failed',
		});
		expect(await env.AUTH_STORAGE.get(sinkKey('missing-key@e2e.alummahnow.net'))).toBeNull();
	});

	it('emails E2E addresses in production', async () => {
		const prod = { ENVIRONMENT: 'production', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' };
		await handler(prod)('prod-check@e2e.alummahnow.net', '222222');
		expect(sendEmailMock).toHaveBeenCalledTimes(1);
		expect(await env.AUTH_STORAGE.get(sinkKey('prod-check@e2e.alummahnow.net'))).toBeNull();
	});
});
