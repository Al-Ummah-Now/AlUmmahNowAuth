/**
 * The Fanous lantern street's files are served by Auth itself (same origin as the sign-in
 * pages), so the pages' CSP needs nothing new.
 */
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { STREET_CSS_PATH, STREET_JS_PATH, STREET_START_JS } from '../../../../packages/ui/src/fanous-street/index.ts';
import { STREET_CSS } from '../../../../packages/ui/src/fanous-street/street.generated.ts';

async function get(path: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://localhost:3301${path}`, { headers: { host: 'localhost:3301' } }), env as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('GET /fanous-street/*', () => {
	it('serves the start script and the styles, immutable', async () => {
		const js = await get(STREET_JS_PATH);
		expect(js.status).toBe(200);
		expect(js.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
		expect(js.headers.get('Cache-Control')).toContain('immutable');
		expect(await js.text()).toBe(STREET_START_JS);
		const css = await get(STREET_CSS_PATH);
		expect(css.status).toBe(200);
		expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
		expect(await css.text()).toBe(STREET_CSS);
	});

	it('answers 404 for any other file there', async () => {
		expect((await get('/fanous-street/start.000000000000.js')).status).toBe(404);
	});
});
