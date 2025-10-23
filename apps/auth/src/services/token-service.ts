/**
 * @fileoverview JWT token service for generating and verifying access/refresh tokens
 *
 * This service implements OAuth 2.0 token generation and validation:
 * - Generates short-lived JWT access tokens (15 minutes)
 * - Generates long-lived refresh tokens (7 days) with rotation support
 * - Verifies and validates tokens
 * - Integrates with KeyService for RS256 signing
 */

import { SignJWT, jwtVerify, importJWK } from 'jose';
import { KeyService } from './key-service';
import type { AccessTokenPayload, TokenPair, RefreshTokenRecord } from '../types/jwt';
import { TokenError } from '../types/errors';

/**
 * Configuration constants for token lifetimes
 */
const ACCESS_TOKEN_LIFETIME = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_LIFETIME = 7 * 24 * 60 * 60; // 7 days in seconds
const MAX_ROTATION_COUNT = 100; // Prevent infinite rotation chains

/**
 * User data structure expected by TokenService
 */
export interface TokenUser {
	id: string;
	email: string;
	role: string;
}

/**
 * Service for managing JWT access tokens and refresh tokens
 */
export class TokenService {
	/**
	 * Generates a JWT access token for an authenticated user
	 *
	 * @param user - The authenticated user
	 * @param clientId - The OAuth client ID requesting the token
	 * @param scope - Space-separated OAuth scopes (default: "openid email profile")
	 * @param env - Cloudflare Workers environment
	 * @returns A signed JWT access token
	 * @throws Error if token generation fails
	 */
	static async generateAccessToken(
		user: TokenUser,
		clientId: string,
		scope: string = 'openid email profile',
		env: Env
	): Promise<string> {
		// Get the active signing key
		const { kid, privateKey } = await KeyService.getActiveSigningKey(env);

		// Import the private key for signing
		const privateKeyObject = await importJWK(privateKey, 'RS256');

		const now = Math.floor(Date.now() / 1000);
		const issuer = env.OPENAUTH_ISSUER;

		// Build the access token payload
		const payload: AccessTokenPayload = {
			iss: issuer,
			sub: user.id,
			aud: clientId,
			exp: now + ACCESS_TOKEN_LIFETIME,
			iat: now,
			nbf: now,
			jti: crypto.randomUUID(),
			email: user.email,
			role: user.role,
			client_id: clientId,
			scope,
		};

		// Sign and generate the JWT
		const jwt = await new SignJWT(payload as any)
			.setProtectedHeader({ alg: 'RS256', kid })
			.setIssuedAt(now)
			.setExpirationTime(now + ACCESS_TOKEN_LIFETIME)
			.setNotBefore(now)
			.setIssuer(issuer)
			.setSubject(user.id)
			.setAudience(clientId)
			.setJti(payload.jti)
			.sign(privateKeyObject);

		return jwt;
	}

