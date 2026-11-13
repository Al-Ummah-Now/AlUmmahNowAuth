/** A uniformly random string of `length` decimal digits (rejection sampling, no modulo bias). */
export function generateUnbiasedCode(length: number): string {
	let out = '';
	while (out.length < length) {
		const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
		for (const b of bytes) {
			if (b < 250 && out.length < length) out += String(b % 10);
		}
	}
	return out;
}
