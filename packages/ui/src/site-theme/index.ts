import { GRAPHIC_CSS, THEME_ASSETS, type ThemeAssets } from './generated';

/** The site-wide theme, chosen in the videos admin site. Light and dark follow the viewer's device here. */
export const SITE_THEMES = ['lantern', 'zujaj', 'nahas', 'fawanees'] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];
export const DEFAULT_SITE_THEME: SiteTheme = 'fawanees';

const TTL_SECONDS = 30;
const TIMEOUT_MS = 500;

export function resolveSiteTheme(value: unknown): SiteTheme {
  return (SITE_THEMES as readonly unknown[]).includes(value) ? (value as SiteTheme) : DEFAULT_SITE_THEME;
}

/**
 * The current site theme. Any failure, including the videos side not having
 * the endpoint yet, is Fawanees, so this repo can ship before or after it.
 */
export async function fetchSiteTheme(adminApiUrl: string | undefined, fetcher: typeof fetch = fetch): Promise<SiteTheme> {
  if (!adminApiUrl) return DEFAULT_SITE_THEME;
  try {
    const response = await fetcher(`${adminApiUrl}/public/site-theme`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) return DEFAULT_SITE_THEME;
    return resolveSiteTheme(((await response.json()) as { theme?: unknown }).theme);
  } catch {
    return DEFAULT_SITE_THEME;
  }
}

export function themeAssets(theme: SiteTheme): ThemeAssets {
  return THEME_ASSETS[theme];
}

/** Tokens for the page, then the sign-in graphic's variables. */
export function themeCss(theme: SiteTheme): string {
  return `${THEME_ASSETS[theme].css}${GRAPHIC_CSS}`;
}
