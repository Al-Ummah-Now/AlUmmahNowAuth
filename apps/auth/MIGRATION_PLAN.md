# Migration Plan: Switch to OpenAuth Enterprise Issuer

## Problem Statement

Currently, we use the basic `issuer()` from OpenAuth but manually implement enterprise features:
- Custom session management (`BrowserSessionService`, `AccountSessionService`)
- Custom authorization codes (`generateAuthorizationCode`)
- Custom token generation (`TokenService` with `jwt_keys` table)
- Custom OIDC handling (`handleAuthorizeRequest`, `OIDCAuthorizeService`)

**Critical Issue**: Our `TokenService` generates tokens using keys from D1 `jwt_keys` table, but OpenAuth's `client.verify()` uses JWKS from `/.well-known/jwks.json` which serves OpenAuth's internal keys. **Keys don't match = tokens can't be verified.**

## Solution Overview

Replace basic `issuer()` with `createMultiTenantIssuer()` from `@meywd/openauth/enterprise`. This:
1. Uses consistent keys for ALL tokens (JWKS verification will work)
2. Handles OIDC prompt parameters natively (`prompt=none` for silent auth)
3. Provides built-in session management
4. Eliminates need for custom auth code handling

## Architecture Comparison

### Current (Broken)
```
Profile App
    |
    v
Auth Server (basic issuer)
    |
    +-- Custom handleAuthorizeRequest (generates custom codes)
    +-- Custom TokenService (uses jwt_keys table) <-- WRONG KEYS
    +-- Custom BrowserSessionService (D1)
    +-- Custom AccountSessionService (D1)
    |
    v
OpenAuth JWKS <-- Different keys than TokenService
```

### Target (Working)
```
Profile App
    |
    v
Auth Server (createMultiTenantIssuer)
    |
    +-- OpenAuth handles /authorize with prompt support
    +-- OpenAuth generates tokens with its own keys <-- SAME KEYS
    +-- D1SessionAdapter (wraps our D1 services)
    +-- D1TenantAdapter (wraps our D1 TenantService)
    +-- RBACAdapter (OpenAuth's D1 adapter)
    |
    v
OpenAuth JWKS <-- Same keys used everywhere
```

## Implementation Steps

### Phase 1: Create D1 Adapters for OpenAuth Interfaces

OpenAuth's enterprise services use `StorageAdapter` (KV-based). Our services use D1. Create adapters that wrap our D1 services to implement OpenAuth's interfaces.

#### Step 1.1: Create SessionService Adapter
**File**: `apps/auth/src/adapters/session-adapter.ts`

Implement `SessionService` interface from `@meywd/openauth/contracts`:
```typescript
import { SessionService, BrowserSession, AccountSession } from '@meywd/openauth/contracts/types';
import { BrowserSessionService } from '../services/browser-session.service';
import { AccountSessionService } from '../services/account-session.service';

export class D1SessionAdapter implements SessionService {
  constructor(
    private browserService: BrowserSessionService,
    private accountService: AccountSessionService
  ) {}

  // Implement all SessionService methods by delegating to our D1 services
  async createBrowserSession(params) { ... }
  async getBrowserSession(sessionId, tenantId) { ... }
  // etc.
}
```

#### Step 1.2: Create TenantService Adapter
**File**: `apps/auth/src/adapters/tenant-adapter.ts`

Implement `TenantService` interface wrapping our D1 TenantService.

#### Step 1.3: Configure RBACAdapter
OpenAuth provides `RBACAdapter` for D1 out of the box. We just need to use it.

### Phase 2: Switch to Enterprise Issuer

#### Step 2.1: Update imports
```typescript
// Before
import { issuer } from "@meywd/openauth";

// After
import { createMultiTenantIssuer, hexToSecret } from "@meywd/openauth/enterprise";
import { SessionServiceImpl } from "@meywd/openauth/session";  // Or our adapter
import { TenantServiceImpl } from "@meywd/openauth/tenant";    // Or our adapter
import { RBACServiceImpl, RBACAdapter } from "@meywd/openauth/rbac";
```

