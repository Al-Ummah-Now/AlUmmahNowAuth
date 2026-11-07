/**
 * Admin Enterprise Routes Test Suite
 *
 * Tests for:
 * - Token audit (token_usage) viewing and filtering
 * - Audit log (audit_events) viewing and filtering
 * - User token management (force logout)
 * - Health and metrics endpoints
 *
 * Note: OAuth client management routes were moved to OpenAuth's clientAdminRoutes
 * and are tested in oauth-client-e2e.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { AdminEnterpriseRoutes } from '../admin-enterprise-routes';

// Mock the auth middleware
vi.mock('../auth-middleware', () => ({
  verifyAdminRequest: vi.fn().mockResolvedValue({
    type: 'user',
    user: { id: 'admin-user', email: 'admin@test.com', roles: ['admin'] },
    permissions: [],
    isAdmin: true,
  }),
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
vi.mock('../audit-emitter', () => ({
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
      // Seed token usage records (live schema: created_at in ms, token_type = lifecycle event)
      const now = Date.now();
      const records = [
        { id: 'token-audit-1', user_id: 'user-123', token_type: 'generated', client_id: 'client-web', created_at: now - 3_600_000, ip_address: '192.168.1.1', user_agent: 'Mozilla/5.0' },
        { id: 'token-audit-2', user_id: 'user-456', token_type: 'refreshed', client_id: 'client-mobile', created_at: now - 1_800_000, ip_address: '192.168.1.2', user_agent: 'MobileApp/1.0' },
        { id: 'token-audit-3', user_id: 'user-123', token_type: 'revoked', client_id: 'client-web', created_at: now - 900_000, ip_address: '192.168.1.1', user_agent: 'Mozilla/5.0' },
      ];

      for (const r of records) {
        await env.AUTH_DB.prepare(`
          INSERT INTO token_usage (id, tenant_id, client_id, user_id, token_type, ip_address, user_agent, created_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?)
        `).bind(r.id, r.client_id, r.user_id, r.token_type, r.ip_address, r.user_agent, r.created_at).run();
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

    it('GET /admin/audit should search across user_id, client_id, and ip_address', async () => {
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

    it('GET /admin/audit returns newest first with ISO created_at from ms timestamps', async () => {
      const request = new Request('http://localhost/admin/audit', { method: 'GET' });
      const response = await routes.handle(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.data.map((r: any) => r.id)).toEqual(['token-audit-3', 'token-audit-2', 'token-audit-1']);
      const age = Date.now() - new Date(data.data[0].created_at).getTime();
      expect(age).toBeGreaterThan(800_000);
      expect(age).toBeLessThan(1_000_000);
    });

    it('GET /admin/audit filters by from/to (ms) and rejects invalid dates', async () => {
      const from = new Date(Date.now() - 2_000_000).toISOString();
      const ok = await routes.handle(new Request(`http://localhost/admin/audit?from=${from}`), mockEnv, mockCtx);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).data).toHaveLength(2);

      const bad = await routes.handle(new Request('http://localhost/admin/audit?to=not-a-date'), mockEnv, mockCtx);
      expect(bad.status).toBe(400);
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
      // Public client (no client_secret_hash)
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES ('id-1', 'default', 'Metrics Test Client 1', '[]', '["openid","profile","email"]', '[]', 1, ?, ?)
      `).bind(Date.now(), Date.now()).run();

      // Confidential client (has client_secret_hash)
      await env.AUTH_DB.prepare(`
        INSERT INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, enabled, created_at, updated_at)
        VALUES ('id-2', 'default', 'Metrics Test Client 2', 'hashed_secret_value', '[]', '["openid","profile","email"]', '[]', 1, ?, ?)
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
