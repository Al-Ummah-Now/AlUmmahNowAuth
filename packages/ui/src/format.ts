/**
 * The one display formatter for Al Ummah Now Auth: the sign-in pages and emails (apps/auth), Profile (apps/profile) and the Auth admin (apps/admin, server render and hydration). Apps import it by relative path.
 *
 * Arabic pages show Eastern Arabic (Hindi) numerals ٠–٩ for every formatted value: numbers, counts,
 * dates, times, durations and money. English pages show Arabic numerals 0–9. The numbering system
 * is always explicit (`ar-u-nu-arab`): plain `ar` gives 0–9 in Node and Chromium but ٠–٩ in WebKit,
 * so the server and every browser would disagree.
 *
 * Every `Intl.*` / `toLocale*String` display call goes through this module (packages/ui/src/format-guard.test.ts
 * fails on new ones elsewhere). Ids, URLs, slugs, codes and inputs keep what was typed; inputs
 * accept ٠–٩ and `toAsciiDigits` turns them into 0–9.
 */
export type Lang = 'en' | 'ar';

/** The Intl locale for a UI language: Arabic always with Eastern Arabic (Hindi) numerals. */
export const intlLocale = (lang: Lang | string, en: EnglishTag = 'en-GB'): string => (lang === 'ar' ? 'ar-u-nu-arab' : en);

/** The English tag a page already uses: 'en-GB' by default; a few pages keep 'en-US' so English stays as it was. */
export type EnglishTag = 'en-GB' | 'en-US' | 'en';

const isAr = (lang: Lang | string) => lang === 'ar';

/**
 * Arabic is never grouped (owner, 2026-11-21, wiki O38): «١٢٥٠», «١٢٣٤٫٥», and «٫» is the only mark.
 * «٬» and «٫» look the same in most Arabic UI fonts, so «١٬٢٥٠٫٥» reads as three numbers. English keeps "1,250".
 */
export function formatNumber(n: number, lang: Lang | string, opts: Intl.NumberFormatOptions = {}, en?: EnglishTag): string {
	return new Intl.NumberFormat(intlLocale(lang, en), isAr(lang) ? { ...opts, useGrouping: false } : opts).format(n);
}

/** A number for a {placeholder}: numbers are formatted for the language, anything else passes through. */
export const num = (v: unknown, lang: Lang | string): string => (typeof v === 'number' && Number.isFinite(v) ? formatNumber(v, lang) : String(v));

/** Fills '{0}', '{1}' (array) or '{name}' (object) placeholders; numbers are formatted for the language. */
export function fill(template: string, values: readonly unknown[] | Record<string, unknown>, lang: Lang | string): string {
	return template.replace(/\{(\w+)\}/g, (m, k: string) => {
		const v = Array.isArray(values) ? values[Number(k)] : (values as Record<string, unknown>)[k];
		return v === undefined ? m : num(v, lang);
	});
}

/** `value` cut (never rounded) to one decimal: 1.29 → 1.2, 2.999 → 2.9. */
const cut = (value: number): number => Math.floor(value * 10 + 1e-9) / 10;

interface ArabicScale { size: number; one: string; dual: string; construct: string; few: string; accusative: string }

/** Thousands and billions agree with the number; millions are always «{n} م» (owner, 2026-11-21). */
const AR_SCALES: readonly ArabicScale[] = [
	{ size: 1e9, one: 'مليار', dual: 'ملياران', construct: 'مليارا', few: 'مليارات', accusative: 'مليارًا' },
	{ size: 1e6, one: 'م', dual: 'م', construct: 'م', few: 'م', accusative: 'م' },
	{ size: 1e3, one: 'ألف', dual: 'ألفان', construct: 'ألفا', few: 'آلاف', accusative: 'ألفًا' },
];

export interface CompactOptions {
	/** A noun follows («ألفا جلسة», «١٢ ألف جلسة»); alone it is «ألفان», «١٢ ألفًا». */
	beforeNoun?: boolean;
}

