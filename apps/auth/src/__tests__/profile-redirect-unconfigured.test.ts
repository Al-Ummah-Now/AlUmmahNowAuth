/**
 * `/` and `/docs` redirect to the profile app. Without PROFILE_APP_URL they
 * answer a plain 404 like any unknown path: a feature that config turns off is
 * hidden, never a "Profile app URL not configured" message.
 */
import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';

const PROFILE = 'https://profile.auth.test/';

async function get(path: string, extra: Record<string, unknown>) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`https://auth.test${path}`, { redirect: 'manual' }), { ...(env as object), ...extra } as never, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('/ and /docs', () => {
	it.each(['/', '/docs'])('%s redirects to the profile app when PROFILE_APP_URL is set', async (path) => {
		const res = await get(path, { PROFILE_APP_URL: PROFILE });
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe(PROFILE);
	});

	it.each(['/', '/docs'])('%s answers a quiet 404 when PROFILE_APP_URL is missing', async (path) => {
		const res = await get(path, { PROFILE_APP_URL: '' });
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).toBe('Not found');
		expect(body).not.toMatch(/configured/i);
	});
});
