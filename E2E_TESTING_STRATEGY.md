# End-to-End Testing Strategy

## Overview

This document outlines the comprehensive E2E testing strategy for the Al Ummah Now Authentication system. The strategy covers all critical user flows across the three applications: Auth Server, Admin Dashboard, and Profile App.

## Testing Framework

**Framework**: Playwright
- **Why Playwright?**
  - Cross-browser support (Chromium, Firefox, WebKit)
  - Built-in waiting and auto-retry mechanisms
  - Excellent debugging tools with trace viewer
  - Works seamlessly with Cloudflare Workers via wrangler dev
  - Strong TypeScript support
  - Parallel test execution
  - Screenshot and video recording on failures

## Test Architecture

### Test Environment Setup

```
e2e/
├── tests/
│   ├── auth/
│   │   ├── login-flow.spec.ts       # Email-based login flow
│   │   ├── logout-flow.spec.ts      # Logout across apps
│   │   └── rate-limiting.spec.ts    # Rate limit scenarios
│   ├── oauth/
│   │   ├── authorization.spec.ts    # OAuth authorization flow
│   │   ├── token-exchange.spec.ts   # Code to token exchange
│   │   └── token-refresh.spec.ts    # Token refresh flow
│   ├── admin/
│   │   ├── user-create.spec.ts      # Create new users
│   │   ├── user-edit.spec.ts        # Edit user details
│   │   ├── user-delete.spec.ts      # Delete users
│   │   ├── user-list.spec.ts        # User listing and search
│   │   └── dashboard.spec.ts        # Dashboard stats
│   ├── profile/
│   │   ├── profile-view.spec.ts     # View user profile
│   │   └── session-management.spec.ts # Session handling
│   └── integration/
│       ├── full-oauth-flow.spec.ts  # Complete OAuth flow
│       ├── admin-password-reset.spec.ts # Password reset flow
│       └── cross-app-session.spec.ts # Session across apps
├── fixtures/
│   ├── auth.ts                      # Auth helpers
│   ├── admin.ts                     # Admin helpers
│   └── users.ts                     # Test user data
├── utils/
│   ├── email-interceptor.ts         # Mock email capture
│   ├── db-cleanup.ts                # Database cleanup utilities
│   └── test-data.ts                 # Test data generators
├── playwright.config.ts             # Playwright configuration
└── global-setup.ts                  # Global test setup
```

## Test Scenarios

### 1. Authentication Flows (Priority: HIGH)

#### 1.1 Email-Based Login (Full Flow)
**Test**: `e2e/tests/auth/login-flow.spec.ts`
- Navigate to profile app
- Click "Sign In" button
- Redirected to auth server
- Enter email address
- Receive login code (mocked)
- Enter valid code
- Successfully authenticated
- Redirected back to profile app
- Profile information displayed

**Success Criteria**:
- All redirects complete successfully
- User session created
- Profile data visible
- Session cookie set correctly

#### 1.2 Logout Flow
**Test**: `e2e/tests/auth/logout-flow.spec.ts`
- User logged in (via fixture)
- Click logout button
- Session cleared from KV
- Redirected to homepage
- User no longer authenticated
- Profile page shows login button

**Success Criteria**:
- Session cookie cleared
- KV session deleted
- User redirected appropriately

#### 1.3 Rate Limiting
**Test**: `e2e/tests/auth/rate-limiting.spec.ts`
- Attempt login 5 times rapidly
- 6th attempt should fail with rate limit error
- Error message shows retry time
- Wait for rate limit window
- Login succeeds after window expires

**Success Criteria**:
- Rate limit enforced after 5 attempts
- Clear error message displayed
- Rate limit resets after cooldown

### 2. OAuth 2.0 Flows (Priority: HIGH)

#### 2.1 Authorization Code Flow
**Test**: `e2e/tests/oauth/authorization.spec.ts`
- Start OAuth flow from profile app
- Verify authorization URL parameters
- User authenticates on auth server
- Authorization code generated
- Redirect to callback with code
- Verify state parameter (if implemented)

**Success Criteria**:
- Correct OAuth parameters
- Authorization code issued
- Proper redirect to callback

