/**
 * Admin Stats Routes Test Suite
 *
 * Tests for:
 * - Dashboard statistics endpoint
 * - User counts (total, admins, regular)
 * - Role statistics
 * - User distribution by role
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import adminStatsRoutes from './admin-stats-routes';

// Mock the auth middleware to always allow admin
vi.mock('../middleware/admin-auth', () => ({
	requireAdmin: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
	requirePermission: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

// Mock rate limit to always allow
vi.mock('../middleware/rate-limit', () => ({
	rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

describe('AdminStatsRoutes', () => {
	const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

	beforeEach(async () => {
		// Ensure tables exist (minimal schema)
		await env.AUTH_DB.prepare(`
			CREATE TABLE IF NOT EXISTS tenants (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active',
				created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
			)
		`).run();

		await env.AUTH_DB.prepare(`
			INSERT OR IGNORE INTO tenants (id, name, status)
			VALUES ('default', 'Default Tenant', 'active')
		`).run();

		await env.AUTH_DB.prepare(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL,
				name TEXT,
				tenant_id TEXT NOT NULL DEFAULT 'default',
				status TEXT NOT NULL DEFAULT 'active',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(tenant_id, email)
			)
		`).run();

		await env.AUTH_DB.prepare(`
			CREATE TABLE IF NOT EXISTS rbac_roles (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				tenant_id TEXT NOT NULL,
				description TEXT,
				is_system_role INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
				UNIQUE(name, tenant_id)
			)
		`).run();

		await env.AUTH_DB.prepare(`
			CREATE TABLE IF NOT EXISTS rbac_user_roles (
				user_id TEXT NOT NULL,
				role_id TEXT NOT NULL,
				tenant_id TEXT NOT NULL,
				assigned_at INTEGER NOT NULL,
				expires_at INTEGER,
				assigned_by TEXT NOT NULL,
				PRIMARY KEY (user_id, role_id, tenant_id)
			)
		`).run();

		// Clean up tables before each test - delete in correct order for foreign keys
		await env.AUTH_DB.prepare('DELETE FROM rbac_user_roles').run();
		await env.AUTH_DB.prepare('DELETE FROM rbac_roles').run();
		await env.AUTH_DB.prepare('DELETE FROM users').run();
	});

	describe('GET /admin/stats', () => {
		it('should return correct stats with no users', async () => {
			const app = new Hono<{ Bindings: Env }>();
			app.use('*', async (c, next) => {
				c.set('tenantId', 'default');
				c.set('adminUser', { userId: 'admin-1', email: 'admin@test.com', roles: ['admin'] });
				await next();
			});
			app.route('/', adminStatsRoutes);

			const request = new Request('http://localhost/admin/stats');
			const response = await app.fetch(request, env, mockCtx);

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data).toEqual({
				users: {
					total: 0,
					admins: 0,
					regular: 0,
				},
				roles: expect.objectContaining({
					total: expect.any(Number),
					systemRoles: expect.any(Number),
					customRoles: expect.any(Number),
				}),
				usersByRole: expect.any(Array),
			});
		});

		it('should return correct stats with users and roles', async () => {
			// Create test users
			const user1 = await env.AUTH_DB.prepare(
				`INSERT INTO users (id, email, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			)
				.bind('user-1', 'user1@test.com', 'default', Date.now(), Date.now())
				.run();

			const user2 = await env.AUTH_DB.prepare(
				`INSERT INTO users (id, email, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			)
				.bind('user-2', 'user2@test.com', 'default', Date.now(), Date.now())
				.run();

			const user3 = await env.AUTH_DB.prepare(
				`INSERT INTO users (id, email, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			)
				.bind('user-3', 'user3@test.com', 'default', Date.now(), Date.now())
				.run();

			// Assign admin role to user1
			// Note: rbac_roles should have system roles from migrations
			// Let's verify admin role exists and create if needed
			const adminRole = await env.AUTH_DB.prepare(
				`SELECT id FROM rbac_roles WHERE name = 'admin' AND tenant_id = 'default'`
			).first<{ id: string }>();

			const adminRoleId = adminRole?.id || 'role_admin_default';

			// If no admin role exists, create it (for test environment)
			if (!adminRole) {
				await env.AUTH_DB.prepare(
					`INSERT INTO rbac_roles (id, name, tenant_id, is_system_role, created_at, updated_at)
					 VALUES (?, ?, ?, 1, ?, ?)`
				)
					.bind(adminRoleId, 'admin', 'default', Date.now(), Date.now())
					.run();
			}

			// Assign admin role to user1
			await env.AUTH_DB.prepare(
				`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
				 VALUES (?, ?, ?, ?, ?)`
			)
				.bind('user-1', adminRoleId, 'default', Date.now(), 'system')
				.run();

			// Create a custom role
			await env.AUTH_DB.prepare(
				`INSERT INTO rbac_roles (id, name, tenant_id, is_system_role, created_at, updated_at)
				 VALUES (?, ?, ?, 0, ?, ?)`
			)
				.bind('role-custom-1', 'editor', 'default', Date.now(), Date.now())
				.run();

			// Assign custom role to user2
			await env.AUTH_DB.prepare(
				`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
				 VALUES (?, ?, ?, ?, ?)`
			)
				.bind('user-2', 'role-custom-1', 'default', Date.now(), 'system')
				.run();

			const app = new Hono<{ Bindings: Env }>();
			app.use('*', async (c, next) => {
				c.set('tenantId', 'default');
				c.set('adminUser', { userId: 'admin-1', email: 'admin@test.com', roles: ['admin'] });
				await next();
			});
			app.route('/', adminStatsRoutes);

			const request = new Request('http://localhost/admin/stats');
			const response = await app.fetch(request, env, mockCtx);

			expect(response.status).toBe(200);

			const data = await response.json();

			// Verify user counts
			expect(data.users.total).toBe(3);
			expect(data.users.admins).toBeGreaterThanOrEqual(1); // At least user-1
			expect(data.users.regular).toBe(data.users.total - data.users.admins);

			// Verify role counts
			expect(data.roles.total).toBeGreaterThanOrEqual(2); // admin + custom role
			expect(data.roles.systemRoles).toBeGreaterThanOrEqual(1);
			expect(data.roles.customRoles).toBeGreaterThanOrEqual(1);

			// Verify usersByRole structure
			expect(data.usersByRole).toBeInstanceOf(Array);
			expect(data.usersByRole.length).toBeGreaterThan(0);

			// Find the custom role in usersByRole
			const editorRole = data.usersByRole.find((r: { roleName: string }) => r.roleName === 'editor');
			expect(editorRole).toBeDefined();
			expect(editorRole.userCount).toBe(1);
		});

		it('should handle database errors gracefully', async () => {
			const app = new Hono<{ Bindings: Env }>();
			app.use('*', async (c, next) => {
				c.set('tenantId', 'invalid-tenant-that-causes-error');
				c.set('adminUser', { userId: 'admin-1', email: 'admin@test.com', roles: ['admin'] });
				await next();
			});
			app.route('/', adminStatsRoutes);

			const request = new Request('http://localhost/admin/stats');
			const response = await app.fetch(request, env, mockCtx);

			// Should still return 200 with zero counts rather than crashing
			expect(response.status).toBe(200);
		});

		it('should correctly calculate regular users', async () => {
			// Create 5 regular users (INSERT OR IGNORE for idempotency)
			for (let i = 1; i <= 5; i++) {
				await env.AUTH_DB.prepare(
					`INSERT OR IGNORE INTO users (id, email, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
				)
					.bind(`user-${i}`, `user${i}@test.com`, 'default', Date.now(), Date.now())
					.run();
			}

			// Create 2 admin users (INSERT OR IGNORE for idempotency)
			for (let i = 6; i <= 7; i++) {
				await env.AUTH_DB.prepare(
					`INSERT OR IGNORE INTO users (id, email, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
				)
					.bind(`user-${i}`, `admin${i}@test.com`, 'default', Date.now(), Date.now())
					.run();
			}

			// Create the admin role (beforeEach clears all roles)
			const adminRoleId = 'role_admin';
			await env.AUTH_DB.prepare(
				`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, is_system_role, created_at, updated_at)
				 VALUES (?, 'Admin', 'default', 1, ?, ?)`
			).bind(adminRoleId, Date.now(), Date.now()).run();

			// Assign admin role to the 2 admin users
			for (let i = 6; i <= 7; i++) {
				await env.AUTH_DB.prepare(
					`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
					 VALUES (?, ?, ?, ?, ?)`
				)
					.bind(`user-${i}`, adminRoleId, 'default', Date.now(), 'system')
					.run();
			}

			const app = new Hono<{ Bindings: Env }>();
			app.use('*', async (c, next) => {
				c.set('tenantId', 'default');
				c.set('adminUser', { userId: 'admin-1', email: 'admin@test.com', roles: ['admin'] });
				await next();
			});
			app.route('/', adminStatsRoutes);

			const request = new Request('http://localhost/admin/stats');
			const response = await app.fetch(request, env, mockCtx);

			expect(response.status).toBe(200);

			const data = await response.json();
			expect(data.users.total).toBe(7);
			expect(data.users.admins).toBe(2);
			expect(data.users.regular).toBe(5);
		});
	});
});
