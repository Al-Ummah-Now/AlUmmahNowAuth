import { describe, expect, it } from "vitest";
import { compileTheme } from "../../../../packages/ui/src/auth-theme/compile.ts";
import { builtinPackage, compileBuiltin } from "../../../../packages/ui/src/auth-theme/builtin.ts";
import { fetchShellTheme, shellThemeCss } from "./shell-theme";

const withShell = () => {
  const pkg = structuredClone(builtinPackage("nahas")!);
  pkg.theme["x-auth"] = { ...pkg.theme["x-auth"], sections: { ...pkg.theme["x-auth"]?.sections, adminShell: { "sidebar.background": "#101820", "sidebar.active": { light: "#f4ae3a", dark: "#e0962a" } } } };
  return compileTheme(pkg, { assetUrl: (p) => p, svgText: {} }).tokensCss;
};

describe("admin shell theme", () => {
  it("restyles nothing when the theme has no admin shell parts (today's built-ins)", () => {
    for (const id of ["classic", "fawanees", "lantern", "nahas", "zujaj"]) expect(shellThemeCss(compileBuiltin(id, "https://auth.example")!.tokensCss)).toBe("");
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
});
