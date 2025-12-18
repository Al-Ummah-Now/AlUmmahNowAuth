# Plan: M2M Auth & Admin Management APIs

## Overview
Transition admin app from direct D1 access to using Auth Server APIs with M2M (Machine-to-Machine) authentication.

## Current State

### Auth Server APIs (Already Exist)
| Resource | Endpoint | Status |
|----------|----------|--------|
| Roles | `/admin/roles/*` | ✅ Complete (admin-rbac-routes.ts) |
| Clients | `/admin/clients/*` | ✅ Complete (admin-enterprise-routes.ts) |
| Audit | `/admin/audit-logs/*` | ✅ Complete |
| Token Mgmt | `/admin/users/:id/tokens` | ✅ Complete |
| **Users** | `/admin/users/*` | ❌ Missing |

### Admin App Data Access
| Page | Current Method | Target |
|------|----------------|--------|
| users._index.tsx | Direct D1 | API via M2M |
| roles._index.tsx | Hybrid (API + D1) | API via M2M |
| roles.$id.tsx | Hybrid (API + D1) | API via M2M |
| clients.tsx | Direct D1 | API via M2M |
| audit.tsx | API calls | API via M2M |

### Current Auth Flow
- Session cookies forwarded from user browser to auth server
- `verifyAdminAuth` validates session + admin role

---

## Implementation Plan

### Phase 1: Create User Management API in Auth Server

**New file:** `apps/auth/src/admin-user-routes.ts`

**Endpoints:**
```
GET    /admin/users           - List all users with pagination
GET    /admin/users/:id       - Get user details + roles
POST   /admin/users           - Create user (admin-initiated)
PUT    /admin/users/:id       - Update user (email, etc.)
DELETE /admin/users/:id       - Delete user
POST   /admin/users/:id/roles - Assign role to user
DELETE /admin/users/:id/roles/:roleId - Remove role from user
```

**Features:**
- Input validation with Valibot
- Rate limiting
- Audit event emission
- Same auth pattern as existing admin routes

---

### Phase 2: M2M Authentication Infrastructure

#### 2.1 Create Admin Dashboard OAuth Client
Register `admin-dashboard` as a **confidential** client with `client_credentials` grant:

```sql
INSERT INTO oauth_clients (client_id, client_secret_hash, client_type, allowed_grants, ...)
VALUES ('admin-dashboard-m2m', '<hash>', 'confidential', '["client_credentials"]', ...);
```

#### 2.2 Implement Client Credentials Grant in Auth Server
**Endpoint:** `POST /token`

Check if OpenAuth fork already supports `client_credentials`. If not, add handler:
```typescript
// In token endpoint
if (grant_type === 'client_credentials') {
  // Validate client_id + client_secret
  // Issue access token with scopes
  // No refresh token for M2M
}
```

#### 2.3 M2M Token Format
```json
{
  "iss": "https://auth.alummahnow.net",
  "sub": "admin-dashboard-m2m",
  "aud": "admin-api",
  "scope": "admin:users admin:roles admin:clients",
  "exp": 3600
}
```

#### 2.4 New Auth Middleware: `verifyM2MAuth`
```typescript
// apps/auth/src/middleware/m2m-auth.ts
export async function verifyM2MAuth(
  request: Request,
  env: Env,
  requiredScope?: string
): Promise<{ clientId: string; scopes: string[] }>
```

Validates:
- Bearer token in Authorization header
- Token signature and expiry
- Required scope (if specified)

---

### Phase 3: Update Admin Routes to Support Both Auth Methods

Modify admin routes to accept EITHER:
1. Session cookie (user auth) - existing behavior
2. Bearer token (M2M auth) - new behavior

```typescript
// Combined auth verification
async function verifyAdminRequest(request: Request, env: Env) {
  const authHeader = request.headers.get('Authorization');

  if (authHeader?.startsWith('Bearer ')) {
    // M2M auth
    return verifyM2MAuth(request, env, 'admin:users');
  } else {
    // Session auth (existing)
    return verifyAdminAuth(request, env);
  }
}
```

---

### Phase 4: Create API Client Library for Admin App

**New file:** `apps/admin/app/lib/admin-api.server.ts`

