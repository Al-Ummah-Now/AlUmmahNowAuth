# OpenAuth Fork Test Plan

This document outlines the comprehensive test plan for testing the OpenAuth fork's enterprise functionality at `https://github.com/meywd/openauth/pull/1`.

## 1. Fork Location and Structure

**Repository:** `/tmp/openauth-fork/packages/openauth`

**Test Runner:** Bun (`bun test`)

**Key Source Files:**
- `src/services/audit.ts` - AuditService for token usage logging
- `src/client/d1-adapter.ts` - D1ClientAdapter with circuit breaker/retry
- `src/client/authenticator.ts` - ClientAuthenticator with PBKDF2 hashing
- `src/client/circuit-breaker.ts` - CircuitBreaker resilience pattern
- `src/client/multi-region-d1-adapter.ts` - Multi-region sync via queues
- `src/revocation.ts` - RevocationService via KV storage
- `src/middleware/client-auth.ts` - Hono middleware for client auth
- `src/security/sql-validator.ts` - SQL injection prevention

---

## 2. Existing Test Coverage Summary

### 2.1 AuditService (`test/audit-service.test.ts`) - 27 Tests ✅

| Test Category | Tests | Status |
|---------------|-------|--------|
| `logTokenUsage` | 7 tests | ✅ Covered |
| `getTokenAnalytics` | 5 tests | ✅ Covered |
| `getTokenFamily` | 2 tests | ✅ Covered |
| `getAuditLogs` | 7 tests | ✅ Covered |
| `cleanExpired` | 3 tests | ✅ Covered |
| Configuration | 2 tests | ✅ Covered |

**What's Tested:**
- Token generation, refresh, revoke, reuse event logging
- Analytics retrieval with limits and JSON parsing
- Token family history tracking
- Log filtering by subject, event_type, client_id, timestamp range
- Pagination support (limit/offset)
- Fire-and-forget error handling (no throws)
- Custom table names

### 2.2 ClientAuthenticator (`test/client-authenticator.test.ts`) - 14 Tests ✅

| Test Category | Tests | Status |
|---------------|-------|--------|
| `hashSecret` | 4 tests | ✅ Covered |
| `validateClient` | 5 tests | ✅ Covered |
| `authenticateClient` | 2 tests | ✅ Covered |
| `createClient` | 1 test | ✅ Covered |
| `updateClientSecret` | 2 tests | ✅ Covered |

**What's Tested:**
- PBKDF2 hash consistency with same salt
- Random salt generation
- Hash format (salt:hash with colon separator)
- Valid/invalid credential validation
- Timing-safe comparison (hashes even if client not found)
- Malformed hash handling
- Client creation with hashed secrets
- Secret rotation

### 2.3 RevocationService (`test/revocation-service.test.ts`) - 17 Tests ✅

| Test Category | Tests | Status |
|---------------|-------|--------|
| `revokeAccessToken` | 3 tests | ✅ Covered |
| `isAccessTokenRevoked` | 3 tests | ✅ Covered |
| `revokeRefreshToken` | 3 tests | ✅ Covered |
| `revokeAllRefreshTokens` | 3 tests | ✅ Covered |
| `cleanExpiredRevocations` | 3 tests | ✅ Covered |
| Configuration | 2 tests | ✅ Covered |

**What's Tested:**
- Access token revocation with TTL
- Fail-open behavior for availability
- Refresh token removal from storage
- Batch revocation for a subject
- Expired revocation cleanup
- Custom TTL configuration

### 2.4 Enterprise Endpoints (`test/enterprise-endpoints.test.ts`) - 27 Tests ✅

| Test Category | Tests | Status |
|---------------|-------|--------|
| Token Introspection | 8 tests | ✅ Covered |
| Token Revocation | 8 tests | ✅ Covered |
| Audit Hooks Integration | 4 tests | ✅ Covered |
| CORS Configuration | 1 test | ✅ Covered |
| Unsupported Operations | 2 tests | ✅ Covered |

**What's Tested:**
- Basic auth and form-based client authentication
- Active/inactive token introspection (RFC 7662)
- Token revocation per RFC 7009
- Audit event logging for token lifecycle
- Token reuse detection
- CORS headers
- 501 responses when clientDb not configured

### 2.5 MultiRegionD1ClientAdapter (`test/multi-region-d1-adapter.test.ts`) - 14 Tests ✅

| Test Category | Tests | Status |
|---------------|-------|--------|
| `getClient` | 3 tests | ✅ Covered |
| `createClient` | 2 tests | ✅ Covered |
| `updateClient` | 2 tests | ✅ Covered |
| `deleteClient` | 2 tests | ✅ Covered |
| `listClients` | 1 test | ✅ Covered |
| Circuit Breaker | 2 tests | ✅ Covered |
| `applySyncMessage` | 5 tests | ✅ Covered |

**What's Tested:**
- Local D1 reads/writes with queue sync
- Last-Write-Wins conflict resolution
- Queue failure tolerance (local succeeds even if queue fails)
- Circuit breaker stats and reset