	/**
	 * Generates a refresh token and stores it in the database
	 *
	 * @param userId - The user ID
	 * @param clientId - The OAuth client ID
	 * @param scope - Space-separated OAuth scopes
	 * @param env - Cloudflare Workers environment
	 * @param ipAddress - Client IP address (optional, for audit)
	 * @param userAgent - Client user agent (optional, for audit)
	 * @param parentTokenId - Parent token ID for rotation tracking (optional)
	 * @param tokenFamilyId - Token family ID for reuse detection (optional)
	 * @returns The refresh token and its database ID
	 * @throws Error if token generation or storage fails
	 */
	static async generateRefreshToken(
		userId: string,
		clientId: string,
		scope: string = 'openid email profile',
		env: Env,
		ipAddress?: string,
		userAgent?: string,
		parentTokenId?: string,
		tokenFamilyId?: string
	): Promise<{ token: string; tokenId: string }> {
		// Generate a cryptographically secure random token
		const tokenBytes = new Uint8Array(32);
		crypto.getRandomValues(tokenBytes);
		const token = Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

		// Hash the token for storage (never store plaintext tokens)
		const encoder = new TextEncoder();
		const tokenData = encoder.encode(token);
		const hashBuffer = await crypto.subtle.digest('SHA-256', tokenData);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const tokenHash = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');

		const now = Math.floor(Date.now() / 1000);
		const expiresAt = now + REFRESH_TOKEN_LIFETIME;

		// Determine rotation count and token family
		let rotationCount = 0;
		let finalTokenFamilyId = tokenFamilyId;

		if (parentTokenId) {
			// Get parent token's rotation count and family ID
			const parentStmt = env.AUTH_DB.prepare(
				`SELECT rotation_count, token_family_id FROM refresh_tokens WHERE id = ?`
			);
			const parent = (await parentStmt.bind(parentTokenId).first()) as {
				rotation_count: number;
				token_family_id: string | null;
			} | null;
			if (parent) {
				rotationCount = parent.rotation_count + 1;
				// Inherit family ID from parent if not explicitly provided
				if (!finalTokenFamilyId) {
					finalTokenFamilyId = parent.token_family_id || parentTokenId;
				}
			}
		}

		// Insert refresh token into database
		const stmt = env.AUTH_DB.prepare(
			`INSERT INTO refresh_tokens
      (token_hash, user_id, client_id, issued_at, expires_at, ip_address, user_agent, parent_token_id, rotation_count, scope, token_family_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`
		);

		const result = await stmt
			.bind(tokenHash, userId, clientId, now, expiresAt, ipAddress, userAgent, parentTokenId, rotationCount, scope, finalTokenFamilyId)
			.first<{ id: string }>();

		if (!result) {
			throw TokenError.databaseError('Failed to store refresh token');
		}

		// If this is a root token (no parent), set its own ID as family ID
		if (!parentTokenId && !tokenFamilyId) {
			await env.AUTH_DB.prepare(
				`UPDATE refresh_tokens SET token_family_id = ? WHERE id = ?`
			).bind(result.id, result.id).run();
		}

		// Log token generation in analytics
		await this.logTokenUsage(result.id, 'generated', env, ipAddress, userAgent);

		return {
			token,
			tokenId: result.id,
		};
	}

	/**
	 * Verifies and decodes a JWT access token
	 *
	 * @param token - The JWT access token to verify
	 * @param env - Cloudflare Workers environment
	 * @returns The decoded and verified token payload
	 * @throws Error if token is invalid, expired, or verification fails
	 */
	static async verifyAccessToken(token: string, env: Env): Promise<AccessTokenPayload> {
		try {
			// Decode the token header to get the kid
			const parts = token.split('.');
			if (parts.length !== 3) {
				throw TokenError.invalidToken('Invalid JWT format');
			}

			const header = JSON.parse(atob(parts[0]));
			const kid = header.kid;

			if (!kid) {
				throw TokenError.invalidToken('Token missing kid in header');
			}

			// Get the public key for verification
			const publicJwk = await KeyService.getVerificationKey(kid, env);
			const publicKey = await importJWK(publicJwk, 'RS256');

			// Verify the token signature and claims
			const { payload } = await jwtVerify(token, publicKey, {
				issuer: env.OPENAUTH_ISSUER,
				clockTolerance: 10, // Allow 10 seconds clock skew
			});

			return payload as AccessTokenPayload;
		} catch (error) {
			if (error instanceof TokenError) {
				throw error;
			}
			if (error instanceof Error) {
				// Check for specific jose errors
				if (error.message.includes('signature')) {
					throw TokenError.signatureInvalid(`Token signature verification failed: ${error.message}`);
				}
				if (error.message.includes('expired')) {
					throw TokenError.tokenExpired(`Token has expired: ${error.message}`);
				}
				throw TokenError.invalidToken(`Token verification failed: ${error.message}`);
			}
			throw TokenError.invalidToken('Token verification failed');
		}
	}

