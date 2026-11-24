/**
 * @fileoverview Provides AES-GCM encryption and decryption services.
 * Encrypts private keys and profile data (a date of birth) before they are stored in the database.
 *
 * Security considerations:
 * - Uses AES-256-GCM for authenticated encryption
 * - Master key must be stored as a Cloudflare Worker Secret
 * - IV is randomly generated for each encryption operation
 * - IV is prepended to ciphertext for use during decryption
 */

import { logger } from '../logger';

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96 bits is recommended for AES-GCM

/** A key and the id it is stored under. */
export interface EncryptionKey {
	id: string;
	/** Base64-encoded 256-bit key (a Worker Secret) */
	material: string;
}

/**
 * Imported keys, so a request doesn't import again. One entry per key id, kept only while its material is the
 * same: two keys in one isolate never stand in for each other, and a replaced key is imported anew.
 */
const importedKeys = new Map<string, { material: string; key: Promise<CryptoKey> }>();

const keyOf = (key: string | EncryptionKey): EncryptionKey => (typeof key === 'string' ? { id: 'KEY_ENCRYPTION_MASTER_KEY', material: key } : key);

function getKey(input: string | EncryptionKey): Promise<CryptoKey> {
	const { id, material } = keyOf(input);
	if (!material) return Promise.reject(new Error(`${id} secret is not defined.`));
	const cached = importedKeys.get(id);
	if (cached && cached.material === material) return cached.key;
	const key = importKey(id, material);
	importedKeys.set(id, { material, key });
	// A key that could not be imported is not kept
	key.catch(() => {
		if (importedKeys.get(id)?.key === key) importedKeys.delete(id);
	});
	return key;
}

async function importKey(id: string, material: string): Promise<CryptoKey> {
	try {
		const keyBuffer = Uint8Array.from(atob(material), (c) => c.charCodeAt(0));
		// 32 bytes for AES-256
		if (keyBuffer.length !== 32) throw new Error(`Invalid key length: expected 32 bytes, got ${keyBuffer.length}`);
		return await crypto.subtle.importKey('raw', keyBuffer, { name: ALGORITHM }, false, ['encrypt', 'decrypt']);
	} catch (error) {
		logger.error('Failed to import encryption key', { keyId: id, error });
		throw new Error('Could not import encryption key. Check if it is a valid Base64-encoded 256-bit key.', { cause: error });
	}
}

const gcm = (iv: Uint8Array, boundTo?: string) => ({
	name: ALGORITHM,
	iv,
	...(boundTo !== undefined ? { additionalData: new TextEncoder().encode(boundTo) } : {}),
});

/**
 * Encrypts a plaintext string using AES-GCM.
 * The IV is prepended to the ciphertext for use during decryption.
 *
 * @param plaintext - The data to encrypt
 * @param key - A key with its id, or the Base64 master key
 * @param boundTo - What the value belongs to; decrypting needs the same text
 * @returns A Base64-encoded string containing the IV and ciphertext
 * @throws Error if encryption fails
 */
export async function encrypt(plaintext: string, key: string | EncryptionKey, boundTo?: string): Promise<string> {
	const cryptoKey = await getKey(key);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoder = new TextEncoder();
	const encodedPlaintext = encoder.encode(plaintext);

	const ciphertext = await crypto.subtle.encrypt(gcm(iv, boundTo), cryptoKey, encodedPlaintext);

	const encryptedBuffer = new Uint8Array(iv.length + ciphertext.byteLength);
	encryptedBuffer.set(iv, 0);
	encryptedBuffer.set(new Uint8Array(ciphertext), iv.length);

	// Convert buffer to Base64 for storage
	const base64String = btoa(String.fromCharCode(...Array.from(encryptedBuffer)));
	return base64String;
}

/**
 * Decrypts a Base64-encoded ciphertext string using AES-GCM.
 * It assumes the IV is prepended to the ciphertext.
 *
 * @param base64Ciphertext - The Base64-encoded string containing IV + ciphertext
 * @param key - The key it was encrypted with
 * @param boundTo - The text it was bound to, if any
 * @returns The decrypted plaintext
 * @throws Error if decryption fails
 */
export async function decrypt(base64Ciphertext: string, key: string | EncryptionKey, boundTo?: string): Promise<string> {
	const cryptoKey = await getKey(key);

	const encryptedData = atob(base64Ciphertext);
	const encryptedBuffer = Uint8Array.from(encryptedData, (c) => c.charCodeAt(0));

	const iv = encryptedBuffer.slice(0, IV_LENGTH);
	const ciphertext = encryptedBuffer.slice(IV_LENGTH);

	const decryptedBuffer = await crypto.subtle.decrypt(gcm(iv, boundTo), cryptoKey, ciphertext);

	const decoder = new TextDecoder();
	return decoder.decode(decryptedBuffer);
}
