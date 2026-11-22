/**
 * @fileoverview Auth's error pages: a server error (500), the database being unreachable (503) and an
 * unknown page (404). The Al Ummah Now error-page family (wiki guides/error-pages.md): the same badge,
 * "Error 500" line, words and actions as the videos site, admin, www, scholar sites and the CMS, inside
 * Auth's sign-in page and lantern street with the shared header (finishThemedResponse); the card is the
 * family's own (the vendored sheet), not the sign-in card.
 * Built-in theme only: an error page never waits on the theme store (D1 may be the thing that failed).
 * English unless `?lang=ar`. Never a stack trace, a raw message or a timestamp; the reference to quote.
 */
import { html, raw } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import { compileBuiltin } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { openauthThemeFor } from '../../../../packages/ui/src/auth-theme/compile.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../../packages/ui/src/auth-theme/resolve.ts';
import { formatNumber } from '../../../../packages/ui/src/format.ts';
import { signInFavicon } from '../themes/favicon.ts';
import { ERROR_PAGE_CSS } from './error-page-css.vendored.ts';
import { finishThemedResponse, signInHeaderFor } from '../themes/pages.ts';

type ErrorLocale = 'en' | 'ar';
export type AuthErrorKind = 'notFound' | 'server' | 'unavailable';

/** English unless the link asks for Arabic with `?lang=ar`; any other value is English. */
export function errorPageLocale(request?: Request): ErrorLocale {
	if (!request) return 'en';
	try {
		return new URL(request.url).searchParams.get('lang') === 'ar' ? 'ar' : 'en';
	} catch {
		return 'en';
	}
}

/** The family's words (a copy of the monorepo's ERROR_SCREEN_STRINGS; keep them in step). */
export const ERROR_COPY: Record<ErrorLocale, { kinds: Record<AuthErrorKind, { title: string; body: string }>; tryAgain: string; goHome: string; goBack: string; reference: string; referenceHint: string; copy: string; copied: string; needHelp: string; contactUs: string; errorCode: string; pageTitle: string }> = {
	en: {
		kinds: {
			notFound: { title: 'Page not found', body: 'We couldn’t find this page. The link may be wrong, or the page may have moved.' },
			server: { title: 'We could not load this page', body: 'Our server had a problem with this request. It has been reported. Please try again in a moment.' },
			unavailable: { title: 'Sign-in is temporarily unavailable', body: 'We could not reach our account service. It has been reported. Please try again in a few minutes.' },
		},
		tryAgain: 'Try again',
		goHome: 'Home page',
		goBack: 'Go back',
		reference: 'Reference',
		referenceHint: 'Quote this reference if you contact us, so we can find what happened.',
		copy: 'Copy reference',
		copied: 'Copied',
		needHelp: 'Still stuck?',
		contactUs: 'Contact us',
		errorCode: 'Error {code}',
		pageTitle: '{title} | Al Ummah Now',
	},
	ar: {
		kinds: {
			notFound: { title: 'الصفحة غير موجودة', body: 'لم نعثر على هذه الصفحة. ربما الرابط غير صحيح أو نُقلت الصفحة.' },
			server: { title: 'تعذّر تحميل هذه الصفحة', body: 'واجه الخادم مشكلة في هذا الطلب، وقد أُبلغ عنها. يُرجى المحاولة بعد قليل.' },
			unavailable: { title: 'تسجيل الدخول غير متاح مؤقتًا', body: 'تعذّر الوصول إلى خدمة الحسابات، وقد أُبلغ عن ذلك. يُرجى المحاولة بعد دقائق.' },
		},
		tryAgain: 'حاول مرة أخرى',
		goHome: 'الصفحة الرئيسية',
		goBack: 'رجوع',
		reference: 'الرقم المرجعي',
		referenceHint: 'اذكر هذا الرقم المرجعي عند التواصل معنا لنعرف ما حدث.',
		copy: 'انسخ الرقم المرجعي',
		copied: 'نُسخ',
		needHelp: 'ما زلت تواجه المشكلة؟',
		contactUs: 'تواصل معنا',
		errorCode: 'خطأ {code}',
		pageTitle: '{title} | الأمة الآن',
	},
};

const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const STATUS: Record<AuthErrorKind, number> = { notFound: 404, server: 500, unavailable: 503 };

