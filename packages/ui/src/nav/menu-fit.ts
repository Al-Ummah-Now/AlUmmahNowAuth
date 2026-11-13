/**
 * Keeps an open popup inside the viewport (AlUmmahNow docs/design/NAV.md "Menus never leave the
 * screen"; same function as AlUmmahNow packages/fanous-tokens/nav/menu-fit.js). After it is shown:
 * shift it sideways (CSS `translate`) to an 8px gutter, narrow it if wider than the screen; keep it
 * below its anchor when it fits, else open it upwards when the anchor has more room above, capping
 * its height to the room on that side (it scrolls inside). Never a minimum height (a 96px floor
 * pushed a picker past a landscape phone's bottom in WebKit). Re-fits on size change and resize.
 */
const GUTTER = 8;
const fitted = new Set<HTMLElement>();
const observers = new Map<HTMLElement, ResizeObserver>();
let listening = false;

function stopObserving(el: HTMLElement): void {
  observers.get(el)?.disconnect();
  observers.delete(el);
}

/** Re-fit when the popup's size changes (results arriving after it opened); the last size guards against our own cap. */
function observe(el: HTMLElement): void {
  if (observers.has(el) || typeof ResizeObserver === "undefined") return;
  let last = "";
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (size === last) return;
    last = size;
    fitToViewport(el);
  });
  ro.observe(el);
  observers.set(el, ro);
}

/** The visible area in getBoundingClientRect coordinates: the visual viewport (an on-screen keyboard counts). */
function viewport() {
  const vv = window.visualViewport;
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  if (!vv) return { left: 0, top: 0, right: width, bottom: height };
  return { left: Math.max(0, vv.offsetLeft), top: Math.max(0, vv.offsetTop), right: Math.min(width, vv.offsetLeft + vv.width), bottom: Math.min(height, vv.offsetTop + vv.height) };
}

export function fitToViewport(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.style.removeProperty("translate");
  el.style.removeProperty("max-inline-size");
  el.style.removeProperty("max-block-size");
  if (el.hidden || !el.isConnected || el.getClientRects().length === 0) {
    fitted.delete(el);
    stopObserving(el);
    return;
  }
  fitted.add(el);
  observe(el);
  if (!listening) {
    listening = true;
    const refit = () => fitted.forEach((f) => fitToViewport(f));
    window.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("resize", refit);
  }
  const vp = viewport();
  let r = el.getBoundingClientRect();
  if (r.width > vp.right - vp.left - 2 * GUTTER) {
    el.style.maxInlineSize = `${vp.right - vp.left - 2 * GUTTER}px`;
    r = el.getBoundingClientRect();
  }
  const dx = r.left < vp.left + GUTTER ? vp.left + GUTTER - r.left : r.right > vp.right - GUTTER ? vp.right - GUTTER - r.right : 0;
  let dy = 0;
  const below = Math.floor(vp.bottom - GUTTER - Math.max(r.top, vp.top + GUTTER));
  let cap: number | null = r.height > below ? below : null;
  if (cap !== null) {
    // No room below: open upwards when the anchor (the positioned box it hangs from) has more room
    // above. A fixed popup (a phone sheet) has no anchor to flip around.
    const anchor = getComputedStyle(el).position === "fixed" ? null : el.offsetParent;
    if (anchor && anchor !== document.body && anchor !== document.documentElement) {
      const a = anchor.getBoundingClientRect();
      const gap = Math.max(0, r.top - a.bottom);
      const above = Math.floor(a.top - gap - (vp.top + GUTTER));
      if (above > below) {
        const height = Math.min(r.height, above);
        cap = r.height > above ? above : null;
        dy = a.top - gap - height - r.top;
      }
    }
  }
  if (cap !== null) el.style.maxBlockSize = `${Math.max(cap, 0)}px`;
  if (dx || dy) el.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
}
