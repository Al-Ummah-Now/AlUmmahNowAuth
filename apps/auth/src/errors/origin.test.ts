/** Auth error origin (AlUmmahNow request-origin model): classified, nothing raw kept. */
import { describe, expect, it } from 'vitest';
import { buildErrorEvent } from './report';
import { requestOrigin, routeTemplate } from './origin';

const env = { ERRORS_INGEST_URL: 'https://admin.api.qa.alummahnow.net/internal/errors', INTERNAL_API_KEY: 'k', ENVIRONMENT: 'qa' };

describe('auth request origin', () => {
	it('a native app names itself; ids leave the route template', () => {
		const req = new Request('https://auth.alummahnow.net/admin/users/usr_9ace4771/roles', {
			headers: { 'x-aun-client': 'aun-android/2.1.0 (Android 15)', 'cf-connecting-ip': '203.0.113.9' },
		});
		expect(requestOrigin(req)).toEqual({ surface: 'android', app: 'aun-android', appVersion: '2.1.0', source: 'direct', entry: '/admin/users/:id/roles', device: 'phone' });
		expect(routeTemplate('/password/authorize')).toBe('/password/authorize');
	});

	it('a browser: surface, device and source from the referrer host only; no UA, IP or query kept', () => {
		const req = new Request('https://auth.alummahnow.net/password/authorize?client_id=x&state=secret', {
			headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Mobile/15E148', referer: 'https://videos.alummahnow.net/en?token=abc' },
		});
		const o = requestOrigin(req)!;
		expect(o).toEqual({ surface: 'web', source: 'platform', referrerHost: 'videos.alummahnow.net', entry: '/password/authorize', device: 'phone' });
		for (const leak of ['Mozilla', 'secret', 'abc', '203.0.113']) expect(JSON.stringify(o)).not.toContain(leak);
	});

	it('the error event carries it in its context', () => {
		const req = new Request('https://auth.alummahnow.net/token', { headers: { 'user-agent': 'curl/8.4.0' } });
		const e = buildErrorEvent(new Error('D1_ERROR: x'), { request: req }, env);
		expect(e.context).toEqual({ upstream: { service: 'd1' }, origin: { surface: 'bot', source: 'direct', entry: '/token', device: 'unknown' } });
		expect(buildErrorEvent(new Error('x'), {}, env).context).toBeUndefined();
	});
});
