# E2E Testing Guide

## Overview

This guide explains how to run and maintain End-to-End (E2E) tests for the Al Ummah Now Authentication system. E2E tests use Playwright to test complete user flows across all three applications: Auth Server, Admin Dashboard, and Profile App.

## Prerequisites

- Node.js 20+
- pnpm 9+
- All apps running locally (or CI environment)

## Installation

E2E test dependencies are already included in the workspace. If you need to reinstall:

```bash
# Install all dependencies (includes Playwright)
pnpm install

# Install Playwright browsers
npx playwright install chromium
```

## Running E2E Tests

### Quick Start

```bash
# 1. Start all services (in one terminal)
pnpm dev

# 2. Run E2E tests (in another terminal)
pnpm test:e2e
```

### All Test Commands

```bash
# Run all E2E tests (headless)
pnpm test:e2e

# Run with UI mode (interactive)
pnpm test:e2e:ui

# Run in debug mode (step through tests)
pnpm test:e2e:debug

# Run with visible browser (headed mode)
pnpm test:e2e:headed

# Show HTML test report
pnpm test:e2e:report

# Run specific test file
pnpm exec playwright test e2e/tests/auth/login-flow.spec.ts

# Run specific test by name
pnpm exec playwright test --grep "should complete full login flow"

# Run tests in specific browser
pnpm exec playwright test --project=chromium
pnpm exec playwright test --project=firefox
pnpm exec playwright test --project=webkit
```

## Test Structure

```
e2e/
├── tests/                          # Test files organized by feature
│   ├── auth/                       # Authentication tests
│   │   ├── login-flow.spec.ts      # Email login flow
│   │   └── logout-flow.spec.ts     # Logout functionality
│   ├── admin/                      # Admin dashboard tests
│   │   ├── user-create.spec.ts     # User creation
│   │   ├── user-edit.spec.ts       # User editing
│   │   └── user-delete.spec.ts     # User deletion
│   ├── profile/                    # Profile app tests
│   │   └── session-management.spec.ts # Session handling
│   └── integration/                # Full integration tests
│       └── full-oauth-flow.spec.ts # Complete OAuth flow
├── fixtures/                       # Reusable test helpers
│   ├── auth.ts                     # Auth helper functions
│   └── admin.ts                    # Admin helper functions
├── utils/                          # Utility functions
│   ├── test-data.ts                # Test data generators
│   ├── db-cleanup.ts               # Database cleanup
│   └── email-interceptor.ts        # Email mocking
└── playwright.config.ts            # Playwright configuration
```

## Test Coverage

### Authentication Tests
- ✅ Email-based login flow
- ✅ Logout functionality
- ✅ Invalid email handling
- ✅ Session persistence across reloads
- ✅ Session cookie attributes

### OAuth Tests
- ✅ Full OAuth authorization code flow
- ✅ Authorization URL parameters
- ✅ Token exchange
- ✅ Redirect handling
- ✅ Cross-tab session sharing

### Admin Dashboard Tests
- ✅ User creation (user and admin roles)
- ✅ User editing (email and role)
- ✅ User deletion with confirmation
- ✅ Duplicate user handling
- ✅ Dashboard statistics
- ✅ Input validation

### Profile App Tests
- ✅ Profile view
- ✅ Session management
- ✅ Session persistence
- ✅ Corrupted session handling
- ✅ Cross-browser session isolation

## Writing New Tests

### Basic Test Structure

```typescript
import { test, expect } from '@playwright/test';
import { login } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    // Setup before each test
    await login(page, TEST_USERS.user.email);
  });

  test('should do something', async ({ page }) => {
    // Arrange
    await page.goto(TEST_URLS.profileApp);

    // Act
    await page.click('button:has-text("Action")');

    // Assert
    await expect(page.locator('.result')).toBeVisible();
  });
});
```

### Using Fixtures

```typescript
import { login, logout, getCurrentUser } from '../../fixtures/auth';
import { createUser, editUser, deleteUser } from '../../fixtures/admin';

// Login helper
await login(page, 'user@example.com');

// Create user helper
await createUser(page, { email: 'new@example.com', role: 'user' });

// Get current user info
const user = await getCurrentUser(page);
```