```typescript
// M2M token management
class AdminApiClient {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  async getAccessToken(env: Env): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await fetch(`${authServerUrl}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.ADMIN_CLIENT_ID,
        client_secret: env.ADMIN_CLIENT_SECRET,
        scope: 'admin:users admin:roles admin:clients'
      })
    });

    const { access_token, expires_in } = await response.json();
    this.accessToken = access_token;
    this.tokenExpiry = Date.now() + (expires_in - 60) * 1000;
    return access_token;
  }

  // User APIs
  async listUsers(env: Env, params?: { page?: number; limit?: number }) { ... }
  async getUser(env: Env, userId: string) { ... }
  async createUser(env: Env, data: CreateUserData) { ... }
  async updateUser(env: Env, userId: string, data: UpdateUserData) { ... }
  async deleteUser(env: Env, userId: string) { ... }

  // Role APIs
  async listRoles(env: Env) { ... }
  // ... existing role methods migrated from rbac-api.server.ts

  // Client APIs
  async listClients(env: Env) { ... }
  // ...
}

export const adminApi = new AdminApiClient();
```

---

### Phase 5: Update Admin App Routes

#### 5.1 users._index.tsx
```typescript
// Before
const usersResult = await env.AUTH_DB.prepare(`SELECT ...`).all();

// After
const users = await adminApi.listUsers(env, { page, limit });
```

#### 5.2 roles._index.tsx / roles.$id.tsx
```typescript
// Migrate remaining D1 queries to API calls
const roles = await adminApi.listRoles(env);
const roleDetails = await adminApi.getRole(env, roleId);
```

#### 5.3 clients.tsx
```typescript
// Before
const result = await env.AUTH_DB.prepare(`SELECT ... FROM oauth_clients`).all();

// After
const clients = await adminApi.listClients(env);
```

---

### Phase 6: Environment Configuration

#### Admin App Secrets
```bash
# apps/admin/.dev.vars
ADMIN_CLIENT_ID=admin-dashboard-m2m
ADMIN_CLIENT_SECRET=<generated-secret>
```

#### Wrangler Config
```json
// apps/admin/wrangler.json
{
  "vars": {
    "ADMIN_CLIENT_ID": "admin-dashboard-m2m"
  },
  "secrets_store_secrets": [
    {
      "binding": "ADMIN_CLIENT_SECRET",
      "store_id": "...",
      "secret_name": "ADMIN_CLIENT_SECRET"
    }
  ]
}
```

---

## File Changes Summary

### New Files
| File | Description |
|------|-------------|
| `apps/auth/src/admin-user-routes.ts` | User CRUD API endpoints |
| `apps/auth/src/middleware/m2m-auth.ts` | M2M token verification |
| `apps/admin/app/lib/admin-api.server.ts` | Unified API client with M2M |

### Modified Files
| File | Changes |
|------|---------|
| `apps/auth/src/index.ts` | Register new user routes, token endpoint for client_credentials |
| `apps/auth/src/auth-middleware.ts` | Add combined auth verification |
| `apps/admin/app/routes/users._index.tsx` | Replace D1 queries with API calls |
| `apps/admin/app/routes/roles._index.tsx` | Replace D1 queries with API calls |
| `apps/admin/app/routes/roles.$id.tsx` | Replace D1 queries with API calls |
| `apps/admin/app/routes/clients.tsx` | Replace D1 queries with API calls |
| `apps/admin/wrangler.json` | Add M2M client credentials |

### Database Changes
- Create `admin-dashboard-m2m` OAuth client with `client_credentials` grant

---

## Implementation Order

1. **Phase 1** - User API (2-3 hours)
   - Create admin-user-routes.ts
   - Add to index.ts routing

2. **Phase 2** - M2M Infrastructure (3-4 hours)
   - Add client_credentials grant support
   - Create M2M auth middleware
   - Register M2M client in DB

3. **Phase 3** - Update Admin Routes (1 hour)
   - Add combined auth to existing routes

4. **Phase 4** - API Client Library (2 hours)
   - Create admin-api.server.ts
   - Token caching logic

5. **Phase 5** - Migrate Admin App (3-4 hours)
   - Update each route file
   - Test thoroughly

6. **Phase 6** - Configuration (1 hour)
   - Set up secrets
   - Update wrangler configs

**Total Estimate:** 12-16 hours

---

## Security Considerations

1. **M2M Client Secret** must be stored in Cloudflare Secrets Store (not in code)
2. **Scopes** limit what M2M tokens can do (e.g., `admin:users:read` vs `admin:users:write`)
3. **Token Expiry** should be short (1 hour) since M2M can easily refresh
4. **Rate Limiting** applies equally to M2M requests
5. **Audit Logging** records M2M client_id as actor instead of user_id

---

## Rollback Plan

1. Keep session-based auth working alongside M2M
2. Feature flag to switch between D1 and API access
3. Can revert admin app changes without touching auth server
