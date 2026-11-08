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
});
