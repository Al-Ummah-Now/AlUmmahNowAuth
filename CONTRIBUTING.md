# Contributing to Al Ummah Now Auth

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the Al Ummah Now authentication system.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Style Guidelines](#code-style-guidelines)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Code Review Standards](#code-review-standards)
- [Project Structure](#project-structure)
- [Common Tasks](#common-tasks)

## Code of Conduct

### Our Standards

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on what is best for the community
- Show empathy towards other community members
- Respect differing viewpoints and experiences

### Unacceptable Behavior

- Harassment, discriminatory language, or personal attacks
- Trolling, insulting/derogatory comments
- Publishing others' private information
- Other conduct which could reasonably be considered inappropriate

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- **Node.js 18+** or **Node.js 20+**
- **pnpm 9.0.0+** - Package manager
- **Git** - Version control
- **Cloudflare account** - For testing deployments (optional)
- **Code editor** - VS Code recommended with TypeScript extensions

### Fork and Clone

1. **Fork the repository** on GitHub
2. **Clone your fork:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/AlUmmahNowAuth.git
   cd AlUmmahNowAuth
   ```
3. **Add upstream remote:**
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/AlUmmahNowAuth.git
   ```

### Install Dependencies

```bash
# Install all dependencies for monorepo
pnpm install
```

### Set Up Local Environment

#### 1. Auth Server

```bash
cd apps/auth

# Copy environment variables
cp .dev.vars.example .dev.vars

# Edit .dev.vars with your values
# RESEND_API_KEY=your_key_here
# PROFILE_APP_URL=http://localhost:8788

# Run database migrations
pnpm migrations:local
```

#### 2. Profile App

```bash
cd apps/profile

# Copy environment variables
cp .dev.vars.example .dev.vars

# Edit .dev.vars
# AUTH_SERVER_URL=http://localhost:8787
```

#### 3. Admin Dashboard

```bash
cd apps/admin

# Copy environment variables
cp .dev.vars.example .dev.vars

# Edit .dev.vars
# AUTH_SERVER_URL=http://localhost:8787
```

### Run Development Servers

```bash
# From project root - runs all apps in parallel
pnpm dev

# Or run individual apps
pnpm dev:auth     # http://localhost:8787
pnpm dev:admin    # http://localhost:5174
pnpm dev:profile  # http://localhost:8788
```

### Verify Setup

1. Visit http://localhost:8788
2. Click "Sign In"
3. Complete email authentication
4. Verify you can see your profile

## Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions/changes
- `chore/` - Maintenance tasks

**Examples:**
```bash
git checkout -b feature/add-mfa-support
git checkout -b fix/session-expiration-bug
git checkout -b docs/update-auth-flows
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

**Format:**
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `style` - Code style changes (formatting, no logic change)
- `refactor` - Code refactoring
- `test` - Adding or updating tests
- `chore` - Maintenance tasks

**Examples:**
```bash
git commit -m "feat(auth): add MFA support with TOTP"
git commit -m "fix(session): resolve session expiration race condition"
git commit -m "docs(readme): update deployment instructions"
git commit -m "test(users): add tests for user creation edge cases"
```

### Keep Your Fork Updated

```bash
# Fetch upstream changes
git fetch upstream

# Merge upstream main into your branch
git checkout main
git merge upstream/main

# Push to your fork
git push origin main
```

## Code Style Guidelines

### TypeScript Standards

- **Use TypeScript strict mode** - No `any` types without justification
- **Explicit return types** - For exported functions
- **Interface over type** - For object shapes (unless using unions)
- **Const assertions** - Use `as const` for literal types

**Good:**
```typescript
export async function getUser(id: string): Promise<User | null> {
  const user = await db.query('SELECT * FROM users WHERE id = ?', id);
  return user || null;
}

interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
}
```

**Bad:**
```typescript
export async function getUser(id) {
  return await db.query('SELECT * FROM users WHERE id = ?', id);
}
```

### Naming Conventions

- **Variables/Functions:** camelCase
- **Classes/Interfaces:** PascalCase
- **Constants:** UPPER_SNAKE_CASE
- **Files:** kebab-case
- **Avoid abbreviations** - Use descriptive names

**Examples:**
```typescript
// Good
const userSession = await getUserSession(request);
const MAX_RETRY_ATTEMPTS = 3;
interface UserProfile { ... }

// Bad
const usrSess = await getUsrSess(req);
const max = 3;
interface UP { ... }
```

### File Organization

```typescript
// 1. Imports (grouped)
import { issuer } from '@openauthjs/openauth';
import * as v from 'valibot';

import { getUser } from './users';
import { logger } from './logger';

// 2. Types/Interfaces
interface SessionData {
  user: User;
  tokens: Tokens;
}

// 3. Constants
const SESSION_TTL = 7 * 24 * 60 * 60;

// 4. Helper functions
function parseToken(token: string): TokenPayload {
  // ...
}

// 5. Exported functions
export async function createSession(): Promise<string> {
  // ...
}

// 6. Default export (if applicable)
export default handler;
```

### Error Handling

- **Always handle errors** - No silent failures
- **Use try-catch** - For async operations
- **Log errors** - Use logger utility
- **Provide context** - Include relevant data in error messages

**Good:**
```typescript
try {
  const user = await getUser(userId);

  if (!user) {
    logger.warn('User not found', { userId });
    return new Response('User not found', { status: 404 });
  }

  return new Response(JSON.stringify(user));
} catch (error) {
  logger.error('Failed to fetch user', {
    userId,
    error: error instanceof Error ? error.message : String(error)
  });
  return new Response('Internal server error', { status: 500 });
}
```

**Bad:**
```typescript
const user = await getUser(userId);
return new Response(JSON.stringify(user));
```

### Async/Await

- **Prefer async/await** - Over promise chains
- **Avoid blocking** - Use `ctx.waitUntil()` for non-critical tasks
- **Parallel operations** - Use `Promise.all()` when possible

**Good:**
```typescript
// Non-blocking log
ctx.waitUntil(logger.finalizeRequest());

// Parallel operations
const [user, sessions] = await Promise.all([
  getUser(userId),
  getUserSessions(userId),
]);
```

**Bad:**
```typescript
// Blocking log
await logger.finalizeRequest();

// Sequential when could be parallel
const user = await getUser(userId);
const sessions = await getUserSessions(userId);
```

### Comments and Documentation

- **JSDoc for exported functions** - Include description, params, returns
- **Inline comments for complex logic** - Explain "why", not "what"
- **TODO comments** - Include issue number or date

**Good:**
```typescript
/**
 * Create a new session for authenticated user
 *
 * @param storage - KV namespace for session storage
 * @param sessionData - User and token data to store
 * @returns Session token (UUID)
 */
export async function createSession(
  storage: KVNamespace,
  sessionData: SessionData
): Promise<string> {
  const sessionToken = crypto.randomUUID();

  // Store with 7-day TTL to match cookie expiration
  await storage.put(
    `session:${sessionToken}`,
    JSON.stringify(sessionData),
    { expirationTtl: 7 * 24 * 60 * 60 }
  );

  return sessionToken;
}
```

## Testing Requirements

### Test Coverage

- **Minimum 80% coverage** - For new code
- **Unit tests required** - For all utility functions
- **Integration tests recommended** - For API endpoints

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for specific app
pnpm --filter auth test

# Watch mode (for TDD)
pnpm --filter auth test:watch

# Coverage report
pnpm test:coverage
```

### Writing Tests

**Test File Location:**
- Place tests in `__tests__` directory
- Or co-locate with source files as `*.test.ts`

**Test Structure:**
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrCreateUser } from '../users';

describe('getOrCreateUser', () => {
  let mockEnv: Env;

  beforeEach(() => {
    // Setup mocks
    mockEnv = {
      AUTH_DB: {
        prepare: vi.fn().mockReturnThis(),
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(),
      },
    } as any;
  });

  it('should return existing user if found', async () => {
    // Arrange
    const existingUser = { id: '123', role: 'user' };
    mockEnv.AUTH_DB.first.mockResolvedValueOnce(existingUser);

    // Act
    const result = await getOrCreateUser(mockEnv, 'test@example.com');

    // Assert
    expect(result).toEqual(existingUser);
    expect(mockEnv.AUTH_DB.prepare).toHaveBeenCalledWith(
      'SELECT id, role FROM user WHERE email = ?'
    );
  });

  it('should create new user if not found', async () => {
    // Arrange
    mockEnv.AUTH_DB.first
      .mockResolvedValueOnce(null) // First call returns null (user not found)
      .mockResolvedValueOnce({ id: '456', role: 'user' }); // Second call returns new user

    // Act
    const result = await getOrCreateUser(mockEnv, 'new@example.com');

    // Assert
    expect(result).toEqual({ id: '456', role: 'user' });
    expect(mockEnv.AUTH_DB.prepare).toHaveBeenCalledWith(
      'INSERT INTO user (email, role, password_reset_required) VALUES (?, "user", FALSE) RETURNING id, role'
    );
  });

  it('should handle database errors gracefully', async () => {
    // Arrange
    mockEnv.AUTH_DB.first.mockRejectedValueOnce(new Error('Database error'));

    // Act & Assert
    await expect(
      getOrCreateUser(mockEnv, 'test@example.com')
    ).rejects.toThrow('Database error');
  });
});
```

### Test Best Practices

1. **AAA Pattern** - Arrange, Act, Assert
2. **One assertion per test** - Or related assertions
3. **Descriptive test names** - Clearly state what is tested
4. **Test edge cases** - Not just happy path
5. **Mock external dependencies** - Database, APIs, etc.

## Pull Request Process

### Before Submitting

1. **Update from upstream:**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run tests:**
   ```bash
   pnpm test
   ```

3. **Check types:**
   ```bash
   pnpm type-check
   ```

4. **Test locally:**
   - Run dev servers
   - Test affected features manually
   - Check browser console for errors

### Creating Pull Request

1. **Push to your fork:**
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open PR on GitHub:**
   - Use descriptive title
   - Follow PR template
   - Link related issues
   - Add screenshots (for UI changes)

3. **PR Template:**
   ```markdown
   ## Description
   Brief description of changes

   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update

   ## Testing
   - [ ] Unit tests pass
   - [ ] Integration tests pass
   - [ ] Manual testing completed

   ## Checklist
   - [ ] Code follows style guidelines
   - [ ] Comments added for complex logic
   - [ ] Documentation updated
   - [ ] No new warnings
   - [ ] Tests added/updated

   ## Related Issues
   Closes #123

   ## Screenshots (if applicable)
   [Add screenshots here]
   ```

### PR Size Guidelines

- **Keep PRs small** - Easier to review
- **Single purpose** - One feature/fix per PR
- **Split large changes** - Into multiple PRs

**Good PR:**
- 100-300 lines of code
- Single feature or bug fix
- Clear commit history

**Bad PR:**
- 1000+ lines of code
- Multiple unrelated changes
- Messy commit history

## Code Review Standards

### For Contributors

**Responding to feedback:**
- Be open to suggestions
- Ask questions if unclear
- Make requested changes promptly
- Push new commits (don't force-push until approved)

### For Reviewers

**Review checklist:**
- [ ] Code follows style guidelines
- [ ] Tests are comprehensive
- [ ] Documentation is updated
- [ ] No security vulnerabilities
- [ ] Performance considerations addressed
- [ ] Error handling is robust

**Review comments:**
- Be constructive and specific
- Explain reasoning
- Suggest improvements
- Acknowledge good work

**Approval criteria:**
- All tests pass
- Code coverage maintained
- No unresolved discussions
- At least one approval from maintainer

## Project Structure

```
AlUmmahNowAuth/
├── apps/
│   ├── auth/                 # OAuth 2.0 server
│   │   ├── src/
│   │   ├── migrations/       # D1 migrations
│   │   └── package.json
│   ├── admin/                # Admin dashboard
│   │   └── ...
│   └── profile/              # Profile app (OAuth client example)
│       └── ...
├── docs/                     # Additional documentation
├── .claude/                  # Claude Code agent configurations
├── ARCHITECTURE.md           # System architecture
├── AUTHENTICATION_FLOWS.md   # Detailed auth flows
├── CONTRIBUTING.md           # This file
├── LICENSE                   # MIT License
├── QUICKSTART.md             # Quick start guide
├── ROADMAP.md                # Feature roadmap
├── SECURITY.md               # Security policy
└── package.json              # Root package.json
```

## Common Tasks

### Add New Database Migration

```bash
cd apps/auth
npx wrangler d1 migrations create AUTH_DB descriptive_name
```

Edit the generated SQL file in `migrations/`:
```sql
-- Migration: descriptive_name
-- Date: 2025-10-12

ALTER TABLE user ADD COLUMN phone_number TEXT;
```

Apply migration:
```bash
pnpm migrations:local  # For local testing
pnpm migrations:remote # For production
```

### Add New Environment Variable

1. **Add to `.dev.vars.example`:**
   ```env
   NEW_VARIABLE=example_value
   ```

2. **Add to `wrangler.json` (if not secret):**
   ```json
   {
     "vars": {
       "NEW_VARIABLE": "production_value"
     }
   }
   ```

3. **Update TypeScript types:**
   ```typescript
   // worker-configuration.d.ts
   interface Env {
     NEW_VARIABLE: string;
   }
   ```

4. **Document in README:**
   Add to environment variables section

### Add New OAuth Client

See [apps/auth/README.md](./apps/auth/README.md#add-new-oauth-client) for detailed instructions.

### Update Dependencies

```bash
# Check for outdated packages
pnpm outdated

# Update specific package
pnpm update package-name

# Update all packages (be cautious)
pnpm update

# Test after updating
pnpm test
pnpm type-check
```

### Debug Issues

1. **Check logs:**
   ```bash
   # Auth server logs
   pnpm --filter auth tail

   # Or in browser
   # http://localhost:8787/logs
   ```

2. **Query database:**
   ```bash
   cd apps/auth
   npx wrangler d1 execute AUTH_DB --local \
     --command="SELECT * FROM user LIMIT 10"
   ```

3. **Clear KV data:**
   ```bash
   # Local
   rm -rf .wrangler/state

   # Remote (use Cloudflare dashboard)
   ```

4. **Enable debug mode:**
   ```typescript
   // In src/index.ts
   logger.setDatabase(env.AUTH_DB, true); // Verbose logging
   ```

## Getting Help

- **Documentation:** Check README files and architecture docs
- **Issues:** Search existing issues on GitHub
- **Discussions:** Use GitHub Discussions for questions
- **Security:** Email security@alummahnow.net (security issues only)

## Recognition

Contributors will be recognized in:
- GitHub contributors page
- Release notes (for significant contributions)
- CONTRIBUTORS.md file (coming soon)

Thank you for contributing to Al Ummah Now Auth!

---

**Last Updated:** October 12, 2025
