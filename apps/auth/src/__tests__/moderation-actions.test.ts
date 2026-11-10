/**
 * The account actions an approved moderation request runs (moderation/actions.ts),
 * for real against D1: users that exist only in D1 (AU-3) are found and changed.
 * Regression: the runner used OpenAuth's KV-only user service, so deleting a
 * D1-only account "succeeded" as already deleted and left it active.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import { createActionRunner } from '../moderation/actions';

const E = () => env as unknown as Env;

async function user(id: string) {
	const now = Date.now();
	await E().AUTH_DB.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES (?, 'default', ?, 'active', ?, ?)`)
		.bind(id, `${id}@example.com`, now, now)
		.run();
}
const row = (id: string) =>
	E().AUTH_DB.prepare('SELECT status, deleted_at, password_reset_required FROM users WHERE id = ?').bind(id).first<{ status: string; deleted_at: number | null; password_reset_required: number }>();

describe('moderation actions on D1-only accounts', () => {
	beforeAll(async () => {
		await setupDatabase();
		for (const id of ['usr_mod_delete', 'usr_mod_suspend', 'usr_mod_reset', 'usr_mod_sessions']) await user(id);
	});

	it('deletes the account (soft delete in D1)', async () => {
		const outcome = await createActionRunner(E())('delete_account', 'usr_mod_delete', 'default');
		expect(outcome.ok).toBe(true);
		expect(outcome).not.toMatchObject({ result: { alreadyDeleted: true } });
		const r = await row('usr_mod_delete');
		expect(r?.deleted_at).not.toBeNull();
		// A second delivery: already gone counts as done
		expect(await createActionRunner(E())('delete_account', 'usr_mod_delete', 'default')).toMatchObject({ ok: true, result: { alreadyDeleted: true } });
	});

	it('suspends the account', async () => {
		expect((await createActionRunner(E())('suspend_account', 'usr_mod_suspend', 'default')).ok).toBe(true);
		expect((await row('usr_mod_suspend'))?.status).toBe('suspended');
	});

	it('requires a password reset', async () => {
		expect((await createActionRunner(E())('require_password_reset', 'usr_mod_reset', 'default')).ok).toBe(true);
		expect((await row('usr_mod_reset'))?.password_reset_required).toBe(1);
	});

	it('ends every session', async () => {
		expect((await createActionRunner(E())('revoke_sessions', 'usr_mod_sessions', 'default')).ok).toBe(true);
	});

	it('a missing account fails permanently (except delete)', async () => {
		expect(await createActionRunner(E())('suspend_account', 'usr_nobody', 'default')).toMatchObject({ ok: false, permanent: true });
	});
});
