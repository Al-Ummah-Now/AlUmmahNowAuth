# RBAC Security Implementation Guide

## ⚠️ CRITICAL SECURITY REQUIREMENTS

This document addresses the critical security vulnerabilities identified in the code review and provides mandatory implementation requirements for production deployment.

---

## P0-1: SQL Injection Prevention

### Vulnerability
Dynamic SQL queries without proper parameterization can lead to SQL injection attacks.

### Required Implementation

**ALWAYS use parameterized queries. NEVER use string interpolation for user input.**

```typescript
// ❌ WRONG - SQL INJECTION VULNERABILITY
async getRoleByName(name: string): Promise<Role | null> {
  // DO NOT DO THIS!
  const query = `SELECT * FROM roles WHERE name = '${name}'`;
  return await this.db.prepare(query).first();
}

// ✅ CORRECT - PARAMETERIZED QUERY
async getRoleByName(name: string): Promise<Role | null> {
  const query = `SELECT * FROM roles WHERE name = ?`;
  return await this.db.prepare(query).bind(name).first();
}
```

### Examples for All RBAC Operations

```typescript
export class PermissionService {
  // ✅ Safe permission lookup
  async getPermission(name: string): Promise<Permission | null> {
    return await this.db.prepare(
      `SELECT * FROM permissions WHERE name = ?`
    ).bind(name).first<Permission>();
  }

  // ✅ Safe permission creation
  async createPermission(data: PermissionData): Promise<Permission> {
    return await this.db.prepare(
      `INSERT INTO permissions (name, resource, action, scope, description)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      data.name,
      data.resource,
      data.action,
      data.scope,
      data.description
    ).run();
  }

  // ✅ Safe dynamic filtering
  async findPermissions(filters: {
    resource?: string;
    action?: string;
  }): Promise<Permission[]> {
    const conditions: string[] = [];
    const bindings: any[] = [];

    if (filters.resource) {
      conditions.push('resource = ?');
      bindings.push(filters.resource);
    }

    if (filters.action) {
      conditions.push('action = ?');
      bindings.push(filters.action);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    return await this.db.prepare(
      `SELECT * FROM permissions ${whereClause}`
    ).bind(...bindings).all<Permission>();
  }
}
```

### Code Review Checklist
- [ ] All database queries use `.bind()` for parameters
- [ ] No string interpolation (`${variable}`) in SQL queries
- [ ] User input never directly concatenated into SQL
- [ ] Dynamic queries build parameter arrays alongside SQL

---

## P0-2: Cache Invalidation Race Conditions

### Vulnerability
Revoked permissions may remain active for up to 5 minutes due to cache race conditions without versioning.

### Required Implementation

Implement versioned caching with atomic invalidation:

```typescript
export class PermissionService {
  private cache: KVNamespace;
  private cacheTTL = 300; // 5 minutes
  private cacheVersionKey = 'rbac:cache:version';

  /**
   * Get current cache version
   */
  private async getCacheVersion(): Promise<number> {
    const version = await this.cache.get(this.cacheVersionKey);
    return version ? parseInt(version) : 1;
  }

  /**
   * Increment cache version (invalidates all cached permissions)
   */
  private async incrementCacheVersion(): Promise<void> {
    const currentVersion = await this.getCacheVersion();
    await this.cache.put(
      this.cacheVersionKey,
      (currentVersion + 1).toString(),
      { expirationTtl: 86400 } // 24 hours
    );
    console.log(`[RBAC] Cache version incremented to ${currentVersion + 1}`);
  }

  /**
   * Get versioned cache key
   */
  private async getVersionedCacheKey(key: string): Promise<string> {
    const version = await this.getCacheVersion();
    return `${key}:v${version}`;
  }

  /**
   * Get user permissions with versioned caching
   */
  async getUserPermissions(
    userId: string
  ): Promise<EffectivePermissions> {
    const baseCacheKey = `rbac:user:${userId}:permissions`;
    const cacheKey = await this.getVersionedCacheKey(baseCacheKey);

    // Try cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as EffectivePermissions;
    }

    // Load from database
    const permissions = await this.loadUserPermissions(userId);

    // Cache with version
    await this.cache.put(
      cacheKey,
      JSON.stringify(permissions),
      { expirationTtl: this.cacheTTL }
    );

