import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Download, Monitor, Moon, Smartphone, Star, Sun, Upload } from "lucide-react";
import { AdminLayout } from "../components/admin-layout";
import { ConfirmDialog } from "../components/confirm-dialog";
import { confirmCopy, dirOf, langOf } from "../lib/confirm-copy";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { getAuthenticatedUser } from "../lib/auth.server";
import { getAuthServerUrl } from "../lib/config";
import { errorMessage, themeActor, themesApi, type ThemeDetail, type ThemeEnv } from "../lib/themes.server";
import {
  FONT_CHOICES,
  fontChoiceOf,
  getPath,
  googleFontsUrl,
  gradientCss,
  HEX,
  parseGradient,
  parseShadow,
  pickerHex,
  getSlot,
  sectionPath,
  setPath,
  setSlot,
  shadowCss,
  withUpload,
  type Gradient,
  type Mode,
  type Shadow,
} from "../lib/theme-builder";
import { AUTH_RADII, SECTIONS, type SlotDef } from "../../../../packages/ui/src/auth-theme/catalog.ts";
import type { AuthThemeJson, SchemeValue } from "../../../../packages/ui/src/auth-theme/types.ts";
import { validateTheme } from "../../../../packages/ui/src/auth-theme/validate.ts";
import { BASE } from "../../../../packages/ui/src/theme-packages/base.generated.ts";
import { COMPONENT_PARTS } from "../../../../packages/ui/src/theme-packages/components.ts";
import type { Issue } from "../../../../packages/ui/src/theme-packages/validate.ts";
import { getCloudflare } from "../lib/cloudflare-context";
import { formatNumber, formatPercent } from "../../../../packages/ui/src/format.ts";
import { adminCopy, catalogLabel, pageTitle, THEME_TABS, type PreviewPage, type ThemeTab } from "../lib/admin-copy";
import { withLang } from "../lib/shell-copy";

export const meta: MetaFunction<typeof loader> = ({ loaderData, location }) => {
  const lang = langOf(location.search);
  const name = loaderData?.detail?.theme.name;
  return [{ title: pageTitle("themes", lang, (name && (name[lang] || name.en)) || adminCopy(lang).theme.fallbackName) }];
};

type LoaderData = {
  detail: ThemeDetail;
  user: { id: string; email: string };
  authServerUrl: string;
};

export async function loader({ request, context, params }: LoaderFunctionArgs): Promise<LoaderData> {
  const env = getCloudflare(context).env as ThemeEnv;
  const actor = await themeActor(request, env);
  const session = await getAuthenticatedUser(request, env);
  try {
    const detail = await themesApi(env, actor, request).get(params.id!);
    return { detail, user: { id: actor.id, email: session?.user.email ?? actor.email }, authServerUrl: getAuthServerUrl(request, env) };
  } catch (error) {
    throw new Response(errorMessage(error), { status: (error as { status?: number }).status === 404 ? 404 : 502 });
  }
}

type ActionData = { ok?: string; error?: string; details?: Issue[]; contrast?: Issue[]; uploaded?: { path: string; target?: string } };

export async function action({ request, context, params }: ActionFunctionArgs): Promise<ActionData> {
  const env = getCloudflare(context).env as ThemeEnv;
  const actor = await themeActor(request, env);
  const api = themesApi(env, actor, request);
  const id = params.id!;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const words = adminCopy(langOf(new URL(request.url).search));
  try {
    if (intent === "save" || intent === "publish") {
      const raw = form.get("theme");
      if (typeof raw === "string") {
        const saved = await api.saveDraft(id, JSON.parse(raw));
        if (intent === "save") return { ok: words.theme.draftSaved, contrast: saved.contrast };
      }
      const published = await api.publish(id);
      return { ok: words.theme.published(String(published.version)) };
    }
    if (intent === "set-default") {
      await api.setAuthDefault(id);
      return { ok: words.theme.nowDefault };
    }
    if (intent === "upload") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) return { error: words.theme.chooseFile };
      const name = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "file";
      const path = name.endsWith(".woff2") ? `assets/fonts/${name}` : `assets/${name}`;
      await api.uploadAsset(id, path, await file.arrayBuffer(), file.type);
      return { ok: words.theme.uploaded(path), uploaded: { path, target: String(form.get("target") ?? "") || undefined } };
    }
    if (intent === "remove-asset") {
      await api.removeAsset(id, String(form.get("path")));
      return { ok: words.theme.fileRemoved };
    }
    return { error: words.common.unknownAction };
  } catch (error) {
    return { error: errorMessage(error), details: (error as { details?: Issue[] }).details };
  }
}

// ---------------------------------------------------------------- helpers

const PAGES: readonly PreviewPage[] = ["sign-in", "register", "code", "reset", "consent", "account-switcher", "profile"];

/** The theme builder's words in the page language (?lang=ar). */
function useWords() {
  const [searchParams] = useSearchParams();
  const lang = langOf(searchParams);
  return { lang, t: adminCopy(lang).theme, c: adminCopy(lang).common };
}

const DEVICES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;

const ROLE_GROUPS: ["surfaces" | "text" | "primary" | "rest", (role: { name: string; role: string }) => boolean][] = [
  ["surfaces", (r) => r.role === "surface"],
  ["text", (r) => r.role === "text"],
  ["primary", (r) => /^(on)?[pP]rimary/.test(r.name)],
  ["rest", (r) => r.role !== "surface" && r.role !== "text" && !/^(on)?[pP]rimary/.test(r.name)],
];

type Tab = ThemeTab;

const selectClass =
  "flex h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] disabled:opacity-60";
const muted = "text-[var(--color-muted-foreground)]";

// ---------------------------------------------------------------- controls

