import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { clientAdminRoutes } from '@al-ummah-now/openauth';
import { CLIENT_SCOPES } from '../../../../packages/auth-contract/client-scopes';
import { adminContextMiddleware, clientResponseCompatMiddleware } from '../custom/admin-context-middleware';
import '../test-setup';

it('accepts and persists the shared scope catalog through the client admin API', async () => {
	const app = new Hono();
	app.use('*', clientResponseCompatMiddleware);
	app.use('*', adminContextMiddleware);
	app.route('/', clientAdminRoutes(env.AUTH_DB));
	const jsonRequest = (method: string, body: object) => ({
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	const created = await app.request('/clients', jsonRequest('POST', {
		name: 'Scope Catalog Test',
		grant_types: ['client_credentials'],
		scopes: CLIENT_SCOPES,
	}));
	expect(created.status).toBe(201);
	const client = await created.json() as { client_id: string; scopes: string[] };
	expect(client.scopes).toEqual(CLIENT_SCOPES);

	const scopes = ['account-events:receive', 'account-exports:write', 'moderation:request', 'invites:provision', 'tokens:revoke'];
	const path = `/clients/${client.client_id}`;
	expect((await app.request(path, jsonRequest('PATCH', { scopes }))).status).toBe(200);
	const stored = await app.request(path);
	expect(stored.status).toBe(200);
	expect(await stored.json()).toMatchObject({ scopes });
});
