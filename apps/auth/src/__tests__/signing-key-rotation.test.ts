/**
 * Signing-key rotation (#13, signing-keys/rotation.ts): the step policy, the
 * queued job (retry, failure flagged), and Admin > Signing keys.
 *
 * Rotation runs on its own in-memory key store here: the D1 key index is the
 * one every other test file's issuer signs with, and retiring its keys would
 * break them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { MemoryStorage } from '@al-ummah-now/openauth/storage/memory';
import { listSigningKeys } from '@al-ummah-now/openauth/keys';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { setupDatabase } from '../test-setup';
import {
	MAX_ATTEMPTS,
	PUBLISH_LEAD_MS,
	ROTATE_EVERY_MS,
	ROTATION_STATUS_SETTING,
	deadLetterRotation,
	enqueueRotation,
	handleRotationMessages,
	readRotationStatus,
	retireAfterMs,
	rotationStep,
	runRotation,
	type RotationMessage,
} from '../signing-keys/rotation';

// The acting admin comes from a test header (verifyAdminRequest is tested elsewhere)
vi.mock('../auth-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../auth-middleware')>()),
	verifyAdminRequest: async (request: Request) => {
		const id = request.headers.get('X-Test-Admin');
		if (!id) throw new Error('Unauthorized');
		return { type: 'm2m', clientId: 'admin-app', tenantId: 'default', scopes: ['admin:*'], actingUser: { id, email: `${id}@example.com`, roles: (request.headers.get('X-Test-Roles') ?? '').split(',') } };
	},
}));
const { handleSigningKeys } = await import('../signing-keys/routes');

const DB = () => (env as unknown as Env).AUTH_DB;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const RETIRE = retireAfterMs(900);

let storage: StorageAdapter;
const sent: RotationMessage[] = [];
const fakeQueue = { send: vi.fn(async (m: RotationMessage) => void sent.push(m)) };
const testEnv = (over: Partial<Env> = {}) => ({ ...(env as unknown as Env), MODERATION_QUEUE: fakeQueue as unknown as Queue, ACCESS_TOKEN_TTL: '900', SIGNING_KEY_ROTATION_SCHEDULE: 'on', ...over });
/** A step at `now` (the key store reads the clock too, so the clock moves with it). */
const step = (now: number, force = false) => {
	vi.setSystemTime(now);
	return rotationStep(storage, { now, force, retireAfterMs: RETIRE });
};
const states = async (now: number) =>
	(await listSigningKeys(storage)).map((k) => ({
		id: k.id,
		state: k.expired ? 'retired' : k.activates && k.activates > now ? 'pending' : 'live',
	}));

beforeAll(async () => {
	await setupDatabase();
});

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	storage = MemoryStorage();
	sent.length = 0;
	fakeQueue.send.mockClear();
	await DB().prepare(`DELETE FROM auth_settings WHERE key = ?`).bind(ROTATION_STATUS_SETTING).run();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('retireAfterMs', () => {
	it('is twice the longest token lifetime, at least a day', () => {
		expect(retireAfterMs(900)).toBe(DAY); // 15-minute access tokens, 1-hour M2M tokens
		expect(retireAfterMs(2 * DAY / 1000)).toBe(4 * DAY);
		expect(retireAfterMs(undefined)).toBe(60 * DAY); // openauth's 30-day default
	});
});

describe('rotationStep', () => {
	it('publishes a pending key, switches at activation and retires the old key after the overlap', async () => {
		const first = await step(T0);
		// A fresh key is not due: nothing to do
		expect(first.added).toBeNull();
		const oldKid = first.active!;

		const forced = await step(T0, true);
		expect(forced.added?.activates).toBe(T0 + PUBLISH_LEAD_MS);
		const newKid = forced.added!.id;
		expect(await states(T0)).toEqual(expect.arrayContaining([{ id: oldKid, state: 'live' }, { id: newKid, state: 'pending' }]));
		// One rotation at a time
		expect((await step(T0, true)).added).toBeNull();

		// Activation: the new key signs, the old one still verifies
		const switched = T0 + PUBLISH_LEAD_MS;
		const s1 = await step(switched);
		expect(s1.active).toBe(newKid);
		expect(s1.retired).toEqual([]);
		// Not yet: the overlap has not passed
		expect((await step(switched + RETIRE - 1)).retired).toEqual([]);
		const s2 = await step(switched + RETIRE);
		expect(s2.retired).toEqual([oldKid]);
		expect(await states(switched + RETIRE)).toEqual(expect.arrayContaining([{ id: oldKid, state: 'retired' }, { id: newKid, state: 'live' }]));
		// Idempotent
		expect(await step(switched + RETIRE)).toEqual({ added: null, retired: [], active: newKid });
	});

	it('adds a successor on schedule once the key in use is due', async () => {
		await step(T0);
		expect((await step(T0 + ROTATE_EVERY_MS - 1)).added).toBeNull();
		expect((await step(T0 + ROTATE_EVERY_MS)).added?.activates).toBe(T0 + ROTATE_EVERY_MS + PUBLISH_LEAD_MS);
	});
});

