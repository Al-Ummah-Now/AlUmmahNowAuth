/**
 * QA only: lets per-PR web previews of the videos app sign in.
 *
 * The client registry matches redirect_uri exactly, so a preview Worker per PR
 * can't be listed in oauth_clients. When PREVIEW_WEB_CLIENT_ID and
 * PREVIEW_WORKERS_SUBDOMAIN are set (only in wrangler.qa.json) and this is the
 * QA environment, the one matching redirect_uri of the current /authorize
 * request is treated as registered for that one client. Everywhere else this
 * returns the database untouched.
 */

export interface PreviewRedirectEnv {
	ENVIRONMENT?: string;
	PREVIEW_WEB_CLIENT_ID?: string;
	PREVIEW_WORKERS_SUBDOMAIN?: string;
}

const CALLBACK = '/api/callback(?:/multi-account)?(?:\\?locale=(?:en|ar))?';

export function isPreviewRedirect(env: PreviewRedirectEnv, clientId: string | null, redirectUri: string | null): boolean {
	const subdomain = env.PREVIEW_WORKERS_SUBDOMAIN?.trim();
	const allowedClient = env.PREVIEW_WEB_CLIENT_ID?.trim();
	if (env.ENVIRONMENT !== 'qa' || !subdomain || !allowedClient) return false;
	if (!/^[a-z0-9-]+$/.test(subdomain) || clientId !== allowedClient || !redirectUri) return false;
	return new RegExp(`^https://al-ummah-web-pr-[0-9]+\\.${subdomain}\\.workers\\.dev${CALLBACK}$`).test(redirectUri);
}

function withRedirect(row: unknown, redirectUri: string): unknown {
	if (!row || typeof row !== 'object' || typeof (row as { redirect_uris?: unknown }).redirect_uris !== 'string') return row;
	const stored = row as { redirect_uris: string };
	const list = stored.redirect_uris.startsWith('[') ? (JSON.parse(stored.redirect_uris) as string[]) : stored.redirect_uris.split(',').map((u) => u.trim());
	return { ...stored, redirect_uris: JSON.stringify([...list, redirectUri]) };
}

/**
 * The database the client registry reads, with ONE exact redirect_uri added to ONE client's
 * registered list for this request only (the preview and scholar-site checks decide which).
 */
export function withAddedRedirect<T extends D1Database>(db: T, clientId: string, redirectUri: string): T {
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, property) {
				if (property === 'first') {
					return async (...args: unknown[]) => withRedirect(await (target.first as (...a: unknown[]) => Promise<unknown>)(...args), redirectUri);
				}
				if (property === 'bind') {
					return (...values: unknown[]) => (values[0] === clientId ? wrap(target.bind(...values)) : target.bind(...values));
				}
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});

	return new Proxy(db, {
		get(target, property) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query);
					return /from\s+oauth_clients/i.test(query) ? wrap(statement) : statement;
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/** The database the client registry reads for this request. */
export function withPreviewRedirects<T extends D1Database>(db: T, env: PreviewRedirectEnv, request: Request): T {
	const url = new URL(request.url);
	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');
	if (url.pathname !== '/authorize' || !isPreviewRedirect(env, clientId, redirectUri)) return db;
	return withAddedRedirect(db, clientId as string, redirectUri as string);
}
