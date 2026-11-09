/**
 * account.* is a convenience alias for the profile app: every request to it is
 * redirected (301) to the same path and query on the profile host (APP_URL).
 * The alias serves no pages and has no OAuth redirect URIs of its own.
 */
export function aliasRedirect(requestUrl: string, appUrl: string | undefined): Response | null {
  if (!appUrl) return null;
  const url = new URL(requestUrl);
  if (!url.hostname.startsWith('account.')) return null;
  const target = new URL(appUrl);
  if (url.hostname === target.hostname) return null;
  target.pathname = url.pathname;
  target.search = url.search;
  return new Response(null, { status: 301, headers: { Location: target.toString() } });
}
