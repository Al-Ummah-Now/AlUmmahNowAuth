/**
 * The browser-session adapter: what a sign-in writes, in how many D1 round trips (#314).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import { D1SessionAdapter } from '../adapters/session-adapter';

const E = env as unknown as Env;

/** The real D1, counting round trips: a run/all/first on its own, or a whole batch, is one. */
function counted(db: D1Database) {
	const trips: string[] = [];
	const raw = new WeakMap<object, D1PreparedStatement>();
	const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
		const proxy = new Proxy(statement, {
			get(target, key) {
				if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
				const value = Reflect.get(target, key);
				if (typeof value !== 'function') return value;
				return (...args: unknown[]) => {
					trips.push(sql);
					return value.apply(target, args);
				};
			},
		});
		raw.set(proxy, statement);
		return proxy;
	};
	const proxy = {
		prepare: (sql: string) => wrap(db.prepare(sql), sql.trim().split(/\s+/).slice(0, 2).join(' ')),
		batch: (statements: D1PreparedStatement[]) => {
			trips.push(`batch of ${statements.length}`);
			return db.batch(statements.map((s) => raw.get(s) ?? s));
		},
	} as unknown as D1Database;
	return { db: proxy, trips };
}

describe('D1SessionAdapter', () => {
	let trips: string[];
	let sessions: D1SessionAdapter;
	let id: string;

	beforeEach(async () => {
		await setupDatabase();
		const c = counted(E.AUTH_DB);
		trips = c.trips;
		sessions = new D1SessionAdapter(c.db);
		id = (await sessions.createBrowserSession({ tenantId: 'default', userAgent: 'ua', ipAddress: '192.0.2.1' })).id;
		trips.length = 0;
	});

	const add = (userId: string, extra: { authenticatedAt?: number; clientId?: string } = {}) =>
		sessions.addAccountToSession({
			browserSessionId: id,
			userId,
			subjectType: 'user',
			subjectProperties: { id: userId },
			refreshToken: `rt-${userId}`,
			clientId: 'profile',
			ttl: 3600,
			...extra,
		});
	const active = async () => (await sessions.listAccounts(id)).filter((a) => a.is_active).map((a) => a.user_id);

	it('a first sign-in is one read and one batch, and the account is the active one', async () => {
		const account = await add('u1');
		expect(trips).toHaveLength(2);
		expect(trips[1]).toBe('batch of 3');
		expect(account.is_active).toBe(true);
		expect((await sessions.getBrowserSession(id, 'default'))?.active_user_id).toBe('u1');
		expect((await sessions.getAccountSession(id, 'u1'))?.id).toBe(account.id);
	});

	it('signing in again keeps the account row, takes the new details and stays two round trips', async () => {
		const first = await add('u1', { authenticatedAt: 1000 });
		await add('u2');
		trips.length = 0;
		const again = await add('u1', { authenticatedAt: 2000, clientId: 'admin' });
		expect(trips).toHaveLength(2);
		expect(again.id).toBe(first.id);
		expect(await sessions.getAccountSession(id, 'u1')).toMatchObject({ id: first.id, authenticated_at: 2000, client_id: 'admin', is_active: true });
		expect(await active()).toEqual(['u1']);
		expect((await sessions.getBrowserSession(id, 'default'))?.active_user_id).toBe('u1');
	});

	it('a fourth account is refused and changes nothing; one already there still signs in', async () => {
		for (const u of ['u1', 'u2', 'u3']) await add(u);
		await expect(add('u4')).rejects.toThrow('max_accounts_exceeded');
		expect(await active()).toEqual(['u3']);
		await add('u1');
		expect(await active()).toEqual(['u1']);
	});

	it('a failed write leaves the browser as it was (one transaction)', async () => {
		await add('u1');
		// No browser_sessions row would be changed by a rolled-back batch
		await expect(
			sessions.addAccountToSession({
				browserSessionId: id,
				userId: 'u2',
				subjectType: 'user',
				subjectProperties: {},
				refreshToken: null as unknown as string, // NOT NULL
				clientId: 'profile',
				ttl: 3600,
			})
		).rejects.toThrow();
		expect(await active()).toEqual(['u1']);
		expect((await sessions.getBrowserSession(id, 'default'))?.active_user_id).toBe('u1');
	});

	it('reading the browser session is one round trip, with its accounts oldest first', async () => {
		await add('u2', { authenticatedAt: 2000 });
		await add('u1', { authenticatedAt: 1000 });
		trips.length = 0;
		const session = await sessions.getBrowserSession(id, 'default');
		expect(trips).toEqual(['batch of 2']);
		expect(session?.account_user_ids).toEqual(['u1', 'u2']);
		expect(await sessions.getBrowserSession(id, 'other-tenant')).toBeNull();
		expect(await sessions.getBrowserSession('missing', 'default')).toBeNull();
	});

	it('switching accounts is one round trip and leaves exactly one active', async () => {
		await add('u1');
		await add('u2');
		trips.length = 0;
		await sessions.switchActiveAccount(id, 'u1');
		expect(trips).toEqual(['batch of 2']);
		expect(await active()).toEqual(['u1']);
		expect((await sessions.getBrowserSession(id, 'default'))?.active_user_id).toBe('u1');
	});
});
