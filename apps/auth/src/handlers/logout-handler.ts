/**
 * @fileoverview Logout handler
 *
 * Handles user logout by clearing sessions and emitting audit events.
 */

import { logger } from '../logger';
import { getUserSession, deleteSession, clearSessionCookie } from '../session';
import { getClientIP } from '../rate-limit';
import { getAuditEmitter } from '../audit-emitter';
import { createLogoutEvent } from '../audit-events';
import { trackEvent } from '../utils/analytics';
import { addSecurityHeaders } from '../utils/security-headers';

interface LogoutEnv {
	AUTH_STORAGE: KVNamespace;
	AUTH_ANALYTICS?: AnalyticsEngineDataset;
}

interface LogoutContext {
	waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Handle logout request
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param ctx - Execution context
 * @param requestId - Request ID for audit logging
 * @param isProduction - Whether running in production
 * @returns Response redirecting to homepage with cleared cookie
 */
export async function handleLogout(
	request: Request,
	env: LogoutEnv,
	ctx: LogoutContext,
	requestId: string,
	isProduction: boolean
): Promise<Response> {
	const url = new URL(request.url);

	logger.debug('Handling logout request');

	// Get user session before deleting it
	const session = await getUserSession(request, env.AUTH_STORAGE);
	const userId = session?.user?.id;

	// Delete session from KV
	await deleteSession(request, env.AUTH_STORAGE);
	logger.info('User logged out');

	// Emit logout audit event
	if (userId) {
		const clientIP = getClientIP(request);
		const auditEvent = createLogoutEvent(userId, {
			ipAddress: clientIP,
			userAgent: request.headers.get('User-Agent') ?? undefined,
			requestId,
		});
		ctx.waitUntil(getAuditEmitter().emit(auditEvent));

		// Track logout in analytics
		trackEvent(env, {
			event: 'logout',
			userId,
			ipAddress: clientIP,
			userAgent: request.headers.get('User-Agent') ?? undefined,
			success: true,
		});
	}

	// Finalize request before returning
	ctx.waitUntil(logger.finalizeRequest());

	// Redirect to homepage with cleared cookie
	const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	const response = new Response(null, {
		status: 302,
		headers: {
			Location: url.origin,
			'Set-Cookie': clearSessionCookie(isLocalhost),
		},
	});

	return addSecurityHeaders(response, isProduction);
}
