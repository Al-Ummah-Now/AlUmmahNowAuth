# RBAC Test Plan

## Executive Summary
This document outlines the comprehensive testing strategy for the Role-Based Access Control (RBAC) system implementation. It covers unit tests, integration tests, performance tests, security tests, and user acceptance criteria.

## Test Objectives
1. Verify correct permission evaluation logic
2. Ensure backward compatibility with existing role system
3. Validate performance under load
4. Confirm security boundaries are enforced
5. Test cache invalidation mechanisms
6. Verify audit logging completeness
7. Validate migration process

## Test Environment Requirements

### Infrastructure
- Cloudflare Workers test environment
- D1 database (test instance)
- KV namespace (test instance)
- Mock OpenAuth service
- Test data generators

### Test Data
- 1000+ test users
- 50+ test roles
- 100+ test permissions
- Various role hierarchies
- Edge case scenarios

## Test Categories

## 1. Unit Tests

### 1.1 Permission Service Tests

#### Test Case: Permission Matching
```typescript
describe('Permission Matching', () => {
  test('Exact permission match', () => {
    // Given: User has permission 'users:read:all'
    // When: Check for 'users:read:all'
    // Then: Should return true
  });

  test('Wildcard resource match', () => {
    // Given: User has permission '*:read:all'
    // When: Check for 'users:read:all'
    // Then: Should return true
  });

  test('Wildcard action match', () => {
    // Given: User has permission 'users:*:all'
    // When: Check for 'users:delete:all'
    // Then: Should return true
  });

  test('Wildcard scope match', () => {
    // Given: User has permission 'users:read:*'
    // When: Check for 'users:read:own'
    // Then: Should return true
  });

  test('Super admin wildcard', () => {
    // Given: User has permission '*:*:*'
    // When: Check for any permission
    // Then: Should return true
  });

  test('No match returns false', () => {
    // Given: User has permission 'users:read:own'
    // When: Check for 'users:delete:all'
    // Then: Should return false
  });
});
```

#### Test Case: Scope Hierarchy
```typescript
describe('Scope Hierarchy', () => {
  test('Higher scope grants lower scope', () => {
    // Given: User has 'content:read:all'
    // When: Check for 'content:read:own'
    // Then: Should return true
  });

  test('Lower scope does not grant higher scope', () => {
    // Given: User has 'content:read:own'
    // When: Check for 'content:read:all'
    // Then: Should return false
  });

  test('Scope hierarchy order: all > org > team > own', () => {
    // Test each level grants appropriate access
  });
});
```

#### Test Case: Direct Permission Overrides
```typescript
describe('Direct Permission Overrides', () => {
  test('Direct deny overrides role grant', () => {
    // Given: Role grants 'users:delete:all'
    // And: Direct deny for 'users:delete:all'
    // When: Check permission
    // Then: Should return false
  });

  test('Direct grant works without role', () => {
    // Given: No roles assigned
    // And: Direct grant for 'admin:special:all'
    // When: Check permission
    // Then: Should return true
  });

  test('Expired direct permissions ignored', () => {
    // Given: Expired direct grant
    // When: Check permission
    // Then: Should return false
  });
});
```

### 1.2 Role Service Tests

#### Test Case: Role Hierarchy
```typescript
describe('Role Hierarchy', () => {
  test('Child role inherits parent permissions', () => {
    // Given: Parent role has permissions A, B
    // And: Child role extends parent
    // When: Get child role permissions
    // Then: Should include A, B
  });

  test('Circular hierarchy prevented', () => {
    // Given: Role A with parent B
    // When: Try to set B's parent to A
    // Then: Should throw error
  });

  test('Deep hierarchy traversal', () => {
    // Given: 5-level deep role hierarchy
    // When: Get leaf role permissions
    // Then: Should include all ancestor permissions
  });
});
```