function compactArabic(n: number, beforeNoun: boolean): string {
	const abs = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	const scale = AR_SCALES.find((s) => abs >= s.size);
	if (!scale) return formatNumber(n, 'ar');
	const shown = cut(abs / scale.size);
	const digits = formatNumber(shown, 'ar', { maximumFractionDigits: 1 });
	// U+00A0 keeps the number and its scale word together, as Intl writes it.
	if (scale.size === 1e6) return `${sign}${digits}\u00a0م`;
	if (!sign && shown === 1) return scale.one;
	if (!sign && shown === 2) return beforeNoun ? scale.construct : scale.dual;
	if (!Number.isInteger(shown)) return `${sign}${digits}\u00a0${scale.one}`;
	if (shown >= 3 && shown <= 10) return `${sign}${digits}\u00a0${scale.few}`;
	// 11–99 (and 111–199 …) alone take the accusative: «١٢ ألفًا»; before a noun «١٢ ألف جلسة».
	if (!beforeNoun && shown % 100 >= 11) return `${sign}${digits}\u00a0${scale.accusative}`;
	return `${sign}${digits}\u00a0${scale.one}`;
}

/**
 * Counts on stat tiles and cards: full under 1,000, compact from 1,000, cut to one decimal and
 * never rounded up (owner, 2026-11-21): 1,250 → "1.2K" / «١٫٢ ألف», 2,999 → "2.9K", 1,500,000 →
 * "1.5M" / «١٫٥ م». Tables, money and sizes stay exact with `formatNumber`.
 */
export function formatCompact(n: number, lang: Lang | string, options: CompactOptions = {}): string {
	const safe = Number.isFinite(n) ? n : 0;
	if (isAr(lang)) return compactArabic(safe, options.beforeNoun === true);
	// Not Intl's compact notation: ICU builds disagree on the suffix (Node "1.2K", Chromium "1.2k"
	// for en-GB), which breaks hydration. K/M/B/T by hand, like the Arabic scale words.
	const abs = Math.abs(safe);
	const scale = EN_SCALES.find(([size]) => abs >= size);
	if (!scale) return formatNumber(safe, lang);
	return `${formatNumber(Math.sign(safe) * cut(abs / scale[0]), lang, { maximumFractionDigits: 1 })}${scale[1]}`;
}

const EN_SCALES: readonly (readonly [number, string])[] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/** 0.25 → '25%' / '٢٥٪'. */
export const formatPercent = (ratio: number, lang: Lang | string, opts: Intl.NumberFormatOptions = {}) => formatNumber(ratio, lang, { style: 'percent', maximumFractionDigits: 1, ...opts });

/** Money: Arabic uses the currency's Arabic name («١٫٥٠ دولار أمريكي»), never «US$» inside Arabic text. */
export function formatMoney(amount: number, currency: string, lang: Lang | string, opts: Intl.NumberFormatOptions = {}): string {
	return formatNumber(amount, lang, { style: 'currency', currency, currencyDisplay: isAr(lang) ? 'name' : 'symbol', ...opts });
}

/**
 * ICU builds differ in the spaces they put in dates and times: macOS WebKit writes «٩:٣٠ ص» with a
 * no-break space where Node and Chromium write a plain one, and English "9:30 AM" uses U+202F in
 * some builds. One plain space everywhere, so a server render hydrates in every browser (React #418).
 */
export const sameSpaces = (s: string): string => s.replace(/[\u00A0\u202F\u2009]/g, ' ');

export function toDate(v: unknown): Date | null {
	if (v === null || v === undefined || v === '') return null;
	const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v) : new Date(String(v));
	return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(v: unknown, lang: Lang | string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }, en?: EnglishTag): string {
	const d = toDate(v);
	if (!d) return '';
	const one = (o: Intl.DateTimeFormatOptions) => sameSpaces(new Intl.DateTimeFormat(intlLocale(lang, en), o).format(d));
	// A date with a time: each half on its own, joined the same way everywhere. ICU builds join them
	// differently (WebKit on macOS: "12 Nov 2026 at 09:30", Node: "12 Nov 2026, 09:30"), which broke
	// hydration; the joins below are Node's.
	const { dateStyle, timeStyle, hour, minute, second, dayPeriod, hour12, hourCycle, fractionalSecondDigits, ...rest } = opts;
	const timeFields = { hour, minute, second, dayPeriod, hour12, hourCycle, fractionalSecondDigits };
	const hasTimeFields = hour !== undefined || minute !== undefined || second !== undefined;
	const hasDateFields = rest.year !== undefined || rest.month !== undefined || rest.day !== undefined || rest.weekday !== undefined;
	if (dateStyle && timeStyle) {
		const join = dateStyle === 'long' || dateStyle === 'full' ? (isAr(lang) ? ' في ' : ' at ') : isAr(lang) ? '، ' : ', ';
		return one({ ...rest, dateStyle }) + join + one({ ...rest, timeStyle });
	}
	if (!dateStyle && !timeStyle && hasTimeFields && hasDateFields) {
		const { timeZoneName, ...dateOnly } = rest;
		return one(dateOnly) + (isAr(lang) ? '، ' : ', ') + one({ ...timeFields, timeZone: rest.timeZone, timeZoneName });
	}
	return one(opts);
}

