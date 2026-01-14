/**
 * @fileoverview Host header validation for defense-in-depth tenant resolution
 *
 * Provides validation of Host headers before using them for tenant lookup.
 * This is a defense-in-depth measure - the primary protection is the DB lookup
 * which only returns valid tenants.
 */

import { logger } from '../logger';

/**
 * Known allowed domain patterns for the application.
 * These are the main domains that are expected for tenant resolution.
 */
const KNOWN_DOMAIN_PATTERNS = [
	// Production and QA domains
	'.alummahnow.net',
	// Workers dev domains (for preview deployments)
	'.workers.dev',
	// Cloudflare Pages domains (for preview deployments)
	'.pages.dev',
];

/**
 * Development-only allowed hosts
 */
const DEVELOPMENT_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0'];

/**
 * Maximum reasonable length for a host header
 * Prevents potential DoS via extremely long headers
 */
const MAX_HOST_LENGTH = 253; // DNS max domain name length

/**
 * Result of host validation
 */
export interface HostValidationResult {
	/** Whether the host is valid for tenant resolution */
	isValid: boolean;
	/** The normalized host (lowercase, port stripped) */
	normalizedHost: string;
	/** Whether the host is a known/expected pattern */
	isKnownPattern: boolean;
	/** Reason for validation failure (if invalid) */
	reason?: string;
}

/**
 * Validate and normalize a host header for tenant resolution
 *
 * @param host - The raw Host header value
 * @param isDevelopment - Whether running in development mode
 * @returns Validation result with normalized host
 *
 * @example
 * validateHost('auth.alummahnow.net', false);
 * // { isValid: true, normalizedHost: 'auth.alummahnow.net', isKnownPattern: true }
 *
 * validateHost('localhost:8787', true);
 * // { isValid: true, normalizedHost: 'localhost', isKnownPattern: true }
 *
 * validateHost('evil.com', false);
 * // { isValid: true, normalizedHost: 'evil.com', isKnownPattern: false }
 * // (valid but will be logged as suspicious; DB lookup will handle rejection)
 */
export function validateHost(host: string, isDevelopment: boolean = false): HostValidationResult {
	// Handle empty or missing host
	if (!host || host.trim() === '') {
		return {
			isValid: false,
			normalizedHost: '',
			isKnownPattern: false,
			reason: 'Empty or missing Host header',
		};
	}

	// Check length limit
	if (host.length > MAX_HOST_LENGTH) {
		return {
			isValid: false,
			normalizedHost: '',
			isKnownPattern: false,
			reason: `Host header exceeds maximum length (${MAX_HOST_LENGTH})`,
		};
	}

	// Normalize: lowercase and strip port
	const normalizedHost = normalizeHost(host);

	// Basic format validation
	if (!isValidHostFormat(normalizedHost)) {
		return {
			isValid: false,
			normalizedHost,
			isKnownPattern: false,
			reason: 'Invalid host format',
		};
	}

	// Check if it's a known pattern
	const isKnownPattern = isKnownHost(normalizedHost, isDevelopment);

	// Host is valid for tenant resolution attempt
	// Even unknown hosts are allowed - DB lookup will handle rejection
	// But unknown hosts will be logged for monitoring
	return {
		isValid: true,
		normalizedHost,
		isKnownPattern,
	};
}

/**
 * Normalize a host header value
 * - Converts to lowercase
 * - Strips port number if present
 *
 * @param host - Raw host header value
 * @returns Normalized host
 */
