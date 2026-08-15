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

1. **Clone and install:**
   ```bash
   git clone https://github.com/virinchisai/temp-mail-agent.git
   cd temp-mail-agent
   npm install
   ```
   You'll see a few `npm WARN deprecated` lines and a note about "2 moderate
   severity vulnerabilities" — both expected, both benign, both explained in
   [Known low-risk advisory](#known-low-risk-advisory) below. Nothing to fix.

2. **Create your config:**
   ```bash
   cp .env.example .env
   ```

3. **Generate a session secret** (signs login sessions — without this the
   server still runs in dev mode, but every restart logs everyone out):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Copy the output into `.env` as `SESSION_SECRET=<value>`.

4. **Start the server:**
   ```bash
   npm start        # or `npm run dev` for auto-reload on file changes
   ```
   You should see `temp-mail-agent listening on http://localhost:4000`.
   Open that URL in a browser for the dashboard, or drive the API directly.

5. **Stop it later** with `Ctrl+C` in that terminal, or see
   [Troubleshooting](#troubleshooting) below if you lose track of it.

## Troubleshooting

**`Error: listen EADDRINUSE: address already in use :::4000`**
Something (often a previous `npm start` you forgot about) is still bound to
the port. Free it, then retry:
```bash
lsof -ti:4000 -sTCP:LISTEN | xargs -r kill
```
If you changed `PORT` in `.env`, swap `4000` for that value. To check what's
using a port without killing it first: `lsof -i:4000`.

**That `kill` command runs but the port is still stuck / EADDRINUSE keeps
coming back**
You likely stopped the server with `Ctrl+Z` instead of `Ctrl+C`. `Ctrl+Z`
*suspends* the process (`zsh: suspended`) rather than killing it — it's
still alive, still holding the port, just paused. A suspended process can't
even process a plain `kill` (`SIGTERM`) until it's resumed, so that command
silently does nothing. Force it instead:
```bash
lsof -ti:4000 -sTCP:LISTEN | xargs -r kill -9
```
Going forward, use `Ctrl+C` to stop `npm start` — it actually terminates the
process and frees the port immediately, no `kill` needed at all.

**Server exits immediately in production with `SESSION_SECRET must be set`**
Expected — production mode refuses to run with an insecure auto-generated
secret. Do step 3 above and set `NODE_ENV=production` only once
`SESSION_SECRET` is actually set (locally in `.env`, or as a `fly secrets
set` value when deploying — see below).

**`npm install` shows deprecation warnings / "2 moderate severity
vulnerabilities"**
Expected, see [Known low-risk advisory](#known-low-risk-advisory).

**`502 Failed to provision mailbox from upstream provider` / similar**
The free [mail.tm](https://mail.tm) API this project depends on is
occasionally slow or briefly unavailable — it's outside this project's
control. Wait a few seconds and retry; if `GET /health` on this server
still returns `200`, the server itself is fine.

**"Invalid API key" or "Invalid or missing credentials"**
The key was never issued (typo), belongs to a different account, or you're
pointed at a different server than the one that issued it. Get a fresh one
via the dashboard (sign up or log in, then check the header) or
`POST /api/auth/signup`.

**Dashboard won't stay logged in across restarts**
`SESSION_SECRET` wasn't set, so a new random one was generated at startup
and every previous session's cookie stopped verifying. Set it in `.env`
(step 3 above) to fix this permanently.

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
| POST | `/api/emails` | `{ ttlMinutes?, parentId?, prefix?, domain? }` | create inbox; `parentId` makes it a child/alias grouped under an existing inbox |
| GET | `/api/emails/domains` | — | currently active mail.tm domains, for a domain picker |
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

**Custom address** (SharkLasers/Guerrilla Mail style): pass `prefix` to pick
the local part yourself instead of getting a random one, and/or `domain` to
choose which active mail.tm domain to use. A taken prefix or an inactive
domain returns a `400` with a clear message; if mail.tm itself rate-limits
the request (its free tier has a fairly tight limit), you'll get a `429`
telling you to wait a few seconds. The dashboard's "🔁 New address" button
deletes the current inbox and creates a fresh random one in its place —
the quick "forget me and start over" pattern from those sites.

## Phone endpoints

Same shape as email, under `/api/phones` (`number` instead of `address`).

## The assistant (LLM agent)

Optional, and off unless you set `ANTHROPIC_API_KEY`. Everything else works
without it.

This is what makes the project an *agent* rather than only a REST service:
instead of you picking which endpoint to call, you describe what you want and
a model decides which actions to take, in what order, and when it's done.

> *"Create an inbox, then watch it for a couple of minutes and tell me the
> verification code as soon as one arrives."*

The model works through that by calling `create_inbox` → `get_otp` → `wait` →
`get_otp` … until it has an answer or decides to stop. The dashboard shows
every tool call it makes, so the run is auditable rather than a black box.

**The tools are this service's own REST API** — nothing is reimplemented.
`src/agent/tools.js` wraps the endpoints above and authenticates with the same
`tma_` key as any other client, which also means the agent can only ever touch
the inboxes belonging to the account that invoked it.

| Piece | What it does |
|---|---|
| `src/agent/tools.js` | The 12 tools (create/list/read/otp/extend/delete for email + phone, plus `wait`) |
| `src/agent/agent.js` | The loop — Anthropic SDK Tool Runner, system prompt, step capture |
| `src/routes/agent.js` | `POST /api/agent/chat` and `GET /api/agent/status` |

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/agent/status` | — | `{enabled, model}` — whether a key is configured |
| POST | `/api/agent/chat` | `{ message, history? }` | Returns `{reply, steps, history}`; `steps` is the tool trace |

```bash
curl -X POST http://localhost:4000/api/agent/chat \
  -H 'x-api-key: tma_...' -H 'Content-Type: application/json' \
  -d '{"message":"Create an inbox that lasts 30 minutes and give me the address."}'
```

Notes:
- Uses `claude-opus-5` at `medium` effort — these are short API calls, not hard
  reasoning, so medium keeps latency and cost down. Override with `AGENT_MODEL`.
- Conversation state lives in the browser and is posted back as `history`; the
  endpoint itself is stateless like the rest of the API.
- Bounded by `AGENT_MAX_ITERATIONS` (default 30) so a confused run can't loop
  forever, and by its own rate limit (default 10/min).
- **Worth knowing:** single actions ("make me an inbox") don't benefit from the
  agent — that's one API call and the model is pure overhead. The value is in
  multi-step requests where the sequence isn't known in advance.

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

## Deploying to Fly.io

`Dockerfile` and `fly.toml` are ready to go — Fly gives a persistent volume
for the SQLite file and a straightforward free/cheap tier.

```bash
brew install flyctl                 # or: curl -L https://fly.io/install.sh | sh
fly auth login                      # opens a browser — this step is on you

# app name in fly.toml must be globally unique; edit it first if taken
fly apps create temp-mail-agent

fly volumes create temp_mail_data --size 1 --region iad

fly secrets set \
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  PUBLIC_SIGNUP=true          # only if you actually want open public signup

fly deploy                          # builds remotely even without local Docker running
```

That's it — `fly deploy` prints the live URL. Redeploy any time with
`fly deploy` after pushing changes. To add real Twilio SMS later:
`fly secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=...` (ignored while
`PUBLIC_SIGNUP=true`, see above).

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
