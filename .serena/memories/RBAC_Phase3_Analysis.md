# RBAC Migration Phase 3 Analysis

## Analysis Date
December 14, 2025

## OpenAuth RBAC Endpoints Overview

### rbacEndpoints() - User Permission Checking API
**Mount path**: `/rbac` (or custom path via route mounting)

**Endpoints provided**:
1. `POST /check` - Check single permission
   - Required: userId, permission, appId, tenantId (from middleware context)
   - Returns: { hasPermission: boolean }

2. `POST /check/batch` - Check multiple permissions  
   - Required: userId, permissions[], appId, tenantId
   - Returns: { permissions: { [name]: boolean }, hasAll, hasAny }

3. `GET /permissions` - Get user's effective permissions for app
   - Required: userId, appId, tenantId (from context)
   - Returns: Array of permission strings

4. `GET /roles` - Get user's roles
   - Required: userId, appId, tenantId
   - Returns: Array of roles with details

**Context requirements**: Variables { userId, tenantId, appId? }

---

### rbacAdminEndpoints() - Admin Management API
**Mount path**: `/rbac/admin` (or custom path)

**Endpoints provided**:
1. **App Management**:
   - `POST /apps` - Create app
   - `GET /apps` - List apps

2. **Role Management**:
   - `POST /roles` - Create role
   - `GET /roles` - List roles
   - (Individual role CRUD not explicitly documented in type definitions)

3. **Permission Management**:
   - `POST /permissions` - Create permission
   - `GET /permissions?appId=...` - List permissions

4. **User Role Assignment**:
   - `POST /users/:userId/roles` - Assign role to user
   - `DELETE /users/:userId/roles/:roleId` - Remove role from user

5. **Role Permission Assignment**:
   - `POST /roles/:roleId/permissions` - Assign permission to role
   - `DELETE /roles/:roleId/permissions/:permissionId` - Remove permission from role

**Context requirements**: Variables { adminId, tenantId, isAdmin: boolean }

---

## Current Implementation Analysis

### User-Facing RBAC Routes (src/rbac-routes.ts)
- **Paths**: `/api/users/:id/roles`, `/api/users/:id/permissions`, `/api/permissions/*`
- **Endpoints**: 6 endpoints (get roles, assign, remove, get permissions, check, bulk-check, list)
- **Custom features**:
  - Privilege escalation prevention (verifyGranterPermission)
  - Audit logging (emitAuditEvent)
  - Rate limiting
  - Input validation (Valibot)
  - Permission caching

### Admin RBAC Routes (src/admin-rbac-routes.ts)
- **Paths**: `/admin/roles`, `/admin/roles/:id`, `/admin/roles/:id/permissions`
- **Endpoints**: 8 endpoints (CRUD roles, grant/revoke permissions)
- **Custom features**:
  - Admin authentication (verifyAdminAuth)
  - Rate limiting
  - Privilege escalation checks
  - Audit logging
  - Comprehensive error handling

### Role Service (src/role-service.ts)
- **Responsibilities**:
  - Role CRUD operations
  - System role protection
  - Role-permission associations
  - User role assignments
  - Permission grant validation
- **Custom security features**:
  - `canGrantPermissions()` - Validates granter has all permissions being granted
  - `isSystemRole()` - Prevents modification of system roles
  - Privilege escalation prevention throughout

### Permission Service (src/permission-service.ts)
- **Responsibilities**:
  - Permission CRUD
  - User permission checking
  - Effective permission computation (roles + direct grants/denies)
  - Caching with atomic invalidation
  - Bulk permission checks
- **Custom features**:
  - Versioned caching for atomic invalidation
  - Direct permission grants/denies separate from roles
  - Permission pattern matching with wildcards

### Current Route Mounting (src/index.ts, lines 464-702)
```typescript
// Line 448-449: Initialize custom RBAC handlers
const adminRBACRoutes = new AdminRBACRoutes(env.AUTH_DB, env.AUTH_STORAGE);
const rbacRoutes = new RBACRoutes(env.AUTH_DB, env.AUTH_STORAGE);

// Lines 465-469: Admin RBAC routes at /admin/roles
if (url.pathname.startsWith('/admin/roles')) {
  const response = await adminRBACRoutes.handle(request, env, ctx);
  if (response.status !== 404) return addSecurityHeaders(response, isProduction);
}

// Lines 698-702: User-facing RBAC routes at /api/users/... and /api/permissions
if (url.pathname.startsWith('/api/users/') || url.pathname.startsWith('/api/permissions')) {
  const response = await rbacRoutes.handle(request, env, ctx);
  if (response.status !== 404) return addSecurityHeaders(response, isProduction);
}
```

---

## Path Mapping Strategy

### Current vs. OpenAuth Paths

