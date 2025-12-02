/**
 * @fileoverview Session authentication middleware for Hono routes
 *
 * Provides middleware for requiring browser sessions and active accounts.
 * Used by session management APIs to enforce authentication.
 */

/**
 * Middleware that requires a valid browser session with active account
 *
 * Returns 401 if:
 * - No browser session exists
 * - No active account in the session
 *
 * @example
 * ```typescript
 * app.get('/session/accounts', requireSession, async (c) => {
 *   const browserSession = c.get('browserSession');
 *   const activeAccount = c.get('activeAccount');
 *   // Both are guaranteed to be set
 * });
 * ```
 */
export async function requireSession(c: any, next: () => Promise<void>): Promise<Response | void> {
	const browserSession = c.get('browserSession');
	const activeAccount = c.get('activeAccount');

	if (!browserSession) {
		return c.json({ error: 'No session found' }, 401);
	}

	if (!activeAccount) {
		return c.json({ error: 'No active account in session' }, 401);
	}

	await next();
}

/**
 * Middleware that requires browser session but not necessarily active account
 *
 * Returns 401 if:
 * - No browser session exists
 *
 * @example
 * ```typescript
 * app.post('/session/add-account', requireBrowserSession, async (c) => {
 *   const browserSession = c.get('browserSession');
 *   // Browser session is guaranteed to be set
 * });
 * ```
 */
export async function requireBrowserSession(c: any, next: () => Promise<void>): Promise<Response | void> {
	const browserSession = c.get('browserSession');

	if (!browserSession) {
		return c.json({ error: 'No session found' }, 401);
	}

	await next();
}

/**
 * Optional session middleware - doesn't fail if no session
 *
 * This middleware is a no-op. It's used to mark routes as session-aware
 * without enforcing session requirements. The session loading is handled
 * by the main middleware chain.
 *
 * @example
 * ```typescript
 * app.get('/public', optionalSession, async (c) => {
 *   const browserSession = c.get('browserSession'); // May be undefined
 *   // Handle both authenticated and unauthenticated cases
 * });
 * ```
 */
export async function optionalSession(c: any, next: () => Promise<void>): Promise<void> {
	// Session is already loaded in the main middleware
	// This just marks the route as session-aware
	await next();
}
