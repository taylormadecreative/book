# Inbox app — design

Date: 2026-09-23 · Branch: `inbox-app` · Status: awaiting Nelson's review

## Goal

Nelson hears about every booking and inquiry on www.taylormadecreative.net the
moment it happens, on his phone, and can answer in about 10 seconds with a
reply Claude drafted from real data. Nothing is ever sent without him tapping
Send.

Decisions Nelson made (2026-09-23): phone alerts come from a home-screen web
app (option 1, not SMS/Telegram); replies are drafted by Claude and approved
by him (option 1, not canned templates). Scope is taylormadecreative.net only;
Academy / client-site forms are out of scope for v1.

## What Nelson sees

- **Install once:** `book.taylormadecreative.net/inbox/` → sign in (existing
  staff login, incl. Continue with Google) → Share → Add to Home Screen →
  open from the icon → "Turn on alerts". iOS only allows web push from a
  home-screen install (iOS 16.4+); the page says so if opened in Safari.
- **Alerts** (push, email alerts continue as backup):
  - new inquiry — `Jasmine R. · Brand content · wants Oct 12`
  - new paid booking — `Booked + paid $175 · Marcus T. · Headshots · Thu 2pm`
  - client portal message — `Message from Marcus T.: "Can I bring…"`
  - needs-you — every other `nelson_alert` type (card declined, stuck
    payment, contract signed…), titled from the same wording the email uses.
- **List:** newest first, dark with gold accent. Unhandled items carry a gold
  dot and a waiting time ("2h"). Filter chips: Needs reply · All.
- **Detail — inquiry:** who, what, requested date/time, location, budget,
  their message, past projects with the same email. Claude's draft is already
  in an editable box when the page opens. Buttons: **Send email**, **Text it**,
  **Call**, **Rewrite** (with an optional note, e.g. "shorter", "offer Friday"),
  **Mark handled**.
- **Detail — booking:** service, slot, amount paid, balance status, with a
  drafted "see you Thursday" note and the same buttons.
- **Detail — client message:** the thread (last 10 messages) plus a draft.

Out of scope for v1: client email replies appearing in the app (they still
land in the hello@ mailbox), Academy forms, multiple staff users beyond the
existing staff check.

## Architecture

Everything that alerts Nelson today already passes through two places, so the
push hooks there and touches nothing in checkout, the Stripe webhook, or slot
logic:

1. `bk_email_queue` rows with `kind = 'nelson_alert'` (inquiries, paid
   bookings, balance failures, stuck payments, signed contracts).
2. `bk_messages` rows with `sender = 'client'`.

### New database objects (one migration, `20260923_bk_inbox.sql`)

- `bk_push_subscriptions` — `id, user_id (auth.users), endpoint unique,
  p256dh, auth, user_agent, created_at, last_ok_at`. RLS: staff only
  (`bk_is_staff()`, the check admin.html already uses), each user sees/inserts/deletes own rows.
- `bk_projects.inbox_handled_at timestamptz null` — set by Mark handled or by
  a successful Send; cleared when a new client message or alert arrives for
  that project. "Needs reply" = `inbox_handled_at is null`.
- `bk_messages.emailed_direct boolean not null default false` — when true,
  `bk_on_studio_message` skips its "you have a new message" email (the full
  reply is emailed instead; see Send).
- `bk_email_queue` kind check gains `'studio_reply'`.
- Trigger `bk_inbox_notify` (after insert on `bk_email_queue` where
  kind='nelson_alert', and on `bk_messages` where sender='client'): clears
  `inbox_handled_at` and calls `bk-push` via `net.http_post` (pg_net, already used by the mailer cron) with the
  row id + a shared secret from `bk_config.inbox_push_secret`. Fire-and-forget;
  a failed call never blocks the insert.
- RPC `bk_inbox_list(p_filter text, p_before timestamptz)` — staff-gated,
  returns the list rows (project, latest event, handled state) 30 at a time.

### New edge functions (all `--no-verify-jwt`, like every bk-* function)

