/**
 * The admin shell takes its look from Auth's theme for the admin app (its
 * client default, else the Auth default): the theme's `adminShell` section.
 * Only parts the theme sets are restyled; the rest keeps the admin's own look. The theme's
 * Fanous tokens always come along, for the shared header account menu (NAV_CSS).
 * Any failure keeps the admin as it is.
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

/**
 * The style for the admin shell from a resolved theme's token CSS ("" when the theme sets no
 * shell parts, no menu tokens and no lantern street). The street comes last, so its dark-scheme
 * values win over the theme's own street tokens.
 */
export function shellThemeCss(tokensCss: string): string {
  if (/<\/style|<!--/i.test(tokensCss)) return "";
  const rules = RULES.filter(([key]) => tokensCss.includes(`${VAR(key)}:`)).map(([key, css]) => css(`var(${VAR(key)})`));
  const street = adminStreetCss(tokensCss);
  // The header account button and menus (NAV_CSS, AlUmmahNow docs/design/NAV.md) read the theme's
  // Fanous tokens: keep them even when the theme restyles no shell part
  const menu = tokensCss.includes("--fanous-c-menu-bg:");
  if (!rules.length && !menu && !street) return "";
  // only the theme's custom properties are needed here, not its font imports
  const start = tokensCss.indexOf(":root{");
  const tokens = rules.length || menu ? `${start >= 0 ? tokensCss.slice(start) : tokensCss}\n${rules.join("\n")}` : "";
  return [tokens, street].filter(Boolean).join("\n");
}

/** The street tokens the shared module reads, and the primary colour its lantern glow uses. */
const STREET_DECL = /^--fanous-(?:street-[a-z-]+|color-primary):/;

/**
 * The Fanous lantern street in the admin (design: AlUmmahNow docs/design/FAWANEES-STREET.md).
 * The admin is a dark app whatever the device's setting, so it takes the theme's dark-scheme
 * street, over its own page colour (the body paints it; the page wrapper lets the street through).
 * "" when the theme has no street.
 */
export function adminStreetCss(tokensCss: string): string {
  const dark = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(tokensCss);
  if (!dark) return "";
  const decls = dark[1].split(";").map((d) => d.trim()).filter((d) => STREET_DECL.test(d));
  if (!decls.some((d) => /^--fanous-street-on:\s*1$/.test(d))) return "";
  return (
    `:root{${decls.join(";")}}\n` +
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