### 2.6 SQLValidator (`test/security/sql-validator.test.ts`) - 17 Tests ✅

| Test Category | Tests | Status |
|---------------|-------|--------|
| `validateTableName` | 11 tests | ✅ Covered |
| `isValidTableName` | 3 tests | ✅ Covered |
| `getAllowedTables` | 3 tests | ✅ Covered |

**What's Tested:**
- SQL injection prevention (DROP, UNION, OR attacks)
- Allow-list validation
- Case sensitivity
- Security violation logging

### 2.7 E2E OAuth Flow (`test/e2e/oauth-flow.test.ts`) - 4 Tests ✅

**What's Tested:**
- Well-known endpoint metadata
- Complete password registration flow
- Token exchange and refresh
- Invalid verification code handling
- Authorization parameter validation

---

## 3. Current Test Execution Results (as of Nov 26, 2025)

**Overall Status:** 148 pass / 23 fail (87% pass rate)

### 3.1 Failing Tests

The following tests are currently failing and require investigation:

#### Issuer Tests
- `refresh token > success with reuse interval enabled` - JTI mismatch in access token payload

#### RevocationService Tests
- `isAccessTokenRevoked > returns false for non-revoked token`
- `revokeRefreshToken > removes refresh token from storage`
- `revokeAllRefreshTokens > revokes all refresh tokens for a subject`
- `revokeAllRefreshTokens > only revokes tokens for specified subject`
- `cleanExpiredRevocations > removes expired revocation entries`

#### Sync Consumer Tests
- `processClientSyncBatch > processes CREATE message across all regions`
- `processClientSyncBatch > processes UPDATE message across all regions`
- `processClientSyncBatch > processes DELETE message across all regions`
- `processClientSyncBatch > handles empty batch gracefully`
- `processClientSyncBatch > uses custom table name when provided`
- `applySyncMessage > applies CREATE operation with Last-Write-Wins`

#### Enterprise Endpoints Tests
- `Token Introspection > accepts Basic auth credentials`
- `Token Introspection > accepts form-based credentials`
- `Token Introspection > returns active=true for valid access token`
- `Token Introspection > returns active=false for expired access token`
- `Token Introspection > returns active=false for invalid token`
- `Token Revocation > accepts Basic auth credentials`
- `Token Revocation > revokes refresh token successfully`
- `Token Revocation > returns success even for non-existent token (RFC 7009)`
- `Token Revocation > auto-detects token type from format`
- `Audit Hooks Integration > logs token revocation events`

#### AuditService Tests
- `configuration > uses custom table name`

### 3.2 Root Cause Analysis

Most failures appear to be related to:
1. **Storage interface changes** - MemoryStorage scan implementation differences
2. **Token reuse interval logic** - JTI handling in reused tokens
3. **Enterprise endpoints** - Client authentication integration issues
4. **Custom table name validation** - SQLValidator allow-list restrictions

### 3.3 Priority for Fixes

| Priority | Test Category | Effort |
|----------|---------------|--------|
| P0 | Enterprise Endpoints (introspection/revocation) | Medium |
| P1 | RevocationService | Low |
| P2 | Sync Consumer | Medium |
| P3 | Token reuse interval | Low |

---

## 4. Running Fork Tests

```bash
# Navigate to fork directory
cd /tmp/openauth-fork/packages/openauth

# Install dependencies (if not already done)
bun install

# Run all tests
bun test

# Run specific test file
bun test test/audit-service.test.ts
bun test test/client-authenticator.test.ts
bun test test/revocation-service.test.ts
bun test test/enterprise-endpoints.test.ts
bun test test/multi-region-d1-adapter.test.ts
bun test test/security/sql-validator.test.ts

# Run E2E tests
bun test test/e2e/oauth-flow.test.ts

# Run with coverage
bun test --coverage
```

---

## 5. Test Gaps and Additional Testing Needed

### 5.1 Circuit Breaker Deep Testing

**Current:** Basic stats/reset tests exist
**Needed:**
- [ ] State transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
- [ ] Failure threshold behavior (5 failures in 60s)
- [ ] Cooldown period (30s) behavior
- [ ] Half-open success/failure scenarios
- [ ] Concurrent request handling during state transitions

### 5.2 D1ClientAdapter Edge Cases

**Current:** Basic CRUD with mocks
**Needed:**
- [ ] Retry logic (3 retries with exponential backoff)
- [ ] Network timeout handling
- [ ] Partial failure recovery
- [ ] Connection pooling behavior
- [ ] Transaction rollback scenarios

### 5.3 Real D1 Database Integration

**Current:** All tests use mocks
**Needed:**
- [ ] Actual Cloudflare D1 integration tests
- [ ] Schema migration verification
- [ ] Query performance testing
- [ ] Concurrent write handling

### 5.4 Multi-Region Sync Queue Consumer

**Current:** Producer side tested, consumer partially tested
**Needed:**
- [ ] Full consumer processing (`sync-consumer.test.ts` exists but may need expansion)
- [ ] Out-of-order message handling
- [ ] Duplicate message idempotency
- [ ] Dead letter queue behavior
- [ ] Batch processing