#### Test Case: Role Assignment
```typescript
describe('Role Assignment', () => {
  test('User can have multiple roles', () => {
    // Given: User with roles A and B
    // When: Get user permissions
    // Then: Should have combined permissions
  });

  test('Duplicate role assignment prevented', () => {
    // Given: User has role A
    // When: Assign role A again
    // Then: Should not create duplicate
  });

  test('Expired role assignments ignored', () => {
    // Given: Role with past expiry date
    // When: Get user permissions
    // Then: Should not include expired role
  });

  test('Inactive roles excluded', () => {
    // Given: Role marked as inactive
    // When: Get user permissions
    // Then: Should not include inactive role
  });
});
```

### 1.3 Cache Service Tests

#### Test Case: Cache Operations
```typescript
describe('Cache Operations', () => {
  test('Cache miss triggers database load', () => {
    // Given: Empty cache
    // When: Get permissions
    // Then: Should load from database
  });

  test('Cache hit avoids database', () => {
    // Given: Cached permissions
    // When: Get permissions
    // Then: Should not query database
  });

  test('Expired cache treated as miss', () => {
    // Given: Expired cache entry
    // When: Get permissions
    // Then: Should reload from database
  });

  test('Cache invalidation on role change', () => {
    // Given: Cached permissions
    // When: User role changes
    // Then: Cache should be cleared
  });
});
```

## 2. Integration Tests

### 2.1 API Endpoint Tests

#### Test Case: Permission Check Endpoint
```typescript
describe('POST /permissions/check', () => {
  test('Authorized user can check permissions', async () => {
    const response = await fetch('/api/permissions/check', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        permission: 'users:read:all'
      })
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('hasPermission');
  });

  test('Unauthenticated request rejected', async () => {
    const response = await fetch('/api/permissions/check', {
      method: 'POST',
      body: JSON.stringify({
        permission: 'users:read:all'
      })
    });

    expect(response.status).toBe(401);
  });

  test('Invalid permission format rejected', async () => {
    const response = await fetch('/api/permissions/check', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        permission: 'invalid-format'
      })
    });

    expect(response.status).toBe(400);
  });
});
```

#### Test Case: Role Management
```typescript
describe('Role Management API', () => {
  test('Create role with permissions', async () => {
    const response = await fetch('/api/roles', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'test_role',
        description: 'Test role',
        permissions: ['users:read:all']
      })
    });

    expect(response.status).toBe(201);
    const role = await response.json();
    expect(role.name).toBe('test_role');
  });

  test('Non-admin cannot create roles', async () => {
    const response = await fetch('/api/roles', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer user-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'unauthorized_role'
      })
    });

    expect(response.status).toBe(403);
  });

  test('Cannot delete system role', async () => {
    const response = await fetch('/api/roles/role_super_admin', {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer admin-token'
      }
    });

    expect(response.status).toBe(403);
  });

  test('Cannot delete role with active users', async () => {
    // Assign role to user first
    await assignRoleToUser('user123', 'role_test');

    const response = await fetch('/api/roles/role_test', {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer admin-token'
      }
    });

    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error).toContain('active users');
  });
});
```

### 2.2 Middleware Tests

#### Test Case: Permission Middleware
```typescript
describe('Permission Middleware', () => {
  test('Allows access with required permission', async () => {
    // Setup: User with 'users:read:all' permission
    const response = await fetch('/admin/users', {
      headers: {
        'Authorization': 'Bearer user-with-permission'
      }
    });

    expect(response.status).toBe(200);
  });

  test('Denies access without permission', async () => {
    // Setup: User without 'users:read:all' permission
    const response = await fetch('/admin/users', {
      headers: {
        'Authorization': 'Bearer user-without-permission'
      }
    });

    expect(response.status).toBe(403);
  });

  test('Logs permission denial in audit', async () => {
    // Make request that will be denied
    await fetch('/admin/users', {
      headers: {
        'Authorization': 'Bearer user-without-permission'
      }
    });

    // Check audit log
    const audit = await getAuditEvents('permission.denied');
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.path).toBe('/admin/users');
  });
});
```

