/**
 * The Al Ummah Now email design: one layout for every email the platform sends.
 *
 * Each email is ONE language (en or ar), chosen when the action happens: the
 * admin's pick in the send dialog, the page the user clicked from, or the
 * user's saved preference (English otherwise). Subject, preheader, body, plain
 * text, `dir`/`lang` and dates all follow it.
 *
 * - Header: the owner's logo as is (hosted on www) on the night-teal band with
 *   a lantern-gold rule; brand colours from www's Lantern/Fanous tokens.
 * - Body: table based, 600 px max, mobile first; Arabic font stack and RTL.
 * - Dark mode: `color-scheme` meta + `prefers-color-scheme` (and Outlook.com's
 *   [data-ogsc]); clients that ignore both get the light colours, which are
 *   complete on their own.
 * - Every email has a preheader, a clear CTA (when there is an action), a
 *   footer with the site link and why the reader got it, and a plain-text part
 *   rendered from the same blocks (renderEmailText), so the two never drift.
 *
 * Twin file: AlUmmahNow apps/admin-api/src/lib/email/layout.ts. The repos share
 * no package, so keep the two copies identical (same tokens, same blocks).
 */

export type EmailLocale = 'en' | 'ar';

/** One piece of an email body. Strings are plain text: the layout escapes them. */
export type EmailBlock =
	| { kind: 'p'; text: string }
	/** A one-time code in a large, selectable box. */
	| { kind: 'code'; label: string; code: string; hint?: string }
	/** Label/value rows (topic, reason, count...). */
	| { kind: 'facts'; rows: [string, string][] }
	/** Quoted text the reader or an admin wrote (kept as typed, line breaks kept, dir="auto"). */
	| { kind: 'quote'; label?: string; text: string }
	/** A highlighted box: security notices, warnings. */
	| { kind: 'notice'; text: string; tone?: 'info' | 'warning' }
	/** Small print (expiry, "ignore this if..."). */
	| { kind: 'small'; text: string }
	/** A plain link with its own label, shown under the text in the plain-text part. */
	| { kind: 'link'; label: string; url: string };

export interface EmailDoc {
	locale: EmailLocale;
	/** <title>, also the header's accessible name of the message */
	subject: string;
	/** Shown by inbox lists next to the subject; never visible in the body. */
	preheader: string;
	greeting?: string;
	/** Optional heading above the body */
	heading?: string;
	blocks: EmailBlock[];
	cta?: { label: string; url: string };
	/** Blocks after the button (small print, notes) */
	after?: EmailBlock[];
	signoff?: string;
	/** Footer: why the reader got this email. */
	reason: string;
	/** Footer says "This is an automated message." (default); false when replies reach a person. */
	automated?: boolean;
	/** Site origin for the footer link, e.g. https://www.alummahnow.net */
	siteUrl?: string;
	/** Per-sign-in-theme overrides (Auth themes' `email` section); invalid values are ignored. */
	theme?: EmailThemeOverrides;
}

export interface EmailThemeOverrides {
	headerImage?: string;
	background?: string;
	text?: string;
	buttonBackground?: string;
	buttonText?: string;
	buttonRadius?: string;
}

/**
 * The owner's logo as is (AlUmmahNowUI public/brand/alummah-now-logo.png), served
 * from www and shown at 64 px. A 128 px copy (alummah-now-logo-email.png) ships
 * with the next www release; switch to it then (it is ~25 KB instead of ~1 MB).
 */
export const EMAIL_LOGO_URL = 'https://www.alummahnow.net/brand/alummah-now-logo.png';
export const SITE_URL = 'https://www.alummahnow.net';

/** www's tokens (AlUmmahNowUI src/styles/global.css), as email-safe hex. */
export const EMAIL_COLORS = {
	light: {
		page: '#f2f6f5', // mist
		card: '#ffffff', // paper
		text: '#12282f', // ink
		soft: '#435c63', // ink-soft
		line: '#d3dfdd',
		link: '#0a5c6e',
		button: '#0b3443', // night
		buttonText: '#ffffff',
		codeBg: '#fff4e3', // notice-bg
		codeLine: '#f1d3a6',
		codeText: '#0b3443',
		accent: '#8a5a12', // brass
		warnBg: '#fff4e3',
		warnLine: '#f5a443',
	},
	dark: {
		page: '#09151e',
		card: '#0e2b3d',
		text: '#f7f1e8',
		soft: '#b0c0c8',
		line: '#184456',
		link: '#fbc661',
		button: '#f5a443', // lantern
		buttonText: '#072832', // night-deep
		codeBg: '#133a4e',
		codeLine: '#3d6475',
		codeText: '#fbefd0',
		accent: '#f5cf92',
		warnBg: '#133a4e',
		warnLine: '#f5a443',
	},
	header: '#0b3443', // night: the band is dark in both modes
	headerText: '#e6f0ef', // on-night
	lantern: '#f5a443',
} as const;

