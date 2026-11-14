import { describe, expect, it } from "vitest";
import { compileTheme } from "../../../../packages/ui/src/auth-theme/compile.ts";
import { builtinPackage, compileBuiltin } from "../../../../packages/ui/src/auth-theme/builtin.ts";
import { contrastRatio } from "../../../../packages/ui/src/theme-packages/contrast.ts";
import { adminStreetCss, fetchShellTheme, modeScopedCss, shellThemeCss } from "./shell-theme";

const BUILTINS = ["classic", "fawanees", "lantern", "nahas", "zujaj"];

const withShell = () => {
  const pkg = structuredClone(builtinPackage("nahas")!);
  pkg.theme["x-auth"] = { ...pkg.theme["x-auth"], sections: { ...pkg.theme["x-auth"]?.sections, adminShell: { "sidebar.background": "#101820", "sidebar.active": { light: "#f4ae3a", dark: "#e0962a" } } } };
  return compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss;
};

/** The declarations of the block a selector opens, as a map. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector}{`);
  if (start < 0) return {};
  const body = css.slice(start + selector.length + 1, css.indexOf("}", start));
  return Object.fromEntries(body.split(";").filter((d) => d.includes(":")).map((d) => {
    const i = d.indexOf(":");
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
  }));
}

describe("admin theme: light and dark", () => {
  it("keys each scheme's tokens on the admin's mode class, and on the device when no class is set", () => {
    const css = modeScopedCss(":root{--a:1;}@media(prefers-color-scheme:light){:root{--c:#fff;}}@media(prefers-color-scheme:dark){:root{--c:#000;}}");
    expect(css).toBe(
      ":root{--a:1;}" +
        ":root.light{--c:#fff;}@media(prefers-color-scheme:light){:root:not(.dark){--c:#fff;}}" +
        ":root.dark{--c:#000;}@media(prefers-color-scheme:dark){:root:not(.light){--c:#000;}}",
    );
  });

  it("every built-in theme colours the whole admin in both modes, with no device-only blocks left and no font imports", () => {
    for (const id of BUILTINS) {
      const css = shellThemeCss(compileBuiltin(id, "https://auth.example")!.tokensCss);
      expect(css, id).not.toMatch(/@import|@font-face/);
      expect(css, id).not.toMatch(/@media\(prefers-color-scheme:(light|dark)\)\{:root\{/);
      for (const mode of ["light", "dark"]) {
        const tokens = block(css, `:root.${mode}`);
        for (const name of ["--fanous-color-background", "--fanous-color-text-primary", "--fanous-c-drawer-bg", "--fanous-c-dialog-bg", "--fanous-c-menu-bg", "--fanous-c-button-primary-bg"]) {
          expect(tokens[name], `${id} ${mode} ${name}`).toMatch(/^#[0-9a-f]{6}/);
        }
      }
      // no theme sets adminShell parts today
      expect(css, id).not.toMatch(/\[data-shell="(sidebar|header)"\]/);
    }
  });

  it("Fawanees light is the approved light palette, and dark its dark one", () => {
    const css = shellThemeCss(compileBuiltin("fawanees", "https://auth.example")!.tokensCss);
    expect(block(css, ":root.light")["--fanous-color-background"]).toBe("#f3eee5");
    expect(block(css, ":root.light")["--fanous-color-text-primary"]).toBe("#16232b");
    expect(block(css, ":root.dark")["--fanous-color-background"]).toBe("#09151e");
    expect(block(css, ":root.dark")["--fanous-color-text-primary"]).toBe("#f7f1e8");
  });

  // The pairs the admin draws (app/tailwind.css): text on its surfaces, AA (4.5:1); icons 3:1
  const PAIRS: [fg: string, bg: string, min: number][] = [
    ["--fanous-color-text-primary", "--fanous-color-background", 4.5],
    ["--fanous-color-text-primary", "--fanous-color-surface", 4.5],
    ["--fanous-color-text-primary", "--fanous-color-surface-raised", 4.5],
    ["--fanous-color-text-primary", "--fanous-c-drawer-active-bg", 4.5],
    ["--fanous-color-text-muted", "--fanous-color-background", 4.5],
    ["--fanous-color-text-muted", "--fanous-color-surface", 4.5],
    ["--fanous-color-text-muted", "--fanous-c-drawer-active-bg", 4.5],
    ["--fanous-color-error-text", "--fanous-color-surface", 4.5],
    ["--fanous-color-error-text", "--fanous-color-background", 4.5],
    ["--fanous-color-success-text", "--fanous-color-surface", 4.5],
    ["--fanous-c-link-text", "--fanous-color-surface", 4.5],
    ["--fanous-c-link-text", "--fanous-color-background", 4.5],
    ["--fanous-c-button-primary-text", "--fanous-c-button-primary-bg", 4.5],
    ["--fanous-c-button-secondary-text", "--fanous-c-button-secondary-bg", 4.5],
    ["--fanous-c-button-destructive-text", "--fanous-c-button-destructive-bg", 4.5],
    ["--fanous-c-drawer-text", "--fanous-c-drawer-bg", 4.5],
    ["--fanous-c-drawer-active-text", "--fanous-c-drawer-active-bg", 4.5],
    ["--fanous-c-drawer-icon", "--fanous-c-drawer-bg", 3],
    ["--fanous-c-dialog-text", "--fanous-c-dialog-bg", 4.5],
    ["--fanous-c-form-input-text", "--fanous-c-form-input-bg", 4.5],
    ["--fanous-c-nav-text", "--fanous-c-nav-bg", 4.5],
    ["--fanous-c-nav-active-text", "--fanous-c-nav-bg", 4.5],
  ];

  it("every built-in theme's admin colours pass WCAG AA in light and in dark", () => {
    const failures: string[] = [];
    for (const id of BUILTINS) {
      const css = shellThemeCss(compileBuiltin(id, "https://auth.example")!.tokensCss);
      for (const mode of ["light", "dark"]) {
        const t = block(css, `:root.${mode}`);
        for (const [fg, bg, min] of PAIRS) {
          const ratio = contrastRatio(t[fg].slice(0, 7), t[bg].slice(0, 7));
          if (ratio < min) failures.push(`${id} ${mode}: ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("applies the theme's adminShell parts with its light and dark values", () => {
    const css = shellThemeCss(withShell());
    expect(css).toContain('[data-shell="sidebar"]{background:var(--auth-adminShell-sidebar-background)}');
    expect(css).toContain('[data-shell="sidebar"] a[aria-current="page"]{background:var(--auth-adminShell-sidebar-active)}');
    expect(css).not.toContain(`[data-shell="header"]`);
    expect(css).not.toMatch(/@import|@font-face/);
    expect(block(css, ":root.light")["--auth-adminShell-sidebar-active"]).toBe("#f4ae3a");
    expect(block(css, ":root.dark")["--auth-adminShell-sidebar-active"]).toBe("#e0962a");
    expect(block(css, ":root.light")["--auth-adminShell-sidebar-background"]).toBe("#101820");
    expect(block(css, ":root.dark")["--auth-adminShell-sidebar-background"]).toBe("#101820");
  });

  it("Fawanees: the lantern street follows the mode, like the profile app (light street in light, dark in dark)", () => {
    const tokens = compileBuiltin("fawanees", "https://auth.example")!.tokensCss;
    const css = shellThemeCss(tokens);
    const street = adminStreetCss(tokens);
    expect(css.endsWith(street)).toBe(true);
    expect(street).toBe('html.fanous-street [data-shell="page"]{background:transparent}\nhtml.fanous-street [data-shell="page"]>main{min-height:100vh;padding-bottom:96px}');
    const light = block(css, ":root.light"), dark = block(css, ":root.dark");
    expect(light["--fanous-street-on"]).toBe("1");
    expect(dark["--fanous-street-on"]).toBe("1");
    expect(dark["--fanous-street-line"]).toBe("#f5cf9242");
    expect(light["--fanous-street-line"]).not.toBe(dark["--fanous-street-line"]);
    const pkg = builtinPackage("fawanees")!;
    expect(dark["--fanous-street-lights"]).toBe(`url("https://auth.example/themes/assets/${pkg.assets["assets/street-lights-dark.svg"]!.hash}")`);
    expect(light["--fanous-street-lights"]).not.toBe(dark["--fanous-street-lights"]);
  });

  it("keeps the street next to the shell parts when a theme has both", () => {
    const pkg = structuredClone(builtinPackage("fawanees")!);
    pkg.theme["x-auth"] = { ...pkg.theme["x-auth"], sections: { ...pkg.theme["x-auth"]?.sections, adminShell: { "sidebar.background": "#101820" } } };
    const css = shellThemeCss(compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss);
    expect(css).toContain('[data-shell="sidebar"]{background:var(--auth-adminShell-sidebar-background)}');
    expect(css).toContain('html.fanous-street [data-shell="page"]{background:transparent}');
  });

  it("no street when the theme switches it off, or has none", () => {
    const pkg = structuredClone(builtinPackage("fawanees")!);
    pkg.theme.street = { ...pkg.theme.street!, enabled: false };
    expect(adminStreetCss(compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss)).toBe("");
    expect(adminStreetCss(compileBuiltin("lantern", "https://auth.example")!.tokensCss)).toBe("");
  });

  it("refuses CSS that could leave its style element, and CSS with no Fanous tokens", () => {
    expect(shellThemeCss(`${withShell()}</style><script>`)).toBe("");
    expect(shellThemeCss(":root{--x:1}")).toBe("");
  });

  it("keeps the admin's fallback palette when Auth can't answer", async () => {
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchShellTheme("https://auth.example", "c", failing)).toBe("");
    const notFound = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchShellTheme("https://auth.example", "c", notFound)).toBe("");
    const ok = (async (url: string) => {
      expect(url).toBe("https://auth.example/themes/resolve?client_id=c");
      return Response.json({ id: "x", css: withShell() });
    }) as unknown as typeof fetch;
    expect(await fetchShellTheme("https://auth.example", "c", ok)).toContain("data-shell");
  });

  it("asks Auth for the theme the link names (?theme=), ignoring malformed ids", async () => {
    const urls: string[] = [];
    const record = (async (url: string) => {
      urls.push(url);
      return Response.json({ id: "x", css: withShell() });
    }) as unknown as typeof fetch;
    await fetchShellTheme("https://auth.example", "c", record, "fawanees");
    await fetchShellTheme("https://auth.example", "c", record, "../x");
    expect(urls).toEqual(["https://auth.example/themes/resolve?client_id=c&theme=fawanees", "https://auth.example/themes/resolve?client_id=c"]);
  });
});
