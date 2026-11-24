# CI/CD

How a change reaches users. [docs/release-pipeline.md](docs/release-pipeline.md) has the details that are specific to this repository; the [wiki](https://github.com/Al-Ummah-Now/AlUmmahNowWiki/blob/main/guides/release-process.md) covers every repository.

**The short version:** a pull request runs unit tests and checks. A merge to `main` deploys QA, and releases through stage to production. There are no preview deployments, no integration branches and no hand deploys.

## Workflows

| Workflow | Runs on | Does |
|---|---|---|
| `test.yml` | Pull requests, pushes to `main` | Lint, types, dependency audit, unit tests, release gates (below), Arabic hydration. On `main` it also calls `qa-e2e.yml` |
| `qa-e2e.yml` | From `test.yml` on `main` | Deploys QA under a lock and runs the specs stage E2E leaves out. Never on a pull request (owner rule 2026-11-13) |
| `release.yml` | Every push to `main`, or by hand | Build once → stage → production (below) |
| `rollback.yml` | By hand | Puts workers back on an earlier version (below) |
| `secrets-check.yml` | By hand | Every deployed worker has its required secrets and client ids |
| `committed-secrets.yml` | Pull requests, pushes | No secret is committed |
| `local-stack-bundle.yml` | After a release | Publishes the released workers for other repositories' local tests |

### Release Workflow (`release.yml`)

**Trigger**: push to `main` (every merge), or run by hand. One release at a time
(`concurrency: auth-release`, never cancelled half-way).

| Job | What it does |
|---|---|
| **Build once** | Type check, `check:config`, `check:schema`, `test:scripts`; bundles auth and profile (`wrangler deploy --dry-run --outdir dist/…`), builds admin and derives its stage config. The same files go to stage and production. |
| **Stage** | `stage:seed` (migrations, roles, prod's live redirect URIs with stage hosts); `check:secrets --env stage` (every stage worker has its required secrets and client ids); deploys the candidates to stage with the same promote mechanics as production; deploys the audit consumer; runs the release regressions and auth E2E on stage. |
| **Production** | `check:secrets --env production` (fails the release before anything changes); `d1-migrate.ts --env production` (expand-only migrations); `promote.ts --env production`: upload versions → candidates at 0% → wait until the override serves the candidate → smoke through `Cloudflare-Workers-Version-Overrides` → 100% + `triggers deploy` → smoke → automatic rollback on any failure. Result in the job summary and the `release-result` artifact. |
| **Release record** | After a successful promote: a `vYYYY.MM.DD[.N]` GitHub release with the changes, migrations and worker versions (docs/release-pipeline.md). The newest one is what production runs, unless someone rolled back since. |

A failed stage job stops the release: production is not touched. If `main` has
moved on while a release runs (a newer merge is queued behind it), the
production job promotes nothing and says so in the summary; the newer run
releases the newer commit, so a candidate built before a later merge is never
promoted.
The audit consumer is deployed after the migration and before the auth
candidates (docs/release-pipeline.md).

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
| `pnpm check:dev-config` | Local development could reach a deployed environment: an app's dev config (`wrangler.dev.json`, `.jsonc` for the audit consumer) names a production or stage resource id or host, any wrangler config sets `remote: true`, a local script (`wrangler dev`, `--local`) or the admin's Vite dev server runs without the dev config, a deploy ships a dev config, or a dev config is missing a binding from the app's `wrangler.json`. | Point it at local stores (or QA at most). Rules live in `scripts/release/dev-config.ts`. |
| `pnpm check:migrations <base>` | An existing file in `apps/*/migrations*/` was modified, deleted or renamed, or a new one sorts before the latest. | Add a new migration instead. |
| `pnpm check:api` | `openapi.json` takes away something the last release promised, or a deprecation gives too little notice (docs/API_VERSIONING.md). | Keep it, deprecate it first, or record a security fix or spec correction in `docs/api-exceptions.json`. |
| `pnpm check:schema` | `apps/auth/schema.snapshot.sql` / `schema.qa.snapshot.sql` don't match what the migrations (openauth + app) produce. | `pnpm schema:snapshot` and commit the result with the migration. |
| `pnpm test:scripts` | The release scripts' own tests fail. | |

The release workflow runs `check:config`, `check:schema` and `test:scripts` again in its build job.

`GET /health?deep=1` on any auth deployment reports, as booleans, whether D1, KV, the audit queue and each required Secrets Store secret resolve (HTTP 503 if any don't). Release smoke tests use it. Plain `/health` stays dependency-free.

## Environments

### Local

`pnpm dev`: sign-in on port 3301, profile 3302, admin 3303, audit consumer 3304 ([CONTRIBUTING.md](CONTRIBUTING.md)).

Local dev and the `*:local` scripts run on each app's `wrangler.dev.json` (audit consumer: `wrangler.dev.jsonc`): local KV and D1 shared by id (`local-auth-storage`, `local-auth-db`), localhost URLs, never a deployed store. `wrangler.json` is the deploy config; `pnpm check:dev-config` keeps the two apart.

### QA

`auth.qa.alummahnow.net`, `profile.auth.qa.alummahnow.net`, `admin.auth.qa.alummahnow.net`. Deployed from `main` only. Its own database, with its own migration history (`migrations-qa/`).

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

`release.yml` runs these before promoting to production.

### Production

`auth.alummahnow.net`, `profile.auth.alummahnow.net`, `admin.auth.alummahnow.net`. Only `release.yml` deploys it. If CI blocks a release, fix CI in a pull request; a hand deploy skips stage and every check.

## Secrets

- GitHub Actions: `CLOUDFLARE_API_TOKEN` (an organization secret, set only on the steps that call Cloudflare) and `CLOUDFLARE_ACCOUNT_ID`.
- Workers: Secrets Store bindings and worker secrets, listed per environment in `scripts/release/secrets-manifest.ts`. The release fails if one is missing.
- Local: `.dev.vars` files, gitignored.

## Logs

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

## When something fails

| What you see | What to do |
|---|---|
| A red spec | Find the cause. A red test means a real bug, or a stale expectation after a change. Don't re-run until it passes, and don't skip it |
| `stage` failed | Production is untouched. Fix forward; the next merge releases |
| `production` failed before the promote | Nothing is live. Expand-only migrations may have been applied, which is safe |
| `production` failed during the promote | It rolled itself back; the run summary says so. If it says the rollback failed, run **Rollback** |
| "main moved" in the summary | A newer merge is releasing instead |
| `Unauthorized` from Cloudflare | The token expired or lost a permission: an admin renews the organization secret |
