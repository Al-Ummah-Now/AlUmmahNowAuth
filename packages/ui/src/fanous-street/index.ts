/**
 * The Fanous lantern street on Auth's pages (sign-in, profile, accounts admin).
 *
 * The shared module (fanous-street.js + .css, vendored at a pinned commit by
 * scripts/themes/sync-fanous-street.ts) is served by each app from its own origin under
 * /fanous-street/, with a content hash in the file name, so the pages' CSP needs nothing new.
 * The start script is the module followed by `startStreet()`: it draws only when the active
 * theme's tokens set --fanous-street-on to 1 (Fawanees), so other themes show no street.
 * Design record: AlUmmahNow docs/design/FAWANEES-STREET.md.
 */
import { STREET_CSS, STREET_HASH, STREET_JS } from './street.generated.ts';

export const STREET_BASE = '/fanous-street';
export const STREET_CSS_PATH = `${STREET_BASE}/street.${STREET_HASH}.css`;
export const STREET_JS_PATH = `${STREET_BASE}/start.${STREET_HASH}.js`;

/** The module, then the call that starts it (the file is loaded as a module script). */
export const STREET_START_JS = `${STREET_JS}\nstartStreet();\n`;

/** Whether a theme's token CSS switches the street on (in either colour scheme). */
export function streetOn(tokensCss: string): boolean {
	return /--fanous-street-on:\s*1\s*[;}]/.test(tokensCss);
}

/** The tags that load the street, for the end of <head> (after the theme's CSS). */
export function streetHeadTags(): string {
	return `<link rel="stylesheet" href="${STREET_CSS_PATH}" data-fanous-street><script type="module" src="${STREET_JS_PATH}" data-fanous-street></script>`;
}

/** A street file for a request path (undefined when the path is not one of them). */
export function streetAsset(pathname: string): { body: string; type: string } | undefined {
	if (pathname === STREET_CSS_PATH) return { body: STREET_CSS, type: 'text/css; charset=utf-8' };
	if (pathname === STREET_JS_PATH) return { body: STREET_START_JS, type: 'text/javascript; charset=utf-8' };
	return undefined;
}

/** The response for a street file (immutable: the hash changes with the content). */
export function streetResponse(pathname: string): Response | undefined {
	const asset = streetAsset(pathname);
	if (!asset) return undefined;
	return new Response(asset.body, {
		headers: {
			'Content-Type': asset.type,
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
		},
	});
}
