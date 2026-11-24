/** Admin > Account events (account-events/admin.ts, AlUmmahNowAuth#507 C1c). */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import { recordAccountEvent } from '../account-events/record';
import { deliver } from '../account-events/deliver';
import { MemoryStorage } from '@al-ummah-now/openauth/storage/memory';
import { emitAuditEvent } from '../audit-emitter';
import { fakeLimiter } from './helpers/fake-limiter';

vi.mock('../audit-emitter', async (importOriginal) => ({ ...(await importOriginal<typeof import('../audit-emitter')>()), emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));
// The acting admin comes from a test header (verifyAdminRequest is tested elsewhere)
vi.mock('../auth-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../auth-middleware')>()),
	verifyAdminRequest: async (request: Request) => {
		const id = request.headers.get('X-Test-Admin');
		if (!id) throw new Error('Unauthorized');
		return { type: 'm2m', clientId: 'admin-app', tenantId: 'default', scopes: ['admin:*'], ...(id === 'nobody' ? {} : { actingUser: { id, email: `${id}@example.com`, roles: ['Admin'] } }) };
	},
}));
const { ADMIN_QUERIES, COUNT_LIMIT, handleAccountEvents, PAGE_SIZE } = await import('../account-events/admin');

const DB = () => (env as unknown as Env).AUTH_DB;
const storage = MemoryStorage();
const pendingWork: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pendingWork.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
const queued: string[] = [];
const on = (over: Partial<Env> = {}) =>
	({
		...(env as unknown as Env),
		OPENAUTH_ISSUER: 'https://auth.example.com',
		ACCOUNT_EVENTS: 'on',
		ACCOUNT_EVENTS_QUEUE: { sendBatch: async (m: { body: { jti: string } }[]) => void queued.push(...m.map((x) => x.body.jti)) } as unknown as Queue,
		ADMIN_SENSITIVE_LIMITER: fakeLimiter(100) as unknown as RateLimit,
		...over,
	}) as Env;

async function call(method: string, path = '', body?: unknown, opts: { env?: Env; admin?: string | null } = {}) {
	const admin = opts.admin === undefined ? 'adm' : opts.admin;
	const res = await handleAccountEvents(
		new Request(`https://auth.example.com/admin/settings/account-events${path}`, { method, headers: admin ? { 'X-Test-Admin': admin } : {}, body: body === undefined ? undefined : JSON.stringify(body) }),
		opts.env ?? on(),
		ctx,
		'req-1'
	);
	return { status: res.status, cache: res.headers.get('Cache-Control'), json: (await res.json()) as Record<string, any> };
}
async function client(id: string, name = id) {
	await DB()
		.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at) VALUES (?1, 'default', ?2, 'hash', '["client_credentials"]', '["account-events:receive"]', '[]', ?3, 1, 1, 1)`)
		.bind(id, name, JSON.stringify({ events: { uri: `https://${id}.example.com/events`, types: ['account-disabled', 'account-purged'] } }))
		.run();
}
/** One event per user, delivered with the given status to every subscriber. */
async function event(userId: string, status: number, now: number) {
	const r = await recordAccountEvent(on(), { type: 'account-disabled', userId, reason: 'deleted' }, { now });
	await DB().batch(r.statements);
	if (status) for (const jti of r.jtis) await deliver(on(), jti, 1, { storage, now, fetchImpl: (async () => new Response(null, { status })) as unknown as typeof fetch });
	return r.jtis;
}

beforeAll(async () => {
	await setupDatabase();
});
beforeEach(async () => {
	for (const t of ['account_event_deliveries', 'account_events']) await DB().prepare(`DELETE FROM ${t}`).run();
	await DB().prepare(`DELETE FROM oauth_clients WHERE id LIKE 'aea-%'`).run();
	queued.length = 0;
	vi.mocked(emitAuditEvent).mockClear();
});

