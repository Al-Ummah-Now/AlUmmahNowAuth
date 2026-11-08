import { env } from 'cloudflare:test';

/** The apps' local OAuth clients, registered as in migrations/0004_seed_data.sql. */
export const PROFILE = { id: '109a1087-6626-40f7-8a7f-7f42f83f4f30', redirect: 'http://localhost:3302/callback' };
export const ADMIN = { id: '1448ed27-39a6-417d-b4c8-07f881e81269', redirect: 'http://localhost:5175/auth/callback' };

export async function registerTestClients() {
	const now = Date.now();
	for (const [c, name] of [
		[PROFILE, 'Profile Application'],
		[ADMIN, 'Auth Admin'],
	] as const) {
		await (env as unknown as Env).AUTH_DB.prepare(
			`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
			 VALUES (?, 'default', ?, 'test-hash', '["authorization_code","refresh_token"]', '[]', ?, '{}', 1, ?, ?)`
		)
			.bind(c.id, name, JSON.stringify([c.redirect]), now, now)
			.run();
	}
}
