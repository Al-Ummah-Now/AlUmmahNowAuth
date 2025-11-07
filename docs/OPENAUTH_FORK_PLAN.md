# Fork OpenAuth to Add Enterprise Features

**Date**: 2025-10-25
**Status**: PLANNING
**Estimated Effort**: 16-25 hours

---

## Current Architecture Analysis

**What Works:**
- OpenAuth handles OAuth 2.0 authorization flow (authorization_code grant)
- User authentication with password provider
- Session management in KV
- Basic token generation

**What's Missing (Why TokenRoutes Exists):**
1. **Confidential client authentication** (client_secret with PBKDF2)
2. **D1 database integration** for audit logging and analytics
3. **Token introspection endpoint** (RFC 7662)
4. **Token revocation endpoint** (RFC 7009)
5. **Comprehensive audit trail** (token_usage table)
6. **Token analytics** (rotation counts, usage patterns)

## Fork Strategy: Extend OpenAuth Core

### 1. Create Storage Adapter for D1 Database

**File to Create:** `packages/openauth/src/storage/d1.ts`

**Purpose:**
- Store refresh tokens in D1 instead of KV
- Enable relational queries for audit logs
- Support token family tracking (Issue #77)

**Implementation:**
```typescript
interface D1StorageAdapter {
  // Implement OpenAuth StorageAdapter interface
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  remove(key: string): Promise<void>;

  // D1-specific extensions
  storeRefreshToken(token: RefreshTokenRecord): Promise<void>;
  revokeTokenFamily(familyId: string): Promise<void>;
  logTokenUsage(event: TokenUsageEvent): Promise<void>;
}
```

**Database Schema:** Use existing D1 tables from migration 0016
- `refresh_tokens` table
- `token_usage` table
- `jwt_keys` table

### 2. Add Confidential Client Authentication

**File to Modify:** `packages/openauth/src/issuer.ts`

**Add Configuration:**
```typescript
issuer({
  // Existing config
  storage: D1Storage({ database: env.AUTH_DB }),

  // NEW: Client authentication
  clients: {
    adapter: D1ClientAdapter({ database: env.AUTH_DB }),
    authenticator: async (clientId, clientSecret) => {
      // PBKDF2 validation (from your client-auth-service.ts)
      return await validateClient(clientId, clientSecret);
    }
  }
})
```

**Files to Create:**
- `packages/openauth/src/client/d1-adapter.ts`
- `packages/openauth/src/client/authenticator.ts`

**Database Schema:** Use existing `oauth_clients` table from migration 0015

### 3. Add Token Introspection Endpoint (RFC 7662)

**File to Modify:** `packages/openauth/src/issuer.ts`

**Add Route:**
```typescript
// POST /token/introspect
app.post('/token/introspect', async (c) => {
  const { token, token_type_hint } = await c.req.formData();

  // Validate token (access or refresh)
  const result = await introspectToken(token, token_type_hint);

  return c.json(result); // RFC 7662 compliant response
});
```

**Reuse Logic:** Port from your `token-routes.ts:274-334`

### 4. Add Token Revocation Endpoint (RFC 7009)

**File to Modify:** `packages/openauth/src/issuer.ts`

**Add Route:**
```typescript
// POST /token/revoke
app.post('/token/revoke', async (c) => {
  const { token, token_type_hint } = await c.req.formData();

  await revokeToken(token, token_type_hint);

  return c.text('', 200); // RFC 7009: always 200
});
```

**Reuse Logic:** Port from your `token-routes.ts:336-389`

### 5. Enhance Token Service with Audit Logging

**File to Modify:** `packages/openauth/src/token.ts`

**Add Hooks:**
```typescript
interface TokenHooks {
  onTokenGenerated?: (event: TokenEvent) => Promise<void>;
  onTokenRefreshed?: (event: TokenEvent) => Promise<void>;
  onTokenRevoked?: (event: TokenEvent) => Promise<void>;
  onTokenReused?: (event: TokenEvent) => Promise<void>;
}
```

**Integration:**
```typescript
issuer({
  hooks: {
    onTokenRefreshed: async (event) => {
      // Log to D1 token_usage table
      await logTokenUsage(event);
    }
  }
})
```

### 6. Add CORS Configuration (Fix Issue #79)

**File to Modify:** `packages/openauth/src/issuer.ts`

**Current:** OpenAuth may use wildcard CORS
**Fix:** Environment-based origin whitelisting

```typescript
issuer({
  cors: {
    origins: env.ALLOWED_ORIGINS.split(','),
    credentials: true
  }
})
```

## Modified OpenAuth Architecture

```
OpenAuth Fork (Extended)
├── Core OAuth 2.0 (unchanged)
│   ├── /authorize endpoint
│   ├── Authorization code generation
│   └── Password provider
│
├── Enhanced Token Endpoints
│   ├── POST /token (authorization_code + refresh_token)
│   ├── POST /token/introspect (RFC 7662) ← NEW
│   └── POST /token/revoke (RFC 7009) ← NEW
│
├── Storage Layer
│   ├── KV Storage (sessions, auth codes)
│   └── D1 Storage ← NEW
│       ├── refresh_tokens table
│       ├── token_usage table (audit)
│       ├── oauth_clients table
│       └── jwt_keys table
│
├── Client Authentication ← NEW
│   ├── PKCE (public clients) - existing
│   └── client_secret (confidential) ← NEW
│
└── Audit & Analytics ← NEW
    ├── Token usage logging
    ├── Token family tracking
    └── Reuse detection
```

## Files to Create/Modify

### New Files (Port from your code):
1. `packages/openauth/src/storage/d1.ts` - D1 storage adapter
2. `packages/openauth/src/client/d1-adapter.ts` - Client DB adapter
3. `packages/openauth/src/client/authenticator.ts` - PBKDF2 validation
4. `packages/openauth/src/middleware/client-auth.ts` - Port your clientAuth.ts
5. `packages/openauth/src/services/audit.ts` - Audit logging hooks

### Modified Files:
1. `packages/openauth/src/issuer.ts` - Add introspection, revocation, client auth
2. `packages/openauth/src/token.ts` - Add audit hooks, D1 integration
3. `packages/openauth/src/storage/index.ts` - Export D1 adapter

## Migration Strategy

### Phase 1: Fork Setup (1-2 hours)
1. Fork OpenAuth repo to your organization
2. Set up local development environment
3. Create feature branch: `feat/enterprise-features`

### Phase 2: D1 Storage Adapter (4-6 hours)
1. Implement D1StorageAdapter interface
2. Add refresh token storage to D1
3. Maintain KV for sessions and auth codes
4. Test dual storage (KV + D1)

### Phase 3: Client Authentication (3-4 hours)
1. Port client-auth-service.ts logic
2. Add client authentication middleware
3. Update /token endpoint to validate clients
4. Test both public (PKCE) and confidential (secret) flows

### Phase 4: RFC Endpoints (3-4 hours)
1. Add /token/introspect endpoint
2. Add /token/revoke endpoint
3. Port error handling from TokenRoutes
4. Test RFC compliance

### Phase 5: Audit Logging (2-3 hours)
1. Add token event hooks
2. Implement D1 audit logging
3. Port token_usage table logic
4. Test analytics queries

### Phase 6: Integration & Testing (4-6 hours)
1. Update apps/auth to use forked OpenAuth
2. Remove custom TokenRoutes
3. Update ARCHITECTURE.md
4. End-to-end testing
5. Security audit

**Total Effort: 16-25 hours**

## Benefits of This Approach

✅ **Single OAuth System** - No more dual token systems
✅ **Upstream Compatible** - Can pull OpenAuth updates (with merge)
✅ **All Features Preserved** - Client auth, audit logging, analytics
✅ **Standards Compliant** - RFC 7662, RFC 7009, RFC 6749
✅ **Maintainable** - Well-organized fork with clear modifications
✅ **Contribution Path** - Some features could be upstreamed to OpenAuth

## Alternative: Plugin System (Lower Effort)

Instead of forking, create OpenAuth plugins:

```typescript
issuer({
  plugins: [
    D1StoragePlugin({ database: env.AUTH_DB }),
    ClientAuthPlugin({ adapter: D1ClientAdapter }),
    AuditLogPlugin({ table: 'token_usage' }),
    IntrospectionPlugin(),
    RevocationPlugin()
  ]
})
```

**If OpenAuth supports plugins** - 8-12 hours effort
**If not** - Need fork approach above

## Quick Fix Alternative (30 minutes)

Before committing to the full fork, consider a quick fix to unblock apps:

**Modify TokenRoutes to pass authorization_code to OpenAuth:**

```typescript
// In token-routes.ts handleTokenEndpoint()
const grantType = formData.get('grant_type') as string;

// Pass authorization_code to OpenAuth
if (grantType === 'authorization_code') {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404
  });
}

// Continue with refresh_token handling...
```

This allows:
- ✅ Apps work immediately
- ✅ All existing features preserved
- ✅ Time to properly plan and execute fork
- ✅ Fully reversible

---

**Next Steps:**
1. Decide: Quick fix first, or go straight to fork?
2. If fork: Set up OpenAuth development environment
3. If quick fix: Modify TokenRoutes, test, then plan fork