## 3. Performance Tests

### 3.1 Load Testing

#### Test Scenario: Permission Check Performance
```yaml
scenario: Permission Check Load Test
vus: 100  # Virtual users
duration: 5m
thresholds:
  - p95 < 50ms  # 95th percentile under 50ms
  - p99 < 100ms # 99th percentile under 100ms

steps:
  - name: Authenticate
    request:
      method: POST
      url: /api/auth/login
      body:
        email: "{{user.email}}"
        password: "{{user.password}}"

  - name: Check Permission
    request:
      method: POST
      url: /api/permissions/check
      headers:
        Authorization: "Bearer {{token}}"
      body:
        permission: "{{random_permission}}"

    assertions:
      - status == 200
      - response_time < 100
```

#### Test Scenario: Bulk Permission Loading
```yaml
scenario: Bulk Permission Load
description: Test loading permissions for many users simultaneously

setup:
  - Create 1000 users
  - Assign random roles to each user
  - Clear all caches

test:
  - Concurrent requests: 500
  - Duration: 1 minute
  - Measure: Response time, cache hit rate

expected:
  - Average response time < 30ms
  - P99 response time < 100ms
  - Cache hit rate > 80% after warmup
  - No database connection errors
```

### 3.2 Cache Performance

#### Test Case: Cache Hit Rate
```typescript
describe('Cache Performance', () => {
  test('Cache hit rate > 90% under normal load', async () => {
    // Warmup: Load permissions for 100 users
    await warmupCache(100);

    // Measure: Make 1000 permission checks
    const startTime = Date.now();
    let cacheHits = 0;

    for (let i = 0; i < 1000; i++) {
      const userId = getRandomUserId();
      const result = await checkPermissionWithStats(userId, 'test:read:all');
      if (result.fromCache) cacheHits++;
    }

    const hitRate = (cacheHits / 1000) * 100;
    expect(hitRate).toBeGreaterThan(90);
  });

  test('Cache invalidation completes under 1 second', async () => {
    // Setup: 100 users with cached permissions
    const userIds = await setupUsersWithCache(100);

    // Measure: Invalidate all caches
    const startTime = Date.now();
    await invalidateAllUserCaches(userIds);
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(1000);
  });
});
```

## 4. Security Tests

### 4.1 Authorization Tests

#### Test Case: Privilege Escalation Prevention
```typescript
describe('Privilege Escalation Prevention', () => {
  test('User cannot grant permissions they dont have', async () => {
    // Given: User with limited permissions
    const response = await fetch('/api/users/other-user/permissions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer limited-user-token'
      },
      body: JSON.stringify({
        permissions: ['admin:super:all']
      })
    });

    expect(response.status).toBe(403);
  });

  test('User cannot assign higher roles', async () => {
    // Given: Moderator user
    const response = await fetch('/api/users/other-user/roles', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer moderator-token'
      },
      body: JSON.stringify({
        roleId: 'role_admin'
      })
    });

    expect(response.status).toBe(403);
  });

  test('User cannot modify system roles', async () => {
    const response = await fetch('/api/roles/role_super_admin', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer admin-token'
      },
      body: JSON.stringify({
        permissions: ['malicious:permission:all']
      })
    });

    expect(response.status).toBe(403);
  });
});
```

#### Test Case: SQL Injection Prevention
```typescript
describe('SQL Injection Prevention', () => {
  test('Permission name with SQL rejected', async () => {
    const response = await fetch('/api/permissions/check', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-token'
      },
      body: JSON.stringify({
        permission: "users:read:all'; DROP TABLE users; --"
      })
    });

    expect(response.status).toBe(400);
  });

  test('Role name with special characters sanitized', async () => {
    const response = await fetch('/api/roles', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer admin-token'
      },
      body: JSON.stringify({
        name: "test'; DELETE FROM roles WHERE '1'='1"
      })
    });

    expect(response.status).toBe(400);
  });
});
```

