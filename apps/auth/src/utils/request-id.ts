/**
 * Request ID propagation (Issue #95)
 *
 * Honors an incoming `X-Request-ID` header (if it looks like a sane identifier),
 * then Cloudflare's `CF-Ray`, and otherwise generates a UUID. The chosen ID is
 * used for logs/audit events and echoed back as `X-Request-ID` on the response.
 */

export const REQUEST_ID_HEADER = 'X-Request-ID';

/** Accept only short, printable, header-safe identifiers to avoid log injection. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(request: Request): string {
	const incoming = request.headers.get(REQUEST_ID_HEADER)?.trim();
	if (incoming && SAFE_REQUEST_ID.test(incoming)) {
		return incoming;
	}
	const ray = request.headers.get('CF-Ray')?.trim();
	if (ray && SAFE_REQUEST_ID.test(ray)) {
		return ray;
	}
	return crypto.randomUUID();
}

/**
 * Return a response carrying the X-Request-ID header. Responses with immutable
 * headers (e.g. from fetch() or Response.redirect()) are copied.
 */
export function withRequestId(response: Response, requestId: string): Response {
	// WebSocket upgrade responses must be returned untouched
	if (response.status === 101) {
		return response;
	}
	try {
		response.headers.set(REQUEST_ID_HEADER, requestId);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		copy.headers.set(REQUEST_ID_HEADER, requestId);
		return copy;
	}
}
