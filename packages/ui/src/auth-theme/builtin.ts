/** The built-in theme packages, bundled into every app that renders Auth pages. */
import { BUILTIN_BLOBS, BUILTIN_PACKAGES } from './builtin.generated.ts';
import { compileTheme } from './compile.ts';
import type { AuthThemeJson, CompiledTheme, StoredAsset, StoredPackage } from './types.ts';

export interface BuiltinBlob {
	type: string;
	text?: string;
	base64?: string;
}
export interface BuiltinPackage {
	theme: AuthThemeJson;
	assets: Record<string, StoredAsset>;
}

export const BUILTIN_IDS = Object.keys(BUILTIN_PACKAGES);

export function builtinPackage(id: string): StoredPackage | undefined {
	return Object.prototype.hasOwnProperty.call(BUILTIN_PACKAGES, id) ? (BUILTIN_PACKAGES[id] as StoredPackage) : undefined;
}

/** A built-in file by content hash (served at /themes/assets/<hash>). */
export function builtinBlob(hash: string): BuiltinBlob | undefined {
	return Object.prototype.hasOwnProperty.call(BUILTIN_BLOBS, hash) ? BUILTIN_BLOBS[hash] : undefined;
}

export function blobBytes(b: BuiltinBlob): Uint8Array {
	if (b.text !== undefined) return new TextEncoder().encode(b.text);
	const bin = atob(b.base64 ?? '');
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Text of a package's SVG files that are built in, by path. */
export function builtinSvgTexts(pkg: StoredPackage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, a] of Object.entries(pkg.assets)) {
		const b = builtinBlob(a.hash);
		if (b?.text !== undefined && a.type === 'image/svg+xml') out[path] = b.text;
	}
	return out;
}

const cache = new Map<string, CompiledTheme>();

/** A built-in theme compiled (cached per isolate); asset URLs are relative to `assetBase`. */
export function compileBuiltin(id: string, assetBase: string): CompiledTheme | undefined {
	const pkg = builtinPackage(id);
	if (!pkg) return undefined;
	const key = `${id}@${assetBase}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const compiled = compileTheme(pkg, { assetUrl: (_p, hash) => `${assetBase}/themes/assets/${hash}`, svgText: builtinSvgTexts(pkg) });
	cache.set(key, compiled);
	return compiled;
}
