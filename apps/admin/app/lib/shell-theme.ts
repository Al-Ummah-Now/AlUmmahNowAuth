/**
 * The admin shell takes its look from Auth's theme for the admin app (its
 * client default, else the Auth default): the theme's `adminShell` section.
 * Only parts the theme sets are restyled; the rest keeps the admin's own look.
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

/** The style for the admin shell from a resolved theme's token CSS ("" when the theme sets no shell parts). */
export function shellThemeCss(tokensCss: string): string {
  if (/<\/style|<!--/i.test(tokensCss)) return "";
  const rules = RULES.filter(([key]) => tokensCss.includes(`${VAR(key)}:`)).map(([key, css]) => css(`var(${VAR(key)})`));
  if (!rules.length) return "";
  // only the theme's custom properties are needed here, not its font imports
  const start = tokensCss.indexOf(":root{");
  return `${start >= 0 ? tokensCss.slice(start) : tokensCss}\n${rules.join("\n")}`;
}

const TIMEOUT_MS = 500;
const TTL_SECONDS = 30;

export async function fetchShellTheme(authServerUrl: string, clientId: string, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const url = new URL("/themes/resolve", authServerUrl);
    url.searchParams.set("client_id", clientId);
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
