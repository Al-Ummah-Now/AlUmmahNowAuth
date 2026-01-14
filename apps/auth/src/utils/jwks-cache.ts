/**
 * @fileoverview Shared JWKS caching utility for JWT verification
 *
 * This module provides a cached JWKS (JSON Web Key Set) fetcher that retrieves
 * signing keys from OpenAuth's KV storage or falls back to HTTP fetch.
 *
 * IMPORTANT: Cloudflare Workers isolates are ephemeral and per-request.
 * The module-level cache (`cachedJWKS`) provides caching within a single
 * worker instance, but different requests may hit different instances.
 * The cache TTL (5 minutes) balances performance with key freshness.
 * For true cross-request caching in Workers, consider using KV storage
 * or Durable Objects, but for JWKS this in-memory approach is sufficient
 * as keys rarely change and the fallback to KV storage is fast.
 *
 * OpenAuth stores signing keys with the key path ["signing:key", "primary"]
 * which translates to "signing:key::primary" in KV (using "::" as separator).
 * The stored format is a SerializedKeyPair with publicKey in SPKI format.
 */

import { importSPKI, exportJWK, type JWK } from 'jose';
import { logger } from '../logger';

/**
 * Cache TTL for JWKS in milliseconds (5 minutes)
 * This provides a balance between performance and key freshness.
 */
export const JWKS_CACHE_TTL = 5 * 60 * 1000;

/**
 * KV storage key where OpenAuth stores the primary signing key.
 * Uses OpenAuth's key path format: ["signing:key", "primary"] -> "signing:key::primary"
 */
export const SIGNING_KEY_KV_KEY = 'signing:key::primary';

/**
 * Default signing algorithm used by OpenAuth
 */
export const SIGNING_ALG = 'ES256';

/**
 * OpenAuth's serialized key pair format stored in KV.
 * Contains both public and private keys for signing operations.
 */
export interface SerializedKeyPair {
	/** Unique identifier for the key pair */
	id: string;
	/** Public key in SPKI (Subject Public Key Info) format */
	publicKey: string;
	/** Private key (used by OpenAuth for signing, not needed for verification) */
	privateKey: string;
	/** Unix timestamp when the key was created */
	created: number;
	/** Signing algorithm (e.g., 'ES256') */
	alg: string;
	/** Optional Unix timestamp when the key expired */
	expired?: number;
}

/**
 * Cached JWKS structure with fetch timestamp for TTL checking.
 * Module-level variable for in-memory caching within a worker instance.
 */
let cachedJWKS: { keys: JWK[]; fetchedAt: number } | null = null;

/**
 * Environment bindings required for JWKS retrieval.
 * Minimal subset of the full Env interface.
 */
interface JWKSEnv {
	/** KV namespace for auth storage (contains signing keys) */
	AUTH_STORAGE: KVNamespace;
	/** OpenAuth issuer URL for fallback JWKS fetch */
	OPENAUTH_ISSUER?: string;
}

/**
 * Retrieves JWKS from cache, KV storage, or HTTP fallback.
 *
 * Resolution order:
 * 1. In-memory cache (if valid within TTL)
 * 2. KV storage (OpenAuth's signing key)
 * 3. HTTP fetch from JWKS endpoint (fallback, may fail in Workers due to self-referential calls)
 *
 * @param env - Environment bindings with AUTH_STORAGE and optional OPENAUTH_ISSUER
 * @returns Promise resolving to JWKS object with keys array
 * @throws Error if JWKS cannot be retrieved from any source
 *
 * @example
 * ```typescript
 * import { getJWKS } from '../utils/jwks-cache';
 * import { createLocalJWKSet, jwtVerify } from 'jose';
 *
 * const jwks = await getJWKS(env);
 * const JWKS = createLocalJWKSet(jwks);
 * const { payload } = await jwtVerify(token, JWKS, { issuer });
 * ```
 */
export async function getJWKS(env: JWKSEnv): Promise<{ keys: JWK[] }> {
	// Check cache first
	if (cachedJWKS && Date.now() - cachedJWKS.fetchedAt < JWKS_CACHE_TTL) {
		return { keys: cachedJWKS.keys };
	}

	// Try to get from KV storage using OpenAuth's key format
	const primaryKeyStr = await env.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
	if (primaryKeyStr) {
		try {
			const keyData = JSON.parse(primaryKeyStr) as SerializedKeyPair;
			if (keyData.publicKey) {
				// Import SPKI format and convert to JWK
				const publicKey = await importSPKI(keyData.publicKey, keyData.alg || SIGNING_ALG, {
					extractable: true,
				});
				const jwk = await exportJWK(publicKey);
				jwk.kid = keyData.id || 'primary';
				jwk.use = 'sig';
				jwk.alg = keyData.alg || SIGNING_ALG;

				cachedJWKS = {
					keys: [jwk as JWK],
					fetchedAt: Date.now(),
				};
				logger.debug('Loaded JWKS from KV storage', { keyId: jwk.kid, alg: jwk.alg });
				return { keys: cachedJWKS.keys };
			}
		} catch (e) {
			logger.error('Failed to parse JWKS from KV storage', { error: e, key: SIGNING_KEY_KV_KEY });
		}
	} else {
		logger.warn('Signing key not found in KV storage', { key: SIGNING_KEY_KV_KEY });
	}

	// Fallback: fetch from JWKS endpoint (may fail in workers due to self-referential call)
	const issuer = env.OPENAUTH_ISSUER || 'http://localhost:3301';
	const jwksUrl = `${issuer}/.well-known/jwks.json`;

	logger.debug('Fetching JWKS from external URL', { jwksUrl });
	const response = await fetch(jwksUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch JWKS: ${response.status} ${response.statusText}`);
	}

	const jwks = (await response.json()) as { keys: JWK[] };
	cachedJWKS = {
		keys: jwks.keys,
		fetchedAt: Date.now(),
	};

	return jwks;
}

/**
 * Clears the JWKS cache.
 * Useful for testing or when keys are known to have rotated.
 */
export function clearJWKSCache(): void {
	cachedJWKS = null;
}
