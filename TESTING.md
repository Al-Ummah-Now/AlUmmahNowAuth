# Testing Guide

This document provides comprehensive information about the testing infrastructure for the Al Ummah Now Auth project.

## Overview

The project uses [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples) for testing Cloudflare Workers applications. This setup allows tests to run in an environment that closely mimics the production Cloudflare Workers runtime.

## Test Infrastructure

### Dependencies

- **vitest**: ^2.1.8 - Fast unit test framework
- **@cloudflare/vitest-pool-workers**: ^0.5.29 - Cloudflare Workers test environment
- **@cloudflare/workers-types**: ^4.20250110.0 - TypeScript types for Workers API
- **@vitest/coverage-v8**: ^2.1.8 - Code coverage reporting

### Configuration

Each app has a `vitest.config.ts` file that configures:

**Example (`apps/auth/vitest.config.ts`):**
```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          d1Databases: ["AUTH_DB"],
          kvNamespaces: ["AUTH_STORAGE"],
          compatibilityFlags: ["nodejs_compat"],
          compatibilityDate: "2024-12-30",
        },
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/index.ts",
      ],
    },
  },
});
```

## Running Tests

### All Apps

```bash
# Run all tests across all apps
pnpm test

# Run tests in verbose mode
pnpm test:unit

# Run tests in watch mode (auto-rerun on changes)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

### Individual Apps

```bash
# Auth app
pnpm --filter auth test

# Admin app
pnpm --filter admin test

# Profile app
pnpm --filter profile test
```

## Test Files

### Auth App (`apps/auth/src/`)

#### `users.test.ts` - User Management Tests (21 tests)

Tests for user CRUD operations and password reset functionality:

- **User Creation**
  - Create new user when user doesn't exist
  - Return existing user when user already exists
  - Handle race condition when multiple requests create same user
  - Error handling for invalid operations

- **User Retrieval**
  - Find user by ID
  - Find user by email
  - Return null when user not found

- **User Updates**
  - Update user email
  - Update user role (with session invalidation)
  - Update both email and role
  - Return null when updating non-existent user
  - Throw error when no updates provided
  - Validate email format and role values

- **User Deletion**
  - Delete existing user
  - Return false when deleting non-existent user

- **Password Reset**
  - Check password reset required status
  - Clear password reset required flag
  - Handle non-existent users

#### `session.test.ts` - Session Management Tests (19 tests)

Tests for session handling with KV storage:

- **Cookie Parsing**
  - Extract session token from cookie header
  - Handle missing cookie header
  - Handle missing auth_session cookie
  - Handle cookie values with equals signs

- **Session Creation**
  - Create and store session in KV
  - Generate unique session tokens

- **Session Retrieval**
  - Retrieve session from KV
  - Handle missing cookie
  - Handle session not found in KV
  - Handle expired sessions (auto-delete)
  - Handle corrupted JSON (auto-delete)
  - Handle session without expiresAt field

- **Session Deletion**
  - Remove session from KV
  - Handle deletion when no cookie present
  - Handle deletion of non-existent session

- **Cookie Helpers**
  - Create secure cookie for production
  - Create non-secure cookie for localhost
  - Clear session cookie

#### `email.test.ts` - Email Validation Tests (9 tests)

Tests for email validation and retry logic:

- **Email Validation**
  - Validate correct email addresses
  - Reject invalid email addresses

- **Retry Logic**
  - Exponential backoff calculation
  - Correct retry parameters
  - Required function parameters
  - Optional maxRetries parameter

- **Error Handling**
  - Descriptive errors for invalid emails
  - Graceful validation error handling

- **Module Exports**
  - Verify SendEmail function export

## Test Setup

### Database Schema

The `test-setup.ts` file automatically creates the required database schema before tests run:

```typescript
// apps/auth/src/test-setup.ts
import { env } from "cloudflare:test";

export async function setupDatabase() {
  await env.AUTH_DB.prepare(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      role TEXT DEFAULT 'user',
      password_reset_required BOOLEAN DEFAULT FALSE
    )
  `).run();
}

await setupDatabase();
```

### Mocking

Tests use Vitest's mocking capabilities:

```typescript
import { vi } from "vitest";

// Mock logger to prevent console spam
vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
```

## Writing Tests

### Basic Test Structure

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

describe("My Feature", () => {
  beforeEach(async () => {
    // Clean up before each test
    await env.AUTH_DB.prepare("DELETE FROM user").run();
  });

  it("should work correctly", async () => {
    // Arrange
    const testData = { email: "test@example.com" };

    // Act
    const result = await myFunction(env, testData.email);

    // Assert
    expect(result).toBeDefined();
    expect(result.email).toBe(testData.email);
  });
});
```

### Accessing Cloudflare Bindings

Tests have full access to Cloudflare bindings:

```typescript
import { env } from "cloudflare:test";

// D1 Database
await env.AUTH_DB.prepare("SELECT * FROM user").all();

// KV Namespace
await env.AUTH_STORAGE.put("key", "value");
await env.AUTH_STORAGE.get("key");
```

### Test Best Practices

1. **Isolation**: Each test is independent with cleanup in `beforeEach`
2. **Mocking**: External services are mocked using `vi.mock()`
3. **Coverage**: Aim for high coverage on business logic
4. **Fast**: Tests run quickly using in-memory Miniflare environment
5. **Real Bindings**: Tests use actual D1 and KV APIs for accuracy
6. **Descriptive Names**: Test names clearly describe what they test
7. **AAA Pattern**: Arrange, Act, Assert for clear test structure

## Coverage Reports

Coverage reports are generated with:

```bash
pnpm test:coverage
```

Reports are saved in:
- `coverage/` directory (HTML reports)
- Console output (text summary)
- `coverage/coverage-final.json` (JSON data)

Coverage excludes:
- Test files (`*.test.ts`, `*.spec.ts`)
- Main entry points (`index.ts`)
- Client-specific code (`auth-client.ts`)

## Continuous Integration

Tests run automatically in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run tests
  run: pnpm test

- name: Run tests with coverage
  run: pnpm test:coverage
```

## Troubleshooting

### Common Issues

1. **"No such table" errors**
   - Ensure `test-setup.ts` is imported in test files
   - Check database schema matches migrations

2. **"No such module" errors**
   - Verify all dependencies are installed: `pnpm install`
   - Check import paths are correct

3. **Tests timing out**
   - Increase timeout in vitest config
   - Check for infinite loops or unresolved promises

4. **Flaky tests**
   - Ensure proper cleanup in `beforeEach`
   - Avoid shared state between tests
   - Use proper async/await handling

### Debug Mode

Run tests in debug mode:

```bash
# With Node.js debugger
node --inspect-brk ./node_modules/.bin/vitest

# With verbose output
pnpm test -- --reporter=verbose
```

## Test Metrics

Current test coverage:
- **Auth App**: 49 tests across 3 test files
- **Admin App**: Tests pending (vitest configured)
- **Profile App**: Tests pending (vitest configured)

## Future Improvements

- [ ] Add integration tests for full authentication flows
- [ ] Add API endpoint tests using supertest-like library
- [ ] Add performance benchmarks
- [ ] Add mutation testing
- [ ] Increase coverage to 80%+
- [ ] Add visual regression tests for admin UI
- [ ] Add E2E tests with Playwright

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Cloudflare Workers Testing Guide](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Miniflare Documentation](https://miniflare.dev/)
- [Testing Best Practices](https://testingjavascript.com/)
