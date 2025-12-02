/**
 * Phase 0: Validate jose library compatibility with Cloudflare Workers
 * This test ensures jose works with the Workers runtime and Web Crypto API
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair, SignJWT, jwtVerify, exportJWK, importJWK } from 'jose';

describe('jose library compatibility with Workers runtime', () => {
	it('should generate RS256 key pair using jose', async () => {
		const keyPair = await generateKeyPair('RS256', {
			modulusLength: 2048,
		});

		expect(keyPair.publicKey).toBeDefined();
		expect(keyPair.privateKey).toBeDefined();
	});

	it('should sign a JWT with RS256', async () => {
		const keyPair = await generateKeyPair('RS256', {
			modulusLength: 2048,
		});

		const jwt = await new SignJWT({ userId: 'test-user-123', email: 'test@example.com' })
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
			.setIssuer('https://auth.alummahnow.net')
			.setAudience('https://api.alummahnow.net')
			.setExpirationTime('15m')
			.setIssuedAt()
			.sign(keyPair.privateKey);

		expect(jwt).toBeDefined();
		expect(typeof jwt).toBe('string');
		expect(jwt.split('.')).toHaveLength(3); // JWT has 3 parts
	});

	it('should verify a signed JWT', async () => {
		const keyPair = await generateKeyPair('RS256', {
			modulusLength: 2048,
		});

		const payload = {
			userId: 'test-user-123',
			email: 'test@example.com',
			role: 'user',
		};

		const jwt = await new SignJWT(payload)
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
			.setIssuer('https://auth.alummahnow.net')
			.setAudience('https://api.alummahnow.net')
			.setExpirationTime('15m')
			.setIssuedAt()
			.sign(keyPair.privateKey);

		const { payload: verifiedPayload, protectedHeader } = await jwtVerify(jwt, keyPair.publicKey, {
			issuer: 'https://auth.alummahnow.net',
			audience: 'https://api.alummahnow.net',
		});

		expect(verifiedPayload.userId).toBe(payload.userId);
		expect(verifiedPayload.email).toBe(payload.email);
		expect(verifiedPayload.role).toBe(payload.role);
		expect(protectedHeader.alg).toBe('RS256');
		expect(protectedHeader.kid).toBe('test-key-1');
	});

	it('should export and import keys as JWK', async () => {
		const keyPair = await generateKeyPair('RS256', {
			modulusLength: 2048,
			extractable: true, // CRITICAL: Keys must be extractable for storage
		});

		// Export to JWK
		const publicJWK = await exportJWK(keyPair.publicKey);
		const privateJWK = await exportJWK(keyPair.privateKey);

		expect(publicJWK.kty).toBe('RSA');
		expect(publicJWK.n).toBeDefined(); // modulus
		expect(publicJWK.e).toBeDefined(); // exponent

		expect(privateJWK.kty).toBe('RSA');
		expect(privateJWK.d).toBeDefined(); // private exponent

		// Import back from JWK
		const importedPublicKey = await importJWK(publicJWK, 'RS256');
		const importedPrivateKey = await importJWK(privateJWK, 'RS256');

		// Test that imported keys work
		const jwt = await new SignJWT({ test: 'data' })
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer('test')
			.setExpirationTime('1h')
			.sign(importedPrivateKey);

		const { payload } = await jwtVerify(jwt, importedPublicKey, {
			issuer: 'test',
		});

		expect(payload.test).toBe('data');
	});

	it('should handle kid in JWT header for key rotation', async () => {
		// Simulate key rotation scenario with multiple keys
		const oldKeyPair = await generateKeyPair('RS256', { modulusLength: 2048 });
		const newKeyPair = await generateKeyPair('RS256', { modulusLength: 2048 });

		const oldKeyId = 'key_2024_q4';
		const newKeyId = 'key_2025_q1';

		// Create JWT with old key
		const oldJWT = await new SignJWT({ data: 'signed with old key' })
			.setProtectedHeader({ alg: 'RS256', kid: oldKeyId })
			.setIssuer('test')
			.setExpirationTime('1h')
			.sign(oldKeyPair.privateKey);

		// Create JWT with new key
		const newJWT = await new SignJWT({ data: 'signed with new key' })
			.setProtectedHeader({ alg: 'RS256', kid: newKeyId })
			.setIssuer('test')
			.setExpirationTime('1h')
			.sign(newKeyPair.privateKey);

		// Decode headers without verification to get kid
		const oldHeader = JSON.parse(atob(oldJWT.split('.')[0]));
		const newHeader = JSON.parse(atob(newJWT.split('.')[0]));

		expect(oldHeader.kid).toBe(oldKeyId);
		expect(newHeader.kid).toBe(newKeyId);

		// Verify with correct keys
		const oldVerified = await jwtVerify(oldJWT, oldKeyPair.publicKey, { issuer: 'test' });
		const newVerified = await jwtVerify(newJWT, newKeyPair.publicKey, { issuer: 'test' });

		expect(oldVerified.payload.data).toBe('signed with old key');
		expect(newVerified.payload.data).toBe('signed with new key');
	});

	it('should fail verification with wrong key', async () => {
		const keyPair1 = await generateKeyPair('RS256', { modulusLength: 2048 });
		const keyPair2 = await generateKeyPair('RS256', { modulusLength: 2048 });

		const jwt = await new SignJWT({ data: 'test' })
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer('test')
			.setExpirationTime('1h')
			.sign(keyPair1.privateKey);

		// Try to verify with wrong key
		await expect(async () => {
			await jwtVerify(jwt, keyPair2.publicKey, { issuer: 'test' });
		}).rejects.toThrow();
	});

	it('should handle expired tokens', async () => {
		const keyPair = await generateKeyPair('RS256', { modulusLength: 2048 });

		// Create an already expired token (negative expiration time)
		const jwt = await new SignJWT({ data: 'test' })
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer('test')
			.setExpirationTime('-1s') // Already expired
			.sign(keyPair.privateKey);

		await expect(async () => {
			await jwtVerify(jwt, keyPair.publicKey, { issuer: 'test' });
		}).rejects.toThrow();
	});
});
