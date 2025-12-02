/**
 * @fileoverview Utility functions for accessing JWT signing keys
 *
 * Provides helper functions for retrieving active signing keys from KeyService.
 * Used by token generation and verification flows.
 */

import { KeyService } from '../services/key-service';

/**
 * Get the active JWT signing key
 *
 * This is a convenience wrapper around KeyService.getActiveSigningKey
 * that can be used as a function reference for token service initialization.
 *
 * @param env - Cloudflare Workers environment
 * @returns Active signing key with kid and private key
 *
 * @example
 * ```typescript
 * const tokenService = new TokenService(
 *   db,
 *   issuer,
 *   () => getActiveSigningKey(env)
 * );
 * ```
 */
export async function getActiveSigningKey(env: Env): Promise<{ kid: string; privateKey: JsonWebKey }> {
	return KeyService.getActiveSigningKey(env);
}
