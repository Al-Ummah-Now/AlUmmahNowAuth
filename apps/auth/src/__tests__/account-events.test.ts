/** Account events (AlUmmahNowAuth#507, docs/account-hub/SPEC.md §5.4). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { MemoryStorage } from '@al-ummah-now/openauth/storage/memory';
import { signingKeys } from '@al-ummah-now/openauth/keys';
import { setupDatabase } from '../test-setup';
import { accountEventsCron, deadLetter, deliver, handleAccountEventBatch, isAccountEventQueue, MAX_ATTEMPTS, QUERIES, retryDelaySeconds } from '../account-events/deliver';
import { enqueue, recordAccountEvent, REQUEUE_AFTER_MS } from '../account-events/record';
import { isDeliverable, subscribers } from '../account-events/subscribers';
import { ACCOUNT_EVENT_TYPES, EVENT_URIS, type AccountEvent, type AccountEventsEnv } from '../account-events/types';

const ISSUER = 'https://auth.example.com';
const CLIENT = 'ae-receiver';
const URI = 'https://receiver.example.com/events';
const DAY = 24 * 60 * 60 * 1000;
const DB = () => (env as unknown as Env).AUTH_DB;
const storage = MemoryStorage();

const queued: string[] = [];
const queue = { sendBatch: vi.fn(async (m: { body: { jti: string } }[]) => void queued.push(...m.map((x) => x.body.jti))) };
const on = (over: Partial<AccountEventsEnv> = {}): AccountEventsEnv => ({
	AUTH_DB: DB(),
	AUTH_STORAGE: (env as unknown as Env).AUTH_STORAGE,
	OPENAUTH_ISSUER: ISSUER,
	ACCOUNT_EVENTS: 'on',
	ACCOUNT_EVENTS_QUEUE: queue as unknown as Queue,
	...over,
});

const sent: { url: string; init: RequestInit; token: string }[] = [];
let answer: () => Response | Promise<Response> = () => new Response(null, { status: 202 });
const fetchImpl = (async (url: string, init: RequestInit) => {
	sent.push({ url, init, token: String(init.body) });
	return answer();
}) as unknown as typeof fetch;
const opts = (now?: number) => ({ storage, fetchImpl, ...(now === undefined ? {} : { now }) });

async function client(over: Partial<{ id: string; secret: string | null; grants: string[]; scopes: string[]; metadata: unknown; enabled: number }> = {}) {
	const c = { id: CLIENT, secret: 'hash', grants: ['client_credentials'], scopes: ['account-events:receive', 'account-exports:write'], metadata: { exportPart: 'videos', events: { uri: URI, types: [...ACCOUNT_EVENT_TYPES] } } as unknown, enabled: 1, ...over };
	await DB()
		.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at) VALUES (?1, 'default', ?1, ?2, ?3, ?4, '[]', ?5, ?6, 1, 1)`)
		.bind(c.id, c.secret, JSON.stringify(c.grants), JSON.stringify(c.scopes), typeof c.metadata === 'string' ? c.metadata : JSON.stringify(c.metadata), c.enabled)
		.run();
}
async function record(event: AccountEvent, e = on(), now?: number) {
	const r = await recordAccountEvent(e, event, now);
	if (r.statements.length) await e.AUTH_DB.batch(r.statements);
	return r.jtis;
}
const delivery = (jti: string) => DB().prepare('SELECT * FROM account_event_deliveries WHERE jti = ?').bind(jti).first<{ status: string; attempts: number; error: string | null; next_at: number; seq: number }>();
const count = async (table: string) => (await DB().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const jwks = async () => createLocalJWKSet({ keys: (await signingKeys(storage)).map((k) => ({ ...k.jwk, kid: k.id, alg: k.alg })) });
const batch = (name: string, jtis: string[], attempts = 1) => {
	const messages = jtis.map((jti) => ({ body: { type: 'account-event.deliver', jti }, attempts, ack: vi.fn(), retry: vi.fn() }));
	return { messages, batch: { queue: name, messages } as unknown as MessageBatch<unknown> };
};

async function clean() {
	for (const t of ['account_event_deliveries', 'account_events']) await DB().prepare(`DELETE FROM ${t}`).run();
	await DB().prepare(`DELETE FROM oauth_clients WHERE id LIKE 'ae-%'`).run();
}
beforeAll(async () => {
	await setupDatabase();
});
beforeEach(async () => {
	await clean();
	queued.length = 0;
	sent.length = 0;
	queue.sendBatch.mockClear();
	answer = () => new Response(null, { status: 202 });
});
afterEach(clean);

const EVENTS: AccountEvent[] = [
	{ type: 'account-disabled', userId: 'usr_a', reason: 'age' },
	{ type: 'account-disabled', userId: 'usr_a', reason: 'deleted' },
	{ type: 'account-enabled', userId: 'usr_a' },
	{ type: 'account-export-requested', userId: 'usr_a', exportId: 'exp_1' },
	{ type: 'account-purged', userId: 'usr_a' },
];

describe('off by default', () => {
	for (const value of [undefined, 'off', '', 'true', 'ON'])
		it(`ACCOUNT_EVENTS ${JSON.stringify(value)} records, queues and sends nothing`, async () => {
			await client();
			const e = on({ ACCOUNT_EVENTS: value });
			expect(await record(EVENTS[0]!, e)).toEqual([]);
			await enqueue(e, ['x']);
			expect(await accountEventsCron(e)).toEqual({ verified: 0, queued: 0, removed: 0 });
			expect([await count('account_events'), queued.length]).toEqual([0, 0]);
			// a message left from when it was on is dropped, and its row waits
			const [jti] = await record(EVENTS[0]!);
			const b = batch('account-events', [jti!]);
			await handleAccountEventBatch(b.batch, e, opts());
			expect(b.messages[0]!.ack).toHaveBeenCalled();
			expect(sent).toEqual([]);
			expect(await delivery(jti!)).toMatchObject({ status: 'pending' });
		});
	it('is off in every deployed config', async () => {
		expect((env as unknown as Env).ACCOUNT_EVENTS).toBe('off');
	});
});

describe('who subscribes', () => {
	it.each([
		['a public client', { secret: null }],
		['a browser client', { grants: ['authorization_code', 'refresh_token'] }],
		['a disabled client', { enabled: 0 }],
		['no scope', { scopes: ['openid'] }],
		['no types', { metadata: { events: { uri: URI, types: [] } } }],
		['an unknown type', { metadata: { events: { uri: URI, types: ['account-created'] } } }],
		['no metadata.events', { metadata: {} }],
		['broken metadata', { metadata: '{"events"' }],
	])('%s does not', async (_name, over) => {
		await client(over);
		expect(await subscribers(DB())).toEqual([]);
		expect(await record(EVENTS[0]!)).toEqual([]);
		expect(await count('account_events')).toBe(0);
	});
	it('only for the types it names; exports also need their scope and part', async () => {
		await client({ metadata: { events: { uri: URI, types: ['account-purged'] } } });
		expect(await record(EVENTS[0]!)).toEqual([]);
		expect(await record(EVENTS[4]!)).toHaveLength(1);
		for (const over of [{ scopes: ['account-events:receive'] }, { metadata: { events: { uri: URI, types: [...ACCOUNT_EVENT_TYPES] } } }]) {
			await client(over);
			expect(await record(EVENTS[3]!)).toEqual([]);
			expect(await record(EVENTS[4]!)).toHaveLength(1);
		}
	});
	it.each(['http://receiver.example.com/e', 'https://127.0.0.1/e', 'https://[::1]/e', 'https://2130706433/e', 'https://0x7f.1/e', 'https://localhost/e', 'https://a.localhost/e', 'https://db.internal/e', 'https://receiver/e', 'https://receiver.example.com./e', 'https://receiver.example.com:8443/e', 'https://me:pw@receiver.example.com/e', 'https://receiver.example.com/e#x', 'javascript:alert(1)', 'nope', 5, null])(
		'%s is not an address to send to',
		(uri) => expect(isDeliverable(uri)).toBe(false)
	);
	it('an https host name is', () => expect(isDeliverable(URI)).toBe(true));
});

describe('the token', () => {
	it.each(EVENTS.map((e) => [e.type, e] as const))('%s verifies with the published keys and says only what it must', async (type, event) => {
		await client();
		const [jti] = await record(event);
		expect(await deliver(on(), jti!, 1, opts())).toBe('delivered');
		const { url, init, token } = sent[0]!;
		expect(url).toBe(URI);
		expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/secevent+jwt' } });
		const { payload, protectedHeader } = await jwtVerify(token, await jwks(), { issuer: ISSUER, audience: CLIENT, typ: 'secevent+jwt' });
		expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'secevent+jwt' });
		expect(payload).toEqual({
			iss: ISSUER,
			aud: CLIENT,
			iat: expect.any(Number),
			jti,
			toe: expect.any(Number),
			seq: expect.any(Number),
			sub_id: { format: 'iss_sub', iss: ISSUER, sub: 'usr_a' },
			events: { [EVENT_URIS[type]]: event.type === 'account-disabled' ? { reason: event.reason } : event.type === 'account-export-requested' ? { export_id: 'exp_1' } : {} },
		});
		expect(JSON.stringify(payload)).not.toMatch(/@|email|name|birth|band/i);
	});
	it('can not pass as an access token', async () => {
		await client();
		const [jti] = await record(EVENTS[0]!);
		await deliver(on(), jti!, 1, opts());
		const claims = decodeJwt(sent[0]!.token);
		for (const claim of ['sub', 'exp', 'mode', 'type', 'properties']) expect(claims).not.toHaveProperty(claim);
		expect(decodeProtectedHeader(sent[0]!.token).typ).not.toBe('JWT');
		await expect(jwtVerify(sent[0]!.token, await jwks(), { issuer: ISSUER, audience: CLIENT, typ: 'JWT' })).rejects.toThrow();
		const { verifyUserAccessToken } = await import('../routes/account-routes');
		const res = await verifyUserAccessToken(new Request(`${ISSUER}/account/export`, { headers: { Authorization: `Bearer ${sent[0]!.token}` } }), { ...(env as unknown as Env), OPENAUTH_ISSUER: ISSUER });
		expect(res).toBeInstanceOf(Response);
		expect((res as Response).status).toBe(401);
	});
});

describe('recording', () => {
	it('is in the batch of the change: a batch that fails records nothing', async () => {
		await client();
		const r = await recordAccountEvent(on(), EVENTS[0]!);
		await expect(DB().batch([...r.statements, DB().prepare('INSERT INTO account_events (id, type, created_at) VALUES (NULL, NULL, NULL)')])).rejects.toThrow();
		expect([await count('account_events'), await count('account_event_deliveries')]).toEqual([0, 0]);
	});
	it('one delivery per subscriber, and the purge outlives the user', async () => {
		await client();
		await client({ id: 'ae-second' });
		await DB().prepare(`INSERT OR REPLACE INTO users (id, email, created_at, updated_at) VALUES ('usr_ae', 'ae@example.com', 1, 1)`).run();
		const r = await recordAccountEvent(on(), { type: 'account-purged', userId: 'usr_ae' });
		await DB().batch([...r.statements, DB().prepare(`DELETE FROM users WHERE id = 'usr_ae'`)]);
		expect(await count('account_events')).toBe(1);
		for (const jti of r.jtis) expect(await deliver(on(), jti, 1, opts())).toBe('delivered');
		expect(sent.map((s) => decodeJwt(s.token).aud).sort()).toEqual([CLIENT, 'ae-second'].sort());
		expect(new Set(r.jtis).size).toBe(2);
	});
	it('a failed enqueue loses nothing: the next cron queues it', async () => {
		await client({ metadata: { events: { uri: URI, types: ['account-purged'] } } });
		const jtis = await record(EVENTS[4]!);
		queue.sendBatch.mockRejectedValueOnce(new Error('queue down'));
		await enqueue(on(), jtis);
		expect(queued).toEqual([]);
		expect(await accountEventsCron(on())).toMatchObject({ queued: 1 });
		expect(queued).toEqual(jtis);
		// and not again while its retries run
		expect(await accountEventsCron(on())).toMatchObject({ queued: 0 });
		expect(await accountEventsCron(on(), Date.now() + REQUEUE_AFTER_MS + 1000)).toMatchObject({ queued: 1 });
	});
	it('a queue that stays down does not loop', async () => {
		await client({ metadata: { events: { uri: URI, types: ['account-purged'] } } });
		await record(EVENTS[4]!);
		const down = on({ ACCOUNT_EVENTS_QUEUE: undefined });
		await accountEventsCron(down);
		expect(await DB().prepare(`SELECT COUNT(*) AS n FROM account_event_deliveries WHERE status = 'pending' AND next_at <= ?`).bind(Date.now()).first()).toEqual({ n: 1 });
	});
});

describe('delivery', () => {
	it('retries with backoff, then fails; sending again has the same jti', async () => {
		await client();
		const [jti] = await record(EVENTS[0]!);
		answer = () => new Response('down', { status: 503 });
		for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
			const b = batch('account-events', [jti!], attempt);
			await handleAccountEventBatch(b.batch, on(), opts());
			expect(b.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(attempt) });
			expect(await delivery(jti!)).toMatchObject({ status: 'pending', attempts: attempt, error: '503' });
		}
		expect(await deliver(on(), jti!, MAX_ATTEMPTS, opts())).toBe('failed');
		expect(await delivery(jti!)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error: '503' });
		expect(new Set(sent.map((s) => decodeJwt(s.token).jti))).toEqual(new Set([jti]));
		expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 900]);
	});
	it.each([
		['a redirect', () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com' } }), 'retry', '302'],
		['another 2xx', () => new Response(null, { status: 200 }), 'retry', '200'],
		['a network error', () => { throw new TypeError('fetch failed: person@example.com'); }, 'retry', 'network error'],
		['a timeout', () => { throw new DOMException('t', 'TimeoutError'); }, 'retry', 'timeout'],
	])('%s is not a delivery', async (_name, reply, result, error) => {
		await client();
		const [jti] = await record(EVENTS[0]!);
		answer = reply as () => Response;
		expect(await deliver(on(), jti!, 1, opts())).toBe(result);
		expect(await delivery(jti!)).toMatchObject({ status: 'pending', error });
		expect(sent).toHaveLength(1);
	});
	it('a 400 is final, and only a SET error code is kept', async () => {
		await client();
		for (const [body, error] of [
			['{"err":"invalid_audience","description":"person@example.com"}', '400 invalid_audience'],
			['{"err":"Person@Example.com"}', '400'],
			['x'.repeat(5000), '400'],
		] as const) {
			const [jti] = await record(EVENTS[0]!);
			answer = () => new Response(body, { status: 400, headers: { 'content-length': String(body.length) } });
			expect(await deliver(on(), jti!, 1, opts())).toBe('failed');
			expect(await delivery(jti!)).toMatchObject({ status: 'failed', error });
		}
	});
	it('a client that left or was disabled since gets nothing', async () => {
		await client();
		const [jti] = await record(EVENTS[0]!);
		await client({ enabled: 0 });
		expect(await deliver(on(), jti!, 1, opts())).toBe('failed');
		expect(sent).toEqual([]);
		expect(await delivery(jti!)).toMatchObject({ status: 'failed', error: 'not subscribed' });
	});
	it('delivers once: a repeated message does nothing', async () => {
		await client();
		const [jti] = await record(EVENTS[0]!);
		expect(await deliver(on(), jti!, 1, opts())).toBe('delivered');
		expect(await deliver(on(), jti!, 1, opts())).toBe('skipped');
		expect(await deliver(on(), 'unknown', 1, opts())).toBe('skipped');
		expect(sent).toHaveLength(1);
	});
	it('a later event of the same user waits for the earlier one; another user does not', async () => {
		await client();
		const [first] = await record(EVENTS[0]!);
		const [second] = await record(EVENTS[2]!);
		const [other] = await record({ type: 'account-enabled', userId: 'usr_b' });
		const b = batch('account-events', [second!]);
		await handleAccountEventBatch(b.batch, on(), opts());
		expect(b.messages[0]!.ack).toHaveBeenCalled();
		expect(sent).toEqual([]);
		expect(await deliver(on(), other!, 1, opts())).toBe('delivered');
		expect(await deliver(on(), first!, 1, opts())).toBe('delivered');
		// the waiting one was queued when the first settled
		expect(queued).toEqual([second]);
		expect(await deliver(on(), second!, 1, opts())).toBe('delivered');
		const seqs = sent.map((s) => decodeJwt(s.token).seq as number);
		expect(seqs[2]!).toBeGreaterThan(seqs[1]!);
	});
	it('a failed event does not hold back the next', async () => {
		await client();
		const [first] = await record(EVENTS[0]!);
		const [second] = await record(EVENTS[2]!);
		answer = () => new Response(null, { status: 400 });
		expect(await deliver(on(), first!, 1, opts())).toBe('failed');
		expect(queued).toEqual([second]);
		answer = () => new Response(null, { status: 202 });
		expect(await deliver(on(), second!, 1, opts())).toBe('delivered');
	});
	it('the dead-letter queue marks what could not be handled, once', async () => {
		await client();
		const [jti] = await record(EVENTS[0]!);
		const broken = batch('account-events', [jti!]);
		await handleAccountEventBatch(broken.batch, on({ OPENAUTH_ISSUER: '' }), opts());
		expect(broken.messages[0]!.retry).toHaveBeenCalled();
		const dead = batch('account-events-dlq', [jti!]);
		await handleAccountEventBatch(dead.batch, on(), opts());
		expect(dead.messages[0]!.ack).toHaveBeenCalled();
		expect(await delivery(jti!)).toMatchObject({ status: 'failed' });
		await deadLetter(on(), jti!);
		expect(sent).toEqual([]);
	});
	it('knows its queues from the job queue', () => {
		expect(['account-events', 'account-events-qa', 'account-events-stage-dlq'].map(isAccountEventQueue)).toEqual([true, true, true]);
		expect(['moderation-actions', 'moderation-actions-dlq', 'account-eventsx'].map(isAccountEventQueue)).toEqual([false, false, false]);
	});
});

describe('the cron', () => {
	it('sends each subscriber one verification a day', async () => {
		await client();
		await client({ id: 'ae-second', metadata: { events: { uri: URI, types: ['account-purged'] } } });
		const now = Date.now();
		expect(await accountEventsCron(on(), now)).toEqual({ verified: 1, queued: 1, removed: 0 });
		expect(await deliver(on(), queued[0]!, 1, opts(now))).toBe('delivered');
		expect(decodeJwt(sent[0]!.token)).toMatchObject({ aud: CLIENT, sub_id: { format: 'opaque', id: CLIENT }, events: { [EVENT_URIS.verification]: {} } });
		for (const hours of [1, 12, 23]) expect(await accountEventsCron(on(), now + hours * 3600_000)).toMatchObject({ verified: 0 });
		expect(await accountEventsCron(on(), now + DAY)).toMatchObject({ verified: 1 });
	});
	it('removes delivered rows after 30 days and keeps failed and pending ones', async () => {
		await client({ metadata: { events: { uri: URI, types: ['account-purged', 'account-disabled'] } } });
		const old = Date.now() - 31 * DAY;
		const [delivered] = await record(EVENTS[4]!, on(), old);
		await deliver(on(), delivered!, 1, opts(old));
		const [failed] = await record({ type: 'account-disabled', userId: 'usr_f', reason: 'age' }, on(), old);
		answer = () => new Response(null, { status: 400 });
		await deliver(on(), failed!, 1, opts(old));
		const [pending] = await record({ type: 'account-disabled', userId: 'usr_p', reason: 'age' }, on(), old);
		expect(await accountEventsCron(on({ ACCOUNT_EVENTS: 'off' }))).toMatchObject({ removed: 2 });
		expect(await delivery(delivered!)).toBeNull();
		expect(await delivery(failed!)).not.toBeNull();
		expect(await delivery(pending!)).not.toBeNull();
		expect(await count('account_events')).toBe(2);
	});
	it('no query scans a table', async () => {
		for (const [name, sql] of Object.entries(QUERIES)) {
			const binds = [...new Set(sql.match(/\?\d/g) ?? [])].map(() => 1);
			const { results } = await DB().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
			for (const { detail } of results) expect(detail, name).not.toMatch(/^SCAN (?!.*USING (?:COVERING )?INDEX)/);
		}
		const { results } = await DB().prepare(`EXPLAIN QUERY PLAN SELECT id FROM oauth_clients INDEXED BY idx_oauth_clients_events WHERE instr(metadata, '"events"') > 0`).all<{ detail: string }>();
		expect(results.map((r) => r.detail).join()).toContain('idx_oauth_clients_events');
	});
});