/** "Error 500" / «خطأ ٥٠٠» (Eastern Arabic digits in Arabic, never the implicit 'ar' default). */
export function errorCodeLabel(locale: ErrorLocale, code: number): string {
	const digits = formatNumber(code, locale, { useGrouping: false }, 'en-US');
	return ERROR_COPY[locale].errorCode.replace('{code}', digits);
}

/** "Page not found | Al Ummah Now" / «الصفحة غير موجودة | الأمة الآن»: the family's tab title. */
export function errorPageTitle(locale: ErrorLocale, title: string): string {
	return ERROR_COPY[locale].pageTitle.replace('{title}', title);
}

/** The family's lucide shapes (monorepo ERROR_PAGE_ICONS). */
const ICONS = {
	notFound: '<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>',
	alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
	home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
} as const;
const icon = (name: keyof typeof ICONS) =>
	raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="${name}">${ICONS[name]}</svg>`);

/** The family's own buttons (the vendored sheet), never the sign-in theme's: the same on every app. */
const PRIMARY = 'ep-btn ep-btn-primary';
const SECONDARY = 'ep-btn ep-btn-secondary';

/* Auth's frame around the family card: the sign-in theme's header, page and street stay; its card
   chrome (the lantern graphic, logo and wordmark) steps aside so the family card is the only card and
   the page has one h1. The card reads the theme's own fonts (the sign-in pages' body font). */
const FRAME_STYLE = `
[data-component=center]:has(>.ep){width:100%;max-width:none;margin:0;padding:0;background:none;border:0;border-radius:0;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
[data-component=center]:has(>.ep)>.demo-gfx{display:none}
[data-component=center]:has(>.ep)::before,[data-component=center]:has(>.ep)::after{content:none}
.ep{font-family:var(--fanous-font-latin,system-ui,sans-serif)}
.ep[lang=ar]{font-family:var(--fanous-font-arabic,system-ui,sans-serif)}
`;

const COPY_SCRIPT = `(function(){var b=document.querySelector('[data-ep-back]');if(b&&history.length>1){b.hidden=false;b.addEventListener('click',function(){history.back()})}var c=document.querySelector('[data-ep-copy]');if(!c)return;c.addEventListener('click',function(){var r=document.getElementById('ep-ref').textContent;navigator.clipboard.writeText(r).then(function(){var s=c.querySelector('span');var o=s.textContent;s.textContent=c.dataset.copied;setTimeout(function(){s.textContent=o},2000)})})})();`;

interface RenderOptions {
	kind: AuthErrorKind;
	request?: Request;
	reference?: string;
	/** Try again: the page that failed (same origin only) */
	retryUrl?: string;
	env?: { ENVIRONMENT?: string; PROFILE_APP_URL?: string };
}

function sameOriginPath(raw: string | undefined, origin: string): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw, origin);
		return u.origin === origin ? `${u.pathname}${u.search}` : null;
	} catch {
		return null;
	}
}

async function renderFamilyPage(o: RenderOptions): Promise<Response> {
	const locale = errorPageLocale(o.request);
	const t = ERROR_COPY[locale];
	const copy = t.kinds[o.kind];
	const status = STATUS[o.kind];
	const lost = o.kind === 'notFound';
	const url = new URL(o.request?.url ?? 'https://auth.alummahnow.net/');
	const header = signInHeaderFor(url, locale, o.env ?? {});
	const compiled = compileBuiltin(BUILTIN_DEFAULT_THEME, url.origin)!;
	// 500/503: Home page + Try again (the page that failed, else this page); 404: Go back + Home page
	const retry = lost ? null : (sameOriginPath(o.retryUrl, url.origin) ?? `${url.pathname}${url.search}`);
	// hono/html escapes every interpolated value; raw() only for our own constants
	const body = html`<style>${raw(ERROR_PAGE_CSS)}${raw(FRAME_STYLE)}</style>
		<div class="ep" lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" data-page="error" data-error-status="${status}" data-testid="error-screen" ${lost ? '' : raw('role="alert"')}>
			<section class="ep-card" aria-labelledby="ep-title">
				<div class="ep-head">
					<span class="ep-badge" aria-hidden="true">${icon(lost ? 'notFound' : 'alert')}</span>
					<div class="ep-heading">
						<p class="ep-code">${errorCodeLabel(locale, status)}</p>
						<h1 class="ep-title" id="ep-title">${copy.title}</h1>
					</div>
					<p class="ep-body">${copy.body}</p>
				</div>
				${o.reference
					? html`<div class="ep-ref" data-testid="error-reference-box">
							<div class="ep-ref-row">
								<span class="ep-ref-label">${t.reference}</span>
								<code id="ep-ref" class="ep-ref-code" dir="ltr" data-testid="error-reference">${o.reference}</code>
								<button type="button" class="ep-ref-copy" data-ep-copy data-copied="${t.copied}">${icon('copy')}<span>${t.copy}</span></button>
							</div>
							<p class="ep-ref-hint">${t.referenceHint}</p>
						</div>`
					: ''}
				<footer class="ep-foot">
					<p class="ep-help">${t.needHelp} <a href="${contactHref(url, locale, o.reference)}">${t.contactUs}</a></p>
					<div class="ep-actions">
						${lost
							? html`<button type="button" class="${SECONDARY}" data-ep-back hidden>${icon('back')}<span>${t.goBack}</span></button>
									<a class="${PRIMARY}" href="${header.home}" data-action="home">${icon('home')}<span>${t.goHome}</span></a>`
							: html`<a class="${SECONDARY}" href="${header.home}" data-action="home">${icon('home')}<span>${t.goHome}</span></a>
									<a class="${PRIMARY}" href="${retry}" data-action="retry">${icon('retry')}<span>${t.tryAgain}</span></a>`}
					</div>
				</footer>
			</section>
		</div>
		<script>${raw(COPY_SCRIPT)}</script>`;
	const theme = { ...openauthThemeFor(compiled), favicon: signInFavicon(compiled, o.env?.ENVIRONMENT) };
	const page = Layout({ theme, locale, children: body });
	// The tab says what happened; the sign-in card's branding (logo and wordmark h1) is not drawn here:
	// the family card has its own heading and the header already carries the brand.
	const doc = `<!DOCTYPE html>${(await page.toString())
		.replace(/<div data-component="branding">[\s\S]*?<\/div>/, '')
		.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(errorPageTitle(locale, copy.title))}</title>`)
		.replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>')}`;
	const raw500 = new Response(doc, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Language': locale,
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex, nofollow',
			...(o.kind === 'unavailable' ? { 'Retry-After': '30' } : {}),
		},
	});
	return finishThemedResponse(raw500, compiled, url, url.origin, header);
}

