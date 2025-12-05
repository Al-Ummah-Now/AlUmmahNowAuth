# Suggested Commands

## Package Manager
This project uses **pnpm** (v9.0.0+).

## Development

```bash
# Run all apps concurrently
pnpm dev

# Run individual apps
pnpm dev:auth      # Auth server (port 3301)
pnpm dev:admin     # Admin dashboard (port 3303)
pnpm dev:profile   # Profile app (port 8788)
pnpm dev:consumer  # Audit consumer
```

## Building

```bash
# Build all apps
pnpm build

# Build individual apps
pnpm build:auth
pnpm build:admin
pnpm build:profile
pnpm build:consumer
```

## Testing

### Unit Tests (Vitest)
```bash
pnpm test              # Run all tests
pnpm test:unit         # Run with verbose reporter
pnpm test:watch        # Watch mode
pnpm test:coverage     # With coverage report

# Per-app testing
pnpm --filter auth test
pnpm --filter admin test
pnpm --filter profile test
```

### E2E Tests (Playwright)
```bash
pnpm test:e2e          # Run E2E tests
pnpm test:e2e:ui       # Interactive UI mode
pnpm test:e2e:debug    # Debug mode
pnpm test:e2e:headed   # Headed browser
pnpm test:e2e:report   # View HTML report
```

## Linting & Type Checking

```bash
pnpm lint              # Run ESLint
pnpm lint:fix          # Fix auto-fixable issues
pnpm type-check        # Type check all apps
```

## Database Migrations

```bash
# Local development
cd apps/auth
pnpm migrations:local

# Remote/Production
pnpm migrations:remote

# QA environment
pnpm migrations:qa
```

## Deployment

```bash
# Deploy all apps
pnpm deploy:all

# Deploy individual apps
pnpm deploy:auth
pnpm deploy:admin
pnpm deploy:profile
pnpm deploy:consumer

# QA deployments
pnpm deploy:qa
pnpm deploy:qa:auth
pnpm deploy:qa:admin
```

## Wrangler Commands

```bash
# Generate types
pnpm types

# View logs
cd apps/auth && pnpm tail
```

## Git (Linux)
Standard unix commands work: `git`, `ls`, `cd`, `grep`, `find`