    return permissions;
  }

  /**
   * Invalidate all permission caches atomically
   * Call this after ANY permission/role change
   */
  async invalidateAllCaches(): Promise<void> {
    await this.incrementCacheVersion();
    console.log('[RBAC] All permission caches invalidated');
  }

  /**
   * Grant permission to role - with cache invalidation
   */
  async grantPermissionToRole(
    roleId: string,
    permissionId: string,
    grantedBy: string
  ): Promise<void> {
    // Make database change
    await this.db.prepare(
      `INSERT INTO role_permissions (role_id, permission_id, granted_by)
       VALUES (?, ?, ?)`
    ).bind(roleId, permissionId, grantedBy).run();

    // CRITICAL: Invalidate caches immediately
    await this.invalidateAllCaches();

    // Log audit event
    console.log(`[AUDIT] Permission ${permissionId} granted to role ${roleId} by ${grantedBy}`);
  }

  /**
   * Revoke permission from role - with cache invalidation
   */
  async revokePermissionFromRole(
    roleId: string,
    permissionId: string,
    revokedBy: string
  ): Promise<void> {
    // Make database change
    await this.db.prepare(
      `DELETE FROM role_permissions
       WHERE role_id = ? AND permission_id = ?`
    ).bind(roleId, permissionId).run();

    // CRITICAL: Invalidate caches immediately
    await this.invalidateAllCaches();

    // Log audit event
    console.log(`[AUDIT] Permission ${permissionId} revoked from role ${roleId} by ${revokedBy}`);
  }
}
```

### Implementation Requirements
- [ ] All permission/role modifications call `invalidateAllCaches()`
- [ ] Cache keys include version number
- [ ] Version is stored in KV with 24-hour TTL
- [ ] Cache invalidation is logged for audit trails

---

## P0-3: Privilege Escalation Prevention

### Vulnerability
Users with `users:manage:all` can grant themselves super_admin privileges without permission checks.

### Required Implementation

**Enforce "you can only grant what you have" rule:**

```typescript
export class RoleService {
  private permissionService: PermissionService;

  /**
   * Check if granter can grant specific permissions
   */
  private async canGrantPermissions(
    granterId: string,
    permissionIds: string[]
  ): Promise<{ allowed: boolean; missingPermissions: string[] }> {
    // Get granter's effective permissions
    const granterPerms = await this.permissionService.getUserPermissions(granterId);

    // Get the permissions being granted
    const permissions = await this.db.prepare(
      `SELECT id, name FROM permissions WHERE id IN (${permissionIds.map(() => '?').join(',')})`
    ).bind(...permissionIds).all<Permission>();

    const missingPermissions: string[] = [];

    for (const perm of permissions.results) {
      // Special case: super admin permission can only be granted by existing super admin
      if (perm.name === '*:*:*') {
        const hasSuperAdmin = await this.permissionService.hasPermission(
          granterId,
          '*:*:*'
        );
        if (!hasSuperAdmin) {
          missingPermissions.push(perm.name);
        }
        continue;
      }

      // Check if granter has this specific permission
      const hasPermission = await this.permissionService.hasPermission(
        granterId,
        perm.name
      );

      if (!hasPermission) {
        missingPermissions.push(perm.name);
      }
    }

    return {
      allowed: missingPermissions.length === 0,
      missingPermissions
    };
  }

