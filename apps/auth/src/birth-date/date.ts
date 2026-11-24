/**
 * A date of birth and what is said of it (wiki E20 §5.1). Gregorian, no time zone: ages count from the date
 * at UTC−12, the last place on Earth to reach it, so nobody is older here than they are anywhere.
 */
export interface BirthDate {
	year: number;
	month: number;
	day: number;
}

/** The only thing other apps ever learn. Under 13 has no band: such an account can't stay. */
export type AgeBand = '13_15' | '16_17' | '18_plus';

export const MIN_PLAUSIBLE_AGE = 3;
export const MAX_PLAUSIBLE_AGE = 120;
export const MIN_ACCOUNT_AGE = 13;
const UTC_MINUS_12_MS = 12 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a real day, or null. */
export function parseBirthDate(value: unknown): BirthDate | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const at = new Date(Date.UTC(2000, month - 1, day));
	at.setUTCFullYear(year, month - 1, day);
	if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
	return { year, month, day };
}

/** Whole years on the UTC−12 date. Born on 29 February, a year is complete on 1 March of a common year. */
export function ageOf(date: BirthDate, now = Date.now()): number {
	const today = new Date(now - UTC_MINUS_12_MS);
	const month = today.getUTCMonth() + 1;
	const before = month < date.month || (month === date.month && today.getUTCDate() < date.day);
	return today.getUTCFullYear() - date.year - (before ? 1 : 0);
}

/** A future date, or an age nobody signing in has: a typing mistake. */
export function isPlausible(date: BirthDate, now = Date.now()): boolean {
	const age = ageOf(date, now);
	return age >= MIN_PLAUSIBLE_AGE && age <= MAX_PLAUSIBLE_AGE;
}

const BANDS: readonly { band: AgeBand; from: number }[] = [
	{ band: '18_plus', from: 18 },
	{ band: '16_17', from: 16 },
	{ band: '13_15', from: MIN_ACCOUNT_AGE },
];

export function bandOf(date: BirthDate, now = Date.now()): AgeBand | null {
	const age = ageOf(date, now);
	return BANDS.find((b) => age >= b.from)?.band ?? null;
}

const ORDER: readonly (AgeBand | null)[] = [null, '13_15', '16_17', '18_plus'];

/** Whether going from one band to another makes the person older: never theirs to do (E20-D11). */
export function isOlderBand(from: AgeBand | null, to: AgeBand | null): boolean {
	return ORDER.indexOf(to) > ORDER.indexOf(from);
}
