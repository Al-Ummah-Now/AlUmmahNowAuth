/**
 * Scholar sites (AlUmmahNowUI apps/sites, wiki AUN-SCHOLAR-SITES §5.4/§9.3): every white-label site
 * signs in with one public PKCE client, "Al Ummah Now (sites)", from its own host's callback
 * `https://<host>/auth/callback`. Hosts come and go as admins grant sites and scholars add domains,
 * so they are not listed in oauth_clients. Instead, on /authorize for SITES_CLIENT_ID, the ONE exact
 * redirect_uri of the request is accepted when its host is a live site's primary host in the site
 * registry (api-videos `GET /api/sites/by-host/:host`). Never a wildcard: an exact host, checked
 * against the registry, per request (answers cached 60 s per isolate).
 *
 * The same check lets auth /logout return to a live site after a site's sign-out.
 */
export interface SiteRedirectEnv {
	SITES_CLIENT_ID?: string;
	/** api-videos base URL, e.g. https://videos.api.alummahnow.net (no trailing slash needed). */
	SITES_REGISTRY_URL?: string;
}

const CALLBACK = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\/auth\/callback$/;
/** Platform hosts are never sites, whatever the registry says. */
const PLATFORM = /(^|\.)alummahnow\.(net|com|app|link)$/;
const FRESH_MS = 60_000;
const memo = new Map<string, { at: number; live: boolean }>();

export function resetSiteRedirectCache(): void {
	memo.clear();
}

/** The host of a sites-client callback, or null when this request is not one. */
export function siteCallbackHost(env: SiteRedirectEnv, clientId: string | null, redirectUri: string | null): string | null {
	const client = env.SITES_CLIENT_ID?.trim();
	if (!client || clientId !== client || !redirectUri || !env.SITES_REGISTRY_URL) return null;
	const host = CALLBACK.exec(redirectUri)?.[1] ?? null;
	return host && !PLATFORM.test(host) ? host : null;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Is `host` the primary host of a live site? Fails closed (registry down → no). */
export async function isLiveSiteHost(env: SiteRedirectEnv, host: string, fetcher: Fetcher = (u, i) => fetch(u, i), now = Date.now()): Promise<boolean> {
	const base = env.SITES_REGISTRY_URL?.replace(/\/+$/, '');
	if (!base || PLATFORM.test(host)) return false;
	const cached = memo.get(host);
	if (cached && now - cached.at < FRESH_MS) return cached.live;
	let live = false;
	try {
		const res = await fetcher(`${base}/api/sites/by-host/${encodeURIComponent(host)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2_000) });
		if (res.ok) {
			const body = (await res.json()) as { redirectTo?: unknown; preview?: unknown; site?: { status?: unknown; primaryHost?: unknown } } | null;
			live = !body?.redirectTo && body?.preview !== true && body?.site?.status === 'live' && body.site.primaryHost === host;
		}
	} catch {
		return false; // not cached: try again on the next request
	}
	memo.set(host, { at: now, live });
	return live;
}

/** The redirect_uri this /authorize request may add for the sites client, or null. */
export async function allowedSiteRedirect(env: SiteRedirectEnv, request: Request, fetcher?: Fetcher): Promise<{ clientId: string; redirectUri: string } | null> {
	const url = new URL(request.url);
	if (url.pathname !== '/authorize') return null;
	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');
	const host = siteCallbackHost(env, clientId, redirectUri);
	if (!host || !(await isLiveSiteHost(env, host, fetcher))) return null;
	return { clientId: clientId as string, redirectUri: redirectUri as string };
}

/** Whether auth /logout may end on this URL: a live site's own page. */
export async function isSiteReturnUrl(env: SiteRedirectEnv, target: URL, fetcher?: Fetcher): Promise<boolean> {
	if (target.protocol !== 'https:' || !env.SITES_CLIENT_ID) return false;
	return isLiveSiteHost(env, target.hostname, fetcher);
}
