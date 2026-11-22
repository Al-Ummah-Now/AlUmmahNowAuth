/**
 * packages/ui/src/nav/menu-fit.ts and its inline ES5 twin (menu-fit-es5.ts, the profile page's script) are the
 * same function as AlUmmahNow packages/fanous-tokens/nav/menu-fit.js: a phone sheet (a fixed account menu)
 * hangs 4px under its `.aun-header` wherever the bar is, so a banner above the bar never puts the sheet over
 * it (AUDIT-2, CMS #154).
 */
import { afterEach, describe, expect, it } from "vitest";
import { fitToViewport } from "../../../../packages/ui/src/nav/menu-fit";
import { FIT_TO_VIEWPORT_ES5 } from "../../../../packages/ui/src/nav/menu-fit-es5";

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box) => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top });

/** A fixed sheet CSS put at 60px, inside a 56px header at `barTop`, on a 375×667 phone. */
function stubSheet(barTop: number, height = 300) {
  const style: Record<string, string> = {};
  const box = { left: 8, top: 60, width: 359, height };
  const el = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [box],
    getBoundingClientRect: () => rect(box),
    offsetParent: null,
    closest: (sel: string) => (sel === ".aun-header" ? { getBoundingClientRect: () => rect({ left: 0, top: barTop, width: 375, height: 56 }) } : null),
    style: {
      removeProperty: (k: string) => delete style[k],
      set translate(v: string) { style.translate = v; },
      set maxInlineSize(v: string) { style["max-inline-size"] = v; },
      set maxBlockSize(v: string) { style["max-block-size"] = v; },
    },
  };
  Object.assign(globalThis, {
    document: { documentElement: { clientWidth: 375 }, body: {} },
    window: { innerHeight: 667, addEventListener: () => {} },
    getComputedStyle: () => ({ position: "fixed" }),
  });
  return { el: el as unknown as HTMLElement, style };
}

const es5 = () => new Function(`${FIT_TO_VIEWPORT_ES5}; return fitToViewport;`)() as (el: HTMLElement) => void;

afterEach(() => {
  for (const k of ["document", "window", "getComputedStyle"]) delete (globalThis as Record<string, unknown>)[k];
});

describe.each([
  ["menu-fit.ts", () => fitToViewport],
  ["the ES5 twin", es5],
])("a phone sheet hangs under its header (%s)", (_, fit) => {
  it("moves below a header a banner pushed down, and caps its height from there", () => {
    const { el, style } = stubSheet(40);
    fit()(el);
    expect(style.translate).toBe("0px 40px");
    const tall = stubSheet(40, 900);
    fit()(tall.el);
    expect(tall.style["max-block-size"]).toBe(`${667 - 8 - 100}px`);
  });

  it("stays where its CSS put it under a header at the top", () => {
    const { el, style } = stubSheet(0);
    fit()(el);
    expect(style.translate).toBeUndefined();
  });
});
