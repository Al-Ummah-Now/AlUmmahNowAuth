/**
 * @fileoverview JWT key management service for RS256 signing keys
 *
 * This service manages the lifecycle of JWT signing keys:
 * - Generates new RS256 key pairs
 * - Encrypts private keys before storage
 * - Caches public keys for performance
 * - Auto-generates keys when none exist
 */

import { generateKeyPair, exportJWK } from 'jose';
import { encrypt, decrypt } from './encryption';
import type { JwtKeyRecord } from '../types/jwt';

/**
 * Public key cache with TTL to reduce database lookups
 */
class PublicKeyCache {
	private cache = new Map<string, { key: string; expiresAt: number }>();
	private TTL = 5 * 60 * 1000; // 5 minutes

	set(kid: string, key: string) {
		this.cache.set(kid, {
			key,
			expiresAt: Date.now() + this.TTL,
		});
	}

	get(kid: string): string | null {
		const entry = this.cache.get(kid);
		if (!entry || entry.expiresAt < Date.now()) {
			this.cache.delete(kid);
			return null;
		}
		return entry.key;
	}

	clear() {
		this.cache.clear();
	}
}

const publicKeyCache = new PublicKeyCache();

/**
 * Service for managing JWT signing keys
 */
export class KeyService {
	/**
	 * Generates a new RS256 key pair and stores it in the database
	 *
	 * @param env - Cloudflare Workers environment
	 * @returns The generated key's kid
	 * @throws Error if key generation or storage fails
	 */
	static async generateAndStoreKey(env: Env): Promise<string> {
		// Generate key pair with extractable set to true (required for export)
		const { privateKey, publicKey } = await generateKeyPair('RS256', {
			extractable: true,
		});

		// Export keys to JWK format
		const privateJwk = await exportJWK(privateKey);
		const publicJwk = await exportJWK(publicKey);

		// jose generates a kid automatically, but we'll ensure it exists
		if (!privateJwk.kid) {
			privateJwk.kid = crypto.randomUUID();
			publicJwk.kid = privateJwk.kid;
		}

		// Encrypt private key before storage
		const encryptedPrivateKey = await encrypt(
			JSON.stringify(privateJwk),
			env.KEY_ENCRYPTION_MASTER_KEY
		);

		// Prepare key record
		const now = Date.now();
		const keyRecord: JwtKeyRecord = {
			kid: privateJwk.kid,
			public_key: JSON.stringify(publicJwk),
			private_key_encrypted: encryptedPrivateKey,
			algorithm: 'RS256',
			status: 'active',
			created_at: now,
			expires_at: now + 90 * 24 * 60 * 60 * 1000, // 90 days from now
		};

		// Insert into database
		const stmt = env.AUTH_DB.prepare(
			`INSERT INTO jwt_keys
      (kid, public_key, private_key_encrypted, algorithm, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
		);

		const result = await stmt
			.bind(
				keyRecord.kid,
				keyRecord.public_key,
				keyRecord.private_key_encrypted,
				keyRecord.algorithm,
				keyRecord.status,
				keyRecord.created_at,
				keyRecord.expires_at
			)
			.run();

		if (result.error) {
			throw new Error(`Failed to store key: ${result.error}`);
		}

		return keyRecord.kid;
	}

	/**
	 * Retrieves the current active signing key
	 *
	 * @param env - Cloudflare Workers environment
	 * @returns Object containing the kid and decrypted private key as JWK
	 * @throws Error if decryption fails
	 */
	static async getActiveSigningKey(env: Env): Promise<{ kid: string; privateKey: JsonWebKey }> {
		// Find the current active key that hasn't expired
		const stmt = env.AUTH_DB.prepare(
			`SELECT * FROM jwt_keys
       WHERE status = 'active'
       AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
		);

		const result = (await stmt.bind(Date.now()).first()) as JwtKeyRecord | null;

		if (!result) {
			// If no active key exists, generate a new one
			await this.generateAndStoreKey(env);
			// Recursively call to get the newly created key
			return this.getActiveSigningKey(env);
		}

		// Decrypt the private key
		const decryptedPrivateKey = await decrypt(
			result.private_key_encrypted,
			env.KEY_ENCRYPTION_MASTER_KEY
		);

		return {
			kid: result.kid,
			privateKey: JSON.parse(decryptedPrivateKey),
		};
	}

	/**
	 * Retrieves a public key for token verification
	 *
	 * @param kid - Key ID to retrieve
	 * @param env - Cloudflare Workers environment
	 * @returns Public key as JWK object
	 * @throws Error if key not found
	 */
	static async getVerificationKey(kid: string, env: Env): Promise<JsonWebKey> {
		// Check cache first
		const cachedKey = publicKeyCache.get(kid);
		if (cachedKey) {
			return JSON.parse(cachedKey);
		}

		// Fetch from database
		const stmt = env.AUTH_DB.prepare(`SELECT public_key FROM jwt_keys WHERE kid = ?`);

		const result = (await stmt.bind(kid).first()) as { public_key: string } | null;

		if (!result) {
			throw new Error(`No key found with kid: ${kid}`);
		}

		const publicKey = JSON.parse(result.public_key);

		// Cache the public key
		publicKeyCache.set(kid, result.public_key);

		return publicKey;
	}

	/**
	 * Clears the public key cache (useful for testing or forced refresh)
	 */
	static clearCache(): void {
		publicKeyCache.clear();
	}
}