- **`bk-push`** — authenticated by the shared secret. Loads the event, builds
  title/body/URL (`/inbox/?p=<project_id>`), sends Web Push (VAPID) to every
  subscription. Removes a subscription on 404/410. VAPID private key lives in
  Supabase secrets; public key in `js/config.js`.
- **`bk-draft-reply`** — staff JWT required (checked in code). Input:
  project id, optional rewrite note, optional current draft. Gathers facts:
  project fields, service row from `bk_services` (name, price, deposit, kind),
  next 6 open slots from `bk_open_slots` for session services, past projects
  for the email, last 10 messages. Calls the Claude API (`claude-opus-5`, low effort, server-side refusal fallback on)
  with a system prompt carrying Nelson's rules:
  - sign as Nelson, warm partnership voice, never salesy, short (≤120 words)
  - quote ONLY prices present in the facts; project/custom work → offer a
    quick call or a written quote, never a number
  - never invent policies, turnaround times, addresses (studio = "Downtown
    Dallas"), or availability not in the facts
  Returns `{ draft }`. On missing `ANTHROPIC_API_KEY` or any API error returns
  `{ draft: null, reason }`.
- **Send = SQL RPC `bk_inbox_send`** (was an edge function; a security-definer RPC does the same in one transaction) — staff-gated. Inserts the reply into
  `bk_messages` (sender='studio', emailed_direct=true) so it lives in the
  project thread and portal, queues a `studio_reply` email with the full body
  + portal link, pings `bk-mailer` via pg_net for instant delivery, sets
  `inbox_handled_at`. Idempotency key from the client prevents a double-tap
  double-send.
- **`bk-mailer`** gains a `studio_reply` renderer (branded template, full
  reply text, "View in your portal" link; reply-to stays Nelson's Gmail like every other bk email, so client answers land where he reads).

### Front end (`taylormade-book` repo)

- `inbox/index.html`, `js/inbox.js`, `css/inbox.css`, `inbox/manifest.webmanifest`,
  `inbox/sw.js` (push + notificationclick only; no asset caching, so deploys
  are never stale), app icon in `assets/`.
- Reuses `js/config.js` Supabase client and the login flow in `login.js`
  (redirect back to /inbox/ after sign-in).
- **Text it:** `sms:<phone>&body=<draft>`; **Call:** `tel:<phone>`. Both are
  hidden when no phone is on file. Neither marks handled automatically; the
  page asks "Sent it?" on return and offers Mark handled.

## Failure behavior

| Failure | Result |
|---|---|
| Push call fails / phone unsubscribed | Email alert still arrives (unchanged path) |
| Claude key missing or API error | Empty box, "Couldn't draft — write your own", Send still works |
| Session expired | Redirect to login, back to the same item after |
| Send double-tapped | Idempotency key → one message, one email |
| Not staff | RPCs and functions refuse; page shows sign-in |

## Testing

- Offline: unit tests for `bk-push` payload building, draft-prompt fact
  assembly (asserts no price appears when the service has none), and
  `bk_inbox_send` idempotency in a rolled-back SQL test inside the apply script.
- On production with real clicks (Nelson's iPhone + my browser rig): install,
  enable alerts, submit a test inquiry on the live site → phone buzzes → open
  → draft cites real price/slots → edit → Send → client inbox receives the
  full text → reload shows handled → second reply on same project also
  arrives → client portal message re-opens it. Then delete every test row and
  confirm no test project remains in admin.
- 4-agent review before Nelson sees it.

## Rollout (Nelson's steps)

1. `! bash ~/Downloads/apply-inbox.sh` — applies the migration via the
   Management API, generates VAPID keys + push secret, sets secrets, deploys
   `bk-push`, `bk-draft-reply`, `bk-mailer`.
2. Set `ANTHROPIC_API_KEY` in Supabase secrets (shared with the OPIL task).
3. Push `inbox-app:main` (GitHub Pages deploys the page).
4. Install on his iPhone and run one live test inquiry together.