  /**
   * Assign role to user - with privilege escalation check
   */
  async assignRoleToUser(
    userId: string,
    roleId: string,
    grantedBy: string
  ): Promise<void> {
    // Get all permissions in the role
    const rolePermissions = await this.db.prepare(
      `SELECT permission_id FROM role_permissions WHERE role_id = ?`
    ).bind(roleId).all<{ permission_id: string }>();

    const permissionIds = rolePermissions.results.map(rp => rp.permission_id);

    // CRITICAL: Check if granter can grant these permissions
    const check = await this.canGrantPermissions(grantedBy, permissionIds);

    if (!check.allowed) {
      throw new Error(
        `Privilege escalation prevented: You cannot grant permissions you don't have: ${check.missingPermissions.join(', ')}`
      );
    }

    // Proceed with role assignment
    await this.db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by)
       VALUES (?, ?, ?)`
    ).bind(userId, roleId, grantedBy).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    // Log audit event
    console.log(`[AUDIT] Role ${roleId} assigned to user ${userId} by ${grantedBy}`);
  }

  /**
   * Grant permission directly to user - with privilege escalation check
   */
  async grantPermissionToUser(
    userId: string,
    permissionId: string,
    grantedBy: string,
    reason: string
  ): Promise<void> {
    // CRITICAL: Check if granter can grant this permission
    const check = await this.canGrantPermissions(grantedBy, [permissionId]);

    if (!check.allowed) {
      throw new Error(
        `Privilege escalation prevented: You cannot grant permission '${check.missingPermissions[0]}' that you don't have`
      );
    }

    // Proceed with permission grant
    await this.db.prepare(
      `INSERT INTO user_permissions (user_id, permission_id, is_grant, granted_by, reason)
       VALUES (?, ?, TRUE, ?, ?)`
    ).bind(userId, permissionId, grantedBy, reason).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    // Log audit event
    console.log(`[AUDIT] Permission ${permissionId} granted to user ${userId} by ${grantedBy}. Reason: ${reason}`);
  }
}
```

### Implementation Requirements
- [ ] All role assignments check granter permissions
- [ ] All direct permission grants check granter permissions
- [ ] Super admin permission requires existing super admin
- [ ] Failed attempts are logged with audit trail
- [ ] Errors return specific missing permissions

---

## P0-4: System Role Protection

### Vulnerability
`is_system` flag exists but no application-level checks prevent modification/deletion of system roles.

### Required Implementation

```typescript
export class RoleService {
  /**
   * Check if role is a system role
   */
  private async isSystemRole(roleId: string): Promise<boolean> {
    const role = await this.db.prepare(
      `SELECT is_system FROM roles WHERE id = ?`
    ).bind(roleId).first<{ is_system: boolean }>();

    return role?.is_system === true;
  }

