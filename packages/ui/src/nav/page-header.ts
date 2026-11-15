/**
 * The shared header (AlUmmahNow docs/design/NAV.md "Header") for Auth's server-rendered pages: the
 * profile app and the sign-in pages. It renders the vendored builders (./header.js, byte for byte
 * the AlUmmahNow file, kept equal by `pnpm nav:check`); the auth admin renders the same elements as
 * JSX and its tests compare them with these builders.
 *
 * Reading order (mirrored in Arabic): brand · environment badge · app links · language · light/dark
 * · account (or Sign in).
 */
import { appLinksHtml, brandHtml, envBadgeHtml, langButtonHtml, modeButtonHtml, signInHtml } from './header.js';
import { MODE_TOGGLE_LABELS, modeIconSvg } from './mode-toggle.js';

export type HeaderLang = 'en' | 'ar';

/** The second line under the wordmark, per app (NAV.md "Brand"): the accounts admin, and the account pages (profile and sign-in). */
export const APP_NAMES = {
	authAdmin: { en: 'Accounts admin', ar: 'إدارة الحسابات' },
	account: { en: 'Account', ar: 'الحساب' },
} as const;

/** The owner's logo and the app icons, served by each app at these paths (scripts/themes/sync-nav.ts). */
export const LOGO_SRC = '/brand/logo-64.webp';
export const APP_ICON_BASE = '/aun-nav/icons';

/**
 * Website and Videos, the public sites other than Auth's, from Auth's own host:
 * auth.<domain> (or profile.auth.<domain>, admin.auth.<domain>) → www.<domain>/<lang>/ and
 * videos.<domain>/<lang>. None on hosts outside that pattern (local dev).
 */
export function publicAppLinks(authUrl: string, lang: HeaderLang): { id: 'www' | 'videos'; href: string }[] {
	let u: URL;
	try {
		u = new URL(authUrl);
	} catch {
		return [];
	}
	const m = /(?:^|\.)auth\.(.+)$/.exec(u.host);
	if (!m) return [];
	const at = (sub: string) => `${u.protocol}//${sub}.${m[1]}`;
	return [
		{ id: 'www', href: `${at('www')}/${lang}/` },
		{ id: 'videos', href: `${at('videos')}/${lang}` },
	];
}

/**
 * The language button's link: the current page and query in the other language (`?lang=`), the
 * fragment dropped. `drop` removes one-shot parameters (an error message) from the link.
 */
export function langHref(current: URL | string, to: HeaderLang, drop: string[] = []): string {
	const u = typeof current === 'string' ? new URL(sameSitePath(current), 'https://x.invalid') : new URL(current.href);
	for (const p of drop) u.searchParams.delete(p);
	u.searchParams.set('lang', to);
	return `${sameSitePath(u.pathname)}${u.search}`;
}

/**
 * A path for a link back to this site: never protocol-relative. A request path such as
 * `//evil.example` or `/\evil.example` would otherwise become href="//evil.example?…", a link to
 * another site. Backslashes become slashes and leading slashes collapse to one; anything that
 * isn't a path is "/".
 */
export function sameSitePath(path: string): string {
	const p = String(path).replace(/\\/g, '/').replace(/^\/+/, '/');
	return p.startsWith('/') ? p : '/';
}

/**
 * The light/dark button with both icons: the page's mode is not known on the server (the choice is
 * in the browser), so CSS (PAGE_HEADER_CSS) shows the sun in dark mode and the moon in light mode,
 * and PAGE_MODE_SCRIPT names the button for the mode on screen. Otherwise exactly modeButtonHtml.
 */
export function modeButtonBothHtml(lang: HeaderLang, dark = false): string {
	const one = modeButtonHtml({ lang, dark });
	const icon = modeIconSvg(dark ? 'sun' : 'moon');
	if (!one.includes(icon)) throw new Error('header.js modeButtonHtml no longer renders modeIconSvg');
	return one.replace(icon, modeIconSvg('sun', 'aun-mode-sun') + modeIconSvg('moon', 'aun-mode-moon'));
}

export interface PageHeaderOptions {
	lang: HeaderLang;
	/** The app's own home. */
	brandHref: string;
	/** The second line under the wordmark (APP_NAMES). */
	app: string;
	/** APP_ENV / ENVIRONMENT: "qa" and "stage" show the badge. */
	environment?: string;
	/** Website and Videos (publicAppLinks). */
	appLinks: { id: string; href: string }[];
	/** langHref(...) */
	langHref: string;
	/** The account control's markup (signed in), else... */
	account?: string;
	/** ...the Sign in link (signed out). Neither: no account slot (the sign-in pages themselves). */
	signInHref?: string;
}

/**
 * The whole header bar: full width in every app (the brand 16px from the edge, 12px on phones),
 * never centred in a max width, and in the contract's typeface (aun-nav.css .aun-header), whatever
 * font the page uses.
 */
