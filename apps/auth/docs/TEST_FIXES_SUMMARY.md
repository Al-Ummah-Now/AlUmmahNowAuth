# OpenAuth Client Authentication E2E Test Fixes

## Summary
Fixed failing E2E tests for OAuth client authentication, token introspection, and token revocation by ensuring correct PBKDF2 hash format compatibility with OpenAuth 1.0.x.

## Root Cause
Tests were creating client secrets with manual PBKDF2 hashing using hex encoding (`saltHex:hashHex` format), but OpenAuth expects a different format: `$pbkdf2-sha256$iterations$salt$hash` with base64url encoding.

Additionally:
- Tests used 512-bit hashes (64*8 bits) instead of 256-bit hashes
- Tests had SQL column name mismatch (`client_id` instead of `id`)

## Files Modified

### 1. `/apps/auth/src/token-revocation-e2e.test.ts`
**Changes:**
- Replaced manual PBKDF2 implementation with OpenAuth's `hashClientSecret` function
- Import `hashClientSecret` from `@al-ummah-now/openauth`
- Removed 30+ lines of manual crypto code

**Before:**
```typescript
// Manual PBKDF2 with hex encoding
const salt = crypto.getRandomValues(new Uint8Array(16));
const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
// ... manual deriveBits with 64*8 bits
const secretHash = `${saltHex}:${hashHex}`;
```

**After:**
```typescript
// Use OpenAuth's standard hash function
const secretHash = await hashClientSecret(testClientSecret);
```

### 2. `/apps/auth/src/oauth-client-e2e.test.ts`
**Changes:**
- Fixed SQL column name from `client_id` to `id` in UPDATE statement

**Before:**
```sql
UPDATE oauth_clients SET client_secret_hash = ? WHERE client_id = ?
```

**After:**
```sql
UPDATE oauth_clients SET client_secret_hash = ? WHERE id = ?
```

### 3. `/apps/auth/src/token-lifecycle-e2e.test.ts`
**No changes needed** - Already using `hashClientSecret` correctly

## Test Results

### Individual Test Runs (✅ All Passing)
```bash
# Token Revocation
pnpm test token-revocation-e2e.test.ts
✓ 6/6 tests passed

# OAuth Client Management
pnpm test oauth-client-e2e.test.ts
✓ 9/9 tests passed

# Token Lifecycle
pnpm test token-lifecycle-e2e.test.ts
✓ 11/11 tests passed
```

### Combined Test Run (⚠️ Known Limitation)
```bash
pnpm test oauth-client-e2e.test.ts token-lifecycle-e2e.test.ts token-revocation-e2e.test.ts
⚠️ Some tests fail when run together due to shared D1 database state
```

## Known Issue: Test Isolation

When all three E2E test files run together, some tests fail with 401 errors. This is due to shared D1 database state between test files.

**Why this happens:**
- All tests share the same `env.AUTH_DB` instance
- Each test file creates its own OpenAuth issuer in `beforeEach`
- Vitest runs test files in parallel by default
- Race conditions occur with shared database state

**Workaround:**
Run E2E tests individually or sequentially:
```bash
# Option 1: Run individually
pnpm test token-revocation-e2e.test.ts
pnpm test oauth-client-e2e.test.ts
pnpm test token-lifecycle-e2e.test.ts

# Option 2: Run sequentially (not parallel)
pnpm test --sequence.concurrent=false
```

**Future Fix:**
Consider using Vitest's workspace feature or `test.concurrent = false` for E2E tests that share database state.

## Technical Details

### OpenAuth Hash Format
OpenAuth uses PBKDF2-SHA256 with the following format:
```
$pbkdf2-sha256$100000$<base64url-salt>$<base64url-hash>
```

Where:
- Iterations: 100,000
- Salt: 16 bytes (base64url encoded)
- Hash: 256 bits (base64url encoded)
- Format: PHC string format

### Schema Reference
The `oauth_clients` table schema:
```sql
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                    -- Client ID (NOT client_id)
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  client_secret_hash TEXT,                -- $pbkdf2-sha256$ format
  grant_types TEXT DEFAULT '[]',
  scopes TEXT DEFAULT '[]',
  redirect_uris TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Secret rotation fields
  rotated_at INTEGER,
  previous_secret_hash TEXT,
  previous_secret_expires_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
)
```

## Related Documentation
- [OpenAuth Client Authentication](https://github.com/openauthjs/openauth/blob/main/docs/client-authentication.md)
- [RFC 7009: Token Revocation](https://datatracker.ietf.org/doc/html/rfc7009)
- [RFC 7662: Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662)
- [PHC String Format](https://github.com/P-H-C/phc-string-format/blob/master/phc-sf-spec.md)
