# Permission Checking Patterns

## Introduction
This document provides reusable patterns and best practices for implementing permission checks throughout the Al Ummah Now platform. These patterns ensure consistent, performant, and secure authorization across all services.

## Core Patterns

### 1. Basic Permission Check

#### Pattern: Simple Permission Verification
```typescript
// Basic permission check for a single permission
async function checkBasicPermission(
  userId: string,
  permission: string,
  env: Env
): Promise<boolean> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
  return await permService.hasPermission(userId, permission);
}

// Usage example
if (!await checkBasicPermission(userId, 'users:read:all', env)) {
  throw new Error('Permission denied');
}
```

#### Pattern: Multiple Permission Options (OR Logic)
```typescript
// User needs at least one of the specified permissions
async function checkAnyPermission(
  userId: string,
  permissions: string[],
  env: Env
): Promise<boolean> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  for (const permission of permissions) {
    if (await permService.hasPermission(userId, permission)) {
      return true;
    }
  }

  return false;
}

// Usage: User can access if they have either admin or moderator permissions
const canAccess = await checkAnyPermission(
  userId,
  ['content:moderate:all', 'content:admin:all'],
  env
);
```

#### Pattern: Required Permissions (AND Logic)
```typescript
// User must have all specified permissions
async function checkAllPermissions(
  userId: string,
  permissions: string[],
  env: Env
): Promise<boolean> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  for (const permission of permissions) {
    if (!await permService.hasPermission(userId, permission)) {
      return false;
    }
  }

  return true;
}

// Usage: User needs both permissions to perform action
const canPerform = await checkAllPermissions(
  userId,
  ['content:delete:all', 'content:permanent_delete:all'],
  env
);
```

### 2. Resource-Based Permissions

#### Pattern: Owner-Based Access
```typescript
interface Resource {
  id: string;
  ownerId: string;
  type: string;
}

async function checkResourcePermission(
  userId: string,
  action: string,
  resource: Resource,
  env: Env
): Promise<boolean> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Check if user is the owner
  const isOwner = resource.ownerId === userId;

  // Build permission string based on ownership
  const scope = isOwner ? 'own' : 'all';
  const permission = `${resource.type}:${action}:${scope}`;

  // If owner, check for 'own' permission
  if (isOwner) {
    return await permService.hasPermission(userId, permission);
  }

  // If not owner, need 'all' permission
  return await permService.hasPermission(
    userId,
    `${resource.type}:${action}:all`
  );
}

// Usage
const content = await loadContent(contentId);
const canEdit = await checkResourcePermission(
  userId,
  'update',
  {
    id: content.id,
    ownerId: content.userId,
    type: 'content'
  },
  env
);
```

#### Pattern: Hierarchical Resource Access
```typescript
async function checkHierarchicalPermission(
  userId: string,
  action: string,
  resource: {
    type: string;
    id: string;
    ownerId: string;
    teamId?: string;
    organizationId?: string;
  },
  env: Env
): Promise<boolean> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Check from most specific to least specific
  const scopes = [];

  if (resource.ownerId === userId) {
    scopes.push('own');
  }

  if (resource.teamId && await isUserInTeam(userId, resource.teamId)) {
    scopes.push('team');
  }

  if (resource.organizationId && await isUserInOrg(userId, resource.organizationId)) {
    scopes.push('org');
  }

  scopes.push('all');

  // Check each scope level
  for (const scope of scopes) {
    const permission = `${resource.type}:${action}:${scope}`;
    if (await permService.hasPermission(userId, permission)) {
      return true;
    }
  }

  return false;
}
```

### 3. Middleware Patterns

#### Pattern: Express/Hono Middleware
```typescript
import { Context, Next } from 'hono';

// Basic permission middleware
export function requirePermission(permission: string) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');

    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const permService = new PermissionService(
      c.env.AUTH_DB,
      c.env.AUTH_STORAGE
    );

    if (!await permService.hasPermission(userId, permission)) {
      // Audit the denial
      await logPermissionDenial(userId, permission, c);

      return c.json({
        error: 'Insufficient permissions',
        required: permission
      }, 403);
    }

    await next();
  };
}

// Usage
app.get('/admin/users',
  requireAuth(),
  requirePermission('users:read:all'),
  async (c) => {
    // Handler code
  }
);
```

