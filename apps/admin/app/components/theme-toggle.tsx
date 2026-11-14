import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { MODE_COPY, currentColorMode, setColorMode, type ColorMode } from "../lib/color-mode";
import type { AdminLang } from "../lib/deletion-copy";
import { cn } from "../lib/utils";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * The light/dark switch at the foot of the side rail, as on the videos site (AlUmmahNow
 * apps/web ThemeDemo/AppShell `theme-toggle`; NAV.md: apps with a side rail put it there): one
 * icon button that names the mode it switches to. The icon follows the <html> class through CSS,
 * so the server render and the first paint already show the right one.
 */
export function ThemeToggle({ lang, className }: { lang: AdminLang; className?: string }) {
  // null on the server and during hydration: the label then comes from the class after hydration
  const mode = useSyncExternalStore<ColorMode | null>(subscribe, () => currentColorMode(), () => null);
  const copy = MODE_COPY[lang];
  const label = mode === "dark" ? copy.toLight : mode === "light" ? copy.toDark : `${copy.toLight} / ${copy.toDark}`;
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => setColorMode(currentColorMode() === "dark" ? "light" : "dark")}
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg text-[var(--color-sidebar-icon)] transition-colors hover:bg-[var(--color-sidebar-active)] hover:text-[var(--color-sidebar-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]",
        className,
      )}
    >
      <Sun aria-hidden="true" className="hidden size-5 dark:block" />
      <Moon aria-hidden="true" className="block size-5 dark:hidden" />
    </button>
  );
}
