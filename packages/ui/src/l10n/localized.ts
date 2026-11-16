/**
 * Localized admin fields (owner rule 2026-11-16): every staff-set text that
 * has an English and an Arabic version needs both. No "leave empty to use the
 * other one", and public pages never show one language's text in the other's
 * place. User content (names, bios) is exempt.
 */

export type Lang = 'en' | 'ar';
export const LANGS: readonly Lang[] = ['en', 'ar'];

export interface LocalizedPairValue {
	en: string;
	ar: string;
}

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN = /[A-Za-z]/;

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Whether `lang` has a usable value. An Arabic value with no Arabic letters is
 * missing: the old admin forms copied the English text into the Arabic field
 * when it was left empty, so such values are English shown as Arabic. The
 * English side is only missing when empty or written entirely in Arabic.
 */
export function hasLang(value: unknown, lang: Lang): boolean {
	if (!value || typeof value !== 'object') return false;
	const text = clean((value as Record<string, unknown>)[lang]);
	if (!text) return false;
	if (lang === 'ar') return ARABIC.test(text);
	return LATIN.test(text) || !ARABIC.test(text);
}

/** The languages a staff-set pair is missing ([] when complete). */
export function missingLangs(value: unknown): Lang[] {
	return LANGS.filter((l) => !hasLang(value, l));
}

/** The value for `lang`, or undefined when that language is missing (never the other one). */
export function localizedOrUndefined(value: unknown, lang: Lang): string | undefined {
	return hasLang(value, lang) ? clean((value as Record<string, unknown>)[lang]) : undefined;
}

/**
 * Save-time check: both languages typed. Returns the empty ones. (Only
 * emptiness blocks a save; a proper noun may be written the same way in both.)
 */
export function emptyLangs(value: unknown): Lang[] {
	const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	return LANGS.filter((l) => !clean(v[l]));
}

export const LANG_NAMES: Record<Lang, { en: string; ar: string }> = {
	en: { en: 'English', ar: 'الإنجليزية' },
	ar: { en: 'Arabic', ar: 'العربية' },
};

/** "Arabic missing" / "English missing" (admin badge copy). */
export function missingLabel(lang: Lang, ui: Lang = 'en'): string {
	return ui === 'ar' ? `${LANG_NAMES[lang].ar} ناقصة` : `${LANG_NAMES[lang].en} missing`;
}