#### 2.2 Token Exchange
**Test**: `e2e/tests/oauth/token-exchange.spec.ts`
- Receive authorization code
- Exchange code for tokens
- Receive access and refresh tokens
- Tokens are valid JWT format
- Token contains correct user data

**Success Criteria**:
- Token exchange succeeds
- Access token contains user claims
- Refresh token provided

#### 2.3 Token Refresh (if implemented)
**Test**: `e2e/tests/oauth/token-refresh.spec.ts`
- User has valid refresh token
- Access token expires
- Use refresh token to get new access token
- New access token works correctly

**Success Criteria**:
- Refresh token works
- New access token issued
- Old access token invalidated

### 3. Admin Dashboard CRUD Operations (Priority: HIGH)

#### 3.1 User Creation
**Test**: `e2e/tests/admin/user-create.spec.ts`
- Admin logs in to admin dashboard
- Navigate to user management
- Click "Create User" button
- Fill in email and role
- Submit form
- User created in database
- User appears in user list
- Password reset flag set

**Success Criteria**:
- User created successfully
- Database record exists
- User visible in UI
- Correct role assigned

#### 3.2 User Editing
**Test**: `e2e/tests/admin/user-edit.spec.ts`
- Admin navigates to user list
- Click edit on existing user
- Change email or role
- Submit changes
- Changes saved to database
- Updated data visible in UI

**Success Criteria**:
- Updates saved correctly
- UI reflects changes
- Database updated

#### 3.3 User Deletion
**Test**: `e2e/tests/admin/user-delete.spec.ts`
- Admin navigates to user list
- Click delete on user
- Confirm deletion
- User removed from database
- User no longer in list

**Success Criteria**:
- User deleted from database
- UI updated immediately
- No errors on deletion

#### 3.4 User List and Search
**Test**: `e2e/tests/admin/user-list.spec.ts`
- Admin views user list
- Users displayed in table
- Search by email
- Filter by role
- Pagination works correctly

**Success Criteria**:
- All users displayed
- Search returns correct results
- Filters work properly

#### 3.5 Dashboard Statistics
**Test**: `e2e/tests/admin/dashboard.spec.ts`
- Admin navigates to dashboard
- Total users count displayed
- Admin users count displayed
- Regular users count displayed
- Stats match database counts

**Success Criteria**:
- Accurate statistics
- Real-time updates

### 4. Profile App (Priority: MEDIUM)

#### 4.1 Profile View
**Test**: `e2e/tests/profile/profile-view.spec.ts`
- User logs in
- Profile page displays user ID
- Profile page displays email
- Profile page displays role badge
- Correct styling applied

**Success Criteria**:
- All user data visible
- UI renders correctly

#### 4.2 Session Management
**Test**: `e2e/tests/profile/session-management.spec.ts`
- User logs in
- Session stored in KV
- Session persists across page reloads
- Session expires after 7 days (mock time)
- Expired session redirects to login

**Success Criteria**:
- Session persistence works
- Expiration enforced

### 5. Integration Tests (Priority: HIGH)

#### 5.1 Full OAuth Flow (End-to-End)
**Test**: `e2e/tests/integration/full-oauth-flow.spec.ts`
- Start from profile app (logged out)
- Click login
- Complete auth on auth server
- Redirect to profile app
- View profile data
- Navigate to admin dashboard
- Admin functions work
- Logout from admin
- Verify logout across all apps

**Success Criteria**:
- Complete flow works seamlessly
- No errors or broken redirects
- Sessions work across apps

#### 5.2 Admin-Initiated Password Reset
**Test**: `e2e/tests/integration/admin-password-reset.spec.ts`
- Admin creates new user
- User has password_reset_required flag
- User logs in
- User completes first login
- Password reset flag cleared
- User can log in again

**Success Criteria**:
- Flag set on creation
- Flag cleared on first login
- Subsequent logins work

#### 5.3 Cross-App Session Verification
**Test**: `e2e/tests/integration/cross-app-session.spec.ts`
- User logs in to profile app
- Navigate to admin dashboard (same browser)
- Session recognized
- User authenticated in admin
- Shared KV session works

