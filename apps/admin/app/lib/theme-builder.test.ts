import { describe, expect, it } from "vitest";
import { builtinPackage } from "../../../../packages/ui/src/auth-theme/builtin.ts";
import type { AuthThemeJson } from "../../../../packages/ui/src/auth-theme/types.ts";
import { validateTheme } from "../../../../packages/ui/src/auth-theme/validate.ts";
import {
  FONT_CHOICES,
  getPath,
  getSlot,
  googleFontsUrl,
  gradientCss,
  parseGradient,
  parseShadow,
  pickerHex,
  setPath,
  setSlot,
  shadowCss,
  swatchesOf,
  withUpload,
} from "./theme-builder";

const nahas = () => builtinPackage("nahas")!.theme as AuthThemeJson;
const classic = () => builtinPackage("classic")!.theme as AuthThemeJson;

describe("setPath / getPath", () => {
  it("sets a deep value on a copy", () => {
    const a = { x: { y: 1 } };
    const b = setPath(a, "x.z.w", 2);
    expect(getPath(b, "x.z.w")).toBe(2);
    expect(a).toEqual({ x: { y: 1 } });
  });

  it("removing the last value removes the emptied parents", () => {
    const b = setPath({ keep: 1, x: { y: { z: 1 } } }, "x.y.z", undefined);
    expect(b).toEqual({ keep: 1 });
  });
});

describe("gradients and shadows", () => {
  it("round-trip what the builder writes", () => {
    const g = { angle: 135, stops: [{ color: "#112233", at: 0 }, { color: "{color.primary}", at: 60 }, { color: "#ffffff", at: 100 }] };
    expect(parseGradient(gradientCss(g))).toEqual(g);
    const s = { x: 0, y: -4, blur: 24, spread: 2, color: "#0a0b0c", alpha: 0.35 };
    expect(parseShadow(shadowCss(s))).toEqual(s);
  });

  it("leave hand-written CSS alone", () => {
    expect(parseGradient("radial-gradient(#fff, #000)")).toBeUndefined();
    expect(parseShadow("0 18px 40px rgb(0 0 0 / 0.28)")).toBeUndefined();
  });

  it("produce values the format accepts", () => {
    const theme = setSlot(nahas(), "base", "button.background", gradientCss({ angle: 90, stops: [{ color: "#f4ae3a", at: 0 }, { color: "#e0962a", at: 100 }] }));
    const withShadow = setSlot(theme, "base", "card.shadow", shadowCss({ x: 0, y: 12, blur: 32, spread: 0, color: "#000000", alpha: 0.3 }));
    expect(validateTheme(withShadow).errors).toEqual([]);
  });
});

describe("page slots", () => {
  it("base page and card parts live in the format's signIn fields", () => {
    let t = setSlot(nahas(), "base", "page.background", "#123456");
    expect(t.signIn?.background).toEqual({ light: "#123456", dark: "#123456" });
    expect(getSlot(t, "base", "page.background")).toEqual({ light: "#123456", dark: "#123456" });
    t = setSlot(t, "base", "card.radius", { light: "20px", dark: "24px" });
    expect(getPath(t, "signIn.card.radius")).toBe("20px");
    expect(t["x-auth"]?.sections?.base?.["page.background"]).toBeUndefined();
    expect(validateTheme(t).errors).toEqual([]);
  });

  it("other parts live in x-auth sections, and clearing removes empty sections", () => {
    let t = setSlot(nahas(), "register", "heading.color", { light: "#111111", dark: "#eeeeee" });
    expect(t["x-auth"]?.sections?.register?.["heading.color"]).toEqual({ light: "#111111", dark: "#eeeeee" });
    t = setSlot(t, "register", "heading.color", undefined);
    expect(t["x-auth"]?.sections?.register).toBeUndefined();
  });
});

describe("uploads go where they were uploaded for", () => {
  it.each([
    ["logo", "imagery.logo", { light: "assets/a.png", dark: "assets/a.png" }],
    ["favicon", "imagery.favicon", "assets/a.png"],
    ["headerGraphic", "imagery.headerGraphic", { light: "assets/a.png", dark: "assets/a.png" }],
    ["emailHeader", "email.headerImage", "assets/a.png"],
  ])("%s", (target, path, expected) => {
    expect(getPath(withUpload(nahas(), target, "assets/a.png"), path)).toEqual(expected);
  });

  it("photos are added to the list", () => {
    const t = withUpload(classic(), "photo", "assets/p.jpg");
    const photos = t["x-auth"]?.photos?.light ?? [];
    expect(photos[photos.length - 1]).toBe("assets/p.jpg");
    expect(photos.length).toBe((classic()["x-auth"]?.photos?.light ?? []).length + 1);
  });

  it("an unknown target changes nothing", () => {
    const t = nahas();
    expect(withUpload(t, "", "assets/a.png")).toBe(t);
  });
});

describe("fonts", () => {
  it("one Google Fonts stylesheet for the chosen families, none for system fonts", () => {
    const cairo = FONT_CHOICES.find((f) => f.label === "Cairo");
    const amiri = FONT_CHOICES.find((f) => f.label === "Amiri");
    expect(googleFontsUrl([FONT_CHOICES[0]])).toBeUndefined();
    const url = googleFontsUrl([cairo, amiri, cairo])!;
    expect(url).toBe("https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&family=Amiri:wght@400;700&display=swap");
    expect(validateTheme(setPath(nahas(), "x-auth.fontImports", [url])).errors).toEqual([]);
  });

  it("every Arabic choice is offered for Arabic pages", () => {
    expect(FONT_CHOICES.filter((f) => f.arabic).map((f) => f.label)).toEqual(
      expect.arrayContaining(["Cairo", "Tajawal", "Noto Kufi Arabic", "IBM Plex Sans Arabic", "Almarai", "Amiri", "Reem Kufi"])
    );
  });
});

describe("colours shown in the builder", () => {
  it("swatches resolve references to hex in both modes", () => {
    const s = swatchesOf(nahas())!;
    for (const mode of ["light", "dark"] as const) for (const v of Object.values(s[mode])) expect(v).toMatch(/^#[0-9a-f]{6}/i);
  });

  it("the picker shows a reference's hex, and black for what it cannot show", () => {
    const t = nahas();
    expect(pickerHex(t, "light", "{color.primary}")).toBe(pickerHex(t, "light", t.tokens.color.light.primary));
    expect(pickerHex(t, "light", undefined)).toBe("#000000");
    expect(pickerHex(t, "light", "linear-gradient(90deg,#fff 0%,#000 100%)")).toBe("#000000");
  });
});
