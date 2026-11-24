import { describe, expect, it } from 'vitest';
import { QA_AUTH, report, run, type Counts } from '../e2e-disposable.ts';

const page = (over: Partial<Counts> & { next?: string | null; dryRun?: boolean; recentPrefixes?: Record<string, number> } = {}) =>
	new Response(
		JSON.stringify({ dryRun: true, scanned: 2, eligible: 1, eligibleAdmins: 0, deleted: 0, deletedAdmins: 0, skipped: 0, failed: 0, recentPrefixes: {}, next: null, ...over })
	);

function harness(responses: (Response | Error)[]) {
	const urls: string[] = [];
	const sleeps: number[] = [];
	return {
		urls,
		sleeps,
		opts: {
			sinkSecret: 's',
			testSecret: 't',
			max: 100,
			sleep: async (ms: number) => void sleeps.push(ms),
			fetchImpl: (async (url: string) => {
				urls.push(url);
				const r = responses.shift();
				if (!r || r instanceof Error) throw r ?? new Error('no more responses');
				return r;
			}) as typeof fetch,
		},
	};
}

describe('e2e-disposable', () => {
	it('is a dry run unless asked to delete, and only ever talks to QA', async () => {
		const h = harness([page({ next: 'u2', recentPrefixes: { 'new-user': 2 } }), page({ recentPrefixes: { 'new-user': 1 } })]);
		const r = await run({ ...h.opts, delete: false });
		expect(h.urls).toEqual([`${QA_AUTH}/test/run-users/disposable?dryRun=1&after=`, `${QA_AUTH}/test/run-users/disposable?dryRun=1&after=u2`]);
		expect(h.sleeps).toEqual([1000]);
		expect(r).toMatchObject({ dryRun: true, finished: true, calls: 2, counts: { scanned: 4, eligible: 2, deleted: 0 } });
		expect(report(r)).toContain('nothing was changed');
		expect(report(r)).toContain('| new-user | 3 |');
	});

	it('deletes in pages, counts admins apart, and stops at the limit', async () => {
		const h = harness([
			page({ dryRun: false, deleted: 10, deletedAdmins: 4, next: 'u1' }),
			page({ dryRun: false, deleted: 10, deletedAdmins: 1, next: 'u2' }),
			page({ dryRun: false, deleted: 10, next: 'u3' }),
		]);
		const r = await run({ ...h.opts, delete: true, max: 20 });
		expect(r).toMatchObject({ finished: false, calls: 2, counts: { deleted: 20, deletedAdmins: 5 } });
		expect(h.urls[0]).toContain('dryRun=0');
		expect(report(r)).toContain('Deleted 20 accounts (5 of them test-made admins). Stopped at the limit');
	});

	it('repeats a dropped connection or a 5xx, from the same place', async () => {
		const h = harness([page({ next: 'u1' }), new Error('ECONNRESET'), new Response('', { status: 503 }), page()]);
		expect((await run({ ...h.opts, delete: false })).finished).toBe(true);
		expect(h.urls.slice(1).every((u) => u.endsWith('after=u1'))).toBe(true);
	});

	it('never repeats a refusal', async () => {
		for (const status of [401, 404]) {
			const h = harness([new Response('', { status })]);
			await expect(run({ ...h.opts, delete: true })).rejects.toThrow(`HTTP ${status}`);
			expect(h.urls).toHaveLength(1);
		}
	});

	it('stops when too many accounts fail, when it stands still, or when the mode is wrong', async () => {
		const failing = harness([page({ dryRun: false, failed: 26, next: 'u1' })]);
		await expect(run({ ...failing.opts, delete: true })).rejects.toThrow('26 accounts failed');
		const still = harness([page({ next: 'u1' }), page({ next: 'u1' })]);
		await expect(run({ ...still.opts, delete: false })).rejects.toThrow('move forward');
		const wrong = harness([page({ dryRun: false })]);
		await expect(run({ ...wrong.opts, delete: false })).rejects.toThrow('mode');
	});
});
