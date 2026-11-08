import { describe, it, expect } from 'vitest';
import { currentVersion, parseVersionId, promote, releaseApps, ReleaseError, type PromoteDeps } from '../promote.ts';
import type { CheckResult } from '../smoke.ts';

const PREV = { auth: 'aaaaaaaa-0000-4000-8000-000000000001', profile: 'aaaaaaaa-0000-4000-8000-000000000002', admin: 'aaaaaaaa-0000-4000-8000-000000000003' };
const NEXT = { auth: 'bbbbbbbb-0000-4000-8000-000000000001', profile: 'bbbbbbbb-0000-4000-8000-000000000002', admin: 'bbbbbbbb-0000-4000-8000-000000000003' };
const ok: CheckResult[] = [{ name: 'x', ok: true, detail: '' }];
const bad: CheckResult[] = [{ name: 'auth: issuer metadata', ok: false, detail: 'HTTP 500' }];

function fakeDeps(smokeResults: CheckResult[][], opts: { failRollbackFor?: string } = {}) {
	const calls: string[] = [];
	const appOf = (cwd: string) => cwd.split('/').pop() as keyof typeof PREV;
	const deps: PromoteDeps = {
		run: (cwd, args) => {
			const app = appOf(cwd);
			// record "<app> <command> <positionals>", without flags, their values, or paths
			const words = args.filter((a, i) => !a.startsWith('-') && !args[i - 1]?.startsWith('-') && !a.includes('/'));
			calls.push(`${app} ${words.join(' ')}`.trim());
			if (args[0] === 'deployments') return JSON.stringify({ versions: [{ version_id: PREV[app], percentage: 100 }] });
			if (args[0] === 'versions' && args[1] === 'upload') return `Total Upload: 1 KiB\nWorker Version ID: ${NEXT[app]}\n`;
			if (args[0] === 'rollback' && opts.failRollbackFor === app) throw new Error('api down');
			return '';
		},
		smoke: async () => smokeResults.shift() ?? ok,
		waitForVersion: async () => {},
		log: () => {},
	};
	return { deps, calls };
}

const apps = () => releaseApps('/repo', 'production');

describe('parseVersionId / currentVersion', () => {
	it('reads the version id from wrangler output', () => {
		expect(parseVersionId('...\nWorker Version ID: 2c7a1425-17ec-41dc-92f2-d5266950be3a\n')).toBe('2c7a1425-17ec-41dc-92f2-d5266950be3a');
		expect(() => parseVersionId('Upload failed')).toThrow(/version id/);
	});

	it('refuses to release over a split deployment', () => {
		const split = JSON.stringify({ versions: [{ version_id: 'a', percentage: 90 }, { version_id: 'b', percentage: 10 }] });
		expect(() => currentVersion(split, 'w')).toThrow(/split deployment/);
		expect(currentVersion(JSON.stringify({ versions: [{ version_id: 'a', percentage: 100 }] }), 'w')).toBe('a');
	});
});

describe('releaseApps', () => {
	it('never deploys production with the local-dev top level of auth', () => {
		const auth = apps().find((a) => a.app === 'auth')!;
		expect(auth.configArgs).toEqual(['-c', 'wrangler.json', '--env', 'production']);
		expect(releaseApps('/repo', 'stage').map((a) => a.worker)).toEqual(['al-ummah-now-auth-stage', 'al-ummah-now-profile-stage', 'al-ummah-now-auth-admin-stage']);
	});
});

describe('promote', () => {
	it('uploads, smoke-tests at 0%, then moves 100% and deploys triggers', async () => {
		const { deps, calls } = fakeDeps([ok, ok]);
		const released = await promote(apps(), 'production', 'release abc', deps);
		expect(released.map((r) => [r.previous, r.candidate])).toEqual([
			[PREV.auth, NEXT.auth],
			[PREV.profile, NEXT.profile],
			[PREV.admin, NEXT.admin],
		]);
		expect(calls).toContain(`auth versions deploy ${NEXT.auth}@0% ${PREV.auth}@100%`);
		expect(calls).toContain(`auth versions deploy ${NEXT.auth}@100%`);
		expect(calls).toContain('auth triggers deploy');
		expect(calls.some((c) => c.includes('rollback'))).toBe(false);
		// 100% only after every 0% step
		expect(calls.findIndex((c) => c.endsWith('@100%') && !c.includes('@0%'))).toBeGreaterThan(calls.findLastIndex((c) => c.includes('@0%')));
	});

	it('never gives the candidate traffic when the pre-traffic smoke fails', async () => {
		const { deps, calls } = fakeDeps([bad]);
		await expect(promote(apps(), 'production', 'release abc', deps)).rejects.toMatchObject({ rolledBack: true, message: expect.stringMatching(/pre-traffic/) });
		expect(calls.some((c) => c.endsWith(`${NEXT.auth}@100%`))).toBe(false);
		expect(calls).toContain(`auth rollback ${PREV.auth}`);
	});

	it('rolls every worker back when the post-promote smoke fails', async () => {
		const { deps, calls } = fakeDeps([ok, bad]);
		await expect(promote(apps(), 'production', 'release abc', deps)).rejects.toBeInstanceOf(ReleaseError);
		for (const app of ['auth', 'profile', 'admin'] as const) expect(calls).toContain(`${app} rollback ${PREV[app]}`);
	});

	it('still rolls back the others, and says so loudly, when one rollback fails', async () => {
		const { deps, calls } = fakeDeps([ok, bad], { failRollbackFor: 'profile' });
		await expect(promote(apps(), 'production', 'release abc', deps)).rejects.toMatchObject({ rolledBack: false, message: expect.stringMatching(/ROLLBACK FAILED/) });
		expect(calls).toContain(`admin rollback ${PREV.admin}`);
	});
});