export function normalizeHost(host: string): string {
	let normalized = host.toLowerCase().trim();

	// Strip port if present (handle both IPv4 and IPv6)
	// IPv6 format: [::1]:8787
	if (normalized.startsWith('[')) {
		// IPv6: find the closing bracket and strip port after it
		const bracketEnd = normalized.indexOf(']');
		if (bracketEnd !== -1) {
			const portStart = normalized.indexOf(':', bracketEnd);
			if (portStart !== -1) {
				normalized = normalized.substring(0, portStart);
			}
		}
	} else {
		// IPv4 or hostname: strip port after last colon
		// But be careful not to strip IPv6 colons
		const colonIndex = normalized.lastIndexOf(':');
		if (colonIndex !== -1) {
			const afterColon = normalized.substring(colonIndex + 1);
			// Only strip if what's after colon looks like a port number
			if (/^\d+$/.test(afterColon)) {
				normalized = normalized.substring(0, colonIndex);
			}
		}
	}

	return normalized;
}

/**
 * Check if a host has valid format
 *
 * @param host - Normalized host value
 * @returns Whether the host has valid format
 */
function isValidHostFormat(host: string): boolean {
	// Empty check
	if (!host) {
		return false;
	}

	// Allow localhost and IP addresses
	if (host === 'localhost' || isValidIPv4(host) || isValidIPv6(host)) {
		return true;
	}

	// Domain name validation (simplified)
	// - Labels separated by dots
	// - Labels can contain alphanumeric and hyphens
	// - Labels cannot start or end with hyphen
	// - TLD must be at least 2 characters
	const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
	if (!domainRegex.test(host)) {
		return false;
	}

	// Check that it has at least a TLD
	const parts = host.split('.');
	if (parts.length < 2) {
		return false;
	}

	// TLD should be at least 2 characters
	const tld = parts[parts.length - 1];
	if (tld.length < 2) {
		return false;
	}

	return true;
}

/**
 * Check if host is a known/expected pattern
 *
 * @param host - Normalized host
 * @param isDevelopment - Whether in development mode
 * @returns Whether the host matches known patterns
 */
function isKnownHost(host: string, isDevelopment: boolean): boolean {
	// Development hosts
	if (isDevelopment) {
		if (DEVELOPMENT_HOSTS.includes(host)) {
			return true;
		}
		// Also allow IP addresses in development
		if (isValidIPv4(host) || isValidIPv6(host)) {
			return true;
		}
	}

	// Check against known domain patterns
	for (const pattern of KNOWN_DOMAIN_PATTERNS) {
		if (host.endsWith(pattern) || host === pattern.substring(1)) {
			return true;
		}
	}

	return false;
}

/**
 * Simple IPv4 validation
 */
function isValidIPv4(host: string): boolean {
	const parts = host.split('.');
	if (parts.length !== 4) {
		return false;
	}
	return parts.every((part) => {
		const num = parseInt(part, 10);
		return !isNaN(num) && num >= 0 && num <= 255 && String(num) === part;
	});
}

/**
 * Simple IPv6 validation (basic format check)
 */
function isValidIPv6(host: string): boolean {
	// Handle bracketed IPv6 (e.g., [::1])
	let ipv6 = host;
	if (ipv6.startsWith('[') && ipv6.endsWith(']')) {
		ipv6 = ipv6.slice(1, -1);
	}

	// Basic IPv6 format: contains colons and valid hex characters
	if (!/^[a-f0-9:]+$/.test(ipv6)) {
		return false;
	}

	// Must have at least one colon
	if (!ipv6.includes(':')) {
		return false;
	}

	return true;
}

/**
 * Log a suspicious host header for security monitoring
 *
 * @param host - The suspicious host
 * @param reason - Why it's suspicious
 * @param requestInfo - Additional request context
 */
export function logSuspiciousHost(
	host: string,
	reason: string,
	requestInfo?: {
		method?: string;
		path?: string;
		userAgent?: string;
		ip?: string;
	}
): void {
	logger.warn('Suspicious Host header detected', {
		host,
		reason,
		method: requestInfo?.method,
		path: requestInfo?.path,
		userAgent: requestInfo?.userAgent,
		ip: requestInfo?.ip,
		category: 'SECURITY',
		subcategory: 'HOST_VALIDATION',
	});
}
