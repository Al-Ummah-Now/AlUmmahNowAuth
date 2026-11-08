import { describe, expect, it } from 'vitest';
import { checkWorker, type Deps } from '../check-secrets.ts';
import type { WorkerBinding } from '../cf-api.ts';
import { generateClientSecret, hashClientSecret, parseArgs, verifyClientSecret } from '../rotate-client-secret.ts';
import { SECRETS_MANIFEST, type WorkerSecrets } from '../secrets-manifest.ts';

const STORE = 'store1';

function deps(bindings: WorkerBinding[] | null, opts: { store?: { name: string; status?: string }[]; clients?: Record<string, boolean> } = {}): Deps {
	return {
		bindings: async () => bindings,
		storeSecrets: async () => opts.store ?? [],
		clientIds: async (_db, ids) => new Map(ids.filter((id) => id in (opts.clients ?? {})).map((id) => [id, opts.clients![id]])),
	};
}

const entry: WorkerSecrets = {
	app: 'admin',
	env: 'production',
	worker: 'w',
	required: [
		{ name: 'ADMIN_CLIENT_SECRET', purpose: 'p' },
		{ name: 'RESEND_API_KEY', purpose: 'p' },
	],
	forbidden: ['E2E_CODE_SINK_SECRET'],
	clientIdVars: [{ name: 'ADMIN_CLIENT_ID', required: true }],
};

const failures = (fs: { ok: boolean; check: string }[]) => fs.filter((f) => !f.ok).map((f) => f.check);

describe('checkWorker', () => {
	it('passes a fully seeded worker', async () => {
		const fs = await checkWorker(
			entry,
			deps(
				[
					{ type: 'secret_text', name: 'ADMIN_CLIENT_SECRET' },
					{ type: 'secrets_store_secret', name: 'RESEND_API_KEY', secret_name: 'RESEND_API_KEY', store_id: STORE },
					{ type: 'plain_text', name: 'ADMIN_CLIENT_ID', text: 'client-a' },
				],
				{ store: [{ name: 'RESEND_API_KEY', status: 'active' }], clients: { 'client-a': true } }
			)
		);
		expect(failures(fs)).toEqual([]);
		expect(fs.map((f) => f.check)).toContain('worker exists');
	});

	it('reports the 2026-11-08 admin outage: no secret, client id not in D1', async () => {
		const fs = await checkWorker(entry, deps([{ type: 'plain_text', name: 'ADMIN_CLIENT_ID', text: 'admin-dashboard-m2m' }]));
		expect(failures(fs)).toEqual([
			'secret ADMIN_CLIENT_SECRET',
			'secret RESEND_API_KEY',
			'client admin-dashboard-m2m (var ADMIN_CLIENT_ID)',
		]);
	});

	it('fails a Secrets Store binding whose secret was deleted', async () => {
		const fs = await checkWorker(
			{ ...entry, required: [{ name: 'RESEND_API_KEY', purpose: 'p' }], clientIdVars: [] },
			deps([{ type: 'secrets_store_secret', name: 'RESEND_API_KEY', secret_name: 'GONE', store_id: STORE }])
		);
		expect(fs.find((f) => f.check === 'secret RESEND_API_KEY')).toMatchObject({ ok: false, detail: 'Secrets Store GONE does not exist' });
	});

	it('fails forbidden test secrets, disabled clients and missing required vars', async () => {
		const fs = await checkWorker(
			{ ...entry, required: [], fixedClientIds: ['fixed-1'] },
			deps([{ type: 'secret_text', name: 'E2E_CODE_SINK_SECRET' }], { clients: { 'fixed-1': false } })
		);
		expect(failures(fs)).toEqual(['forbidden E2E_CODE_SINK_SECRET', 'client var ADMIN_CLIENT_ID', 'client fixed-1 (fixed in code)']);
	});

	it('fails a worker that is not deployed', async () => {
		expect(failures(await checkWorker(entry, deps(null)))).toEqual(['worker exists']);
	});
});

describe('secrets manifest', () => {
	it('never requires a test-only secret in production', () => {
		for (const e of SECRETS_MANIFEST.filter((x) => x.env === 'production')) {
			for (const r of e.required ?? []) expect(e.forbidden ?? []).not.toContain(r.name);
		}
	});
});

describe('rotate-client-secret', () => {
	it('hashes in the openauth $pbkdf2-sha256$100000$salt$hash format and verifies', async () => {
		const secret = generateClientSecret();
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const hash = await hashClientSecret(secret);
		expect(hash).toMatch(/^\$pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
		expect(await verifyClientSecret(secret, hash)).toBe(true);
		expect(await verifyClientSecret(`${secret}x`, hash)).toBe(false);
	});

	it('requires every consumer to be named', () => {
		expect(() => parseArgs(['--db', 'd', '--client', 'c'])).toThrow(/at least one consumer/);
		expect(parseArgs(['--db', 'd', '--client', 'c', '--worker', 'w:NAME', '--gh-secret', 'o/r:GH']).targets).toEqual([
			{ kind: 'worker', scope: 'w', name: 'NAME' },
			{ kind: 'gh', scope: 'o/r', name: 'GH' },
		]);
	});
});
