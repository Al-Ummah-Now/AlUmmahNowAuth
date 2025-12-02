/**
 * @fileoverview ID generation utilities for sessions and tokens
 *
 * Generates cryptographically secure random IDs with optional prefixes
 */

/**
 * Generate a random ID with optional prefix
 *
 * @param prefix - Optional prefix (e.g., 'bs' for browser session, 'as' for account session)
 * @param bytes - Number of random bytes to generate (default: 16)
 * @returns A hex-encoded random ID with optional prefix
 *
 * @example
 * generateId('bs') // 'bs_a1b2c3d4e5f6...'
 * generateId('bst', 32) // 'bst_a1b2c3d4e5f6...' (64 chars)
 */
export function generateId(prefix?: string, bytes: number = 16): string {
	const array = new Uint8Array(bytes);
	crypto.getRandomValues(array);
	const hex = Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');

	return prefix ? `${prefix}_${hex}` : hex;
}

/**
 * Generate a cryptographically secure random token
 * Alias for generateId without prefix
 *
 * @param bytes - Number of random bytes to generate (default: 32)
 * @returns A hex-encoded random token
 */
export function generateToken(bytes: number = 32): string {
	return generateId(undefined, bytes);
}
