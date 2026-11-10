/**
 * Never a browser prompt (owner rule): no alert/confirm/prompt dialogs and no
 * beforeunload, anywhere in the apps. ESLint guards the code it parses; this
 * also covers the HTML and inline scripts the workers render inside template
 * strings (auth and profile pages), which ESLint sees only as text.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SOURCES = ['apps/auth/src', 'apps/profile/src', 'apps/admin/app', 'apps/audit-consumer/src', 'packages/ui/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.react-router', '.wrangler', '__tests__', '__mocks__']);
const IS_TEST = /\.(test|spec)\.tsx?$/;

/** A call of alert/confirm/prompt (bare or on window), or beforeunload anywhere. */
const BROWSER_PROMPT = /(?<![\w$.])(?:window\s*\.\s*)?(?:alert|confirm|prompt)\(|window\s*\.\s*(?:alert|confirm|prompt)\b|beforeunload/g;

function sourceFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
		return /\.(ts|tsx|js|mjs|html)$/.test(name) && !IS_TEST.test(name) ? [path] : [];
	});
}

describe('no browser prompts', () => {
	it('the pattern catches the forms they take in rendered HTML and code', () => {
		const hits = (s: string) => (s.match(BROWSER_PROMPT) ?? []).length;
		expect(hits(`onclick="return confirm('Sign out?');"`)).toBe(1);
		expect(hits(`alert('Failed: ' + e)`)).toBe(1);
		expect(hits('window.confirm(message)')).toBe(1);
		expect(hits('if (!window.prompt) {}')).toBe(1);
		// eslint-disable-next-line no-restricted-syntax -- the guard's own sample of what it forbids
		expect(hits(`addEventListener('beforeunload', f)`)).toBe(1);
		expect(hits('function loginUrl(prompt) { return prompt ? 1 : 0; }')).toBe(0);
		expect(hits('openConfirm(x); showAlert(y); dlg.close("confirm")')).toBe(0);
	});

	it('no app source uses alert, confirm, prompt or beforeunload', () => {
		const files = SOURCES.flatMap((dir) => sourceFiles(resolve(ROOT, dir)));
		expect(files.length).toBeGreaterThan(50);
		const found = files.flatMap((file) => {
			const lines = readFileSync(file, 'utf8').split('\n');
			return lines.flatMap((line, i) =>
				new RegExp(BROWSER_PROMPT.source).test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : [],
			);
		});
		expect(found).toEqual([]);
	});
});