describe('who and when', () => {
	it('admins only, and 404 while events are off', async () => {
		expect((await call('GET', '', undefined, { admin: null })).status).toBe(403);
		expect((await call('GET', '', undefined, { admin: 'nobody' })).status).toBe(403);
		for (const method of ['GET', 'POST']) expect(await call(method, '', method === 'POST' ? { action: 'resend', jti: crypto.randomUUID() } : undefined, { env: on({ ACCOUNT_EVENTS: 'off' }) })).toMatchObject({ status: 404, json: { error: 'feature_off' } });
		expect((await call('DELETE')).status).toBe(405);
	});
});

describe('GET', () => {
	it('each subscriber with its last delivery and counts, and the failed deliveries first', async () => {
		await client('aea-a', 'App A');
		await client('aea-b', 'App B');
		await event('usr_1', 202, 1000);
		await event('usr_2', 400, 2000);
		await event('usr_3', 0, 3000);
		const { status, cache, json } = await call('GET');
		expect([status, cache]).toEqual([200, 'no-store']);
		expect(json.clients).toEqual(
			['a', 'b'].map((x) => ({ clientId: `aea-${x}`, name: `App ${x.toUpperCase()}`, uri: `https://aea-${x}.example.com/events`, types: ['account-disabled', 'account-purged'], lastDeliveredAt: 1000, pending: 1, failed: 1 }))
		);
		expect(json).toMatchObject({ status: 'failed', next: null, countLimit: COUNT_LIMIT });
		expect(json.deliveries).toHaveLength(2);
		expect(json.deliveries[0]).toEqual({ jti: expect.any(String), seq: expect.any(Number), clientId: expect.any(String), type: 'account-disabled', reason: 'deleted', userId: 'usr_2', status: 'failed', attempts: 1, error: '400', createdAt: 2000, settledAt: 2000 });
		expect(JSON.stringify(json)).not.toMatch(/@|hash|secret/);
		expect((await call('GET', '?status=delivered&client=aea-b')).json.deliveries).toMatchObject([{ userId: 'usr_1', clientId: 'aea-b' }]);
		const pending = (await call('GET', '?status=pending')).json.deliveries;
		expect(pending.map((d: { userId: string }) => d.userId)).toEqual(['usr_3', 'usr_3']);
		expect((await call('GET', '?status=pending&client=aea-a')).json.deliveries).toMatchObject([{ userId: 'usr_3', settledAt: null }]);
	});
	it('a client that never received anything', async () => {
		await client('aea-a');
		expect((await call('GET')).json).toMatchObject({ clients: [{ lastDeliveredAt: null, pending: 0, failed: 0 }], deliveries: [], next: null });
	});
	it('pages without a gap or a repeat, also when many settled at the same moment', async () => {
		await client('aea-a');
		for (let i = 0; i < PAGE_SIZE + 30; i++) await event(`usr_${i}`, 400, i < 20 ? 1000 + i : 5000);
		for (const filter of ['', '&client=aea-a']) {
			const first = (await call('GET', `?status=failed${filter}`)).json;
			expect(first.deliveries).toHaveLength(PAGE_SIZE);
			const second = (await call('GET', `?status=failed${filter}&before=${first.next}`)).json;
			expect([second.deliveries.length, second.next]).toEqual([30, null]);
			const all = [...first.deliveries, ...second.deliveries];
			expect(new Set(all.map((d: { jti: string }) => d.jti)).size).toBe(PAGE_SIZE + 30);
			expect(all.map((d: { settledAt: number }) => d.settledAt)).toEqual([...all.map((d: { settledAt: number }) => d.settledAt)].sort((a, b) => b - a));
		}
	});
	it.each(['?status=all', '?before=x', '?before=1_zz', "?client=a'b", `?client=${'a'.repeat(129)}`])('%s is refused', async (query) => {
		expect(await call('GET', query)).toMatchObject({ status: 400, json: { error: 'invalid_request' } });
	});
});

