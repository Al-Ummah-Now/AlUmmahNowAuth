import { describe, expect, it } from 'vitest';
import { census, QA_AUTH, report } from '../e2e-census.ts';

const page = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const count = (total: number) => ({ total, old: total, deleted: 0, marked: 0, admin: 1, active: 0 });

describe('e2e-census', () => {
	it('adds up the pages, only reads, and only from QA', async () => {
		const calls: { url: string; method: string }[] = [];
		const pages = [page({ scanned: 2, counts: { kept: count(1), disposable: count(1) }, next: 'u2' }), page({ scanned: 1, counts: { disposable: count(1) }, next: null })];
		const result = await census({
			sinkSecret: 's',
			testSecret: 't',
			pauseMs: 0,
			fetchImpl: (async (url: string, init: RequestInit = {}) => {
				calls.push({ url, method: init.method ?? 'GET' });
				return pages.shift()!;
			}) as typeof fetch,
		});
		expect(result).toEqual({ pages: 2, scanned: 3, totals: { kept: count(1), disposable: { ...count(2), admin: 2 } } });
		expect(calls).toEqual([
			{ url: `${QA_AUTH}/test/run-users/census?after=`, method: 'GET' },
			{ url: `${QA_AUTH}/test/run-users/census?after=u2`, method: 'GET' },
		]);
		expect(report(result)).toContain('| disposable | 2 | 2 | 0 | 0 | 2 | 0 |');
	});

	it('stops on an error and when it does not move forward', async () => {
		const run = (responses: Response[]) => census({ sinkSecret: 's', testSecret: 't', pauseMs: 0, fetchImpl: (async () => responses.shift()!) as typeof fetch });
		await expect(run([page({}, 401)])).rejects.toThrow('HTTP 401');
		await expect(run([page({ scanned: 1, counts: {}, next: 'u1' }), page({ scanned: 1, counts: {}, next: 'u1' })])).rejects.toThrow('move forward');
	});
});
