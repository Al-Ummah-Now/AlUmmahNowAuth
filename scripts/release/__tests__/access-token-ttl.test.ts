/**
 * Access tokens live 15 minutes in every deployed environment (#437), so a
 * revoked session or deleted account stops working quickly; clients refresh
 * silently. The release check (apps.ts) pins the production and stage value,
 * and the revocation list must be bound wherever tokens are issued.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APPS } from '../apps.ts';
import { parseAccessTtl } from '../../../apps/auth/src/revocation/token-gate.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const prodStage = JSON.parse(readFileSync(resolve(ROOT, 'apps/auth/wrangler.json'), 'utf8'));
const qa = JSON.parse(readFileSync(resolve(ROOT, 'apps/auth/wrangler.qa.json'), 'utf8'));
const ENVS: Record<string, { vars: Record<string, string>; kv_namespaces?: Array<{ binding: string }> }> = {
	production: prodStage.env.production,
	stage: prodStage.env.stage,
	qa,
};

describe('access-token lifetime', () => {
	it.each(Object.keys(ENVS))('%s issues 15-minute access tokens', (env) => {
		expect(ENVS[env].vars.ACCESS_TOKEN_TTL).toBe('900');
		expect(parseAccessTtl(ENVS[env].vars.ACCESS_TOKEN_TTL)).toBe(900);
	});

	it.each(Object.keys(ENVS))('%s binds the token revocation list', (env) => {
		expect(ENVS[env].kv_namespaces?.map((k) => k.binding)).toContain('TOKEN_REVOCATIONS');
	});

	it('the release check pins the lifetime and the binding for production and stage', () => {
		const auth = APPS.find((a) => a.app === 'auth')!;
		for (const rule of [auth.production, auth.stage]) {
			expect(rule!.vars?.ACCESS_TOKEN_TTL).toBe('900');
			expect(rule!.requiredBindings).toContainEqual({ kind: 'kv_namespaces', name: 'TOKEN_REVOCATIONS' });
		}
	});
});
