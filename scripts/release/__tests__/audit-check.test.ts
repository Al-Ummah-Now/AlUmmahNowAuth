import { describe, expect, it, vi } from 'vitest';
import { CANARY_EVENT_TYPE, canaryMessage, runAuditCheck } from '../audit-check.ts';
import { AUTH_DBS } from '../secrets-manifest.ts';
import type { CfClient } from '../cf-api.ts';

function fakeCf(opts: { queues?: { queue_id: string; queue_name: string }[]; landsAfterPolls?: number }) {
	let polls = 0;
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const cf: CfClient = {
		accountId: 'acct',
		request: vi.fn(async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			if (path.startsWith('/queues?')) return opts.queues ?? [{ queue_id: 'q1', queue_name: 'audit-events' }];
			if (path.endsWith('/messages')) return {};
			polls++;
			return [{ results: [{ c: opts.landsAfterPolls !== undefined && polls >= opts.landsAfterPolls ? 1 : 0 }] }];
		}) as CfClient['request'],
	};
	return { cf, calls };
}

function clock() {
	let t = 1_000_000;
	return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('runAuditCheck', () => {
	it('publishes a canary to the env queue and passes once its row lands', async () => {
		const { cf, calls } = fakeCf({ landsAfterPolls: 2 });
		const detail = await runAuditCheck(cf, { env: 'production', canaryId: 'c-1', ...clock() });
		expect(detail).toContain('c-1');
		expect(calls[0].path).toBe('/queues?name=audit-events');
		expect(calls[1].path).toBe('/queues/q1/messages');
		expect(calls[1].body).toMatchObject({ content_type: 'json', body: { type: 'app_audit_event', event: { requestId: 'c-1' } } });
		const query = calls[2];
		expect(query.path).toBe(`/d1/database/${AUTH_DBS.production}/query`);
		expect(query.body).toMatchObject({ params: [CANARY_EVENT_TYPE, 'c-1'] });
	});

	it('fails when the row never lands (the 2026-11-08 prod state)', async () => {
		const { cf } = fakeCf({});
		await expect(runAuditCheck(cf, { env: 'production', timeoutMs: 20_000, ...clock() })).rejects.toThrow(/did not reach audit_events/);
	});

	it('fails when the queue does not exist', async () => {
		const { cf } = fakeCf({ queues: [] });
		await expect(runAuditCheck(cf, { env: 'stage', ...clock() })).rejects.toThrow(/audit-events-stage not found/);
	});

	it('sends the shape the consumer routes to audit_events', () => {
		const { body } = canaryMessage('c-2', Date.UTC(2026, 10, 8));
		expect(body.type).toBe('app_audit_event');
		expect(body.event.timestamp).toBe('2026-11-08T00:00:00.000Z');
		expect(body.event.eventType).toBe(CANARY_EVENT_TYPE);
	});
});
