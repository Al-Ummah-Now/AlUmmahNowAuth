# Moderation requests

Auth and the client apps are separate. A client app manages its own users (the
videos admin bans or deletes a videos profile without touching auth). When a
client app thinks the **auth identity** itself needs action, its admins file a
**moderation request**. Only auth admins decide, and only auth acts.

```
videos admin ──POST /moderation/requests──▶ auth (pending)
                                             │ auth admin: approve / reject / request info
videos admin ◀──GET /moderation/requests/:id─┘ (approved → actioned, or rejected + note)
```

Code: `apps/auth/src/moderation/`. Tables: migration `0022_moderation_requests.sql`.
Auth admin pages: **Moderation** (`/moderation`, `/moderation/:id`) in `apps/admin`.

## Client authentication

Machine to machine, with the client's own OAuth credentials (RFC 6749 §2.3.1),
checked by the same code as `/token` (`middleware/clientAuth.ts`):

```
Authorization: Basic base64(client_id:client_secret)
```

The client must be enabled, have a secret, and hold the `moderation:request`
scope. No shared database: the client only knows auth user ids (`usr_…`, the
`sub` of its users' tokens).

| Env | Client | id |
| --- | --- | --- |
| qa, stage, production | Videos Admin (moderation requests) | `d7464de8-363d-4fc1-b1af-7c71653f0afc` |

The secret is set per environment with
`scripts/release/rotate-client-secret.ts` (never in a migration), which also
hands it to its consumers:

```bash
node --experimental-strip-types scripts/release/rotate-client-secret.ts \
  --db <AUTH_DBS[env]> --client d7464de8-363d-4fc1-b1af-7c71653f0afc \
  --worker al-ummah-admin-api[-qa|-stage]:AUTH_MODERATION_CLIENT_SECRET \
  [--gh-secret Al-Ummah-Now/AlUmmahNowAuth:E2E_MODERATION_CLIENT_SECRET   # qa only]
```

## Client API

All responses are JSON with `Cache-Control: no-store`. A client only sees its
own requests; another client's id answers 404.

### `POST /moderation/requests`

Headers: `Authorization` (above), `Idempotency-Key: <8-128 chars>` (required;
`idempotency_key` in the body is accepted too).

```json
{
  "subject_user_id": "usr_21dbdf625e0940b8ac21a08835e1f834",
  "action": "suspend_account",
  "reason_category": "harassment",
  "reason": "Repeated abusive comments on three channels",
  "evidence": [
    { "url": "https://admin.alummahnow.net/users/usr_21db…", "label": "Videos admin user page" },
    { "url": "https://admin.alummahnow.net/moderation/reports/rep_123", "label": "Report rep_123" }
  ],
  "requested_by": { "id": "usr_…", "display_name": "Fatima (videos moderator)" }
}
```

| Field | Rules |
| --- | --- |
| `subject_user_id` | auth user id, `[A-Za-z0-9_-]{1,128}`; must exist (else 404 `subject_not_found`) |
| `action` | `suspend_account`, `delete_account`, `revoke_sessions` (sign out everywhere), `require_password_reset`, `other` |
| `reason_category` | `spam`, `harassment`, `hate_speech`, `violent_content`, `sexual_content`, `impersonation`, `copyright`, `fraud`, `compromised_account`, `other` |
| `reason` | 1-4000 chars |
| `evidence` | optional, up to 20 `{ url (https), label? }` |
| `requested_by` | the client-side admin: `id`, `display_name` (shown to auth admins) |

Responses:

| Status | When |
| --- | --- |
| `201` + `Location` | created; body `{ "request": Request }` |
| `200` + `Idempotent-Replay: true` | same key, same body: the original request |
| `400` `invalid_request` | `{ error, issues: [{ path, message }] }` |
| `401` `invalid_client` | bad or missing credentials |
| `403` `insufficient_scope` | client lacks `moderation:request` |
| `404` `subject_not_found` | no auth user with that id |
| `409` `idempotency_conflict` | same key, different body |
| `429` `rate_limit_exceeded` | per client: 10 writes/min (`ADMIN_SENSITIVE_LIMITER`), 120 reads/min (`ADMIN_LIMITER`), 100 new requests/hour |

### `GET /moderation/requests/:id`

`{ "request": Request }` with its history. Poll this for status (there is no
callback; a few calls a minute per open request is fine).

### `GET /moderation/requests`

Query: `subject_user_id`, `status`, `action`, `limit` (1-100, default 50), `offset`.
`{ "requests": Request[], "total", "limit", "offset" }` (no history), newest first.

### `POST /moderation/requests/:id/info`

Answers an auth admin's request for more information; only while the status is
`info_requested` (else 409 `invalid_state`). Moves the request back to `pending`.

```json
{ "note": "Here are two more reports", "evidence": [{ "url": "https://…" }], "requested_by": { "id": "…", "display_name": "…" } }
```

### Request (as the client sees it)

```json
{
  "id": "modreq_8f0c…",
  "status": "actioned",
  "subject_user_id": "usr_…",
  "action": "revoke_sessions",
  "reason_category": "spam",
  "reason": "…",
  "evidence": [{ "url": "https://…", "label": "…" }],
  "requested_by": { "id": "…", "display_name": "…" },
  "decision_note": "Confirmed; signed out everywhere",
  "decided_at": "2026-11-09T21:10:00.000Z",
  "actioned_at": "2026-11-09T21:10:01.000Z",
  "created_at": "…",
  "updated_at": "…",
  "history": [
    { "type": "created", "by": "Fatima (videos moderator)", "note": null, "at": "…" },
    { "type": "approved", "by": "auth_admin", "note": "Confirmed; …", "at": "…" },
    { "type": "actioned", "by": "auth_admin", "note": null, "at": "…" }
  ]
}
```

Auth admin identities are never sent to the client (`by: "auth_admin"`).

## Statuses

| Status | Meaning | Final |
| --- | --- | --- |
| `pending` | waiting for an auth admin | |
| `info_requested` | an auth admin asked for more (see `decision_note`); answer with `/info` | |
| `approved` | approved; the action is queued or retrying, failed (flagged for an auth admin), or is `other` (handled by hand) | |
| `rejected` | rejected; `decision_note` says why | yes |
| `actioned` | the action ran (or, for `other`, was done by hand) | yes |

```
pending ──approve──▶ approved ──(queued action runs)──▶ actioned
   │  ▲                 │  └──mark-actioned (other / failed action)──▶ actioned
   │  └─/info── info_requested ◀──request-info── pending
   └──reject──▶ rejected ◀──reject── info_requested, approved
```

History event types: `created`, `info_requested`, `info_provided`, `approved`,
`rejected`, `action_requeued`, `actioned`, `action_failed`.

## Auth admin API

Admin only (`requireAdmin`) plus the RBAC permission
`moderation_requests:manage` (`perm_admin_moderation_requests`, granted to the
existing **Admin** and **Super Admin** roles by migration 0022; no new roles).

| Method | Path | |
| --- | --- | --- |
| GET | `/admin/moderation-requests` | queue; `status`, `client_id`, `action`, `subject_user_id`, `from`, `to` (YYYY-MM-DD), `limit`, `offset`; returns `requests` (with `subject`, `client_name`), `total`, `open`, `clients` |
| GET | `/admin/moderation-requests/:id` | `request` (with full history), `subject` (auth user), `prior_requests` for the same user |
| POST | `/admin/moderation-requests/:id/approve` | `{ note? }`; approves and queues the action (202) |
| POST | `/admin/moderation-requests/:id/reject` | `{ note }` required |
| POST | `/admin/moderation-requests/:id/request-info` | `{ note }` required |
| POST | `/admin/moderation-requests/:id/execute` | queues a failed action again (202); 409 while it is queued |
| POST | `/admin/moderation-requests/:id/mark-actioned` | closes an approved `other` request, or one whose action failed, as done by hand |

The queue (`GET`) also takes `needs_attention=1` and returns `needs_attention` (the count of flagged requests).
Each request carries `execution: { status, attempts, updated_at, needs_attention }`.

A decision that does not fit the current status answers 409 `invalid_state`
(two admins cannot both decide: updates are conditional on the status).

### What approval runs: the moderation-actions queue

Approving (or **Run action again**) does not run the action in the request: it
**queues** it (`moderation/queue.ts`) and answers 202 with `execution.status: "queued"`.
The auth worker consumes the queue and runs the same account code as the
admin's own buttons (`moderation/actions.ts`):

| action | runs | same as |
| --- | --- | --- |
| `suspend_account` | `userService.suspendUser` + sign-out everywhere | `POST /admin/users/:id/suspend` |
| `delete_account` | `userService.deleteUser` + sign-out everywhere (an account already gone counts as done) | `DELETE /admin/users/:id` |
| `revoke_sessions` | `endAllSessions` (tokens, revocation list, every browser sign-in) | `DELETE /admin/users/:id/sessions` |
| `require_password_reset` | `userService.forcePasswordReset` + sign-out everywhere | `POST /admin/users/:id/force-password-reset` |
| `other` | nothing is queued; mark actioned when done | |

| Outcome | What happens |
| --- | --- |
| ok | `actioned`, `execution.status: "done"` |
| transient error | `execution.status: "retrying"`, `action_error` set; retried after 30 s, 60 s, 2, 4, 8, 15 min (`max_retries` 6) |
| permanent error (user gone, invalid) or the last retry fails | **flagged**: `execution.status: "failed"`, `needs_attention: true`, an `action_failed` event, an ERROR audit event |
| the handler itself keeps crashing | the message lands in `moderation-actions[-env]-dlq`, whose consumer flags the request the same way |

Flagged requests show a banner and an **Action failed** badge in the queue (filter
**Needs attention**, `?needs_attention=1`) and a "Needs attention" alert on the
request. The admin can **Run action again** (re-queued, attempts reset), **Mark
actioned** (done by hand) or **Reject**. A request rejected after its action was
queued is skipped by the consumer.

| Env | Queue | DLQ | Consumer |
| --- | --- | --- | --- |
| qa | `moderation-actions-qa` | `moderation-actions-qa-dlq` | `al-ummah-now-auth-qa` (registered by its `wrangler deploy`) |
| stage | `moderation-actions-stage` | `moderation-actions-stage-dlq` | `al-ummah-now-auth-stage` |
| production | `moderation-actions` | `moderation-actions-dlq` | `al-ummah-now-auth` |

Stage and production are released with `wrangler versions upload`, which does not
register queue consumers: the release runs `scripts/release/queue-consumers.ts`
after each promote, which registers any consumer the wrangler config declares and
Cloudflare lacks (idempotent; it needs the code with the queue handler deployed).

## Audit

Every step is in auth's audit log (`audit_events`, Audit Logs page):
`moderation.request.created`, `.info_requested`, `.info_provided`, `.approved`,
`.rejected`, `.actioned`, `.action_failed` (ERROR, `needsAttention: true`), with
the request id, target user, action, client and note.
