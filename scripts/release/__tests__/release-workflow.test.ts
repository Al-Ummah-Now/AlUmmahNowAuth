import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(join(__dirname, '../../../.github/workflows/release.yml'), 'utf8');

/** Each step of the workflow as raw text, split on step boundaries. */
const steps = workflow.split(/\n(?=      - )/);

describe('release.yml', () => {
	it('runs stage E2E against the deployed workers, never local dev servers', () => {
		const e2e = steps.filter((s) => s.includes('playwright test'));
		expect(e2e.length).toBeGreaterThan(0);
		for (const step of e2e) {
			expect(step).toMatch(/SKIP_WEB_SERVER: true/);
			expect(step).toMatch(/E2E_AUTH_SERVER_URL: https:\/\/auth\.stage\.alummahnow\.net/);
		}
	});

	it('builds the audit consumer once and deploys that bundle to both envs', () => {
		expect(workflow).toContain('--outdir ../../dist/audit-consumer');
		expect(workflow).toContain('wrangler deploy ../../dist/audit-consumer/index.js --no-bundle --env stage');
		expect(workflow).toMatch(/wrangler deploy \.\.\/\.\.\/dist\/audit-consumer\/index\.js --no-bundle\n/);
	});

	it('deploys the production consumer after the migration and before the promote', () => {
		const at = (name: string) => workflow.indexOf(`- name: ${name}`);
		expect(at('Migrate production database')).toBeGreaterThan(-1);
		expect(at('Deploy audit consumer to production')).toBeGreaterThan(at('Migrate production database'));
		expect(at('Promote (0%')).toBeGreaterThan(at('Deploy audit consumer to production'));
		expect(at('Audit pipeline check (production)')).toBeGreaterThan(at('Promote (0%'));
	});

	it('gates production on the stage audit pipeline check, before E2E', () => {
		const at = (name: string) => workflow.indexOf(`- name: ${name}`);
		expect(at('Audit pipeline check (stage)')).toBeGreaterThan(at('Deploy audit consumer to stage'));
		expect(at('Install Playwright')).toBeGreaterThan(at('Audit pipeline check (stage)'));
	});

	it('skips the production consumer steps on a superseded release', () => {
		for (const name of ['Deploy audit consumer to production', 'Audit pipeline check (production)']) {
			const step = steps.find((s) => s.includes(`- name: ${name}`));
			expect(step).toContain("if: steps.head.outputs.current == 'true'");
		}
	});
});