function ColorField({ theme, mode, value, onChange, disabled, label }: { theme: AuthThemeJson; mode: Mode; value: string | undefined; onChange: (v: string) => void; disabled: boolean; label: string }) {
  const { t, c } = useWords();
  const modeName = mode === "light" ? c.light : c.dark;
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        aria-label={`${label} (${modeName})`}
        value={pickerHex(theme, mode, value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-9 shrink-0 cursor-pointer rounded border border-[var(--color-border)] bg-transparent p-0.5 disabled:cursor-default"
      />
      <Input
        key={value ?? ""}
        defaultValue={value ?? ""}
        disabled={disabled}
        aria-label={t.colourValue(label, modeName)}
        dir="ltr"
        className="h-8 font-mono text-xs"
        onBlur={(e) => e.target.value !== (value ?? "") && onChange(e.target.value.trim().toLowerCase())}
      />
    </div>
  );
}

function TextField({ value, onChange, disabled, label, placeholder, dir }: { value: string | undefined; onChange: (v: string | undefined) => void; disabled: boolean; label: string; placeholder?: string; dir?: string }) {
  return (
    <Input
      key={value ?? ""}
      defaultValue={value ?? ""}
      disabled={disabled}
      aria-label={label}
      placeholder={placeholder}
      dir={dir}
      className="h-8 text-sm"
      onBlur={(e) => {
        const text = e.target.value.trim();
        if (text !== (value ?? "")) onChange(text === "" ? undefined : text);
      }}
    />
  );
}

function GradientEditor({ value, onChange, disabled }: { value: string | undefined; onChange: (v: string) => void; disabled: boolean }) {
  const g: Gradient = parseGradient(value) ?? { angle: 180, stops: [{ color: "#f4ae3a", at: 0 }, { color: "#e0962a", at: 100 }] };
  const update = (next: Gradient) => onChange(gradientCss(next));
  const { lang, t } = useWords();
  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-2">
      <div className="h-6 rounded" style={{ background: gradientCss({ ...g, stops: g.stops.map((s) => ({ ...s, color: HEX.test(s.color) ? s.color : "#888888" })) }) }} />
      <div className="flex items-center gap-2 text-xs">
        <span className={muted}>{t.angle}</span>
        <input type="range" min={0} max={360} value={g.angle} disabled={disabled} onChange={(e) => update({ ...g, angle: Number(e.target.value) })} className="flex-1" aria-label={t.gradientAngle} />
        <span className="w-10 text-end">{formatNumber(g.angle, lang)}°</span>
      </div>
      {g.stops.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <input
            type="color"
            value={HEX.test(s.color) ? s.color : "#888888"}
            disabled={disabled}
            aria-label={t.stopColour(i + 1)}
            onChange={(e) => update({ ...g, stops: g.stops.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })}
            className="h-7 w-8 rounded border border-[var(--color-border)] bg-transparent p-0.5"
          />
          <input type="range" min={0} max={100} value={s.at} disabled={disabled} aria-label={t.stopPosition(i + 1)} onChange={(e) => update({ ...g, stops: g.stops.map((x, j) => (j === i ? { ...x, at: Number(e.target.value) } : x)) })} className="flex-1" />
          <span className="w-10 text-end">{formatPercent(s.at / 100, lang)}</span>
          {g.stops.length > 2 && (
            <button type="button" className="text-[var(--color-destructive-text)]" disabled={disabled} onClick={() => update({ ...g, stops: g.stops.filter((_, j) => j !== i) })} aria-label={t.removeStop(i + 1)}>×</button>
          )}
        </div>
      ))}
      {g.stops.length < 5 && (
        <button type="button" disabled={disabled} className="text-xs underline" onClick={() => update({ ...g, stops: [...g.stops, { color: "#ffffff", at: 100 }] })}>{t.addStop}</button>
      )}
    </div>
  );
}

function ShadowEditor({ value, onChange, disabled }: { value: string | undefined; onChange: (v: string) => void; disabled: boolean }) {
  const s: Shadow = parseShadow(value) ?? { x: 0, y: 12, blur: 32, spread: 0, color: "#000000", alpha: 0.28 };
  const update = (patch: Partial<Shadow>) => onChange(shadowCss({ ...s, ...patch }));
  const { lang, t } = useWords();
  const num = (key: "x" | "y" | "blur" | "spread", min: number, max: number) => (
    <label className="flex items-center gap-2 text-xs">
      <span className={`w-12 ${muted}`}>{t.shadow[key]}</span>
      <input type="range" min={min} max={max} value={s[key]} disabled={disabled} onChange={(e) => update({ [key]: Number(e.target.value) })} className="flex-1" />
      <span className="w-10 text-end" dir="ltr">{formatNumber(s[key], lang)}px</span>
    </label>
  );
  return (
    <div className="space-y-1.5 rounded-md border border-[var(--color-border)] p-2">
      <div className="mx-auto my-2 h-8 w-24 rounded-md bg-[var(--color-card)]" style={{ boxShadow: shadowCss(s) }} />
      {num("x", -40, 40)}
      {num("y", -40, 60)}
      {num("blur", 0, 100)}
      {num("spread", -20, 40)}
      <label className="flex items-center gap-2 text-xs">
        <span className={`w-12 ${muted}`}>{t.shadow.color}</span>
        <input type="color" value={s.color} disabled={disabled} onChange={(e) => update({ color: e.target.value })} className="h-7 w-8 rounded border border-[var(--color-border)] bg-transparent p-0.5" />
        <input type="range" min={0} max={100} value={Math.round(s.alpha * 100)} disabled={disabled} onChange={(e) => update({ alpha: Number(e.target.value) / 100 })} className="flex-1" aria-label={t.shadowOpacity} />
        <span className="w-10 text-end">{formatPercent(Math.round(s.alpha * 100) / 100, lang)}</span>
      </label>
    </div>
  );
}