### 4.2 Audit Trail Tests

#### Test Case: Audit Logging Completeness
```typescript
describe('Audit Logging', () => {
  test('Permission check logged', async () => {
    await checkPermission('user123', 'users:read:all');

    const audit = await getAuditEvents({
      eventType: 'permission.check',
      userId: 'user123'
    });

    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.permission).toBe('users:read:all');
  });

  test('Role assignment logged', async () => {
    await assignRole('user123', 'role_admin', 'admin456');

    const audit = await getAuditEvents({
      eventType: 'rbac.role_assigned',
      userId: 'admin456'
    });

    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.targetUserId).toBe('user123');
    expect(audit[0].metadata.roleId).toBe('role_admin');
  });

  test('Failed permission attempts logged', async () => {
    await checkPermission('user123', 'admin:super:all'); // Will fail

    const audit = await getAuditEvents({
      eventType: 'permission.denied',
      userId: 'user123'
    });

    expect(audit).toHaveLength(1);
    expect(audit[0].severity).toBe('warning');
  });
});
```

## 5. Migration Tests

### 5.1 Data Migration

#### Test Case: Existing User Migration
```typescript
describe('User Migration to RBAC', () => {
  test('Admin users get admin role', async () => {
    // Given: Users with role='admin' in old system
    const adminUsers = await getOldSystemAdmins();

    // When: Migration runs
    await runMigration();

    // Then: All admins have role_admin in RBAC
    for (const user of adminUsers) {
      const roles = await getUserRoles(user.id);
      expect(roles).toContainEqual(
        expect.objectContaining({ roleId: 'role_admin' })
      );
    }
  });

  test('Regular users get user role', async () => {
    // Given: Users with role='user' in old system
    const regularUsers = await getOldSystemUsers();

    // When: Migration runs
    await runMigration();

    // Then: All users have role_user in RBAC
    for (const user of regularUsers) {
      const roles = await getUserRoles(user.id);
      expect(roles).toContainEqual(
        expect.objectContaining({ roleId: 'role_user' })
      );
    }
  });

  test('No users left without roles', async () => {
    await runMigration();

    const usersWithoutRoles = await db.query(`
      SELECT COUNT(*) as count
      FROM user u
      WHERE NOT EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.user_id = u.id AND ur.is_active = TRUE
      )
    `);

    expect(usersWithoutRoles[0].count).toBe(0);
  });
});
```

### 5.2 Rollback Tests

#### Test Case: Rollback Procedure
```typescript
describe('RBAC Rollback', () => {
  test('Rollback restores original role field', async () => {
    // Given: RBAC system active
    await runMigration();

    // When: Rollback executed
    await runRollback();

    // Then: Original role field restored
    const users = await getAllUsers();
    for (const user of users) {
      expect(user.role).toBeInRange(['admin', 'user']);
    }
  });

  test('RBAC tables removed after rollback', async () => {
    await runMigration();
    await runRollback();

    const tables = await getTableList();
    expect(tables).not.toContain('roles');
    expect(tables).not.toContain('permissions');
    expect(tables).not.toContain('user_roles');
  });
});
```

## 6. Edge Case Tests

### 6.1 Boundary Conditions

