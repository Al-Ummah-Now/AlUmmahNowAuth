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
| `approved` | approved, action not run yet: `other` (handled by hand), or the action failed and will be retried | |
| `rejected` | rejected; `decision_note` says why | yes |
| `actioned` | the action ran (or, for `other`, was done by hand) | yes |

```
pending ──approve──▶ approved ──(action runs)──▶ actioned
   │  ▲                 │  └──mark-actioned (other / failed action)──▶ actioned
   │  └─/info── info_requested ◀──request-info── pending
   └──reject──▶ rejected ◀──reject── info_requested, approved
```

History event types: `created`, `info_requested`, `info_provided`, `approved`,
`rejected`, `actioned`, `action_failed`.

## Auth admin API

Admin only (`requireAdmin`) plus the RBAC permission
`moderation_requests:manage` (`perm_admin_moderation_requests`, granted to the
existing **Admin** and **Super Admin** roles by migration 0022; no new roles).

| Method | Path | |
| --- | --- | --- |
| GET | `/admin/moderation-requests` | queue; `status`, `client_id`, `action`, `subject_user_id`, `from`, `to` (YYYY-MM-DD), `limit`, `offset`; returns `requests` (with `subject`, `client_name`), `total`, `open`, `clients` |
| GET | `/admin/moderation-requests/:id` | `request` (with full history), `subject` (auth user), `prior_requests` for the same user |
| POST | `/admin/moderation-requests/:id/approve` | `{ note? }`; approves and runs the action |
| POST | `/admin/moderation-requests/:id/reject` | `{ note }` required |
| POST | `/admin/moderation-requests/:id/request-info` | `{ note }` required |
| POST | `/admin/moderation-requests/:id/execute` | runs the action of an approved request again (after a failure) |
| POST | `/admin/moderation-requests/:id/mark-actioned` | closes an approved `other` request, or one whose action failed, as done by hand |

A decision that does not fit the current status answers 409 `invalid_state`
(two admins cannot both decide: updates are conditional on the status).

### What approval runs

The action goes through auth's **existing** admin routes, with the deciding
admin's own credentials (`moderation/executor.ts`), so guards, sign-out
everywhere (#437) and audit events are the same as on the Users/Sessions pages:

| action | route |
| --- | --- |
| `suspend_account` | `POST /admin/users/:id/suspend` |
| `delete_account` | `DELETE /admin/users/:id` |
| `revoke_sessions` | `DELETE /admin/users/:id/sessions` |
| `require_password_reset` | `POST /admin/users/:id/force-password-reset` |
| `other` | nothing; mark actioned when done |

If the route fails the request stays `approved` with `action_error`, the API
answers 502 `action_failed`, and the admin can **Run action again** or reject.

## Audit

Every step is in auth's audit log (`audit_events`, Audit Logs page):
`moderation.request.created`, `.info_requested`, `.info_provided`, `.approved`,
`.rejected`, `.actioned`, `.action_failed`, with the request id, target user,
action, client and note. The executed action adds its own events
(`user.suspended`, `admin.sessions.terminated_all`, …).
