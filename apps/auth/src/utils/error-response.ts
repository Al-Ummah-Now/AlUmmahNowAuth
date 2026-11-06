/**
 * Helpers that keep internal error details (SQL errors, library messages, stack
 * context) out of HTTP responses. Full errors are still logged by callers.
 */

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message, status }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * Return `error.message` only if it is one of the explicitly allowed,
 * user-facing messages; otherwise return `fallback`.
 */
export function safeErrorMessage(error: unknown, fallback: string, allowed: readonly string[] = []): string {
	if (error instanceof Error && allowed.includes(error.message)) {
		return error.message;
	}
	return fallback;
}

/**
 * Error response for admin handlers that call verifyAdminRequest() inside their
 * try block: auth failures (messages containing "required") map to a generic 401,
 * everything else to a generic 500 with `fallback` as the message.
 */
export function adminErrorResponse(error: unknown, fallback: string): Response {
	if (error instanceof Error && error.message.includes('required')) {
		return jsonError('Authentication required', 401);
	}
	return jsonError(fallback, 500);
}
