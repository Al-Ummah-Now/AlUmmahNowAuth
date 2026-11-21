/**
 * The test-only debug routes answer a failure with a generic 500: the error's
 * own text (SQL, table names, stack details) goes to the log, never the body.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleTestDebugClients, handleTestDebugKV, handleTestDebugRoles } from '../routes/test-routes';

const LEAK = 'D1_ERROR: no such table: secret_table at offset 9: SQLITE_ERROR';
const ctx = { waitUntil: vi.fn() };
const failing = () => {
	throw new Error(LEAK);
};
const env = {
	AUTH_DB: { prepare: failing },
	AUTH_STORAGE: { list: async () => failing(), get: async () => null },
} as never;

describe('test debug routes on failure', () => {
	it.each([
		['GET /test/debug/kv', () => handleTestDebugKV(env, ctx as never)],
		['GET /test/debug/roles', () => handleTestDebugRoles(env, ctx as never)],
		['GET /test/debug/clients', () => handleTestDebugClients(env, ctx as never)],
		['GET /test/debug/clients/:id', () => handleTestDebugClients(env, ctx as never, 'some-client')],
	])('%s: 500 without the error text', async (_name, call) => {
		const res = await call();
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(JSON.parse(body)).toEqual({ error: 'Internal server error' });
		expect(body).not.toContain('secret_table');
	});
});