#### Pattern: Dynamic Permission Middleware
```typescript
// Middleware that determines permission based on request
export function requireDynamicPermission(
  getPermission: (c: Context) => string | Promise<string>
) {
  return async (c: Context, next: Next) => {
    const userId = c.get('userId');
    const permission = await getPermission(c);

    const permService = new PermissionService(
      c.env.AUTH_DB,
      c.env.AUTH_STORAGE
    );

    if (!await permService.hasPermission(userId, permission)) {
      return c.json({
        error: 'Insufficient permissions',
        required: permission
      }, 403);
    }

    await next();
  };
}

// Usage: Permission depends on HTTP method
app.all('/api/content/:id',
  requireAuth(),
  requireDynamicPermission(async (c) => {
    const method = c.req.method;
    const actions: Record<string, string> = {
      'GET': 'read',
      'PUT': 'update',
      'DELETE': 'delete'
    };

    return `content:${actions[method] || 'read'}:all`;
  }),
  async (c) => {
    // Handler
  }
);
```

### 4. Caching Patterns

#### Pattern: Request-Scoped Cache
```typescript
class RequestPermissionCache {
  private cache = new Map<string, boolean>();
  private userId: string;
  private permService: PermissionService;

  constructor(userId: string, permService: PermissionService) {
    this.userId = userId;
    this.permService = permService;
  }

  async hasPermission(permission: string): Promise<boolean> {
    // Check request cache first
    if (this.cache.has(permission)) {
      return this.cache.get(permission)!;
    }

    // Load from service (which has its own cache)
    const result = await this.permService.hasPermission(
      this.userId,
      permission
    );

    // Cache for this request
    this.cache.set(permission, result);

    return result;
  }
}

// Usage in request handler
app.use(async (c, next) => {
  const userId = c.get('userId');
  if (userId) {
    const permService = new PermissionService(
      c.env.AUTH_DB,
      c.env.AUTH_STORAGE
    );
    const cache = new RequestPermissionCache(userId, permService);
    c.set('permissionCache', cache);
  }
  await next();
});

// In handlers
const permCache = c.get('permissionCache');
const canRead = await permCache.hasPermission('content:read:all');
```

#### Pattern: Preload Common Permissions
```typescript
async function preloadUserPermissions(
  userId: string,
  commonPermissions: string[],
  env: Env
): Promise<Map<string, boolean>> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
  const results = new Map<string, boolean>();

  // Load all permissions in parallel
  const checks = await Promise.all(
    commonPermissions.map(async (perm) => ({
      permission: perm,
      hasPermission: await permService.hasPermission(userId, perm)
    }))
  );

  checks.forEach(({ permission, hasPermission }) => {
    results.set(permission, hasPermission);
  });

  return results;
}

// Usage: Preload permissions for a dashboard
const permissions = await preloadUserPermissions(
  userId,
  [
    'users:read:all',
    'content:read:all',
    'analytics:read:all',
    'settings:read:all'
  ],
  env
);

// Use preloaded permissions
if (permissions.get('users:read:all')) {
  // Show users section
}
```

### 5. Conditional Rendering Patterns

#### Pattern: UI Component Visibility
```typescript
// React component with permission-based rendering
function PermissionGate({
  permission,
  children,
  fallback = null
}: {
  permission: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { hasPermission } = usePermissions();
  const [canRender, setCanRender] = useState(false);

  useEffect(() => {
    hasPermission(permission).then(setCanRender);
  }, [permission]);

  return canRender ? <>{children}</> : <>{fallback}</>;
}

// Usage
<PermissionGate permission="users:delete:all">
  <Button onClick={handleDelete}>Delete User</Button>
</PermissionGate>
```

