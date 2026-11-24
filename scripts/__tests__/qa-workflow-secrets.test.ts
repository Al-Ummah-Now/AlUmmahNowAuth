/** QA's test-route secrets come from GitHub secrets, never from the workflow text (this repo is public). */
import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '../../.github/workflows');

it.each(readdirSync(dir))('%s takes every test-route secret from GitHub secrets', (file) => {
	const text = readFileSync(join(dir, file), 'utf8');
	const literal = [...text.matchAll(/^\s+(TEST_PROMOTE_SECRET|E2E_CODE_SINK_SECRET): *(.+)$/gm)].filter((m) => !/^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/.test(m[2].trim()));
	expect(literal.map((m) => m[0].trim())).toEqual([]);
	// `wrangler secret put` reads a variable, not a literal
	expect(text).not.toMatch(/(echo|printf) +["'](?!%s)[^"'$]+["'] *\| *(npx|pnpm exec) wrangler secret put/);
});
