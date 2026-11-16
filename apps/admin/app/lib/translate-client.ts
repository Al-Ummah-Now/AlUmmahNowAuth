/**
 * Browser side of Translate: calls this site's own /api/translate (session
 * cookie, no secret). The server forwards to AlUmmahNow admin-api
 * (lib/translate.server.ts). A suggestion only fills the form; the admin
 * checks it and saves.
 */
import type { Lang } from "../../../../packages/ui/src/l10n/localized";
import type { TranslateFn } from "../components/localized-pair";

export type TranslateFieldName = "clients.name" | "themes.name" | "themes.description" | "themes.title";

export interface TranslateItem {
  text: string;
  refused?: "quran";
  quran?: Array<{ range: string; label: string }>;
}

/** Texts per request, as admin-api allows. */
export const TRANSLATE_PAGE = 50;

const MESSAGES: Record<string, { en: string; ar: string }> = {
  quran: {
    en: "This is Quran text, which is never machine-translated. Paste the official text instead.",
    ar: "هذا نص قرآني، ولا يُترجم آليًا. الصق النص الرسمي بدلًا من ذلك.",
  },
  daily_limit: { en: "You've reached today's translation limit. Try again tomorrow.", ar: "بلغتَ حدّ الترجمة لهذا اليوم. حاول غدًا." },
  translation_paused: { en: "Translation is paused right now.", ar: "الترجمة متوقفة الآن." },
  budget_exhausted: { en: "Translation is paused right now.", ar: "الترجمة متوقفة الآن." },
  forbidden: { en: "Your role can't use Translate.", ar: "دورك لا يسمح باستخدام الترجمة." },
  too_much_text: { en: "Too much text to translate at once.", ar: "النص أطول من أن يُترجم دفعة واحدة." },
  text_too_long: { en: "This text is too long to translate.", ar: "هذا النص أطول من أن يُترجم." },
  default: { en: "Translation didn't work. Try again.", ar: "لم تنجح الترجمة. حاول مرة أخرى." },
};

export function translateMessage(code: string, lang: Lang = "en"): string {
  return (MESSAGES[code] ?? (code === "daily_cap" || code === "rate_limited" ? MESSAGES.daily_limit : MESSAGES.default))[lang];
}

export class TranslateError extends Error {
  constructor(public code: string, lang: Lang = "en") {
    super(translateMessage(code, lang));
  }
}

/** Translates up to TRANSLATE_PAGE texts in one request. */
export async function translateTexts(field: TranslateFieldName, from: Lang, to: Lang, texts: string[], uiLang: Lang = "en", fetcher: typeof fetch = fetch): Promise<TranslateItem[]> {
  let res: Response;
  try {
    res = await fetcher("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ field, from, to, texts }),
    });
  } catch {
    throw new TranslateError("unavailable", uiLang);
  }
  const body = (await res.json().catch(() => null)) as { items?: TranslateItem[]; error?: string } | null;
  if (!res.ok || !body?.items) throw new TranslateError(body?.error ?? "translation_failed", uiLang);
  return body.items;
}

/** Many texts, a page at a time (the "Translate missing" batch). */
export async function translateAll(field: TranslateFieldName, from: Lang, to: Lang, texts: string[], uiLang: Lang = "en", fetcher: typeof fetch = fetch): Promise<TranslateItem[]> {
  const out: TranslateItem[] = [];
  for (let i = 0; i < texts.length; i += TRANSLATE_PAGE) {
    out.push(...(await translateTexts(field, from, to, texts.slice(i, i + TRANSLATE_PAGE), uiLang, fetcher)));
  }
  return out;
}

/** The `translate` prop of a LocalizedPair for one field; undefined when Translate is off. */
export function fieldTranslator(enabled: boolean | undefined, field: TranslateFieldName, uiLang: Lang = "en"): TranslateFn | undefined {
  if (!enabled) return undefined;
  return async (text, from, to) => {
    const [item] = await translateTexts(field, from, to, [text], uiLang);
    if (!item) throw new TranslateError("translation_failed", uiLang);
    if (item.refused) throw new TranslateError(item.refused, uiLang);
    return item.text;
  };
}
