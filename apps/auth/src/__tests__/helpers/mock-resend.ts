/**
 * Resend without the network: while installed, every call to api.resend.com
 * answers like a successful send and is counted; other requests go to the
 * fetch that was there before. Swapped and put back as the same object (other
 * files replace globalThis.fetch at import time, see system-accounts.test.ts),
 * so miniflare's fetchMock can't be relied on across the suite.
 */
export function mockResend() {
	let previous: typeof fetch = globalThis.fetch;
	const sends: string[] = [];
	return {
		sends,
		install() {
			previous = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (new URL(url).hostname === 'api.resend.com') {
					sends.push(url);
					return new Response(JSON.stringify({ id: `mock-${sends.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				return previous(input as RequestInfo, init);
			}) as typeof fetch;
		},
		restore() {
			globalThis.fetch = previous;
		},
	};
}