	/**
	 * Validates a refresh token and returns its record
	 *
	 * @param token - The refresh token to validate
	 * @param env - Cloudflare Workers environment
	 * @returns The refresh token record from the database
	 * @throws Error if token is invalid, expired, or revoked
	 */
	static async validateRefreshToken(token: string, env: Env): Promise<RefreshTokenRecord> {
		// Hash the provided token
		const encoder = new TextEncoder();
		const tokenData = encoder.encode(token);
		const hashBuffer = await crypto.subtle.digest('SHA-256', tokenData);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const tokenHash = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');

		// Look up the token in the database
		const stmt = env.AUTH_DB.prepare(
			`SELECT id, user_id, token_hash, expires_at, issued_at, revoked_at
       FROM refresh_tokens
       WHERE token_hash = ?`
		);

		const record = (await stmt.bind(tokenHash).first()) as RefreshTokenRecord | null;

		if (!record) {
			throw TokenError.invalidToken('Invalid refresh token');
		}

		// Check if token is revoked
		if (record.revoked_at !== null) {
			throw TokenError.tokenRevoked('Refresh token has been revoked', { revokedAt: record.revoked_at });
		}

		// Check if token is expired
		const now = Math.floor(Date.now() / 1000);
		if (record.expires_at < now) {
			throw TokenError.tokenExpired('Refresh token has expired', { expiresAt: record.expires_at });
		}

		// Update last_used_at timestamp
		const updateStmt = env.AUTH_DB.prepare(
			`UPDATE refresh_tokens SET last_used_at = ? WHERE id = ?`
		);
		await updateStmt.bind(now, record.id).run();

		return record;
	}

