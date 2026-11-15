import { useSyncExternalStore } from "react";
import { MODE_COPY, currentColorMode, setColorMode, type ColorMode } from "../lib/color-mode";
import type { AdminLang } from "../lib/deletion-copy";
import { MOON_ICON_BODY, SUN_ICON_BODY, modeToggleLabel } from "../lib/mode-toggle";

/**
 * One Lucide 0.487 icon exactly as the shared modeIconSvg draws it (AlUmmahNow
 * packages/fanous-tokens/nav/mode-toggle.js, vendored in packages/ui/src/nav): `aun-mode-sun` /
 * `aun-mode-moon` let the shared header CSS (PAGE_HEADER_CSS) show the icon of the mode on screen.
 */
function ModeIcon({ icon }: { icon: "sun" | "moon" }) {
  return (
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
      className={`lucide lucide-${icon} aun-mode-${icon}`}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: icon === "sun" ? SUN_ICON_BODY : MOON_ICON_BODY }}
    />
  );
}

/**
 * The header's light/dark button (AlUmmahNow docs/design/NAV.md "Header": `.aun-icon-btn.aun-mode`),
 * the same element as the shared modeButtonHtml with both icons (site-header.test.tsx compares
 * them). `dark` null: the mode is not known yet (server render), so the name offers both.
 */
export function ModeButton({ lang, dark, onClick }: { lang: AdminLang; dark: boolean | null; onClick?: () => void }) {
  const copy = MODE_COPY[lang];
  const label = dark === null ? `${copy.toLight} / ${copy.toDark}` : modeToggleLabel(lang, dark);
  return (
    <button type="button" className="aun-icon-btn aun-mode" id="mode-toggle" data-testid="theme-toggle" aria-label={label} title={label} onClick={onClick}>
      <ModeIcon icon="sun" />
      <ModeIcon icon="moon" />
    </button>
  );
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * The light/dark switch in the header, as on the videos site (AlUmmahNow apps/web `theme-toggle`):
 * one icon button that names the mode it switches to. The icon follows the <html> class through
 * CSS, so the server render and the first paint already show the right one.
 */
export function ThemeToggle({ lang }: { lang: AdminLang }) {
  // null on the server and during hydration: the label then comes from the class after hydration
  const mode = useSyncExternalStore<ColorMode | null>(subscribe, () => currentColorMode(), () => null);
  return (
    <ModeButton
      lang={lang}
      dark={mode === null ? null : mode === "dark"}
      onClick={() => setColorMode(currentColorMode() === "dark" ? "light" : "dark")}
    />
  );
}
