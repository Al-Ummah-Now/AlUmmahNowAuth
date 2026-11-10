/**
 * Moderation requests (docs/MODERATION_REQUESTS.md): client authentication,
 * validation, idempotency, RBAC, the state machine and approve-and-execute.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { hashClientSecret } from '@al-ummah-now/openauth';
import migration0022 from '../../migrations/0022_moderation_requests.sql?raw';
import migration0023 from '../../migrations/0023_moderation_execution_queue.sql?raw';
import { setupDatabase } from '../test-setup';
import { canTransition, isFinal, validate, CreateRequestSchema, payloadHash, MODERATION_STATUSES, type Decision } from '../moderation/model';
import { routeModerationClient } from '../moderation/client-routes';
import { handleModerationBatch, retryDelaySeconds, runQueuedAction, deadLetter, MAX_ATTEMPTS, type ModerationQueueMessage } from '../moderation/queue';
import { classifyActionError, type ActionOutcome } from '../moderation/actions';
import { ModerationStore } from '../moderation/store';

// requireAdmin is tested elsewhere; here the acting admin comes from a test header
vi.mock('../middleware/admin-auth', async (importOriginal) => ({
	...(await importOriginal<typeof import('../middleware/admin-auth')>()),
	requireAdmin: () => async (c: { req: { header: (n: string) => string | undefined }; set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response }, next: () => Promise<void>) => {
		const id = c.req.header('X-Test-Admin');
		if (!id) return c.json({ error: 'Unauthorized' }, 401);
		c.set('adminUser', { userId: id, email: `${id}@example.com`, roles: [] });
		await next();
	},
}));

const { moderationAdminRoutes } = await import('../moderation/admin-routes');

const DB = () => (env as unknown as Env).AUTH_DB;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const VIDEOS = { id: 'd7464de8-363d-4fc1-b1af-7c71653f0afc', secret: 'videos-admin-test-secret-0123456789' };
const OTHER = { id: 'other-moderation-client', secret: 'other-client-test-secret-0123456789' };
const NO_SCOPE = { id: 'no-scope-client', secret: 'no-scope-client-secret-0123456789' };
const NO_SECRET = { id: 'no-secret-client' };
const SUBJECT = 'usr_subject0001';
const ADMIN = 'usr_authadmin01';
const SUPER = 'usr_superadmin1';
const MODERATOR = 'usr_moderator01';

function sqlStatements(sql: string): string[] {
	return sql
		.split('\n')
		.filter((line) => !line.trim().startsWith('--'))
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);
}

const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;

function body(overrides: Record<string, unknown> = {}) {
	return {
		subject_user_id: SUBJECT,
		action: 'revoke_sessions',
		reason_category: 'spam',
		reason: 'Posts the same link under every video',
		evidence: [{ url: 'https://admin.qa.alummahnow.net/users/usr_subject0001', label: 'Videos admin user page' }],
		requested_by: { id: 'videos-admin-1', display_name: 'Videos Moderator' },
		...overrides,
	};
}

let keySeq = 0;
async function clientCall(method: string, path: string, opts: { client?: { id: string; secret?: string }; json?: unknown; key?: string | null; auth?: string } = {}) {
	const headers = new Headers({ 'Content-Type': 'application/json' });
	const client = opts.client ?? VIDEOS;
	const auth = opts.auth ?? (client.secret ? basic(client.id, client.secret) : basic(client.id, 'whatever'));
	if (auth) headers.set('Authorization', auth);
	if (method === 'POST' && opts.key !== null) headers.set('Idempotency-Key', opts.key ?? `test-key-${++keySeq}-${Date.now()}`);
	const req = new Request(`https://auth.test${path}`, { method, headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json) });
	const res = await routeModerationClient(req, env as unknown as Env, ctx, 'req-test');
	if (!res) throw new Error('not routed');
	return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> };
}

/** The approve/execute routes only queue: a fake producer records what was sent. */
const sent: ModerationQueueMessage[] = [];
const fakeQueue = { send: vi.fn(async (m: ModerationQueueMessage) => void sent.push(m)) };
const testEnv = () => ({ ...(env as unknown as Env), MODERATION_QUEUE: fakeQueue as unknown as Queue });
const adminApp = () => moderationAdminRoutes();
async function adminCall(method: string, path: string, adminId: string | null, json?: unknown) {
	const headers = new Headers({ 'Content-Type': 'application/json' });
	if (adminId) headers.set('X-Test-Admin', adminId);
	const res = await adminApp().fetch(
		new Request(`https://auth.test/admin/moderation-requests${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }),
		testEnv(),
		ctx
	);
	return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function fileRequest(overrides: Record<string, unknown> = {}) {
	const res = await clientCall('POST', '/moderation/requests', { json: body(overrides) });
	expect(res.status).toBe(201);
	return res.json.request as { id: string; status: string };
}

beforeAll(async () => {
	await setupDatabase();
	const db = DB();
	const now = Date.now();
	await db.prepare(`CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, user_id TEXT, is_active INTEGER)`).run();
	// What openauth's seed provides in every environment
	await db
		.prepare(`INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, created_at, updated_at) VALUES ('client_admin_dashboard', 'default', 'Admin Dashboard', ?, ?)`)
		.bind(now, now)
		.run();
	for (const [id, name] of [
		['role_super_admin', 'Super Admin'],
		['role_admin', 'Admin'],
		['role_moderator', 'Moderator'],
	]) {
		await db.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES (?, ?, 'default')`).bind(id, name).run();
	}
	// The migration under test
	for (const stmt of [...sqlStatements(migration0022), ...sqlStatements(migration0023)]) await db.prepare(stmt).run();

	await db.prepare(`UPDATE oauth_clients SET client_secret_hash = ? WHERE id = ?`).bind(await hashClientSecret(VIDEOS.secret), VIDEOS.id).run();
	for (const [c, scopes, hash] of [
		[OTHER, '["moderation:request"]', await hashClientSecret(OTHER.secret)],
		[NO_SCOPE, '["openid"]', await hashClientSecret(NO_SCOPE.secret)],
		[NO_SECRET, '["moderation:request"]', null],
	] as const) {
		await db
			.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, scopes, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, ?, ?)`)
			.bind(c.id, c.id, hash, scopes, now, now)
			.run();
	}
	for (const id of [SUBJECT, ADMIN, SUPER, MODERATOR]) {
		await db
			.prepare(`INSERT OR IGNORE INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES (?, 'default', ?, 'active', ?, ?)`)
			.bind(id, `${id}@example.com`, now, now)
			.run();
	}
	for (const [user, role] of [
		[ADMIN, 'role_admin'],
		[SUPER, 'role_super_admin'],
		[MODERATOR, 'role_moderator'],
	]) {
		await db.prepare(`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES (?, ?, 'default', ?, 'test')`).bind(user, role, now).run();
	}
});

beforeEach(() => {
	sent.length = 0;
	fakeQueue.send.mockClear();
});

describe('state machine', () => {
	const table: Array<[string, Decision, boolean]> = [
		['pending', 'approve', true],
		['pending', 'reject', true],
		['pending', 'request_info', true],
		['pending', 'provide_info', false],
		['pending', 'execute', false],
		['info_requested', 'provide_info', true],
		['info_requested', 'approve', true],
		['info_requested', 'request_info', false],
		['approved', 'execute', true],
		['approved', 'mark_actioned', true],
		['approved', 'approve', false],
		['rejected', 'approve', false],
		['rejected', 'reject', false],
		['actioned', 'reject', false],
		['actioned', 'execute', false],
	];
	it.each(table)('%s --%s--> allowed=%s', (from, decision, allowed) => {
		expect(canTransition(from as never, decision)).toBe(allowed);
	});
	it('rejected and actioned are final', () => {
		expect(MODERATION_STATUSES.filter(isFinal)).toEqual(['rejected', 'actioned']);
	});
});

describe('validation', () => {
	it('accepts a full request and defaults evidence', () => {
		const r = validate(CreateRequestSchema, { ...body(), evidence: undefined });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.evidence).toEqual([]);
	});
	it.each([
		['unknown action', { action: 'ban_forever' }, 'action'],
		['unknown reason category', { reason_category: 'meh' }, 'reason_category'],
		['empty reason', { reason: '   ' }, 'reason'],
		['non-https evidence', { evidence: [{ url: 'javascript:alert(1)' }] }, 'evidence'],
		['bad user id', { subject_user_id: 'usr x; drop' }, 'subject_user_id'],
		['no requester', { requested_by: { id: '', display_name: '' } }, 'requested_by'],
	])('rejects %s', (_name, overrides, path) => {
		const r = validate(CreateRequestSchema, body(overrides));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.some((i) => i.path.startsWith(path))).toBe(true);
	});
	it('hashes the same payload the same way', async () => {
		const a = validate(CreateRequestSchema, body());
		const b = validate(CreateRequestSchema, body({ reason: 'different' }));
		if (!a.ok || !b.ok) throw new Error('invalid');
		expect(await payloadHash(a.value)).toBe(await payloadHash(a.value));
		expect(await payloadHash(a.value)).not.toBe(await payloadHash(b.value));
	});
});

describe('migration 0022', () => {
	it('grants moderation_requests:manage to Admin and Super Admin only', async () => {
		const { results } = await DB()
			.prepare(`SELECT role_id FROM rbac_role_permissions WHERE permission_id = 'perm_admin_moderation_requests' ORDER BY role_id`)
			.all<{ role_id: string }>();
		expect(results.map((r) => r.role_id)).toEqual(['role_admin', 'role_super_admin']);
	});
	it('registers the videos admin client with the moderation:request scope and no secret', async () => {
		const row = await DB().prepare(`SELECT scopes FROM oauth_clients WHERE id = ?`).bind(VIDEOS.id).first<{ scopes: string }>();
		expect(JSON.parse(row!.scopes)).toEqual(['moderation:request']);
		const sql = migration0022.toLowerCase();
		expect(sql).not.toMatch(/\bdrop\b|\balter table\b.*\bdrop\b/);
	});
});

describe('client authentication', () => {
	it('401 without credentials', async () => {
		const res = await clientCall('GET', '/moderation/requests', { auth: '' });
		expect(res.status).toBe(401);
	});
	it('401 with a wrong secret', async () => {
		const res = await clientCall('GET', '/moderation/requests', { auth: basic(VIDEOS.id, 'wrong') });
		expect(res.status).toBe(401);
		expect(res.json.error).toBe('invalid_client');
	});
	it('401 for a client with no stored secret', async () => {
		const res = await clientCall('GET', '/moderation/requests', { client: NO_SECRET });
		expect(res.status).toBe(401);
	});
	it('403 for a client without the moderation:request scope', async () => {
		const res = await clientCall('GET', '/moderation/requests', { client: NO_SCOPE });
		expect(res.status).toBe(403);
		expect(res.json.error).toBe('insufficient_scope');
	});
	it('405 for an unsupported method', async () => {
		const res = await clientCall('DELETE', '/moderation/requests');
		expect(res.status).toBe(405);
	});
});

describe('filing requests', () => {
	it('creates a pending request with its history', async () => {
		const res = await clientCall('POST', '/moderation/requests', { json: body() });
		expect(res.status).toBe(201);
		expect(res.json.request).toMatchObject({ status: 'pending', subject_user_id: SUBJECT, action: 'revoke_sessions', requested_by: { display_name: 'Videos Moderator' } });
		expect(res.json.request.id).toMatch(/^modreq_/);
		expect(res.json.request.history.map((h: { type: string }) => h.type)).toEqual(['created']);
	});
	it('requires an Idempotency-Key', async () => {
		const res = await clientCall('POST', '/moderation/requests', { json: body(), key: null });
		expect(res.status).toBe(400);
	});
	it('replays the same key and body (200, same id)', async () => {
		const first = await clientCall('POST', '/moderation/requests', { json: body(), key: 'idem-key-replay-1' });
		const again = await clientCall('POST', '/moderation/requests', { json: body(), key: 'idem-key-replay-1' });
		expect(first.status).toBe(201);
		expect(again.status).toBe(200);
		expect(again.headers.get('Idempotent-Replay')).toBe('true');
		expect(again.json.request.id).toBe(first.json.request.id);
	});
	it('409 for the same key with a different body', async () => {
		await clientCall('POST', '/moderation/requests', { json: body(), key: 'idem-key-conflict-1' });
		const res = await clientCall('POST', '/moderation/requests', { json: body({ reason: 'something else' }), key: 'idem-key-conflict-1' });
		expect(res.status).toBe(409);
		expect(res.json.error).toBe('idempotency_conflict');
	});
	it('keys are per client', async () => {
		const a = await clientCall('POST', '/moderation/requests', { json: body(), key: 'idem-key-shared-1' });
		const b = await clientCall('POST', '/moderation/requests', { json: body(), key: 'idem-key-shared-1', client: OTHER });
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		expect(b.json.request.id).not.toBe(a.json.request.id);
	});
	it('404 for an unknown subject', async () => {
		const res = await clientCall('POST', '/moderation/requests', { json: body({ subject_user_id: 'usr_nobody' }) });
		expect(res.status).toBe(404);
		expect(res.json.error).toBe('subject_not_found');
	});
	it('400 with issues for an invalid body', async () => {
		const res = await clientCall('POST', '/moderation/requests', { json: body({ action: 'nuke' }) });
		expect(res.status).toBe(400);
		expect(res.json.issues[0].path).toBe('action');
	});
	it('a client cannot read another client\'s request', async () => {
		const mine = await fileRequest();
		const res = await clientCall('GET', `/moderation/requests/${mine.id}`, { client: OTHER });
		expect(res.status).toBe(404);
		const own = await clientCall('GET', `/moderation/requests/${mine.id}`);
		expect(own.status).toBe(200);
	});
	it('lists only the calling client\'s requests, filtered by subject', async () => {
		const res = await clientCall('GET', `/moderation/requests?subject_user_id=${SUBJECT}`, { client: OTHER });
		expect(res.status).toBe(200);
		expect(res.json.requests.length).toBeGreaterThan(0);
		for (const r of res.json.requests) expect(r.subject_user_id).toBe(SUBJECT);
		const total = await DB().prepare(`SELECT COUNT(*) n FROM moderation_requests WHERE client_id = ?`).bind(OTHER.id).first<{ n: number }>();
		expect(res.json.total).toBe(total!.n);
	});
});

describe('auth admin decisions', () => {
	it('403 for a signed-in user whose roles lack moderation_requests:manage', async () => {
		const res = await adminCall('GET', '', MODERATOR);
		expect(res.status).toBe(403);
	});
	it('401 without an admin', async () => {
		expect((await adminCall('GET', '', null)).status).toBe(401);
	});
	it('lists the queue with filters for Admin and Super Admin', async () => {
		await fileRequest({ action: 'suspend_account' });
		for (const admin of [ADMIN, SUPER]) {
			const res = await adminCall('GET', '?status=pending&action=suspend_account', admin);
			expect(res.status).toBe(200);
			expect(res.json.requests.length).toBeGreaterThan(0);
			for (const r of res.json.requests) expect(r).toMatchObject({ status: 'pending', action: 'suspend_account', subject: { email: `${SUBJECT}@example.com` } });
			expect(res.json.clients.map((c: { id: string }) => c.id)).toContain(VIDEOS.id);
		}
	});
	it('detail has the user and the user\'s prior requests', async () => {
		const req = await fileRequest();
		const res = await adminCall('GET', `/${req.id}`, ADMIN);
		expect(res.status).toBe(200);
		expect(res.json.subject.id).toBe(SUBJECT);
		expect(res.json.prior_requests.length).toBeGreaterThan(0);
		expect(res.json.prior_requests.every((r: { id: string }) => r.id !== req.id)).toBe(true);
	});
	it('approve queues the action (202); the queue runs it and the client sees actioned', async () => {
		const req = await fileRequest({ action: 'revoke_sessions' });
		const res = await adminCall('POST', `/${req.id}/approve`, ADMIN, { note: 'Confirmed spam' });
		expect(res.status).toBe(202);
		expect(res.json.request).toMatchObject({ status: 'approved', decision_note: 'Confirmed spam', decided_by: ADMIN, execution: { status: 'queued', needs_attention: false } });
		expect(sent).toEqual([{ type: 'moderation.execute', requestId: req.id, adminId: ADMIN }]);
		// The client already sees the decision; the action is still pending
		expect((await clientCall('GET', `/moderation/requests/${req.id}`)).json.request.status).toBe('approved');

		const run = vi.fn(async (): Promise<ActionOutcome> => ({ ok: true, result: { sessionsTerminated: 1 } }));
		expect(await runQueuedAction(new ModerationStore(DB()), run, sent[0], 1)).toBe('done');
		expect(run).toHaveBeenCalledWith('revoke_sessions', SUBJECT, 'default');
		const seen = await clientCall('GET', `/moderation/requests/${req.id}`);
		expect(seen.json.request).toMatchObject({ status: 'actioned', decision_note: 'Confirmed spam' });
		expect(seen.json.request.history.map((h: { type: string }) => h.type)).toEqual(['created', 'approved', 'actioned']);
		expect(JSON.stringify(seen.json)).not.toContain(ADMIN);
		// Final: a second approval is a conflict and queues nothing
		expect((await adminCall('POST', `/${req.id}/approve`, SUPER, {})).status).toBe(409);
		expect(sent).toHaveLength(1);
		// A late duplicate delivery does nothing
		expect(await runQueuedAction(new ModerationStore(DB()), run, sent[0], 2)).toBe('skipped');
		expect(run).toHaveBeenCalledTimes(1);
	});
	it('transient failures retry with backoff; the last one flags the request; execute queues it again', async () => {
		const req = await fileRequest({ action: 'suspend_account' });
		await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		const store = new ModerationStore(DB());
		const failing = vi.fn(async (): Promise<ActionOutcome> => ({ ok: false, permanent: false, error: 'D1 timeout' }));
		expect(await runQueuedAction(store, failing, sent[0], 1)).toBe('retry');
		let row = (await store.get(req.id))!;
		expect(row).toMatchObject({ status: 'approved', execution_status: 'retrying', execution_attempts: 1 });
		expect(row.action_error).toContain('D1 timeout');
		expect(await runQueuedAction(store, failing, sent[0], MAX_ATTEMPTS)).toBe('failed');
		const flagged = await adminCall('GET', `/${req.id}`, ADMIN);
		expect(flagged.json.request.execution).toMatchObject({ status: 'failed', needs_attention: true, attempts: MAX_ATTEMPTS });
		expect(flagged.json.request.history.map((h: { type: string }) => h.type)).toContain('action_failed');
		const queue = await adminCall('GET', '?needs_attention=1&status=approved', ADMIN);
		expect(queue.json.requests.map((r: { id: string }) => r.id)).toContain(req.id);
		expect(queue.json.needs_attention).toBeGreaterThan(0);
		// Run again: re-queued with a fresh attempt count, then succeeds
		const again = await adminCall('POST', `/${req.id}/execute`, ADMIN, {});
		expect(again.status).toBe(202);
		expect(again.json.request.execution).toMatchObject({ status: 'queued', attempts: 0 });
		expect(sent).toHaveLength(2);
		expect(await runQueuedAction(store, async () => ({ ok: true, result: {} }), sent[1], 1)).toBe('done');
		row = (await store.get(req.id))!;
		expect(row).toMatchObject({ status: 'actioned', execution_status: 'done', action_error: null });
	});
	it('a permanent failure flags at once (no retry)', async () => {
		const req = await fileRequest({ action: 'require_password_reset' });
		await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		const store = new ModerationStore(DB());
		expect(await runQueuedAction(store, async () => ({ ok: false, permanent: true, error: 'user_not_found' }), sent[0], 1)).toBe('failed');
		expect((await store.get(req.id))!.execution_status).toBe('failed');
	});
	it('execute is refused while the action is queued', async () => {
		const req = await fileRequest({ action: 'suspend_account' });
		await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		expect((await adminCall('POST', `/${req.id}/execute`, ADMIN, {})).status).toBe(409);
	});
	it('without a queue binding the approval is flagged instead of lost', async () => {
		const req = await fileRequest({ action: 'suspend_account' });
		const headers = new Headers({ 'Content-Type': 'application/json', 'X-Test-Admin': ADMIN });
		const res = await moderationAdminRoutes().fetch(
			new Request(`https://auth.test/admin/moderation-requests/${req.id}/approve`, { method: 'POST', headers, body: '{}' }),
			{ ...(env as unknown as Env), MODERATION_QUEUE: undefined },
			ctx
		);
		expect(res.status).toBe(502);
		const json = (await res.json()) as Record<string, any>;
		expect(json.request.execution).toMatchObject({ status: 'failed', needs_attention: true });
	});
	it('reject needs a note and is final', async () => {
		const req = await fileRequest();
		expect((await adminCall('POST', `/${req.id}/reject`, ADMIN, {})).status).toBe(400);
		const res = await adminCall('POST', `/${req.id}/reject`, ADMIN, { note: 'Not enough evidence' });
		expect(res.json.request).toMatchObject({ status: 'rejected', decision_note: 'Not enough evidence' });
		expect((await adminCall('POST', `/${req.id}/approve`, ADMIN, {})).status).toBe(409);
		expect(sent).toHaveLength(0);
		const seen = await clientCall('GET', `/moderation/requests/${req.id}`);
		expect(seen.json.request).toMatchObject({ status: 'rejected', decision_note: 'Not enough evidence' });
	});
	it('a request rejected after its action was queued is not run', async () => {
		const req = await fileRequest({ action: 'delete_account' });
		await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		await adminCall('POST', `/${req.id}/reject`, SUPER, { note: 'Changed my mind' });
		const run = vi.fn(async (): Promise<ActionOutcome> => ({ ok: true, result: {} }));
		expect(await runQueuedAction(new ModerationStore(DB()), run, sent[0], 1)).toBe('skipped');
		expect(run).not.toHaveBeenCalled();
	});
	it('request-info -> the client answers -> pending again -> approve', async () => {
		const req = await fileRequest({ action: 'require_password_reset' });
		const asked = await adminCall('POST', `/${req.id}/request-info`, ADMIN, { note: 'Which videos?' });
		expect(asked.json.request.status).toBe('info_requested');
		const answered = await clientCall('POST', `/moderation/requests/${req.id}/info`, {
			json: { note: 'Videos 1 and 2', evidence: [{ url: 'https://admin.qa.alummahnow.net/moderation/reports/r1' }], requested_by: { id: 'm1', display_name: 'Videos Moderator' } },
		});
		expect(answered.status).toBe(200);
		expect(answered.json.request.status).toBe('pending');
		expect(answered.json.request.evidence).toHaveLength(2);
		const twice = await clientCall('POST', `/moderation/requests/${req.id}/info`, { json: { note: 'again', requested_by: { id: 'm1', display_name: 'M' } } });
		expect(twice.status).toBe(409);
		const approved = await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		expect(approved.json.request.status).toBe('approved');
		expect(sent).toHaveLength(1);
	});
	it('"other" is approved without queueing anything, then marked actioned by hand', async () => {
		const req = await fileRequest({ action: 'other', reason: 'Merge two accounts' });
		const approved = await adminCall('POST', `/${req.id}/approve`, ADMIN, { note: 'Will merge' });
		expect(approved.status).toBe(200);
		expect(approved.json.request.status).toBe('approved');
		expect(sent).toHaveLength(0);
		const done = await adminCall('POST', `/${req.id}/mark-actioned`, ADMIN, { note: 'Merged' });
		expect(done.json.request.status).toBe('actioned');
	});
	it('an automatic action is closed by hand only after it failed', async () => {
		const req = await fileRequest({ action: 'delete_account' });
		await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		expect((await adminCall('POST', `/${req.id}/mark-actioned`, ADMIN, { note: 'x' })).status).toBe(409);
		await runQueuedAction(new ModerationStore(DB()), async () => ({ ok: false, permanent: true, error: 'boom' }), sent[0], 1);
		const closed = await adminCall('POST', `/${req.id}/mark-actioned`, ADMIN, { note: 'Deleted by hand' });
		expect(closed.json.request).toMatchObject({ status: 'actioned', execution: { status: 'done', needs_attention: false } });
	});
	it('decisions are audit-logged', async () => {
		const spy = vi.spyOn(await import('../audit-emitter'), 'emitAuditEvent');
		const req = await fileRequest();
		await adminCall('POST', `/${req.id}/reject`, ADMIN, { note: 'no' });
		expect(spy.mock.calls.map(([e]) => e.eventType)).toContain('moderation.request.rejected');
		spy.mockRestore();
	});
});

