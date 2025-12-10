/**
 * @fileoverview Client authentication service for OAuth 2.0 confidential clients
 *
 * Provides secure client secret hashing and verification using PBKDF2.
 * Implements RFC 6749 Section 2.3 (Client Authentication).
 *
 * Security features:
 * - PBKDF2 with 100,000 iterations (OWASP recommended)
 * - SHA-256 hashing algorithm
 * - Salt from environment variable
 * - Constant-time comparison for secrets
 */

/// <reference types="@cloudflare/workers-types" />

import { requireSecret } from '../utils/secrets';
import { logger } from '../logger';

/**
 * OAuth 2.0 client record from database
 */
export interface OAuthClient {
	id: string;
	client_id: string;
	client_secret_hash: string | null;
	client_type: 'public' | 'confidential';
	allowed_grants: string;
	redirect_uris: string;
	created_at: number;
}

/**
 * Hashes a client secret using PBKDF2
 *
 * Uses 100,000 iterations (OWASP recommendation for PBKDF2-SHA256)
 * to provide strong protection against brute-force attacks.
 *
 * @param secret - The plain text client secret
 * @param env - Cloudflare Workers environment containing CLIENT_SECRET_SALT
 * @returns Base64-encoded hash of the secret
 * @throws Error if CLIENT_SECRET_SALT is not configured
 */
export async function hashClientSecret(secret: string, env: Env): Promise<string> {
	const salt = await requireSecret(env.CLIENT_SECRET_SALT, 'CLIENT_SECRET_SALT', env as Record<string, unknown>);

	const encoder = new TextEncoder();
	const secretData = encoder.encode(secret);
	const saltData = encoder.encode(salt);

	// Import the secret as a key for PBKDF2
	const keyMaterial = await crypto.subtle.importKey('raw', secretData, { name: 'PBKDF2' }, false, [
		'deriveBits',
		'deriveKey',
	]);

	// Derive a 256-bit key using PBKDF2 with 100,000 iterations
	const derivedKey = await crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: saltData,
			iterations: 100000,
			hash: 'SHA-256',
		},
		keyMaterial,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		true,
		['sign']
	);

	// Export the derived key as raw bytes
	const derivedKeyData = await crypto.subtle.exportKey('raw', derivedKey);

	// Convert to base64 for storage
	const uint8Array = new Uint8Array(derivedKeyData as ArrayBuffer);
	const binaryString = Array.from(uint8Array)
		.map((byte) => String.fromCharCode(byte))
		.join('');
	const base64Hash = btoa(binaryString);

	return base64Hash;
}

/**
 * Verifies a client secret against a stored hash
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param secret - The plain text client secret to verify
 * @param hash - The stored base64-encoded hash
 * @param env - Cloudflare Workers environment containing CLIENT_SECRET_SALT
 * @returns True if the secret matches the hash, false otherwise
 * @throws Error if CLIENT_SECRET_SALT is not configured
 */
export async function verifyClientSecret(secret: string, hash: string, env: Env): Promise<boolean> {
	try {
		const computedHash = await hashClientSecret(secret, env);

		// Constant-time comparison to prevent timing attacks
		// Both strings should be the same length (base64 encoded)
		if (computedHash.length !== hash.length) {
			return false;
		}

		// Use crypto.subtle.verify for constant-time comparison
		// We'll import both as HMAC keys and compare them
		const encoder = new TextEncoder();

		const computedHashData = encoder.encode(computedHash);
		const storedHashData = encoder.encode(hash);

		// XOR all bytes and accumulate - if result is 0, strings match
		let result = 0;
		for (let i = 0; i < computedHashData.length; i++) {
			result |= computedHashData[i] ^ storedHashData[i];
		}

		return result === 0;
	} catch (error) {
		logger.error('Error verifying client secret', { error });
		return false;
	}
}

/**
 * Retrieves an OAuth client from the database by client_id
 *
 * @param clientId - The client identifier
 * @param db - D1 database instance
 * @returns The OAuth client or null if not found
 */
export async function getOAuthClient(clientId: string, db: D1Database): Promise<OAuthClient | null> {
	try {
		const result = await db
			.prepare(
				`SELECT id, client_id, client_secret_hash, client_type, allowed_grants, redirect_uris, created_at
         FROM oauth_clients
         WHERE client_id = ?`
			)
			.bind(clientId)
			.first<OAuthClient>();

		return result;
	} catch (error) {
		logger.error('Error retrieving OAuth client', { error });
		return null;
	}
}
