/**
 * The shared header's pieces (AlUmmahNow docs/design/NAV.md "Header") as JSX: the same elements,
 * classes and attributes as the vendored builders (packages/ui/src/nav/header.js, byte for byte the
 * AlUmmahNow file, kept equal by `pnpm nav:check`). site-header.test.tsx renders each piece and
 * compares it with the builder's output, so this header can't drift from the other apps'.
 */
import { HEADER_LABELS, MENU_ICON_BODY } from "../../../../packages/ui/src/nav/header.js";
import { LOGO_SRC } from "../../../../packages/ui/src/nav/page-header.ts";
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

/**
 * The drawer toggle, first in the bar: the same 40px round `.aun-icon-btn.aun-menu-btn` with lucide
 * `menu` (0.487, exactly the shared menuButtonHtml's icon) as the videos site's drawer toggle, in every
 * state (no X, no chevron). Always shown (it opens the drawer / collapses the rail), so not
 * `.aun-menu-collapse`; never `.aun-menu`, the account menu's surface in aun-nav.css.
 */
export function MenuButton({
  label,
  onClick,
  expanded,
  pressed,
  controls,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  pressed?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      className="aun-icon-btn aun-menu-btn"
      data-testid="nav-drawer-toggle"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-pressed={pressed}
      aria-controls={controls}
      onClick={onClick}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="lucide lucide-menu"
        aria-hidden="true"
        focusable="false"
        dangerouslySetInnerHTML={{ __html: MENU_ICON_BODY }}
      />
    </button>
  );
}
