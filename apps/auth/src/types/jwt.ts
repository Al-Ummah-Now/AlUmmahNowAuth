/**
 * @fileoverview JWT-related type definitions for token management
 */

import type { JWK } from 'jose';

/**
 * Represents the possible statuses for a JWT key
 * - 'active': Used for signing new tokens
 * - 'expiring': No longer used for signing, but public key is valid for verification
 * - 'expired': No longer valid for signing or verification
 */
export type KeyStatus = 'active' | 'expiring' | 'expired';

/**
 * Represents the structure of a JWT key record in the database
 */
export interface JwtKeyRecord {
	kid: string;
	public_key: string; // Stringified JWK
	private_key_encrypted: string; // Base64-encoded encrypted private JWK
	algorithm: string;
	status: KeyStatus;
	created_at: number; // Unix timestamp in milliseconds
	expires_at: number; // Unix timestamp in milliseconds
}

/**
 * Represents the structure of a refresh token record in the database
 */
export interface RefreshTokenRecord {
	id: string;
	user_id: string;
	client_id: string;
	token_hash: string;
	expires_at: number;
	issued_at: number;
	last_used_at: number | null;
	revoked: number; // SQLite boolean (0 or 1)
	revoked_at: number | null;
	revoked_reason: string | null;
	parent_token_id: string | null;
	rotation_count: number;
	scope: string;
	ip_address: string | null;
	user_agent: string | null;
	token_family_id: string | null;
}

/**
 * JWT access token payload structure
 */
export interface AccessTokenPayload {
	iss: string; // Issuer
	sub: string; // Subject (user ID)
	aud: string | string[]; // Audience
	exp: number; // Expiration time
	iat: number; // Issued at
	nbf: number; // Not before
	jti: string; // JWT ID
	email: string;
	roles: string[]; // RBAC roles from user_roles table
	client_id: string;
	scope: string;
}

/**
 * Token pair returned after authentication or refresh
 */
export interface TokenPair {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	refresh_token: string;
	scope: string;
}

// Extend the existing Env interface to include JWT-related secrets
declare global {
	interface Env {
		/**
		 * Base64-encoded 256-bit master key for encrypting private keys at rest.
		 * MUST be configured as a Cloudflare Worker Secret.
		 */
		KEY_ENCRYPTION_MASTER_KEY: string;

		/**
		 * Salt for PBKDF2 client secret hashing.
		 * MUST be configured as a Cloudflare Worker Secret.
		 * Used for OAuth 2.0 confidential client authentication (RFC 6749 Section 2.3).
		 */
		CLIENT_SECRET_SALT: string;

		// Note: ALLOWED_ORIGINS is declared in src/env.d.ts
	}
}
