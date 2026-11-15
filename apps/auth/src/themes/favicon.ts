import { BUILTIN_IDS } from '../../../../packages/ui/src/auth-theme/builtin.ts';
// only this app's set, so the profile icons are not bundled into the auth Worker
import { APP_ICONS as AUTH_ICONS } from '../../../../packages/ui/src/app-icons/auth.generated.ts';
import { iconServer, tabIconPath } from '../../../../packages/ui/src/app-icons/serve.ts';
import { NAV_ICONS } from '../../../../packages/ui/src/nav/aun-nav-icons.generated.ts';
import { LOGO_SRC } from '../../../../packages/ui/src/nav/page-header.ts';

/** What the sign-in pages' header shows (AlUmmahNow docs/design/NAV.md "Header"): the owner's logo (no links to other sites). */
export const HEADER_ICON_PATHS = [LOGO_SRC] as const;

/** Sign-in's tab and app icons (the owner's keyhole lantern, cropped and downscaled by AlUmmahNow packages/app-icons), and the header's. */
export const serveIcon = iconServer({ ...AUTH_ICONS, ...Object.fromEntries(HEADER_ICON_PATHS.map((p) => [p, NAV_ICONS[p]])) });

/**
 * The sign-in page's tab icon: the sign-in mark for the environment (QA/stage get a corner dot),
 * unless a custom theme brings its own favicon. OpenAuth links one icon: in production the ICO
 * (16/32/48, the browser picks the frame), never an SVG it would blur. Built-in themes all carry the old site raster.
 */
export function signInFavicon(theme: { id: string; openauth: { favicon?: string } }, environment: string | undefined): string {
  if (theme.openauth.favicon && !BUILTIN_IDS.includes(theme.id)) return theme.openauth.favicon;
  return tabIconPath(environment);
}