#### Test Case: Maximum Limits
```typescript
describe('System Limits', () => {
  test('User with 100+ roles', async () => {
    // Create user with many roles
    const userId = await createUser();
    for (let i = 0; i < 100; i++) {
      await assignRole(userId, `role_${i}`);
    }

    // Should still perform adequately
    const start = Date.now();
    const perms = await getUserPermissions(userId);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100);
    expect(perms).toBeDefined();
  });

  test('Role with 1000+ permissions', async () => {
    const roleId = await createRole('massive_role');
    const permissions = generatePermissions(1000);

    await assignPermissionsToRole(roleId, permissions);

    const rolePerms = await getRolePermissions(roleId);
    expect(rolePerms).toHaveLength(1000);
  });

  test('Deep role hierarchy (10 levels)', async () => {
    // Create deep hierarchy
    let parentId = null;
    for (let i = 0; i < 10; i++) {
      const role = await createRole(`level_${i}`, parentId);
      parentId = role.id;
    }

    // Leaf role should inherit all permissions
    const leafPermissions = await getRolePermissions(parentId);
    expect(leafPermissions).toBeDefined();
  });
});
```

### 6.2 Concurrent Operations

#### Test Case: Race Conditions
```typescript
describe('Concurrent Operations', () => {
  test('Simultaneous role assignments', async () => {
    const userId = await createUser();

    // Assign multiple roles concurrently
    const assignments = Promise.all([
      assignRole(userId, 'role_1'),
      assignRole(userId, 'role_2'),
      assignRole(userId, 'role_3')
    ]);

    await expect(assignments).resolves.toBeDefined();

    const roles = await getUserRoles(userId);
    expect(roles).toHaveLength(3);
  });

  test('Cache invalidation during active reads', async () => {
    const userId = await createUser();

    // Start multiple permission checks
    const checks = [];
    for (let i = 0; i < 100; i++) {
      checks.push(checkPermission(userId, 'test:read:all'));
    }

    // Invalidate cache in the middle
    setTimeout(() => invalidateCache(userId), 50);

    const results = await Promise.all(checks);
    expect(results.every(r => typeof r === 'boolean')).toBe(true);
  });
});
```

## 7. User Acceptance Tests

### 7.1 Admin Dashboard

#### Test Scenario: Role Management UI
```
Feature: Role Management
  As an admin
  I want to manage roles and permissions
  So that I can control user access

  Scenario: Create new role
    Given I am logged in as admin
    When I navigate to /admin/roles
    And I click "Create Role"
    And I enter role name "Content Reviewer"
    And I select permissions:
      | content:read:all |
      | content:update:all |
      | content:approve:all |
    And I click "Save"
    Then I should see "Role created successfully"
    And the role should appear in the list

  Scenario: Assign role to user
    Given I am on the user management page
    When I select user "john@example.com"
    And I click "Manage Roles"
    And I assign role "Content Reviewer"
    Then the user should have the new role
    And audit log should show the assignment

  Scenario: Remove role from user
    Given user has role "Content Reviewer"
    When I remove the role
    Then user should lose associated permissions
    And user sessions should be invalidated
```

### 7.2 Permission Checks

#### Test Scenario: Content Management Permissions
```
Feature: Content Permissions
  As a content creator
  I want appropriate permissions
  So that I can manage my content

  Scenario: View own content
    Given I am a content creator
    When I navigate to /my-content
    Then I should see my content list

  Scenario: Cannot edit others' content
    Given I am a content creator
    When I try to edit another user's content
    Then I should see "Permission denied"

  Scenario: Moderator can edit any content
    Given I am a moderator
    When I edit any content
    Then the edit should succeed
    And audit log should record the action
```

## 8. Regression Tests

### 8.1 Backward Compatibility

#### Test Case: Legacy API Compatibility
```typescript
describe('Backward Compatibility', () => {
  test('Old role field still works', async () => {
    const user = await db.query(
      'SELECT role FROM user WHERE id = ?',
      ['user123']
    );

    expect(user[0].role).toBeDefined();
    expect(['admin', 'user']).toContain(user[0].role);
  });

  test('Legacy permission checks work', async () => {
    // Old code checking user.role === 'admin'
    const isAdmin = await legacyAdminCheck('admin-user-id');
    expect(isAdmin).toBe(true);
  });
});
```

## 9. Monitoring & Alerting Tests