/** What `toLocaleDateString()` / `toLocaleString()` print with no options: a numeric date (and time). */
export const NUMERIC_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
export const NUMERIC_DATE_TIME: Intl.DateTimeFormatOptions = { ...NUMERIC_DATE, hour: 'numeric', minute: '2-digit', second: '2-digit' };

export const formatTime = (v: unknown, lang: Lang | string, opts: Intl.DateTimeFormatOptions = {}, en?: EnglishTag) => formatDate(v, lang, { timeStyle: 'short', ...opts }, en);

export const formatDateTime = (v: unknown, lang: Lang | string, opts: Intl.DateTimeFormatOptions = {}, en?: EnglishTag) =>
	formatDate(v, lang, { dateStyle: 'medium', timeStyle: 'short', ...opts }, en);

/** '5 minutes ago' / «قبل ٥ دقائق»; older than 30 days → `older(d)` (default: a UTC date and time). */
export function formatRelative(v: unknown, lang: Lang | string, now = Date.now(), older?: (d: Date) => string): string {
	const d = toDate(v);
	if (!d) return '—';
	const s = Math.round((d.getTime() - now) / 1000);
	const rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: 'auto' });
	const abs = Math.abs(s);
	if (abs < 60) return sameSpaces(rtf.format(s, 'second'));
	if (abs < 3600) return sameSpaces(rtf.format(Math.round(s / 60), 'minute'));
	if (abs < 86400) return sameSpaces(rtf.format(Math.round(s / 3600), 'hour'));
	if (abs < 86400 * 30) return sameSpaces(rtf.format(Math.round(s / 86400), 'day'));
	return older ? older(d) : formatDateTime(d, lang, { timeZone: 'UTC' }) + ' UTC';
}

/** Seconds → 'm:ss' or 'h:mm:ss', each part formatted for the language. */
export function formatDuration(seconds: number, lang: Lang | string): string {
	const t = Math.max(0, Math.round(seconds));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const two = (n: number) => formatNumber(n, lang, { minimumIntegerDigits: 2, useGrouping: false });
	return h > 0 ? `${formatNumber(h, lang)}:${two(m)}:${two(s)}` : `${formatNumber(m, lang)}:${two(s)}`;
}

/** The page language in a browser ('en' outside one): for modules shared with the server and tests. */
export const docLang = (): string => (globalThis as { document?: { documentElement?: { lang?: string } } }).document?.documentElement?.lang || 'en';

/** The reader's IANA time zone (not a display value). */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Joins names: 'a, b and c' / «a وb وc». */
export const formatList = (items: string[], lang: Lang | string) => new Intl.ListFormat(isAr(lang) ? 'ar' : 'en', { style: 'long', type: 'conjunction' }).format(items);

/** Input normalisation: Eastern Arabic (Hindi) ٠–٩ and Persian ۰–۹ numerals → Arabic numerals 0–9. */
export function toAsciiDigits(s: string): string {
	return s.replace(/[٠-٩۰-۹]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10));
}

/** A typed number → Arabic numerals 0–9 with '.' as the decimal mark (٫ → ., the ٬ group mark dropped). */
export const toAsciiNumber = (s: string): string => toAsciiDigits(s).replace(/\u066B/g, '.').replace(/\u066C/g, '');

/**
 * The same formatting for inline browser scripts that have no bundler (the Profile page): defines
 * `aunNum(n)` and `aunDate(value, options)` with this module's locale, so the browser shows what
 * the server would.
 */
export function clientFormatScript(lang: Lang | string, en: EnglishTag = 'en-GB'): string {
	const tag = JSON.stringify(intlLocale(lang, en));
	return (
		`var AUN_LOCALE=${tag};` +
		`function aunNum(n){return new Intl.NumberFormat(AUN_LOCALE,${isAr(lang) ? '{useGrouping:false}' : '{}'}).format(n);}` +
		`function aunDate(v,o){var d=new Date(v);return isNaN(d.getTime())?'':new Intl.DateTimeFormat(AUN_LOCALE,o||{dateStyle:'medium'}).format(d).replace(/[\\u00A0\\u202F\\u2009]/g,' ');}`
	);
}
