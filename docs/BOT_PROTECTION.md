# Bot protection on the sign-in pages

Code: `apps/auth/src/security/turnstile.ts` (Turnstile, bypass, abuse counters) and
`apps/auth/src/security/password-guard.ts` (where each check runs). Platform-wide
overview and owner steps: wiki page "Bot Protection".

## What is checked

| Page / post | Turnstile | Other limits |
| --- | --- | --- |
| Sign-up (`/password/register`, the "Continue" that sends the code) | always | `PASSWORD_IP_LIMITER`, `PASSWORD_EMAIL_LIMITER` |
| Forgot password / email code send (`/password/change`, `action=code`, also "Resend code") | always | same, plus `SEND_CODE_LIMITER` |
| Sign-in (`/password/authorize`) | from the 3rd failed attempt in 15 minutes for that email (`TURNSTILE_AFTER_FAILURES`) | same, plus the D1 attempt slots (10 per 15 min) |
| Code entry (`action=verify`) | no (5 guesses per code, in D1) | same |

The widget is Cloudflare Turnstile in *managed* mode, rendered with
`appearance: "interaction-only"`: almost every visitor sees nothing; only a visitor
Cloudflare is unsure about gets a one-click check. A form submitted before the token is
ready waits for it (status line "Checking that you are not a robot…", `role="status"`)
and is then sent. When the widget cannot run (blocked script, offline) the form is sent
without a token and the server decides. Copy is English or Arabic with the page.

A refused post re-renders the same form with "Please confirm that you are not a robot,
then try again." and HTTP 400. A refused sign-in does not use up an attempt.

In production with `TURNSTILE_MODE=enforce`, scripted clients (curl, python-requests,
Go-http-client, wget, Scrapy, … or no User-Agent) get 403 on these posts. Browsers, our
native apps (okhttp, CFNetwork, Ktor) and crawlers are not affected.

## Modes and keys

`TURNSTILE_MODE` (wrangler var): `off` | `monitor` (verify and count, never refuse) |
`enforce`. A siteverify outage is let through and counted (`turnstile_error`).

| Env | Mode | Site key | Secret (Secrets Store) |
| --- | --- | --- | --- |
| local / unit tests | `off` (tests set their own) | test `1x00000000000000000000AA` | test secret (plain var) |
| QA, stage | `enforce` | test `1x00000000000000000000AA` | `turnstile-secret-test` (Cloudflare's public always-pass secret) |
| production | `off` → `monitor` → `enforce` | `0x4AAAAAAF_3KPNkPlEGf_dP` (widget "al-ummah-now-production", domains alummahnow.net/.org/.com/.app) | `turnstile-secret` |

Test keys never reach Cloudflare: the server answers the test secrets itself and the
page loads `/turnstile/stub.js` (served outside production only) instead of
`challenges.cloudflare.com`, so E2E and CI make no Turnstile calls. Production refuses
test keys (the mode reads as `off` and an error is logged).

### Rollout in production

1. Merged with `TURNSTILE_MODE: "off"` in `env.production`.
2. Set `"monitor"`: the widget runs and passes/failures show on the videos admin
   **Abuse** panel; nothing is refused.
3. When the failure rate looks like bots only, set `"enforce"`.

Undo: set `"off"` again (one-line PR; Auth deploys on merge).

## Test bypass (never in production)

Outside production, a request with `X-AUN-Bot-Bypass: v1.<unix ts>.<hex HMAC-SHA256 of
"v1.<ts>">` signed with `BOT_BYPASS_SECRET` (Secrets Store `bot-bypass-secret-nonprod`)
gets no widget and no check; it is valid for 6 hours. `signBypass()` makes one.
`BOT_BYPASS_SECRET` is a test-only name: the release config check refuses it in
production. QA and stage do not need it today (they use the test keys); it exists for
running against real keys. The stored value cannot be read back: to use it, generate a
new value, write it to the store and to the CI secret that needs it.

## Counters (Abuse panel)

Each outcome writes one Analytics Engine point to `ABUSE_EVENTS`
(`al_ummah_now_abuse`, `_stage`, `_qa`, `_dev`): blobs `[app, endpoint, kind, env]`,
kinds `turnstile_pass|turnstile_fail|turnstile_missing|turnstile_error|rate_limited|bad_user_agent|bypass`.
No IP, email, token or user id is written. No D1 writes.

## Privacy

Turnstile runs only on these pages. Cloudflare processes the visitor's IP and browser
signals to issue the token; we send the token and the client IP to siteverify and keep
nothing but the counters above. See the GDPR page in the wiki.
