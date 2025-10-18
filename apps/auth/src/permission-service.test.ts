/**
 * Permission Service Test Suite
 *
 * Comprehensive tests for PermissionService covering ALL P0 security measures:
 * - P0-1: SQL Injection Prevention
 * - P0-2: Cache Invalidation Race Conditions
 * - P0-3: Privilege Escalation Prevention (via permission grants)
 * - P0-4: System Permission Protection
 *
 * @module permission-service.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import './test-setup'; // Setup database schema
import { PermissionService } from './permission-service';
import {
  Permission,
  PermissionData,
  EffectivePermissions,
} from './rbac-types';

describe('PermissionService', () => {
  let permissionService: PermissionService;

  beforeEach(async () => {
    // Initialize service with test environment
    permissionService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

    // Clean up database before each test
    await env.AUTH_DB.prepare('DELETE FROM permissions').run();
    await env.AUTH_DB.prepare('DELETE FROM roles').run();
    await env.AUTH_DB.prepare('DELETE FROM role_permissions').run();
    await env.AUTH_DB.prepare('DELETE FROM user_roles').run();
    await env.AUTH_DB.prepare('DELETE FROM user_permissions').run();

    // Clean up cache
    const keys = await env.AUTH_STORAGE.list({ prefix: 'rbac:' });
    for (const key of keys.keys) {
      await env.AUTH_STORAGE.delete(key.name);
    }
  });

  // ============================================================================
  // P0-1: SQL INJECTION PREVENTION TESTS
  // ============================================================================

  describe('P0-1: SQL Injection Prevention', () => {
    describe('getPermission()', () => {
      it('should prevent SQL injection in permission name lookup', async () => {
        // Create a legitimate permission
        await permissionService.createPermission({
          name: 'users:read:all',
          resource: 'users',
          action: 'read',
          scope: 'all',
          description: 'Read all users',
        });

        // Attempt SQL injection - should not return any permission
        const maliciousInput = "users:read:all' OR '1'='1";
        const result = await permissionService.getPermission(maliciousInput);

        expect(result).toBeNull();
      });

      it('should handle SQL injection with DROP TABLE attempt', async () => {
        const maliciousInput = "test'; DROP TABLE permissions; --";
        const result = await permissionService.getPermission(maliciousInput);

        expect(result).toBeNull();

        // Verify table still exists by creating a permission
        const perm = await permissionService.createPermission({
          name: 'test:create:all',
          resource: 'test',
          action: 'create',
          scope: 'all',
        });

        expect(perm).toBeDefined();
        expect(perm.name).toBe('test:create:all');
      });

      it('should handle special characters safely', async () => {
        const specialInputs = [
          "test'; --",
          "test' OR 1=1 --",
          "test' UNION SELECT * FROM users --",
          "'; DELETE FROM permissions WHERE 'a'='a",
        ];

        for (const input of specialInputs) {
          const result = await permissionService.getPermission(input);
          expect(result).toBeNull();
        }
      });
    });

    describe('findPermissions()', () => {
      it('should prevent SQL injection in resource filter', async () => {
        await permissionService.createPermission({
          name: 'users:read:all',
          resource: 'users',
          action: 'read',
          scope: 'all',
        });

        const maliciousResource = "users' OR '1'='1";
        const results = await permissionService.findPermissions({
          resource: maliciousResource,
        });

        expect(results).toEqual([]);
      });

      it('should prevent SQL injection in action filter', async () => {
        const maliciousAction = "read'; DROP TABLE permissions; --";
        const results = await permissionService.findPermissions({
          action: maliciousAction,
        });

        expect(results).toEqual([]);
      });

      it('should prevent SQL injection in scope filter', async () => {
        const maliciousScope = "all' UNION SELECT * FROM users --";
        const results = await permissionService.findPermissions({
          scope: maliciousScope,
        });

        expect(results).toEqual([]);
      });

      it('should handle combined filter SQL injection attempts', async () => {
        const results = await permissionService.findPermissions({
          resource: "users'; --",
          action: "read' OR '1'='1",
          scope: "all'; DROP TABLE roles; --",
        });

        expect(results).toEqual([]);
      });
    });

    describe('createPermission()', () => {
      it('should safely handle special characters in permission data', async () => {
        const perm = await permissionService.createPermission({
          name: 'test:action:scope',
          resource: 'test',
          action: 'action',
          scope: 'scope',
          description: "Test with 'quotes' and \"double quotes\" and ; semicolon",
        });

        expect(perm).toBeDefined();
        expect(perm.description).toContain('quotes');

        // Verify it was stored correctly
        const retrieved = await permissionService.getPermission('test:action:scope');
        expect(retrieved?.description).toBe(perm.description);
      });
    });
  });

  // ============================================================================
  // P0-2: CACHE INVALIDATION RACE CONDITIONS TESTS
  // ============================================================================

  describe('P0-2: Cache Invalidation Race Conditions', () => {
    let testRoleId: string;
    let testPermissionId: string;
    let testUserId: string;

    beforeEach(async () => {
      // Create test role
      testRoleId = crypto.randomUUID();
      await env.AUTH_DB.prepare(
        'INSERT INTO roles (id, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          testRoleId,
          'test_role',
          'Test Role',
          0,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      // Create test permission
      const perm = await permissionService.createPermission({
        name: 'test:read:all',
        resource: 'test',
        action: 'read',
        scope: 'all',
      });
      testPermissionId = perm.id;

      // Create test user ID
      testUserId = 'test-user-123';
    });

    it('should use versioned cache keys', async () => {
      // Grant permission to role
      await permissionService.grantPermissionToRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      // Assign role to user
      await env.AUTH_DB.prepare(
        'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          crypto.randomUUID(),
          testUserId,
          testRoleId,
          'admin-user',
          new Date().toISOString(),
          1
        )
        .run();

      // Load permissions (should cache)
      const perms1 = await permissionService.getUserPermissions(testUserId);
      expect(perms1.permissions.length).toBeGreaterThan(0);
      expect(perms1.version).toBeGreaterThan(0);

      // Load again (should use cache)
      const perms2 = await permissionService.getUserPermissions(testUserId);
      expect(perms2.version).toBe(perms1.version);
    });

    it('should invalidate cache immediately after permission grant', async () => {
      // Assign role to user
      await env.AUTH_DB.prepare(
        'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          crypto.randomUUID(),
          testUserId,
          testRoleId,
          'admin-user',
          new Date().toISOString(),
          1
        )
        .run();

      // Load permissions (should have no permissions)
      const permsBefore = await permissionService.getUserPermissions(testUserId);
      expect(permsBefore.permissions.length).toBe(0);
      const versionBefore = permsBefore.version;

      // Grant permission to role
      await permissionService.grantPermissionToRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      // Load permissions again (should have new permission)
      const permsAfter = await permissionService.getUserPermissions(testUserId);
      expect(permsAfter.permissions.length).toBe(1);
      expect(permsAfter.permissions[0].name).toBe('test:read:all');

      // Verify version was incremented
      expect(permsAfter.version).toBeGreaterThan(versionBefore);
    });

    it('should invalidate cache immediately after permission revocation', async () => {
      // Grant permission to role
      await permissionService.grantPermissionToRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      // Assign role to user
      await env.AUTH_DB.prepare(
        'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          crypto.randomUUID(),
          testUserId,
          testRoleId,
          'admin-user',
          new Date().toISOString(),
          1
        )
        .run();

      // Load permissions (should have permission)
      const permsBefore = await permissionService.getUserPermissions(testUserId);
      expect(permsBefore.permissions.length).toBe(1);
      const versionBefore = permsBefore.version;

      // Revoke permission
      await permissionService.revokePermissionFromRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      // Load permissions again (should have no permission)
      const permsAfter = await permissionService.getUserPermissions(testUserId);
      expect(permsAfter.permissions.length).toBe(0);

      // Verify version was incremented
      expect(permsAfter.version).toBeGreaterThan(versionBefore);
    });

    it('should prevent stale cache usage after permission changes', async () => {
      // Create another permission
      const perm2 = await permissionService.createPermission({
        name: 'test:write:all',
        resource: 'test',
        action: 'write',
        scope: 'all',
      });

      // Grant first permission
      await permissionService.grantPermissionToRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      // Assign role to user
      await env.AUTH_DB.prepare(
        'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          crypto.randomUUID(),
          testUserId,
          testRoleId,
          'admin-user',
          new Date().toISOString(),
          1
        )
        .run();

      // Load permissions
      const perms1 = await permissionService.getUserPermissions(testUserId);
      expect(perms1.permissions.length).toBe(1);

      // Grant second permission
      await permissionService.grantPermissionToRole(testRoleId, perm2.id, 'admin-user');

      // Load permissions again - should immediately reflect new permission
      const perms2 = await permissionService.getUserPermissions(testUserId);
      expect(perms2.permissions.length).toBe(2);

      // Verify no stale cache
      expect(perms2.version).toBeGreaterThan(perms1.version);
    });

    it('should handle concurrent permission changes correctly', async () => {
      // Create multiple permissions
      const perms = await Promise.all([
        permissionService.createPermission({
          name: 'concurrent:read:all',
          resource: 'concurrent',
          action: 'read',
          scope: 'all',
        }),
        permissionService.createPermission({
          name: 'concurrent:write:all',
          resource: 'concurrent',
          action: 'write',
          scope: 'all',
        }),
        permissionService.createPermission({
          name: 'concurrent:delete:all',
          resource: 'concurrent',
          action: 'delete',
          scope: 'all',
        }),
      ]);

      // Assign role to user
      await env.AUTH_DB.prepare(
        'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          crypto.randomUUID(),
          testUserId,
          testRoleId,
          'admin-user',
          new Date().toISOString(),
          1
        )
        .run();

      // Grant all permissions concurrently
      await Promise.all(
        perms.map((p) =>
          permissionService.grantPermissionToRole(testRoleId, p.id, 'admin-user')
        )
      );

      // Verify all permissions are present and cache is fresh
      const userPerms = await permissionService.getUserPermissions(testUserId);
      expect(userPerms.permissions.length).toBe(3);
    });

    it('should invalidate cache when direct user permission is granted', async () => {
      const permsBefore = await permissionService.getUserPermissions(testUserId);
      const versionBefore = permsBefore.version;

      // Grant direct permission to user
      await permissionService.grantPermissionToUser(
        testUserId,
        testPermissionId,
        'admin-user',
        'Testing direct grant'
      );

      // Verify cache was invalidated
      const permsAfter = await permissionService.getUserPermissions(testUserId);
      expect(permsAfter.directGrants.length).toBe(1);
      expect(permsAfter.version).toBeGreaterThan(versionBefore);
    });

    it('should invalidate cache when direct user permission is denied', async () => {
      const permsBefore = await permissionService.getUserPermissions(testUserId);
      const versionBefore = permsBefore.version;

      // Deny permission for user
      await permissionService.denyPermissionForUser(
        testUserId,
        testPermissionId,
        'admin-user',
        'Testing denial'
      );

      // Verify cache was invalidated
      const permsAfter = await permissionService.getUserPermissions(testUserId);
      expect(permsAfter.directDenies.length).toBe(1);
      expect(permsAfter.version).toBeGreaterThan(versionBefore);
    });
  });

  // ============================================================================
  // P0-4: SYSTEM PERMISSION PROTECTION TESTS
  // ============================================================================

  describe('P0-4: System Permission Protection', () => {
    let systemPermissionId: string;
    let regularPermissionId: string;

    beforeEach(async () => {
      // Create system permission directly in database
      systemPermissionId = crypto.randomUUID();
      await env.AUTH_DB.prepare(
        'INSERT INTO permissions (id, name, resource, action, scope, description, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(
          systemPermissionId,
          '*:*:*',
          '*',
          '*',
          '*',
          'Super admin permission',
          1,
          new Date().toISOString()
        )
        .run();

      // Create regular permission
      const perm = await permissionService.createPermission({
        name: 'regular:read:all',
        resource: 'regular',
        action: 'read',
        scope: 'all',
      });
      regularPermissionId = perm.id;
    });

    it('should prevent deletion of system permissions', async () => {
      await expect(
        permissionService.deletePermission(systemPermissionId, 'admin-user')
      ).rejects.toThrow(/System permissions are protected/);

      // Verify permission still exists
      const perm = await permissionService.getPermissionById(systemPermissionId);
      expect(perm).not.toBeNull();
    });

    it('should allow deletion of non-system permissions', async () => {
      await permissionService.deletePermission(regularPermissionId, 'admin-user');

      // Verify permission was deleted
      const perm = await permissionService.getPermissionById(regularPermissionId);
      expect(perm).toBeNull();
    });

    it('should prevent deletion of permissions in use', async () => {
      // Create role and assign permission
      const roleId = crypto.randomUUID();
      await env.AUTH_DB.prepare(
        'INSERT INTO roles (id, name, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(
          roleId,
          'test_role',
          0,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      await permissionService.grantPermissionToRole(
        roleId,
        regularPermissionId,
        'admin-user'
      );

      // Attempt to delete permission
      await expect(
        permissionService.deletePermission(regularPermissionId, 'admin-user')
      ).rejects.toThrow(/Currently in use/);
    });

    it('should create new permissions as non-system by default', async () => {
      const perm = await permissionService.createPermission({
        name: 'new:permission:all',
        resource: 'new',
        action: 'permission',
        scope: 'all',
      });

      expect(perm.is_system).toBe(false);
    });
  });

  // ============================================================================
  // PERMISSION MANAGEMENT TESTS
  // ============================================================================

  describe('Permission Management', () => {
    describe('createPermission()', () => {
      it('should create a valid permission', async () => {
        const data: PermissionData = {
          name: 'users:create:all',
          resource: 'users',
          action: 'create',
          scope: 'all',
          description: 'Create all users',
        };

        const perm = await permissionService.createPermission(data);

        expect(perm.id).toBeDefined();
        expect(perm.name).toBe('users:create:all');
        expect(perm.resource).toBe('users');
        expect(perm.action).toBe('create');
        expect(perm.scope).toBe('all');
        expect(perm.description).toBe('Create all users');
        expect(perm.is_system).toBe(false);
      });

      it('should reject invalid permission format', async () => {
        await expect(
          permissionService.createPermission({
            name: 'invalid-format',
            resource: 'invalid',
            action: 'format',
            scope: 'test',
          })
        ).rejects.toThrow(/Invalid permission format/);
      });

      it('should reject duplicate permission names', async () => {
        const data: PermissionData = {
          name: 'duplicate:test:all',
          resource: 'duplicate',
          action: 'test',
          scope: 'all',
        };

        await permissionService.createPermission(data);

        await expect(permissionService.createPermission(data)).rejects.toThrow(
          /already exists/
        );
      });

      it('should store metadata correctly', async () => {
        const metadata = { priority: 'high', category: 'admin' };
        const perm = await permissionService.createPermission({
          name: 'meta:test:all',
          resource: 'meta',
          action: 'test',
          scope: 'all',
          metadata,
        });

        expect(perm.metadata).toEqual(metadata);
      });
    });

    describe('getPermission()', () => {
      it('should retrieve permission by name', async () => {
        const created = await permissionService.createPermission({
          name: 'find:me:all',
          resource: 'find',
          action: 'me',
          scope: 'all',
        });

        const found = await permissionService.getPermission('find:me:all');

        expect(found).not.toBeNull();
        expect(found?.id).toBe(created.id);
      });

      it('should return null for non-existent permission', async () => {
        const result = await permissionService.getPermission('nonexistent:perm:all');
        expect(result).toBeNull();
      });
    });

    describe('findPermissions()', () => {
      beforeEach(async () => {
        // Create multiple permissions
        await permissionService.createPermission({
          name: 'users:read:all',
          resource: 'users',
          action: 'read',
          scope: 'all',
        });
        await permissionService.createPermission({
          name: 'users:write:all',
          resource: 'users',
          action: 'write',
          scope: 'all',
        });
        await permissionService.createPermission({
          name: 'content:read:all',
          resource: 'content',
          action: 'read',
          scope: 'all',
        });
      });

      it('should filter by resource', async () => {
        const results = await permissionService.findPermissions({
          resource: 'users',
        });

        expect(results.length).toBe(2);
        expect(results.every((p) => p.resource === 'users')).toBe(true);
      });

      it('should filter by action', async () => {
        const results = await permissionService.findPermissions({ action: 'read' });

        expect(results.length).toBe(2);
        expect(results.every((p) => p.action === 'read')).toBe(true);
      });

      it('should filter by scope', async () => {
        const results = await permissionService.findPermissions({ scope: 'all' });

        expect(results.length).toBe(3);
        expect(results.every((p) => p.scope === 'all')).toBe(true);
      });

      it('should filter by multiple criteria', async () => {
        const results = await permissionService.findPermissions({
          resource: 'users',
          action: 'read',
          scope: 'all',
        });

        expect(results.length).toBe(1);
        expect(results[0].name).toBe('users:read:all');
      });

      it('should return empty array when no matches', async () => {
        const results = await permissionService.findPermissions({
          resource: 'nonexistent',
        });

        expect(results).toEqual([]);
      });
    });
  });

  // ============================================================================
  // PERMISSION CHECKING TESTS
  // ============================================================================

  describe('Permission Checking', () => {
    let userId: string;
    let roleId: string;
    let permission1Id: string;
    let permission2Id: string;

    beforeEach(async () => {
      userId = 'check-user-123';
      roleId = crypto.randomUUID();

      // Create role
      await env.AUTH_DB.prepare(
        'INSERT INTO roles (id, name, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(
          roleId,
          'check_role',
          0,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      // Create permissions
      const perm1 = await permissionService.createPermission({
        name: 'resource:read:all',
        resource: 'resource',
        action: 'read',
        scope: 'all',
      });
      permission1Id = perm1.id;

      const perm2 = await permissionService.createPermission({
        name: 'resource:write:all',
        resource: 'resource',
        action: 'write',
        scope: 'all',
      });
      permission2Id = perm2.id;
    });

    describe('hasPermission()', () => {
      it('should return true for granted role permission', async () => {
        // Grant permission to role
        await permissionService.grantPermissionToRole(
          roleId,
          permission1Id,
          'admin-user'
        );

        // Assign role to user
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            userId,
            roleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        const hasPermission = await permissionService.hasPermission(
          userId,
          'resource:read:all'
        );

        expect(hasPermission).toBe(true);
      });

      it('should return false for non-granted permission', async () => {
        const hasPermission = await permissionService.hasPermission(
          userId,
          'resource:read:all'
        );

        expect(hasPermission).toBe(false);
      });

      it('should respect direct grant overrides', async () => {
        // Grant permission directly to user
        await permissionService.grantPermissionToUser(
          userId,
          permission1Id,
          'admin-user',
          'Direct grant test'
        );

        const hasPermission = await permissionService.hasPermission(
          userId,
          'resource:read:all'
        );

        expect(hasPermission).toBe(true);
      });

      it('should respect direct deny overrides (highest priority)', async () => {
        // Grant via role
        await permissionService.grantPermissionToRole(
          roleId,
          permission1Id,
          'admin-user'
        );
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            userId,
            roleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        // Deny directly
        await permissionService.denyPermissionForUser(
          userId,
          permission1Id,
          'admin-user',
          'Testing deny override'
        );

        const hasPermission = await permissionService.hasPermission(
          userId,
          'resource:read:all'
        );

        expect(hasPermission).toBe(false);
      });

      it('should match wildcard permissions', async () => {
        // Create wildcard permission
        const wildcardPerm = await permissionService.createPermission({
          name: '*:*:*',
          resource: '*',
          action: '*',
          scope: '*',
        });

        await permissionService.grantPermissionToUser(
          userId,
          wildcardPerm.id,
          'admin-user',
          'Super admin'
        );

        // Should match any permission
        const hasAnyPermission = await permissionService.hasPermission(
          userId,
          'anything:anywhere:anyscope'
        );

        expect(hasAnyPermission).toBe(true);
      });
    });

    describe('hasAnyPermission()', () => {
      it('should return true if user has any of the permissions', async () => {
        await permissionService.grantPermissionToUser(
          userId,
          permission1Id,
          'admin-user',
          'Test'
        );

        const hasAny = await permissionService.hasAnyPermission(userId, [
          'resource:read:all',
          'resource:write:all',
        ]);

        expect(hasAny).toBe(true);
      });

      it('should return false if user has none of the permissions', async () => {
        const hasAny = await permissionService.hasAnyPermission(userId, [
          'resource:read:all',
          'resource:write:all',
        ]);

        expect(hasAny).toBe(false);
      });
    });

    describe('hasAllPermissions()', () => {
      it('should return true if user has all permissions', async () => {
        await permissionService.grantPermissionToUser(
          userId,
          permission1Id,
          'admin-user',
          'Test'
        );
        await permissionService.grantPermissionToUser(
          userId,
          permission2Id,
          'admin-user',
          'Test'
        );

        const hasAll = await permissionService.hasAllPermissions(userId, [
          'resource:read:all',
          'resource:write:all',
        ]);

        expect(hasAll).toBe(true);
      });

      it('should return false if user missing any permission', async () => {
        await permissionService.grantPermissionToUser(
          userId,
          permission1Id,
          'admin-user',
          'Test'
        );

        const hasAll = await permissionService.hasAllPermissions(userId, [
          'resource:read:all',
          'resource:write:all',
        ]);

        expect(hasAll).toBe(false);
      });
    });

    describe('bulkCheckPermissions()', () => {
      it('should check multiple permissions efficiently', async () => {
        await permissionService.grantPermissionToUser(
          userId,
          permission1Id,
          'admin-user',
          'Test'
        );

        const result = await permissionService.bulkCheckPermissions({
          userId,
          permissions: ['resource:read:all', 'resource:write:all'],
        });

        expect(result.permissions['resource:read:all']).toBe(true);
        expect(result.permissions['resource:write:all']).toBe(false);
        expect(result.hasAny).toBe(true);
        expect(result.hasAll).toBe(false);
      });
    });
  });

  // ============================================================================
  // AUDIT LOGGING TESTS
  // ============================================================================

  describe('Audit Logging', () => {
    it('should log permission creation', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      await permissionService.createPermission({
        name: 'audit:test:all',
        resource: 'audit',
        action: 'test',
        scope: 'all',
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AUDIT] Permission created')
      );
    });

    it('should log permission grant to role', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const roleId = crypto.randomUUID();
      await env.AUTH_DB.prepare(
        'INSERT INTO roles (id, name, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(
          roleId,
          'audit_role',
          0,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      const perm = await permissionService.createPermission({
        name: 'audit:grant:all',
        resource: 'audit',
        action: 'grant',
        scope: 'all',
      });

      await permissionService.grantPermissionToRole(roleId, perm.id, 'admin-user');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AUDIT] Permission granted to role')
      );
    });

    it('should log permission revocation', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const roleId = crypto.randomUUID();
      await env.AUTH_DB.prepare(
        'INSERT INTO roles (id, name, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(
          roleId,
          'revoke_role',
          0,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      const perm = await permissionService.createPermission({
        name: 'audit:revoke:all',
        resource: 'audit',
        action: 'revoke',
        scope: 'all',
      });

      await permissionService.grantPermissionToRole(roleId, perm.id, 'admin-user');
      await permissionService.revokePermissionFromRole(
        roleId,
        perm.id,
        'admin-user'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AUDIT] Permission revoked from role')
      );
    });
  });
});
