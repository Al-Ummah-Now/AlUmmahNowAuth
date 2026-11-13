# CI/CD Documentation

## Overview

The Al Ummah Now Auth system uses GitHub Actions for continuous integration and continuous deployment (CI/CD). This document covers the automated workflows, deployment processes, and best practices.

## Table of Contents

- [GitHub Actions Workflows](#github-actions-workflows)
- [Release gates](#release-gates)
- [Deployment Environments](#deployment-environments)
- [Automated Testing](#automated-testing)
- [Deployment Process](#deployment-process)
- [Secrets Management](#secrets-management)
- [Branch Strategy](#branch-strategy)
- [Troubleshooting](#troubleshooting)

## GitHub Actions Workflows

### Test Suite Workflow (`test.yml`)

**Trigger**: Push to `main`, Pull requests to `main`

**Jobs**:

#### 1. Lint and Type Check
- Install dependencies via pnpm
- Run TypeScript type checking across all apps
- Verify auth app can be deployed (dry run)

#### 2. Security Check
- Audit dependencies for high-severity vulnerabilities
- Scan for hardcoded secrets in source code
- Exclude markdown and test files from secret scanning

#### 3. Documentation Check
- Verify presence of required documentation files:
  - `README.md`
  - `USER_MANAGEMENT.md`
  - `CICD.md`

#### 4. Migration Check
- List all SQL migration files
- Validate basic SQL syntax
- Ensure migrations contain valid SQL keywords

**Example**:
```yaml
jobs:
  lint-and-type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
      - run: pnpm install
      - run: pnpm run type-check
```

### Release Workflow (`release.yml`)

**Trigger**: push to `main` (every merge), or run by hand. One release at a time
(`concurrency: auth-release`, never cancelled half-way).

| Job | What it does |
|---|---|
| **Build once** | Type check, `check:config`, `check:schema`, `test:scripts`; bundles auth and profile (`wrangler deploy --dry-run --outdir dist/…`), builds admin and derives its stage config. The same files go to stage and production. |
| **Stage** | `stage:seed` (migrations, roles, prod's live redirect URIs with stage hosts); `check:secrets --env stage` (every stage worker has its required secrets and client ids); deploys the candidates to stage with the same promote mechanics as production; deploys the audit consumer; runs the release regressions and auth E2E on stage. |
| **Production** | `check:secrets --env production` (fails the release before anything changes); `d1-migrate.ts --env production` (expand-only migrations); `promote.ts --env production`: upload versions → candidates at 0% → wait until the override serves the candidate → smoke through `Cloudflare-Workers-Version-Overrides` → 100% + `triggers deploy` → smoke → automatic rollback on any failure. Result in the job summary and the `release-result` artifact. |

A failed stage job stops the release: production is not touched. If `main` has
moved on while a release runs (a newer merge is queued behind it), the
production job promotes nothing and says so in the summary; the newer run
releases the newer commit, so a candidate built before a later merge is never
promoted. The audit
consumer is not deployed to production by CI (it never was); deploy it by hand
until that is decided (see docs/release-pipeline.md).

### Rollback Workflow (`rollback.yml`)

One click: **Actions → Rollback → Run workflow** (environment, `all` or one
worker, optional version id). Same as `pnpm release:rollback`. Code only:
migrations stay applied (they are expand-only).

The target is resolved from `wrangler deployments list` (the version served
before the current one, or `--to`). **Dry run** (`--dry-run`, or the workflow's
dry-run box) resolves and prints the targets, then stops before moving traffic.
Use it to check what a rollback would do on production. A real rollback after a
release that changed sign-in or the database puts users on code that may not
match their cookies or the migrated D1, so prefer a fix-forward there and
drill rollbacks on stage.

## Release gates

These run on every PR (`test.yml` → **Release Checks**) and are part of the release pipeline (see [docs/release-pipeline.md](docs/release-pipeline.md)). Run them locally before pushing:

| Command | Fails when | Fix |
|---|---|---|
| `pnpm check:config` | A deployed wrangler env is wrong: auth `env.production` without `ENVIRONMENT=production`, the prod issuer, or the Secrets Store bindings; a test-only binding in prod; a localhost value; a non-prod route. Also fails on any `wrangler deploy` / `versions upload` for auth without `--env` or `--config` (the 2026-11-07 incident). | Fix the config or command. Rules live in `scripts/release/apps.ts`. |
| `pnpm check:migrations <base>` | An existing file in `apps/*/migrations*/` was modified, deleted or renamed, or a new one sorts before the latest. | Add a new migration instead. |
| `pnpm check:schema` | `apps/auth/schema.snapshot.sql` / `schema.qa.snapshot.sql` don't match what the migrations (openauth + app) produce. | `pnpm schema:snapshot` and commit the result with the migration. |
| `pnpm test:scripts` | The release scripts' own tests fail. | |

The release workflow runs `check:config`, `check:schema` and `test:scripts` again in its build job.

`GET /health?deep=1` on any auth deployment reports, as booleans, whether D1, KV, the audit queue and each required Secrets Store secret resolve (HTTP 503 if any don't). Release smoke tests use it. Plain `/health` stays dependency-free.

## Deployment Environments

### Local Development

**Auth Server**:
```bash
cd apps/auth
pnpm dev
# Accessible at http://localhost:8787
```

**Admin Dashboard**:
```bash
# Option 1: Fast dev mode (no D1/KV bindings)
cd apps/admin
pnpm dev
# Accessible at http://localhost:5174

# Option 2: Full Wrangler context (with D1/KV)
cd apps/admin
pnpm dev:wrangler
# Accessible at http://localhost:5175
```

**Database Setup**:
```bash
cd apps/auth
pnpm run migrations:local
```

### Preview Environment

**Purpose**: Test changes before merging to production

**Trigger**: Automatically created for each pull request

**Characteristics**:
- Unique URLs per PR
- Shared D1 database with production (use caution)
- Temporary - deleted after PR is merged/closed
- Full Cloudflare Workers environment

**Access**:
- Auth: `https://al-ummah-now-auth-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`
- Admin: `https://al-ummah-now-auth-admin-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`

**Automated Comment**:
GitHub Actions posts a comment on each PR with preview URLs:
```markdown
🚀 **Preview deployments ready!**

🔐 **Auth Server**: https://al-ummah-now-auth-pr-42.mahmoud-s-darwish.workers.dev
🛠️ **Admin Dashboard**: https://al-ummah-now-auth-admin-pr-42.mahmoud-s-darwish.workers.dev

**Test the changes:**
- Test authentication flow with the auth server
- Access the admin dashboard to manage users
- Both apps share the same D1 database
```

### Stage Environment

**Purpose**: the release candidate's test slot. Same code and config shape as
production, separate data. See `docs/release-pipeline.md` and AlUmmahNow's
`docs/release-pipeline/SPEC.md` for the full design.

| Worker | Hostname |
|--------|----------|
| `al-ummah-now-auth-stage` | `https://auth.stage.alummahnow.net` |
| `al-ummah-now-profile-stage` | `https://profile.auth.stage.alummahnow.net` |
| `al-ummah-now-auth-admin-stage` | `https://admin.auth.stage.alummahnow.net` |
| `al-ummah-now-audit-consumer-stage` | (queue consumer, no route) |

**Config**: `env.stage` in each app's wrangler file, next to `env.production`.
`pnpm check:config` fails if stage drifts from production (bindings, vars) or if
a stage binding points at a production resource.

**Data**: D1 `al-ummah-now-d1-stage`, its own KV namespace, queue
`audit-events-stage` (+ DLQ) and Secrets Store secrets with a `_STAGE` suffix.
No production user data. `pnpm stage:seed` brings the stage D1 to the production
schema (openauth + app migrations), seeds roles and copies the clients'
**live** production redirect URIs with stage hostnames (read-only query on prod).
It refuses to run unless the target DB name ends in `-stage`.

**Rate limits**: stage uses production defaults (QA uses higher ones), so
rate-limit bugs show up on stage. E2E addresses (`@e2e.alummahnow.net`) are
limited per address rather than per IP while the code sink is active.

**Commands**:

```bash
pnpm deploy:stage           # seed + deploy all four stage workers
pnpm smoke --env stage      # issuer, JWKS, deep health, authorize per client, home pages
E2E_AUTH_SERVER_URL=https://auth.stage.alummahnow.net \
E2E_PROFILE_URL=https://profile.auth.stage.alummahnow.net \
E2E_ADMIN_URL=https://admin.auth.stage.alummahnow.net \
E2E_CODE_SINK_SECRET=... TEST_PROMOTE_SECRET=... \
  npx playwright test e2e/tests/release e2e/tests/auth/forgot-password.spec.ts
```

The release workflow (phase 4) runs these automatically before promoting to
production.

### Production Environment

**Purpose**: Live production system

**Trigger**: Push to `main` branch

**Characteristics**:
- Stable, tested code only
- Database migrations applied automatically
- Full monitoring and logging
- High availability via Cloudflare Workers

**Access**:
- Auth: `https://al-ummah-now-auth.alummahnow.workers.dev`
- Admin: `https://al-ummah-now-auth-admin.alummahnow.workers.dev`

## Automated Testing

### Type Checking

**Command**: `pnpm run type-check`

**Coverage**:
- All TypeScript files in both apps
- Type safety across shared dependencies
- React Router type generation

**Configuration**:
```json
// apps/admin/tsconfig.json
{
  "exclude": [".react-router/types/**/*"],
  "compilerOptions": {
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

### Security Auditing

**Dependency Audit**:
```bash
pnpm audit --audit-level high
```

**Secret Scanning**:
```bash
grep -r -E "(password|secret|key|token)[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9+/=]{16,}['\"]" apps/
```

**Exclusions**:
- `node_modules/`
- `*.md` files
- `test-*` files

### Migration Validation

**Checks**:
1. All migration files exist in `apps/auth/migrations/`
2. Files follow naming convention: `XXXX_description.sql`
3. Each file contains valid SQL keywords
4. Migrations are sequential

**Example Migration**:
```sql
-- 0003_add_user_role.sql
ALTER TABLE user ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX idx_user_role ON user(role);
```

### Build Validation

**Auth App**:
```bash
cd apps/auth
pnpm exec wrangler deploy --dry-run
```

**Admin App**:
```bash
cd apps/admin
pnpm run build
```

## Deployment Process

### Manual Deployment

**Deploy Both Apps**:
```bash
pnpm deploy
```

**Deploy Individual Apps**:
```bash
# Auth server only
pnpm deploy:auth

# Admin dashboard only
pnpm deploy:admin
```

**With Migrations**:
```bash
# Apply production migrations first
cd apps/auth
pnpm run migrations:remote

# Then deploy
pnpm deploy:auth
```

### Automated Deployment

Every merge to `main` runs `release.yml` (above): build once → stage → E2E →
secrets check → production at 0% → smoke → 100% → smoke. There are no per-PR preview deployments;
PRs never deploy to QA or test against it (owner rule 2026-11-13: tests run against QA only with
releases). A push to `main` deploys QA (`test.yml` → `qa-e2e.yml`) and runs there only the specs
stage E2E leaves out (admin, profile, integration, the "code delivery failure" specs).

Manual production deploys (`pnpm deploy:auth` etc.) bypass stage. Use them only
to recover when the workflow itself is broken.

### Rollback Process

```bash
pnpm release:rollback --env production                    # every worker, previous version
pnpm release:rollback --env production --app auth --to <version-id>
```

or **Actions → Rollback**. Both run the smoke afterwards and exit non-zero if it
fails. Version ids for each release are in the release run's summary.

**Database**: never rolled back. Migrations are expand-only (add tables, columns,
indexes); code that no longer needs a column stops using it, and a later
release drops it once no deployed version reads it.

## Secrets Management

### Required Secrets

#### GitHub Repository Secrets

Configure in: `Settings → Secrets and variables → Actions`

| Secret Name | Description | Used By |
|-------------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for deployments | All deployment jobs |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account identifier | All deployment jobs |

**Creating Cloudflare API Token**:
1. Log in to Cloudflare Dashboard
2. Navigate to "My Profile" → "API Tokens"
3. Click "Create Token"
4. Use "Edit Cloudflare Workers" template
5. Scope to account and specific zones if needed
6. Copy token and add to GitHub secrets

#### Cloudflare Workers Secrets

**Production Environment Variables**:
```bash
# Auth server
wrangler secret put RESEND_API_KEY --env production

# Admin dashboard (if needed)
wrangler secret put AUTH_SERVER_URL --env production
```

**Setting via Dashboard**:
1. Cloudflare Dashboard → Workers
2. Select your worker
3. Settings → Variables
4. Add environment variable

### Local Development Secrets

**Never commit** `.dev.vars` files:

```env
# apps/auth/.dev.vars (gitignored)
RESEND_API_KEY=re_xxxxxxxxxxxxx
```

## Branch Strategy

### Main Branches

**`main`** (Protected):
- Production-ready code
- All commits trigger production deployment
- Requires PR approval
- All checks must pass

**`develop`** (Optional):
- Integration branch for features
- Pre-production testing
- Runs test suite on push

### Feature Branches

**Naming Convention**:
- `feature/description`
- `fix/description`
- `docs/description`
- `refactor/description`

**Workflow**:
1. Create feature branch from `main`
2. Make changes
3. Open PR to `main`
4. Preview deployments created automatically
5. Review and test in preview environment
6. Merge to `main` after approval
7. Automatic production deployment

### Pull Request Requirements

**Before Merge**:
- ✅ All checks pass (type-check, security, docs, migrations)
- ✅ Preview deployments successful
- ✅ Code review approved
- ✅ No merge conflicts
- ✅ Branch up to date with `main`

## Monitoring and Logging

### Cloudflare Workers Logs

**Real-time Logging**:
```bash
# Auth server
cd apps/auth
pnpm run tail

# Admin dashboard
cd apps/admin
wrangler tail
```

**Log Levels**:
- `debug`: Detailed debugging information
- `info`: General informational messages
- `warn`: Warning messages
- `error`: Error messages with context

**What each environment keeps** (Workers Logs bills per line):

| Worker config | `LOG_LEVEL` var | `logs.head_sampling_rate` | `invocation_logs` | `logpush` |
| --- | --- | --- | --- | --- |
| QA (`wrangler.qa.json[c]`, admin: `scripts/patch-qa-config.js`) | `warn` | 1 | false | false |
| Stage (`env.stage`, admin: `scripts/release/admin-config.ts`) | `warn` | 1 | false | false |
| Production | `debug` (everything) | 1 | default (on) | not set |

`LOG_LEVEL` drops `console.debug/log/info` per isolate in every Auth worker
(auth, profile, admin, audit-consumer; `packages/ui/src/log-level.ts`), including
library output such as openauth's per-attempt `console.log`. QA and stage log every
invocation (no sampling), so no warning or error is sampled away, but no info lines
and no per-request invocation log. No Logpush job reads these workers, so QA/stage
send nothing to Logpush. `wrangler versions deploy` (stage/prod promote) syncs
`observability` and `logpush` from the config it is given.

**Example Log**:
```javascript
logger.error('Auth callback error', {
  error: error.message,
  email: 'user@example.com',
  timestamp: new Date().toISOString()
});
```

### Database Logs

**Stored in D1**:
```sql
SELECT * FROM logs
ORDER BY timestamp DESC
LIMIT 100;
```

**Query via Wrangler**:
```bash
wrangler d1 execute AUTH_DB --command="SELECT * FROM logs ORDER BY timestamp DESC LIMIT 10"
```

### GitHub Actions Logs

**Accessing Logs**:
1. Navigate to repository
2. Click "Actions" tab
3. Select workflow run
4. Click on job to view logs

**Download Logs**:
- Click on workflow run
- Click "..." menu → "Download log archive"

## Troubleshooting

### Issue: Deployment Fails with "Unauthorized"

**Cause**: Invalid or expired Cloudflare API token

**Solution**:
1. Generate new API token in Cloudflare Dashboard
2. Update `CLOUDFLARE_API_TOKEN` secret in GitHub
3. Re-run deployment

### Issue: Type Check Fails in CI but Passes Locally

**Cause**: Different TypeScript versions or missing generated files

**Solution**:
1. Ensure `pnpm-lock.yaml` is committed
2. Run `pnpm install` to sync dependencies
3. Commit any changes to lock file
4. Push and re-run checks

### Issue: Preview Deployment Not Created

**Cause**: Workflow permissions or branch protection

**Solution**:
1. Check workflow permissions in `.github/workflows/release.yml`
2. Verify PR is targeting `main` branch
3. Check workflow logs for errors
4. Ensure secrets are properly configured

### Issue: Database Migration Fails in Production

**Cause**: Migration already applied or syntax error

**Solution**:
1. Check migration history:
   ```bash
   wrangler d1 migrations list AUTH_DB --remote
   ```
2. Test migration locally first:
   ```bash
   pnpm run migrations:local
   ```
3. If needed, create reverse migration
4. Contact team before applying production fixes

### Issue: Build Fails with Module Not Found

**Cause**: Missing dependency or incorrect import path

**Solution**:
1. Check if dependency is in `package.json`
2. Run `pnpm install` to ensure all dependencies installed
3. Verify import paths are correct
4. Check TypeScript configuration (`tsconfig.json`)

## Performance Optimization

### Build Optimization

**Admin Dashboard**:
- Uses Vite for fast builds
- Code splitting for route-based chunks
- CSS minification and bundling
- Asset optimization

**Auth Server**:
- Single-file worker bundle
- Minimal dependencies
- Fast cold starts (~50ms)

### Deployment Speed

**Typical Deployment Times**:
- Type check: ~10 seconds
- Auth server deploy: ~20 seconds
- Admin build: ~10 seconds
- Admin deploy: ~20 seconds
- **Total**: ~60 seconds from push to live

### Caching

**GitHub Actions Cache**:
- pnpm dependencies cached
- Node modules cached between runs
- Speeds up CI/CD by ~70%

**Cloudflare Edge Cache**:
- Static assets cached at edge
- API responses cached where appropriate
- Reduced latency for end users

## Best Practices

### 1. Test Locally Before Pushing

```bash
# Run full test suite
pnpm install
pnpm run type-check

# Test auth server
cd apps/auth
pnpm dev

# Test admin dashboard
cd apps/admin
pnpm dev:wrangler
```

### 2. Use Preview Deployments

- Always create PR for changes
- Test in preview environment before merging
- Share preview URLs with team for review

### 3. Database Migrations

- Test migrations locally first
- Make migrations reversible
- Document migration purpose in filename
- Never modify existing migration files

### 4. Keep Dependencies Updated

```bash
# Check for updates
pnpm outdated

# Update dependencies
pnpm update

# Update specific package
pnpm update package-name
```

### 5. Monitor Deployments

- Watch deployment logs
- Check application logs after deployment
- Test critical paths after production deployment
- Keep Cloudflare Dashboard open during deployment

### 6. Security First

- Never commit secrets
- Use `.dev.vars` for local development
- Use Cloudflare secrets for production
- Run security audits regularly
- Review dependency vulnerabilities

## Additional Resources

- [Main README](./README.md)
- [User Management Guide](./USER_MANAGEMENT.md)
- [Project Roadmap](./ROADMAP.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)

## Support

For CI/CD issues:
1. Check workflow logs in GitHub Actions
2. Review Cloudflare deployment logs
3. Consult this documentation
4. Create issue with `ci/cd` label
5. Contact DevOps team if urgent