describe('the rotation job', () => {
	const message = (over: Partial<RotationMessage> = {}): RotationMessage => ({ type: 'signing-keys.rotate', trigger: 'admin', adminId: 'usr_super', force: true, requestedAt: T0, ...over });

	it('rotate now: queued with the admin, runs, records the status', async () => {
		expect(await enqueueRotation(testEnv(), 'admin', 'usr_super')).toBe(true);
		expect(sent).toEqual([expect.objectContaining({ type: 'signing-keys.rotate', trigger: 'admin', adminId: 'usr_super', force: true })]);
		expect((await readRotationStatus(DB())).queuedBy).toBe('usr_super');

		expect(await runRotation(testEnv(), sent[0], 1, storage)).toBe('done');
		const status = await readRotationStatus(DB());
		expect(status.lastTrigger).toBe('admin');
		expect(status.lastAdded).toBeTruthy();
		expect(status.queuedAt).toBeNull();
		expect(status.error).toBeNull();
		expect((await states(T0)).some((k) => k.state === 'pending')).toBe(true);
	});

	it('the schedule never forces a rotation', async () => {
		await enqueueRotation(testEnv(), 'schedule');
		expect(sent[0].force).toBeUndefined();
		expect(await runRotation(testEnv(), sent[0], 1, storage)).toBe('done');
		expect((await states(T0)).every((k) => k.state === 'live')).toBe(true);
	});

	it('schedule on: a due key gets a successor; schedule off: only rotate now starts one', async () => {
		const schedule = message({ trigger: 'schedule', force: undefined, adminId: undefined });
		await listSigningKeys(storage); // the first key, created at T0
		vi.setSystemTime(T0 + ROTATE_EVERY_MS);
		expect(await runRotation(testEnv({ SIGNING_KEY_ROTATION_SCHEDULE: 'off' }), schedule, 1, storage)).toBe('done');
		expect((await states(T0 + ROTATE_EVERY_MS)).some((k) => k.state === 'pending')).toBe(false);
		expect(await runRotation(testEnv(), schedule, 1, storage)).toBe('done');
		expect((await states(T0 + ROTATE_EVERY_MS)).some((k) => k.state === 'pending')).toBe(true);
	});

	it('schedule off still finishes a rotation: the replaced key is retired', async () => {
		const off = testEnv({ SIGNING_KEY_ROTATION_SCHEDULE: 'off' });
		await runRotation(off, message(), 1, storage);
		const later = T0 + PUBLISH_LEAD_MS + RETIRE;
		vi.setSystemTime(later);
		expect(await runRotation(off, message({ trigger: 'schedule', force: undefined, adminId: undefined }), 1, storage)).toBe('done');
		expect((await states(later)).map((k) => k.state).sort()).toEqual(['live', 'retired']);
		expect((await readRotationStatus(DB())).lastRetired).toHaveLength(1);
	});

	it('retries a failing step, then flags it for an admin', async () => {
		const broken = { ...storage, get: async () => { throw new Error('D1 unavailable'); } } as unknown as StorageAdapter;
		const atomicBroken = { ...broken, atomic: { get: async () => { throw new Error('D1 unavailable'); } } } as unknown as StorageAdapter;
		expect(await runRotation(testEnv(), message(), 1, atomicBroken)).toBe('retry');
		expect((await readRotationStatus(DB())).error).toBeNull();
		expect(await runRotation(testEnv(), message(), MAX_ATTEMPTS, atomicBroken)).toBe('failed');
		const status = await readRotationStatus(DB());
		expect(status.error).toMatch(/D1 unavailable/);
		expect(status.attempts).toBe(MAX_ATTEMPTS);
		// The next good run clears the flag
		expect(await runRotation(testEnv(), message(), 1, storage)).toBe('done');
		expect((await readRotationStatus(DB())).error).toBeNull();
	});

	it('the dead-letter queue flags the failure', async () => {
		await deadLetterRotation(testEnv(), message(), 7);
		expect((await readRotationStatus(DB())).error).toMatch(/after every retry/);
	});

	it('without a queue, rotate now is flagged instead of lost', async () => {
		expect(await enqueueRotation(testEnv({ MODERATION_QUEUE: undefined }), 'admin', 'usr_super')).toBe(false);
		expect((await readRotationStatus(DB())).error).toMatch(/not configured/);
	});

	it('batch handler: acks rotation messages, retries failures, leaves other jobs alone', async () => {
		const acks: string[] = [];
		const retries: string[] = [];
		const msg = (id: string, body: unknown, attempts = 1) => ({ id, body, attempts, timestamp: new Date(), ack: () => acks.push(id), retry: () => retries.push(id) });
		const batch = { queue: 'moderation-actions-qa', messages: [msg('m1', { type: 'moderation.execute', requestId: 'r1' }), msg('m2', { type: 'signing-keys.rotate', trigger: 'schedule', requestedAt: T0 })] };
		await handleRotationMessages(batch as unknown as MessageBatch<unknown>, testEnv());
		expect(acks).toEqual(['m2']);
		expect(retries).toEqual([]);
		acks.length = 0;
		const dlq = { queue: 'moderation-actions-qa-dlq', messages: [msg('m3', message(), 7)] };
		await handleRotationMessages(dlq as unknown as MessageBatch<unknown>, testEnv());
		expect(acks).toEqual(['m3']);
		expect((await readRotationStatus(DB())).error).toMatch(/after every retry/);
	});
});

