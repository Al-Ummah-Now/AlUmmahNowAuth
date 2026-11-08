import { describe, it, expect } from 'vitest';
import { parseRollbackArgs, rollbackCommands } from '../rollback.ts';

describe('rollback', () => {
	it('rolls back every production worker to its previous version by default', () => {
		const cmds = rollbackCommands('/repo', parseRollbackArgs(['--env', 'production']));
		expect(cmds.map((c) => c.worker)).toEqual(['al-ummah-now-auth', 'al-ummah-now-profile', 'al-ummah-now-auth-admin']);
		expect(cmds[0].argv).toEqual(['rollback', '-c', 'wrangler.json', '--env', 'production', '-y', '--message', 'manual rollback']);
	});

	it('targets one worker and version', () => {
		const cmds = rollbackCommands('/repo', parseRollbackArgs(['--env', 'production', '--app', 'auth', '--to', 'abc', '--reason', 'drill']));
		expect(cmds).toHaveLength(1);
		expect(cmds[0].argv.slice(0, 2)).toEqual(['rollback', 'abc']);
		expect(cmds[0].argv).toContain('drill');
	});

	it('rejects ambiguous or unknown input', () => {
		expect(() => parseRollbackArgs([])).toThrow(/--env/);
		expect(() => parseRollbackArgs(['--env', 'production', '--to', 'abc'])).toThrow(/single --app/);
		expect(() => parseRollbackArgs(['--env', 'production', '--app', 'web'])).toThrow(/unknown/);
	});
});
