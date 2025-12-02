/**
 * @fileoverview Authorization code generation and validation utilities
 *
 * This module provides functions for:
 * - Generating authorization codes for OAuth 2.0 flow
 * - Validating and consuming authorization codes
 * - PKCE (Proof Key for Code Exchange) validation
 */

import { generateId } from './id';
import { hashToken } from './crypto';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Parameters for generating an authorization code
 */
export interface AuthorizationCodeParams {
	clientId: string;
	userId: string;
	redirectUri: string;
	scope?: string;
	codeChallenge?: string;
	codeChallengeMethod?: 'S256' | 'plain';
	nonce?: string;
}

/**
 * Result from validating an authorization code
 */
export interface AuthorizationCodeResult {
	userId: string;
	scope: string;
	nonce?: string;
}

/**
 * Generate and store an authorization code for the OAuth flow
 *
 * Authorization codes are:
 * - Single-use tokens
 * - Valid for 10 minutes
 * - Bound to client_id and redirect_uri
 * - Optionally include PKCE challenge for security
 *
 * @param db - D1 database instance
 * @param params - Authorization code parameters
 * @returns The generated authorization code (plaintext)
 */
export async function generateAuthorizationCode(
	db: D1Database,
	params: AuthorizationCodeParams
): Promise<string> {
	const code = generateId('authcode', 32); // Random authorization code (64 chars)
	const codeHash = await hashToken(code);
	const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

	// Store the authorization code with its parameters
	await db
		.prepare(
			`INSERT INTO authorization_codes (
        code_hash, client_id, user_id, redirect_uri, scope,
        code_challenge, code_challenge_method, nonce, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			codeHash,
			params.clientId,
			params.userId,
			params.redirectUri,
			params.scope || '',
			params.codeChallenge || null,
			params.codeChallengeMethod || null,
			params.nonce || null,
			expiresAt.toISOString()
		)
		.run();

	return code;
}

/**
 * Validate and consume an authorization code during token exchange
 *
 * Validation checks:
 * - Code exists and hasn't been used
 * - Code hasn't expired
 * - Client ID matches
 * - Redirect URI matches
 * - PKCE verifier matches challenge (if PKCE was used)
 *
 * The code is marked as used after successful validation (one-time use).
 *
 * @param db - D1 database instance
 * @param code - The authorization code to validate
 * @param clientId - Client ID from token request
 * @param redirectUri - Redirect URI from token request
 * @param codeVerifier - PKCE code verifier (if PKCE was used)
 * @returns Authorization code data or null if invalid
 */
export async function validateAuthorizationCode(
	db: D1Database,
	code: string,
	clientId: string,
	redirectUri: string,
	codeVerifier?: string
): Promise<AuthorizationCodeResult | null> {
	const codeHash = await hashToken(code);

	const stored = await db
		.prepare(
			`SELECT * FROM authorization_codes
      WHERE code_hash = ?
        AND client_id = ?
        AND redirect_uri = ?
        AND expires_at > datetime('now')
        AND used_at IS NULL`
		)
		.bind(codeHash, clientId, redirectUri)
		.first();

	if (!stored) {
		return null;
	}

	// Validate PKCE if code_challenge was provided
	if (stored.code_challenge) {
		if (!codeVerifier) {
			return null; // PKCE required but verifier not provided
		}

		const valid = await validatePKCE(
			codeVerifier,
			stored.code_challenge as string,
			stored.code_challenge_method as 'S256' | 'plain'
		);

		if (!valid) {
			return null;
		}
	}

	// Mark code as used (one-time use)
	await db
		.prepare(`UPDATE authorization_codes SET used_at = datetime('now') WHERE code_hash = ?`)
		.bind(codeHash)
		.run();

	return {
		userId: stored.user_id as string,
		scope: stored.scope as string,
		nonce: stored.nonce as string | undefined,
	};
}

/**
 * Validate PKCE code verifier against code challenge
 *
 * Supports both S256 and plain methods:
 * - S256: BASE64URL(SHA256(verifier)) === challenge
 * - plain: verifier === challenge
 *
 * @param verifier - The code verifier from token request
 * @param challenge - The code challenge from authorization request
 * @param method - The challenge method (S256 or plain)
 * @returns True if verifier matches challenge
 */
async function validatePKCE(
	verifier: string,
	challenge: string,
	method: 'S256' | 'plain'
): Promise<boolean> {
	if (method === 'plain') {
		return verifier === challenge;
	}

	// S256: BASE64URL(SHA256(verifier)) === challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hashBuffer);

	// Convert to base64url (RFC 4648)
	const computed = btoa(String.fromCharCode.apply(null, Array.from(hashArray)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

	return computed === challenge;
}

/**
 * Clean up expired authorization codes
 *
 * Should be called periodically (e.g., via cron) to remove expired codes
 * and prevent database bloat.
 *
 * @param db - D1 database instance
 * @param batchSize - Maximum number of codes to delete (default: 100)
 * @returns Number of codes deleted
 */
export async function cleanupExpiredCodes(
	db: D1Database,
	batchSize: number = 100
): Promise<{ deleted: number }> {
	const result = await db
		.prepare(
			`DELETE FROM authorization_codes
      WHERE expires_at < datetime('now')
        AND code_hash IN (
          SELECT code_hash FROM authorization_codes
          WHERE expires_at < datetime('now')
          LIMIT ?
        )`
		)
		.bind(batchSize)
		.run();

	return { deleted: result.meta?.changes || 0 };
}
