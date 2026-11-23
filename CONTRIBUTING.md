# Contributing to Al Ummah Now Auth

Thank you for helping. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). **Security problems are reported privately** ([SECURITY.md](SECURITY.md)), never as an issue or pull request.

## Set up

You need Git, Node.js 22 and pnpm 9 (`corepack enable` picks the version in `package.json`). No Cloudflare account is needed: everything runs locally.

`@al-ummah-now/openauth` comes from GitHub Packages, which asks for a token even for public packages. Create a classic token with only `read:packages` and keep it in your shell's environment, never in the repository:

```sh
echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> ~/.npmrc   # the value comes from the environment
export NODE_AUTH_TOKEN=...
git clone https://github.com/<you>/AlUmmahNowAuth.git
cd AlUmmahNowAuth
pnpm install
```

Copy each app's `.dev.vars.example` to `.dev.vars` (gitignored), then create the local database:

```sh
for app in auth profile admin audit-consumer; do cp "apps/$app/.dev.vars.example" "apps/$app/.dev.vars"; done
pnpm migrations:local && pnpm seed:local
pnpm dev
```

| App | Local address |
|---|---|
| Sign-in (issuer) | http://localhost:3301 |
| Profile | http://localhost:3302 |
| Admin | http://localhost:3303 |
| Audit consumer | port 3304 |

Local development only ever uses local stores (`wrangler.dev.json`); `pnpm check:dev-config` enforces it.

## Make a change

1. Branch from `main`: `feat/…`, `fix/…`, `docs/…`.
2. Keep one purpose per pull request, with tests for the behavior you change.
3. Use [Conventional Commits](https://www.conventionalcommits.org/): `fix(auth): …`.
4. Before you push:

   ```sh
   pnpm lint && pnpm type-check && pnpm test:unit
   pnpm test:scripts && pnpm check:config && pnpm check:schema
   ```

5. Fill in the pull request template. If users or developers see the change, update the [wiki](https://github.com/Al-Ummah-Now/AlUmmahNowWiki) too.

A merge to `main` goes through stage to production by itself ([CICD.md](CICD.md)), so a merged change has to be ready for users.

## Rules that reviews check

- **Database.** Migrations only add, and an existing file is never edited. A new one goes into both `migrations/` and `migrations-qa/`, with `pnpm schema:snapshot`. No query may scan a whole table: use an index, a limit or a batch.
- **Secrets and personal data** never appear in code, logs, test output or error messages.
- **Two languages.** Everything users or admins read is in English and Arabic. Arabic text uses Eastern Arabic digits through the shared formatter. Pages work right to left.
- **Dialogs** are in-page; the browser's `alert`, `confirm` and `prompt` are not used.
- **Tests** create their own data and delete it, also when they fail. A red test is a bug to fix, never one to skip or retry. Email and other outside services are mocked.
- **Public routes** follow the [security policy](SECURITY.md): check who calls, limit how often, validate input, and fail closed.

## Where things are

The [wiki page of this repository](https://github.com/Al-Ummah-Now/AlUmmahNowWiki/blob/main/repos/AlUmmahNowAuth.md) lists the apps, workflows and key documents. Questions: [SUPPORT.md](SUPPORT.md).
