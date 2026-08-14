# temp-mail-agent

Disposable email service with OTP extraction, adjustable expiry, child/alias
inboxes, real accounts with MFA, and per-account API keys — plus an optional
temporary phone number module. Ships with a web dashboard (auto-refreshing,
no manual "watch" clicks needed) and a plain REST API any other app can call.

## What's real vs. stubbed

- **Email** is fully functional: it provisions real, receivable mailboxes via
  the free [mail.tm](https://docs.mail.tm) API. No signup or domain needed.
- **Phone numbers** default to a **mock provider** (fake number, canned SMS)
  so the rest of the system works out of the box. To receive *real* SMS,
  set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` in `.env` (Twilio has a free
  trial). This intentionally does **not** scrape free public "receive-sms"
  sites — those are shared numbers used specifically to bypass platforms'
  SMS verification, which isn't something this project automates.

## Setup

```bash
npm install
cp .env.example .env   # generate a SESSION_SECRET, see comments inline
npm start               # or `npm run dev` for auto-reload
```

Server runs on `http://localhost:4000` by default — open it in a browser
for the dashboard, or drive the API directly.

## Accounts, sessions, and MFA

- `POST /api/auth/signup` — `{ email, password, label? }`. Password must be
  ≥10 characters. Sets an httpOnly session cookie and creates an API key.
- `POST /api/auth/login` — `{ email, password, totpCode? }`. If MFA is
  enabled and `totpCode` is omitted or wrong, responds `401` with
  `{ mfaRequired: true }` — the dashboard resubmits with a code once you
  enter one. `totpCode` also accepts a backup code (single-use).
- `POST /api/auth/logout` — clears the session cookie.
- `POST /api/auth/mfa/setup` (authenticated) — generates a TOTP secret +
  QR code for an authenticator app.
- `POST /api/auth/mfa/verify` (authenticated) — `{ code }`. Confirms
  enrollment and returns 8 backup codes, shown once.
- `POST /api/auth/mfa/disable` (authenticated) — `{ password }`.

Every other endpoint accepts **either** an `x-api-key` header (for other
applications — this is what you hand to a script or another service) **or**
the session cookie (what the dashboard uses after login). Either is
sufficient on its own.

The old anonymous `POST /api/register` (no email/password, instant key) still
works in development for convenience, but is **disabled automatically when
`NODE_ENV=production`** — it would otherwise let anyone bypass signup
entirely and mint unlimited accounts.

## Email endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/emails` | `{ ttlMinutes?, parentId? }` | create inbox; `parentId` makes it a child/alias grouped under an existing inbox |
| GET | `/api/emails` | — | list your inboxes |
| GET | `/api/emails/:id` | — | inbox details + expiry |
| GET | `/api/emails/:id/messages` | — | full inbox contents |
| GET | `/api/emails/:id/otp` | — | latest extracted OTP (for autofill) |
| PATCH | `/api/emails/:id/extend` | `{ minutes }` | push back expiry |
| DELETE | `/api/emails/:id` | — | delete now |

```bash
curl -X POST http://localhost:4000/api/emails \
  -H 'x-api-key: tma_...' -H 'Content-Type: application/json' \
  -d '{"ttlMinutes": 15}'
# => { "id": "...", "address": "inbox1a2b3c@somedomain.com", "expiresAt": ... }

curl http://localhost:4000/api/emails/<id>/otp -H 'x-api-key: tma_...'
# => { "otp": "482913", "from": "noreply@example.com", ... }
```

Child inbox: `POST /api/emails` with `{"parentId": "<parent-id>"}`.

## Phone endpoints

Same shape as email, under `/api/phones` (`number` instead of `address`).

## Dashboard

Everything auto-watches itself — create an inbox/number and its messages
and OTP show up live (polls every 4s) with no click required. Buttons let
you pause/resume, force an immediate refresh, extend expiry, or delete.
The "Security" button in the header manages MFA.

## Autofill in your own app

`public/autofill.js`, served at `/autofill.js`, polls your `/otp` endpoint
and fills a field on the page that includes it:

```html
<script src="http://localhost:4000/autofill.js"></script>
<script>
  TempMailAutofill.pollAndFill({
    apiBase: 'http://localhost:4000',
    apiKey: 'tma_...',
    mailboxId: '<id>',
    inputSelector: '#otp-input',
  }).then(otp => console.log('filled', otp));
</script>
```

This only fills a field on the page that includes the script (first-party),
not arbitrary third-party pages.

## Deploying publicly — read this first

If you're opening this up for anyone to sign up (not just yourself):

- **Set `SESSION_SECRET`** to a real random value (see `.env.example`) and
  **`NODE_ENV=production`** — this also disables the anonymous bootstrap
  endpoint mentioned above.
- **Leave `PUBLIC_SIGNUP=true`** if signup really is open to strangers. This
  hard-forces the phone module to the mock provider no matter what Twilio
  credentials are set, so anonymous visitors can never provision real
  numbers billed to your account.
- **Rate limits** (`AUTH_RATE_LIMIT_PER_15MIN`, `CREATION_RATE_LIMIT_PER_HOUR`)
  are set to reasonable defaults but are per-IP — consider tightening them
  further, and consider adding a CAPTCHA (e.g. Cloudflare Turnstile) in
  front of `/api/auth/signup` if you see bot signups; that integration
  isn't built in yet.
- Even with all of this, understand what you're hosting: a public,
  freely-joinable disposable-email generator. That's the same category as
  mail.tm itself (which anyone can already use directly, with zero
  friction), so the marginal risk is mostly about scale and about your own
  Twilio bill if `PUBLIC_SIGNUP` isn't respected — not about enabling
  something that doesn't already exist.

## Expiry

A cron job sweeps every minute, deleting mailboxes/numbers past their
`expiresAt` (and best-effort releasing them from the upstream provider).
`PATCH .../extend` pushes the deadline back at any time before that.

## Known low-risk advisory

`npm audit` reports a moderate advisory in `uuid`, pulled in transitively by
`node-cron`'s own dependencies (not something this project uses directly —
`crypto.randomUUID()` is used everywhere here instead). The vulnerable code
path only affects `uuid` v3/v5/v6 when called with an explicit buffer, which
neither this project nor, as far as the advisory describes, `node-cron`
itself does. Fixing it requires a breaking `node-cron` major-version bump;
left alone for now as low-risk.

## Data

SQLite file under `./data/` (gitignored). Delete it to reset everything.
Schema migrations for existing databases run automatically on startup.
