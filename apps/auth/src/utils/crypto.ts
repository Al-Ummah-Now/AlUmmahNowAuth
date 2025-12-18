/**
 * @fileoverview Cryptographic utilities for hashing and token generation
 */

/**
 * Convert hex string to Uint8Array (32 bytes for session secret)
 *
 * @param hex - A 64-character hex string (32 bytes)
 * @returns Uint8Array of 32 bytes
 * @throws Error if hex string is not exactly 64 characters
 *
 * @example
 * const secret = hexToSecret('a1b2c3...'); // 64 chars
 * // Returns: Uint8Array(32)
 */
export function hexToSecret(hex: string): Uint8Array {
	if (hex.length !== 64) {
		throw new Error('Hex string must be exactly 64 characters (32 bytes)');
	}
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * Hash a token using SHA-256
 *
 * @param token - The token string to hash
 * @returns A hex-encoded SHA-256 hash of the token
 *
 * @example
 * const hash = await hashToken('my-secret-token');
 * // Returns: 'a1b2c3d4e5f6...' (64 chars)
 */
export async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a cryptographically secure random token
 *
 * @param length - Number of random bytes to generate (default: 32)
 * @returns A hex-encoded random token (length * 2 characters)
 *
 * @example
 * const token = await generateSecureToken(32);
 * // Returns: 'a1b2c3d4...' (64 chars)
 */
export async function generateSecureToken(length: number = 32): Promise<string> {
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}
