/**
 * The profile page's theme comes from Auth (managed in the Auth admin): the
 * theme Auth resolves for this client, or one the link asks for (?theme=, if
 * Auth publishes it). Any failure keeps the built-in default.
 */
import { compileBuiltin } from '../../../packages/ui/src/auth-theme/builtin.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../packages/ui/src/auth-theme/resolve.ts';

const TTL_SECONDS = 30;
const TIMEOUT_MS = 500;

export interface PageTheme { id: string; css: string }

export function defaultTheme(authServerUrl: string): PageTheme {
  return { id: BUILTIN_DEFAULT_THEME, css: compileBuiltin(BUILTIN_DEFAULT_THEME, authServerUrl)!.tokensCss };
}

export async function fetchAuthTheme(
  authServerUrl: string,
  clientId: string,
  requested: string | null,
  fetcher: typeof fetch = fetch,
): Promise<PageTheme> {
  const url = new URL('/themes/resolve', authServerUrl);
  url.searchParams.set('client_id', clientId);
  if (requested && /^[a-z][a-z0-9-]{1,39}$/.test(requested)) url.searchParams.set('theme', requested);
  try {
    const response = await fetcher(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) return defaultTheme(authServerUrl);
    const body = (await response.json()) as { id?: unknown; css?: unknown };
    if (typeof body.id !== 'string' || typeof body.css !== 'string' || /<\/style/i.test(body.css)) return defaultTheme(authServerUrl);
    return { id: body.id, css: body.css };
  } catch {
    return defaultTheme(authServerUrl);
  }
}
