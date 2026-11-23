import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { easternDay, nextTag, plain, promotedWorkers, recordNotes, recordTags, type RecordInput } from '../record.ts';

const released = [{ app: 'auth', worker: 'al-ummah-now-auth', previous: 'old-version', candidate: 'new-version' }];
const input: RecordInput = {
	repo: 'o/r',
	sha: 'a'.repeat(40),
	previous: 'v2026.11.20',
	prs: [{ number: 7, title: 'fix: a' }],
	commits: [],
	migrations: ['0050_x.sql'],
	openauth: { from: '1.0.59', to: '1.1.0' },
	released,
	runUrl: 'https://github.com/o/r/actions/runs/1',
};

describe('tag', () => {
	it('is the US Eastern day, not UTC', () => {
		expect(easternDay(new Date('2026-11-24T03:30:00Z'))).toBe('2026.11.23');
		expect(easternDay(new Date('2026-07-01T03:59:00Z'))).toBe('2026.06.30'); // daylight time
		expect(easternDay(new Date('2026-07-01T04:00:00Z'))).toBe('2026.07.01');
	});

	it('numbers the later releases of a day from 2, and ignores other tags and days', () => {
		const now = new Date('2026-11-23T15:00:00Z');
		expect(nextTag([], now)).toBe('v2026.11.23');
		expect(nextTag(['local-stack-abc', 'v2026.11.22.4', 'v1.2.3'], now)).toBe('v2026.11.23');
		expect(nextTag(['v2026.11.23'], now)).toBe('v2026.11.23.2');
		expect(nextTag(['v2026.11.23', 'v2026.11.23.2', 'v2026.11.23.10', 'v2026.11.23.9'], now)).toBe('v2026.11.23.11');
	});

	it('sorts newest first by number, not text', () => {
		expect(recordTags(['v2026.11.9.2', 'v2026.11.09', 'v2026.11.23.2', 'v2026.11.23.10', 'v2026.11.23', 'v2026.11.23.1'])).toEqual([
			'v2026.11.23.10',
			'v2026.11.23.2',
			'v2026.11.23',
			'v2026.11.09',
		]);
	});
});

describe('notes', () => {
	it('list the changes, the openauth bump, migrations, worker versions and the rollback', () => {
		const notes = recordNotes(input);
		expect(notes).toContain('- fix: a ([#7](https://github.com/o/r/pull/7))');
		expect(notes).toContain('1.0.59 → 1.1.0');
		expect(notes).toContain('- `0050_x.sql`');
		expect(notes).toContain('| `al-ummah-now-auth` | `new-version` | `old-version` |');
		expect(notes).toContain('actions/workflows/rollback.yml');
		expect(notes).toContain('compare/v2026.11.20...');
	});

	it('leave out what did not change', () => {
		const notes = recordNotes({ ...input, prs: [], migrations: [], openauth: { from: '1.0.59', to: '1.0.59' } });
		expect(notes).toContain('The same code again.');
		expect(notes).not.toContain('openauth');
		expect(notes).not.toContain('Database migrations');
	});

	it('never mention people or carry markup from a title', () => {
		expect(plain('fix: @someone <img src=x> `code` [a](b)')).toBe('fix: &#64;someone &lt;img src=x> \\`code\\` \\[a\\](b)');
	});
});

describe('only a promoted release is recorded', () => {
	it('refuses a rolled-back or empty result', () => {
		expect(promotedWorkers({ status: 'promoted', released })).toEqual(released);
		expect(() => promotedWorkers({ status: 'rolled-back', released })).toThrow('rolled-back');
		expect(() => promotedWorkers({ status: 'promoted', released: [] })).toThrow('no workers');
	});
});

describe('the command, on a scratch repository with a fake gh', () => {
	let dir: string;
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	const commit = (file: string, content: string, message: string) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), content);
		git('add', '-A');
		git('commit', '-qm', message);
		return git('rev-parse', 'HEAD');
	};
	const record = (sha: string) => {
		writeFileSync(join(dir, '.git/gh.log'), '');
		writeFileSync(join(dir, '.git/result.json'), JSON.stringify({ env: 'production', status: 'promoted', released }));
		execFileSync('node', ['--experimental-strip-types', '--no-warnings', join(__dirname, '../record.ts'), '--result', '.git/result.json'], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${join(dir, '.git/bin')}:${process.env.PATH}`, GH_LOG: join(dir, '.git/gh.log'), GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: sha, GITHUB_RUN_ID: '1' },
		});
		return readFileSync(join(dir, '.git/gh.log'), 'utf8');
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'record-test-'));
		git('init', '-q', '-b', 'main');
		mkdirSync(join(dir, '.git/bin'));
		// Every commit belongs to merged PR #12, except the ones gh is told nothing about
		writeFileSync(
			join(dir, '.git/bin/gh'),
			`#!/bin/bash\nif [ "$1" = api ]; then echo '[{"number":12,"title":"feat: twelve"}]'; exit; fi\necho "$@" >> "$GH_LOG"\nwhile [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cat "$2" >> "$GH_LOG"; shift; done\n`
		);
		chmodSync(join(dir, '.git/bin/gh'), 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('creates the first record, then one from the previous, then updates the same commit', () => {
		commit('apps/auth/package.json', '{"dependencies":{"@al-ummah-now/openauth":"1.0.59"}}', 'start');
		const first = commit('a.txt', '1', 'feat: one');
		const created = record(first);
		expect(created).toMatch(/^release create v\d{4}\.\d{2}\.\d{2} -R o\/r --target [0-9a-f]{40}/);
		expect(created).toContain('--latest');
		expect(created).not.toContain('Full changelog');

		git('tag', 'v2026.01.01', first);
		git('tag', 'local-stack-abc', first);
		commit('apps/auth/migrations/0050_x.sql', 'select 1;', 'feat: migration');
		const second = commit('apps/auth/package.json', '{"dependencies":{"@al-ummah-now/openauth":"1.1.0"}}', 'feat: bump');
		const next = record(second);
		expect(next).toContain('compare/v2026.01.01...');
		expect(next).toContain('- `0050_x.sql`');
		expect(next).toContain('1.0.59 → 1.1.0');
		// Two commits of one PR are one line
		expect(next.match(/#12\]/g)).toHaveLength(1);

		git('tag', 'v2026.01.02', second);
		const again = record(second);
		expect(again).toContain('release edit v2026.01.02');
		expect(again).not.toContain('release create');
		expect(again).toContain('compare/v2026.01.01...');
	}, 30_000);
});
