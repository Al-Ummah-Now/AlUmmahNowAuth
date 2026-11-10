import { BUILTIN_IDS } from '../../../../packages/ui/src/auth-theme/builtin.ts';
import { AUTH_ICONS, faviconSvgPath, iconServer } from '../../../../packages/ui/src/app-icons/index.ts';

/** Sign-in's tab and app icons (the owner's keyhole lantern, cropped and downscaled by AlUmmahNow packages/app-icons). */
export const serveIcon = iconServer(AUTH_ICONS);

/**
 * The sign-in page's tab icon: the sign-in mark for the environment (QA/stage get a corner dot),
 * unless a custom theme brings its own favicon. Built-in themes all carry the old site raster.
 */
export function signInFavicon(theme: { id: string; openauth: { favicon?: string } }, environment: string | undefined): string {
  if (theme.openauth.favicon && !BUILTIN_IDS.includes(theme.id)) return theme.openauth.favicon;
  return faviconSvgPath(environment);
}