describe('moderation-actions queue', () => {
	function batch(queue: string, messages: ModerationQueueMessage[], attempts = 1) {
		const msgs = messages.map((body) => ({ body, attempts, id: crypto.randomUUID(), timestamp: new Date(), ack: vi.fn(), retry: vi.fn() }));
		return { b: { queue, messages: msgs, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<ModerationQueueMessage>, msgs };
	}
	it('backs off 30 s doubling, capped at 15 minutes', () => {
		expect([1, 2, 3, 4, 5, 6, 7].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 900, 900]);
	});
	it('acks a done action and retries a failing one with its backoff', async () => {
		const ok = await fileRequest({ action: 'suspend_account' });
		const bad = await fileRequest({ action: 'suspend_account' });
		await adminCall('POST', `/${ok.id}/approve`, ADMIN, {});
		await adminCall('POST', `/${bad.id}/approve`, ADMIN, {});
		const { b, msgs } = batch('moderation-actions-qa', [...sent], 2);
		await handleModerationBatch(b, env as unknown as Env, async (_a, userId) => (userId === SUBJECT && msgs[0].retry.mock.calls.length === 0 && msgs[0].ack.mock.calls.length === 0 ? { ok: true, result: {} } : { ok: false, permanent: false, error: 'flaky' }));
		expect(msgs[0].ack).toHaveBeenCalled();
		expect(msgs[1].retry).toHaveBeenCalledWith({ delaySeconds: 60 });
	});
	it('the dead-letter queue flags the request for an auth admin', async () => {
		const req = await fileRequest({ action: 'suspend_account' });
		await adminCall('POST', `/${req.id}/approve`, ADMIN, {});
		const { b, msgs } = batch('moderation-actions-qa-dlq', [...sent]);
		const run = vi.fn();
		await handleModerationBatch(b, env as unknown as Env, run as never);
		expect(run).not.toHaveBeenCalled();
		expect(msgs[0].ack).toHaveBeenCalled();
		const row = (await new ModerationStore(DB()).get(req.id))!;
		expect(row.execution_status).toBe('failed');
		// Flagging twice adds nothing
		await deadLetter(new ModerationStore(DB()), sent[0]);
		const events = await new ModerationStore(DB()).events(req.id);
		expect(events.filter((e) => e.type === 'action_failed')).toHaveLength(1);
	});
	it('drops malformed messages', async () => {
		const { b, msgs } = batch('moderation-actions-qa', [{ type: 'other' } as never]);
		await handleModerationBatch(b, env as unknown as Env, vi.fn() as never);
		expect(msgs[0].ack).toHaveBeenCalled();
	});
});

describe('account actions', () => {
	it('deleting an account that is already gone counts as done; a missing user is permanent; other errors retry', () => {
		const notFound = Object.assign(new Error('User x not found'), { code: 'user_not_found' });
		expect(classifyActionError('delete_account', notFound)).toEqual({ ok: true, result: { alreadyDeleted: true } });
		expect(classifyActionError('suspend_account', notFound)).toMatchObject({ ok: false, permanent: true });
		expect(classifyActionError('suspend_account', new Error('D1_ERROR: timeout'))).toMatchObject({ ok: false, permanent: false });
	});
});
