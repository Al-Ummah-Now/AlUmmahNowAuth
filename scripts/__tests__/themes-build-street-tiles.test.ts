/**
 * The built-in street tiles (scripts/themes/build.ts): not bundled into the workers, written to the
 * auth Worker's static files instead, and the check catches a stale or extra file there.
 */
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, MAX_TILE_BYTES, STATIC_DIR, staleStatic } from '../themes/build.ts';

describe('built-in street tiles', () => {
	const { files, staticFiles, problems } = build();
	const generated = Object.entries(files).find(([f]) => f.endsWith('builtin.generated.ts'))![1];

	it('are the 8 Fawanees tiles, WebP and within the size limit, matching apps/auth/public', () => {
		expect(problems).toEqual([]);
		const names = Object.keys(staticFiles).map((f) => basename(f)).sort();
		expect(names).toEqual([1, 2, 3, 4].map((n) => `street-tile-${n}.webp`).concat([1, 2, 3, 4].map((n) => `street-tile-dark-${n}.webp`)).sort());
		for (const data of Object.values(staticFiles)) {
			expect(data.subarray(8, 12).toString('latin1')).toBe('WEBP');
			expect(data.length).toBeLessThanOrEqual(MAX_TILE_BYTES);
		}
		expect(readdirSync(STATIC_DIR).sort()).toEqual(names);
		expect(staleStatic(staticFiles)).toEqual([]);
	});

	it('are mapped by hash to their static path and left out of the bundled blobs', () => {
		const statics = JSON.parse(/BUILTIN_STATIC: Record<string, string> = (\{.*\});/.exec(generated)![1]) as Record<string, string>;
		const blobs = /BUILTIN_BLOBS: Record<string, BuiltinBlob> = (\{.*\});/.exec(generated)![1];
		expect(Object.values(statics).sort()).toEqual(Object.keys(staticFiles).map((f) => `/fanous/street/${basename(f)}`).sort());
		for (const hash of Object.keys(statics)) expect(blobs).not.toContain(hash);
	});

	it('the check reports a tile that differs from the theme', () => {
		const [file, data] = Object.entries(staticFiles)[0]!;
		expect(staleStatic({ ...staticFiles, [file]: Buffer.concat([data, Buffer.from([0])]) })).toEqual([file]);
	});
});
