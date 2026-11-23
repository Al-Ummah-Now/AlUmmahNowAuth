/**
 * The files a contributor reads first (AUTH-R6, R6-7): they exist, their relative links resolve,
 * and they never send anyone to the old repository, a workers.dev host or a public security issue.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TEMPLATES = '.github/ISSUE_TEMPLATE';
const FILES = [
	'CODE_OF_CONDUCT.md',
	'CONTRIBUTING.md',
	'SUPPORT.md',
	'SECURITY.md',
	'ROADMAP.md',
	'CICD.md',
	'docs/release-pipeline.md',
	'.github/PULL_REQUEST_TEMPLATE.md',
	...readdirSync(join(ROOT, TEMPLATES)).map((f) => `${TEMPLATES}/${f}`),
];

describe.each(FILES)('%s', (file) => {
	const text = readFileSync(join(ROOT, file), 'utf8');

	it('has no link to the old repository, a workers.dev host or an unread mailbox', () => {
		expect(text).not.toMatch(/meywd\/|workers\.dev|mailto:|ORIGINAL_OWNER/);
	});

	it('has relative links that resolve', () => {
		const links = [...text.matchAll(/\]\((?!https?:|#)([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
		expect(links.filter((l) => !existsSync(join(ROOT, dirname(file), l)))).toEqual([]);
	});
});

it('offers no public template for a security problem, only the private report', () => {
	expect(readdirSync(join(ROOT, TEMPLATES)).filter((f) => /security|vulnerab/i.test(f))).toEqual([]);
	expect(readFileSync(join(ROOT, TEMPLATES, 'config.yml'), 'utf8')).toContain('/security/advisories/new');
});

it('names only commands and workflows that exist', () => {
	const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
	const builtin = ['install', 'dev', 'exec', 'audit'];
	for (const file of ['CONTRIBUTING.md', 'CICD.md', 'docs/release-pipeline.md']) {
		const text = readFileSync(join(ROOT, file), 'utf8');
		const commands = [...text.matchAll(/pnpm (?:run )?([a-z][a-z0-9:-]*)/g)].map((m) => m[1]);
		expect({ file, missing: commands.filter((c) => !builtin.includes(c) && !scripts[c]) }).toEqual({ file, missing: [] });
		const workflows = [...text.matchAll(/`([a-z0-9-]+\.yml)`/g)].map((m) => m[1]);
		expect({ file, missing: workflows.filter((w) => !existsSync(join(ROOT, '.github/workflows', w))) }).toEqual({ file, missing: [] });
	}
});
