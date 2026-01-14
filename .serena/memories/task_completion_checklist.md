# Task Completion Checklist

When a task is completed, run these checks:

## 1. Type Checking
```bash
pnpm type-check
```
Ensure no TypeScript errors.

## 2. Linting
```bash
pnpm lint
```
Fix any linting issues:
```bash
pnpm lint:fix
```

## 3. Unit Tests
```bash
pnpm test
```
All tests should pass. If you modified functionality, ensure tests are updated.

## 4. E2E Tests (if UI/flow changes)
```bash
# Start dev servers first
pnpm dev

# In another terminal
pnpm test:e2e
```

## 5. Build Verification
```bash
pnpm build
```
Ensure all apps build successfully.

## Order of Operations
1. `pnpm type-check` - Catch type errors first
2. `pnpm lint:fix` - Auto-fix style issues
3. `pnpm test` - Run unit tests
4. `pnpm build` - Verify builds work
5. (Optional) `pnpm test:e2e` - If UI changes

## Before Committing
- Ensure working tree is clean after running checks
- Write meaningful commit messages
- Reference issue numbers if applicable

## CI/CD Notes
- GitHub Actions will run these checks on PR
- Preview deployments are auto-created for PRs
- Main branch deployments are automatic
