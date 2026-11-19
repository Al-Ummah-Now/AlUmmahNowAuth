/**
 * @fileoverview Auth's error pages: a server error (500), the database being unreachable (503) and an
 * unknown page (404). The Al Ummah Now error-page family (wiki guides/error-pages.md): the same badge,
 * "Error 500" line, words and actions as the videos site, admin, www, scholar sites and the CMS, inside
 * Auth's own themed sign-in card and lantern street with the shared header (finishThemedResponse).
 * Built-in theme only: an error page never waits on the theme store (D1 may be the thing that failed).
 * English unless `?lang=ar`. Never a stack trace, a raw message or a timestamp; the reference to quote.
 */
import { html, raw } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import { compileBuiltin } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { openauthThemeFor } from '../../../../packages/ui/src/auth-theme/compile.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../../packages/ui/src/auth-theme/resolve.ts';
import { signInFavicon } from '../themes/favicon.ts';
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
export const ERROR_COPY: Record<ErrorLocale, { kinds: Record<AuthErrorKind, { title: string; body: string }>; tryAgain: string; goHome: string; goBack: string; reference: string; referenceHint: string; copy: string; copied: string; needHelp: string; contactUs: string; errorCode: string }> = {
	en: {
		kinds: {
			notFound: { title: 'Page not found', body: "We couldn't find this page. The link may be wrong, or the page may have moved." },
			server: { title: 'We could not load this page', body: 'Our server had a problem with this request. It has been reported. Please try again in a moment.' },
			unavailable: { title: 'Sign-in is temporarily unavailable', body: 'We could not reach our account service. It has been reported. Please try again in a few minutes.' },
		},
		tryAgain: 'Try again',
		goHome: 'Go to home',
		goBack: 'Go back',
		reference: 'Reference',
		referenceHint: 'Quote this reference if you contact us, so we can find what happened.',
		copy: 'Copy reference',
		copied: 'Copied',
		needHelp: 'Still stuck?',
		contactUs: 'Contact us',
		errorCode: 'Error {code}',
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
	},
};

const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const STATUS: Record<AuthErrorKind, number> = { notFound: 404, server: 500, unavailable: 503 };

/** "Error 500" / «خطأ ٥٠٠» (Eastern Arabic digits in Arabic, never the implicit 'ar' default). */
export function errorCodeLabel(locale: ErrorLocale, code: number): string {
	const digits = new Intl.NumberFormat(locale === 'ar' ? 'ar-u-nu-arab' : 'en-US', { useGrouping: false }).format(code);
	return ERROR_COPY[locale].errorCode.replace('{code}', digits);
}

/** The family's lucide shapes (monorepo ERROR_PAGE_ICONS). */
const ICONS = {
	notFound: '<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>',
	alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
} as const;
const icon = (name: keyof typeof ICONS, size = 26) =>
	raw(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`);

/* The family card's inner parts inside Auth's themed card: theme tokens only, logical properties, no
   animation. The card, button, links and street are the sign-in theme's own. */
const STYLE = `
[data-page=error] .ep-head{display:grid;grid-template-columns:auto 1fr;column-gap:16px;align-items:center;text-align:start}
[data-page=error] .ep-badge{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:var(--fanous-color-primary,#e8b477);color:var(--fanous-color-on-primary,#09151e);box-shadow:0 0 18px -4px color-mix(in srgb,var(--fanous-color-primary,#e8b477) 60%,transparent)}
[data-page=error] .ep-code{margin:0 0 2px;font-size:13px;font-weight:600;letter-spacing:.06em;opacity:.8}
[data-page=error]:lang(ar) .ep-code{letter-spacing:0}
[data-page=error] [data-component=title]{margin:0;text-align:start}
[data-page=error] [data-component=description]{text-align:start;line-height:1.65}
[data-page=error] .ep-ref{padding:12px 16px;border-radius:10px;background:color-mix(in srgb,currentColor 7%,transparent);font-size:14px;text-align:start}
[data-page=error] .ep-ref-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
[data-page=error] .ep-ref code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}
[data-page=error] .ep-ref-copy{display:inline-flex;align-items:center;gap:6px;margin-inline-start:auto;min-height:36px;padding-inline:10px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
[data-page=error] .ep-ref p{margin:6px 0 0;opacity:.85;line-height:1.5}
[data-page=error] .ep-links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 20px;font-size:14px}
[data-page=error] .ep-links button{border:0;background:none;padding:0;font:inherit;cursor:pointer}
[data-page=error] a[data-component=button]{text-decoration:none}
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
	const url = new URL(o.request?.url ?? 'https://auth.alummahnow.net/');
	const header = signInHeaderFor(url, locale, o.env ?? {});
	const compiled = compileBuiltin(BUILTIN_DEFAULT_THEME, url.origin)!;
	const retry = o.kind === 'notFound' ? null : sameOriginPath(o.retryUrl, url.origin);
	// hono/html escapes every interpolated value; raw() only for our own constants
	const body = html`<style>${raw(STYLE)}</style>
		<div data-component="form" data-page="error" data-error-status="${status}" data-testid="error-screen" ${o.kind === 'notFound' ? '' : raw('role="alert"')}>
			<div class="ep-head">
				<span class="ep-badge" aria-hidden="true">${icon(o.kind === 'notFound' ? 'notFound' : 'alert')}</span>
				<div>
					<p class="ep-code">${errorCodeLabel(locale, status)}</p>
					<h1 data-component="title">${copy.title}</h1>
				</div>
			</div>
			<p data-component="description">${copy.body}</p>
			${o.reference
				? html`<div class="ep-ref" data-testid="error-reference-box">
						<div class="ep-ref-row">
							<span>${t.reference}</span>
							<code id="ep-ref" dir="ltr" data-testid="error-reference">${o.reference}</code>
							<button type="button" class="ep-ref-copy" data-ep-copy data-copied="${t.copied}">${icon('copy', 16)}<span>${t.copy}</span></button>
						</div>
						<p>${t.referenceHint}</p>
					</div>`
				: ''}
			<a data-component="button" href="${retry ?? header.home}" data-action="${retry ? 'retry' : 'home'}">${retry ? t.tryAgain : t.goHome}</a>
			<p class="ep-links">
				<button type="button" data-component="link" data-ep-back hidden>${t.goBack}</button>
				${retry ? html`<a data-component="link" href="${header.home}">${t.goHome}</a>` : ''}
				<span>${t.needHelp} <a data-component="link" href="${contactHref(url, locale, o.reference)}">${t.contactUs}</a></span>
			</p>
		</div>
		<script>${raw(COPY_SCRIPT)}</script>`;
	const theme = { ...openauthThemeFor(compiled), favicon: signInFavicon(compiled, o.env?.ENVIRONMENT) };
	const page = Layout({ theme, locale, children: body });
	// The tab says what happened (the theme's title stays the card's site name)
	const doc = `<!DOCTYPE html>${(await page.toString())
		.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(copy.title)} | ${locale === 'ar' ? 'الأمة الآن' : 'Al Ummah Now'}</title>`)
		.replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>')}`;
	const raw500 = new Response(doc, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Language': locale,
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex',
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