const FONT = {
	en: "system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
	ar: "'Noto Naskh Arabic','Geeza Pro','Segoe UI',Tahoma,Arial,sans-serif",
} as const;

const BRAND = { en: 'Al Ummah Now', ar: 'الأمة الآن' } as const;
const FOOTER = {
	en: { visit: 'Visit Al Ummah Now', auto: 'This is an automated message.' },
	ar: { visit: 'زيارة الأمة الآن', auto: 'هذه رسالة آلية.' },
} as const;

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Only https URLs reach an href or src. */
export function safeUrl(url: string): string {
	return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '#';
}

const SAFE_VALUE = /^(?:#[0-9a-fA-F]{3,8}|\d{1,3}(?:\.\d+)?(?:px|rem|em|%)|0)$/;
const safeValue = (v: string | undefined) => (v && SAFE_VALUE.test(v) ? v : undefined);

export const dirOf = (locale: EmailLocale) => (locale === 'ar' ? 'rtl' : 'ltr');

/** A date in the email's one language (UTC, so every reader sees the same day). */
export function formatEmailDate(at: number | string | Date, locale: EmailLocale, withTime = false): string {
	const date = at instanceof Date ? at : new Date(at);
	if (Number.isNaN(date.getTime())) return String(at);
	const text = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
		dateStyle: 'long',
		...(withTime ? { timeStyle: 'short' } : {}),
		timeZone: 'UTC',
	}).format(date);
	return withTime ? `${text} UTC` : text;
}

/** Line breaks the writer typed become <br>. */
const lines = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

type Palette = { [K in keyof typeof EMAIL_COLORS.light]: string };

function blockHtml(block: EmailBlock, locale: EmailLocale, c: Palette): string {
	const start = locale === 'ar' ? 'right' : 'left';
	switch (block.kind) {
		case 'p':
			return `<p class="t" style="margin:0 0 16px;font-size:${locale === 'ar' ? 17 : 16}px;line-height:1.65;color:${c.text};">${lines(block.text)}</p>`;
		case 'small':
			return `<p class="s" style="margin:0 0 10px;font-size:13px;line-height:1.6;color:${c.soft};">${lines(block.text)}</p>`;
		case 'link':
			return `<p class="t" style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${c.text};"><a class="a" href="${escapeHtml(safeUrl(block.url))}" style="color:${c.link};text-decoration:underline;">${escapeHtml(block.label)}</a></p>`;
		case 'code':
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td class="code" align="center" style="background:${c.codeBg};border:1px solid ${c.codeLine};border-radius:12px;padding:20px 16px;">
<p class="s" style="margin:0 0 6px;font-size:13px;color:${c.soft};">${escapeHtml(block.label)}</p>
<p class="codetext" dir="ltr" style="margin:0;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:34px;line-height:1.2;font-weight:700;letter-spacing:8px;color:${c.codeText};">${escapeHtml(block.code)}</p>
${block.hint ? `<p class="s" style="margin:8px 0 0;font-size:13px;color:${c.soft};">${escapeHtml(block.hint)}</p>` : ''}
</td></tr></table>`;
		case 'facts':
			return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;font-size:15px;line-height:1.5;">${block.rows
				.map(
					([k, v]) =>
						`<tr><td class="s" valign="top" style="padding:3px 0;padding-${locale === 'ar' ? 'left' : 'right'}:16px;color:${c.soft};white-space:nowrap;text-align:${start};">${escapeHtml(k)}</td><td class="t" valign="top" dir="auto" style="padding:3px 0;color:${c.text};font-weight:600;text-align:${start};">${escapeHtml(v)}</td></tr>`,
				)
				.join('')}</table>`;
		case 'quote':
			return `${block.label ? `<p class="s" style="margin:0 0 6px;font-size:13px;font-weight:600;color:${c.soft};">${escapeHtml(block.label)}</p>` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tr><td class="quote" dir="auto" style="border-${start}:3px solid ${EMAIL_COLORS.lantern};padding:2px 14px;font-size:15px;line-height:1.6;color:${c.soft};text-align:${start};">${lines(block.text)}</td></tr></table>`;
		case 'notice': {
			const warn = block.tone === 'warning';
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px;"><tr><td class="notice" style="background:${warn ? c.warnBg : c.page};border-${start}:4px solid ${warn ? c.warnLine : c.line};border-radius:8px;padding:12px 16px;font-size:14px;line-height:1.6;color:${c.text};text-align:${start};">${lines(block.text)}</td></tr></table>`;
		}
	}
}

