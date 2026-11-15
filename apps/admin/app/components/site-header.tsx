/**
 * The shared header's pieces (AlUmmahNow docs/design/NAV.md "Header") as JSX: the same elements,
 * classes and attributes as the vendored builders (packages/ui/src/nav/header.js, byte for byte the
 * AlUmmahNow file, kept equal by `pnpm nav:check`). site-header.test.tsx renders each piece and
 * compares it with the builder's output, so this header can't drift from the other apps'.
 */
import { HEADER_LABELS } from "../../../../packages/ui/src/nav/header.js";
import { APP_ICON_BASE, LOGO_SRC } from "../../../../packages/ui/src/nav/page-header.ts";
import type { AdminLang } from "../lib/deletion-copy";

const labels = (lang: AdminLang) => HEADER_LABELS[lang === "ar" ? "ar" : "en"];

/** The logo lockup: the owner's logo (round), the wordmark, and the app's name. */
export function Brand({ lang, href, app }: { lang: AdminLang; href: string; app: string }) {
  return (
    <a className="aun-brand" href={href}>
      <img className="aun-brand-mark" src={LOGO_SRC} alt="" width="36" height="36" />
      <span className="aun-brand-text">
        <span className="aun-brand-name">{labels(lang).siteName}</span>
        <span className="aun-brand-app">{app}</span>
      </span>
    </a>
  );
}

/** "QA" / "STAGE" right after the brand; nothing in production or local dev. */
export function EnvBadge({ environment, lang }: { environment?: string; lang: AdminLang }) {
  const env = String(environment ?? "").toLowerCase();
  if (env !== "qa" && env !== "stage") return null;
  const name = labels(lang).env[env];
  return (
    <span className="aun-env" role="note" aria-label={name} title={name}>
      {env.toUpperCase()}
    </span>
  );
}

/** Website and Videos: the public sites other than this one, each with its app icon. */
export function AppLinks({ lang, links }: { lang: AdminLang; links: { id: string; href: string }[] }) {
  const l = labels(lang);
  const items = links.filter((a) => a.href && (a.id === "www" || a.id === "videos")) as { id: "www" | "videos"; href: string }[];
  if (!items.length) return null;
  return (
    <nav className="aun-apps" aria-label={l.apps}>
      {items.map((a) => (
        <a key={a.id} className="aun-app" href={a.href}>
          <img className="aun-app-mark" src={`${APP_ICON_BASE}/${a.id}.webp`} alt="" width="22" height="22" />
          <span className="aun-app-name">{l[a.id]}</span>
        </a>
      ))}
    </nav>
  );
}

/** The language button: the other language's own name; the current page and query in that language. */
export function LangButton({ lang, href }: { lang: AdminLang; href: string }) {
  const l = labels(lang);
  const to = lang === "ar" ? "en" : "ar";
  return (
    <a className="aun-lang" href={href} hrefLang={to}>
      <span className="aun-visually-hidden">{`${l.switchLang}: `}</span>
      <span lang={to}>{l.otherLang}</span>
    </a>
  );
}
