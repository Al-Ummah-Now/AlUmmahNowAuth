/**
 * Finishes a rendered Auth page for its theme: names the theme and the page on
 * <html> (sections are scoped by data-auth-page), puts the header graphic on
 * the card, gives the account switcher its rules, and makes every link inside
 * the sign-in flow keep the theme the flow started with.
 */
import type { CompiledTheme, Scheme } from './types.ts';

export type AuthPage = 'sign-in' | 'register' | 'code' | 'reset' | 'consent' | 'account-switcher' | 'other';

export const THEME_PARAM = 'theme';

export function pageKind(pathname: string, html: string): AuthPage {
	if (/class="accounts-list"|class="accounts"/.test(html) || pathname === '/select-account') return 'account-switcher';
	const hasCode = /name="code"/.test(html);
	if (pathname.endsWith('/password/authorize')) return 'sign-in';
	if (pathname.endsWith('/password/register')) return hasCode ? 'code' : 'register';
	if (pathname.endsWith('/password/change')) return hasCode ? 'code' : 'reset';
	if (pathname === '/activate') return 'consent';
	return 'other';
}

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface DecorateOptions {
	page: AuthPage;
	/** Added to every in-flow link that lacks one. */
	carryTheme?: string;
	/** Admin preview: render as this scheme whatever the viewer's device uses. */
	forceScheme?: Scheme;
}

export function decorateHtml(html: string, compiled: CompiledTheme, opts: DecorateOptions): string {
	let out = html.replace(/<html\b([^>]*)>/i, (_, attrs: string) => {
		const cleaned = attrs.replace(/\s(?:data-theme|data-auth-page)="[^"]*"/g, '');
		return `<html${cleaned} data-theme="${attr(compiled.id)}" data-auth-page="${opts.page}">`;
	});

	if (compiled.graphic && opts.page !== 'account-switcher') {
		const { light, dark } = compiled.graphic;
		const wrap = (svg: string, scheme?: Scheme) =>
			`<div class="demo-gfx"${scheme ? ` data-scheme="${scheme}"` : ''} aria-hidden="true">${svg}</div>`;
		const graphic = light === dark ? wrap(light) : wrap(light, 'light') + wrap(dark, 'dark');
		out = out.replace(/(<div\b[^>]*data-component="center"[^>]*>)/, `$1${graphic}`);
	}

	if (opts.page === 'account-switcher') out = out.replace(/<\/head>/i, `<style data-auth-theme>${compiled.pickerCss}</style></head>`);

	if (opts.carryTheme) {
		const id = encodeURIComponent(opts.carryTheme);
		out = out.replace(/(\shref=")([^"]*auth_flow=[^"]*)"/g, (m, pre: string, href: string) =>
			/[?&](?:amp;)?theme=/.test(href) ? m : `${pre}${href}&amp;${THEME_PARAM}=${id}"`
		);
	}

	if (opts.forceScheme) out = forceScheme(out, opts.forceScheme);
	return out;
}

/** Media queries on the colour scheme answer as `scheme` (preview frames can't set the device's). */
export function forceScheme(html: string, scheme: Scheme): string {
	const yes = '(min-width: 0px)';
	const no = '(max-width: 0px)';
	return html
		.replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/g, scheme === 'dark' ? yes : no)
		.replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/g, scheme === 'light' ? yes : no);
}

/** Same-origin redirect inside the flow: keep the theme on it. */
export function carryThemeOnLocation(location: string, issuerOrigin: string, theme: string): string {
	let url: URL;
	try {
		url = new URL(location, issuerOrigin);
	} catch {
		return location;
	}
	if (url.origin !== new URL(issuerOrigin).origin || url.searchParams.has(THEME_PARAM)) return location;
	url.searchParams.set(THEME_PARAM, theme);
	return /^https?:/i.test(location) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}
