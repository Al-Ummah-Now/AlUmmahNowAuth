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

import { createLocalJWKSet, errors, importSPKI, exportJWK, type JWK, type JWTVerifyGetKey } from 'jose';
import { logger } from '../logger';
import { D1AtomicStorage } from '../storage/d1-atomic';

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

/** The issuer's signing-key index in its atomic store (openauth OA-3). */
export const SIGNING_KEY_INDEX = ['keys:signing'];

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
	/** D1 with the issuer's key index (openauth_atomic) */
	AUTH_DB?: D1Database;
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
 * // Verifiers use issuerKeySet, which reloads once for an unknown kid
 * import { issuerKeySet } from '../utils/jwks-cache';
 * import { jwtVerify } from 'jose';
 *
 * const { payload } = await jwtVerify(token, issuerKeySet(env), { issuer });
 * ```
 */
export async function getJWKS(env: JWKSEnv): Promise<{ keys: JWK[] }> {
	// Check cache first
	if (cachedJWKS && Date.now() - cachedJWKS.fetchedAt < JWKS_CACHE_TTL) {
		return { keys: cachedJWKS.keys };
	}

	// OpenAuth's keys: the original primary key in KV, plus every key in the
	// issuer's key index in D1 (openauth OA-3: unique kid per key, created
	// atomically). Verifiers pick the key by kid, so all of them are listed.
	const stored: SerializedKeyPair[] = [];
	const primaryKeyStr = await env.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
	if (primaryKeyStr) {
		try {
			stored.push(JSON.parse(primaryKeyStr) as SerializedKeyPair);
		} catch (e) {
			logger.error('Failed to parse JWKS from KV storage', { error: e, key: SIGNING_KEY_KV_KEY });
		}
	} else {
		logger.warn('Signing key not found in KV storage', { key: SIGNING_KEY_KV_KEY });
	}
	if (env.AUTH_DB) {
		try {
			const index = (await D1AtomicStorage(env.AUTH_DB).get(SIGNING_KEY_INDEX)) as { keys?: SerializedKeyPair[] } | undefined;
			for (const key of index?.keys ?? []) if (!key.expired) stored.push(key);
		} catch (e) {
			logger.warn('Could not read the signing key index', { error: e instanceof Error ? e.message : String(e) });
		}
	}
	const keys: JWK[] = [];
	const seen = new Set<string>();
	for (const keyData of stored) {
		const kid = keyData.id || 'primary';
		if (!keyData.publicKey || seen.has(kid)) continue;
		try {
			// Import SPKI format and convert to JWK
			const publicKey = await importSPKI(keyData.publicKey, keyData.alg || SIGNING_ALG, { extractable: true });
			const jwk = await exportJWK(publicKey);
			jwk.kid = kid;
			jwk.use = 'sig';
			jwk.alg = keyData.alg || SIGNING_ALG;
			keys.push(jwk as JWK);
			seen.add(kid);
		} catch (e) {
			logger.error('Failed to import a signing key', { error: e, kid });
		}
	}
	if (keys.length) {
		cachedJWKS = { keys, fetchedAt: Date.now() };
		logger.debug('Loaded JWKS from storage', { keyIds: [...seen] });
		return { keys };
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
	lastUnknownKidRefetch = 0;
}

/**
 * Minimum gap between two reloads caused by a token whose kid is not in the
 * cached set. A new signing key is used minutes after it is published, so one
 * reload finds it; the gap stops tokens with made-up kids from turning every
 * request into a KV + D1 read (jose's remote key set uses the same 30 s).
 */
export const UNKNOWN_KID_REFETCH_COOLDOWN = 30 * 1000;
let lastUnknownKidRefetch = 0;

/**
 * The issuer's keys as a jose key resolver for jwtVerify. A token signed with
 * a kid the cache does not hold (a key created or rotated after the cache was
 * filled) reloads the keys once instead of failing until the cache expires.
 */
export function issuerKeySet(env: JWKSEnv): JWTVerifyGetKey {
	return async (header, token) => {
		try {
			return await createLocalJWKSet(await getJWKS(env))(header, token);
		} catch (error) {
			if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
			const now = Date.now();
			if (now - lastUnknownKidRefetch < UNKNOWN_KID_REFETCH_COOLDOWN) throw error;
			lastUnknownKidRefetch = now;
			cachedJWKS = null;
			logger.info('Reloading JWKS for an unknown kid', { kid: header.kid });
			// Awaited so a second miss rejects here, not as a promise handed back
			// unhandled for a tick
			return await createLocalJWKSet(await getJWKS(env))(header, token);
		}
	};
}