export function pageHeaderHtml(o: PageHeaderOptions): string {
	const account = o.account ?? (o.signInHref ? signInHtml({ lang: o.lang, href: o.signInHref }) : '');
	const row =
		brandHtml({ lang: o.lang, href: o.brandHref, app: o.app, logoSrc: LOGO_SRC }) +
		envBadgeHtml(o.environment, o.lang) +
		`<div class="aun-header-tools">` +
		appLinksHtml({ lang: o.lang, links: o.appLinks, iconBase: APP_ICON_BASE }) +
		langButtonHtml({ lang: o.lang, href: o.langHref }) +
		modeButtonBothHtml(o.lang) +
		account +
		`</div>`;
	return `<header class="aun-header" data-testid="aun-header">${row}</header>`;
}

/**
 * What the light/dark button needs on a page whose mode lives in the browser: the icon of the mode
 * on screen, and color-scheme following the chosen mode (the shared menus use light-dark()).
 */
export const PAGE_HEADER_CSS =
	`.aun-mode .aun-mode-sun{display:none}` +
	`html.dark .aun-mode .aun-mode-sun{display:block}` +
	`html.dark .aun-mode .aun-mode-moon{display:none}` +
	// no class yet (no script, or the admin's preview frame): the device's mode
	`@media (prefers-color-scheme: dark){html:not(.light):not(.dark) .aun-mode .aun-mode-sun{display:block}html:not(.light):not(.dark) .aun-mode .aun-mode-moon{display:none}}` +
	`:root.dark{color-scheme:dark}:root.light{color-scheme:light}`;

/**
 * Light / Dark on a server-rendered page whose styles follow the device (prefers-color-scheme), the
 * same switch as the other apps (AlUmmahNow apps/web color-mode; owner decision 2026-11-13: no
 * "System" option). Inline at the end of <head>, after the page's styles. Plain ES5, never throws.
 *
 * - The choice is saved in localStorage `theme` ("light" / "dark"); with nothing saved the page
 *   follows the device, live.
 * - A saved choice wins over the device: every `prefers-color-scheme` media rule in the page's
 *   stylesheets (nested ones too, and stylesheets that load later) is made to answer for the chosen
 *   mode, before first paint; `.dark` / `.light` on <html> say which mode is on screen.
 * - Any `.aun-mode` button switches to the other mode, and is named for the mode it switches to.
 */
export const PAGE_MODE_SCRIPT = `(function(){var d=document.documentElement,k="theme",mem=null,L=${JSON.stringify(MODE_TOGGLE_LABELS)},q=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null,keep=[];function saved(){if(mem)return mem;try{var v=localStorage.getItem(k);if(v==="system"){v=q&&q.matches?"dark":"light";localStorage.setItem(k,v)}return v==="light"||v==="dark"?v:null}catch(e){return null}}function fix(rules,m){for(var i=0;i<rules.length;i++){var r=rules[i];if(r.type===4&&r.media){if(r.__aunMq===undefined&&/prefers-color-scheme/.test(r.media.mediaText)){r.__aunMq=r.media.mediaText;keep.push(r)}if(r.__aunMq!==undefined){var t=m?r.__aunMq.replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)/g,function(_,s){return s===m?"(min-width: 0px)":"(max-width: 0px)"}):r.__aunMq;if(r.media.mediaText!==t)r.media.mediaText=t}}if(r.cssRules)fix(r.cssRules,m)}}function label(){var l=L[d.lang==="ar"?"ar":"en"],t=d.classList.contains("dark")?l.toLight:l.toDark,b=document.querySelectorAll(".aun-mode");for(var i=0;i<b.length;i++){b[i].setAttribute("aria-label",t);b[i].setAttribute("title",t)}}function apply(){var m=saved(),dk=m?m==="dark":!!(q&&q.matches),c=d.classList;if(c.contains("dark")!==dk)c.toggle("dark",dk);if(c.contains("light")===dk)c.toggle("light",!dk);var ss=document.styleSheets;for(var i=0;i<ss.length;i++){var rs=null;try{rs=ss[i].cssRules}catch(e){}if(rs)fix(rs,m)}label()}apply();document.addEventListener("DOMContentLoaded",apply);window.addEventListener("load",apply);document.addEventListener("load",function(e){if(e.target&&e.target.tagName==="LINK")apply()},true);if(q){if(q.addEventListener)q.addEventListener("change",apply);else if(q.addListener)q.addListener(apply)}window.addEventListener("storage",function(e){if(e.key===k){mem=null;apply()}});window.__aunSetMode=function(m){mem=m;try{localStorage.setItem(k,m)}catch(e){}apply()};document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest(".aun-mode"):null;if(b)window.__aunSetMode(d.classList.contains("dark")?"light":"dark")})})();`;
