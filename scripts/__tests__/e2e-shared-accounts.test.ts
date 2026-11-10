/**
 * Session-ending E2E files never use shared accounts (scripts/ci/e2e-shared-accounts.ts).
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { checkE2eDir, checkSource } from '../ci/e2e-shared-accounts';
import { RUN_USER_EMAIL, runAccountEmail } from '../../e2e/utils/test-data';

const ROOT = resolve(import.meta.dirname, '../..');

describe('E2E session-ending specs use their own accounts', () => {
	it('no file under e2e/ ends sessions of a shared account', () => {
		const findings = checkE2eDir(ROOT);
		expect(findings.map((f) => `${f.file}: ${f.sessionEnding} with ${f.shared} (${f.match})`)).toEqual([]);
	});

	it('flags a spec that signs a seeded QA account out', () => {
		const bad = `
			test('sign out', async ({ page }) => {
				await login(page, 'qa-admin@delivered.resend.dev');
				await logout(page);
			});`;
		const findings = checkSource('bad.spec.ts', bad);
		expect(findings.map((f) => f.shared)).toContain('seeded QA/stage account');
		expect(findings[0].sessionEnding).toBe('sign-out');
	});

	it('flags a fixed user from the environment that revokes or resets', () => {
		expect(checkSource('a.spec.ts', `await login(page, process.env.E2E_ADMIN_EMAIL!); await page.request.post(\`\${url}/revoke\`);`)).toHaveLength(1);
		expect(checkSource('b.spec.ts', `const u = 'moderator@e2e.alummahnow.net'; await requestResetCode(page, u);`)).toHaveLength(1);
		expect(checkSource('c.spec.ts', `const u = 'qa-viewer@e2e.alummahnow.net'; await editUser(page, u, { role: 'admin' });`).length).toBeGreaterThan(0);
	});

	it('allows fresh accounts, example.com addresses and shared accounts in files that end no session', () => {
		expect(checkSource('ok.spec.ts', `const email = generateTestEmail('sso'); await register(page, email); await logout(page);`)).toEqual([]);
		expect(checkSource('ok2.spec.ts', `await submit(page, 'x@example.com'); await logout(page);`)).toEqual([]);
		expect(checkSource('read-only.spec.ts', `await login(page, 'qa-viewer@delivered.resend.dev'); await expect(page).toHaveTitle('x');`)).toEqual([]);
		// Comments never count
		expect(checkSource('doc.spec.ts', `// never qa-admin@delivered.resend.dev\n/* logout */ const a = 1;`)).toEqual([]);
	});
});

describe('per-run account addresses', () => {
	it('match the auth server marker regex, whatever the prefix', () => {
		const authSource = readFileSync(resolve(ROOT, 'apps/auth/src/utils/e2e-sink.ts'), 'utf8');
		expect(authSource).toContain(`export const RUN_USER_EMAIL = ${RUN_USER_EMAIL.toString()};`);
		for (const prefix of ['sso', 'sso-journey-ar', 'Moderation Subject!', '', 'x'.repeat(200)]) {
			expect(runAccountEmail(prefix, '19283746501', '3')).toMatch(RUN_USER_EMAIL);
		}
		expect(runAccountEmail('sso', '42', '1')).toMatch(/^e2e\+42-1-sso-/);
	});
});