describe('POST resend', () => {
	it('queues a failed delivery again with the same jti, and says who asked', async () => {
		await client('aea-a');
		const [jti] = await event('usr_1', 400, 1000);
		expect(await call('POST', '', { action: 'resend', jti })).toMatchObject({ status: 202, json: { queued: true } });
		expect(queued).toEqual([jti]);
		expect((await call('GET', '?status=pending')).json.deliveries).toMatchObject([{ jti, attempts: 0, error: null, settledAt: null }]);
		await Promise.all(pendingWork);
		expect(vi.mocked(emitAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'account_event.resent', userId: 'adm', metadata: expect.objectContaining({ jti, clientId: 'aea-a', targetUserId: 'usr_1' }) }));
		expect(await deliver(on(), jti!, 1, { storage, fetchImpl: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch })).toBe('delivered');
		// a second press, or another admin's, finds nothing failed
		expect(await call('POST', '', { action: 'resend', jti })).toMatchObject({ status: 409, json: { error: 'not_failed' } });
	});
	it('a queue that is down leaves it for the cron', async () => {
		await client('aea-a');
		const [jti] = await event('usr_1', 400, 1000);
		expect((await call('POST', '', { action: 'resend', jti }, { env: on({ ACCOUNT_EVENTS_QUEUE: undefined }) })).status).toBe(202);
		const row = await DB().prepare('SELECT status, next_at FROM account_event_deliveries WHERE jti = ?').bind(jti).first<{ status: string; next_at: number }>();
		expect(row!.status).toBe('pending');
		expect(row!.next_at).toBeLessThanOrEqual(Date.now());
	});
	it.each([
		['lost the scope', `scopes = '[]'`],
		['was disabled', 'enabled = 0'],
		['no longer takes this event', `metadata = '{"events":{"uri":"https://aea-a.example.com/events","types":["account-purged"]}}'`],
		['is gone', null],
	])('refuses when the client %s, and changes nothing', async (_, change) => {
		await client('aea-a');
		const [jti] = await event('usr_1', 400, 1000);
		const row = () => DB().prepare('SELECT * FROM account_event_deliveries WHERE jti = ?').bind(jti).first();
		const before = await row();
		await DB().prepare(change ? `UPDATE oauth_clients SET ${change} WHERE id = 'aea-a'` : `DELETE FROM oauth_clients WHERE id = 'aea-a'`).run();
		expect(await call('POST', '', { action: 'resend', jti })).toMatchObject({ status: 409, json: { error: 'not_subscribed' } });
		expect(await row()).toEqual(before);
		await Promise.all(pendingWork);
		expect(queued).toEqual([]);
		expect(vi.mocked(emitAuditEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'account_event.resent' }));
	});
	it('only a failed one, only by its id, and rate limited', async () => {
		await client('aea-a');
		const [pending] = await event('usr_1', 0, 1000);
		const [delivered] = await event('usr_2', 202, 1000);
		for (const jti of [pending, delivered, crypto.randomUUID()]) expect((await call('POST', '', { action: 'resend', jti })).status).toBe(409);
		for (const body of [undefined, {}, { action: 'resend' }, { action: 'delete', jti: pending }, { action: 'resend', jti: 'x' }, { action: 'resend', jti: ['a'] }]) expect((await call('POST', '', body)).status).toBe(400);
		expect(queued).toEqual([]);
		const limited = on({ ADMIN_SENSITIVE_LIMITER: fakeLimiter(0) as unknown as RateLimit });
		expect((await call('POST', '', { action: 'resend', jti: pending }, { env: limited })).status).toBe(429);
	});
});

it('no query scans a table', async () => {
	for (const [name, sql] of Object.entries(ADMIN_QUERIES)) {
		const binds = [...new Set(sql.match(/\?\d/g) ?? [])].map(() => 1);
		const { results } = await DB().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
		for (const { detail } of results) expect(detail, name).not.toMatch(/^SCAN (?!.*USING (?:COVERING )?INDEX|\(subquery)|TEMP B-TREE(?!.*LAST TERM)/);
	}
	// the cursor is a range in the index, not a filter over it
	const { results } = await DB().prepare(`EXPLAIN QUERY PLAN ${ADMIN_QUERIES.LIST_SQL}`).bind('failed', 1, '', 1).all<{ detail: string }>();
	expect(results.map((r) => r.detail).join('\n')).toContain('(status=? AND settled_at<?)');
});
