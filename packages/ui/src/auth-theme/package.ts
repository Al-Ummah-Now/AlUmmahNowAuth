/** Content hashes for stored packages and files (keys never change, so KV never serves a stale one). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
