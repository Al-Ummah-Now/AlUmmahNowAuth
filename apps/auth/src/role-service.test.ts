/**
 * Role Service Test Suite
 *
 * Comprehensive tests for RoleService covering ALL P0 security measures:
 * - P0-1: SQL Injection Prevention
 * - P0-2: Cache Invalidation Race Conditions
 * - P0-3: Privilege Escalation Prevention
 * - P0-4: System Role Protection
 *
 * @module role-service.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import './test-setup'; // Setup database schema
import { RoleService } from './role-service';
import { PermissionService } from './permission-service';
import { RoleData } from './rbac-types';

describe('RoleService', () => {
  let roleService: RoleService;
  let permissionService: PermissionService;

  beforeEach(async () => {
    // Initialize services with test environment
    roleService = new RoleService(env.AUTH_DB, env.AUTH_STORAGE);
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
    describe('getRoleByName()', () => {
      it('should prevent SQL injection in role name lookup', async () => {
        // Create a legitimate role
        await roleService.createRole(
          {
            name: 'legitimate_role',
            description: 'A legitimate role',
          },
          'admin-user'
        );

        // Attempt SQL injection
        const maliciousInput = "legitimate_role' OR '1'='1";
        const result = await roleService.getRoleByName(maliciousInput);

        expect(result).toBeNull();
      });

      it('should handle SQL injection with DROP TABLE attempt', async () => {
        const maliciousInput = "admin'; DROP TABLE roles; --";
        const result = await roleService.getRoleByName(maliciousInput);

        expect(result).toBeNull();

        // Verify table still exists by creating a role
        const role = await roleService.createRole(
          { name: 'test_role', description: 'Test' },
          'admin-user'
        );

        expect(role).toBeDefined();
        expect(role.name).toBe('test_role');
      });

      it('should handle special characters safely', async () => {
        const specialInputs = [
          "test'; --",
          "test' OR 1=1 --",
          "test' UNION SELECT * FROM users --",
          "'; DELETE FROM roles WHERE 'a'='a",
        ];

        for (const input of specialInputs) {
          const result = await roleService.getRoleByName(input);
          expect(result).toBeNull();
        }
      });
    });

    describe('assignRoleToUser()', () => {
      it('should safely handle user IDs with special characters', async () => {
        const role = await roleService.createRole(
          { name: 'safe_role', description: 'Test' },
          'admin-user'
        );

        // Create super admin permission for granter
        const superAdminPerm = await permissionService.createPermission({
          name: '*:*:*',
          resource: '*',
          action: '*',
          scope: '*',
        });

        const granterId = 'super-admin-user';
        await permissionService.grantPermissionToUser(
          granterId,
          superAdminPerm.id,
          'system',
          'Super admin'
        );

        // User ID with special characters that would cause SQL injection if not parameterized
        const maliciousUserId = "user'; DROP TABLE user_roles; --";

        // The parameterized query prevents SQL injection
        // Since user doesn't exist in database, D1 FOREIGN KEY constraint will fail
        // This proves the query was safely parameterized (SQL injection prevented)
        // If SQL injection occurred, the DROP TABLE would execute instead of FK check
        await expect(
          roleService.assignRoleToUser(maliciousUserId, role.id, granterId)
        ).rejects.toThrow(/D1_ERROR.*FOREIGN KEY/);

        // Verify tables still exist (DROP TABLE was prevented)
        const roles = await roleService.getAllRoles();
        expect(roles.length).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // P0-3: PRIVILEGE ESCALATION PREVENTION TESTS
  // ============================================================================

  describe('P0-3: Privilege Escalation Prevention', () => {
    let adminRoleId: string;
    let userRoleId: string;
    let adminPermId: string;
    let userPermId: string;
    let superAdminPermId: string;

    beforeEach(async () => {
      // Create permissions
      const adminPerm = await permissionService.createPermission({
        name: 'users:manage:all',
        resource: 'users',
        action: 'manage',
        scope: 'all',
      });
      adminPermId = adminPerm.id;

      const userPerm = await permissionService.createPermission({
        name: 'users:read:own',
        resource: 'users',
        action: 'read',
        scope: 'own',
      });
      userPermId = userPerm.id;

      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      superAdminPermId = superAdminPerm.id;

      // Create admin role
      const adminRole = await roleService.createRole(
        { name: 'admin_role', description: 'Admin role' },
        'super-admin'
      );
      adminRoleId = adminRole.id;
      await permissionService.grantPermissionToRole(
        adminRoleId,
        adminPermId,
        'super-admin'
      );

      // Create user role
      const userRole = await roleService.createRole(
        { name: 'user_role', description: 'User role' },
        'admin-user'
      );
      userRoleId = userRole.id;
      await permissionService.grantPermissionToRole(
        userRoleId,
        userPermId,
        'admin-user'
      );
    });

    describe('canGrantPermissions()', () => {
      it('should allow granting permissions user has', async () => {
        const adminUserId = 'admin-user-123';

        // Grant admin role to user
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            adminUserId,
            adminRoleId,
            'super-admin',
            new Date().toISOString(),
            1
          )
          .run();

        const check = await roleService.canGrantPermissions(adminUserId, [
          adminPermId,
        ]);

        expect(check.allowed).toBe(true);
        expect(check.missingPermissions).toEqual([]);
      });

      it('should prevent granting permissions user does not have', async () => {
        const regularUserId = 'regular-user-123';

        // Grant only user role
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            regularUserId,
            userRoleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        const check = await roleService.canGrantPermissions(regularUserId, [
          adminPermId,
        ]);

        expect(check.allowed).toBe(false);
        expect(check.missingPermissions).toContain('users:manage:all');
      });

      it('should enforce super admin permission can only be granted by super admin', async () => {
        const adminUserId = 'admin-user-123';

        // Admin user has admin permissions but NOT super admin
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            adminUserId,
            adminRoleId,
            'super-admin',
            new Date().toISOString(),
            1
          )
          .run();

        const check = await roleService.canGrantPermissions(adminUserId, [
          superAdminPermId,
        ]);

        expect(check.allowed).toBe(false);
        expect(check.missingPermissions).toContain('*:*:*');
      });

      it('should allow super admin to grant super admin permission', async () => {
        const superAdminUserId = 'super-admin-user';

        // Grant super admin permission directly
        await permissionService.grantPermissionToUser(
          superAdminUserId,
          superAdminPermId,
          'system',
          'Bootstrap super admin'
        );

        const check = await roleService.canGrantPermissions(superAdminUserId, [
          superAdminPermId,
        ]);

        expect(check.allowed).toBe(true);
        expect(check.missingPermissions).toEqual([]);
      });

      it('should log privilege escalation attempts', async () => {
        const consoleSpy = vi.spyOn(console, 'warn');
        const regularUserId = 'regular-user-456';

        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            regularUserId,
            userRoleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        await roleService.canGrantPermissions(regularUserId, [adminPermId]);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[RBAC] Privilege escalation attempt')
        );
      });
    });

    describe('assignRoleToUser()', () => {
      it('should prevent non-admin from assigning admin role', async () => {
        const regularUserId = 'regular-granter';
        const targetUserId = 'target-user';

        // Regular user only has user permissions
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            regularUserId,
            userRoleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        await expect(
          roleService.assignRoleToUser(targetUserId, adminRoleId, regularUserId)
        ).rejects.toThrow(/Privilege escalation prevented/);
      });

      it('should prevent admin from assigning role with permissions they do not have', async () => {
        const adminUserId = 'admin-granter';
        const targetUserId = 'target-user';

        // Admin has admin permissions (users:manage:all)
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            adminUserId,
            adminRoleId,
            'super-admin',
            new Date().toISOString(),
            1
          )
          .run();

        // Admin cannot assign user role with different permissions (users:read:own)
        // RBAC requires exact permission matches - you can only grant what you have
        // users:manage:all does NOT imply users:read:own (different action and scope)
        await expect(
          roleService.assignRoleToUser(targetUserId, userRoleId, adminUserId)
        ).rejects.toThrow(/Privilege escalation prevented/);
      });

      it('should prevent non-super-admin from assigning role with super admin permission', async () => {
        // Create super admin role
        const superAdminRole = await roleService.createRole(
          { name: 'super_admin_role', description: 'Super admin' },
          'system'
        );
        await permissionService.grantPermissionToRole(
          superAdminRole.id,
          superAdminPermId,
          'system'
        );

        const adminUserId = 'admin-user';
        const targetUserId = 'target-user';

        // Admin user (not super admin)
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            adminUserId,
            adminRoleId,
            'super-admin',
            new Date().toISOString(),
            1
          )
          .run();

        await expect(
          roleService.assignRoleToUser(targetUserId, superAdminRole.id, adminUserId)
        ).rejects.toThrow(/Privilege escalation prevented/);
      });
    });

    describe('grantPermissionToUser()', () => {
      it('should prevent granting permission user does not have', async () => {
        const regularUserId = 'regular-user';
        const targetUserId = 'target-user';

        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            regularUserId,
            userRoleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        await expect(
          roleService.grantPermissionToUser(
            targetUserId,
            adminPermId,
            regularUserId,
            'Attempting escalation'
          )
        ).rejects.toThrow(/Privilege escalation prevented/);
      });

      it('should allow granting permission user has', async () => {
        const adminUserId = 'admin-user';
        const targetUserId = 'target-user';

        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            adminUserId,
            adminRoleId,
            'super-admin',
            new Date().toISOString(),
            1
          )
          .run();

        await expect(
          roleService.grantPermissionToUser(
            targetUserId,
            adminPermId,
            adminUserId,
            'Valid grant'
          )
        ).resolves.not.toThrow();
      });
    });

    describe('modifyRolePermissions()', () => {
      it('should prevent modifying role with permission granter does not have', async () => {
        const regularUserId = 'regular-user';

        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            regularUserId,
            userRoleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        await expect(
          roleService.modifyRolePermissions(
            userRoleId,
            'grant',
            adminPermId,
            regularUserId
          )
        ).rejects.toThrow(/Privilege escalation prevented/);
      });
    });
  });

  // ============================================================================
  // P0-4: SYSTEM ROLE PROTECTION TESTS
  // ============================================================================

  describe('P0-4: System Role Protection', () => {
    let systemRoleId: string;
    let regularRoleId: string;

    beforeEach(async () => {
      // Create system role directly in database
      systemRoleId = crypto.randomUUID();
      await env.AUTH_DB.prepare(
        'INSERT INTO roles (id, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(
          systemRoleId,
          'super_admin',
          'System super admin role',
          1,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      // Create regular role
      const regularRole = await roleService.createRole(
        { name: 'custom_role', description: 'Custom role' },
        'admin-user'
      );
      regularRoleId = regularRole.id;
    });

    describe('updateRole()', () => {
      it('should prevent modification of system roles', async () => {
        await expect(
          roleService.updateRole(
            systemRoleId,
            { name: 'hacked_admin', description: 'Hacked' },
            'admin-user'
          )
        ).rejects.toThrow(/System roles are protected/);
      });

      it('should allow modification of non-system roles', async () => {
        const updated = await roleService.updateRole(
          regularRoleId,
          { description: 'Updated description' },
          'admin-user'
        );

        expect(updated.description).toBe('Updated description');
      });

      it('should prevent setting is_system flag', async () => {
        await expect(
          roleService.updateRole(
            regularRoleId,
            { is_system: true } as any,
            'admin-user'
          )
        ).rejects.toThrow(/Cannot modify is_system flag/);
      });

      it('should prevent renaming to system role name', async () => {
        await expect(
          roleService.updateRole(
            regularRoleId,
            { name: 'admin' },
            'admin-user'
          )
        ).rejects.toThrow(/Cannot rename role to system role name/);
      });
    });

    describe('deleteRole()', () => {
      it('should prevent deletion of system roles', async () => {
        await expect(
          roleService.deleteRole(systemRoleId, 'admin-user')
        ).rejects.toThrow(/System roles are protected/);

        // Verify role still exists
        const role = await roleService.getRole(systemRoleId);
        expect(role).not.toBeNull();
      });

      it('should allow deletion of non-system roles', async () => {
        await roleService.deleteRole(regularRoleId, 'admin-user');

        // Verify role was deleted
        const role = await roleService.getRole(regularRoleId);
        expect(role).toBeNull();
      });

      it('should prevent deletion of roles in use', async () => {
        const userId = 'test-user-123';

        // Assign role to user
        await env.AUTH_DB.prepare(
          'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(
            crypto.randomUUID(),
            userId,
            regularRoleId,
            'admin-user',
            new Date().toISOString(),
            1
          )
          .run();

        await expect(
          roleService.deleteRole(regularRoleId, 'admin-user')
        ).rejects.toThrow(/Currently assigned to/);
      });

      it('should prevent deletion of roles with child roles', async () => {
        // Create child role
        await roleService.createRole(
          {
            name: 'child_role',
            description: 'Child role',
            parent_role_id: regularRoleId,
          },
          'admin-user'
        );

        await expect(
          roleService.deleteRole(regularRoleId, 'admin-user')
        ).rejects.toThrow(/Has .* child role/);
      });
    });

    describe('modifyRolePermissions()', () => {
      it('should prevent modifying permissions of system roles', async () => {
        const perm = await permissionService.createPermission({
          name: 'test:perm:all',
          resource: 'test',
          action: 'perm',
          scope: 'all',
        });

        // Create user with super admin permission
        const superAdminUserId = 'super-admin-user';
        const superAdminPerm = await permissionService.createPermission({
          name: '*:*:*',
          resource: '*',
          action: '*',
          scope: '*',
        });
        await permissionService.grantPermissionToUser(
          superAdminUserId,
          superAdminPerm.id,
          'system',
          'Bootstrap'
        );

        await expect(
          roleService.modifyRolePermissions(
            systemRoleId,
            'grant',
            perm.id,
            superAdminUserId
          )
        ).rejects.toThrow(/System roles are protected/);
      });
    });

    describe('createRole()', () => {
      it('should prevent creating role with system role name', async () => {
        await expect(
          roleService.createRole(
            { name: 'super_admin', description: 'Fake super admin' },
            'admin-user'
          )
        ).rejects.toThrow(/Cannot create role with system role name/);
      });

      it('should create new roles as non-system by default', async () => {
        const role = await roleService.createRole(
          { name: 'new_custom_role', description: 'Custom' },
          'admin-user'
        );

        expect(role.is_system).toBe(false);
      });
    });
  });

  // ============================================================================
  // P0-2: CACHE INVALIDATION TESTS
  // ============================================================================

  describe('P0-2: Cache Invalidation Race Conditions', () => {
    let testRoleId: string;
    let testPermissionId: string;
    let testUserId: string;

    beforeEach(async () => {
      testUserId = 'cache-test-user';

      const role = await roleService.createRole(
        { name: 'cache_test_role', description: 'Cache test' },
        'admin-user'
      );
      testRoleId = role.id;

      const perm = await permissionService.createPermission({
        name: 'cache:test:all',
        resource: 'cache',
        action: 'test',
        scope: 'all',
      });
      testPermissionId = perm.id;
    });

    it('should invalidate cache when role is assigned to user', async () => {
      // Load initial permissions (empty)
      const permsBefore = await permissionService.getUserPermissions(testUserId);
      expect(permsBefore.permissions.length).toBe(0);
      const versionBefore = permsBefore.version;

      // Grant permission to role
      await permissionService.grantPermissionToRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      // Create super admin for assignment
      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      const adminUserId = 'admin-for-assignment';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );

      // Assign role to user
      await roleService.assignRoleToUser(testUserId, testRoleId, adminUserId);

      // Load permissions (should have new permission)
      const permsAfter = await permissionService.getUserPermissions(testUserId);
      expect(permsAfter.permissions.length).toBe(1);
      expect(permsAfter.version).toBeGreaterThan(versionBefore);
    });

    it('should invalidate cache when role is removed from user', async () => {
      // Setup: Grant permission and assign role
      await permissionService.grantPermissionToRole(
        testRoleId,
        testPermissionId,
        'admin-user'
      );

      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      const adminUserId = 'admin-for-removal';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );

      await roleService.assignRoleToUser(testUserId, testRoleId, adminUserId);

      // Load permissions (should have permission)
      const permsBefore = await permissionService.getUserPermissions(testUserId);
      expect(permsBefore.permissions.length).toBe(1);
      const versionBefore = permsBefore.version;

      // Remove role
      await roleService.removeRoleFromUser(testUserId, testRoleId, adminUserId);

      // Load permissions (should have no permission)
      const permsAfter = await permissionService.getUserPermissions(testUserId);
      expect(permsAfter.permissions.length).toBe(0);
      expect(permsAfter.version).toBeGreaterThan(versionBefore);
    });
  });

  // ============================================================================
  // ROLE MANAGEMENT TESTS
  // ============================================================================

  describe('Role Management', () => {
    describe('createRole()', () => {
      it('should create a valid role', async () => {
        const data: RoleData = {
          name: 'new_role',
          description: 'A new role',
        };

        const role = await roleService.createRole(data, 'admin-user');

        expect(role.id).toBeDefined();
        expect(role.name).toBe('new_role');
        expect(role.description).toBe('A new role');
        expect(role.is_system).toBe(false);
        expect(role.created_by).toBe('admin-user');
      });

      it('should reject duplicate role names', async () => {
        await roleService.createRole({ name: 'duplicate_role' }, 'admin-user');

        await expect(
          roleService.createRole({ name: 'duplicate_role' }, 'admin-user')
        ).rejects.toThrow(/already exists/);
      });

      it('should support role hierarchy with parent roles', async () => {
        const parentRole = await roleService.createRole(
          { name: 'parent_role', description: 'Parent' },
          'admin-user'
        );

        const childRole = await roleService.createRole(
          {
            name: 'child_role',
            description: 'Child',
            parent_role_id: parentRole.id,
          },
          'admin-user'
        );

        expect(childRole.parent_role_id).toBe(parentRole.id);
      });

      it('should reject non-existent parent role', async () => {
        await expect(
          roleService.createRole(
            {
              name: 'orphan_role',
              parent_role_id: 'non-existent-parent-id',
            },
            'admin-user'
          )
        ).rejects.toThrow(/Parent role not found/);
      });

      it('should store metadata correctly', async () => {
        const metadata = { category: 'admin', priority: 10 };
        const role = await roleService.createRole(
          {
            name: 'meta_role',
            description: 'With metadata',
            metadata,
          },
          'admin-user'
        );

        expect(role.metadata).toEqual(metadata);
      });
    });

    describe('updateRole()', () => {
      it('should update role name', async () => {
        const role = await roleService.createRole(
          { name: 'old_name', description: 'Test' },
          'admin-user'
        );

        const updated = await roleService.updateRole(
          role.id,
          { name: 'new_name' },
          'admin-user'
        );

        expect(updated.name).toBe('new_name');
      });

      it('should update role description', async () => {
        const role = await roleService.createRole(
          { name: 'test_role', description: 'Old description' },
          'admin-user'
        );

        const updated = await roleService.updateRole(
          role.id,
          { description: 'New description' },
          'admin-user'
        );

        expect(updated.description).toBe('New description');
      });

      it('should prevent renaming to existing role name', async () => {
        await roleService.createRole(
          { name: 'role_one' },
          'admin-user'
        );
        const role2 = await roleService.createRole(
          { name: 'role_two' },
          'admin-user'
        );

        await expect(
          roleService.updateRole(role2.id, { name: 'role_one' }, 'admin-user')
        ).rejects.toThrow(/already exists/);
      });

      it('should prevent circular parent hierarchy', async () => {
        const role = await roleService.createRole(
          { name: 'self_parent' },
          'admin-user'
        );

        await expect(
          roleService.updateRole(
            role.id,
            { parent_role_id: role.id },
            'admin-user'
          )
        ).rejects.toThrow(/cannot be its own parent/);
      });
    });

    describe('getRoleByName()', () => {
      it('should retrieve role by name', async () => {
        const created = await roleService.createRole(
          { name: 'findable_role', description: 'Find me' },
          'admin-user'
        );

        const found = await roleService.getRoleByName('findable_role');

        expect(found).not.toBeNull();
        expect(found?.id).toBe(created.id);
      });

      it('should return null for non-existent role', async () => {
        const result = await roleService.getRoleByName('nonexistent_role');
        expect(result).toBeNull();
      });
    });

    describe('getAllRoles()', () => {
      it('should return all roles ordered by name', async () => {
        await roleService.createRole({ name: 'zebra_role' }, 'admin-user');
        await roleService.createRole({ name: 'alpha_role' }, 'admin-user');
        await roleService.createRole({ name: 'beta_role' }, 'admin-user');

        const roles = await roleService.getAllRoles();

        expect(roles.length).toBe(3);
        expect(roles[0].name).toBe('alpha_role');
        expect(roles[1].name).toBe('beta_role');
        expect(roles[2].name).toBe('zebra_role');
      });
    });
  });

  // ============================================================================
  // USER ROLE ASSIGNMENT TESTS
  // ============================================================================

  describe('User Role Assignment', () => {
    let roleId: string;
    let _permissionId: string;
    let adminUserId: string;

    beforeEach(async () => {
      // Create role and permission
      const role = await roleService.createRole(
        { name: 'assignment_role', description: 'For assignments' },
        'admin-user'
      );
      roleId = role.id;

      const perm = await permissionService.createPermission({
        name: 'assignment:test:all',
        resource: 'assignment',
        action: 'test',
        scope: 'all',
      });
      permissionId = perm.id;

      await permissionService.grantPermissionToRole(roleId, perm.id, 'admin-user');

      // Create super admin for assignments
      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      adminUserId = 'super-admin-for-tests';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );
    });

    describe('assignRoleToUser()', () => {
      it('should assign role to user', async () => {
        const userId = 'test-user-123';

        await roleService.assignRoleToUser(userId, roleId, adminUserId);

        const userRoles = await roleService.getUserRoles(userId);
        expect(userRoles.length).toBe(1);
        expect(userRoles[0].roleId).toBe(roleId);
        expect(userRoles[0].grantedBy).toBe(adminUserId);
      });

      it('should handle role assignment with expiration', async () => {
        const userId = 'expiring-user';
        const expiresAt = new Date(Date.now() + 86400000); // 1 day

        await roleService.assignRoleToUser(userId, roleId, adminUserId, expiresAt);

        const userRoles = await roleService.getUserRoles(userId);
        expect(userRoles.length).toBe(1);
        expect(userRoles[0].expiresAt).toBeDefined();
      });

      it('should not duplicate role assignments', async () => {
        const userId = 'no-duplicate-user';

        await roleService.assignRoleToUser(userId, roleId, adminUserId);
        await roleService.assignRoleToUser(userId, roleId, adminUserId);

        const userRoles = await roleService.getUserRoles(userId);
        expect(userRoles.length).toBe(1);
      });

      it('should reject non-existent role', async () => {
        const userId = 'test-user';

        await expect(
          roleService.assignRoleToUser(userId, 'non-existent-role-id', adminUserId)
        ).rejects.toThrow(/Role not found/);
      });
    });

    describe('removeRoleFromUser()', () => {
      it('should remove role from user', async () => {
        const userId = 'removal-user';

        await roleService.assignRoleToUser(userId, roleId, adminUserId);

        let userRoles = await roleService.getUserRoles(userId);
        expect(userRoles.length).toBe(1);

        await roleService.removeRoleFromUser(userId, roleId, adminUserId);

        userRoles = await roleService.getUserRoles(userId);
        expect(userRoles.length).toBe(0);
      });

      it('should handle removal of non-existent assignment gracefully', async () => {
        const userId = 'no-role-user';

        await expect(
          roleService.removeRoleFromUser(userId, roleId, adminUserId)
        ).resolves.not.toThrow();
      });
    });

    describe('getUserRoles()', () => {
      it('should return all active roles for user', async () => {
        const userId = 'multi-role-user';

        const role2 = await roleService.createRole(
          { name: 'second_role' },
          'admin-user'
        );

        await roleService.assignRoleToUser(userId, roleId, adminUserId);
        await roleService.assignRoleToUser(userId, role2.id, adminUserId);

        const userRoles = await roleService.getUserRoles(userId);
        expect(userRoles.length).toBe(2);
      });

      it('should return empty array for user with no roles', async () => {
        const userId = 'no-roles-user';

        const userRoles = await roleService.getUserRoles(userId);
        expect(userRoles).toEqual([]);
      });

      it('should include role metadata in results', async () => {
        const userId = 'metadata-user';

        await roleService.assignRoleToUser(userId, roleId, adminUserId);

        const userRoles = await roleService.getUserRoles(userId);
        expect(userRoles[0].role.name).toBe('assignment_role');
        expect(userRoles[0].role.is_system).toBe(false);
      });
    });

    describe('getUsersWithRole()', () => {
      it('should return all users with specific role', async () => {
        const user1 = 'user-one';
        const user2 = 'user-two';
        const user3 = 'user-three';

        await roleService.assignRoleToUser(user1, roleId, adminUserId);
        await roleService.assignRoleToUser(user2, roleId, adminUserId);
        await roleService.assignRoleToUser(user3, roleId, adminUserId);

        const users = await roleService.getUsersWithRole(roleId);
        expect(users.length).toBe(3);
        expect(users).toContain(user1);
        expect(users).toContain(user2);
        expect(users).toContain(user3);
      });
    });
  });

  // ============================================================================
  // ROLE PERMISSIONS TESTS
  // ============================================================================

  describe('Role Permissions', () => {
    let roleId: string;
    let adminUserId: string;

    beforeEach(async () => {
      const role = await roleService.createRole(
        { name: 'perm_test_role' },
        'admin-user'
      );
      roleId = role.id;

      // Create super admin
      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      adminUserId = 'super-admin-perm-tests';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );
    });

    describe('getRolePermissions()', () => {
      it('should return all permissions for role', async () => {
        const perm1 = await permissionService.createPermission({
          name: 'role:perm1:all',
          resource: 'role',
          action: 'perm1',
          scope: 'all',
        });
        const perm2 = await permissionService.createPermission({
          name: 'role:perm2:all',
          resource: 'role',
          action: 'perm2',
          scope: 'all',
        });

        await permissionService.grantPermissionToRole(roleId, perm1.id, adminUserId);
        await permissionService.grantPermissionToRole(roleId, perm2.id, adminUserId);

        const permissions = await roleService.getRolePermissions(roleId);
        expect(permissions.length).toBe(2);
      });

      it('should return empty array for role with no permissions', async () => {
        const permissions = await roleService.getRolePermissions(roleId);
        expect(permissions).toEqual([]);
      });
    });
  });

  // ============================================================================
  // BULK OPERATIONS TESTS
  // ============================================================================

  describe('Bulk Operations', () => {
    it('should bulk assign multiple roles to user', async () => {
      const role1 = await roleService.createRole({ name: 'bulk_role_1' }, 'admin');
      const role2 = await roleService.createRole({ name: 'bulk_role_2' }, 'admin');
      const role3 = await roleService.createRole({ name: 'bulk_role_3' }, 'admin');

      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      const adminUserId = 'bulk-admin';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );

      const userId = 'bulk-user';
      const result = await roleService.bulkAssignRolesToUser(
        userId,
        [role1.id, role2.id, role3.id],
        adminUserId
      );

      expect(result.success.length).toBe(3);
      expect(result.failed.length).toBe(0);
    });
  });

  // ============================================================================
  // AUDIT LOGGING TESTS
  // ============================================================================

  describe('Audit Logging', () => {
    it('should log role creation', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      await roleService.createRole({ name: 'audit_role' }, 'admin-user');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AUDIT] Role created')
      );
    });

    it('should log role assignment', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const role = await roleService.createRole({ name: 'log_role' }, 'admin');

      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      const adminUserId = 'audit-admin';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );

      await roleService.assignRoleToUser('user-123', role.id, adminUserId);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AUDIT] Role assigned to user')
      );
    });

    it('should log role removal', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const role = await roleService.createRole({ name: 'remove_role' }, 'admin');

      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      const adminUserId = 'remove-admin';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );

      await roleService.assignRoleToUser('user-456', role.id, adminUserId);
      await roleService.removeRoleFromUser('user-456', role.id, adminUserId);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AUDIT] Role removed from user')
      );
    });
  });

  // ============================================================================
  // EXPIRED ROLES CLEANUP TESTS
  // ============================================================================

  describe('Expired Roles Cleanup', () => {
    it('should deactivate expired role assignments', async () => {
      const role = await roleService.createRole({ name: 'expiry_role' }, 'admin');

      const superAdminPerm = await permissionService.createPermission({
        name: '*:*:*',
        resource: '*',
        action: '*',
        scope: '*',
      });
      const adminUserId = 'expiry-admin';
      await permissionService.grantPermissionToUser(
        adminUserId,
        superAdminPerm.id,
        'system',
        'Bootstrap'
      );

      const userId = 'expiry-user';

      // Assign role with past expiration
      const expiredDate = new Date(Date.now() - 86400000); // 1 day ago
      await env.AUTH_DB.prepare(
        'INSERT INTO user_roles (id, user_id, role_id, granted_by, granted_at, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(
          crypto.randomUUID(),
          userId,
          role.id,
          adminUserId,
          new Date().toISOString(),
          expiredDate.toISOString(),
          1
        )
        .run();

      const deactivated = await roleService.deactivateExpiredRoles();

      expect(deactivated).toBe(1);

      // Verify user no longer has active roles
      const userRoles = await roleService.getUserRoles(userId);
      expect(userRoles.length).toBe(0);
    });
  });
});