#### Pattern: Menu Item Filtering
```typescript
interface MenuItem {
  label: string;
  path: string;
  permission?: string;
  children?: MenuItem[];
}

async function filterMenuItems(
  items: MenuItem[],
  userId: string,
  env: Env
): Promise<MenuItem[]> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
  const filtered: MenuItem[] = [];

  for (const item of items) {
    // Check permission if specified
    if (item.permission) {
      const hasPermission = await permService.hasPermission(
        userId,
        item.permission
      );

      if (!hasPermission) {
        continue; // Skip this item
      }
    }

    // Recursively filter children
    if (item.children) {
      const filteredChildren = await filterMenuItems(
        item.children,
        userId,
        env
      );

      // Only include parent if it has visible children
      if (filteredChildren.length > 0) {
        filtered.push({
          ...item,
          children: filteredChildren
        });
      }
    } else {
      filtered.push(item);
    }
  }

  return filtered;
}
```

### 6. Batch Permission Patterns

#### Pattern: Bulk Resource Filtering
```typescript
async function filterResourcesByPermission<T extends { id: string; ownerId: string }>(
  resources: T[],
  userId: string,
  action: string,
  resourceType: string,
  env: Env
): Promise<T[]> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Check if user has 'all' permission
  const hasAllPermission = await permService.hasPermission(
    userId,
    `${resourceType}:${action}:all`
  );

  if (hasAllPermission) {
    return resources; // Can access all
  }

  // Check if user has 'own' permission
  const hasOwnPermission = await permService.hasPermission(
    userId,
    `${resourceType}:${action}:own`
  );

  if (hasOwnPermission) {
    // Filter to only owned resources
    return resources.filter(r => r.ownerId === userId);
  }

  // No permission
  return [];
}

// Usage
const allContent = await loadAllContent();
const accessibleContent = await filterResourcesByPermission(
  allContent,
  userId,
  'read',
  'content',
  env
);
```

#### Pattern: Parallel Permission Checks
```typescript
interface PermissionCheckResult {
  [key: string]: boolean;
}

async function checkMultiplePermissions(
  userId: string,
  permissions: string[],
  env: Env
): Promise<PermissionCheckResult> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  // Check all permissions in parallel
  const results = await Promise.all(
    permissions.map(async (permission) => ({
      permission,
      hasPermission: await permService.hasPermission(userId, permission)
    }))
  );

  // Convert to object
  return results.reduce((acc, { permission, hasPermission }) => {
    acc[permission] = hasPermission;
    return acc;
  }, {} as PermissionCheckResult);
}

// Usage
const permissions = await checkMultiplePermissions(
  userId,
  ['users:read:all', 'content:write:all', 'settings:manage:all'],
  env
);

if (permissions['users:read:all']) {
  // Show users section
}
```

### 7. Error Handling Patterns

#### Pattern: Permission Denial with Context
```typescript
class PermissionDeniedError extends Error {
  constructor(
    public userId: string,
    public permission: string,
    public resource?: any,
    public context?: any
  ) {
    super(`Permission denied: ${permission} for user ${userId}`);
    this.name = 'PermissionDeniedError';
  }
}

async function enforcePermission(
  userId: string,
  permission: string,
  env: Env,
  context?: any
): Promise<void> {
  const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);

  if (!await permService.hasPermission(userId, permission)) {
    // Log the denial
    await env.AUDIT_SERVICE.log({
      eventType: 'permission.denied',
      userId,
      metadata: {
        permission,
        context
      },
      severity: 'warning',
      success: false
    });

    throw new PermissionDeniedError(userId, permission, null, context);
  }
}

// Usage with error handling
try {
  await enforcePermission(
    userId,
    'admin:super:all',
    env,
    { action: 'delete_all_users' }
  );

  // Perform dangerous operation
  await deleteAllUsers();
} catch (error) {
  if (error instanceof PermissionDeniedError) {
    // Handle permission denial specifically
    return c.json({
      error: 'Permission denied',
      required: error.permission,
      message: 'You do not have sufficient privileges for this action'
    }, 403);
  }

  throw error; // Re-throw other errors
}
```

### 8. Delegation Patterns

