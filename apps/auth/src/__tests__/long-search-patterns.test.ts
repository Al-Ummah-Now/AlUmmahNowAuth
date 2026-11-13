/**
 * Admin searches with text longer than D1's 50-byte LIKE pattern limit ("LIKE or GLOB pattern too
 * complex"): an E2E run account's address alone is longer. They match by substring (instr), never
 * fail with a 500 (#341 follow-up: GET /admin/users 500s on QA, seen on the Errors page).
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { InviteService } from '../invites/service';

const LONG = 'e2e+43400000000-1-admin-web-local-1-moderator@e2e.alummahnow.net';

describe('long admin search text', () => {
	it('invites: q longer than 50 bytes finds the invite, case-insensitively', async () => {
		await env.AUTH_DB.prepare(
			`INSERT OR REPLACE INTO user_invites (id, tenant_id, user_id, email, client_id, invited_by, created_at, updated_at, expires_at) VALUES ('inv_long1', 'default', 'usr_long1', ?, 'c', 'x', 1, 1, ?)`
		)
			.bind(LONG, Date.now() + 86_400_000)
			.run();
		const { invites } = await new InviteService(env.AUTH_DB).list({ q: LONG.toUpperCase() });
		expect(invites.map((i) => i.id)).toContain('inv_long1');
		await env.AUTH_DB.prepare(`DELETE FROM user_invites WHERE id = 'inv_long1'`).run();
	});
});
