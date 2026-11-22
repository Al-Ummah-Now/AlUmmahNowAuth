/**
 * A coarse browser and OS from a User-Agent, for the passkey-failure audit
 * (AUTH-PASSKEYS "Failures"): enough to see a pattern ("Safari on iOS keeps
 * failing") without keeping a fingerprint. Never versions or device models.
 */
export type Browser = 'Edge' | 'Opera' | 'Samsung Internet' | 'Firefox' | 'Chrome' | 'Safari' | 'Other';
export type Os = 'iOS' | 'iPadOS' | 'Android' | 'Windows' | 'macOS' | 'ChromeOS' | 'Linux' | 'Other';

export function coarseAgent(ua: string | null | undefined): { browser: Browser; os: Os } {
	const s = (ua ?? '').slice(0, 512);
	// Order matters: Edge, Opera and Samsung say "Chrome" too; every iOS browser says "Safari"
	const browser: Browser = /Edg(e|A|iOS)?\//.test(s)
		? 'Edge'
		: /OPR\/|Opera/.test(s)
			? 'Opera'
			: /SamsungBrowser\//.test(s)
				? 'Samsung Internet'
				: /Firefox\/|FxiOS\//.test(s)
					? 'Firefox'
					: /Chrome\/|CriOS\//.test(s)
						? 'Chrome'
						: /Safari\//.test(s)
							? 'Safari'
							: 'Other';
	const os: Os = /iPad/.test(s)
		? 'iPadOS'
		: /iPhone|iPod/.test(s)
			? 'iOS'
			: /Android/.test(s)
				? 'Android'
				: /Windows/.test(s)
					? 'Windows'
					: /CrOS/.test(s)
						? 'ChromeOS'
						: /Mac OS X|Macintosh/.test(s)
							? 'macOS'
							: /Linux/.test(s)
								? 'Linux'
								: 'Other';
	return { browser, os };
}

/** What the page may report; anything else is recorded as "failed". */
export const FAILURE_REASONS = ['failed', 'cancelled', 'network', 'expired'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export function failureReason(value: unknown): FailureReason {
	return (FAILURE_REASONS as readonly unknown[]).includes(value) ? (value as FailureReason) : 'failed';
}
