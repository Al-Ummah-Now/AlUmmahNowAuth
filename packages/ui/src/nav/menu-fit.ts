/**
 * Keeps an open popup inside the viewport (AlUmmahNow docs/design/NAV.md "Menus never leave the
 * screen"; owner bug 2026-11-13). The same function as AlUmmahNow packages/fanous-tokens/nav/menu-fit.js.
 *
 * Call after the popup is shown: shifts it sideways (CSS `translate`) so both edges keep an 8px gutter,
 * narrows it when it is wider than the screen, and caps its height to the room below its top (it
 * scrolls inside). Re-fits on resize while open.
 */
const GUTTER = 8;
const fitted = new Set<HTMLElement>();
let listening = false;

export function fitToViewport(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.style.removeProperty("translate");
  el.style.removeProperty("max-inline-size");
  el.style.removeProperty("max-block-size");
  if (el.hidden || !el.isConnected || el.getClientRects().length === 0) {
    fitted.delete(el);
    return;
  }
  fitted.add(el);
  if (!listening) {
    listening = true;
    window.addEventListener("resize", () => fitted.forEach((f) => fitToViewport(f)));
  }
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let r = el.getBoundingClientRect();
  if (r.width > vw - 2 * GUTTER) {
    el.style.maxInlineSize = `${vw - 2 * GUTTER}px`;
    r = el.getBoundingClientRect();
  }
  const dx = r.left < GUTTER ? GUTTER - r.left : r.right > vw - GUTTER ? vw - GUTTER - r.right : 0;
  if (dx) el.style.translate = `${Math.round(dx)}px 0`;
  const room = Math.floor(vh - Math.max(r.top, 0) - GUTTER);
  const cssMax = parseFloat(getComputedStyle(el).maxBlockSize);
  if (!(cssMax <= room)) el.style.maxBlockSize = `${Math.max(room, 96)}px`;
}
