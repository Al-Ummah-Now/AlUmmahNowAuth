# Signing-key rotation

Auth signs access, ID and M2M tokens with ES256 keys kept in the issuer's key index (`keys:signing` in D1 `openauth_atomic`). Rotation replaces the signing key without signing anyone out (AlUmmahNowAuth#13).

## Lifecycle

| Step | When | What happens |
| --- | --- | --- |
| Publish | a rotation step adds a key | The new key is **pending**: it's in `/.well-known/jwks.json` at once, but it doesn't sign yet. `activates` = now + 1 hour. |
| Switch | `activates` | The new key signs every new token. The previous key still verifies the tokens it signed (overlap). |
| Retire | the new key has signed for 2 × the longest token lifetime (at least 1 day; 1 day with 15-minute access tokens) | The previous key leaves JWKS and verifies nothing. Its private key is deleted from the index, from `signing:key::<kid>` and, if it was that key, from `signing:key::primary`. |

The key that is signing can never be retired. Only one key can be pending at a time.

### Why 1 hour before use

Verifiers hold JWKS for up to 15 minutes in total:
- the JWKS edge cache: 5 min (`well-known-cache.ts`);
- `Cache-Control: max-age=300`: 5 min;
- in-memory caches: 5–10 min.

All verifiers also refetch once when a token names a `kid` they don't hold:
- Auth's own checks: `issuerKeySet` in `utils/jwks-cache.ts`, at most once per 30 s;
- openauth's `client.verify`;
- jose's remote JWK set.

## Triggers

Each step runs as a `signing-keys.rotate` message on the worker's job queue (`moderation-actions[-env]`).
- It's retried with backoff (30 s, doubling, up to 15 min; `max_retries` 6).
- When retries run out, it goes to `moderation-actions[-env]-dlq`.

Steps are idempotent: a step does only what the key index says is due.

- **Schedule**: the hourly cron (`token-cleanup`) queues a step. The step always retires replaced keys once the overlap is over. Where `SIGNING_KEY_ROTATION_SCHEDULE` is `"on"`, it also adds a successor once the key in use has signed for 90 days.
  - It's `"on"` for dev and QA.
  - It's `"off"` for stage and production until every app's verifier refetches JWKS on an unknown `kid` (AlUmmahNow `withKeyRefetch`). Before that, admin-web kept a JWKS it fetched once for the isolate's whole life.
  - Rotate now works in every environment.
- **Admin**: Admin > Signing keys > Rotate now (Super Admin, needs a fresh sign-in) queues a step that adds a pending key now.

## Admin API

`GET /admin/settings/signing-keys` (admins) returns:
- the keys, without key material: `id`, `alg`, `created`, `activates`, `expired`, `state` (`pending` | `active` | `previous` | `retired`);
- the policy;
- the last run (`status`);
- `canRotate`.

`POST /admin/settings/signing-keys` with `{ "action": "rotate" }` (Super Admin) answers `202` once the step is queued. It answers `503` if the queue is unavailable; that failure is flagged too. It's rate-limited by `ADMIN_SENSITIVE_LIMITER`.

## Audit and failures

Audit events:
- `signing_key.rotation_requested`: who asked;
- `signing_key.added`: kid, activation time, the key it replaces;
- `signing_key.retired`: kid;
- `signing_key.rotation_failed`: severity ERROR, `needsAttention`.

When a step fails for good (out of retries, the DLQ, or no queue), the failure is recorded on the admin page (`status.error`), audited, and reported to the Errors page. The next successful step clears it.

## Verifiers in other apps

During the overlap two keys are published, so verifiers must pick the key by `kid` (never `keys[0]`). They must refetch JWKS when a token names a `kid` they don't have. Tokens of a retired key are refused everywhere once verifiers' caches refresh (at most about 15 minutes).