### 5.5 Integration with Auth App

**Current:** Fork tests are isolated
**Needed:**
- [ ] Integration tests using fork services from `apps/auth`
- [ ] End-to-end flow with actual D1 and KV
- [ ] Token lifecycle with audit logging
- [ ] Client authentication via PBKDF2

---

## 6. Proposed New Tests

### 6.1 Circuit Breaker State Machine Tests

```typescript
// test/circuit-breaker-states.test.ts
describe("CircuitBreaker State Machine", () => {
  test("transitions from CLOSED to OPEN after threshold failures")
  test("stays OPEN during cooldown period")
  test("transitions to HALF_OPEN after cooldown")
  test("transitions back to CLOSED on HALF_OPEN success")
  test("transitions back to OPEN on HALF_OPEN failure")
  test("resets failure count after success window")
})
```

### 6.2 Integration Tests with Real Storage

```typescript
// test/integration/d1-real.test.ts
describe("D1ClientAdapter Integration", () => {
  test("creates and retrieves client from actual D1")
  test("handles concurrent client creation")
  test("updates client with optimistic locking")
  test("cascades client deletion properly")
})
```

### 6.3 Auth App Integration Tests

```typescript
// apps/auth/src/openauth-integration.test.ts
describe("OpenAuth Fork Integration", () => {
  test("AuditService logs token events to D1")
  test("ClientAuthenticator validates OAuth clients")
  test("RevocationService revokes tokens via KV")
  test("MultiRegion adapter syncs across regions")
})
```

---

## 7. Test Environment Setup

### 7.1 For Fork Tests (Bun)

```bash
# Prerequisites
# - Bun installed (https://bun.sh)
# - Node.js 18+ for some dependencies

cd /tmp/openauth-fork/packages/openauth
bun install
bun test
```

### 7.2 For Auth App Tests (Vitest + Cloudflare)

```bash
cd /home/meywd/AlUmmahNowAuth/apps/auth
npm install
npm test
```

### 7.3 For Real D1/KV Integration (Miniflare)

The existing test setup uses `cloudflare:test` with Miniflare, which provides local D1 and KV emulation.

---

## 8. Test Execution Checklist

### Phase 1: Verify Existing Fork Tests
- [ ] Clone/verify fork exists at `/tmp/openauth-fork`
- [ ] Run `bun install` in fork directory
- [ ] Run `bun test` and verify all tests pass
- [ ] Document any failures

### Phase 2: Run Auth App Tests
- [ ] Run `npm test` in `apps/auth` directory
- [ ] Verify 328+ tests pass
- [ ] Document test coverage

### Phase 3: Integration Testing (Manual)
- [ ] Start local dev server with `npm run dev`
- [ ] Test OAuth client authentication
- [ ] Verify audit logs are written to D1
- [ ] Test token introspection endpoint
- [ ] Test token revocation endpoint

### Phase 4: Add Missing Tests
- [ ] Circuit breaker state machine tests
- [ ] D1 retry logic tests
- [ ] Multi-region sync consumer tests
- [ ] Auth app + fork integration tests

---

## 9. Known Limitations

1. **Fork tests use Bun, Auth app uses Vitest** - Different test runners may have subtle behavioral differences

2. **Mock-heavy tests** - Most fork tests use mocks instead of real D1/KV, which may miss integration issues

3. **No CI/CD integration** - Tests need to be run manually; no automated pipeline verification

4. **E2E tests require server** - The `oauth-flow.test.ts` starts an actual HTTP server which may conflict with other tests

---

## 10. Success Criteria

The fork functionality is considered fully tested when:

1. ⏳ All 171 fork tests pass (currently 148 pass, 23 fail - 87%)
2. ✅ All 328+ auth app tests pass
3. ⏳ Failing fork tests are fixed (see Section 3)
4. ⏳ Circuit breaker state transitions are verified
5. ⏳ Real D1 integration works without mocks
6. ⏳ Multi-region sync is tested end-to-end
7. ⏳ Auth app successfully uses fork services

---

## 11. Next Steps

1. **Immediate:** Fix the 23 failing fork tests (P0: Enterprise Endpoints)
2. **Short-term:** Add circuit breaker state machine tests
3. **Medium-term:** Create integration tests with real D1/KV
4. **Long-term:** Set up CI/CD pipeline for automated testing

---

## 12. Quick Reference Commands

```bash
# Run all fork tests
cd /tmp/openauth-fork/packages/openauth && bun test

# Run specific test categories
bun test test/audit-service.test.ts           # AuditService
bun test test/client-authenticator.test.ts    # ClientAuthenticator
bun test test/revocation-service.test.ts      # RevocationService
bun test test/enterprise-endpoints.test.ts    # Enterprise Endpoints
bun test test/multi-region-d1-adapter.test.ts # Multi-region
bun test test/security/sql-validator.test.ts  # SQLValidator
bun test test/e2e/oauth-flow.test.ts          # E2E OAuth

# Run auth app tests
cd /home/meywd/AlUmmahNowAuth/apps/auth && npm test
```
