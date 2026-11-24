# Quickstart

Run the auth server, its profile app and its admin on your machine.

You need Node 22, pnpm 9 and a GitHub token with `read:packages` (our OpenAuth fork is on GitHub Packages).

## 1. Install

```bash
git clone https://github.com/Al-Ummah-Now/AlUmmahNowAuth.git
cd AlUmmahNowAuth
pnpm config set //npm.pkg.github.com/:_authToken "$GITHUB_TOKEN"   # kept in your own config, not the repo
pnpm install
```

## 2. Settings

```bash
for app in auth profile admin; do cp apps/$app/.dev.vars.example apps/$app/.dev.vars; done
```

In `apps/auth/.dev.vars`, `SESSION_SECRET` is 64 hex characters: `openssl rand -hex 32`. `RESEND_API_KEY` sends the email codes; without a working one, "Create account" and "Forgot password?" are hidden. `.dev.vars` is ignored by git.

## 3. Database

```bash
pnpm migrations:local
```

Creates the tables, the roles and the local clients in `.wrangler`.

## 4. Run

```bash
pnpm dev
```

| App | Address |
|---|---|
| Auth server | http://localhost:3301 |
| Profile | http://localhost:3302 |
| Admin | http://localhost:3303 |
| Audit consumer | http://localhost:3304 |

Open http://localhost:3302 and sign in. One at a time: `pnpm dev:auth`, `pnpm dev:profile`, `pnpm dev:admin`.

## 5. Check

```bash
curl http://localhost:3301/health
curl http://localhost:3301/.well-known/oauth-authorization-server
pnpm lint && pnpm type-check && pnpm test
```

## When something is wrong

| You see | Because |
|---|---|
| `401` from `npm.pkg.github.com` on install | The token is missing or has no `read:packages` |
| An error page on every sign-in page | `SESSION_SECRET` isn't 64 hex characters |
| An error page that names the app or its address | The client or redirect address isn't in the local database: run step 3, and use the ports above |
| No "Create account" link | `RESEND_API_KEY` doesn't work |

## Next

- [ARCHITECTURE.md](ARCHITECTURE.md): the parts
- [AUTHENTICATION_FLOWS.md](AUTHENTICATION_FLOWS.md): how apps sign in
- [API_REFERENCE.md](API_REFERENCE.md): every route
- [TESTING.md](TESTING.md), [CICD.md](CICD.md): tests and releases
