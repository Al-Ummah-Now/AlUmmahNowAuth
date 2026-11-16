import { useEffect, useId, useState } from "react";
import { Languages, Undo2 } from "lucide-react";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { missingLabel, missingLangs, type Lang, type LocalizedPairValue } from "../../../../packages/ui/src/l10n/localized";

/**
 * A staff-set text in English and Arabic (owner rule 2026-11-16): both are
 * required, there is no "leave empty to use the other" fallback.
 *
 * - Two labelled fields, each with its own lang/dir.
 * - Optional Translate buttons fill one language from the other. The result
 *   stays editable; replacing text already there offers Undo (no browser prompt).
 * - Errors are tied to their field (aria-invalid + aria-describedby); status
 *   messages go to an aria-live region.
 * - `flagMissing` shows "Arabic missing" / "English missing" badges for legacy
 *   values (an Arabic field with no Arabic letters counts as missing).
 */
export type TranslateFn = (text: string, from: Lang, to: Lang) => Promise<string>;

export interface LocalizedPairProps {
  label: string;
  value: LocalizedPairValue;
  onChange: (value: LocalizedPairValue) => void;
  /** Form field names (e.g. { en: "name", ar: "name_ar" }) for plain form posts. */
  names?: { en: string; ar: string };
  errors?: Partial<Record<Lang, string>>;
  hint?: string;
  placeholder?: Partial<Record<Lang, string>>;
  disabled?: boolean;
  required?: boolean;
  flagMissing?: boolean;
  /** When given, Translate buttons appear (hidden when translation isn't set up). */
  translate?: TranslateFn;
  /** Admin UI language for the missing-language badges. */
  uiLang?: Lang;
  /** Called on blur of either field (forms that save on blur). */
  onBlur?: (value: LocalizedPairValue) => void;
  className?: string;
}

const FIELD: Record<Lang, { label: string; dir: "ltr" | "rtl" }> = {
  en: { label: "English", dir: "ltr" },
  ar: { label: "العربية", dir: "rtl" },
};

/** Translate copy in the admin's UI language. */
const COPY = {
  en: {
    to: { en: "Translate to Arabic", ar: "Translate to English" } as Record<Lang, string>,
    busy: "Translating…",
    translating: (to: Lang) => `Translating to ${to === "ar" ? "Arabic" : "English"}…`,
    filled: (to: Lang, from: Lang) => `${to === "ar" ? "Arabic" : "English"} filled from ${from === "en" ? "English" : "Arabic"}. Check it before saving.`,
    empty: "The translation came back empty",
    failed: (m: string) => `Couldn't translate: ${m}`,
    retry: "try again",
    restored: (l: Lang) => `${l === "ar" ? "Arabic" : "English"} text restored.`,
    undo: "Undo",
  },
  ar: {
    to: { en: "ترجم إلى العربية", ar: "ترجم إلى الإنجليزية" } as Record<Lang, string>,
    busy: "جارٍ الترجمة…",
    translating: (to: Lang) => `جارٍ الترجمة إلى ${to === "ar" ? "العربية" : "الإنجليزية"}…`,
    filled: (to: Lang, from: Lang) => `مُلئت ${to === "ar" ? "العربية" : "الإنجليزية"} من ${from === "en" ? "الإنجليزية" : "العربية"}. راجعها قبل الحفظ.`,
    empty: "عادت الترجمة فارغة",
    failed: (m: string) => `تعذّرت الترجمة: ${m}`,
    retry: "حاول مرة أخرى",
    restored: (l: Lang) => `استُعيد النص ${l === "ar" ? "العربي" : "الإنجليزي"}.`,
    undo: "تراجع",
  },
};

const other = (l: Lang): Lang => (l === "en" ? "ar" : "en");

export function LocalizedPair(props: LocalizedPairProps) {
  const { label, value, onChange, errors, hint, disabled, required, flagMissing, translate, onBlur, names, placeholder, className, uiLang } = props;
  const id = useId();
  const [busy, setBusy] = useState<Lang | null>(null);
  const [status, setStatus] = useState("");
  const [undo, setUndo] = useState<{ lang: Lang; previous: string } | null>(null);
  const missing = flagMissing ? missingLangs(value) : [];
  const t = COPY[uiLang ?? "en"];
  // A field's error hides once it is edited to non-empty text; it shows again if the
  // field is emptied or the next save reports a different message.
  const [edited, setEdited] = useState<Partial<Record<Lang, boolean>>>({});
  useEffect(() => setEdited({}), [errors?.en, errors?.ar]);

  async function run(from: Lang) {
    if (!translate) return;
    const to = other(from);
    const source = value[from].trim();
    if (!source) return;
    setBusy(from);
    setStatus(t.translating(to));
    try {
      const text = (await translate(source, from, to)).trim();
      if (!text) throw new Error(t.empty);
      const previous = value[to];
      onChange({ ...value, [to]: text });
      setEdited((m) => ({ ...m, [to]: true }));
      setUndo(previous.trim() && previous !== text ? { lang: to, previous } : null);
      setStatus(t.filled(to, from));
    } catch (e) {
      setStatus(t.failed(e instanceof Error ? e.message : t.retry));
    } finally {
      setBusy(null);
    }
  }

  function doUndo() {
    if (!undo) return;
    onChange({ ...value, [undo.lang]: undo.previous });
    setStatus(t.restored(undo.lang));
    setUndo(null);
  }

  return (
    <fieldset className={cn("space-y-2", className)} disabled={disabled}>
      <legend className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </span>
        {missing.map((l) => (
          <Badge key={l} variant="outline" data-testid={`missing-${l}`} className="border-[var(--color-warning-text)] text-[var(--color-warning-text)]">
            {missingLabel(l, uiLang)}
          </Badge>
        ))}
      </legend>
      {hint && <p className="text-xs text-[var(--color-muted-foreground)]">{hint}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {(["en", "ar"] as const).map((lang) => {
          const fid = `${id}-${lang}`;
          const err = edited[lang] && value[lang].trim() ? undefined : errors?.[lang];
          return (
            <div key={lang} className="space-y-1">
              <label htmlFor={fid} className="text-xs font-medium text-[var(--color-muted-foreground)]" lang={lang}>
                {FIELD[lang].label}
              </label>
              <Input
                id={fid}
                name={names?.[lang]}
                lang={lang}
                dir={FIELD[lang].dir}
                value={value[lang]}
                placeholder={placeholder?.[lang]}
                required={required}
                aria-required={required || undefined}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? `${fid}-error` : undefined}
                onChange={(e) => {
                  setEdited((m) => (m[lang] ? m : { ...m, [lang]: true }));
                  onChange({ ...value, [lang]: e.target.value });
                }}
                onBlur={() => onBlur?.(value)}
              />
              {err && (
                <p id={`${fid}-error`} className="text-xs text-[var(--color-destructive-text)]">
                  {err}
                </p>
              )}
              {translate && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={disabled || busy !== null || !value[lang].trim()}
                  onClick={() => run(lang)}
                >
                  <Languages className="me-1 h-3 w-3" aria-hidden="true" />
                  {busy === lang ? t.busy : t.to[lang]}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex min-h-5 items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span role="status" aria-live="polite">
          {status}
        </span>
        {undo && (
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" onClick={doUndo}>
            <Undo2 className="me-1 h-3 w-3" aria-hidden="true" />
            {t.undo}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