#### Pattern: Temporary Permission Elevation
```typescript
async function withElevatedPermissions<T>(
  userId: string,
  permissions: string[],
  duration: number, // seconds
  reason: string,
  operation: () => Promise<T>,
  env: Env
): Promise<T> {
  const grantedPermissions: string[] = [];

  try {
    // Grant temporary permissions
    for (const permission of permissions) {
      await grantTemporaryPermission(
        userId,
        permission,
        duration,
        'system',
        reason,
        env
      );
      grantedPermissions.push(permission);
    }

    // Invalidate cache to pick up new permissions
    const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
    await permService.invalidateUserCache(userId);

    // Execute operation with elevated permissions
    const result = await operation();

    return result;
  } finally {
    // Revoke temporary permissions
    for (const permission of grantedPermissions) {
      await revokeTemporaryPermission(userId, permission, env);
    }

    // Invalidate cache again
    const permService = new PermissionService(env.AUTH_DB, env.AUTH_STORAGE);
    await permService.invalidateUserCache(userId);
  }
}

// Usage: Temporary admin access for specific operation
const result = await withElevatedPermissions(
  userId,
  ['users:delete:all'],
  300, // 5 minutes
  'Bulk user cleanup approved by admin',
  async () => {
    return await performBulkUserCleanup();
  },
  env
);
```

### 9. Testing Patterns

#### Pattern: Permission Mock for Testing
```typescript
class MockPermissionService {
  private permissions: Map<string, Set<string>> = new Map();

  grantPermission(userId: string, permission: string) {
    if (!this.permissions.has(userId)) {
      this.permissions.set(userId, new Set());
    }
    this.permissions.get(userId)!.add(permission);
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const userPerms = this.permissions.get(userId);
    if (!userPerms) return false;

    // Check exact match
    if (userPerms.has(permission)) return true;

    // Check wildcards
    for (const perm of userPerms) {
      if (perm === '*:*:*') return true;

      const [permResource, permAction, permScope] = perm.split(':');
      const [reqResource, reqAction, reqScope] = permission.split(':');

      if (
        (permResource === '*' || permResource === reqResource) &&
        (permAction === '*' || permAction === reqAction) &&
        (permScope === '*' || permScope === reqScope)
      ) {
        return true;
      }
    }

    return false;
  }
}

// Usage in tests
describe('Content API', () => {
  let mockPermissions: MockPermissionService;

  beforeEach(() => {
    mockPermissions = new MockPermissionService();
  });

  test('Admin can delete any content', async () => {
    mockPermissions.grantPermission('admin-user', 'content:delete:all');

    const canDelete = await mockPermissions.hasPermission(
      'admin-user',
      'content:delete:all'
    );

    expect(canDelete).toBe(true);
  });
});
```

### 10. Performance Patterns

#### Pattern: Permission Check Batching
```typescript
class PermissionBatcher {
  private pending: Map<string, Promise<boolean>> = new Map();
  private queue: Array<{ userId: string; permission: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  private permService: PermissionService;

  constructor(permService: PermissionService, private batchDelay = 10) {
    this.permService = permService;
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const key = `${userId}:${permission}`;

    // Return existing promise if already checking
    if (this.pending.has(key)) {
      return this.pending.get(key)!;
    }

    // Create promise for this check
    const promise = new Promise<boolean>((resolve) => {
      this.queue.push({ userId, permission });

      // Schedule batch processing
      if (!this.timer) {
        this.timer = setTimeout(() => this.processBatch(), this.batchDelay);
      }
    });

    this.pending.set(key, promise);
    return promise;
  }

  private async processBatch() {
    const batch = [...this.queue];
    this.queue = [];
    this.timer = null;

    // Group by user for efficient loading
    const byUser = new Map<string, string[]>();
    batch.forEach(({ userId, permission }) => {
      if (!byUser.has(userId)) {
        byUser.set(userId, []);
      }
      byUser.get(userId)!.push(permission);
    });

    // Process each user's permissions
    for (const [userId, permissions] of byUser) {
      const results = await this.checkUserPermissions(userId, permissions);

      // Resolve promises
      results.forEach((hasPermission, permission) => {
        const key = `${userId}:${permission}`;
        const promise = this.pending.get(key);
        if (promise) {
          (promise as any).resolve(hasPermission);
          this.pending.delete(key);
        }
      });
    }
  }

  private async checkUserPermissions(
    userId: string,
    permissions: string[]
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const permission of permissions) {
      const hasPermission = await this.permService.hasPermission(
        userId,
        permission
      );
      results.set(permission, hasPermission);
    }

    return results;
  }
}
```

