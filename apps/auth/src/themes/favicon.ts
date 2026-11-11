import { BUILTIN_IDS } from '../../../../packages/ui/src/auth-theme/builtin.ts';
// only this app's set, so the profile icons are not bundled into the auth Worker
import { APP_ICONS as AUTH_ICONS } from '../../../../packages/ui/src/app-icons/auth.generated.ts';
import { iconServer, tabIconPath } from '../../../../packages/ui/src/app-icons/serve.ts';

/** Sign-in's tab and app icons (the owner's keyhole lantern, cropped and downscaled by AlUmmahNow packages/app-icons). */
export const serveIcon = iconServer(AUTH_ICONS);

/**
 * The sign-in page's tab icon: the sign-in mark for the environment (QA/stage get a corner dot),
 * unless a custom theme brings its own favicon. OpenAuth links one icon: in production the ICO
 * (16/32/48, the browser picks the frame), never an SVG it would blur. Built-in themes all carry the old site raster.
 */
export function signInFavicon(theme: { id: string; openauth: { favicon?: string } }, environment: string | undefined): string {
  if (theme.openauth.favicon && !BUILTIN_IDS.includes(theme.id)) return theme.openauth.favicon;
  return tabIconPath(environment);
}
