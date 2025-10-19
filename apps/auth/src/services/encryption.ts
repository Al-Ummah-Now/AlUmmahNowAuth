/**
 * @fileoverview Provides AES-GCM encryption and decryption services.
 * This service is used to encrypt private keys before they are stored in the database.
 *
 * Security considerations:
 * - Uses AES-256-GCM for authenticated encryption
 * - Master key must be stored as a Cloudflare Worker Secret
 * - IV is randomly generated for each encryption operation
 * - IV is prepended to ciphertext for use during decryption
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96 bits is recommended for AES-GCM

/**
 * A cache for the imported master crypto key to avoid re-importing on every request.
 * The key itself is stored securely as a Worker Secret.
 * This cache is safe because it's scoped to the Worker instance.
 */
let masterCryptoKey: CryptoKey | null = null;

/**
 * Imports the master encryption key from environment variables and prepares it for use.
 * The key is expected to be a Base64-encoded 256-bit (32-byte) string.
 *
 * @param masterKeyBase64 - Base64-encoded master encryption key from Worker Secret
 * @returns The imported CryptoKey object
 * @throws Error if the key is not defined or invalid
 */
async function getMasterKey(masterKeyBase64: string): Promise<CryptoKey> {
	if (masterCryptoKey) {
		return masterCryptoKey;
	}

	if (!masterKeyBase64) {
		throw new Error('KEY_ENCRYPTION_MASTER_KEY secret is not defined.');
	}

	try {
		const keyData = atob(masterKeyBase64);
		const keyBuffer = Uint8Array.from(keyData, (c) => c.charCodeAt(0));

		// Verify key length (must be 32 bytes for AES-256)
		if (keyBuffer.length !== 32) {
			throw new Error(`Invalid key length: expected 32 bytes, got ${keyBuffer.length}`);
		}

		masterCryptoKey = await crypto.subtle.importKey(
			'raw',
			keyBuffer,
			{ name: ALGORITHM },
			false, // not extractable (security best practice)
			['encrypt', 'decrypt']
		);
		return masterCryptoKey;
	} catch (error) {
		console.error('Failed to import master encryption key:', error);
		throw new Error(
			'Could not import master encryption key. Check if it is a valid Base64-encoded 256-bit key.'
		);
	}
}

/**
 * Encrypts a plaintext string using AES-GCM.
 * The IV is prepended to the ciphertext for use during decryption.
 *
 * @param plaintext - The data to encrypt
 * @param masterKeyBase64 - Base64-encoded master encryption key
 * @returns A Base64-encoded string containing the IV and ciphertext
 * @throws Error if encryption fails
 */
export async function encrypt(plaintext: string, masterKeyBase64: string): Promise<string> {
	const masterKey = await getMasterKey(masterKeyBase64);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encoder = new TextEncoder();
	const encodedPlaintext = encoder.encode(plaintext);

	const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, masterKey, encodedPlaintext);

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
 * @param masterKeyBase64 - Base64-encoded master encryption key
 * @returns The decrypted plaintext
 * @throws Error if decryption fails
 */
export async function decrypt(base64Ciphertext: string, masterKeyBase64: string): Promise<string> {
	const masterKey = await getMasterKey(masterKeyBase64);

	const encryptedData = atob(base64Ciphertext);
	const encryptedBuffer = Uint8Array.from(encryptedData, (c) => c.charCodeAt(0));

	const iv = encryptedBuffer.slice(0, IV_LENGTH);
	const ciphertext = encryptedBuffer.slice(IV_LENGTH);

	const decryptedBuffer = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, masterKey, ciphertext);

	const decoder = new TextDecoder();
	return decoder.decode(decryptedBuffer);
}
