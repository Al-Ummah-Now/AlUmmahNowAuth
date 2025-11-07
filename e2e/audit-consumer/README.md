# Audit Consumer E2E Tests

Comprehensive end-to-end tests for the queue-based audit logging system.

## Test Coverage

### 1. Consumer Health & Metrics
- ✅ Health check endpoint returns healthy status
- ✅ Metrics endpoint is accessible
- ✅ Consumer continues running after errors

### 2. Queue Message Processing
- ✅ Audit events are queued when users authenticate
- ✅ Multiple events are batched efficiently (up to 50 per batch)
- ✅ Consumer processes batches within timeout (5 seconds)
- ✅ Events are written to D1 database

### 3. Token Operations
- ✅ Token generation creates audit event
- ✅ Token refresh creates audit event
- ✅ Token revocation creates audit event
- ✅ Token reuse detection creates audit event

### 4. Error Handling
- ✅ Consumer handles transient errors gracefully
- ✅ Failed messages retry with exponential backoff (5s, 10s, 20s)
- ✅ Messages go to DLQ after max retries (3)
- ✅ Malformed messages don't crash consumer

### 5. Performance
- ✅ Batch processing is more efficient than individual writes
- ✅ Consumer scales with queue depth
- ✅ Auth server writes to queue in < 1ms (non-blocking)

### 6. OAuth Integration
- ✅ Discovery endpoint lists supported features
- ✅ Token introspection requires authentication
- ✅ Token revocation requires authentication

## Running Tests

### All E2E Tests
```bash
# From repository root
pnpm test:e2e

# Or with UI
pnpm test:e2e:ui
```

### Only Audit Consumer Tests
```bash
npx playwright test e2e/audit-consumer
```

### Watch Mode (during development)
```bash
npx playwright test e2e/audit-consumer --headed --watch
```

### Debug Mode
```bash
pnpm test:e2e:debug
```

## Prerequisites

All services must be running:

```bash
# Terminal 1: Start all apps
pnpm dev

# Or start individually:
pnpm dev:auth      # Port 3301
pnpm dev:profile   # Port 3302
pnpm dev:admin     # Port 3303
pnpm dev:consumer  # Port 3304
```

### Queue Setup (for local testing)

Create local queues:

```bash
# In apps/auth directory
wrangler queues create audit-events --local
wrangler queues create audit-events-dlq --local
```

## Test Data

Tests use isolated data:
- Unique email addresses per test run
- Test-only endpoints (e.g., `/test/email/{email}`)
- Separate D1 database instance for tests

## Environment Variables

Tests use `.env.test`:

```env
AUTH_SERVER_URL=http://localhost:3301
CONSUMER_URL=http://localhost:3304
TEST_PROMOTE_SECRET=test-secret-for-e2e
```

## CI/CD Integration

Tests run in GitHub Actions:

```yaml
- name: Run E2E Tests
  run: pnpm test:e2e
  env:
    CI: true
```

## Troubleshooting

### Test Timeouts

If tests timeout, increase the timeout in `playwright.config.ts`:

```typescript
timeout: 60 * 1000, // 60 seconds
```

### Queue Not Processing

Check consumer logs:

```bash
# In separate terminal
wrangler tail al-ummah-now-audit-consumer
```

### Database Locked Errors

Reduce parallel workers in `playwright.config.ts`:

```typescript
workers: 1, // Run tests sequentially
```

### Auth Flow Failures

Verify test email endpoints are enabled (only in development):

```typescript
// apps/auth/src/index.ts
if (!isProduction) {
  // /test/email/{email} endpoint enabled
}
```

## Test Reports

After running tests:

```bash
# View HTML report
pnpm test:e2e:report

# Reports are in:
# - e2e-report/index.html (HTML)
# - e2e-results.json (JSON)
# - e2e-results.xml (JUnit)
```

## Writing New Tests

### Structure

```typescript
test.describe('Feature Name', () => {
  test('should do something', async ({ page, request }) => {
    // 1. Setup
    const email = `test-${Date.now()}@example.com`;

    // 2. Action
    await page.goto(`${AUTH_URL}/...`);

    // 3. Wait for async processing
    await page.waitForTimeout(3000);

    // 4. Assertion
    expect(response.ok()).toBeTruthy();
  });
});
```

### Best Practices

1. **Use unique identifiers**: Generate unique emails/IDs per test
2. **Wait for async operations**: Allow time for queue processing
3. **Clean up**: Tests should be isolated and not affect each other
4. **Check both success and error cases**: Test happy path and error scenarios
5. **Verify side effects**: Check that audit events were actually written

## Performance Benchmarks

Expected performance (local development):

- **Queue write**: < 1ms (non-blocking)
- **Batch processing**: < 100ms for 50 events
- **D1 write**: Varies, but batched writes are 50x faster
- **End-to-end**: < 3 seconds from event to database

## Related Documentation

- [Audit Consumer README](../../apps/audit-consumer/README.md)
- [OpenAuth PR #1](https://github.com/meywd/openauth/pull/1)
- [Playwright Documentation](https://playwright.dev)
