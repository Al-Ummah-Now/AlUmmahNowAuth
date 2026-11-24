# API reference

[`openapi.json`](openapi.json) (OpenAPI 3.1) is the reference: every route, its parameters, answers and security. CI fails when it and the code disagree ([`scripts/__tests__/openapi.test.ts`](scripts/__tests__/openapi.test.ts)).

Each operation says who it is for, in `x-audience`:

| Audience | For | Authentication |
|---|---|---|
| `public` | Any registered client: discovery, sign-in, tokens | None, or the client's own credentials |
| `app` | Our own apps and their servers: the browser session, the user's account, invites, moderation | The user's access token, the browser's session cookie, or HTTP Basic with a client that holds a scope |
| `page` | Pages this server shows in a browser | The browser |
| `admin` | Staff | A staff token |

Only our own apps and scholar sites have clients. Staff create them in the Auth admin, under Clients.

## Servers

| | Issuer |
|---|---|
| Production | `https://auth.alummahnow.net` |
| Stage | `https://auth.stage.alummahnow.net` |
| QA | `https://auth.qa.alummahnow.net` |
| Local | `http://localhost:3301` |

Read the endpoints from `GET /.well-known/oauth-authorization-server` rather than writing them down.

## Errors

JSON, with the OAuth shape:

```json
{ "error": "invalid_grant", "error_description": "Authorization code has been used or expired" }
```

Act on `error`. `error_description` is for the developer and may change. An error the server didn't expect carries an `X-Error-Ref` header to quote in a report.

## Limits

Counted by Cloudflare rate limiters, so limits are per location. Over a limit: `429` with `Retry-After: 60`.

| What | Limit in a minute |
|---|---|
| `POST /token`: per user for a refresh, per address otherwise | 60 |
| `POST /token` from our own servers, per client | 3000 |
| Emailed codes and links | 5 |
| Password and passkey pages, per address / per email | 100 / 10 |
| Native passkeys, per address and app | 30 |
| Staff reads / writes | 120 / 10 |

## More

- [AUTHENTICATION_FLOWS.md](AUTHENTICATION_FLOWS.md): what happens in each sign-in
- [SDK_USAGE.md](SDK_USAGE.md): the same in code
- [docs/TOKEN_REVOCATIONS.md](docs/TOKEN_REVOCATIONS.md), [docs/USER_INVITES.md](docs/USER_INVITES.md), [docs/MODERATION_REQUESTS.md](docs/MODERATION_REQUESTS.md), [docs/SIGNING_KEY_ROTATION.md](docs/SIGNING_KEY_ROTATION.md): the server-to-server APIs and the keys