**Success Criteria**:
- Session shared across apps
- No re-authentication needed

### 6. Error Scenarios (Priority: MEDIUM)

#### 6.1 Invalid Login Code
- User enters wrong code
- Error message displayed
- User can retry

#### 6.2 Expired Login Code
- User waits too long
- Code expires
- User must request new code

#### 6.3 Network Failures
- Simulate network errors
- Proper error handling
- User-friendly messages

#### 6.4 Database Failures
- Simulate DB errors
- Graceful degradation
- Error logging

## Test Data Management

### Test Users
```typescript
const TEST_USERS = {
  admin: {
    email: 'admin-e2e-test@example.com',
    role: 'admin',
  },
  user: {
    email: 'user-e2e-test@example.com',
    role: 'user',
  },
  newUser: {
    email: 'new-user-e2e-test@example.com',
    role: 'user',
  },
};
```

### Database Cleanup
- Run before each test suite
- Delete all test users
- Clear test sessions
- Reset rate limit counters

### Email Mocking
- Intercept email sending
- Capture login codes
- Return codes to tests
- No real emails sent

## Test Execution

### Local Development
```bash
# Start all services in dev mode
pnpm dev

# Run E2E tests (in another terminal)
pnpm test:e2e

# Run specific test file
pnpm test:e2e e2e/tests/auth/login-flow.spec.ts

# Run in UI mode (interactive)
pnpm test:e2e:ui

# Debug mode
pnpm test:e2e:debug
```

### CI/CD Pipeline
```bash
# GitHub Actions workflow
# 1. Start wrangler dev for all apps
# 2. Wait for services to be ready
# 3. Run E2E tests
# 4. Generate test report
# 5. Upload artifacts (screenshots, videos)
# 6. Shut down services
```

## Performance Requirements

- **Total E2E Test Suite**: < 2 minutes
- **Individual Test**: < 10 seconds
- **Setup/Teardown**: < 5 seconds per test
- **Parallel Execution**: 4 workers

## CI Integration

### GitHub Actions Workflow
```yaml
name: E2E Tests

on:
  pull_request:
  push:
    branches: [main]

jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - Checkout code
      - Setup Node.js and pnpm
      - Install dependencies
      - Install Playwright browsers
      - Start wrangler dev for all apps (background)
      - Wait for services health check
      - Run E2E tests
      - Upload test results and artifacts
      - Stop services
```

### Test Reporting
- JUnit XML for CI integration
- HTML report with screenshots
- Video recordings on failure
- Trace files for debugging

## Success Metrics

- ✅ All E2E tests pass
- ✅ 100% critical flow coverage
- ✅ Tests complete in < 2 minutes
- ✅ Zero flaky tests
- ✅ Clear error messages on failures
- ✅ Screenshots/videos on failures
- ✅ CI integration working

## Maintenance Strategy

### Regular Updates
- Update Playwright monthly
- Review and update test scenarios
- Add tests for new features
- Remove tests for deprecated features

### Flaky Test Management
- Retry failed tests automatically (max 2 retries)
- Report flaky tests in CI
- Fix or disable flaky tests immediately

### Test Data
- Isolate test data per test
- Clean up after each test
- Use unique identifiers
- Never use production data

## Security Considerations

- Never commit real credentials
- Use environment variables for secrets
- Mock external services
- Clean up sensitive test data
- Use separate test database bindings

## Next Steps

1. ✅ Document E2E strategy (this document)
2. 🔄 Install Playwright and dependencies
3. 🔄 Create test infrastructure files
4. 🔄 Implement critical flow tests
5. 🔄 Implement admin CRUD tests
6. 🔄 Implement integration tests
7. 🔄 Update CI workflow
8. 🔄 Run full test suite
9. 🔄 Create test documentation

## Appendix: Test Priorities

**Must Have (P0)**: Critical user flows
- Email login flow
- OAuth authorization flow
- Admin user creation
- Admin user deletion

**Should Have (P1)**: Important features
- User editing
- User search
- Profile view
- Session management
- Logout flow

**Nice to Have (P2)**: Edge cases
- Rate limiting
- Error scenarios
- Token refresh
- Session expiration
