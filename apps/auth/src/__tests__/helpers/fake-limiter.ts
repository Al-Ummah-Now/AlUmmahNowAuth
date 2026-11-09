/**
 * A Workers Rate Limiting binding stand-in: an exact counter per key (the real
 * binding counts per location within its period). Records the keys it saw.
 */
export function fakeLimiter(limit: number) {
	const counts = new Map<string, number>();
	return {
		counts,
		async limit({ key }: { key: string }) {
			const n = (counts.get(key) ?? 0) + 1;
			counts.set(key, n);
			return { success: n <= limit };
		},
	};
}
