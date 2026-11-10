import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { purgeExpiredAppSessions } from '../services/app-sessions-cleanup';

const insert = (id: string, expiresAt: number, revokedAt: number | null = null) =>
	env.AUTH_DB.prepare(
		`INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, revoked_at, created_at, updated_at)
		 VALUES (?1, 'profile', '{}', 'a', 'r', ?2, ?3, 0, 0)`
	)
		.bind(id, expiresAt, revokedAt)
		.run();

describe('purgeExpiredAppSessions (PF-1)', () => {
	it('removes expired sessions and keeps live ones, logged-out ones included until they expire', async () => {
		await env.AUTH_DB.prepare('DELETE FROM app_sessions').run();
		const now = 1_800_000_000_000;
		await insert('expired', now - 1);
		await insert('expired-revoked', now - 1, now - 100);
		await insert('live', now + 60_000);
		await insert('live-revoked', now + 60_000, now - 100);
		expect(await purgeExpiredAppSessions(env.AUTH_DB, now)).toBe(2);
		const { results } = await env.AUTH_DB.prepare('SELECT id FROM app_sessions ORDER BY id').all();
		expect(results.map((r) => r.id)).toEqual(['live', 'live-revoked']);
	});
});
