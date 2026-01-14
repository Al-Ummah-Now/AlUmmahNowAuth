import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminContextMiddleware, methodCompatMiddleware } from './admin-context-middleware';

describe('Admin Context Middleware', () => {
	describe('adminContextMiddleware', () => {
		let app: Hono;

		beforeEach(() => {
			app = new Hono();
		});

		it('should set default tenant when no tenant context exists', async () => {
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					tenantId: c.get('tenantId'),
					tenant: c.get('tenant'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.tenantId).toBe('default');
			expect(data.tenant).toEqual({ id: 'default' });
		});

		it('should preserve existing tenantId from tenant middleware', async () => {
			app.use('*', async (c, next) => {
				c.set('tenantId', 'custom-tenant');
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					tenantId: c.get('tenantId'),
					tenant: c.get('tenant'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.tenantId).toBe('custom-tenant');
			expect(data.tenant).toEqual({ id: 'custom-tenant' });
		});

		it('should preserve existing tenant object', async () => {
			const existingTenant = {
				id: 'existing-tenant',
				name: 'Existing Tenant',
				slug: 'existing',
			};

			app.use('*', async (c, next) => {
				c.set('tenant', existingTenant);
				c.set('tenantId', existingTenant.id);
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					tenantId: c.get('tenantId'),
					tenant: c.get('tenant'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.tenantId).toBe('existing-tenant');
			expect(data.tenant).toEqual(existingTenant);
		});

		it('should set adminId from adminUser context', async () => {
			app.use('*', async (c, next) => {
				c.set('adminUser', {
					userId: 'admin-123',
					email: 'admin@example.com',
					roles: ['admin'],
				});
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					adminId: c.get('adminId'),
					isAdmin: c.get('isAdmin'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.adminId).toBe('admin-123');
			expect(data.isAdmin).toBe(true);
		});

		it('should set adminId from activeAccount when adminUser not present', async () => {
			app.use('*', async (c, next) => {
				c.set('activeAccount', {
					userId: 'user-456',
					email: 'user@example.com',
				});
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					adminId: c.get('adminId'),
					isAdmin: c.get('isAdmin'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.adminId).toBe('user-456');
			expect(data.isAdmin).toBe(true);
		});

		it('should set adminId from clientId for M2M authentication', async () => {
			app.use('*', async (c, next) => {
				c.set('clientId', 'client-789');
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					adminId: c.get('adminId'),
					isAdmin: c.get('isAdmin'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.adminId).toBe('client-789');
			expect(data.isAdmin).toBe(true);
		});

		it('should prioritize adminUser over activeAccount', async () => {
			app.use('*', async (c, next) => {
				c.set('adminUser', {
					userId: 'admin-123',
					email: 'admin@example.com',
					roles: ['admin'],
				});
				c.set('activeAccount', {
					userId: 'user-456',
					email: 'user@example.com',
				});
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					adminId: c.get('adminId'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.adminId).toBe('admin-123');
		});

		it('should prioritize activeAccount over clientId', async () => {
			app.use('*', async (c, next) => {
				c.set('activeAccount', {
					userId: 'user-456',
					email: 'user@example.com',
				});
				c.set('clientId', 'client-789');
				await next();
			});
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					adminId: c.get('adminId'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.adminId).toBe('user-456');
		});

		it('should set isAdmin to true even when no adminId is present', async () => {
			app.use('*', adminContextMiddleware);
			app.get('/test', (c) => {
				return c.json({
					isAdmin: c.get('isAdmin'),
					adminId: c.get('adminId'),
				});
			});

			const response = await app.request('/test');
			const data = await response.json();

			expect(data.isAdmin).toBe(true);
			expect(data.adminId).toBeUndefined();
		});
	});

	describe('methodCompatMiddleware', () => {
		let app: Hono;

		beforeEach(() => {
			app = new Hono();
		});

		it('should translate PUT to PATCH', async () => {
			app.use('*', methodCompatMiddleware);
			app.all('/test', (c) => {
				return c.json({
					method: c.req.method,
				});
			});

			const response = await app.request('/test', {
				method: 'PUT',
			});
			const data = await response.json();

			expect(data.method).toBe('PATCH');
		});

		it('should not modify GET requests', async () => {
			app.use('*', methodCompatMiddleware);
			app.all('/test', (c) => {
				return c.json({
					method: c.req.method,
				});
			});

			const response = await app.request('/test', {
				method: 'GET',
			});
			const data = await response.json();

			expect(data.method).toBe('GET');
		});

		it('should not modify POST requests', async () => {
			app.use('*', methodCompatMiddleware);
			app.all('/test', (c) => {
				return c.json({
					method: c.req.method,
				});
			});

			const response = await app.request('/test', {
				method: 'POST',
			});
			const data = await response.json();

			expect(data.method).toBe('POST');
		});

		it('should not modify DELETE requests', async () => {
			app.use('*', methodCompatMiddleware);
			app.all('/test', (c) => {
				return c.json({
					method: c.req.method,
				});
			});

			const response = await app.request('/test', {
				method: 'DELETE',
			});
			const data = await response.json();

			expect(data.method).toBe('DELETE');
		});

		it('should not modify PATCH requests', async () => {
			app.use('*', methodCompatMiddleware);
			app.all('/test', (c) => {
				return c.json({
					method: c.req.method,
				});
			});

			const response = await app.request('/test', {
				method: 'PATCH',
			});
			const data = await response.json();

			expect(data.method).toBe('PATCH');
		});
	});

	describe('Combined middleware usage', () => {
		it('should work together for OpenAuth compatibility', async () => {
			const app = new Hono();

			// Simulate session middleware
			app.use('*', async (c, next) => {
				c.set('adminUser', {
					userId: 'admin-123',
					email: 'admin@example.com',
					roles: ['admin'],
				});
				await next();
			});

			// Apply both middleware
			app.use('*', adminContextMiddleware);
			app.use('*', methodCompatMiddleware);

			// Simulate route handler
			app.all('/admin/users/:id', (c) => {
				return c.json({
					method: c.req.method,
					tenantId: c.get('tenantId'),
					adminId: c.get('adminId'),
					isAdmin: c.get('isAdmin'),
				});
			});

			const response = await app.request('/admin/users/user-123', {
				method: 'PUT',
			});
			const data = await response.json();

			expect(data.method).toBe('PATCH');
			expect(data.tenantId).toBe('default');
			expect(data.adminId).toBe('admin-123');
			expect(data.isAdmin).toBe(true);
		});
	});
});
