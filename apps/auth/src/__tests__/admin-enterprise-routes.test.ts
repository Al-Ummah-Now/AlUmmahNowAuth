/**
 * Admin Enterprise Routes Test Suite
 *
 * Tests for:
 * - Audit log viewing and filtering
 * - OAuth client management (CRUD)
 * - User token management (force logout)
 * - Health and metrics endpoints
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { AdminEnterpriseRoutes } from '../admin-enterprise-routes';

// Mock the auth middleware
vi.mock('../auth-middleware', () => ({
  verifyAdminAuth: vi.fn().mockResolvedValue({
    user: { id: 'admin-user', email: 'admin@test.com', roles: ['admin'] },
    isAdmin: true,
  }),
  createAuthErrorResponse: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message, status }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

// Mock logger
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock audit emitter
vi.mock('../audit-emitter-enhanced', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock rate limiting to always allow
vi.mock('../rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 3600000 }),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

describe('AdminEnterpriseRoutes', () => {
  let routes: AdminEnterpriseRoutes;
  const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const mockEnv = env as unknown as Env;

  beforeEach(async () => {
    routes = new AdminEnterpriseRoutes(env.AUTH_DB, env.AUTH_STORAGE);

    // Clean up tables before each test (with error handling for tables that might not exist)
    try { await env.AUTH_DB.prepare('DELETE FROM audit_events').run(); } catch (e) { /* ignore */ }
    try { await env.AUTH_DB.prepare('DELETE FROM oauth_clients').run(); } catch (e) { /* ignore */ }
    try { await env.AUTH_DB.prepare('DELETE FROM refresh_tokens').run(); } catch (e) { /* ignore */ }
    try { await env.AUTH_DB.prepare('DELETE FROM token_usage').run(); } catch (e) { /* ignore */ }
    try { await env.AUTH_DB.prepare('DELETE FROM users WHERE id LIKE \'user-%\'').run(); } catch (e) { /* ignore */ }
  });

  // ==========================================================================
  // Token Audit Tests
  // ==========================================================================

  describe('Token Audit', () => {
    beforeEach(async () => {
      // Seed token usage records
      const now = Math.floor(Date.now() / 1000);
      const records = [
        {
          id: 'token-audit-1',
          token_id: 'token-123',
          subject: 'user:user-123',
          event_type: 'generated',
          client_id: 'client-web',
          timestamp: now - 3600,
          ip_address: '192.168.1.1',
          user_agent: 'Mozilla/5.0',
        },
        {
          id: 'token-audit-2',
          token_id: 'token-456',
          subject: 'user:user-456',
          event_type: 'refreshed',
          client_id: 'client-mobile',
          timestamp: now - 1800,
          ip_address: '192.168.1.2',
          user_agent: 'MobileApp/1.0',
        },
        {
          id: 'token-audit-3',
          token_id: 'token-789',
          subject: 'user:user-123',
          event_type: 'revoked',
          client_id: 'client-web',
          timestamp: now - 900,
          ip_address: '192.168.1.1',
          user_agent: 'Mozilla/5.0',
        },
      ];

      for (const record of records) {
        await env.AUTH_DB.prepare(`
          INSERT INTO token_usage (id, token_id, subject, event_type, client_id, timestamp, ip_address, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          record.id,
          record.token_id,
          record.subject,
          record.event_type,
          record.client_id,
          record.timestamp,
          record.ip_address,
          record.user_agent
        ).run();
      }
    });

    it('GET /admin/audit should return paginated token audit logs', async () => {
      const request = new Request('http://localhost/admin/audit', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(3);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.total).toBe(3);
      expect(data.data[0]).toHaveProperty('user_id');
      expect(data.data[0]).toHaveProperty('client_id');
      expect(data.data[0]).toHaveProperty('action');
      expect(data.data[0]).toHaveProperty('created_at');
    });

    it('GET /admin/audit should filter by user_id', async () => {
      const request = new Request('http://localhost/admin/audit?user_id=user-123', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(2);
      data.data.forEach((record: any) => {
        expect(record.user_id).toBe('user-123');
      });
    });

    it('GET /admin/audit should filter by action', async () => {
      const request = new Request('http://localhost/admin/audit?action=generated', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].action).toBe('generated');
    });

    it('GET /admin/audit should filter by client_id', async () => {
      const request = new Request('http://localhost/admin/audit?client_id=client-mobile', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].client_id).toBe('client-mobile');
    });

    it('GET /admin/audit should search across subject, client_id, and ip_address', async () => {
      const request = new Request('http://localhost/admin/audit?search=192.168.1.2', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].ip_address).toBe('192.168.1.2');
    });

    it('GET /admin/audit should respect pagination limit', async () => {
      const request = new Request('http://localhost/admin/audit?limit=2', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(2);
      expect(data.pagination.limit).toBe(2);
      expect(data.pagination.totalPages).toBe(2);
    });

    it('GET /admin/audit should transform subject to user_id', async () => {
      const request = new Request('http://localhost/admin/audit', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      // Check that user_id is extracted from subject (user:user-123 -> user-123)
      expect(data.data[0].user_id).not.toContain('user:');
      expect(['user-123', 'user-456']).toContain(data.data[0].user_id);
    });
  });

  // ==========================================================================
  // Audit Log Tests
  // ==========================================================================

  describe('Audit Logs', () => {
    beforeEach(async () => {
      // Seed audit events
      const events = [
        { timestamp: '2024-01-15T10:00:00Z', event_type: 'auth.login.success', severity: 'info', user_id: 'user-123', success: 1 },
        { timestamp: '2024-01-15T11:00:00Z', event_type: 'auth.login.failed', severity: 'warning', user_id: 'user-456', success: 0 },
        { timestamp: '2024-01-15T12:00:00Z', event_type: 'security.alert', severity: 'critical', user_id: 'user-123', success: 1 },
      ];

      for (const event of events) {
        await env.AUTH_DB.prepare(`
          INSERT INTO audit_events (timestamp, event_type, severity, user_id, success, metadata)
          VALUES (?, ?, ?, ?, ?, '{}')
        `).bind(event.timestamp, event.event_type, event.severity, event.user_id, event.success).run();
      }
    });

    it('GET /admin/audit-logs should return paginated audit events', async () => {
      const request = new Request('http://localhost/admin/audit-logs', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(3);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.total).toBe(3);
    });

    it('GET /admin/audit-logs should filter by event_type', async () => {
      const request = new Request('http://localhost/admin/audit-logs?event_type=auth.login.success', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].event_type).toBe('auth.login.success');
    });

    it('GET /admin/audit-logs should filter by severity', async () => {
      const request = new Request('http://localhost/admin/audit-logs?severity=critical', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].severity).toBe('critical');
    });

    it('GET /admin/audit-logs should filter by user_id', async () => {
      const request = new Request('http://localhost/admin/audit-logs?user_id=user-123', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(2);
      data.data.forEach((event: any) => {
        expect(event.user_id).toBe('user-123');
      });
    });

    it('GET /admin/audit-logs/stats should return statistics', async () => {
      const request = new Request('http://localhost/admin/audit-logs/stats', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.by_severity).toBeDefined();
      expect(data.by_event_type).toBeDefined();
      expect(data.totals).toBeDefined();
    });

    it('GET /admin/audit-logs/user/:userId should return user audit trail', async () => {
      const request = new Request('http://localhost/admin/audit-logs/user/user-123', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data).toHaveLength(2);
      expect(data.pagination.total).toBe(2);
    });
  });

  // ==========================================================================
  // OAuth Client Tests
  // ==========================================================================

  describe('OAuth Client Management', () => {
    it('GET /admin/clients should return empty list initially', async () => {
      const request = new Request('http://localhost/admin/clients', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.clients).toEqual([]);
    });

    it('POST /admin/clients should create a public client', async () => {
      const request = new Request('http://localhost/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-public-client',
          client_type: 'public',
          allowed_grants: ['authorization_code'],
          redirect_uris: ['http://localhost:3000/callback'],
        }),
      });

      const response = await routes.handle(request, mockEnv, mockCtx);
      expect(response.status).toBe(201);

      const data = await response.json() as any;
      expect(data.client_id).toBe('test-public-client');
      expect(data.client_type).toBe('public');
      expect(data.client_secret).toBeUndefined(); // Public clients don't get secrets
    });

    it('POST /admin/clients should create a confidential client with secret', async () => {
      const request = new Request('http://localhost/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-confidential-client',
          client_type: 'confidential',
          allowed_grants: ['client_credentials'],
          redirect_uris: ['http://localhost:3000/callback'],
        }),
      });

      const response = await routes.handle(request, mockEnv, mockCtx);
      expect(response.status).toBe(201);

      const data = await response.json() as any;
      expect(data.client_id).toBe('test-confidential-client');
      expect(data.client_type).toBe('confidential');
      expect(data.client_secret).toBeDefined();
      expect(data.client_secret.length).toBe(64); // 32 bytes hex encoded
      expect(data.warning).toContain('Store the client_secret securely');
    });

    it('GET /admin/clients/:clientId should return client details', async () => {
      // First create a client
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES (?, 'default', 'My Test Client', '["authorization_code"]', '["openid","profile","email"]', '["http://localhost/cb"]', 1, ?, ?)
      `).bind('my-client', Date.now(), Date.now()).run();

      const request = new Request('http://localhost/admin/clients/my-client', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.client_id).toBe('my-client');
      expect(data.allowed_grants).toEqual(['authorization_code']);
    });

    it('GET /admin/clients/:clientId should return 404 for non-existent client', async () => {
      const request = new Request('http://localhost/admin/clients/non-existent', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(404);
    });

    it('PUT /admin/clients/:clientId should update client', async () => {
      // First create a client
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES (?, 'default', 'Update Test Client', '["authorization_code"]', '["openid","profile","email"]', '["http://localhost/cb"]', 1, ?, ?)
      `).bind('update-client', Date.now(), Date.now()).run();

      const request = new Request('http://localhost/admin/clients/update-client', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost/new-callback', 'http://localhost/cb2'],
        }),
      });

      const response = await routes.handle(request, mockEnv, mockCtx);
      expect(response.status).toBe(200);

      // Verify the update
      const client = await env.AUTH_DB.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?')
        .bind('update-client').first<{ redirect_uris: string }>();
      expect(JSON.parse(client!.redirect_uris)).toEqual(['http://localhost/new-callback', 'http://localhost/cb2']);
    });

    it('DELETE /admin/clients/:clientId should delete client', async () => {
      // First create a client
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES (?, 'default', 'Delete Test Client', '["authorization_code"]', '["openid","profile","email"]', '["http://localhost/cb"]', 1, ?, ?)
      `).bind('delete-client', Date.now(), Date.now()).run();

      const request = new Request('http://localhost/admin/clients/delete-client', { method: 'DELETE' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);

      // Verify deletion
      const client = await env.AUTH_DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
        .bind('delete-client').first();
      expect(client).toBeNull();
    });

    it('POST /admin/clients/:clientId/rotate-secret should rotate confidential client secret', async () => {
      // Create a confidential client with a secret
      const oldSecretHash = 'oldhash123';
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES (?, 'default', 'Rotate Test Client', ?, '["client_credentials"]', '["openid","profile","email"]', '["http://localhost/cb"]', 1, ?, ?)
      `).bind('rotate-client', oldSecretHash, Date.now(), Date.now()).run();

      const request = new Request('http://localhost/admin/clients/rotate-client/rotate-secret', { method: 'POST' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.client_secret).toBeDefined();
      expect(data.client_secret.length).toBe(64);

      // Verify the hash was updated
      const client = await env.AUTH_DB.prepare('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?')
        .bind('rotate-client').first<{ client_secret_hash: string }>();
      expect(client!.client_secret_hash).not.toBe(oldSecretHash);
    });

    it('POST /admin/clients/:clientId/rotate-secret should fail for public clients', async () => {
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES (?, 'default', 'Public Test Client', '["authorization_code"]', '["openid","profile","email"]', '["http://localhost/cb"]', 1, ?, ?)
      `).bind('public-client', Date.now(), Date.now()).run();

      const request = new Request('http://localhost/admin/clients/public-client/rotate-secret', { method: 'POST' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error).toContain('public clients');
    });
  });

  // ==========================================================================
  // User Token Management Tests
  // ==========================================================================

  describe('User Token Management', () => {
    beforeEach(async () => {
      const now = Math.floor(Date.now() / 1000);

      // Users user-123 and user-456 are created in test-setup.ts
      // Just ensure they exist with the correct schema (no email_verified column in OpenAuth)
      await env.AUTH_DB.prepare(`
        INSERT OR IGNORE INTO users (id, email, tenant_id, created_at, updated_at)
        VALUES ('user-123', 'user123@test.com', 'default', ?, ?)
      `).bind(now * 1000, now * 1000).run();

      await env.AUTH_DB.prepare(`
        INSERT OR IGNORE INTO users (id, email, tenant_id, created_at, updated_at)
        VALUES ('user-456', 'user456@test.com', 'default', ?, ?)
      `).bind(now * 1000, now * 1000).run();

      // Seed some refresh tokens
      const tokens = [
        { id: 'token-1', token_hash: 'hash1', user_id: 'user-123', client_id: 'client-1', expires_at: now + 3600, revoked: 0 },
        { id: 'token-2', token_hash: 'hash2', user_id: 'user-123', client_id: 'client-1', expires_at: now + 3600, revoked: 0 },
        { id: 'token-3', token_hash: 'hash3', user_id: 'user-456', client_id: 'client-1', expires_at: now + 3600, revoked: 0 },
        { id: 'token-4', token_hash: 'hash4', user_id: 'user-123', client_id: 'client-1', expires_at: now + 3600, revoked: 1 }, // Already revoked
      ];

      for (const token of tokens) {
        await env.AUTH_DB.prepare(`
          INSERT INTO refresh_tokens (id, token_hash, user_id, client_id, tenant_id, scope, expires_at, revoked, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(token.id, token.token_hash, token.user_id, token.client_id, 'default', 'openid email profile', token.expires_at, token.revoked, now * 1000).run();
      }
    });

    it('GET /admin/users/:userId/tokens should return user tokens and stats', async () => {
      const request = new Request('http://localhost/admin/users/user-123/tokens', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.tokens).toHaveLength(2); // Only active tokens
      expect(data.stats.active).toBe(2);
      expect(data.stats.revoked).toBe(1);
    });

    it('DELETE /admin/users/:userId/tokens should revoke all user tokens', async () => {
      const request = new Request('http://localhost/admin/users/user-123/tokens', { method: 'DELETE' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.tokens_revoked).toBe(2); // Only the 2 active tokens

      // Verify tokens are revoked
      const activeTokens = await env.AUTH_DB.prepare(
        'SELECT COUNT(*) as count FROM refresh_tokens WHERE user_id = ? AND revoked = 0'
      ).bind('user-123').first<{ count: number }>();
      expect(activeTokens!.count).toBe(0);
    });

    it('DELETE /admin/users/:userId/tokens should return 0 if no active tokens', async () => {
      const request = new Request('http://localhost/admin/users/non-existent-user/tokens', { method: 'DELETE' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.tokens_revoked).toBe(0);
      expect(data.message).toContain('No active tokens');
    });

    it('POST /admin/users/tokens/revoke should revoke tokens with custom reason', async () => {
      const request = new Request('http://localhost/admin/users/tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'user-123',
          reason: 'suspicious_activity',
        }),
      });

      const response = await routes.handle(request, mockEnv, mockCtx);
      expect(response.status).toBe(200);

      const data = await response.json() as any;
      expect(data.tokens_revoked).toBe(2);

      // Verify the reason was set
      const token = await env.AUTH_DB.prepare(
        'SELECT revoked_reason FROM refresh_tokens WHERE user_id = ? AND revoked = 1 LIMIT 1'
      ).bind('user-123').first<{ revoked_reason: string }>();
      expect(token!.revoked_reason).toBe('suspicious_activity');
    });
  });

  // ==========================================================================
  // Health & Metrics Tests
  // ==========================================================================

  describe('Health & Metrics', () => {
    it('GET /admin/health should return healthy status', async () => {
      const request = new Request('http://localhost/admin/health', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.status).toBe('healthy');
      expect(data.checks.database.status).toBe('healthy');
      expect(data.checks.kv_store.status).toBe('healthy');
    });

    it('GET /admin/metrics should return service metrics', async () => {
      // Seed some data for metrics
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES ('id-1', 'default', 'Metrics Test Client 1', '[]', '["openid","profile","email"]', '[]', 1, ?, ?)
      `).bind(Date.now(), Date.now()).run();

      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES ('id-2', 'default', 'Metrics Test Client 2', '[]', '["openid","profile","email"]', '[]', 1, ?, ?)
      `).bind(Date.now(), Date.now()).run();

      const request = new Request('http://localhost/admin/metrics', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.timestamp).toBeDefined();
      expect(data.users).toBeDefined();
      expect(data.tokens).toBeDefined();
      expect(data.audit).toBeDefined();
      expect(data.clients).toBeDefined();
      expect(data.clients.total_clients).toBe(2);
      expect(data.clients.public_clients).toBe(1);
      expect(data.clients.confidential_clients).toBe(1);
    });
  });

  // ==========================================================================
  // Route Not Found Tests
  // ==========================================================================

  describe('Route Not Found', () => {
    it('should return 404 for unknown routes', async () => {
      const request = new Request('http://localhost/admin/unknown', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(404);
    });
  });
});
