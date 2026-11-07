import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { verifyAdminRequest } from '../auth-middleware';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';

/**
 * verifyM2MAuth must accept only tokens whose `iss` equals OPENAUTH_ISSUER.
 * X-Forwarded-Host / X-Forwarded-Proto must not influence the accepted issuer.
 */
describe('M2M token issuer pinning', () => {
  let privateKey: CryptoKey;
  let previousKey: string | null;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey as CryptoKey;
    previousKey = await env.AUTH_STORAGE.get(SIGNING_KEY_KV_KEY);
    await env.AUTH_STORAGE.put(
      SIGNING_KEY_KV_KEY,
      JSON.stringify({ id: 'test-kid', alg: 'ES256', publicKey: await exportSPKI(pair.publicKey), privateKey: '', created: Date.now() })
    );
    clearJWKSCache();
  });

  afterAll(async () => {
    if (previousKey) await env.AUTH_STORAGE.put(SIGNING_KEY_KV_KEY, previousKey);
    else await env.AUTH_STORAGE.delete(SIGNING_KEY_KV_KEY);
    clearJWKSCache();
  });

  async function m2mToken(iss: string) {
    return new SignJWT({ client_id: 'admin-client', scope: 'admin:*', mode: 'access' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
      .setIssuer(iss)
      .setSubject('admin-client')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('the test environment pins the local-dev issuer', () => {
    expect(env.OPENAUTH_ISSUER).toBe('http://localhost:3301');
  });

  it('rejects a token issued for a forwarded host even when X-Forwarded-* match it', async () => {
    const token = await m2mToken('https://evil.example');
    const request = new Request('http://localhost:3301/admin/users', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'https',
        'X-Acting-User-Id': 'admin',
      },
    });
    await expect(verifyAdminRequest(request, env, 'admin:*')).rejects.toThrow(/iss/i);
  });

  it('accepts the signature/issuer of a token minted for OPENAUTH_ISSUER', async () => {
    const token = await m2mToken('http://localhost:3301');
    const request = new Request('http://localhost:3301/admin/users', {
      headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' },
    });
    // Passes token verification and fails only on the next check (missing acting user)
    await expect(verifyAdminRequest(request, env, 'admin:*')).rejects.toThrow('M2M requests must include acting user ID');
  });
});