## Best Practices

### 1. Permission Naming Conventions
```
Format: <resource>:<action>:<scope>

Resources: Plural, lowercase (users, content, settings)
Actions: Verb, lowercase (create, read, update, delete, manage)
Scopes: Ownership level (own, team, org, all)

Examples:
- users:read:all
- content:update:own
- settings:manage:all
```

### 2. Error Messages
```typescript
// Good: Specific and actionable
{
  "error": "Permission denied",
  "message": "You need 'content:publish:all' permission to publish other users' content",
  "required": "content:publish:all",
  "help": "Contact an administrator to request this permission"
}

// Bad: Generic
{
  "error": "Forbidden"
}
```

### 3. Audit Logging
```typescript
// Always log permission denials with context
await auditService.log({
  eventType: 'permission.denied',
  userId,
  metadata: {
    permission: requiredPermission,
    resource: resourceId,
    action: attemptedAction,
    path: request.path,
    method: request.method
  },
  severity: 'warning',
  success: false
});
```

### 4. Cache Management
```typescript
// Invalidate cache on permission changes
async function onPermissionChange(userId: string) {
  // Clear user's permission cache
  await permissionCache.invalidate(userId);

  // Invalidate related sessions
  await sessionManager.invalidateUserSessions(userId);

  // Notify other services
  await eventBus.emit('permission.changed', { userId });
}
```

### 5. Testing Permissions
```typescript
// Test both positive and negative cases
describe('Permission checks', () => {
  test('Grants access with correct permission', () => {
    // Test success case
  });

  test('Denies access without permission', () => {
    // Test failure case
  });

  test('Handles edge cases', () => {
    // Test null user, invalid permission format, etc.
  });
});
```

## Common Anti-Patterns to Avoid

### 1. ❌ Checking Roles Instead of Permissions
```typescript
// Bad: Checking role directly
if (user.role === 'admin') {
  // Allow action
}

// Good: Check specific permission
if (await hasPermission(userId, 'users:delete:all')) {
  // Allow action
}
```

### 2. ❌ Client-Side Only Checks
```typescript
// Bad: Only checking on frontend
if (userPermissions.includes('admin')) {
  showDeleteButton();
}

// Good: Always verify on backend too
const response = await fetch('/api/users/delete', {
  method: 'DELETE',
  // Server will verify permissions
});
```

### 3. ❌ Overly Broad Permissions
```typescript
// Bad: Too broad
grantPermission(userId, '*:*:*'); // Super admin for regular admin

// Good: Specific permissions
grantPermission(userId, 'users:manage:all');
grantPermission(userId, 'content:manage:all');
```

### 4. ❌ Missing Audit Logs
```typescript
// Bad: No logging
if (!hasPermission) {
  return false;
}

// Good: Log security events
if (!hasPermission) {
  await logSecurityEvent('permission.denied', { userId, permission });
  return false;
}
```

### 5. ❌ Synchronous Permission Checks in Loops
```typescript
// Bad: Sequential checks
for (const item of items) {
  if (await hasPermission(userId, `item:read:${item.id}`)) {
    results.push(item);
  }
}

// Good: Parallel checks
const checks = await Promise.all(
  items.map(item => hasPermission(userId, `item:read:${item.id}`))
);
const results = items.filter((item, i) => checks[i]);
```

## Conclusion

These patterns provide a robust foundation for implementing permission checks throughout the application. Key principles to remember:

1. **Always verify on the backend** - Never trust client-side permission checks alone
2. **Use specific permissions** - Avoid overly broad permissions
3. **Log security events** - Maintain audit trail for compliance
4. **Cache strategically** - Balance performance with consistency
5. **Handle errors gracefully** - Provide helpful error messages
6. **Test thoroughly** - Cover positive, negative, and edge cases

By following these patterns, the RBAC system will be secure, performant, and maintainable.