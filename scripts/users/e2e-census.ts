/**
 * Dry run for #312: how many accounts of each kind the QA auth database holds. Walks
 * GET /test/run-users/census one page at a time, with a pause, and prints totals only.
 * It reads; it cannot delete (the route has no such power).
 *
 *   E2E_CODE_SINK_SECRET=... TEST_PROMOTE_SECRET=... \
 *     node --experimental-strip-types scripts/users/e2e-census.ts
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** QA only: there is no option for another host. */
export const QA_AUTH = 'https://auth.qa.alummahnow.net';
const KINDS = ['run', 'kept', 'disposable', 'other', 'outside'] as const;
type Count = { total: number; old: number; deleted: number; marked: number };
export type Totals = Record<string, Count>;

export async function census(opts: {
	sinkSecret: string;
	testSecret: string;
	fetchImpl?: typeof fetch;
	pauseMs?: number;
	maxPages?: number;
}): Promise<{ pages: number; scanned: number; totals: Totals }> {
	const doFetch = opts.fetchImpl ?? fetch;
	const totals: Totals = {};
	let after = '';
	let scanned = 0;
	for (let pages = 1; pages <= (opts.maxPages ?? 400); pages++) {
		const res = await doFetch(`${QA_AUTH}/test/run-users/census?after=${encodeURIComponent(after)}`, {
			headers: { 'X-E2E-Secret': opts.sinkSecret, 'X-Test-Secret': opts.testSecret },
		});
		if (!res.ok) throw new Error(`census page ${pages} failed: HTTP ${res.status}`);
		const body = (await res.json()) as { scanned: number; counts: Totals; next: string | null };
		scanned += body.scanned;
		for (const [kind, c] of Object.entries(body.counts)) {
			const t = (totals[kind] ??= { total: 0, old: 0, deleted: 0, marked: 0 });
			for (const key of ['total', 'old', 'deleted', 'marked'] as const) t[key] += c[key];
		}
		if (body.next === null) return { pages, scanned, totals };
		if (body.next <= after) throw new Error('census did not move forward');
		after = body.next;
		// D1 runs one query at a time: leave room for sign-ins between pages
		await new Promise((r) => setTimeout(r, opts.pauseMs ?? 500));
	}
	throw new Error('census did not finish within its page limit');
}

export function report(r: { pages: number; scanned: number; totals: Totals }): string {
	const lines = [`${r.scanned} accounts read in ${r.pages} pages. Nothing was changed.`, '', '| Kind | Accounts | Older than 24 h | Already soft-deleted | Has the run marker |', '|---|---|---|---|---|'];
	for (const kind of KINDS) {
		const c = r.totals[kind] ?? { total: 0, old: 0, deleted: 0, marked: 0 };
		lines.push(`| ${kind} | ${c.total} | ${c.old} | ${c.deleted} | ${c.marked} |`);
	}
	return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const sinkSecret = process.env.E2E_CODE_SINK_SECRET;
	const testSecret = process.env.TEST_PROMOTE_SECRET;
	if (!sinkSecret || !testSecret) {
		process.stderr.write('E2E_CODE_SINK_SECRET and TEST_PROMOTE_SECRET are required\n');
		process.exit(2);
	}
	process.stdout.write(report(await census({ sinkSecret, testSecret })));
}
