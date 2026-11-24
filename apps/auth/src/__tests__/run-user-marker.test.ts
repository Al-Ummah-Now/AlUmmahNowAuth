/** Run accounts an admin creates get the run marker, so the run's teardown can delete them. */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { setupDatabase } from '../test-setup';
import { markCreatedRunUser } from '../custom/run-user-marker';
import { RUN_USERS_FLAG } from '../utils/e2e-sink';

const ENV = env as unknown as Env;
const RUN = 'e2e+45300752822-1-new-user-mwu03zva-7jewoq@e2e.alummahnow.net';
const qa = {
	...ENV,
	ENVIRONMENT: 'qa',
	OPENAUTH_ISSUER: 'https://auth.qa.alummahnow.net',
	E2E_RUN_USERS: RUN_USERS_FLAG,
	E2E_CODE_SINK_SECRET: { get: async () => 'sink' },
	TEST_PROMOTE_SECRET: 'promote-secret-for-tests-0123456789',
};

/** The admin app's shape: the middleware, then a route that creates the user. */
async function create(e: object, email: string, status: 201 | 409 = 201) {
	const app = new Hono();
	app.use('/', markCreatedRunUser(e as never));
	app.post('/', async (c) => {
		if (status !== 201) return c.json({ error: 'email_already_exists' }, status);
		const now = Date.now();
		await ENV.AUTH_DB.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at, password_reset_required) VALUES ('u1', 'default', ?, 'active', ?, ?, 0)`)
			.bind(email, now, now)
			.run();
		return c.json({ id: 'u1', email }, 201);
	});
	const res = await app.request('/', { method: 'POST' });
	const body = await res.json();
	const row = await ENV.AUTH_DB.prepare(`SELECT json_extract(metadata, '$.e2eRun.via') AS via FROM users WHERE id = 'u1'`).first<{ via: string | null }>();
	return { res, body, via: row?.via ?? null };
}

beforeEach(async () => {
	await setupDatabase();
	await ENV.AUTH_DB.prepare('DELETE FROM users').run();
});

describe('markCreatedRunUser', () => {
	it('marks a run account and leaves the answer as it was', async () => {
		const { res, body, via } = await create(qa, RUN);
		expect(via).toBe('admin-create');
		expect(res.status).toBe(201);
		expect(body).toEqual({ id: 'u1', email: RUN });
	});

	it.each([
		['a person', qa, 'someone@example.com'],
		['an old-style test address', qa, 'new-user-1795461009517-1b6pqu@e2e.alummahnow.net'],
		['a seeded account', qa, 'qa-admin@e2e.alummahnow.net'],
		['production', { ...qa, ENVIRONMENT: 'production', OPENAUTH_ISSUER: 'https://auth.alummahnow.net' }, RUN],
		['a deployment without run-account support', { ...qa, E2E_RUN_USERS: undefined }, RUN],
	])('never marks: %s', async (_name, e, email) => {
		expect((await create(e, email)).via).toBeNull();
	});

	it('does nothing when the create fails', async () => {
		const { res, body } = await create(qa, RUN, 409);
		expect(res.status).toBe(409);
		expect(body).toEqual({ error: 'email_already_exists' });
	});
});