describe('Admin > Signing keys', () => {
	const call = (method: string, roles: string | null, body?: unknown) =>
		handleSigningKeys(
			new Request('https://auth.test/admin/settings/signing-keys', {
				method,
				headers: { 'Content-Type': 'application/json', ...(roles !== null ? { 'X-Test-Admin': 'usr_admin', 'X-Test-Roles': roles } : {}) },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			testEnv(),
			ctx,
			'req-test'
		);

	it('lists keys without key material, with the policy and status', async () => {
		vi.useRealTimers();
		const res = await call('GET', 'Admin');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { keys: Record<string, unknown>[]; policy: Record<string, number>; canRotate: boolean };
		expect(body.keys.length).toBeGreaterThan(0);
		expect(body.keys.some((k) => k.state === 'active')).toBe(true);
		for (const k of body.keys) {
			expect(k).not.toHaveProperty('privateKey');
			expect(k).not.toHaveProperty('publicKey');
		}
		expect(body.policy).toEqual({ publishLeadMs: PUBLISH_LEAD_MS, rotateEveryMs: ROTATE_EVERY_MS, retireAfterMs: DAY, scheduled: true });
		expect(body.canRotate).toBe(false);
	});

	it('rotate now: Super Admin only, queued', async () => {
		expect((await call('POST', null, { action: 'rotate' })).status).toBe(403);
		expect((await call('POST', 'Admin', { action: 'rotate' })).status).toBe(403);
		expect((await call('POST', 'Super Admin', { action: 'nope' })).status).toBe(400);
		const res = await call('POST', 'Super Admin', { action: 'rotate' });
		expect(res.status).toBe(202);
		expect(sent).toEqual([expect.objectContaining({ trigger: 'admin', adminId: 'usr_admin', force: true })]);
		expect((await call('DELETE', 'Super Admin')).status).toBe(405);
	});

	it('retry: runs the step again without starting a rotation', async () => {
		const res = await call('POST', 'Super Admin', { action: 'retry' });
		expect(res.status).toBe(202);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ trigger: 'admin', adminId: 'usr_admin' });
		expect(sent[0].force).toBeUndefined();
	});
});
