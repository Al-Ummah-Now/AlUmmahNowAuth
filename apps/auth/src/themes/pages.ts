/**
 * Puts the request's theme on what the issuer answered: HTML pages are
 * decorated (theme and page names, header graphic, in-flow links keep the
 * theme), redirects inside the flow keep ?theme=.
 */
import { carryThemeOnLocation, decorateHtml, pageKind, THEME_PARAM } from '../../../../packages/ui/src/auth-theme/decorate.ts';
import type { CompiledTheme } from '../../../../packages/ui/src/auth-theme/types.ts';

/** Browser page loads and form posts; token and JSON API calls skip theme work. */
export function wantsPage(request: Request): boolean {
	const accept = request.headers.get('Accept') ?? '';
	if (accept.includes('text/html')) return true;
	return request.method === 'POST' && (request.headers.get('Content-Type') ?? '').includes('application/x-www-form-urlencoded') && !accept.includes('application/json');
}

/** The theme id asked for on this request (?theme=). */
export function requestedTheme(url: URL): string | null {
	const v = url.searchParams.get(THEME_PARAM);
	return v && /^[a-z][a-z0-9-]{1,39}$/.test(v) ? v : null;
}

export async function finishThemedResponse(response: Response, compiled: CompiledTheme, url: URL, issuerOrigin: string): Promise<Response> {
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get('Location');
		if (!location) return response;
		const carried = carryThemeOnLocation(location, issuerOrigin, compiled.id);
		if (carried === location) return response;
		const headers = new Headers(response.headers);
		headers.set('Location', carried);
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
	if (!(response.headers.get('Content-Type') ?? '').includes('text/html')) return response;
	const html = await response.text();
	const headers = new Headers(response.headers);
	headers.delete('Content-Length');
	const body = decorateHtml(html, compiled, { page: pageKind(url.pathname, html), carryTheme: compiled.id, street: true });
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
