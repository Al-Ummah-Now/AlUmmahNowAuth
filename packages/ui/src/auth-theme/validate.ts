/**
 * Validates an Auth theme: the platform format v1 rules (schema, references,
 * asset safety, WCAG AA contrast; ../theme-packages) plus Auth's `x-auth`
 * extension. Contrast problems are reported apart so a draft can be saved
 * while it is being fixed; publishing needs none.
 */
import { checkSchema } from '../theme-packages/json-schema.ts';
import { parseRefs } from '../theme-packages/refs.ts';
import { SCHEMA } from '../theme-packages/schema.generated.ts';
import { MAX_ASSET_BYTES, MAX_PACKAGE_BYTES, contrastIssues, validatePackage, type Issue } from '../theme-packages/validate.ts';
import { AUTH_RADII, SECTIONS, SPEC_SLOTS } from './catalog.ts';
import type { StoredAsset } from './types.ts';

export { MAX_ASSET_BYTES, MAX_PACKAGE_BYTES, type Issue };

const sectionValue = {
	anyOf: [
		{ $ref: '#/$defs/cssValue' },
		{
			type: 'object',
			properties: { light: { $ref: '#/$defs/cssValue' }, dark: { $ref: '#/$defs/cssValue' } },
			additionalProperties: false,
			required: ['light', 'dark'],
		},
	],
};

const photo = {
	anyOf: [{ $ref: '#/$defs/imageAsset' }, { type: 'string', pattern: '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/[A-Za-z0-9._~/%+=&?-]*$', maxLength: 500 }],
};

/** JSON Schema of `x-auth` (its $refs point into the format v1 schema's $defs). */
export const AUTH_EXTENSION_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	title: "Auth's extension of a theme package (x-auth)",
	description: 'Sign-in page details beyond the platform format. Other apps ignore it.',
	type: 'object',
	additionalProperties: false,
	properties: {
		title: { $ref: '#/$defs/localized' },
		radius: { enum: [...AUTH_RADII] },
		fontImports: {
			type: 'array',
			maxItems: 4,
			items: { type: 'string', maxLength: 500, pattern: '^https://fonts\\.googleapis\\.com/css2?\\?[A-Za-z0-9=:;,@&+%._-]+$' },
			description: 'Google Fonts stylesheets.',
		},
		photos: {
			type: 'object',
			properties: { light: { type: 'array', maxItems: 8, items: photo }, dark: { type: 'array', maxItems: 8, items: photo } },
			additionalProperties: false,
			required: ['light'],
			description: 'Photos behind the sign-in card; one is picked per page.',
		},
		sections: {
			type: 'object',
			additionalProperties: false,
			properties: Object.fromEntries(
				SECTIONS.map((s) => [
					s.id,
					{
						type: 'object',
						description: s.label,
						propertyNames: { enum: s.slots.map((slot) => slot.key).filter((k) => s.id !== 'base' || !(k in SPEC_SLOTS)) },
						additionalProperties: sectionValue,
					},
				])
			),
		},
	},
} as const;

const EXT_ROOT = { ...AUTH_EXTENSION_SCHEMA, $defs: (SCHEMA as { $defs: Record<string, unknown> }).$defs };

export interface ThemeValidation {
	/** Problems that make the theme unusable (schema, references, files). */
	errors: Issue[];
	/** WCAG AA problems: a draft may have them, a published theme may not. */
	contrast: Issue[];
	warnings: Issue[];
}

export interface ValidateThemeOptions {
	/** The package's files with their bytes (import, built-ins): checked for size, type and safety. */
	files?: Record<string, Uint8Array>;
	/** Files already stored for the package (by path): referenced paths must be among them. */
	stored?: Record<string, StoredAsset>;
	builtIn?: boolean;
}

function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
	if (typeof value === 'string') out.push([path, value]);
	else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
	else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
	return out;
}

/** Every assets/… path the theme names. */
export function referencedAssets(theme: unknown): Set<string> {
	const used = new Set<string>();
	for (const [path, value] of strings(theme, '')) {
		if (path.startsWith('$')) continue;
		if (/^assets\//.test(value)) used.add(value);
		for (const ref of parseRefs(value)) if (ref.kind === 'asset') used.add(ref.name);
	}
	return used;
}

const key = (i: Issue) => `${i.path}\n${i.message}`;

export function validateTheme(theme: unknown, opts: ValidateThemeOptions = {}): ThemeValidation {
	const result = validatePackage(theme, { assets: opts.files, builtIn: opts.builtIn });
	let contrastKeys = new Set<string>();
	if (!result.errors.some((e) => !/WCAG AA/.test(e.message))) {
		try {
			contrastKeys = new Set(contrastIssues(theme as never, opts.builtIn).map(key));
		} catch {
			// the format's own errors already say why
		}
	}
	const errors = result.errors.filter((e) => !contrastKeys.has(key(e)));
	const contrast = result.errors.filter((e) => contrastKeys.has(key(e)));

	const ext = theme && typeof theme === 'object' ? (theme as Record<string, unknown>)['x-auth'] : undefined;
	if (ext !== undefined) {
		for (const e of checkSchema(ext, EXT_ROOT)) errors.push({ path: e.path === '(root)' ? 'x-auth' : `x-auth.${e.path}`, message: e.message });
	}
	if (!opts.files && opts.stored) {
		for (const path of referencedAssets(theme)) if (!opts.stored[path]) errors.push({ path, message: `names ${path}, which is not in the package` });
	}
	return { errors, contrast, warnings: result.warnings };
}

export function formatIssues(issues: Issue[]): string {
	return issues
		.slice(0, 8)
		.map((i) => `${i.path}: ${i.message}`)
		.join('; ');
}

const ASSET_TYPES: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	ico: 'image/x-icon',
	woff2: 'font/woff2',
};

/** Content type for an allowed asset path, or undefined when the path isn't allowed. */
export function assetTypeFor(path: string): string | undefined {
	if (!/^assets\/(?![\s\S]*\.\.)[A-Za-z0-9_-][A-Za-z0-9._/-]*\.(svg|png|jpg|jpeg|webp|ico|woff2)$/.test(path)) return undefined;
	if (path.endsWith('.woff2') && !path.startsWith('assets/fonts/')) return undefined;
	return ASSET_TYPES[path.split('.').pop()!.toLowerCase()];
}
