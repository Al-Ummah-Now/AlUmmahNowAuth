# Al Ummah Now Auth - Project Overview

## Purpose
This is an OpenAuth-based authentication and user management monorepo for Al Ummah Now. It provides:
- Email-based passwordless authentication using OpenAuth
- Admin dashboard for user management
- Profile app (OAuth client example)
- Audit logging for security events

## Tech Stack

### Runtime
- **Cloudflare Workers** - Serverless runtime for all apps
- **D1 Database** - SQLite database (shared across apps)
- **KV Storage** - Key-value storage for sessions

### Auth App (`apps/auth`)
- **@meywd/openauth** - Custom OpenAuth fork with enterprise features
- **Hono** - Lightweight web framework
- **Jose** - JWT handling
- **Resend** - Email delivery
- **Valibot** - Schema validation

### Admin App (`apps/admin`)
- **React 19** - UI library
- **React Router v7** - Routing and SSR
- **shadcn/ui** - UI components (Radix primitives)
- **Tailwind CSS v4** - Styling
- **Lucide Icons** - Icon library

### Profile App (`apps/profile`)
- OAuth 2.0 client implementation
- Demonstrates client-server architecture

### Audit Consumer (`apps/audit-consumer`)
- Cloudflare Queue consumer for audit events

### Development Tools
- **pnpm 9** - Package manager (monorepo)
- **TypeScript 5.9** - Type checking
- **ESLint 9** - Linting
- **Vitest** - Unit testing with Cloudflare Workers pool
- **Playwright** - E2E testing
- **Wrangler** - Cloudflare CLI

## Key Dependencies
- `@meywd/openauth` - Custom OpenAuth fork (v1.0.5+)
- TypeScript 5.9.3
- React 19
- React Router 7
- Tailwind CSS 4

## Development Ports
- Auth server: 3301
- Admin dashboard: 3303
- Profile app: 8788 (default wrangler port)
