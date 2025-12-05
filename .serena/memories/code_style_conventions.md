# Code Style and Conventions

## TypeScript
- ES2024 syntax
- ESM modules (`"type": "module"`)
- Strict TypeScript checking
- Use `type` imports where possible

## Naming Conventions
- **Files**: kebab-case (e.g., `user-management.ts`)
- **Variables/Functions**: camelCase
- **Classes/Types/Interfaces**: PascalCase
- **Constants**: SCREAMING_SNAKE_CASE for true constants

## ESLint Rules
- Unused variables: warn (prefix with `_` to ignore)
- `no-explicit-any`: warn (allowed in tests)
- `no-console`: warn (allow `warn`, `error`, `info`, `debug`)
- `prefer-const`: error
- `no-var`: error

## React (Admin App)
- Function components with hooks
- React Router v7 route module exports allowed:
  - `meta`, `links`, `headers`, `loader`, `clientLoader`
  - `action`, `clientAction`, `ErrorBoundary`, `HydrateFallback`
  - `handle`, `shouldRevalidate`
- shadcn/ui variant exports allowed: `badgeVariants`, `buttonVariants`

## Testing
- Test files: `*.test.ts` or `*.spec.ts`
- Use `describe/it/expect` from Vitest
- Clean up in `beforeEach` for isolation
- Mock external services (e.g., Resend)
- Access Cloudflare bindings via `env` from `cloudflare:test`

## Workers-Specific
- Cloudflare Workers globals available (D1Database, KVNamespace, etc.)
- Use Wrangler for local dev and deployment
- D1 for database, KV for session storage

## Imports
- Group imports: external libs, then internal modules
- Use path aliases where configured

## Error Handling
- Use proper error types
- Log errors with context
- Return appropriate HTTP status codes

## Comments
- Only add comments where logic isn't self-evident
- Use JSDoc for public APIs if needed
