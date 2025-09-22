# AlUmmahNowAuth OpenAuth Server

OpenAuth server implementation running on Cloudflare Workers with D1 database and KV storage for authentication state management. This is a TypeScript-based authentication service using the OpenAuth library.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

### Bootstrap and Build the Repository
- Install dependencies: `npm install` -- takes ~13 seconds
- Check TypeScript compilation and build: `npm run check` -- takes ~3 seconds. NEVER CANCEL.
- Generate TypeScript types: `npm run types` -- takes <1 second

### Development Server
- Start development server: `npm run dev` -- takes ~10 seconds to start. NEVER CANCEL.
- Server runs on `http://localhost:8787`
- Dev server includes hot reload and simulates Cloudflare Workers environment locally
- All Cloudflare bindings (D1, KV, Secrets) are simulated locally via Miniflare

### Deployment Commands  
- Deploy to Cloudflare: `npm run deploy` -- requires proper Cloudflare credentials
- Pre-deployment database migration: `npm run predeploy` -- applies D1 migrations to remote database

## Validation

### Manual Testing Requirements
Always manually validate authentication flows after making changes:

1. **Registration Flow Test**:
   - Navigate to `http://localhost:8787/authorize?response_type=code&client_id=test&redirect_uri=http://localhost:3000/callback`
   - Click "Register" link
   - Fill in email, password, and repeat password
   - Submit form - should attempt email sending (will fail locally due to missing RESEND_API_KEY secret)

2. **Login Flow Test**:
   - Navigate to authorization URL above
   - Enter email and password
   - Submit form - should show code input field (email sending will fail locally)

3. **Expected Local Behavior**:
   - Registration/login forms display correctly with "Al Ummah Now" branding
   - Email sending fails with "Secret RESEND_API_KEY not found" error (expected in local dev)
   - Server logs show proper HTTP status codes (200, 302)
   - Database operations work correctly

### Build Validation
- Always run `npm run check` before committing changes
- Ensure TypeScript compilation succeeds without errors
- No linting tools are configured - manual code review required

## Database and Storage

### D1 Database Setup
- Database name: `al-ummah-now-d1`
- Binding: `AUTH_DB`
- Migrations located in `migrations/` directory:
  - `0001_create_user_table.sql` - User table with id, email, created_at
  - `0002_create_clients_table.sql` - Client configuration table

### KV Storage
- Namespace binding: `AUTH_STORAGE`
- Used by OpenAuth for session state management

### Secrets
- `RESEND_API_KEY` - Required for email sending in production
- Stored in Cloudflare Secrets Store, simulated locally

## Key File Structure

### Source Code (`src/`)
- `index.ts` - Main OpenAuth server configuration and handler
- `email.ts` - Email sending functionality using Resend API
- `users.ts` - User database operations
- `clients.ts` - Client configuration management

### Configuration Files
- `wrangler.json` - Cloudflare Workers configuration with bindings
- `tsconfig.json` - TypeScript compiler configuration
- `package.json` - Dependencies and npm scripts
- `worker-configuration.d.ts` - Auto-generated Cloudflare Workers types

### Database Migrations
- `migrations/` - D1 database schema migrations
- Apply with: `npx wrangler d1 migrations apply AUTH_DB --remote`

## Common Development Tasks

### Making Code Changes
1. Start dev server: `npm run dev`
2. Make changes to TypeScript files in `src/`
3. Test changes manually using browser at `http://localhost:8787`
4. Run build check: `npm run check`
5. Commit changes

### Debugging Authentication Issues
- Check server logs in the `npm run dev` terminal output
- Verify database bindings are working (logs show D1Database and KvNamespace objects)
- Test registration flow to see email sending attempts
- Expected error in local dev: "Secret RESEND_API_KEY not found"

### Adding New Features
- Always update TypeScript types: `npm run types`
- Follow existing patterns in `src/index.ts` for OpenAuth configuration
- Test thoroughly with manual auth flows
- Update database schema with new migrations if needed

## Timing and Performance Expectations

- **Build check**: 3 seconds - Set timeout to 30+ seconds to be safe
- **Development server startup**: 10 seconds - Set timeout to 60+ seconds
- **Type generation**: <1 second - Set timeout to 30+ seconds
- **Dependency installation**: 13 seconds - Set timeout to 300+ seconds

**NEVER CANCEL** any of these operations - they are fast but may occasionally take longer depending on network conditions.

## Technology Stack Summary

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Authentication**: OpenAuth library
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare KV
- **Email**: Resend API
- **Build Tool**: Wrangler CLI
- **Local Development**: Miniflare simulation

## Known Limitations

- No testing framework configured
- No linting tools (ESLint, Prettier) configured  
- Email functionality requires production Cloudflare Secrets Store setup
- Local development simulates all Cloudflare services
- Wrangler version in project (4.12.0) is outdated (4.38.0 available)