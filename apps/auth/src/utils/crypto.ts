/**
 * @fileoverview Cryptographic utilities for hashing and token generation
 */

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