	/**
	 * Generates a new token pair (access token + refresh token)
	 *
	 * @param user - The authenticated user
	 * @param clientId - The OAuth client ID
	 * @param scope - Space-separated OAuth scopes
	 * @param env - Cloudflare Workers environment
	 * @param ipAddress - Client IP address (optional)
	 * @param userAgent - Client user agent (optional)
	 * @returns A complete token pair for OAuth 2.0 response
	 */
	static async generateTokenPair(
		user: TokenUser,
		clientId: string,
		scope: string = 'openid email profile',
		env: Env,
		ipAddress?: string,
		userAgent?: string
	): Promise<TokenPair> {
		// Generate both tokens
		const accessToken = await this.generateAccessToken(user, clientId, scope, env);
		const { token: refreshToken } = await this.generateRefreshToken(
			user.id,
			clientId,
			scope,
			env,
			ipAddress,
			userAgent
		);

		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: ACCESS_TOKEN_LIFETIME,
			refresh_token: refreshToken,
			scope,
		};
	}

	/**
	 * Refreshes a token pair using refresh token rotation
	 *
	 * This implements secure refresh token rotation with:
	 * - Immediate token invalidation (no grace period)
	 * - Atomic rotation using D1 batch API
	 * - Token reuse detection with family revocation
	 * - Concurrent refresh detection
	 *
	 * @param ctx - Cloudflare Workers ExecutionContext (unused after grace period removal)
	 * @param env - Cloudflare Workers environment
	 * @param refreshToken - The current refresh token
	 * @param clientId - The OAuth client ID
	 * @param ipAddress - Client IP address (optional)
	 * @param userAgent - Client user agent (optional)
	 * @returns A new token pair
	 * @throws TokenError if token is invalid, expired, revoked, or reused
	 */
	static async refreshTokenPair(
		ctx: ExecutionContext,
		env: Env,
		refreshToken: string,
		clientId: string,
		ipAddress?: string,
		userAgent?: string
	): Promise<TokenPair> {
		const tokenHash = await this.hashToken(refreshToken);
		const now = Math.floor(Date.now() / 1000);

		// Step 1: Fetch token record with all needed fields
		const tokenRecord = await env.AUTH_DB.prepare(
			`SELECT id, user_id, client_id, token_hash, expires_at, revoked, revoked_at,
              revoked_reason, parent_token_id, rotation_count, scope, token_family_id
       FROM refresh_tokens
       WHERE token_hash = ?`
		)
			.bind(tokenHash)
			.first<RefreshTokenRecord & { token_family_id: string | null }>();

		if (!tokenRecord) {
			throw TokenError.invalidToken('Invalid refresh token');
		}

		// Step 2: Phase 2 - Token Reuse Detection
		// If token is already revoked with reason='rotation', this indicates reuse
		if (tokenRecord.revoked === 1) {
			if (tokenRecord.revoked_reason === 'rotation') {
				// Token reuse detected - revoke entire family
				const familyId = tokenRecord.token_family_id || tokenRecord.id;
				await this.revokeTokenFamily(env, familyId, 'token_reuse_detected');
				await this.logTokenUsage(tokenRecord.id, 'revoked', env, ipAddress, userAgent, 'Token reuse detected - family revoked');
				throw TokenError.tokenReuseDetected(
					'Token reuse detected - entire token family has been revoked for security',
					{
						tokenId: tokenRecord.id,
						familyId,
						revokedAt: tokenRecord.revoked_at,
					}
				);
			}

			// Token revoked for other reasons
			throw TokenError.tokenRevoked('Refresh token has been revoked', {
				reason: tokenRecord.revoked_reason,
				revokedAt: tokenRecord.revoked_at,
			});
		}

		// Step 3: Verify client ID matches
		if (tokenRecord.client_id !== clientId) {
			throw TokenError.clientIdMismatch('Client ID mismatch', { providedClientId: clientId });
		}

		// Step 4: Check expiration
		if (tokenRecord.expires_at < now) {
			throw TokenError.tokenExpired('Refresh token has expired', { expiresAt: tokenRecord.expires_at });
		}

		// Step 5: Check rotation limit
		if (tokenRecord.rotation_count >= MAX_ROTATION_COUNT) {
			const familyId = tokenRecord.token_family_id || tokenRecord.id;
			await this.revokeTokenFamily(env, familyId, 'max_rotation_exceeded');
			throw TokenError.maxRotationExceeded('Maximum rotation count exceeded', {
				rotationCount: tokenRecord.rotation_count,
				maxAllowed: MAX_ROTATION_COUNT,
			});
		}

		// Step 6: Get user data for token generation
		const user = await this.getUserById(tokenRecord.user_id, env);

		// Step 7: Generate new refresh token (before revoking old one)
		const newTokenBytes = new Uint8Array(32);
		crypto.getRandomValues(newTokenBytes);
		const newToken = Array.from(newTokenBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
		const newTokenHash = await this.hashToken(newToken);

		const expiresAt = now + REFRESH_TOKEN_LIFETIME;
		const newRotationCount = tokenRecord.rotation_count + 1;
		const familyId = tokenRecord.token_family_id || tokenRecord.id;

		// Step 8: Phase 1 - Atomic Rotation using D1 Batch API
		// All three operations succeed or fail together
		const batchResult = await env.AUTH_DB.batch([
			// 1. Revoke old token immediately with reason='rotation'
			env.AUTH_DB.prepare(
				`UPDATE refresh_tokens
         SET revoked = 1, revoked_at = ?, revoked_reason = 'rotation'
         WHERE id = ? AND revoked = 0`
			).bind(now, tokenRecord.id),

			// 2. Insert new token
			env.AUTH_DB.prepare(
				`INSERT INTO refresh_tokens
         (token_hash, user_id, client_id, issued_at, expires_at, ip_address, user_agent,
          parent_token_id, rotation_count, scope, token_family_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(
				newTokenHash,
				tokenRecord.user_id,
				clientId,
				now,
				expiresAt,
				ipAddress,
				userAgent,
				tokenRecord.id,
				newRotationCount,
				tokenRecord.scope,
				familyId
			),

			// 3. Log the refresh event
			env.AUTH_DB.prepare(
				`INSERT INTO token_usage (token_id, action, timestamp, ip_address, user_agent)
         VALUES (?, 'refreshed', ?, ?, ?)`
			).bind(tokenRecord.id, now, ipAddress, userAgent)
		]);

		// Step 9: Check for concurrent rotation
		// If UPDATE affected 0 rows, another request already rotated this token
		const updateResult = batchResult[0];
		if (!updateResult.success || (updateResult.meta?.changes ?? 0) === 0) {
			throw TokenError.concurrentRefresh(
				'Concurrent refresh detected - token was already rotated. Please retry with the new token.',
				{
					tokenId: tokenRecord.id,
					statusCode: 409,
				}
			);
		}

		// Step 10: Generate new access token
		const newAccessToken = await this.generateAccessToken(user, clientId, tokenRecord.scope, env);

		// Step 11: Return new token pair
		return {
			access_token: newAccessToken,
			token_type: 'Bearer',
			expires_in: ACCESS_TOKEN_LIFETIME,
			refresh_token: newToken,
			scope: tokenRecord.scope,
		};
	}

	/**
	 * Revokes an entire token family (all tokens with same family ID)
	 *
	 * Used when token reuse is detected to invalidate all tokens in the family
	 * This prevents any stolen tokens from being used, even if they haven't been rotated yet
	 *
	 * @param env - Cloudflare Workers environment
	 * @param familyId - The token family ID to revoke
	 * @param reason - The reason for family revocation
	 * @returns The number of tokens revoked
	 */
	private static async revokeTokenFamily(env: Env, familyId: string, reason: string): Promise<number> {
		const now = Math.floor(Date.now() / 1000);

		// Find all tokens in the family that aren't already revoked
		const familyTokens = await env.AUTH_DB.prepare(
			`SELECT id FROM refresh_tokens WHERE token_family_id = ? AND revoked = 0`
		)
			.bind(familyId)
			.all<{ id: string }>();

		if (!familyTokens.results || familyTokens.results.length === 0) {
			return 0;
		}

		const tokenIds = familyTokens.results.map((t) => t.id);

		// Batch revoke all tokens in the family using D1 batch API
		const revokeStatements = tokenIds.map((id) =>
			env.AUTH_DB.prepare(
				`UPDATE refresh_tokens
         SET revoked = 1, revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked = 0`
			).bind(now, reason, id)
		);

		await env.AUTH_DB.batch(revokeStatements);

		// Log security events in batch
		const metadata = JSON.stringify({
			reason,
			familyRevocation: true,
			familyId,
			totalRevoked: tokenIds.length,
		});

		const logStatements = tokenIds.map((id) =>
			env.AUTH_DB.prepare(
				`INSERT INTO token_usage (token_id, action, timestamp, metadata)
         VALUES (?, 'revoked', ?, ?)`
			).bind(id, now, metadata)
		);

		await env.AUTH_DB.batch(logStatements);

		return tokenIds.length;
	}

	/**
	 * Revokes an entire token chain (all descendants of a root token)
	 *
	 * Used when suspicious activity is detected (token reuse, max rotation exceeded)
	 *
	 * @param env - Cloudflare Workers environment
	 * @param rootTokenId - The root token ID to start revocation from
	 * @param reason - The reason for chain revocation
	 * @returns The number of tokens revoked
	 */
	static async revokeTokenChain(env: Env, rootTokenId: string, reason: string = 'security_breach'): Promise<number> {
		// Use recursive CTE to find all descendants
		// Limited to MAX_ROTATION_COUNT depth to prevent runaway queries
		const chainQuery = `
      WITH RECURSIVE token_chain AS (
        SELECT id, parent_token_id, 1 as level
        FROM refresh_tokens
        WHERE id = ?

        UNION ALL

        SELECT rt.id, rt.parent_token_id, tc.level + 1
        FROM refresh_tokens rt
        JOIN token_chain tc ON rt.parent_token_id = tc.id
        WHERE rt.revoked = 0 AND tc.level < ?
      )
      SELECT id FROM token_chain
    `;

		const tokensToRevoke = await env.AUTH_DB.prepare(chainQuery).bind(rootTokenId, MAX_ROTATION_COUNT).all<{ id: string }>();

		if (!tokensToRevoke.results || tokensToRevoke.results.length === 0) {
			return 0;
		}

		const tokenIds = tokensToRevoke.results.map((t) => t.id);

		// Batch revoke all tokens using D1 batch API (safer than dynamic SQL)
		const now = Math.floor(Date.now() / 1000);
		const revokeStatements = tokenIds.map((id) =>
			env.AUTH_DB.prepare(
				`UPDATE refresh_tokens
         SET revoked = 1, revoked_at = ?, revoked_reason = ?
         WHERE id = ?`
			).bind(now, reason, id)
		);

		// Execute all revocations in a batch
		await env.AUTH_DB.batch(revokeStatements);

		// Log security events in batch
		const metadata = JSON.stringify({
			reason,
			chainRevocation: true,
			rootTokenId,
			totalRevoked: tokenIds.length,
		});

		const logStatements = tokenIds.map((id) =>
			env.AUTH_DB.prepare(
				`INSERT INTO token_usage (token_id, action, metadata)
         VALUES (?, ?, ?)`
			).bind(id, 'revoked', metadata)
		);

		await env.AUTH_DB.batch(logStatements);

		return tokenIds.length;
	}

	/**
	 * Explicitly revokes a single refresh token
	 *
	 * @param env - Cloudflare Workers environment
	 * @param refreshToken - The refresh token to revoke
	 * @param reason - The reason for revocation
	 * @param ipAddress - Client IP address (optional)
	 * @param userAgent - Client user agent (optional)
	 */
	static async revokeRefreshToken(
		env: Env,
		refreshToken: string,
		reason: string = 'user_requested',
		ipAddress?: string,
		userAgent?: string
	): Promise<void> {
		const tokenHash = await this.hashToken(refreshToken);

		const result = await env.AUTH_DB.prepare(
			`UPDATE refresh_tokens
       SET revoked = 1, revoked_at = ?, revoked_reason = ?
       WHERE token_hash = ? AND revoked = 0`
		)
			.bind(Math.floor(Date.now() / 1000), reason, tokenHash)
			.run();

		if (result.success && (result.meta?.changes ?? 0) > 0) {
			// Get the token ID for logging
			const tokenRecord = await env.AUTH_DB.prepare(`SELECT id FROM refresh_tokens WHERE token_hash = ?`)
				.bind(tokenHash)
				.first<{ id: string }>();

			if (tokenRecord) {
				await this.logTokenUsage(tokenRecord.id, 'revoked', env, ipAddress, userAgent, reason);
			}
		}
	}

	/**
	 * Helper method to hash a token using SHA-256
	 *
	 * @param token - The token to hash
	 * @returns The hex-encoded hash
	 */
	private static async hashToken(token: string): Promise<string> {
		const encoder = new TextEncoder();
		const tokenData = encoder.encode(token);
		const hashBuffer = await crypto.subtle.digest('SHA-256', tokenData);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Helper method to get user data by ID
	 *
	 * @param userId - The user ID
	 * @param env - Cloudflare Workers environment
	 * @returns User data
	 * @throws Error if user not found
	 */
	private static async getUserById(userId: string, env: Env): Promise<TokenUser> {
		const user = await env.AUTH_DB.prepare(`SELECT id, email, role FROM user WHERE id = ?`)
			.bind(userId)
			.first<TokenUser>();

		if (!user) {
			throw TokenError.databaseError('User not found', { userId });
		}

		return user;
	}

	/**
	 * Logs token usage for analytics and audit trail
	 *
	 * @param tokenId - The refresh token ID
	 * @param action - The action being performed
	 * @param env - Cloudflare Workers environment
	 * @param ipAddress - Client IP address (optional)
	 * @param userAgent - Client user agent (optional)
	 * @param metadata - Additional metadata as JSON string (optional)
	 */
	private static async logTokenUsage(
		tokenId: string,
		action: 'generated' | 'refreshed' | 'revoked' | 'expired',
		env: Env,
		ipAddress?: string,
		userAgent?: string,
		metadata?: string
	): Promise<void> {
		const stmt = env.AUTH_DB.prepare(
			`INSERT INTO token_usage (token_id, action, ip_address, user_agent, metadata)
       VALUES (?, ?, ?, ?, ?)`
		);

		await stmt.bind(tokenId, action, ipAddress, userAgent, metadata).run();
	}
}