| Current Path | Mapped OpenAuth Path | Handling | Priority |
|--------------|----------------------|----------|----------|
| `/admin/roles` (GET) | `/admin/rbac/roles` | Direct route | High |
| `/admin/roles` (POST) | `/admin/rbac/roles` | Direct route | High |
| `/admin/roles/:id` (GET) | `/admin/rbac/roles/:id` | Direct route | High |
| `/admin/roles/:id` (PUT) | `/admin/rbac/roles/:id` (PATCH) | Method rewrite | High |
| `/admin/roles/:id` (DELETE) | `/admin/rbac/roles/:id` | Direct route | High |
| `/admin/roles/:id/permissions` | `/admin/rbac/roles/:id/permissions` | Direct route | Medium |
| `/api/users/:id/roles` | Keep custom | Custom routing | High |
| `/api/users/:id/permissions` | Keep custom | Custom routing | High |
| `/api/permissions/check` | `/rbac/check` | Rewrite path | Medium |
| `/api/permissions/bulk-check` | `/rbac/check/batch` | Rewrite path | Medium |
| `/api/permissions` | `/rbac/permissions` | Rewrite path | Medium |

---

## Features to Preserve

### 1. Audit System
- **Files**: `audit-emitter.ts`, `audit-emitter-enhanced.ts`, `audit-events.ts`
- **Impact**: Every role/permission change logs to D1 audit table
- **Action**: Keep ALL audit functions; wrap OpenAuth endpoints with custom audit middleware

### 2. Privilege Escalation Prevention
- **Function**: `verifyGranterPermission()` in `auth-middleware.ts`
- **Purpose**: Ensure users can only grant permissions they possess
- **Status**: OpenAuth may have similar checks, but custom middleware wrapper recommended
- **Action**: Create wrapper middleware around rbacAdminEndpoints()

### 3. Cache Invalidation
- **Function**: Versioned caching in PermissionService with atomic invalidation
- **Status**: OpenAuth has native caching (60s TTL per documentation)
- **Conflict**: Custom cache invalidation on every change vs. OpenAuth's TTL-based
- **Action**: Can remove custom service once OpenAuth endpoints validate cache consistency

### 4. Input Validation
- **Library**: Valibot for schema validation
- **Status**: OpenAuth endpoints likely have their own validation
- **Action**: Keep Valibot for request validation if OpenAuth doesn't match our schema

### 5. Rate Limiting
- **Implemented**: Per-endpoint rate limits (20 requests/hour for role assignment, etc.)
- **Status**: Different from general auth rate limiting
- **Action**: Keep rate limiting wrapper around OpenAuth endpoints

---

## Implementation Plan for Phase 3

### Step 1: Create Admin Context & Method Compat Middleware
**File**: `src/custom/admin-context-middleware.ts`

```typescript
import { Context, Next } from 'hono';

/**
 * Middleware to set tenant and admin context for OpenAuth routes
 * Required by rbacAdminEndpoints()
 */
export async function adminContextMiddleware(c: Context, next: Next) {
  // Set admin context variables required by rbacAdminEndpoints
  const adminId = c.req.header('X-Admin-Id') || 'default-admin';
  c.set('adminId', adminId);
  c.set('tenantId', 'default');
  c.set('isAdmin', true);
  
  await next();
}

/**
 * Middleware to translate PUT to PATCH for OpenAuth compatibility
 * OpenAuth expects PATCH for resource updates
 */
export async function methodCompatMiddleware(c: Context, next: Next) {
  if (c.req.method === 'PUT') {
    // Intercept and change method to PATCH
    const originalMethod = c.req.method;
    Object.defineProperty(c.req, 'method', { 
      value: 'PATCH',
      configurable: true 
    });
  }
  await next();
}
```

### Step 2: Create RBAC Context Middleware for User Endpoints
**File**: `src/custom/rbac-context-middleware.ts`

```typescript
/**
 * Middleware to set RBAC context for user-facing endpoints
 * Required by rbacEndpoints()
 */
export async function rbacContextMiddleware(c: Context, next: Next) {
  // Extract user context from auth
  const userId = c.req.header('X-User-Id') || '';
  
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  c.set('userId', userId);
  c.set('tenantId', 'default');
  c.set('appId', c.req.header('X-App-Id'));
  
  await next();
}
```

### Step 3: Create Audit Wrapper Middleware
**File**: `src/custom/rbac-audit-middleware.ts`

Wraps OpenAuth RBAC endpoints to:
1. Log all role/permission changes
2. Track privilege escalation attempts
3. Emit AuditEventType.ROLE_CREATED, ROLE_UPDATED, ROLE_DELETED, etc.
4. Include custom security alerts for suspicious operations

### Step 4: Mount OpenAuth RBAC Endpoints in index.ts

**Key sections to update**:

```typescript
import { 
  rbacEndpoints, 
  rbacAdminEndpoints,
  RBACAdapter,
  RBACServiceImpl,
} from "@al-ummah-now/openauth/rbac/index";

// Initialize RBAC service (line ~1157)
const rbacAdapter = new RBACAdapter(env.AUTH_DB);
const rbacService = new RBACServiceImpl(rbacAdapter, storage, {
  maxPermissionsInToken: 50,
  permissionCacheTTL: 60,
});

// Create admin RBAC app (new)
const adminRbacApp = new Hono();
adminRbacApp.use('*', adminContextMiddleware);
adminRbacApp.use('*', methodCompatMiddleware);
adminRbacApp.use('*', rbacAuditMiddleware); // Custom audit logging
adminRbacApp.route('/roles', rbacAdminEndpoints(rbacService));

// Create user RBAC app (new)
const rbacUserApp = new Hono();
rbacUserApp.use('*', rbacContextMiddleware);
rbacUserApp.route('/check', rbacEndpoints(rbacService)); // POST /check, /check/batch
rbacUserApp.route('', rbacEndpoints(rbacService)); // GET /permissions, /roles

// Route handling in fetch()
// Lines 465-470: Replace /admin/roles handling
if (url.pathname.startsWith('/admin/roles')) {
  // Rewrite /admin/roles -> /roles
  const rewrittenPath = url.pathname.replace('/admin/roles', '/roles') || '/';
  const rewrittenUrl = new URL(request.url);
  rewrittenUrl.pathname = rewrittenPath;
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const response = await adminRbacApp.fetch(rewrittenRequest, env, ctx);
  if (response.status !== 404) {
    return addSecurityHeaders(response, isProduction);
  }
}

// Lines 698-702: Replace /api/permissions handling
if (url.pathname.startsWith('/api/permissions') || 
    url.pathname.startsWith('/api/users/') && url.pathname.endsWith('/permissions')) {
  
  // Map paths to OpenAuth format
  let rewritePath = '';
  if (url.pathname === '/api/permissions/check') {
    rewritePath = '/check';
  } else if (url.pathname === '/api/permissions/bulk-check') {
    rewritePath = '/check/batch'; // OpenAuth batches at /check/batch
  } else if (url.pathname === '/api/permissions') {
    rewritePath = '/permissions';
  } else if (url.pathname.match(/^\/api\/users\/[^/]+\/permissions$/)) {
    // Extract userId and rewrite to /permissions (OpenAuth gets userId from context)
    rewritePath = '/permissions';
  }
  
  const rewrittenUrl = new URL(request.url);
  rewrittenUrl.pathname = rewritePath;
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  
  const response = await rbacUserApp.fetch(rewrittenRequest, env, ctx);
  if (response.status !== 404) {
    return addSecurityHeaders(response, isProduction);
  }
}
```

### Step 5: Delete Custom RBAC Services
- `src/role-service.ts` (600 LOC)
- `src/role-service.test.ts` (350 LOC)
- `src/permission-service.ts` (580 LOC)
- `src/permission-service.test.ts` (350 LOC)
- `src/rbac-routes.ts` (675 LOC)
- `src/admin-rbac-routes.ts` (639 LOC)
- `src/rbac-types.ts` (160 LOC) - Use OpenAuth types instead

**Total LOC removed**: ~3,350 lines

### Step 6: Handle User Role Routes (Custom Feature)
Keep `src/custom/user-role-routes.ts` since it provides:
- `GET /admin/users/:id/roles` - with custom caching
- `POST /admin/users/:id/roles` - with audit logging
- `DELETE /admin/users/:id/roles/:roleId` - with audit logging

These are separate from the admin RBAC endpoints and provide app-specific customizations.

---

## Compatibility Considerations

### 1. Database Schema Alignment
- **OpenAuth uses**: `rbac_roles`, `rbac_permissions`, `rbac_role_permissions`, `rbac_user_roles`
- **Current custom uses**: Same tables (compatible!)
- **Field name differences**:
  - OpenAuth: `is_system_role` (boolean)
  - Current: `is_system` (boolean) - need migration or adapter

### 2. Response Format Changes
- **Current**: Custom JSON response formats
- **OpenAuth**: Standardized formats per documentation
- **Action**: Update callers or create response adapters

### 3. Error Handling
- **Current**: `createAuthErrorResponse()` utility
- **OpenAuth**: Native error handling
- **Action**: May need wrapper for custom error responses

### 4. Authentication Context
- **Current**: Extracts from request headers and session
- **OpenAuth**: Expects userId/adminId/tenantId in context (Hono variables)
- **Action**: Middleware must populate context correctly

---

## Testing Strategy

### Unit Tests
- Keep existing tests for custom features
- Replace RBAC service tests with integration tests against OpenAuth endpoints

### Integration Tests
- Test path rewrites work correctly
- Test audit logging captures all operations
- Test privilege escalation prevention still works
- Test rate limiting still enforces limits
- Test response formats match client expectations

### E2E Tests
- Update admin app tests to use `/admin/rbac/` paths
- Test PATCH method for updates (PUT compatibility)
- Test permission checking endpoints
- Test batch permission checks

---

## Rollback Plan

If OpenAuth RBAC integration fails:

1. **Quick rollback**: Git revert to pre-phase-3
2. **Dual-path approach**: Keep both old and new endpoints, toggle via feature flag
3. **Adapter layer**: Create response adapters to maintain backward compatibility
4. **Phased migration**: Keep custom services as fallback until OpenAuth fully validated

---

## Success Metrics

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| RBAC service LOC | 1,880 | 0 | 0 |
| Custom endpoints | 2 apps | 1 app (wrapper) | 1 |
| Maintenance burden | High | Low | Low |
| Code duplication | ~3,350 LOC | 0 | 0 |