function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-warning-text)]">
      {issues.map((i, n) => (
        <li key={n} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> <span dir="ltr" lang="en">{i.message}</span></li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- slot editor

function SlotEditor({ theme, sectionId, slot, onTheme, disabled, assetUrls }: { theme: AuthThemeJson; sectionId: string; slot: SlotDef; onTheme: (t: AuthThemeJson) => void; disabled: boolean; assetUrls: Record<string, string> }) {
  const raw = getSlot(theme, sectionId, slot.key);
  const { lang, t, c } = useWords();
  const slotLabel = catalogLabel(slot.label, lang);
  const perMode = !!raw && typeof raw === "object";
  const canSplit = !(sectionPath(sectionId, slot.key) && sectionPath(sectionId, slot.key) !== "signIn.background");
  const [tool, setTool] = useState<"text" | "gradient" | "shadow">(slot.kind === "shadow" && parseShadow(typeof raw === "string" ? raw : raw?.light) ? "shadow" : slot.kind === "paint" && parseGradient(typeof raw === "string" ? raw : raw?.light) ? "gradient" : "text");
  const set = (mode: Mode | null, v: string | undefined) => {
    let next: SchemeValue | undefined;
    if (mode === null) next = v;
    else {
      const cur = typeof raw === "object" && raw ? raw : { light: raw ?? "", dark: raw ?? "" };
      next = { ...cur, [mode]: v ?? "" };
    }
    onTheme(setSlot(theme, sectionId, slot.key, next));
  };
  const field = (mode: Mode | null) => {
    const v = mode === null ? (typeof raw === "string" ? raw : undefined) : typeof raw === "object" && raw ? raw[mode] : (raw as string | undefined);
    const m: Mode = mode ?? "light";
    if (slot.kind === "color") return <ColorField theme={theme} mode={m} value={v} onChange={(x) => set(mode, x)} disabled={disabled} label={slotLabel} />;
    if (slot.kind === "display")
      return (
        <select className={selectClass} value={v ?? ""} disabled={disabled} onChange={(e) => set(mode, e.target.value || undefined)} aria-label={slotLabel}>
          <option value="">{t.asBase}</option>
          <option value="block">{t.shown}</option>
          <option value="none">{t.hidden}</option>
        </select>
      );
    if (slot.kind === "font")
      return (
        <select className={selectClass} value={v ?? ""} disabled={disabled} aria-label={slotLabel} onChange={(e) => set(mode, e.target.value || undefined)}>
          <option value="">{t.asPageText}</option>
          {FONT_CHOICES.map((f) => {
            const css = f.stack.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(", ");
            return <option key={f.label} value={css}>{f.label}{f.arabic ? "" : t.latinOnly}</option>;
          })}
          {v && !FONT_CHOICES.some((f) => f.stack.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(", ") === v) && <option value={v}>{v}</option>}
        </select>
      );
    if (slot.kind === "image")
      return (
        <select className={selectClass} value={v ?? ""} disabled={disabled} aria-label={slotLabel} onChange={(e) => set(mode, e.target.value || undefined)}>
          <option value="">{t.asBase}</option>
          <option value="none">{t.noImage}</option>
          {Object.keys(assetUrls).filter((p) => !p.endsWith(".woff2") && !p.endsWith(".ico")).map((p) => (
            <option key={p} value={`{asset:${p}}`}>{p.replace(/^assets\//, "")}</option>
          ))}
        </select>
      );
    if (tool === "gradient") return <GradientEditor value={v} onChange={(x) => set(mode, x)} disabled={disabled} />;
    if (tool === "shadow") return <ShadowEditor value={v} onChange={(x) => set(mode, x)} disabled={disabled} />;
    return (
      <div className="flex items-center gap-1.5">
        {slot.kind === "paint" && (
          <input
            type="color"
            aria-label={`${slotLabel} (${m === "light" ? c.light : c.dark})`}
            value={pickerHex(theme, m, v)}
            disabled={disabled}
            onChange={(e) => set(mode, e.target.value)}
            className="h-8 w-9 shrink-0 rounded border border-[var(--color-border)] bg-transparent p-0.5"
          />
        )}
        <TextField value={v} onChange={(x) => set(mode, x)} disabled={disabled} dir="ltr" label={`${slotLabel} (${m === "light" ? c.light : c.dark})`} placeholder={slot.kind === "length" ? t.lengthPlaceholder.replace("12px", "16px") : t.cssPlaceholder} />
      </div>
    );
  };
  return (
    <div className="grid gap-2 border-b border-[var(--color-border)] py-3 last:border-0 md:grid-cols-[180px_1fr]">
      <div>
        <div className="text-sm font-medium">{slotLabel}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          {slot.kind === "paint" && (
            <button type="button" className="underline" disabled={disabled} onClick={() => setTool(tool === "gradient" ? "text" : "gradient")}>{tool === "gradient" ? t.plainValue : t.gradient}</button>
          )}
          {slot.kind === "shadow" && (
            <button type="button" className="underline" disabled={disabled} onClick={() => setTool(tool === "shadow" ? "text" : "shadow")}>{tool === "shadow" ? t.plainValue : t.shadowBuilder}</button>
          )}
          {canSplit && (
            <button type="button" className="underline" disabled={disabled} onClick={() => onTheme(setSlot(theme, sectionId, slot.key, perMode ? (raw as { light: string }).light : raw ? { light: raw as string, dark: raw as string } : undefined))}>
              {perMode ? t.oneValue : t.lightDark}
            </button>
          )}
          {raw !== undefined && (
            <button type="button" className="text-[var(--color-destructive-text)] underline" disabled={disabled} onClick={() => onTheme(setSlot(theme, sectionId, slot.key, undefined))}>{t.clear}</button>
          )}
        </div>
      </div>
      {perMode ? (
        <div className="grid grid-cols-2 gap-2">
          <div><div className={`mb-1 flex items-center gap-1 text-xs ${muted}`}><Sun className="h-3 w-3" /> {c.light}</div>{field("light")}</div>
          <div><div className={`mb-1 flex items-center gap-1 text-xs ${muted}`}><Moon className="h-3 w-3" /> {c.dark}</div>{field("dark")}</div>
        </div>
      ) : (
        field(null)
      )}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function ThemeBuilderPage() {
  const { detail, user, authServerUrl } = useLoaderData<LoaderData>();
  const { summary, assets, assetUrls } = detail;
  const readOnly = summary.kind === "builtin";
  const [theme, setTheme] = useState<AuthThemeJson>(detail.theme);
  const [dirty, setDirty] = useState(false);
  const [searchParams] = useSearchParams();
  const adminLang = langOf(searchParams);
  const copy = confirmCopy(adminLang);
  const t = adminCopy(adminLang).theme;
  const c = adminCopy(adminLang).common;
  const themesCopy = adminCopy(adminLang).themes;
  const [tab, setTab] = useState<Tab>("colours");
  const [page, setPage] = useState<PreviewPage>("sign-in");
  // The preview starts in the admin's language
  const [lang, setLang] = useState<"en" | "ar">(adminLang);
  const [scheme, setScheme] = useState<Mode>("light");
  const [device, setDevice] = useState<keyof typeof DEVICES>("desktop");
  const [section, setSection] = useState("base");
  const [componentSection, setComponentSection] = useState("input");
  const [preview, setPreview] = useState<{ html: string; error?: string }>({ html: "" });
  const [uploadTarget, setUploadTarget] = useState("");
  const saver = useFetcher<ActionData>();
  const uploader = useFetcher<ActionData>();
  const remover = useFetcher<ActionData>();
  const [removing, setRemoving] = useState<string | null>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(320);

  // New results from the server, handled while rendering (no effects):
  // a successful save or publish means nothing is unsaved; a reloaded theme
  // replaces the edited copy only when nothing is unsaved; an uploaded file
  // goes straight into the slot it was uploaded for.
  const [seen, setSeen] = useState({ detail: detail.theme, saved: saver.data, uploaded: uploader.data });
  if (seen.detail !== detail.theme || seen.saved !== saver.data || seen.uploaded !== uploader.data) {
    let next = theme;
    let nextDirty = dirty;
    if (seen.saved !== saver.data && saver.data?.ok) nextDirty = false;
    if (seen.detail !== detail.theme && !nextDirty) next = detail.theme;
    const up = seen.uploaded !== uploader.data ? uploader.data?.uploaded : undefined;
    if (up?.target) {
      next = withUpload(next, up.target, up.path);
      nextDirty = true;
    }
    setSeen({ detail: detail.theme, saved: saver.data, uploaded: uploader.data });
    if (next !== theme) setTheme(next);
    if (nextDirty !== dirty) setDirty(nextDirty);
  }

  const update = (next: AuthThemeJson) => {
    setTheme(next);
    setDirty(true);
  };

  const validation = useMemo(() => validateTheme(theme, { stored: assets }), [theme, assets]);
  const issuesAt = (prefix: string) => [...validation.errors, ...validation.contrast].filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));

  // Live preview: the real pages, rendered by Auth for the edited theme
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (validation.errors.length) {
        setPreview((p) => ({ ...p, error: t.fixToPreview }));
        return;
      }
      try {
        const res = await fetch(`/themes/${summary.id}/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: readOnly ? undefined : theme, themeId: summary.id, page, lang, scheme }),
          signal: controller.signal,
        });
        const html = await res.text();
        setPreview(res.ok ? { html } : { html: "", error: html || t.previewFailed(res.status) });
      } catch (error) {
        if ((error as Error).name !== "AbortError") setPreview((p) => ({ ...p, error: t.previewUnavailable }));
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // t: the words change only with the admin language (a new page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, page, lang, scheme, summary.id, readOnly, validation.errors.length]);

  useEffect(() => {
    const el = frameBox.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const save = (intent: "save" | "publish") => {
    const fd = new FormData();
    fd.set("intent", intent);
    if (dirty || intent === "save") fd.set("theme", JSON.stringify(theme));
    saver.submit(fd, { method: "post" });
  };

  const dev = DEVICES[device];
  const scale = Math.min(1, boxWidth / dev.width);
  const result = saver.data ?? uploader.data ?? remover.data;
  const contrastCount = validation.contrast.length;

  const colorRow = (role: { name: string }) => (
    <div key={role.name} className="grid grid-cols-2 items-start gap-2 border-b border-[var(--color-border)] py-2 last:border-0 md:grid-cols-[160px_1fr_1fr]">
      <div className="col-span-2 pt-1 text-sm md:col-span-1">
        <div className="font-medium">{t.colourRoles[role.name] ?? <code dir="ltr">{role.name}</code>}</div>
        {t.colourRoles[role.name] && <code className="text-xs text-[var(--color-muted-foreground)]" dir="ltr">{role.name}</code>}
      </div>
      {(["light", "dark"] as const).map((mode) => (
        <div key={mode}>
          <ColorField theme={theme} mode={mode} label={t.colourRoles[role.name] ?? role.name} disabled={readOnly} value={theme.tokens.color[mode][role.name]} onChange={(v) => update(setPath(theme, `tokens.color.${mode}.${role.name}`, v))} />
          <Issues issues={issuesAt(`tokens.color.${mode}.${role.name}`)} />
        </div>
      ))}
    </div>
  );

  const bodyFont = fontChoiceOf(theme.typography.body?.latin) ?? FONT_CHOICES[0];
  const arabicFont = fontChoiceOf(theme.typography.body?.arabic) ?? FONT_CHOICES[0];
  const setFonts = (latin: (typeof FONT_CHOICES)[number], arabic: (typeof FONT_CHOICES)[number]) => {
    let next = setPath(theme, "typography.body", { latin: latin.stack, arabic: arabic.stack });
    const headingFonts = SECTIONS.flatMap((s) => ["heading.font", "heading.fontAr", "title.font", "title.fontAr"].map((k) => getSlot(next, s.id, k))).filter(Boolean) as string[];
    const extra = FONT_CHOICES.filter((f) => headingFonts.some((h) => typeof h === "string" && h.includes(f.stack[0])));
    const url = googleFontsUrl([latin, arabic, ...extra]);
    next = setPath(next, "x-auth.fontImports", url ? [url] : undefined);
    update(next);
  };

  const imageSlot = (label: string, path: string, opts: { svgOnly?: boolean; perMode?: boolean; icoOk?: boolean } = {}) => {
    const value = getPath(theme, path) as string | { light: string; dark: string } | undefined;
    const files = Object.keys(assets).filter((p) => (opts.svgOnly ? p.endsWith(".svg") : !p.endsWith(".woff2") && (opts.icoOk || !p.endsWith(".ico"))));
    const current = typeof value === "object" ? value.light : value;
    return (
      <div className="grid items-center gap-2 border-b border-[var(--color-border)] py-2 last:border-0 sm:grid-cols-[180px_1fr_48px]">
        <Label>{label}</Label>
        <select
          className={selectClass}
          disabled={readOnly}
          value={current ?? ""}
          aria-label={label}
          onChange={(e) => update(setPath(theme, path, e.target.value ? (opts.perMode ? { light: e.target.value, dark: e.target.value } : e.target.value) : undefined))}
        >
          <option value="">{c.none}</option>
          {files.map((p) => <option key={p} value={p}>{p.replace(/^assets\//, "")}</option>)}
        </select>
        {current && assetUrls[current] ? <img src={assetUrls[current]} alt="" className="h-10 w-12 rounded border border-[var(--color-border)] object-contain" /> : <span />}
      </div>
    );
  };

  return (
    <AdminLayout user={user} authServerUrl={authServerUrl}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to={withLang("/themes", adminLang)} className={`mb-2 inline-flex items-center gap-1 text-sm ${muted} hover:underline`}><ArrowLeft className="h-4 w-4 rtl:-scale-x-100" /> {t.back}</Link>
          {adminLang === "ar" ? (
            <h2 className="text-3xl font-bold text-[var(--color-foreground)]">{theme.name.ar || theme.name.en}</h2>
          ) : (
            <h2 className="text-3xl font-bold text-[var(--color-foreground)]">{theme.name.en} <span className={`text-xl font-normal ${muted}`} dir="rtl" lang="ar">{theme.name.ar}</span></h2>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline">{readOnly ? themesCopy.builtIn : themesCopy.custom}</Badge>
            <Badge variant="outline"><span dir="ltr">v{theme.version}</span></Badge>
            {summary.isAuthDefault && <Badge><Star className="me-1 h-3 w-3" /> {themesCopy.authDefault}</Badge>}
            {summary.status === "changed" && <Badge variant="outline">{t.unpublished}</Badge>}
            {summary.status === "draft" && <Badge variant="outline">{t.notPublished}</Badge>}
            {dirty && <Badge variant="outline" className="border-[var(--color-warning-text)] text-[var(--color-warning-text)]">{t.unsaved}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="ghost"><a href={`/themes/${summary.id}/export?source=${summary.status === "draft" ? "draft" : "published"}`}><Download /> {themesCopy.export}</a></Button>
          {!summary.isAuthDefault && summary.status !== "draft" && !dirty && (
            <saver.Form method="post"><input type="hidden" name="intent" value="set-default" /><Button variant="outline" type="submit"><Star /> {themesCopy.makeDefault}</Button></saver.Form>
          )}
          {!readOnly && (
            <>
              <Button variant="outline" onClick={() => save("save")} disabled={saver.state !== "idle" || validation.errors.length > 0}>{t.saveDraft}</Button>
              <Button
                onClick={() => save("publish")}
                disabled={saver.state !== "idle" || validation.errors.length > 0 || contrastCount > 0 || (!dirty && summary.status === "published")}
                title={contrastCount ? t.fixContrastFirst : undefined}
              >
                <Check /> {t.publish}
              </Button>
            </>
          )}
        </div>
      </div>

      {readOnly && (
        <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-3 text-sm">
          {t.readOnlyNote} <Link to={withLang("/themes", adminLang)} className="underline">{t.duplicateIt}</Link> {t.readOnlyNoteEnd}
        </div>
      )}
      {result?.error && (
        <div role="alert" className="mb-4 rounded-lg ui-alert-error p-3 text-sm">
          {result.error}
          {!!result.details?.length && <ul className="mt-1 list-disc ps-5">{result.details.slice(0, 8).map((d, i) => <li key={i}><bdi dir="ltr" lang="en"><code>{d.path}</code>: {d.message}</bdi></li>)}</ul>}
        </div>
      )}
      {result?.ok && <div role="status" className="mb-4 rounded-lg ui-alert-success p-3 text-sm">{result.ok}</div>}
      {(validation.errors.length > 0 || contrastCount > 0) && (
        <div className="mb-4 rounded-lg ui-alert-warning p-3 text-sm" data-testid="theme-problems">
          {validation.errors.length > 0 && <p className="font-medium text-[var(--color-destructive-text)]">{t.problems(validation.errors.length)}</p>}
          {validation.errors.slice(0, 6).map((e, i) => <p key={i} className="text-[var(--color-destructive-text)]"><bdi dir="ltr" lang="en"><code>{e.path}</code>: {e.message}</bdi></p>)}
          {contrastCount > 0 && <p className="font-medium text-[var(--color-warning-text)]">{t.contrastProblems(contrastCount)}</p>}
          {validation.contrast.slice(0, 6).map((e, i) => <p key={i} className="text-[var(--color-warning-text)]"><bdi dir="ltr" lang="en"><code>{e.path}</code>: {e.message}</bdi></p>)}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* ------------------------------------------------ editor */}
        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label={t.tabsLabel}>
              {THEME_TABS.map((id) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${tab === id ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]" : "hover:bg-[var(--color-accent)]"}`}>
                  {t.tabs[id]}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <fieldset disabled={readOnly} className="min-w-0">
              {tab === "colours" && (
                <div>
                  <p className={`mb-3 text-sm ${muted}`}>{t.coloursIntro}</p>
                  {ROLE_GROUPS.map(([name, test]) => (
                    <details key={name} open={name !== "rest"} className="mb-3">
                      <summary className="cursor-pointer py-1 font-medium">{t.roleGroups[name]}</summary>
                      <div className={`grid grid-cols-2 gap-2 text-xs ${muted} md:grid-cols-[160px_1fr_1fr]`}><span className="hidden md:block" /><span className="flex items-center gap-1"><Sun className="h-3 w-3" /> {c.light}</span><span className="flex items-center gap-1"><Moon className="h-3 w-3" /> {c.dark}</span></div>
                      {BASE.roles.filter(test).map(colorRow)}
                    </details>
                  ))}
                  <details className="mb-3">
                    <summary className="cursor-pointer py-1 font-medium">{t.brandColours}</summary>
                    {Object.keys(theme.tokens.brand).map((b) => (
                      <div key={b} className="grid items-center gap-2 py-1 md:grid-cols-[160px_1fr]">
                        <code className="text-xs" dir="ltr">{b}</code>
                        <ColorField theme={theme} mode="light" label={b} disabled={readOnly} value={theme.tokens.brand[b]} onChange={(v) => update(setPath(theme, `tokens.brand.${b}`, v))} />
                      </div>
                    ))}
                  </details>
                </div>
              )}

              {tab === "components" && (
                <div>
                  <p className={`mb-3 text-sm ${muted}`}>{t.componentsIntro}</p>
                  <select className={`${selectClass} mb-3`} dir="ltr" value={componentSection} onChange={(e) => setComponentSection(e.target.value)} aria-label={t.component}>
                    {Object.keys(theme.components).map((c) => <option key={c} value={c}>{c}{COMPONENT_PARTS[c] ? ` (${COMPONENT_PARTS[c]})` : ""}</option>)}
                  </select>
                  {(() => {
                    const comp = theme.components[componentSection];
                    if (!comp) return null;
                    return (
                      <>
                        {comp.colors && (
                          <div className={`grid grid-cols-2 gap-2 text-xs ${muted} md:grid-cols-[140px_1fr_1fr]`}><span className="hidden md:block" /><span className="flex items-center gap-1"><Sun className="h-3 w-3" /> {c.light}</span><span className="flex items-center gap-1"><Moon className="h-3 w-3" /> {c.dark}</span></div>
                        )}
                        {comp.colors && Object.keys(comp.colors.light).map((part) => (
                          <div key={part} className="grid grid-cols-2 items-start gap-2 border-b border-[var(--color-border)] py-2 last:border-0 md:grid-cols-[140px_1fr_1fr]">
                            <code className="col-span-2 pt-1.5 text-xs md:col-span-1" dir="ltr">{part}</code>
                            {(["light", "dark"] as const).map((mode) => (
                              <div key={mode}>
                                <ColorField theme={theme} mode={mode} label={part} disabled={readOnly} value={comp.colors![mode][part]} onChange={(v) => update(setPath(theme, `components.${componentSection}.colors.${mode}.${part}`, v))} />
                                <Issues issues={issuesAt(`components.${componentSection}.colors.${mode}.${part}`)} />
                              </div>
                            ))}
                          </div>
                        ))}
                        {comp.style && Object.keys(comp.style).map((field) => (
                          <div key={field} className="grid items-start gap-2 border-b border-[var(--color-border)] py-2 last:border-0 md:grid-cols-[140px_1fr]">
                            <code className="pt-1.5 text-xs" dir="ltr">style.{field}</code>
                            <div className="space-y-2">
                              <TextField value={comp.style![field]} disabled={readOnly} dir="ltr" label={`style.${field}`} onChange={(v) => v && update(setPath(theme, `components.${componentSection}.style.${field}`, v))} />
                              {/gradient|background|hover|pressed/.test(field) && parseGradient(comp.style![field]) && (
                                <GradientEditor value={comp.style![field]} disabled={readOnly} onChange={(v) => update(setPath(theme, `components.${componentSection}.style.${field}`, v))} />
                              )}
                            </div>
                          </div>
                        ))}
                      </>
                    );
                  })()}
                </div>
              )}

              {tab === "pages" && (
                <div>
                  <p className={`mb-3 text-sm ${muted}`}>{t.pagesIntro} <code dir="ltr">{"{color.surface}"}</code>{c.sep}<code dir="ltr">{"{component.form.inputBg}"}</code></p>
                  <select
                    className={`${selectClass} mb-2`}
                    value={section}
                    aria-label={t.pageSection}
                    onChange={(e) => {
                      setSection(e.target.value);
                      const s = SECTIONS.find((x) => x.id === e.target.value);
                      const p = s?.pages?.[0];
                      if (p && p !== "base" && PAGES.some((id) => id === p)) setPage(p as PreviewPage);
                      if (s?.id === "profile") setPage("profile");
                    }}
                  >
                    {SECTIONS.map((s) => <option key={s.id} value={s.id}>{catalogLabel(s.label, adminLang)}</option>)}
                  </select>
                  {SECTIONS.find((s) => s.id === section)?.scope === "vars" && (
                    <p className={`mb-2 text-xs ${muted}`}>{t.varsNote(section === "profile")}</p>
                  )}
                  {SECTIONS.find((s) => s.id === section)?.slots.map((slot) => (
                    <SlotEditor key={`${section}:${slot.key}`} theme={theme} sectionId={section} slot={slot} onTheme={update} disabled={readOnly} assetUrls={assetUrls} />
                  ))}
                </div>
              )}

              {tab === "shape" && (
                <div className="space-y-6">
                  <section>
                    <h3 className="mb-2 font-medium">{t.fonts}</h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="font-latin">{t.pageText}</Label>
                        <select id="font-latin" className={selectClass} value={bodyFont.label} onChange={(e) => setFonts(FONT_CHOICES.find((f) => f.label === e.target.value)!, arabicFont)}>
                          {FONT_CHOICES.map((f) => <option key={f.label}>{f.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="font-arabic">{t.arabicPages}</Label>
                        <select id="font-arabic" className={selectClass} value={arabicFont.label} onChange={(e) => setFonts(bodyFont, FONT_CHOICES.find((f) => f.label === e.target.value)!)}>
                          {FONT_CHOICES.filter((f) => f.arabic).map((f) => <option key={f.label}>{f.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <p className={`mt-2 text-sm ${muted}`} style={{ fontFamily: bodyFont.stack.join(",") }}><span dir="ltr" lang="en">{t.sample}</span>{c.sep}<span dir="rtl" lang="ar" style={{ fontFamily: arabicFont.stack.join(",") }}>مرحبا بكم في الأمة الآن</span></p>
                    <p className={`mt-1 text-xs ${muted}`}>{t.fontsNote}</p>
                  </section>
                  <section>
                    <h3 className="mb-2 font-medium">{t.corners}</h3>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {Object.keys(theme.materials.radius).map((r) => (
                        <div key={r} className="space-y-1">
                          <Label>{t.componentRadius(r)}</Label>
                          <div className="flex items-center gap-2">
                            <input type="range" min={0} max={40} value={parseInt(theme.materials.radius[r], 10) || 0} onChange={(e) => update(setPath(theme, `materials.radius.${r}`, `${e.target.value}px`))} className="flex-1" aria-label={t.radiusOf(r)} />
                            <span className="w-12 text-end text-xs" dir="ltr">{theme.materials.radius[r]}</span>
                          </div>
                        </div>
                      ))}
                      <div className="space-y-1">
                        <Label htmlFor="oa-radius">{t.formControls}</Label>
                        <select id="oa-radius" className={selectClass} value={theme["x-auth"]?.radius ?? "md"} onChange={(e) => update(setPath(theme, "x-auth.radius", e.target.value))}>
                          {AUTH_RADII.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                    </div>
                  </section>
                  <section>
                    <h3 className="mb-2 font-medium">{t.shadows}</h3>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {(["low", "medium", "high"] as const).map((e) => {
                        const el = theme.tokens.elevation[e];
                        const s: Shadow = { x: parseInt(el.offsetX, 10), y: parseInt(el.offsetY, 10), blur: parseInt(el.blur, 10), spread: parseInt(el.spread, 10), color: el.color.slice(0, 7), alpha: Math.round((parseInt(el.color.slice(7, 9) || "ff", 16) / 255) * 100) / 100 };
                        return (
                          <div key={e}>
                            <Label className="capitalize">{t.elevation[e] ?? e}</Label>
                            <ShadowEditor value={shadowCss(s)} disabled={readOnly} onChange={(css) => {
                              const p = parseShadow(css)!;
                              update(setPath(theme, `tokens.elevation.${e}`, { color: `${p.color}${Math.round(p.alpha * 255).toString(16).padStart(2, "0")}`, offsetX: `${p.x}px`, offsetY: `${p.y}px`, blur: `${p.blur}px`, spread: `${p.spread}px` }));
                            }} />
                          </div>
                        );
                      })}
                    </div>
                  </section>
                  <section>
                    <h3 className="mb-2 font-medium">{t.siteTitle}</h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <TextField label={t.siteTitleEn} dir="ltr" disabled={readOnly} value={theme["x-auth"]?.title?.en} onChange={(v) => update(setPath(theme, "x-auth.title", v ? { en: v, ar: theme["x-auth"]?.title?.ar ?? v } : undefined))} />
                      <TextField label={t.siteTitleAr} dir="rtl" disabled={readOnly} value={theme["x-auth"]?.title?.ar} onChange={(v) => update(setPath(theme, "x-auth.title", { en: theme["x-auth"]?.title?.en ?? "", ar: v ?? "" }))} />
                    </div>
                  </section>
                </div>
              )}

              {tab === "images" && (
                <div className="space-y-6">
                  {!readOnly && (
                    <uploader.Form method="post" encType="multipart/form-data" className="grid items-end gap-3 rounded-lg border border-dashed border-[var(--color-border)] p-3 sm:grid-cols-[1fr_180px_auto]">
                      <input type="hidden" name="intent" value="upload" />
                      <div className="space-y-1">
                        <Label htmlFor="asset-file">{t.uploadImage}</Label>
                        <Input id="asset-file" name="file" type="file" accept=".svg,.png,.jpg,.jpeg,.webp,.ico,.woff2" required />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="asset-target">{t.useAs}</Label>
                        <select id="asset-target" name="target" className={selectClass} value={uploadTarget} onChange={(e) => setUploadTarget(e.target.value)}>
                          <option value="">{t.justUpload}</option>
                          <option value="logo">{t.targets.logo}</option>
                          <option value="favicon">{t.targets.favicon}</option>
                          <option value="headerGraphic">{t.targets.headerGraphic}</option>
                          <option value="photo">{t.targets.photo}</option>
                          <option value="emailHeader">{t.targets.emailHeader}</option>
                        </select>
                      </div>
                      <Button type="submit" disabled={uploader.state !== "idle"}><Upload /> {t.upload}</Button>
                      <p className={`text-xs ${muted} sm:col-span-3`}>{t.uploadHelp}</p>
                    </uploader.Form>
                  )}
                  <section>
                    <h3 className="mb-2 font-medium">{t.whereImages}</h3>
                    {imageSlot(t.slots.logo, "imagery.logo", { perMode: true })}
                    {imageSlot(t.slots.favicon, "imagery.favicon", { icoOk: true })}
                    {imageSlot(t.slots.headerGraphic, "imagery.headerGraphic", { svgOnly: true, perMode: true })}
                    {imageSlot(t.slots.emailHeader, "email.headerImage")}
                    <div className="py-2">
                      <Label>{t.photos}</Label>
                      <p className={`text-xs ${muted}`}>{t.photosHelp}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(theme["x-auth"]?.photos?.light ?? []).map((p, i) => (
                          <div key={`${p}-${i}`} className="relative">
                            <img src={assetUrls[p] ?? p} alt="" className="h-16 w-24 rounded object-cover" />
                            {!readOnly && (
                              <button type="button" className="absolute end-1 top-1 rounded bg-black/60 px-1 text-xs text-white" aria-label={t.removePhoto}
                                onClick={() => {
                                  const list = (theme["x-auth"]?.photos?.light ?? []).filter((_, j) => j !== i);
                                  update(setPath(theme, "x-auth.photos", list.length ? { light: list } : undefined));
                                }}>×</button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                  <section>
                    <h3 className="mb-2 font-medium">{t.files}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {Object.entries(assets).map(([p, a]) => (
                        <div key={p} className="flex items-center gap-3 rounded border border-[var(--color-border)] p-2">
                          {p.endsWith(".woff2") ? <span className="w-12 text-center text-xs">{t.font}</span> : <img src={assetUrls[p]} alt="" className="h-10 w-12 object-contain" />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm rtl:text-right" dir="ltr">{p.replace(/^assets\//, "")}</div>
                            <div className={`text-xs ${muted}`}>{t.size(Math.floor((a.size / 1024) * 10) / 10)}</div>
                          </div>
                          {!readOnly && (
                            <Button size="sm" variant="ghost" type="button" className="text-[var(--color-destructive-text)]" disabled={dirty} title={dirty ? t.saveFirst : t.removeFile} onClick={() => setRemoving(p)}>{c.remove}</Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}

              {tab === "email" && (
                <div>
                  <p className={`mb-3 text-sm ${muted}`}>{t.emailIntro}</p>
                  {(["background", "text", "buttonBackground", "buttonText"] as const).map((k) => (
                    <div key={k} className="grid items-center gap-2 border-b border-[var(--color-border)] py-2 md:grid-cols-[180px_1fr_auto]">
                      <Label>{t.emailFields[k]}</Label>
                      <ColorField theme={theme} mode="light" label={t.emailFields[k]} disabled={readOnly} value={theme.email?.[k]} onChange={(v) => update(setPath(theme, `email.${k}`, v))} />
                      {theme.email?.[k] && <button type="button" className="text-xs text-[var(--color-destructive-text)] underline" onClick={() => update(setPath(theme, `email.${k}`, undefined))}>{t.clear}</button>}
                    </div>
                  ))}
                  <div className="grid items-center gap-2 py-2 md:grid-cols-[180px_1fr]">
                    <Label>{t.codeCorners}</Label>
                    <TextField label={t.codeCorners} dir="ltr" disabled={readOnly} placeholder={t.lengthPlaceholder} value={theme.email?.buttonRadius} onChange={(v) => update(setPath(theme, "email.buttonRadius", v))} />
                  </div>
                </div>
              )}

              {tab === "details" && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1"><Label>{t.nameEn}</Label><TextField label={t.nameEn} dir="ltr" disabled={readOnly} value={theme.name.en} onChange={(v) => v && update(setPath(theme, "name.en", v))} /></div>
                    <div className="space-y-1"><Label>{t.nameAr}</Label><TextField label={t.nameAr} dir="rtl" disabled={readOnly} value={theme.name.ar} onChange={(v) => v && update(setPath(theme, "name.ar", v))} /></div>
                    <div className="space-y-1"><Label>{t.descriptionEn}</Label><TextField label={t.descriptionEn} dir="ltr" disabled={readOnly} value={theme.description?.en} onChange={(v) => update(setPath(theme, "description", v ? { en: v, ar: theme.description?.ar ?? v } : undefined))} /></div>
                    <div className="space-y-1"><Label>{t.descriptionAr}</Label><TextField label={t.descriptionAr} dir="rtl" disabled={readOnly} value={theme.description?.ar} onChange={(v) => update(setPath(theme, "description", { en: theme.description?.en ?? "", ar: v ?? "" }))} /></div>
                    <div className="space-y-1"><Label>{t.version}</Label><TextField label={t.version} dir="ltr" disabled={readOnly} value={theme.version} onChange={(v) => v && update(setPath(theme, "version", v))} /></div>
                  </div>
                  <p className={`text-xs ${muted}`}>
                    {t.id} <code dir="ltr">{theme.id}</code>{theme.basedOn && <>{c.sep}{t.basedOn} <code dir="ltr">{theme.basedOn}</code></>}{c.sep}<span dir="ltr">{t.format(theme.formatVersion)}</span>. {t.versionNote}
                  </p>
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">theme.json</summary>
                    <pre className="ui-code mt-2 max-h-96 overflow-auto rounded p-3 text-xs" dir="ltr">{JSON.stringify(theme, null, 2)}</pre>
                  </details>
                </div>
              )}
            </fieldset>
          </CardContent>
        </Card>

        {/* ------------------------------------------------ preview */}
        <Card className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t.preview}</CardTitle>
            <CardDescription>{t.previewIntro(dirty)}</CardDescription>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <select className={`${selectClass} w-auto`} value={page} onChange={(e) => setPage(e.target.value as PreviewPage)} aria-label={t.previewPage}>
                {PAGES.map((id) => <option key={id} value={id}>{t.previewPages[id]}</option>)}
              </select>
              <div className="inline-flex rounded-md border border-[var(--color-border)]" role="group" aria-label={t.language}>
                {(["en", "ar"] as const).map((l) => <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)} className={`px-2.5 py-1 text-sm ${lang === l ? "bg-[var(--color-accent)] font-medium" : ""}`}>{l === "en" ? "English" : "عربي"}</button>)}
              </div>
              <div className="inline-flex rounded-md border border-[var(--color-border)]" role="group" aria-label={t.colourScheme}>
                <button type="button" aria-pressed={scheme === "light"} onClick={() => setScheme("light")} className={`px-2 py-1 ${scheme === "light" ? "bg-[var(--color-accent)]" : ""}`} title={c.light} aria-label={c.light}><Sun className="h-4 w-4" /></button>
                <button type="button" aria-pressed={scheme === "dark"} onClick={() => setScheme("dark")} className={`px-2 py-1 ${scheme === "dark" ? "bg-[var(--color-accent)]" : ""}`} title={c.dark} aria-label={c.dark}><Moon className="h-4 w-4" /></button>
              </div>
              <div className="inline-flex rounded-md border border-[var(--color-border)]" role="group" aria-label={t.device}>
                <button type="button" aria-pressed={device === "phone"} onClick={() => setDevice("phone")} className={`px-2 py-1 ${device === "phone" ? "bg-[var(--color-accent)]" : ""}`} title={t.phone} aria-label={t.phone}><Smartphone className="h-4 w-4" /></button>
                <button type="button" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")} className={`px-2 py-1 ${device === "desktop" ? "bg-[var(--color-accent)]" : ""}`} title={t.desktop} aria-label={t.desktop}><Monitor className="h-4 w-4" /></button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div ref={frameBox} className="w-full">
              {preview.error && <p className="mb-2 text-sm text-[var(--color-warning-text)]" role="status">{preview.error}</p>}
              <div dir="ltr" className="mx-auto max-w-full overflow-hidden rounded-lg border border-[var(--color-border)] shadow-sm" style={{ width: dev.width * scale, height: dev.height * scale }}>
                <iframe
                  title={t.previewFrame}
                  data-testid="theme-preview"
                  sandbox=""
                  srcDoc={preview.html}
                  style={{ width: dev.width, height: dev.height, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, background: "#fff" }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={!!removing}
        cancelLabel={copy.cancel}
        onCancel={() => setRemoving(null)}
        title={copy.removeFile.title}
        description={removing ? copy.removeFile.body(removing.replace(/^assets\//, "")) : ""}
        confirmLabel={copy.removeFile.confirm}
        dir={dirOf(adminLang)}
        lang={adminLang}
        onConfirm={() => {
          if (removing) remover.submit({ intent: "remove-asset", path: removing }, { method: "post" });
          setRemoving(null);
        }}
      />
    </AdminLayout>
  );
}