  /**
   * Update role - with system role protection
   */
  async updateRole(
    roleId: string,
    updates: Partial<RoleData>,
    updatedBy: string
  ): Promise<void> {
    // CRITICAL: Prevent modification of system roles
    if (await this.isSystemRole(roleId)) {
      throw new Error(
        `Security violation: Cannot modify system role ${roleId}. System roles are protected.`
      );
    }

    // Prevent setting is_system flag
    if ('is_system' in updates) {
      throw new Error(
        `Security violation: Cannot modify is_system flag. This is a protected field.`
      );
    }

    // Proceed with update
    const fields: string[] = [];
    const bindings: any[] = [];

    if (updates.name) {
      fields.push('name = ?');
      bindings.push(updates.name);
    }

    if (updates.description !== undefined) {
      fields.push('description = ?');
      bindings.push(updates.description);
    }

    if (updates.parent_role_id !== undefined) {
      fields.push('parent_role_id = ?');
      bindings.push(updates.parent_role_id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    fields.push('updated_by = ?');
    bindings.push(updatedBy);
    bindings.push(roleId);

    await this.db.prepare(
      `UPDATE roles SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...bindings).run();

    console.log(`[AUDIT] Role ${roleId} updated by ${updatedBy}`);
  }

  /**
   * Delete role - with system role protection
   */
  async deleteRole(roleId: string, deletedBy: string): Promise<void> {
    // CRITICAL: Prevent deletion of system roles
    if (await this.isSystemRole(roleId)) {
      throw new Error(
        `Security violation: Cannot delete system role ${roleId}. System roles are protected.`
      );
    }

    // Check if role is in use
    const usageCount = await this.db.prepare(
      `SELECT COUNT(*) as count FROM user_roles WHERE role_id = ?`
    ).bind(roleId).first<{ count: number }>();

    if (usageCount && usageCount.count > 0) {
      throw new Error(
        `Cannot delete role ${roleId}: Currently assigned to ${usageCount.count} user(s)`
      );
    }

    // Proceed with deletion
    await this.db.prepare(
      `DELETE FROM roles WHERE id = ?`
    ).bind(roleId).run();

    // Invalidate caches
    await this.permissionService.invalidateAllCaches();

    console.log(`[AUDIT] Role ${roleId} deleted by ${deletedBy}`);
  }

  /**
   * Modify role permissions - with system role protection
   */
  async modifyRolePermissions(
    roleId: string,
    operation: 'grant' | 'revoke',
    permissionId: string,
    modifiedBy: string
  ): Promise<void> {
    // CRITICAL: Prevent modification of system role permissions
    if (await this.isSystemRole(roleId)) {
      throw new Error(
        `Security violation: Cannot modify permissions for system role ${roleId}. System roles are protected.`
      );
    }

    // Check privilege escalation
    const check = await this.canGrantPermissions(modifiedBy, [permissionId]);
    if (!check.allowed) {
      throw new Error(
        `Privilege escalation prevented: You cannot modify permission '${check.missingPermissions[0]}'`
      );
    }

    // Proceed with operation
    if (operation === 'grant') {
      await this.permissionService.grantPermissionToRole(
        roleId,
        permissionId,
        modifiedBy
      );
    } else {
      await this.permissionService.revokePermissionFromRole(
        roleId,
        permissionId,
        modifiedBy
      );
    }
  }
}
```

### System Roles Protection Rules

1. **Cannot Delete**: `role_super_admin`, `role_admin`, `role_moderator`, `role_content_creator`, `role_user`
2. **Cannot Modify**: Name, description, or permissions of system roles
3. **Cannot Set**: `is_system` flag via API (only via migration)
4. **Audit All Attempts**: Log all attempts to modify system roles

### Implementation Requirements
- [ ] All role modifications check `is_system` flag
- [ ] All role deletions check `is_system` flag
- [ ] System role permission modifications are blocked
- [ ] `is_system` field cannot be modified via API
- [ ] Failed attempts are logged with security events

---

## Security Testing Requirements

### Test Cases

```typescript
describe('RBAC Security', () => {
  describe('SQL Injection Prevention', () => {
    it('should prevent SQL injection in role lookup', async () => {
      const maliciousInput = "admin' OR '1'='1";
      const role = await roleService.getRoleByName(maliciousInput);
      expect(role).toBeNull(); // Should not return any role
    });

    it('should prevent SQL injection in permission search', async () => {
      const maliciousInput = "users'; DROP TABLE permissions; --";
      const perms = await permissionService.findPermissions({
        resource: maliciousInput
      });
      expect(perms).toEqual([]);
    });
  });

  describe('Privilege Escalation Prevention', () => {
    it('should prevent non-admin from granting admin role', async () => {
      await expect(
        roleService.assignRoleToUser('user1', 'role_admin', 'regularUser')
      ).rejects.toThrow('Privilege escalation prevented');
    });

    it('should prevent granting super admin without having it', async () => {
      await expect(
        roleService.assignRoleToUser('user1', 'role_super_admin', 'adminUser')
      ).rejects.toThrow('Privilege escalation prevented');
    });
  });

  describe('System Role Protection', () => {
    it('should prevent deletion of system roles', async () => {
      await expect(
        roleService.deleteRole('role_super_admin', 'adminUser')
      ).rejects.toThrow('Cannot delete system role');
    });

    it('should prevent modification of system roles', async () => {
      await expect(
        roleService.updateRole('role_admin', { name: 'hacked' }, 'adminUser')
      ).rejects.toThrow('Cannot modify system role');
    });
  });

  describe('Cache Race Condition Prevention', () => {
    it('should invalidate cache on permission revocation', async () => {
      // Grant permission
      await roleService.assignRoleToUser('user1', 'role_admin', 'superAdmin');

      // Verify permission exists
      const hasPerm1 = await permissionService.hasPermission('user1', 'users:create:all');
      expect(hasPerm1).toBe(true);

      // Revoke permission
      await roleService.removeRoleFromUser('user1', 'role_admin', 'superAdmin');

      // Verify permission removed immediately (no stale cache)
      const hasPerm2 = await permissionService.hasPermission('user1', 'users:create:all');
      expect(hasPerm2).toBe(false);
    });
  });
});
```

---

## Deployment Checklist

Before deploying RBAC to production:

- [ ] All P0 security issues addressed
- [ ] SQL injection prevention implemented
- [ ] Versioned cache invalidation implemented
- [ ] Privilege escalation checks implemented
- [ ] System role protection implemented
- [ ] Security tests pass (40+ test cases)
- [ ] Code review completed
- [ ] Penetration testing completed
- [ ] Audit logging verified
- [ ] Rollback plan documented

---

## Security Monitoring

### Metrics to Track

1. **Failed Authorization Attempts**
   - Privilege escalation attempts
   - System role modification attempts
   - Invalid permission grants

2. **Cache Performance**
   - Cache hit/miss rates
   - Cache invalidation frequency
   - Permission lookup latency

3. **Audit Events**
   - All permission/role changes
   - Failed security checks
   - System role access attempts

### Alert Thresholds

- More than 5 privilege escalation attempts in 1 hour
- More than 10 system role modification attempts in 1 hour
- Cache invalidation frequency > 100/hour (indicates potential attack)

---

## References

- [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
- [OWASP Access Control](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [Cloudflare Workers KV Best Practices](https://developers.cloudflare.com/kv/best-practices/)

---

**Document Status**: Production Ready ✅
**Last Updated**: 2025-10-15
**Review Required**: Before any production deployment
