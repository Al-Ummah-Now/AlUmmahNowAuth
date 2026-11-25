/**
 * Every answer for a path under /account is about one person: it has the
 * security headers and is never cached, whoever made it (a route here, a 404 of
 * the issuer, a 405, a 429, a 503 or the error page).
 */
import { addSecurityHeaders } from './security-headers';

export function isAccountPath(pathname: string): boolean {
	return pathname === '/account' || pathname.startsWith('/account/');
}

export function protectAccountAnswer(pathname: string, response: Response, isProduction: boolean): Response {
	if (!isAccountPath(pathname)) return response;
	const answer = addSecurityHeaders(response, isProduction);
	const cacheControl = answer.headers.get('Cache-Control') ?? '';
	if (!/\bno-store\b/.test(cacheControl)) answer.headers.set('Cache-Control', 'no-store');
	return answer;
}
