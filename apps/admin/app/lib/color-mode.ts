/**
 * Light / Dark for the accounts admin, the same as the videos site (AlUmmahNow
 * apps/web/src/lib/theme/color-mode.ts; owner decision 2026-11-13: no "System" option):
 *
 * - the choice is saved in localStorage `theme` ("light" or "dark"); with nothing saved the page
 *   follows the device, live;
 * - MODE_SCRIPT runs inline in <head> before first paint and puts `.light` or `.dark` on <html>,
 *   so a reload never flashes the other mode. The class is owned by the script, never by React;
 * - the theme toggle (components/theme-toggle.tsx) always saves "light" or "dark";
 * - a "system" saved by an older release is resolved once to the device's mode and saved as that.
 *
 * The Auth theme's tokens follow the class (lib/shell-theme.ts scopes them per mode).
 */
export type ColorMode = "light" | "dark";

export const MODE_STORAGE_KEY = "theme";

/**
 * Inline in <head>, before any stylesheet. Plain ES5 with no imports; never throws. It also keeps
 * the class: if anything rewrites <html class> (React recovering from a hydration mismatch), the
 * mode is put back at once. window.__aunSetMode saves a choice (in memory too, for when storage
 * is blocked) and shows it.
 */
export const MODE_SCRIPT = `(function(){var d=document.documentElement,k="${MODE_STORAGE_KEY}",mem=null,q=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;function s(){if(mem)return mem;try{var v=localStorage.getItem(k);if(v==="system"){v=q&&q.matches?"dark":"light";localStorage.setItem(k,v)}return v==="light"||v==="dark"?v:null}catch(e){return null}}function a(){var m=s(),dk=m?m==="dark":!!(q&&q.matches);var c=d.classList;if(c.contains("dark")!==dk)c.toggle("dark",dk);if(c.contains("light")===dk)c.toggle("light",!dk)}a();if(q){if(q.addEventListener)q.addEventListener("change",a);else if(q.addListener)q.addListener(a)}window.addEventListener("storage",function(e){if(e.key===k){mem=null;a()}});if(window.MutationObserver)new MutationObserver(a).observe(d,{attributes:true,attributeFilter:["class"]});window.__aunSetMode=function(m){mem=m;try{localStorage.setItem(k,m)}catch(e){}a()}})();`;

/** The mode on screen right now (the class MODE_SCRIPT set). */
export function currentColorMode(doc: Document = document): ColorMode {
  return doc.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Save a choice and show it now (through MODE_SCRIPT, which owns the class). */
export function setColorMode(mode: ColorMode, win: Window & { __aunSetMode?: (m: ColorMode) => void } = window): void {
  if (win.__aunSetMode) return win.__aunSetMode(mode);
  try {
    win.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  win.document.documentElement.classList.toggle("dark", mode === "dark");
  win.document.documentElement.classList.toggle("light", mode === "light");
}

/** The switch's labels, as on the videos site (the action the button takes). */
export const MODE_COPY = {
  en: { toLight: "Switch to light mode", toDark: "Switch to dark mode" },
  ar: { toLight: "التبديل إلى الوضع الفاتح", toDark: "التبديل إلى الوضع الداكن" },
} as const;
