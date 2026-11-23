/**
 * The record of a production release: a `vYYYY.MM.DD[.N]` GitHub release (US Eastern date) on the
 * promoted commit, with what changed since the last record, the worker versions and how to roll back.
 * release.yml runs it after a successful promote; a superseded or rolled-back run records nothing.
 *
 *   node --experimental-strip-types scripts/release/record.ts --result release-result.json
 *
 * Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA and the full git history with tags.
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Released } from './promote.ts';

/** vYYYY.MM.DD, or vYYYY.MM.DD.N with N >= 2 for the second and later releases of a day. */
export const RECORD_TAG = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.([2-9]|[1-9]\d+))?$/;

const order = (tag: string): number[] => {
	const m = RECORD_TAG.exec(tag)!;
	return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 1)];
};

/** Newest first; tags of any other shape (local-stack-*) are left out. */
export function recordTags(tags: string[]): string[] {
	return tags
		.filter((t) => RECORD_TAG.test(t))
		.sort((a, b) => {
			const [x, y] = [order(a), order(b)];
			for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
			return 0;
		});
}

/** The day in US Eastern, as every other release tag of the org (never UTC). */
export function easternDay(now: Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
	const part = (type: string) => parts.find((p) => p.type === type)!.value;
	return `${part('year')}.${part('month')}.${part('day')}`;
}

export function nextTag(tags: string[], now: Date): string {
	const day = `v${easternDay(now)}`;
	const taken = recordTags(tags).filter((t) => t === day || t.startsWith(`${day}.`));
	return taken.length === 0 ? day : `${day}.${Math.max(...taken.map((t) => order(t)[3])) + 1}`;
}

export interface ReleaseResult {
	status: string;
	released: Released[];
}

export interface RecordInput {
	repo: string;
	sha: string;
	/** The previous record's tag; null for the first one */
	previous: string | null;
	prs: { number: number; title: string }[];
	/** Commits without a merged pull request */
	commits: { sha: string; subject: string }[];
	/** App migrations added since the previous record */
	migrations: string[];
	openauth: { from: string | null; to: string | null };
	released: Released[];
	runUrl: string;
}

/** Release notes are public and rendered: no @mentions (they notify people), no markup from titles. */
export const plain = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/@/g, '&#64;')
		.replace(/[\\`*_[\]|]/g, (c) => `\\${c}`)
		.replace(/\s+/g, ' ')
		.trim();

export function recordNotes(r: RecordInput): string {
	const url = `https://github.com/${r.repo}`;
	const out: string[] = [];
	out.push(`Production release of [\`${r.sha.slice(0, 7)}\`](${url}/commit/${r.sha}) ([run](${r.runUrl})).`, '');
	out.push('### Changes', '');
	for (const pr of r.prs) out.push(`- ${plain(pr.title)} ([#${pr.number}](${url}/pull/${pr.number}))`);
	for (const c of r.commits) out.push(`- ${plain(c.subject)} ([\`${c.sha.slice(0, 7)}\`](${url}/commit/${c.sha}))`);
	if (r.prs.length + r.commits.length === 0) out.push('- The same code again.');
	out.push('');
	if (r.openauth.from !== r.openauth.to && r.openauth.to) {
		out.push(`**openauth**: ${r.openauth.from ?? 'none'} → ${r.openauth.to}`, '');
	}
	if (r.migrations.length) out.push('### Database migrations', '', ...r.migrations.map((m) => `- \`${m}\``), '');
	out.push('### Workers', '', '| Worker | Version | Replaced |', '|---|---|---|');
	for (const w of r.released) out.push(`| \`${w.worker}\` | \`${w.candidate}\` | \`${w.previous}\` |`);
	out.push(
		'',
		'### Roll back',
		'',
		`[Run the Rollback workflow](${url}/actions/workflows/rollback.yml): it returns the workers to the versions they replaced. Migrations only add, and stay applied.`,
		''
	);
	if (r.previous) out.push(`**Full changelog**: ${url}/compare/${r.previous}...${r.sha}`, '');
	return out.join('\n');
}

/** The production workers' versions, if and only if the run really promoted them. */
export function promotedWorkers(result: ReleaseResult): Released[] {
	if (result.status !== 'promoted') throw new Error(`nothing to record: the release ended as "${result.status}"`);
	if (!result.released?.length) throw new Error('nothing to record: no workers in the release result');
	return result.released;
}

function main(argv: string[]): void {
	const repo = process.env.GITHUB_REPOSITORY!;
	const sha = process.env.GITHUB_SHA!;
	if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('GITHUB_SHA must be a full commit sha');
	const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
	const tryRun = (cmd: string, args: string[]) => {
		try {
			return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		} catch {
			return null;
		}
	};
	const lines = (text: string | null) => (text ?? '').split('\n').filter(Boolean);

	const released = promotedWorkers(JSON.parse(readFileSync(argv[argv.indexOf('--result') + 1], 'utf8')) as ReleaseResult);

	const tags = lines(run('git', ['tag', '-l', 'v*']));
	// The same commit released again (a manual run): update its record instead of adding one
	const own = recordTags(lines(run('git', ['tag', '--points-at', sha])))[0] ?? null;
	const previous = recordTags(tags).find((t) => t !== own && tryRun('git', ['merge-base', '--is-ancestor', t, sha]) !== null) ?? null;

	const range = previous ? `${previous}..${sha}` : `${sha}~1..${sha}`;
	const prs = new Map<number, string>();
	const commits: RecordInput['commits'] = [];
	for (const line of lines(run('git', ['log', '--no-merges', '--reverse', '--format=%H%x09%s', range]))) {
		const [commit, subject] = line.split('\t');
		const merged = JSON.parse(run('gh', ['api', `repos/${repo}/commits/${commit}/pulls`, '--jq', '[.[] | select(.merged_at != null) | {number, title}]'])) as { number: number; title: string }[];
		if (merged.length === 0) commits.push({ sha: commit, subject });
		for (const pr of merged) prs.set(pr.number, pr.title);
	}

	const openauthAt = (ref: string | null): string | null => {
		const json = ref && tryRun('git', ['show', `${ref}:apps/auth/package.json`]);
		return json ? ((JSON.parse(json) as { dependencies?: Record<string, string> }).dependencies?.['@al-ummah-now/openauth'] ?? null) : null;
	};
	const migrations = previous ? lines(run('git', ['diff', '--name-only', '--diff-filter=A', previous, sha, '--', 'apps/auth/migrations'])).filter((f) => f.endsWith('.sql')) : [];

	const notes = recordNotes({
		repo,
		sha,
		previous,
		prs: [...prs].map(([number, title]) => ({ number, title })),
		commits,
		migrations: migrations.map((f) => f.split('/').pop()!),
		openauth: { from: openauthAt(previous), to: previous ? openauthAt(sha) : null },
		released,
		runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
	});
	const file = join(mkdtempSync(join(tmpdir(), 'record-')), 'notes.md');
	writeFileSync(file, notes);

	if (own) {
		run('gh', ['release', 'edit', own, '-R', repo, '--notes-file', file]);
		process.stdout.write(`Updated the record ${own}\n`);
		return;
	}
	const tag = nextTag(tags, new Date());
	run('gh', ['release', 'create', tag, '-R', repo, '--target', sha, '--title', tag, '--notes-file', file, '--latest']);
	process.stdout.write(`Recorded ${sha.slice(0, 7)} as ${tag}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2));
