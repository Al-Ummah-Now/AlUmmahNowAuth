/**
 * The admin takes its look from Auth's theme for the admin app (its client default, else the
 * Auth default), in light and dark: the theme's Fanous tokens (roles, component colours,
 * materials) colour the whole admin (app/tailwind.css maps them), and the theme's `adminShell`
 * section restyles the shell parts it sets, with its light and dark values. The admin shows the
 * mode the user chose (lib/color-mode.ts: `.light` / `.dark` on <html>), so the theme's
 * per-scheme blocks are scoped to that class here. Any failure keeps the admin's fallback palette.
 */

const VAR = (key: string) => `--auth-adminShell-${key}`;

/** Admin shell parts → the CSS that applies a theme variable to them. */
const RULES: [key: string, css: (v: string) => string][] = [
  ["sidebar-background", (v) => `[data-shell="sidebar"]{background:${v}}`],
  ["sidebar-text", (v) => `[data-shell="sidebar"] a:not([aria-current="page"]){color:${v}}`],
  ["sidebar-active", (v) => `[data-shell="sidebar"] a[aria-current="page"]{background:${v}}`],
  ["sidebar-active-text", (v) => `[data-shell="sidebar"] a[aria-current="page"]{color:${v}}`],
  ["header-background", (v) => `[data-shell="header"]{background:${v}}`],
  ["header-text", (v) => `[data-shell="header"],[data-shell="header"] h1{color:${v}}`],
  ["page-background", (v) => `[data-shell="page"]{background:${v}}`],
  ["accent", (v) => `[data-shell="page"] a:focus-visible,[data-shell="page"] button:focus-visible{outline-color:${v}}[data-shell="header"]{border-bottom-color:${v}}`],
];

/** One scheme's custom properties, as the Auth theme compiler emits them. */
const SCHEME_BLOCK = /@media\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*\{\s*:root\s*\{([^{}]*)\}\s*\}/g;

/**
 * The theme's per-scheme token blocks keyed on the admin's mode class instead of the device:
 * `.light` / `.dark` on <html> wins; with neither (no script ran) the device decides, as before.
 */
export function modeScopedCss(tokensCss: string): string {
  return tokensCss.replace(SCHEME_BLOCK, (_m, scheme: "light" | "dark", body: string) => {
    const other = scheme === "light" ? "dark" : "light";
    return `:root.${scheme}{${body}}@media(prefers-color-scheme:${scheme}){:root:not(.${other}){${body}}}`;
  });
}

/**
 * The style for the admin from a resolved theme's token CSS: its tokens scoped per mode, the
 * `adminShell` parts it sets, and the lantern street's page rules when the theme has a street.
 * "" when the CSS has no Fanous tokens or could leave its style element.
 */
export function shellThemeCss(tokensCss: string): string {
  if (/<\/style|<!--/i.test(tokensCss)) return "";
  // only the theme's custom properties are needed here, not its font imports
  const start = tokensCss.indexOf(":root{");
  if (start < 0 || !tokensCss.includes("--fanous-color-background:")) return "";
  const tokens = modeScopedCss(tokensCss.slice(start));
  const rules = RULES.filter(([key]) => tokensCss.includes(`${VAR(key)}:`)).map(([key, css]) => css(`var(${VAR(key)})`));
  return [tokens, ...rules, adminStreetCss(tokensCss)].filter(Boolean).join("\n");
}

/**
 * The Fanous lantern street in the admin (design: AlUmmahNow docs/design/FAWANEES-STREET.md). It
 * follows the mode like the profile app: the street's tokens are part of the theme's per-scheme
 * blocks, so the light street shows in light mode and the dark street in dark. Here: the page
 * wrapper lets the street through (the body paints the page colour), and room for garlands.
 * "" when the theme has no street in either scheme.
 */
export function adminStreetCss(tokensCss: string): string {
  const on = [...tokensCss.matchAll(SCHEME_BLOCK)].some(([, , body]) => /(?:^|;)\s*--fanous-street-on:\s*1\s*(?:;|$)/.test(body));
  if (!on) return "";
  return (
    `html.fanous-street [data-shell="page"]{background:transparent}\n` +
    // Room for garlands: below short pages, and one band at the end of every page
    `html.fanous-street [data-shell="page"]>main{min-height:100vh;padding-bottom:96px}`
  );
}

const TIMEOUT_MS = 500;
const TTL_SECONDS = 30;

export async function fetchShellTheme(authServerUrl: string, clientId: string, fetcher: typeof fetch = fetch, requested?: string | null): Promise<string> {
  try {
    const url = new URL("/themes/resolve", authServerUrl);
    url.searchParams.set("client_id", clientId);
    // A theme the link asks for (?theme=, if Auth publishes it), like the profile app
    if (requested && /^[a-z][a-z0-9-]{1,39}$/.test(requested)) url.searchParams.set("theme", requested);
    const response = await fetcher(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) return "";
    const body = (await response.json()) as { css?: unknown };
    return typeof body.css === "string" ? shellThemeCss(body.css) : "";
  } catch {
    return "";
  }
}
