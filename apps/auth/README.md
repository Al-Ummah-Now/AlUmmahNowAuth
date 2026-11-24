# Auth server

The issuer every app signs in through: a Cloudflare Worker on our OpenAuth fork (`@al-ummah-now/openauth`).

| | |
|---|---|
| Entry | [`src/index.ts`](src/index.ts): the issuer and its options. [`src/router.ts`](src/router.ts): Auth's own routes, tried first |
| Routes | [`openapi.json`](../../openapi.json), checked against the code in CI |
| Storage | D1 `AUTH_DB` (users, sessions, codes, refresh tokens), KV `AUTH_STORAGE` (passwords, older tokens), KV `TOKEN_REVOCATIONS` (the list other services read), KV `AUTH_THEMES` |
| Queues | Audit events and moderation actions, with dead-letter queues |
| Config | `wrangler.json` (production, stage), `wrangler.qa.json`, `wrangler.dev.json` |

Never add an unindexed query on `AUTH_DB`.

Run it: [QUICKSTART.md](../../QUICKSTART.md). Integrate an app: [SDK_USAGE.md](../../SDK_USAGE.md). Release: [CICD.md](../../CICD.md).
