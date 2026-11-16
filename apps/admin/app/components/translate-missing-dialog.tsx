import { useEffect, useId, useState } from "react";
import { Languages, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import type { Lang } from "../../../../packages/ui/src/l10n/localized";
import { translateAll, translateMessage, type TranslateFieldName, type TranslateItem } from "../lib/translate-client";

/**
 * "Translate missing" (L10N rule): fills the missing language of the listed
 * rows from the other one, then shows every suggestion for review. Nothing is
 * saved until the admin presses Save; only the ticked rows are saved, and each
 * stays editable. Quran text comes back refused and is never filled.
 */
export interface MissingRow {
  id: string;
  /** What the admin knows the row by (the English name, usually). */
  label: string;
  /** The text to translate from (the language that is there). */
  source: string;
  /** The current value of the missing language (legacy rows may hold a copy of the other). */
  current: string;
}

export interface ReviewedRow {
  id: string;
  text: string;
}

const COPY = {
  en: {
    title: (to: Lang) => `Translate missing ${to === "ar" ? "Arabic" : "English"}`,
    description: "Machine suggestions. Check and edit each one; only the ticked rows are saved.",
    translating: (n: number) => `Translating ${n} name${n === 1 ? "" : "s"}…`,
    done: (n: number, refused: number) => `${n} suggestion${n === 1 ? "" : "s"} ready to review${refused ? `, ${refused} not translated` : ""}.`,
    now: "Now:",
    include: (label: string) => `Save ${label}`,
    cancel: "Cancel",
    save: (n: number) => `Save ${n} reviewed`,
    saving: "Saving…",
    retry: "Try again",
    to: (to: Lang) => (to === "ar" ? "Arabic" : "English"),
  },
  ar: {
    title: (to: Lang) => `ترجمة ${to === "ar" ? "العربية" : "الإنجليزية"} الناقصة`,
    description: "اقتراحات آلية. راجع كلًّا منها وعدّله؛ لا يُحفظ إلا ما حدّدته.",
    translating: (n: number) => `جارٍ ترجمة ${n.toLocaleString("ar-EG-u-nu-arab")}…`,
    done: (n: number, refused: number) => `${n.toLocaleString("ar-EG-u-nu-arab")} اقتراحًا جاهزًا للمراجعة${refused ? `، و${refused.toLocaleString("ar-EG-u-nu-arab")} لم تُترجم` : ""}.`,
    now: "الآن:",
    include: (label: string) => `احفظ ${label}`,
    cancel: "إلغاء",
    save: (n: number) => `احفظ ${n.toLocaleString("ar-EG-u-nu-arab")} بعد المراجعة`,
    saving: "جارٍ الحفظ…",
    retry: "حاول مرة أخرى",
    to: (to: Lang) => (to === "ar" ? "العربية" : "الإنجليزية"),
  },
};

type State = { phase: "translating" } | { phase: "error"; message: string } | { phase: "review"; items: TranslateItem[] };

export function TranslateMissingDialog({
  open,
  onOpenChange,
  rows,
  to,
  field,
  uiLang = "en",
  saving,
  error,
  onSave,
  translator = translateAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: MissingRow[];
  to: Lang;
  field: TranslateFieldName;
  uiLang?: Lang;
  saving?: boolean;
  /** A save error from the page (shown above the buttons). */
  error?: string | null;
  onSave: (rows: ReviewedRow[]) => void;
  /** Tests swap the network call. */
  translator?: typeof translateAll;
}) {
  const t = COPY[uiLang];
  const from: Lang = to === "ar" ? "en" : "ar";
  const id = useId();
  const [state, setState] = useState<State>({ phase: "translating" });
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ phase: "translating" });
    translator(field, from, to, rows.map((r) => r.source), uiLang)
      .then((items) => {
        if (!live) return;
        const nextTexts: Record<string, string> = {};
        const nextInclude: Record<string, boolean> = {};
        rows.forEach((r, i) => {
          const item = items[i];
          nextTexts[r.id] = item && !item.refused ? item.text.trim() : "";
          nextInclude[r.id] = !!nextTexts[r.id];
        });
        setTexts(nextTexts);
        setInclude(nextInclude);
        setState({ phase: "review", items });
      })
      .catch((e: unknown) => live && setState({ phase: "error", message: e instanceof Error ? e.message : translateMessage("translation_failed", uiLang) }));
    return () => {
      live = false;
    };
    // rows are fixed while the dialog is open; a new attempt re-runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt]);

  const chosen = rows.filter((r) => include[r.id] && texts[r.id]?.trim());
  const refused = state.phase === "review" ? state.items.filter((i) => i.refused).length : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" dir={uiLang === "ar" ? "rtl" : "ltr"} lang={uiLang}>
        <DialogHeader>
          <DialogTitle>{t.title(to)}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-muted-foreground)]">
          {state.phase === "translating" ? t.translating(rows.length) : state.phase === "review" ? t.done(rows.length - refused, refused) : ""}
        </p>
        {state.phase === "translating" && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--color-muted-foreground)]" aria-hidden="true" />
          </div>
        )}
        {state.phase === "error" && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-[var(--color-destructive-text)]">{state.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              <Languages className="me-1 h-4 w-4" aria-hidden="true" />
              {t.retry}
            </Button>
          </div>
        )}
        {state.phase === "review" && (
          <ul className="max-h-[55vh] space-y-3 overflow-y-auto pe-1" data-testid="translate-missing-review">
            {rows.map((r, i) => {
              const item = state.items[i];
              const fid = `${id}-${r.id}`;
              return (
                <li key={r.id} className="rounded-lg border border-[var(--color-border)] p-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-2 h-4 w-4 accent-[var(--color-primary)]"
                      aria-label={t.include(r.label)}
                      checked={!!include[r.id]}
                      disabled={!!item?.refused || !texts[r.id]?.trim()}
                      onChange={(e) => setInclude((m) => ({ ...m, [r.id]: e.target.checked }))}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <label htmlFor={fid} className="block text-sm font-medium">
                        <span lang={from} dir={from === "ar" ? "rtl" : "ltr"}>{r.source}</span>
                        <span className="text-[var(--color-muted-foreground)]"> → {t.to(to)}</span>
                      </label>
                      <Input
                        id={fid}
                        lang={to}
                        dir={to === "ar" ? "rtl" : "ltr"}
                        value={texts[r.id] ?? ""}
                        disabled={!!item?.refused}
                        aria-invalid={item?.refused ? true : undefined}
                        aria-describedby={item?.refused ? `${fid}-refused` : undefined}
                        onChange={(e) => {
                          const v = e.target.value;
                          setTexts((m) => ({ ...m, [r.id]: v }));
                          setInclude((m) => ({ ...m, [r.id]: !!v.trim() }));
                        }}
                      />
                      {item?.refused && (
                        <p id={`${fid}-refused`} className="text-xs text-[var(--color-destructive-text)]">
                          {translateMessage(item.refused, uiLang)}
                        </p>
                      )}
                      {r.current.trim() && (
                        <div className="text-xs text-[var(--color-muted-foreground)]">
                          {t.now}{" "}
                          <Badge variant="outline" className="font-normal">
                            <span lang={to}>{r.current}</span>
                          </Badge>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-[var(--color-destructive-text)]">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button
            type="button"
            disabled={state.phase !== "review" || !chosen.length || saving}
            onClick={() => onSave(chosen.map((r) => ({ id: r.id, text: texts[r.id]!.trim() })))}
          >
            {saving ? t.saving : t.save(chosen.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
