/** Auth errors reach the videos admin Errors page (AlUmmahNowAuth#341). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildErrorEvent, newErrorRef, reportAuthError, resetErrorReporter } from './report';

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
});
