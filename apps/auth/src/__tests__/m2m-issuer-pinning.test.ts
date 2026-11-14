import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { verifyAdminRequest } from '../auth-middleware';
import { clearJWKSCache, SIGNING_KEY_KV_KEY } from '../utils/jwks-cache';
import { setupDatabase } from '../test-setup';
import { userRoleRoutes } from '../custom/user-role-routes';

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

  async function m2mToken(iss: string, claims: Record<string, unknown> = {}) {
    return new SignJWT({ client_id: 'admin-client', scope: 'admin:*', mode: 'm2m', ...claims })
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

  describe('scope and token type (a forged or low-scope M2M token never acts for an admin)', () => {
    const request = (token: string) =>
      new Request('http://localhost:3301/admin/users', { headers: { Authorization: `Bearer ${token}`, 'X-Acting-User-Id': 'audit-admin' } });

    it('rejects a client without an admin scope (e.g. the videos moderation client)', async () => {
      const token = await m2mToken('http://localhost:3301', { client_id: 'videos-moderation', scope: 'moderation:request' });
      await expect(verifyAdminRequest(request(token), env, 'admin:roles')).rejects.toThrow('Forbidden: admin scope required');
    });

    it('rejects a client with no scope at all', async () => {
      const token = await m2mToken('http://localhost:3301', { scope: undefined });
      await expect(verifyAdminRequest(request(token), env, 'admin:*')).rejects.toThrow('Forbidden: admin scope required');
    });

    it('rejects a signed token that is not a client_credentials token (mode "access")', async () => {
      const token = await m2mToken('http://localhost:3301', { mode: 'access' });
      await expect(verifyAdminRequest(request(token), env, 'admin:*')).rejects.toThrow('not an M2M token');
    });

    it('rejects a token signed with another key, even with an admin scope', async () => {
      const other = await generateKeyPair('ES256', { extractable: true });
      const token = await new SignJWT({ client_id: 'admin-client', scope: 'admin:*', mode: 'm2m' })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
        .setIssuer('http://localhost:3301')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(other.privateKey as CryptoKey);
      await expect(verifyAdminRequest(request(token), env, 'admin:*')).rejects.toThrow(/signature/i);
    });

    it('rejects an unsigned (alg none) token', async () => {
      const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      const now = Math.floor(Date.now() / 1000);
      const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ client_id: 'admin-client', scope: 'admin:*', mode: 'm2m', iss: 'http://localhost:3301', iat: now, exp: now + 300 })}.`;
      await expect(verifyAdminRequest(request(token), env, 'admin:*')).rejects.toThrow();
    });

    it('rejects an expired token', async () => {
      const token = await new SignJWT({ client_id: 'admin-client', scope: 'admin:*', mode: 'm2m' })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-kid' })
        .setIssuer('http://localhost:3301')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(privateKey);
      await expect(verifyAdminRequest(request(token), env, 'admin:*')).rejects.toThrow(/exp/i);
    });
  });

  describe('userRoleRoutes (M2M via verifyAdminRequest)', () => {
    let memberRoleId: string;

    beforeAll(async () => {
      await setupDatabase();
      await env.AUTH_DB.prepare(
        `INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_pin_admin', 'Admin', 'default'), ('role_pin_member', 'PinMember', 'default')`
      ).run();
      const admin = await env.AUTH_DB.prepare(`SELECT id FROM rbac_roles WHERE name = 'Admin' AND tenant_id = 'default'`).first<{ id: string }>();
      memberRoleId = 'role_pin_member';
      await env.AUTH_DB.prepare(
        `INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) VALUES ('audit-admin', ?, 'default', ?, 'test')`
      ).bind(admin!.id, Date.now()).run();
      await env.AUTH_DB.prepare(`DELETE FROM rbac_user_roles WHERE user_id = 'target-user' AND role_id = ?`).bind(memberRoleId).run();
    });

    async function assign(app: ReturnType<typeof userRoleRoutes>, claims: Record<string, unknown> = {}) {
      const token = await m2mToken('http://localhost:3301', claims);
      return app.fetch(
        new Request('http://localhost:3301/target-user/roles', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Acting-User-Id': 'audit-admin',
          },
          body: JSON.stringify({ roleId: memberRoleId }),
        })
      );
    }

    it('assigns a role when the router passes OPENAUTH_ISSUER', async () => {
      const res = await assign(userRoleRoutes(env.AUTH_DB, env.AUTH_STORAGE, env.OPENAUTH_ISSUER));
      expect(res.status).toBe(200);
    });

    it('refuses a role assignment from an M2M client without an admin scope', async () => {
      await env.AUTH_DB.prepare(`DELETE FROM rbac_user_roles WHERE user_id = 'target-user' AND role_id = ?`).bind(memberRoleId).run();
      const res = await assign(userRoleRoutes(env.AUTH_DB, env.AUTH_STORAGE, env.OPENAUTH_ISSUER), { client_id: 'videos-moderation', scope: 'moderation:request' });
      expect(res.status).not.toBe(200);
      const row = await env.AUTH_DB.prepare(`SELECT 1 AS hit FROM rbac_user_roles WHERE user_id = 'target-user' AND role_id = ?`).bind(memberRoleId).first();
      expect(row).toBeNull();
    });

    it('rejects the M2M token when its iss differs from the configured issuer', async () => {
      const res = await assign(userRoleRoutes(env.AUTH_DB, env.AUTH_STORAGE, 'https://other-issuer.example'));
      expect(res.status).toBe(500);
    });
  });
});

