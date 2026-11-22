/**
 * Finishes a rendered Auth page for its theme: names the theme and the page on
 * <html> (sections are scoped by data-auth-page), puts the header graphic on
 * the card, gives the account switcher its rules, loads the lantern street,
 * puts the shared site header on top (AlUmmahNow docs/design/NAV.md "Header"),
 * and makes every link inside the sign-in flow keep the theme the flow started with.
 */
import { streetHeadTags, streetOn } from '../fanous-street/index.ts';
import { NAV_CSS } from '../nav/aun-nav.generated.ts';
import { APP_NAMES, langHref, PAGE_HEADER_CSS, PAGE_MODE_SCRIPT, pageHeaderHtml } from '../nav/page-header.ts';
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
	/** Live pages: load the lantern street when the theme switches it on (the admin preview runs no scripts). */
	street?: boolean;
	/** The shared site header on top of the page. */
	header?: SignInHeader;
}

/** What the sign-in pages' header needs (AlUmmahNow docs/design/NAV.md "Header"). */
export interface SignInHeader {
	/** The page's language (OpenAuth's ?lang=). */
	lang: 'en' | 'ar';
	/** ENVIRONMENT: "qa" / "stage" show the badge. */
	environment?: string;
	/** This page's URL: the language button keeps its path and query. */
	url: URL;
	/** The brand's link: the account home (the profile app). */
	home: string;
}

/**
 * The sign-in pages' header: brand ("Account"), environment badge, language, light/dark. No account control and no Sign in: these pages are the sign-in.
 */
export function signInHeaderHtml(h: SignInHeader): string {
	return pageHeaderHtml({
		lang: h.lang,
		brandHref: h.home,
		app: APP_NAMES.account[h.lang],
		environment: h.environment,
		langHref: langHref(h.url, h.lang === 'ar' ? 'en' : 'ar'),
	});
}

/**
 * The header on OpenAuth's pages and on the account switcher. OpenAuth's root is a full-page
 * centred column: the header takes the top and the card stays centred in the space below.
 * The card's auto margins shrink to nothing once it is taller than that space, so the header's
 * margin and the root's end padding keep the same .75rem gap above and below it at any height.
 * The passkey block ("or" + "Sign in with a passkey") sits one card gap below the form like every
 * other section (OpenAuth's own top margin doubled it), and its verify form only carries hidden
 * fields: display:contents keeps it (and its margin) from adding an empty row under "or".
 */
export const SIGN_IN_HEADER_CSS =
	`[data-component="root"]{padding:0 0 .75rem;bottom:auto;min-height:100%;justify-content:flex-start;align-items:stretch}` +
	`[data-component="root"]>.aun-header{flex:none;user-select:auto;margin-block-end:.75rem}` +
	`[data-passkey]{margin-block-start:0}[data-passkey]>form{display:contents}` +
	`[data-component="root"]>[data-component="center"]{align-self:center;margin-block:auto;padding-block:1rem;max-width:calc(100% - 2rem)}` +
	`body:has(>.aun-header){flex-direction:column;align-items:stretch;justify-content:flex-start;padding:0}` +
	`body>.aun-header~.container{margin:auto;width:calc(100% - 40px)}`;


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

	if (opts.street && streetOn(compiled.tokensCss)) out = out.replace(/<\/head>/i, `${streetHeadTags()}</head>`);

	if (opts.carryTheme) {
		const id = encodeURIComponent(opts.carryTheme);
		out = out.replace(/(\shref=")([^"]*auth_flow=[^"]*)"/g, (m, pre: string, href: string) =>
			/[?&](?:amp;)?theme=/.test(href) ? m : `${pre}${href}&amp;${THEME_PARAM}=${id}"`
		);
	}

	if (opts.header) out = addHeader(out, signInHeaderHtml(opts.header));

	if (opts.forceScheme) out = forceScheme(out, opts.forceScheme);
	return out;
}

/** Inserts the header (first in OpenAuth's root, else first in <body>) with its styles and the light/dark script, last in <head>. */
function addHeader(html: string, header: string): string {
	let placed = false;
	let out = html.replace(/(<div\b[^>]*data-component="root"[^>]*>)/, (m) => {
		placed = true;
		return `${m}${header}`;
	});
	if (!placed) out = out.replace(/(<body\b[^>]*>)/i, (m) => {
		placed = true;
		return `${m}${header}`;
	});
	if (!placed) return html;
	// a function, so "$" in the CSS or script is never read as a replacement pattern
	return out.replace(/<\/head>/i, () => `<style data-aun-header>${NAV_CSS}${PAGE_HEADER_CSS}${SIGN_IN_HEADER_CSS}</style><script>${PAGE_MODE_SCRIPT}</script></head>`);
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