/**
 * The videos site's Contact us on this environment (auth.<env>.alummahnow.net → videos.<env>…), with the
 * reference; elsewhere (local runs) the support address.
 */
export function contactHref(url: URL, locale: ErrorLocale, reference?: string): string {
	if (!url.hostname.startsWith('auth.')) {
		return `mailto:support@alummahnow.net${reference ? `?subject=${encodeURIComponent(reference)}` : ''}`;
	}
	const base = `${url.protocol}//videos.${url.hostname.slice('auth.'.length)}/${locale}/contact`;
	return reference ? `${base}?ref=${encodeURIComponent(reference)}` : base;
}

/**
 * Render a user-friendly error page for server errors
 *
 * @param error - The error that occurred (only its kind is used: D1 unreachable → 503)
 * @param requestId - The reference to quote (ERR-…)
 * @param originalUrl - The page that failed (Try again), same origin only
 * @param request - The request, for its `?lang=` (English unless it asks for Arabic)
 */
export async function renderErrorPage(error: unknown, requestId: string, originalUrl?: string, request?: Request, env?: RenderOptions['env']): Promise<Response> {
	const isD1Error =
		error instanceof Error && (error.message.includes('D1_ERROR') || error.message.includes('D1Database') || error.message.includes('error code: 1031'));
	return renderFamilyPage({ kind: isD1Error ? 'unavailable' : 'server', request, reference: requestId, retryUrl: originalUrl, env });
}

/** An unknown page asked for by a browser (Accept: text/html): the family's 404 instead of a bare "Not found". */
export async function renderNotFoundPage(request: Request, env?: RenderOptions['env']): Promise<Response> {
	return renderFamilyPage({ kind: 'notFound', request, env });
}
