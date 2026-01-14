/**
 * @fileoverview OAuth callback handler
 *
 * Handles the OAuth callback endpoint. Note that this endpoint has a
 * fundamental issue - the auth server cannot call client.exchange() on
 * itself as it causes a 522 timeout. This handler exists mainly for
 * documentation and proper error handling.
 */

import { logger } from '../logger';
import { addSecurityHeaders } from '../utils/security-headers';

interface CallbackContext {
	waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Handle OAuth callback request
 *
 * Note: This callback endpoint has a fundamental issue - the auth server
 * cannot call client.exchange() on itself as it causes a 522 timeout.
 * The OpenAuth issuer handles OAuth flows internally, so this custom
 * callback is redundant and problematic.
 *
 * Proper solution: Remove this endpoint and handle auth via OpenAuth's
 * built-in success callback or use a separate client app
 *
 * @param request - The incoming request
 * @param ctx - Execution context
 * @param isProduction - Whether running in production
 * @returns Response redirecting with error or result
 */
export async function handleCallback(
	request: Request,
	ctx: CallbackContext,
	isProduction: boolean
): Promise<Response> {
	const url = new URL(request.url);

	logger.debug('Handling OAuth callback');
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');

	if (error) {
		logger.warn('OAuth callback error', { error });
		ctx.waitUntil(logger.finalizeRequest());
		const response = Response.redirect(
			`${url.origin}/?error=${encodeURIComponent(error)}`,
			302
		);
		return addSecurityHeaders(response, isProduction);
	}

	if (!code) {
		logger.warn('OAuth callback failed', { reason: 'missing_code' });
		ctx.waitUntil(logger.finalizeRequest());
		const response = Response.redirect(`${url.origin}/?error=missing_code`, 302);
		return addSecurityHeaders(response, isProduction);
	}

	// Log warning about self-calling issue
	logger.warn('Auth server /callback endpoint hit - this causes 522 errors', {
		hasCode: !!code,
		issue: 'Cannot exchange tokens with self',
		solution: 'Use OpenAuth internal flow or deploy separate client',
	});

	// Redirect to home with error message
	ctx.waitUntil(logger.finalizeRequest());
	const response = Response.redirect(`${url.origin}/?error=callback_not_supported`, 302);
	return addSecurityHeaders(response, isProduction);
}
