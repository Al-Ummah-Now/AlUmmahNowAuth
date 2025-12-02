/**
 * @fileoverview JWT-related type definitions for token management
 */

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
	session_id: string | null; // Account session ID for session binding (Lane 4)
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
	// Lane 4: Token Architecture enhancements
	session_id?: string; // Account session ID for session binding
	permissions?: string[]; // Effective permissions (intersection of user roles and client grants)
	token_version?: number; // Token version for legacy token migration (1 = legacy, 2 = new)
	tenant_id?: string; // Tenant context
	auth_time?: number; // Time of authentication (Unix timestamp)
	nonce?: string; // Nonce from authorization request (OIDC)
	// Index signature for jose JWTPayload compatibility
	[key: string]: unknown;
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

/**
 * Token introspection response (RFC 7662)
 * https://datatracker.ietf.org/doc/html/rfc7662
 */
export interface IntrospectionResponse {
	active: boolean;
	scope?: string;
	client_id?: string;
	username?: string;
	token_type?: string;
	exp?: number;
	iat?: number;
	nbf?: number;
	sub?: string;
	aud?: string | string[];
	iss?: string;
	jti?: string;
	// Custom claims
	roles?: string[];
	permissions?: string[];
	session_id?: string;
}

/**
 * Token exchange request (RFC 8693)
 * https://datatracker.ietf.org/doc/html/rfc8693
 */
export interface TokenExchangeRequest {
	grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange';
	subject_token: string;
	subject_token_type: 'urn:ietf:params:oauth:token-type:access_token';
	audience: string; // Target client/audience
	scope?: string; // Requested scope for new token
	requested_token_type?: string;
}

/**
 * App token record for tracking app-specific access tokens
 */
export interface AppTokenRecord {
	id: string;
	account_session_id: string;
	client_id: string;
	access_token_hash: string;
	scope: string | null;
	audience: string;
	issued_at: string;
	expires_at: string;
	is_revoked: number; // SQLite boolean (0 or 1)
	revoked_at: string | null;
	revoke_reason: string | null;
}

// Type for Cloudflare Secrets Store binding (production)
interface SecretsStoreBinding {
	get(): Promise<string>;
}

// Union type: string (local dev via .dev.vars) or Secrets Store binding (production)
type SecretBinding = string | SecretsStoreBinding;

/**
 * Global augmentation: Extend the existing Env interface to include JWT-related secrets.
 * This declaration is intended to MERGE with other Env interface definitions (e.g., in worker-configuration.d.ts),
 * not to replace them. If you add or modify Env properties elsewhere, ensure they are compatible.
 */
declare global {
	interface Env {
		/**
		 * Base64-encoded 256-bit master key for encrypting private keys at rest.
		 * Can be a plain string (local dev) or Secrets Store binding (production).
		 */
		KEY_ENCRYPTION_MASTER_KEY: SecretBinding;

		/**
		 * Salt for PBKDF2 client secret hashing.
		 * Can be a plain string (local dev) or Secrets Store binding (production).
		 * Used for OAuth 2.0 confidential client authentication (RFC 6749 Section 2.3).
		 */
		CLIENT_SECRET_SALT: SecretBinding;

		// Note: ALLOWED_ORIGINS is declared in src/env.d.ts
	}
}
