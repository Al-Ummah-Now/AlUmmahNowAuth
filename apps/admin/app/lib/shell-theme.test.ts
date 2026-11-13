import { describe, expect, it } from "vitest";
import { compileTheme } from "../../../../packages/ui/src/auth-theme/compile.ts";
import { builtinPackage, compileBuiltin } from "../../../../packages/ui/src/auth-theme/builtin.ts";
import { adminStreetCss, fetchShellTheme, shellThemeCss } from "./shell-theme";

const withShell = () => {
  const pkg = structuredClone(builtinPackage("nahas")!);
  pkg.theme["x-auth"] = { ...pkg.theme["x-auth"], sections: { ...pkg.theme["x-auth"]?.sections, adminShell: { "sidebar.background": "#101820", "sidebar.active": { light: "#f4ae3a", dark: "#e0962a" } } } };
  return compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss;
};

describe("admin shell theme", () => {
  it("restyles no shell part when the theme sets none (today's built-ins but Fawanees), but keeps its Fanous tokens for the account menu", () => {
    for (const id of ["classic", "lantern", "nahas", "zujaj"]) {
      const css = shellThemeCss(compileBuiltin(id, "https://auth.example")!.tokensCss);
      expect(css).not.toContain('[data-shell=');
      expect(css).toContain("--fanous-c-menu-bg:");
      expect(css).not.toMatch(/@import|@font-face/);
    }
  });

  it("Fawanees: the menu tokens, then the lantern street in its dark-scheme colours over the admin's own page colour", () => {
    const tokens = compileBuiltin("fawanees", "https://auth.example")!.tokensCss;
    const css = shellThemeCss(tokens);
    const street = adminStreetCss(tokens);
    expect(css).toContain("--fanous-c-menu-bg:");
    expect(css.endsWith(street)).toBe(true);
    expect(css).not.toMatch(/@import|@font-face|\[data-shell="sidebar"\]/);
    expect(street).toMatch(/^:root\{--fanous-color-primary: #[0-9a-f]{6};--fanous-street-on: 1;/);
    // dark scheme values (Fawanees dark: line #f5cf9242, glow 0.6, the dark lights file)
    expect(street).toContain("--fanous-street-line: #f5cf9242");
    expect(street).toContain("--fanous-street-glow: 0.6");
    expect(street).not.toContain("#d8cebdff");
    const dark = builtinPackage("fawanees")!.assets["assets/street-lights-dark.svg"]!.hash;
    expect(street).toContain(`--fanous-street-lights: url("https://auth.example/themes/assets/${dark}")`);
    expect(street).toContain('html.fanous-street [data-shell="page"]{background:transparent}');
    // the street block carries no other theme colours
    expect(street).not.toMatch(/--fanous-color-(?!primary)/);
  });

  it("keeps the street next to the shell parts when a theme has both", () => {
    const pkg = structuredClone(builtinPackage("fawanees")!);
    pkg.theme["x-auth"] = { ...pkg.theme["x-auth"], sections: { ...pkg.theme["x-auth"]?.sections, adminShell: { "sidebar.background": "#101820" } } };
    const css = shellThemeCss(compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss);
    expect(css).toContain('[data-shell="sidebar"]{background:var(--auth-adminShell-sidebar-background)}');
    expect(css).toContain('html.fanous-street [data-shell="page"]{background:transparent}');
  });

  it("no street when the theme switches it off", () => {
    const pkg = structuredClone(builtinPackage("fawanees")!);
    pkg.theme.street = { ...pkg.theme.street!, enabled: false };
    expect(adminStreetCss(compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss)).toBe("");
  });

  it("restyles only the parts the theme sets, with its variables and no font imports", () => {
    const css = shellThemeCss(withShell());
    expect(css).toContain('[data-shell="sidebar"]{background:var(--auth-adminShell-sidebar-background)}');
    expect(css).toContain('[data-shell="sidebar"] a[aria-current="page"]{background:var(--auth-adminShell-sidebar-active)}');
    expect(css).not.toContain(`[data-shell="header"]`);
    expect(css).not.toMatch(/@import|@font-face/);
    expect(css).toMatch(/--auth-adminShell-sidebar-background:\s*#101820/);
  });

  it("refuses CSS that could leave its style element", () => {
    expect(shellThemeCss(`${withShell()}</style><script>`)).toBe("");
  });

  it("keeps the admin as it is when Auth can't answer", async () => {
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
