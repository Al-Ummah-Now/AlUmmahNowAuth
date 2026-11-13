import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { authTarget, mintSetupLink, newTicket, SETUP_TICKET_TTL_MS } from '../setup-link.ts';
import type { CfClient } from '../../release/cf-api.ts';

const repoRoot = resolve(__dirname, '../../..');

function fakeCf(users: { id: string; status: string }[]) {
	const calls: { sql: string; params: unknown[] }[] = [];
	const cf: CfClient = {
		accountId: 'acct',
		async request<T>(_method: string, _path: string, body?: unknown): Promise<T> {
			const { sql, params } = body as { sql: string; params: unknown[] };
			calls.push({ sql, params });
			return [{ results: sql.startsWith('SELECT') ? users : [] }] as T;
		},
	};
	return { cf, calls };
}

describe('setup-link (owner break-glass)', () => {
	it('stores only the SHA-256 of the token, as createSetupTicket does', () => {
		const { token, hash } = newTicket();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
	});

	it('targets each environment’s AUTH_DB and auth host', () => {
		expect(authTarget('production', repoRoot).host).toBe('auth.alummahnow.net');
		expect(authTarget('stage', repoRoot).host).toBe('auth.stage.alummahnow.net');
		expect(authTarget('qa', repoRoot)).toEqual({ db: '28590f3c-dd92-4c26-a803-d73a9bbe2b58', host: 'auth.qa.alummahnow.net' });
	});

	it('looks the user up by lower(email) and inserts one 24-hour ticket', async () => {
		const { cf, calls } = fakeCf([{ id: 'usr_owner', status: 'active' }]);
		const now = 1_800_000_000_000;
		const { link, userId, expiresAt } = await mintSetupLink(cf, { db: 'db1', host: 'auth.qa.alummahnow.net' }, ' Owner@Example.com ', now);
		expect(userId).toBe('usr_owner');
		expect(expiresAt).toBe(now + SETUP_TICKET_TTL_MS);
		expect(calls[0].sql).toContain('WHERE lower(email) = ?1');
		expect(calls[0].params).toEqual(['owner@example.com']);
		expect(calls[1].sql).toMatch(/^INSERT INTO passkey_setup_tickets/);
		const token = new URL(link).searchParams.get('ticket')!;
		expect(calls[1].params).toEqual([createHash('sha256').update(token).digest('hex'), 'usr_owner', 'break-glass', now, expiresAt]);
		expect(link.startsWith('https://auth.qa.alummahnow.net/passkeys/setup?ticket=')).toBe(true);
	});

	it('refuses unknown, ambiguous and suspended accounts without writing', async () => {
		for (const users of [[], [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }], [{ id: 'a', status: 'suspended' }]]) {
			const { cf, calls } = fakeCf(users);
			await expect(mintSetupLink(cf, { db: 'db1', host: 'h' }, 'x@example.com')).rejects.toThrow();
			expect(calls).toHaveLength(1);
		}
	});
});