#### Step 2.2: Configure Enterprise Issuer
```typescript
const sessionSecret = hexToSecret(env.SESSION_SECRET);  // Need to add this env var

const { app } = createMultiTenantIssuer({
  tenantService: d1TenantAdapter,      // Our D1 adapter
  sessionService: d1SessionAdapter,    // Our D1 adapter
  rbacService: new RBACServiceImpl(new RBACAdapter(env.AUTH_DB), storage),
  storage: CloudflarePatchedStorage({ namespace: env.AUTH_STORAGE }),
  sessionSecret,
  clientDb: env.AUTH_DB,
  providers: {
    password: PasswordProvider(PasswordUI({ ... })),
  },
  subjects,
  theme: { ... },
  onSuccess: async (ctx, value, tenant) => {
    // Similar to current success callback
    const user = await getOrCreateUser(env, value.email, true);
    return ctx.subject("user", {
      id: user.id,
      email: value.email,
      roles: user.roles,
    });
  },
});
```

### Phase 3: Remove Custom Code

Remove these files/sections that are now handled by enterprise issuer:

#### Files to Remove
- `apps/auth/src/routes/authorize.ts` - Enterprise issuer handles this
- `apps/auth/src/services/oidc-authorize.service.ts` - Enterprise issuer handles this
- `apps/auth/src/utils/authorization-code.ts` - Enterprise issuer handles this

#### Code to Remove from index.ts
- Lines 904-1038: Custom authorization code handling in `/token` endpoint
- Lines 769-825: Custom `/authorize` handling (handleAuthorizeRequest)
- Custom session creation in success callback (enterprise issuer does this)

#### Services to Potentially Remove/Adapt
- `TokenService` - Only keep for refresh token management if needed
- `jwt_keys` related code - OpenAuth manages its own keys

### Phase 4: Update Profile App

The profile app should work automatically once auth server uses consistent keys. But verify:

1. `client.verify()` should now work (same JWKS keys)
2. Remove any workarounds for token verification
3. Test account switching flow

### Phase 5: Database Migration (If Needed)

OpenAuth's session service stores data differently. Options:
1. **Adapter approach** (recommended): Keep D1 schema, adapt interface
2. **Full migration**: Move session data to KV format

For adapter approach, ensure D1 tables have all required fields:
- `browser_sessions` needs: tenant_id, active_user_id, account_user_ids (array as JSON)
- `account_sessions` needs: subject_type, subject_properties, refresh_token, client_id

### Phase 6: Environment Variables

Add new required secrets:
```bash
# .dev.vars
SESSION_SECRET=<64-char-hex-string>  # 256-bit = 32 bytes = 64 hex chars
```

Generate with:
```bash
openssl rand -hex 32
```

## Files Changed Summary

| File | Action | Notes |
|------|--------|-------|
| `apps/auth/src/index.ts` | Major refactor | Use createMultiTenantIssuer |
| `apps/auth/src/adapters/session-adapter.ts` | Create | Wrap D1 services |
| `apps/auth/src/adapters/tenant-adapter.ts` | Create | Wrap D1 TenantService |
| `apps/auth/src/routes/authorize.ts` | Delete | Handled by enterprise issuer |
| `apps/auth/src/services/oidc-authorize.service.ts` | Delete | Handled by enterprise issuer |
| `apps/auth/src/utils/authorization-code.ts` | Delete | Handled by enterprise issuer |
| `apps/auth/.dev.vars` | Update | Add SESSION_SECRET |

## Testing Plan

1. **Unit Tests**: Test D1 adapters implement interfaces correctly
2. **Integration Tests**:
   - Login flow (password provider)
   - Token exchange
   - Token verification in profile app
   - Account switching with `prompt=none`
   - Multi-account support
3. **E2E Tests**: Existing tests should pass after migration

## Rollback Plan

If issues arise:
1. Keep old `index.ts` as `index.ts.bak`
2. Can quickly revert by restoring backup
3. Custom services remain intact during adapter approach

## Estimated Effort

- Phase 1 (Adapters): 2-3 hours
- Phase 2 (Enterprise Issuer): 1-2 hours
- Phase 3 (Cleanup): 1 hour
- Phase 4 (Profile App): 30 mins
- Phase 5 (DB Migration): 1-2 hours if needed
- Phase 6 (Env): 15 mins
- Testing: 2-3 hours

**Total: ~8-12 hours**

## Alternative: Quick Fix (Not Recommended)

If time is critical, a quick fix is to skip token verification in profile app:
```typescript
// Instead of client.verify(), just decode the JWT
const decoded = decodeJwt(result.tokens.access);
const userInfo = decoded.properties;
```

This works because we control both sides and trust our auth server. But it's a workaround, not a fix.
