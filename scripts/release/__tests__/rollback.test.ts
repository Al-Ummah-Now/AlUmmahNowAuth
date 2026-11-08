import { describe, it, expect } from 'vitest';
import { parseRollbackArgs, rollbackCommands, rollbackTarget } from '../rollback.ts';

describe('rollback', () => {
	it('rolls back every production worker to its previous version by default', () => {
		const cmds = rollbackCommands('/repo', parseRollbackArgs(['--env', 'production']));
		expect(cmds.map((c) => c.worker)).toEqual(['al-ummah-now-auth', 'al-ummah-now-profile', 'al-ummah-now-auth-admin']);
		expect(cmds[0].listArgv).toEqual(['deployments', 'list', '--json', '-c', 'wrangler.json', '--env', 'production']);
		expect(cmds[0].argv('v1')).toEqual(['rollback', 'v1', '-c', 'wrangler.json', '--env', 'production', '-y', '--message', 'manual rollback']);
	});

	it('targets one worker and version', () => {
		const cmds = rollbackCommands('/repo', parseRollbackArgs(['--env', 'production', '--app', 'auth', '--to', 'abc', '--reason', 'drill']));
		expect(cmds).toHaveLength(1);
		expect(cmds[0].argv('abc').slice(0, 2)).toEqual(['rollback', 'abc']);
		expect(cmds[0].argv('abc')).toContain('drill');
	});

	it('rejects ambiguous or unknown input', () => {
		expect(() => parseRollbackArgs([])).toThrow(/--env/);
		expect(() => parseRollbackArgs(['--env', 'production', '--to', 'abc'])).toThrow(/single --app/);
		expect(() => parseRollbackArgs(['--env', 'production', '--app', 'web'])).toThrow(/unknown/);
	});

	it('parses --dry-run', () => {
		expect(parseRollbackArgs(['--env', 'production']).dryRun).toBe(false);
		expect(parseRollbackArgs(['--env', 'production', '--dry-run']).dryRun).toBe(true);
	});

	const dep = (created_on: string, ...versions: [string, number][]) => ({ created_on, versions: versions.map(([version_id, percentage]) => ({ version_id, percentage })) });

	it('targets the main version of the latest earlier deployment that served something else', () => {
		// stage history from the promote rehearsal and the rollback drill, out of order
		const list = JSON.stringify([
			dep('2026-11-08T03:42:10Z', ['new', 100]),
			dep('2026-11-08T03:30:00Z', ['old', 100]),
			dep('2026-11-08T03:42:01Z', ['new', 0], ['old', 100]),
			dep('2026-11-08T03:50:00Z', ['new', 100]),
		]);
		expect(rollbackTarget(list, 'w')).toEqual({ current: 'new', target: 'old' });
	});

	it('uses --to as given, and refuses to guess mid-promote or with no history', () => {
		const split = JSON.stringify([dep('2026-01-01T00:00:00Z', ['a', 100]), dep('2026-01-02T00:00:00Z', ['b', 0], ['a', 100])]);
		expect(() => rollbackTarget(split, 'w')).toThrow(/mid-promote/);
		expect(rollbackTarget(split, 'w', 'a')).toEqual({ current: 'a', target: 'a' });
		expect(() => rollbackTarget(JSON.stringify([dep('2026-01-01T00:00:00Z', ['a', 100])]), 'w')).toThrow(/no earlier version/);
	});
});
