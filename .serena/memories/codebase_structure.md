# Codebase Structure

```
AlUmmahNowAuth/
├── apps/
│   ├── auth/              # OpenAuth server (Cloudflare Worker)
│   │   ├── src/           # Source code
│   │   │   ├── index.ts   # Entry point
│   │   │   ├── *.test.ts  # Unit tests
│   │   │   └── ...        # Auth logic, subjects, providers
│   │   ├── migrations/    # D1 database migrations
│   │   ├── wrangler.json  # Wrangler config
│   │   └── vitest.config.ts
│   │
│   ├── admin/             # Admin dashboard (React Router v7)
│   │   ├── app/
│   │   │   ├── routes/    # React Router routes
│   │   │   ├── components/
│   │   │   │   └── ui/    # shadcn/ui components
│   │   │   └── lib/       # Utilities and DB functions
│   │   ├── workers/       # Worker-related code
│   │   ├── scripts/       # Build scripts
│   │   ├── wrangler.json  # Wrangler config
│   │   └── react-router.config.ts
│   │
│   ├── profile/           # Profile app (OAuth client)
│   │   ├── src/
│   │   │   └── index.ts   # OAuth client implementation
│   │   └── wrangler.json
│   │
│   └── audit-consumer/    # Audit event consumer
│       └── ...
│
├── e2e/                   # Playwright E2E tests
├── docs/                  # Documentation files
├── images/                # Image assets
├── .github/               # GitHub workflows and templates
│
├── package.json           # Root package.json (workspace)
├── pnpm-workspace.yaml    # pnpm workspace config
├── eslint.config.js       # ESLint config
├── playwright.config.ts   # Playwright config
│
├── README.md              # Main documentation
├── ARCHITECTURE.md        # Architecture overview
├── QUICKSTART.md          # Quick start guide
├── API_REFERENCE.md       # API documentation
├── TESTING.md             # Testing guide
├── CONTRIBUTING.md        # Contribution guidelines
└── ...                    # Other docs
```

## Key Files by App

### Auth App
- `src/index.ts` - Main entry, OpenAuth configuration
- `src/users.ts` - User management functions
- `src/session.ts` - Session management
- `src/email.ts` - Email sending
- `migrations/` - D1 schema migrations

### Admin App
- `app/routes/` - Route modules (loaders, actions, components)
- `app/components/ui/` - shadcn/ui components
- `app/lib/` - Shared utilities, DB helpers
- `workers/` - Server-side worker code

### Shared Resources
- All apps share the same D1 database (`AUTH_DB`)
- Auth and Profile share KV storage (`AUTH_STORAGE`)
