/**
 * Dates on the admin's English pages, through the shared formatter (packages/ui/src/format.ts).
 * The English tag is fixed ('en-US', what the server printed before) so the server render and
 * every browser agree; Arabic pages format with Eastern Arabic (Hindi) numerals ٠–٩.
 */
import { formatDate as formatShared, NUMERIC_DATE, NUMERIC_DATE_TIME, type Lang } from '../../../../packages/ui/src/format.ts';

const toDateValue = (value: string | number) => (typeof value === 'number' ? new Date(value * 1000) : new Date(value));

/**
 * Formats a date value that can be either an ISO string or Unix timestamp
 * @param dateValue - ISO string or Unix timestamp (in seconds)
 * @returns Formatted date string
 */
export function formatDate(dateValue: string | number, lang: Lang = 'en'): string {
  return formatShared(toDateValue(dateValue), lang, NUMERIC_DATE, 'en-US');
}

/** A date and time (ISO string, or Unix seconds when a number), numeric like `toLocaleString()`. */
export function formatDateTime(dateValue: string | number, lang: Lang = 'en'): string {
  return formatShared(toDateValue(dateValue), lang, NUMERIC_DATE_TIME, 'en-US');
}

/** A date and time from epoch milliseconds or an ISO string. */
export function formatDateTimeMs(value: string | number, lang: Lang = 'en'): string {
  return formatShared(value, lang, NUMERIC_DATE_TIME, 'en-US');
}

/** A date from epoch milliseconds or an ISO string. */
export function formatDateMs(value: string | number, lang: Lang = 'en'): string {
  return formatShared(value, lang, NUMERIC_DATE, 'en-US');
}
