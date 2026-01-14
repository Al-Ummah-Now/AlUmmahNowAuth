/**
 * @fileoverview User agent parsing utilities
 *
 * Parses user agent strings to extract device type, browser, and OS information
 */

export interface ParsedUserAgent {
	deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
	deviceName: string;
	browser: string;
	os: string;
}

/**
 * Parse a user agent string to extract device and browser information
 *
 * @param ua - The user agent string from the request
 * @returns Parsed device type, device name, browser, and OS
 *
 * @example
 * const parsed = parseUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0');
 * // Returns: { deviceType: 'desktop', browser: 'Chrome', os: 'Windows', deviceName: 'Chrome on Windows' }
 */
export function parseUserAgent(ua: string): ParsedUserAgent {
	const result: ParsedUserAgent = {
		deviceType: 'unknown',
		deviceName: 'Unknown Device',
		browser: 'Unknown',
		os: 'Unknown',
	};

	if (!ua) return result;

	// Detect OS
	if (ua.includes('Windows')) result.os = 'Windows';
	else if (ua.includes('Mac OS X')) result.os = 'macOS';
	else if (ua.includes('Linux')) result.os = 'Linux';
	else if (ua.includes('Android')) result.os = 'Android';
	else if (ua.includes('iPhone') || ua.includes('iPad')) result.os = 'iOS';
	else if (ua.includes('CrOS')) result.os = 'Chrome OS';

	// Detect Browser
	if (ua.includes('Chrome') && !ua.includes('Edg')) result.browser = 'Chrome';
	else if (ua.includes('Firefox')) result.browser = 'Firefox';
	else if (ua.includes('Safari') && !ua.includes('Chrome')) result.browser = 'Safari';
	else if (ua.includes('Edg')) result.browser = 'Edge';
	else if (ua.includes('Opera') || ua.includes('OPR')) result.browser = 'Opera';

	// Detect Device Type
	if (ua.includes('Mobile') || (ua.includes('Android') && !ua.includes('Tablet'))) {
		result.deviceType = 'mobile';
	} else if (ua.includes('iPad') || ua.includes('Tablet')) {
		result.deviceType = 'tablet';
	} else if (ua.includes('Windows') || ua.includes('Macintosh') || ua.includes('Linux')) {
		result.deviceType = 'desktop';
	}

	// Build device name
	result.deviceName = `${result.browser} on ${result.os}`;

	return result;
}