### Test Data

```typescript
import { TEST_USERS, generateTestEmail, TEST_URLS } from '../../utils/test-data';

// Use predefined test users
const admin = TEST_USERS.admin;
const user = TEST_USERS.user;

// Generate unique email
const uniqueEmail = generateTestEmail('my-test');

// Use test URLs
await page.goto(TEST_URLS.profileApp);
```

## Debugging Tests

### UI Mode (Recommended)

```bash
pnpm test:e2e:ui
```

This opens an interactive UI where you can:
- See all tests
- Run individual tests
- Watch tests execute
- Inspect DOM at each step
- View test artifacts

### Debug Mode

```bash
pnpm test:e2e:debug
```

This opens Playwright Inspector where you can:
- Step through tests line by line
- Set breakpoints
- Inspect page state
- Execute commands in console

### Viewing Test Reports

```bash
# After tests run, view HTML report
pnpm test:e2e:report
```

The report includes:
- Test results
- Screenshots on failure
- Videos on failure
- Trace files for debugging

### Common Issues

#### Services Not Running

**Error**: `Error: connect ECONNREFUSED 127.0.0.1:8787`

**Solution**: Start all services first
```bash
pnpm dev
```

#### Browser Not Installed

**Error**: `Error: browserType.launch: Executable doesn't exist`

**Solution**: Install Playwright browsers
```bash
npx playwright install chromium
```

#### Port Already in Use

**Error**: `Port 8787 is already in use`

**Solution**: Stop existing services
```bash
# Find and kill processes
lsof -ti:8787 | xargs kill
lsof -ti:5175 | xargs kill
lsof -ti:8788 | xargs kill
```

#### Test Timeout

**Error**: `Test timeout of 30000ms exceeded`

**Solution**: Increase timeout in test
```typescript
test('slow test', async ({ page }) => {
  test.setTimeout(60000); // 60 seconds
  // ... test code
});
```

## CI/CD Integration

### GitHub Actions

E2E tests run automatically on:
- Pull requests to `main`
- Pushes to `main` and `develop`

#### Workflow Steps

1. Checkout code
2. Install dependencies
3. Install Playwright browsers
4. Apply database migrations
5. Start all services in background
6. Wait for services to be ready
7. Run E2E tests
8. Upload test artifacts (reports, videos, screenshots)
9. Stop services

#### Viewing CI Test Results

1. Go to Actions tab in GitHub
2. Click on the workflow run
3. Download artifacts:
   - `e2e-test-results` - HTML report and test results
   - `e2e-test-videos` - Videos of failed tests (if any)

### Local CI Simulation

Run tests exactly as CI does:

```bash
# Set CI environment variable
export CI=true

# Start services manually
pnpm dev &

# Wait for services
sleep 10

# Run tests
pnpm test:e2e

# Stop services
pkill -f "wrangler dev"
```

## Performance Optimization

### Parallel Execution

Tests run in parallel by default. Configure in `playwright.config.ts`:

```typescript
export default defineConfig({
  workers: 4, // Number of parallel workers
});
```

### Test Isolation

Each test runs in a fresh browser context:
- No shared state between tests
- Independent cookies and storage
- Clean database state (via cleanup utilities)

### Fast Feedback

```bash
# Run only changed tests
pnpm exec playwright test --only-changed

# Run tests matching pattern
pnpm exec playwright test --grep "login"

# Run until first failure
pnpm exec playwright test --max-failures=1
```

## Best Practices

### 1. Use Fixtures

Create reusable helpers in `e2e/fixtures/`:

```typescript
// Good
await login(page, testUser.email);

// Avoid
await page.goto('/login');
await page.fill('input[type="email"]', testUser.email);
// ... multiple lines of repeated code
```

### 2. Generate Unique Test Data

```typescript
// Good - unique email for each test
const email = generateTestEmail('my-test');

// Avoid - hardcoded email (conflicts between tests)
const email = 'test@example.com';
```

### 3. Use Explicit Waits

```typescript
// Good - wait for element to be visible
await expect(page.locator('.result')).toBeVisible();

// Avoid - implicit wait
await page.waitForTimeout(1000);
```