function blockText(block: EmailBlock): string {
	switch (block.kind) {
		case 'p':
		case 'small':
			return block.text;
		case 'link':
			return `${block.label}:\n${block.url}`;
		case 'code':
			return [`${block.label}: ${block.code}`, block.hint ?? ''].filter(Boolean).join('\n');
		case 'facts':
			return block.rows.map(([k, v]) => `${k}: ${v}`).join('\n');
		case 'quote':
			return [block.label ?? '', block.text.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n')].filter(Boolean).join('\n');
		case 'notice':
			return block.text;
	}
}

function button(cta: { label: string; url: string }, theme: EmailThemeOverrides | undefined): string {
	const c = EMAIL_COLORS.light;
	const bg = safeValue(theme?.buttonBackground) ?? c.button;
	const fg = safeValue(theme?.buttonText) ?? c.buttonText;
	const radius = safeValue(theme?.buttonRadius) ?? '10px';
	const href = escapeHtml(safeUrl(cta.url));
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td class="btn" align="center" bgcolor="${bg}" style="background:${bg};border-radius:${radius};">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="20%" stroke="f" fillcolor="${bg}"><center style="color:${fg};font-size:16px;font-weight:bold;">${escapeHtml(cta.label)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a class="btna" href="${href}" style="display:inline-block;padding:14px 28px;font-size:16px;line-height:20px;font-weight:700;color:${fg};text-decoration:none;border-radius:${radius};mso-hide:all;">${escapeHtml(cta.label)}</a><!--<![endif]-->
</td></tr></table>`;
}

const DARK_CSS = (() => {
	const d = EMAIL_COLORS.dark;
	const rules = `
.bg{background:${d.page}!important}
.card{background:${d.card}!important;border-color:${d.line}!important}
.t,.t td{color:${d.text}!important}
.s{color:${d.soft}!important}
.a{color:${d.link}!important}
.code{background:${d.codeBg}!important;border-color:${d.codeLine}!important}
.codetext{color:${d.codeText}!important}
.quote{color:${d.soft}!important}
.notice{background:${d.warnBg}!important;color:${d.text}!important}
.btn{background:${d.button}!important}
.btna{color:${d.buttonText}!important}
.rule{border-color:${d.line}!important}`;
	const scoped = (prefix: string) =>
		rules
			.trim()
			.split('\n')
			.map((r) => r.replace(/^([^{]+)\{/, (_, sel: string) => `${sel.split(',').map((s) => `${prefix} ${s}`).join(',')}{`))
			.join('\n');
	return { media: rules, ogsc: scoped('[data-ogsc]') };
})();

/** The HTML part. */
export function renderEmailHtml(doc: EmailDoc): string {
	const { locale } = doc;
	const dir = dirOf(locale);
	const start = locale === 'ar' ? 'right' : 'left';
	const page = safeValue(doc.theme?.background) ?? EMAIL_COLORS.light.page;
	const c: Palette = { ...EMAIL_COLORS.light, page, text: safeValue(doc.theme?.text) ?? EMAIL_COLORS.light.text };
	const font = FONT[locale];
	const logo = doc.theme?.headerImage && /^https:\/\/[^\s"'<>]+$/.test(doc.theme.headerImage) ? doc.theme.headerImage : EMAIL_LOGO_URL;
	const site = safeUrl(doc.siteUrl ?? SITE_URL);
	const siteHome = `${site.replace(/\/$/, '')}/${locale}`;
	const f = FOOTER[locale];
	const body = doc.blocks.map((b) => blockHtml(b, locale, c)).join('\n');
	const after = (doc.after ?? []).map((b) => blockHtml(b, locale, c)).join('\n');
	// Inbox preview: the preheader, then invisible padding so body text does not follow it
	const pad = '&#8199;&#65279;&#847; '.repeat(40);
	return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(doc.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a{color:${c.link}}
@media only screen and (max-width:620px){
.wrap{padding:0!important}
.card{border-radius:0!important;border-left:0!important;border-right:0!important}
.pad{padding:24px 20px!important}
.codetext{font-size:28px!important;letter-spacing:5px!important}
.btn,.btna{display:block!important;width:100%!important;box-sizing:border-box}
}
@media (prefers-color-scheme:dark){${DARK_CSS.media}
}
${DARK_CSS.ogsc}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${page};font-family:${font};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${page};">${escapeHtml(doc.preheader)}${pad}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${page};">
<tr><td class="wrap" align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" lang="${locale}" style="max-width:600px;background:${c.card};border:1px solid ${c.line};border-radius:16px;overflow:hidden;font-family:${font};">
<tr><td align="center" bgcolor="${EMAIL_COLORS.header}" style="background:${EMAIL_COLORS.header};padding:28px 24px 22px;border-bottom:3px solid ${EMAIL_COLORS.lantern};">
<a href="${escapeHtml(siteHome)}" style="text-decoration:none;"><img src="${escapeHtml(logo)}" width="64" height="64" alt="${escapeHtml(BRAND[locale])}" style="display:block;margin:0 auto 10px;width:64px;height:64px;border-radius:32px;"></a>
<p style="margin:0;font-size:${locale === 'ar' ? 22 : 20}px;line-height:1.3;font-weight:700;color:${EMAIL_COLORS.headerText};letter-spacing:${locale === 'ar' ? 0 : 0.3}px;">${escapeHtml(BRAND[locale])}</p>
</td></tr>
<tr><td class="pad" style="padding:32px 36px 12px;text-align:${start};">
${doc.heading ? `<h1 class="t" style="margin:0 0 16px;font-size:${locale === 'ar' ? 24 : 22}px;line-height:1.35;font-weight:700;color:${c.text};">${escapeHtml(doc.heading)}</h1>` : ''}
${doc.greeting ? `<p class="t" style="margin:0 0 16px;font-size:${locale === 'ar' ? 17 : 16}px;line-height:1.6;color:${c.text};">${escapeHtml(doc.greeting)}</p>` : ''}
${body}
${doc.cta ? button(doc.cta, doc.theme) : ''}
${after}
${doc.signoff ? `<p class="t" style="margin:8px 0 16px;font-size:15px;line-height:1.6;color:${c.text};">${lines(doc.signoff)}</p>` : ''}
</td></tr>
<tr><td class="pad" style="padding:0 36px 28px;text-align:${start};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid ${c.line};padding-top:16px;">
<p class="s" style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${c.soft};">${escapeHtml(doc.reason)}</p>
<p class="s" style="margin:0;font-size:12px;line-height:1.6;color:${c.soft};"><a class="a" href="${escapeHtml(siteHome)}" style="color:${c.link};">${escapeHtml(f.visit)}</a>${doc.automated === false ? '' : ` · ${escapeHtml(f.auto)}`}</p>
</td></tr></table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text part: the same blocks, in the same order. */
export function renderEmailText(doc: EmailDoc): string {
	const site = `${(doc.siteUrl ?? SITE_URL).replace(/\/$/, '')}/${doc.locale}`;
	const parts = [
		doc.heading ?? '',
		doc.greeting ?? '',
		...doc.blocks.map(blockText),
		doc.cta ? `${doc.cta.label}:\n${doc.cta.url}` : '',
		...(doc.after ?? []).map(blockText),
		doc.signoff ?? '',
		'—',
		doc.reason,
		`${FOOTER[doc.locale].visit}: ${site}`,
	];
	return parts.filter((p) => p !== '').join('\n\n');
}

export interface RenderedEmailParts {
	subject: string;
	html: string;
	text: string;
}

export function renderEmail(doc: EmailDoc): RenderedEmailParts {
	return { subject: doc.subject, html: renderEmailHtml(doc), text: renderEmailText(doc) };
}
