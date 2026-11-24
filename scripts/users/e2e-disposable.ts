/**
 * QA's cleanup of old test accounts (#312): walks POST /test/run-users/disposable until the end,
 * with a pause between calls, and prints counts. What may be deleted, and that this is QA's
 * database, is decided by the server (apps/auth/src/routes/test-disposable-users.ts).
 *
 *   node --experimental-strip-types scripts/users/e2e-disposable.ts                    # dry run
 *   node --experimental-strip-types scripts/users/e2e-disposable.ts --delete --max 5000
 *
 * Needs E2E_CODE_SINK_SECRET and TEST_PROMOTE_SECRET (QA's). Stopping it at any point is safe:
 * deleted accounts are gone, so the next run starts from the beginning and goes on.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** At most this many deletions per call (the server's own limit is the same) */
const PER_CALL = 10;

/** QA only: there is no option for another host. */
export const QA_AUTH = 'https://auth.qa.alummahnow.net';
const COUNTS = ['scanned', 'eligible', 'eligibleAdmins', 'deleted', 'deletedAdmins', 'skipped', 'failed'] as const;
export type Counts = Record<(typeof COUNTS)[number], number>;
interface Page extends Counts {
	dryRun: boolean;
	recentPrefixes: Record<string, number>;
	next: string | null;
}

export interface Options {
	sinkSecret: string;
	testSecret: string;
	/** Delete; otherwise only count */
	delete: boolean;
	/** Stop after this many deletions */
	max: number;
	/** Stop when more accounts than this failed */
	maxFailed?: number;
	pauseMs?: number;
	fetchImpl?: typeof fetch;
	log?: (line: string) => void;
	sleep?: (ms: number) => Promise<void>;
}

export interface Result {
	dryRun: boolean;
	finished: boolean;
	calls: number;
	counts: Counts;
	recentPrefixes: Record<string, number>;
}

export async function run(opts: Options): Promise<Result> {
	const doFetch = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const log = opts.log ?? (() => {});
	const counts = Object.fromEntries(COUNTS.map((c) => [c, 0])) as Counts;
	const recentPrefixes: Record<string, number> = {};
	const result = (finished: boolean, calls: number): Result => ({ dryRun: !opts.delete, finished, calls, counts, recentPrefixes });

	const call = async (after: string): Promise<Page> => {
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await doFetch(`${QA_AUTH}/test/run-users/disposable?dryRun=${opts.delete ? 0 : 1}&limit=${Math.min(PER_CALL, Math.max(1, opts.max - counts.deleted))}&after=${encodeURIComponent(after)}`, {
					method: 'POST',
					headers: { 'X-E2E-Secret': opts.sinkSecret, 'X-Test-Secret': opts.testSecret },
				});
				if (res.ok) return (await res.json()) as Page;
				// Refused: wrong secret, or not QA's database. Never repeat that
				if (res.status < 500 && res.status !== 429) throw new Refused(`HTTP ${res.status}`);
				throw new Error(`HTTP ${res.status}`);
			} catch (error) {
				// A dropped connection is safe to repeat: the server re-reads every account
				if (error instanceof Refused || attempt === 4) throw error;
				await sleep(attempt * 5000);
			}
		}
	};

	let after = '';
	for (let calls = 1; ; calls++) {
		const page = await call(after);
		if (page.dryRun === opts.delete) throw new Error('the server did not run in the mode that was asked for');
		for (const c of COUNTS) counts[c] += page[c];
		for (const [prefix, n] of Object.entries(page.recentPrefixes)) recentPrefixes[prefix] = (recentPrefixes[prefix] ?? 0) + n;
		if (calls % 50 === 0) log(`${calls} calls: ${COUNTS.map((c) => `${c} ${counts[c]}`).join(', ')}`);
		if (counts.failed > (opts.maxFailed ?? 25)) throw new Error(`stopped: ${counts.failed} accounts failed`);
		if (page.next === null) return result(true, calls);
		if (page.next <= after) throw new Error('did not move forward');
		if (opts.delete && counts.deleted >= opts.max) return result(false, calls);
		after = page.next;
		// D1 runs one query at a time: leave room for sign-ins
		await sleep(opts.pauseMs ?? 1000);
	}
}

class Refused extends Error {}

export function report(r: Result): string {
	const c = r.counts;
	const lines = [
		r.dryRun ? 'Dry run: nothing was changed.' : `Deleted ${c.deleted} accounts (${c.deletedAdmins} of them test-made admins).${r.finished ? '' : ' Stopped at the limit; run it again to go on.'}`,
		'',
		'| | All | Admins |',
		'|---|---|---|',
		`| May be deleted | ${c.eligible} | ${c.eligibleAdmins} |`,
		`| Deleted | ${c.deleted} | ${c.deletedAdmins} |`,
		'',
		`Read ${c.scanned} accounts in ${r.calls} calls. Left alone because they changed meanwhile: ${c.skipped}. Failed: ${c.failed}.`,
	];
	const recent = Object.entries(r.recentPrefixes).sort((a, b) => b[1] - a[1]);
	if (recent.length) lines.push('', 'Test accounts made in the last 24 hours, by the start of the address:', '', '| Start | Accounts |', '|---|---|', ...recent.map(([p, n]) => `| ${p} | ${n} |`));
	return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const argv = process.argv.slice(2);
	const sinkSecret = process.env.E2E_CODE_SINK_SECRET;
	const testSecret = process.env.TEST_PROMOTE_SECRET;
	const max = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : 5000;
	if (!sinkSecret || !testSecret || !Number.isInteger(max) || max < 1) {
		process.stderr.write('E2E_CODE_SINK_SECRET and TEST_PROMOTE_SECRET are required; --max is a whole number\n');
		process.exit(2);
	}
	process.stdout.write(report(await run({ sinkSecret, testSecret, delete: argv.includes('--delete'), max, log: (l) => process.stderr.write(`${l}\n`) })));
}
