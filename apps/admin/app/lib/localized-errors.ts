import type { Lang, LocalizedPairValue } from "../../../../packages/ui/src/l10n/localized";

/** Save-time errors for a pair: both languages are required. */
export function pairErrors(value: LocalizedPairValue, what = "this"): Partial<Record<Lang, string>> | undefined {
  const e: Partial<Record<Lang, string>> = {};
  if (!value.en.trim()) e.en = `Enter the English ${what}`;
  if (!value.ar.trim()) e.ar = `Enter the Arabic ${what}`;
  return e.en || e.ar ? e : undefined;
}
