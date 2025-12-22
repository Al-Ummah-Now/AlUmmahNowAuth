# Refactor Plan: Remove Duplicate Admin APIs

## Current State

The auth app has **duplicate admin APIs**:

1. **Custom `AdminEnterpriseRoutes`** (in `admin-enterprise-routes.ts`):
   - `/admin/clients/*` - Client management
   - `/admin/audit-logs/*` - Audit log viewing
   - `/admin/users/tokens/*` - Token management
   - `/admin/health`, `/admin/metrics` - Health checks

2. **OpenAuth's Built-in Routes** (already partially used):
   - `userApiRoutes` - Mounted at `/admin/users`
   - `rbacAdminEndpoints` - Mounted at `/admin/roles`

3. **OpenAuth's `createEnterpriseAdminRoutes`** (NOT currently used):
   - Provides unified `/users`, `/clients`, `/rbac`, `/sessions`, `/tenants`, `/providers`
   - All modules use `ClientService` properly

## Goal

Replace custom client management with OpenAuth's `clientAdminRoutes` to eliminate duplication and ensure consistent data (scopes, metadata, enabled fields).

## Analysis: Route Differences

### Client Routes
| Admin App Calls | Custom Routes | OpenAuth Routes |
|-----------------|---------------|-----------------|
| GET `/admin/clients` | GET `/admin/clients` | GET `/clients` |
| POST `/admin/clients` | POST `/admin/clients` | POST `/clients` |
| GET `/admin/clients/:id` | GET `/admin/clients/:id` | GET `/clients/:clientId` |
| PUT `/admin/clients/:id` | PUT `/admin/clients/:id` | **PATCH** `/clients/:clientId` |
| DELETE `/admin/clients/:id` | DELETE `/admin/clients/:id` | DELETE `/clients/:clientId` |
| POST `/admin/clients/:id/rotate-secret` | POST `.../rotate-secret` | POST `.../rotate` |

**Key differences:**
- OpenAuth uses PATCH not PUT for updates
- OpenAuth uses `/rotate` not `/rotate-secret`

### User Routes (already using OpenAuth)
- Already delegating to `userApiRoutes` via `adminUserApp`

### RBAC Routes (already using OpenAuth)
- Already delegating to `rbacAdminEndpoints` via `adminRbacApp`

## Refactor Approach

### Option A: Use `createEnterpriseAdminRoutes` (Recommended)

Replace all separate route handlers with a single `createEnterpriseAdminRoutes` call:

```typescript
import { createEnterpriseAdminRoutes } from '@al-ummah-now/openauth';

const { app: adminApp } = createEnterpriseAdminRoutes({
  database: env.AUTH_DB,
  storage: kvStorage,
  tenantService,
  sessionService,
  rbacService,
  middleware: [adminAuthMiddleware], // Custom auth
  modules: {
    users: true,
    clients: true,
    rbac: true,
    sessions: true,
    tenants: false,    // We have custom tenant routes
    providers: false,  // Not needed
  },
});

// Mount at /admin
mainApp.route('/admin', adminApp);
```

**Pros:**
- Single source of truth
- Automatically uses `ClientService` with all fields
- Less code to maintain
- Consistent behavior with OpenAuth updates

**Cons:**
- Need to update admin app for path/method differences
- May lose some custom audit logging (can add via middleware)

### Option B: Keep Hybrid but Fix Client Routes

Keep current structure but replace only client routes with OpenAuth's:

```typescript
import { clientAdminRoutes } from '@al-ummah-now/openauth/client/api';

const clientApp = clientAdminRoutes(clientService);
clientApp.use('*', adminContextMiddleware); // Add our auth
mainApp.route('/admin/clients', clientApp);
```

**Pros:**
- Minimal changes
- Keep existing patterns

**Cons:**
- Still need path rewrites
- Still maintaining multiple patterns

## Recommended Plan: Option A

### Phase 1: Prepare (No Breaking Changes)

1. **Create adapter middleware** for auth:
   ```typescript
   // Converts our auth context to what OpenAuth expects
   const enterpriseAuthMiddleware = async (c, next) => {
     const authContext = await verifyAdminRequest(c.req.raw, env, 'admin:*');
     c.set('tenantId', 'default');
     c.set('adminId', authContext.userId);
     c.set('isAdmin', true);
     await next();
   };
   ```

2. **Create backward-compatible wrapper** for client responses:
   - Add `client_id` alias for `id`
   - Add `allowed_grants` alias for `grant_types`

### Phase 2: Replace Client Routes

1. Remove client routes from `AdminEnterpriseRoutes`:
   - `listClients`
   - `createClient`
   - `getClient`
   - `updateClient`
   - `deleteClient`
   - `rotateClientSecret`

2. Use OpenAuth's `clientAdminRoutes`:
   ```typescript
   import { clientAdminRoutes, ClientService } from '@al-ummah-now/openauth';

   const clientService = new ClientService(env.AUTH_DB);
   const clientApp = new Hono();
   clientApp.use('*', enterpriseAuthMiddleware);
   clientApp.route('/', clientAdminRoutes(clientService));

   // Mount with path rewrite
   mainApp.route('/admin/clients', clientApp);
   ```

3. Update router.ts to delegate to new clientApp

### Phase 3: Update Admin App

1. **Update `admin-api.server.ts`**:
   - Change `PUT` to `PATCH` for `updateClient`
   - Change `/rotate-secret` to `/rotate`

2. **Update `OAuthClient` interface** to match OpenAuth's response:
   - Uses `grant_types` not `allowed_grants`
   - Includes all fields natively

### Phase 4: Cleanup

1. Remove deprecated methods from `AdminEnterpriseRoutes`
2. Update tests
3. Verify all admin app pages work

## Files to Modify

### Auth App
- `src/index.ts` - Add clientApp setup
- `src/router.ts` - Update client route handling
- `src/admin-enterprise-routes.ts` - Remove client methods
- `src/custom/admin-context-middleware.ts` - Create enterprise adapter

### Admin App
- `app/lib/admin-api.server.ts`:
  - Change `updateClient` to use PATCH
  - Change rotate endpoint path
  - Update types

## Testing Checklist

- [ ] List clients shows scopes/metadata
- [ ] Create client with scopes works
- [ ] Edit client scopes/metadata works
- [ ] Rotate secret works
- [ ] Delete client works
- [ ] All other admin pages still work

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing clients | Add backward-compat response wrapper |
| Auth not working | Test middleware thoroughly |
| Missing audit events | Add audit logging to middleware |

## Estimated Effort

- Phase 1: 1-2 hours
- Phase 2: 2-3 hours
- Phase 3: 1 hour
- Phase 4: 1 hour
- Testing: 1-2 hours

**Total: ~6-9 hours**
