/**
 * The vendored Fanous lantern street (scripts/themes/sync-fanous-street.ts): the files on disk
 * are exactly what the sync wrote at the locked commit, and the check catches a hand edit.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOutputs, checkFiles, DIR, LOCK, OUT, SOURCES, TS_OUT, type Lock, sha256, vendorFile } from '../themes/sync-fanous-street.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, LOCK), 'utf8')) as Lock;
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });

describe('vendored Fanous street', () => {
	it('is pinned to a commit of the monorepo, with a hash for every file', () => {
		expect(lock.repo).toBe('Al-Ummah-Now/AlUmmahNow');
		expect(lock.ref).toMatch(/^[0-9a-f]{40}$/);
		expect(Object.keys(lock.sources).sort()).toEqual(Object.values(SOURCES).sort());
		expect(Object.keys(lock.outputs).sort()).toEqual([...Object.values(OUT), TS_OUT].sort());
	});

	it('matches the lock on disk', () => {
		expect(checkFiles(root)).toEqual([]);
	});

	it('the files are the sources as they were at the ref (hash of each source under its header)', () => {
		for (const kind of ['js', 'dts', 'css'] as const) {
			const text = readFileSync(join(root, OUT[kind]), 'utf8');
			const source = text.slice(text.indexOf('\n') + 1);
			expect(sha256(source), kind).toBe(lock.sources[SOURCES[kind]]);
			expect(vendorFile(source, kind, lock.ref)).toBe(text);
		}
	});

	it('rebuilding from the same sources gives the same files (the generated TS included)', () => {
		const src = (kind: 'js' | 'dts' | 'css') => { const t = readFileSync(join(root, OUT[kind]), 'utf8'); return t.slice(t.indexOf('\n') + 1); };
		const outputs = buildOutputs({ js: src('js'), dts: src('dts'), css: src('css') }, lock.ref);
		for (const [path, text] of Object.entries(outputs)) expect(sha256(text), path).toBe(lock.outputs[path]);
	});

	it('the check catches a hand edit', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'street-'));
		temps.push(tmp);
		for (const path of [LOCK, ...Object.values(OUT), TS_OUT]) {
			mkdirSync(dirname(join(tmp, path)), { recursive: true });
			writeFileSync(join(tmp, path), readFileSync(join(root, path)));
		}
		expect(checkFiles(tmp)).toEqual([]);
		writeFileSync(join(tmp, OUT.css), `${readFileSync(join(tmp, OUT.css), 'utf8')}\nbody{}`);
		expect(checkFiles(tmp)).toEqual([`${DIR}/fanous-street.css differs from ${LOCK} (run the sync, never edit it)`]);
	});
});