### 9.1 Metrics Collection

#### Test Case: Performance Metrics
```typescript
describe('Metrics Collection', () => {
  test('Permission check latency tracked', async () => {
    await checkPermission('user123', 'test:read:all');

    const metrics = await getMetrics('permission_check_latency');
    expect(metrics).toBeDefined();
    expect(metrics.p50).toBeLessThan(50);
  });

  test('Cache hit rate tracked', async () => {
    // Perform multiple permission checks
    for (let i = 0; i < 100; i++) {
      await checkPermission('user123', 'test:read:all');
    }

    const metrics = await getMetrics('cache_hit_rate');
    expect(metrics.rate).toBeGreaterThan(0.8);
  });
});
```

## Test Execution Plan

### Phase 1: Development Testing
- Unit tests: Run on every commit
- Integration tests: Run on PR creation
- Coverage requirement: > 80%

### Phase 2: Staging Testing
- Deploy to staging environment
- Run full test suite
- Performance testing with realistic data
- Security scanning

### Phase 3: Production Testing
- Canary deployment (5% of traffic)
- Monitor metrics and error rates
- A/B testing for permission checks
- Gradual rollout to 100%

### Phase 4: Post-Deployment
- Continuous monitoring
- Weekly security audits
- Monthly performance reviews
- Quarterly penetration testing

## Test Data Management

### Test User Hierarchy
```
super_admin_test
├── admin_test_1
│   ├── moderator_test_1
│   └── moderator_test_2
├── admin_test_2
└── content_creator_test
    └── user_test_1
        └── user_test_2
```

### Test Permissions Matrix
| Role | Users | Content | Settings | Audit |
|------|-------|---------|----------|-------|
| super_admin | All | All | All | All |
| admin | All | All | Read/Write | Read |
| moderator | Read | All | - | - |
| content_creator | Own | Own | - | - |
| user | Own | Read | - | - |

## Success Criteria

### Functional Requirements
- ✅ All permission checks accurate
- ✅ Role inheritance working
- ✅ Cache invalidation functional
- ✅ Audit logging complete
- ✅ Migration successful
- ✅ Rollback tested

### Non-Functional Requirements
- ✅ P95 latency < 50ms
- ✅ P99 latency < 100ms
- ✅ Cache hit rate > 80%
- ✅ Zero security vulnerabilities
- ✅ 99.9% availability
- ✅ Backward compatible

## Risk Mitigation

### High Risk Areas
1. **Migration failures**
   - Mitigation: Dry run on copy of production
   - Rollback plan ready

2. **Performance degradation**
   - Mitigation: Comprehensive load testing
   - Cache optimization

3. **Security breaches**
   - Mitigation: Security audit
   - Penetration testing

4. **Cache inconsistencies**
   - Mitigation: Conservative TTLs
   - Version-based invalidation

## Test Automation

### CI/CD Pipeline
```yaml
name: RBAC Test Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - run: npm test:unit

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - run: npm test:integration

  security-scan:
    runs-on: ubuntu-latest
    needs: integration-tests
    steps:
      - run: npm audit
      - run: npm run security:scan

  performance-tests:
    runs-on: ubuntu-latest
    needs: integration-tests
    if: github.ref == 'refs/heads/main'
    steps:
      - run: npm test:performance
```

## Reporting

### Test Reports
- Daily: Unit test results
- Weekly: Integration test summary
- Monthly: Performance benchmarks
- Quarterly: Security audit report

### Metrics Dashboard
- Real-time permission check latency
- Cache hit rate
- Error rate by permission type
- Audit event volume
- Role distribution
- Permission usage heatmap

## Conclusion

This comprehensive test plan ensures the RBAC system is thoroughly validated across all dimensions:
- Functionality
- Performance
- Security
- Compatibility
- Reliability

Regular execution of these tests and continuous monitoring will ensure the system maintains its integrity and performance standards in production.