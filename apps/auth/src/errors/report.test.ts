/** Auth errors reach the videos admin Errors page (AlUmmahNowAuth#341). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildErrorEvent, newErrorRef, reportAuthError, resetErrorReporter, sendEvents } from './report';
import { logger } from '../logger';

const env = { ERRORS_INGEST_URL: 'https://admin.api.qa.alummahnow.net/internal/errors', INTERNAL_API_KEY: 'k', ENVIRONMENT: 'qa' };

describe('auth error reporter', () => {
	beforeEach(() => resetErrorReporter());

	it('posts one auth event with the message, stack and reference to the ingest, with the internal key', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const waits: Promise<unknown>[] = [];
		const ref = reportAuthError(env, { waitUntil: (p) => waits.push(p) }, new Error('D1_ERROR: storage unavailable'), { route: '/authorize', method: 'GET', requestId: 'r1' }, fetchImpl as unknown as typeof fetch);
		await Promise.all(waits);
		expect(ref).toMatch(/^ERR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(env.ERRORS_INGEST_URL);
		expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
		const { events } = JSON.parse(String(init.body));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ app: 'auth', kind: 'unhandled', ref, message: 'D1_ERROR: storage unavailable', route: '/authorize', status: 500, environment: 'qa' });
		expect(events[0].stack).toContain('D1_ERROR');
	});

	it('repeats within 10 s are folded into the next report, not sent', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		for (let i = 0; i < 5; i++) reportAuthError(env, undefined, new Error('boom 1'), { route: '/token' }, fetchImpl as unknown as typeof fetch);
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('never sends emails or tokens; never throws; without an ingest URL nothing is sent', async () => {
		const e = buildErrorEvent(new Error('no user someone@example.com token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfMSJ9.abcdefghijk'), {}, env);
		expect(e.message).not.toContain('someone@example.com');
		expect(e.message).not.toContain('eyJhbGci');
		const fetchImpl = vi.fn();
		expect(reportAuthError({}, undefined, new Error('x'), {}, fetchImpl as unknown as typeof fetch)).toMatch(/^ERR-/);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(() => reportAuthError(env, { waitUntil: () => { throw new Error('no ctx'); } }, new Error('y'), {}, (() => { throw new Error('net'); }) as unknown as typeof fetch)).not.toThrow();
		expect(newErrorRef()).not.toBe(newErrorRef());
	});

	it('without the key or URL it says so loudly, once per isolate, instead of dropping silently', async () => {
		const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		const fetchImpl = vi.fn();
		expect(await sendEvents({ ...env, INTERNAL_API_KEY: undefined }, [buildErrorEvent(new Error('a'), {}, env)], fetchImpl as unknown as typeof fetch)).toBe('no-key');
		expect(await sendEvents({ ...env, INTERNAL_API_KEY: undefined }, [buildErrorEvent(new Error('b'), {}, env)], fetchImpl as unknown as typeof fetch)).toBe('no-key');
		reportAuthError({ ENVIRONMENT: 'qa' }, undefined, new Error('c'));
		expect(fetchImpl).not.toHaveBeenCalled();
		const warnings = spy.mock.calls.filter(([m]) => String(m).startsWith('ERROR REPORTING DISABLED'));
		expect(warnings).toHaveLength(1);
		spy.mockRestore();
	});

	it('a probe event is marked test (never alerts)', () => {
		expect(buildErrorEvent(new Error('probe'), { test: true }, env).test).toBe(true);
		expect(buildErrorEvent(new Error('real'), {}, env).test).toBeUndefined();
	});
});