### 4. Clean Up After Tests

```typescript
test.afterEach(async ({ page }) => {
  // Clean up test data
  await deleteTestUsers();
});
```

### 5. Test Real User Flows

```typescript
// Good - test complete flow
test('user can create and edit profile', async ({ page }) => {
  await login(page, testUser.email);
  await createProfile(page, profileData);
  await editProfile(page, updatedData);
  await verifyProfile(page, updatedData);
});

// Avoid - testing implementation details
test('profile API returns 200', async () => {
  // Don't test APIs directly in E2E tests
});
```

## Maintenance

### Updating Tests

When adding new features:
1. Write E2E tests alongside feature development
2. Add tests to appropriate directory
3. Update fixtures if adding reusable helpers
4. Run tests locally before committing

### Handling Flaky Tests

If a test fails intermittently:
1. Add explicit waits
2. Increase timeouts if needed
3. Check for race conditions
4. Use Playwright's auto-retry mechanisms

### Test Data Management

- Clean up test data after each run
- Use unique identifiers (timestamps, UUIDs)
- Never use production data
- Mock external services (emails, webhooks)

## Support

For issues or questions:
- Check existing tests for examples
- Review Playwright documentation: https://playwright.dev
- Open an issue on GitHub
- Ask in project discussions

## Quick Reference

```bash
# Essential commands
pnpm dev                  # Start all services
pnpm test:e2e            # Run E2E tests
pnpm test:e2e:ui         # Interactive UI mode
pnpm test:e2e:debug      # Debug mode
pnpm test:e2e:report     # View HTML report

# Playwright CLI
npx playwright test                    # Run tests
npx playwright test --ui              # UI mode
npx playwright test --debug           # Debug mode
npx playwright show-report           # Show report
npx playwright codegen               # Generate tests
npx playwright test --headed         # See browser
npx playwright test --project=firefox # Specific browser
```

## Example Test Execution

```bash
# Full workflow
$ pnpm dev                              # Start services
✓ Auth Server running on :8787
✓ Admin Dashboard running on :5175
✓ Profile App running on :8788

$ pnpm test:e2e                         # Run E2E tests

Running 24 tests using 4 workers

  ✓ auth/login-flow.spec.ts:5:1 › should complete full login flow
  ✓ auth/logout-flow.spec.ts:5:1 › should logout successfully
  ✓ admin/user-create.spec.ts:7:1 › should create new user
  ✓ admin/user-edit.spec.ts:7:1 › should edit user email
  ✓ admin/user-delete.spec.ts:7:1 › should delete user
  ✓ profile/session-management.spec.ts:5:1 › should persist session
  ✓ integration/full-oauth-flow.spec.ts:7:1 › complete OAuth flow

  24 passed (1.2m)

$ pnpm test:e2e:report                 # View results
```

## Next Steps

- Review the [E2E Testing Strategy](./E2E_TESTING_STRATEGY.md)
- Explore example tests in `e2e/tests/`
- Write tests for new features
- Check CI/CD workflow in `.github/workflows/test.yml`

## Verification codes (E2E code sink)

Test users get `@e2e.alummahnow.net` addresses (`generateTestEmail`). On local, QA and stage, auth does not email codes for that domain. It stores them in KV, and the helpers read them through `GET /test/email/<addr>?consume=1` with the `X-E2E-Secret` header (`e2e/utils/email-interceptor.ts`).

- Local: set `E2E_CODE_SINK_SECRET` in `apps/auth/.dev.vars` and export the same value before `pnpm test:e2e`.
- QA: the worker binds Secrets Store `E2E_CODE_SINK_SECRET_QA`; CI passes GitHub secret `E2E_CODE_SINK_SECRET_QA` to the E2E jobs.
- Without `E2E_CODE_SINK_SECRET`, the helpers fall back to the Resend API (`RESEND_API_KEY`).
- Every `/test/*` route needs the header and answers 404 without it. None of them exist in production. Design and guarantees: `docs/release-pipeline.md`.

Release regression specs live in `e2e/tests/release/` and run in the QA E2E job.
