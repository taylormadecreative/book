# TAYLORMADE / BOOK

Studio CRM and direct booking site for Taylormade Creative photo & video. Stripe and HoneyBook remain separate billing systems, selected and locked per project.
Live: **https://book.taylormadecreative.net/** (custom subdomain via Cloudflare DNS → GitHub Pages; the old `taylormadecreative.github.io/book/` auto-redirects here).

## Hosting & deploys

- **Domain:** `book` CNAME in Cloudflare DNS → `taylormadecreative.github.io`. HTTPS enforced (GitHub-issued cert).
- **Deploys:** GitHub **Actions** (`.github/workflows/deploy-pages.yml`), not the legacy Jekyll builder. The legacy builder 0-duration-fails whenever a `CNAME` file is present on this repo, so Pages `build_type` is set to `workflow`. Just `git push` to `main` and the workflow publishes. (Ignore the `status: errored` field in the Pages REST API — it's the frozen legacy-builder status and no longer used.)
- **Client login** depends on the subdomain being in Supabase → Auth → URL Configuration → Redirect URLs (`https://book.taylormadecreative.net/**`).

## The surfaces

| URL | What it is |
| --- | --- |
| `/crm/` | Daily workspace: due/overdue next actions, searchable pipeline, clients and repeat jobs, production tasks, quotes, billing ownership, activity, reporting and CSV exports. |
| `/crm/?view=money` | Open money: every proposal, contract and invoice a client still has to decide, sign or pay, grouped by whose move it is, with proposal view counts. Kept by hand. |
| `/inbox/` | Conversations and template-based replies, with server-side search, pagination and complete staff totals. |
| `/book/` | Marketing + booking page. Inquiry wizard creates a project + private portal instantly. |
| `/book/portal.html?p=…&t=…` | Client portal (tokenized link, no login): status, invoices + pay, messages, delivery files, **and Photos & Video** (proofing + downloads). |
| `/book/login.html` → `/book/gallery.html` | **Client login** (email magic-link, no password). Lands on their gallery hub: proofing, edited photos, video downloads, across all their projects. |
| `/book/admin.html` | Studio dashboard (staff login): pipeline, invoices, messages, files, notes, **and Galleries — upload photos/video, see client picks, lock proofing**. |

## Photos, proofing & delivery (the client gallery flow)

1. After the shoot, open the project in **admin.html** → the **Galleries** card → **New gallery**:
   - **Proofing** (set a pick limit if you want) → upload the previews. The client selects which shots they want edited.
   - **Edited photos** → upload the finished edits. The client views and downloads them.
   - **Video** → upload the cut. The client streams and downloads it.
2. The client reaches their media two ways, both showing the same galleries:
   - their **portal link** (`portal.html?p=…&t=…`) — no login, and
   - **login.html** — they enter the email they booked with, get a one-tap magic link, and land on `gallery.html`.
3. When a client submits their proofing picks, the gallery **locks** and a message lands in your thread
   ("Selected N images for editing…"). Selected shots show a gold ring in your admin Galleries card.

### Adding a second staff member (your future employee)

In Supabase → Authentication → add the user (email + password), then in the SQL editor:
`insert into public.profiles (id, role, full_name) values ('<their auth user id>', 'employee', 'Their Name');`
Employees get the same admin dashboard + upload access. Only `admin`/`employee` roles can reach galleries or storage.

## How a booking flows

1. Client submits the form → the lead appears in **CRM** and **Inbox**, with an owner and first follow-up task. The client receives their private portal link on-screen. Staff can also create a lead without an email address and add it later.
2. Reply using a template, prepare a versioned quote, and publish it for client approval. Set the project's billing provider explicitly before creating an invoice. Use the agreed deposit and balance terms for that project.
3. Stripe projects use portal Checkout; verified payment events record the actual collected amount. Existing booking rules apply, and conflicting or late payments require staff review. HoneyBook projects use their saved HoneyBook billing link and require staff to record payments in this CRM after checking HoneyBook.
4. Manage shoot dates, production tasks and delivery deadlines in **CRM**. Deliver through galleries or **Files**, then complete the delivery and rebooking follow-ups. Only bookings with existing saved-card authorization and scheduled Stripe balances use the automatic balance worker.
5. **Copy portal link** in Studio provides the private link for manually created and online projects. Quote approval alone does not reserve a date or record a payment.

## Backend

- Supabase project `taylormade-studio` (pgqdmnmessbbzyszjfvr) — tables `bk_projects`, `bk_invoices`, `bk_messages`, `bk_files`, `bk_galleries`, `bk_gallery_items` (RLS: staff full; clients via token RPCs + the `bk-media` edge function only).
- Private storage bucket `project-media` (staff-only RLS; clients reach media only through `bk-media` signed URLs).
- Edge functions: `bk-create-checkout`, `bk-stripe-webhook`, `bk-media` (all deployed).

### Client email login (one-time setup for production)

Login uses Supabase's built-in email (magic link). The default sender works but is **rate-limited to a few
emails/hour** — fine for testing. For production, set up custom SMTP in Supabase → Project Settings → Auth →
SMTP (e.g. Resend, Postmark, SendGrid) so login links always arrive. The token portal link works with no email
at all, so clients are never blocked.

## Stripe server configuration

Preserve the existing production keys and webhook when deploying this release. For a new environment, configure server secrets and a verified Stripe webhook before enabling collection:

1. Stripe Dashboard → Developers → API keys → copy the **Secret key**.
2. Supabase Dashboard → project `taylormade-studio` → Edge Functions → Secrets → add
   `STRIPE_SECRET_KEY = sk_live_…`
3. Stripe Dashboard → Developers → Webhooks → Add endpoint:
   `https://pgqdmnmessbbzyszjfvr.supabase.co/functions/v1/bk-stripe-webhook`
   — select event `checkout.session.completed`, then copy the **Signing secret**.
4. Add a second Supabase secret: `STRIPE_WEBHOOK_SECRET = whsec_…`

Missing payment configuration must be resolved before collecting through Stripe. Never put Stripe secret keys or signing secrets in frontend files or Git.

## Notes

- Admin login = the same email/password you use for the studio content portal.
- A demo project ("E2E Test Booking", $500 invoice) is in the pipeline so you can see it working — archive it whenever.
- No public pricing anywhere by design; quotes happen per-project, like HoneyBook.

## CRM release (2026-11-16)

### Studio workflow additions

- **Client preparation** appears at the top of each CRM project. Use the service checklist, edit its questions, then publish it to the client's existing portal. Clients can save partial answers and submit for your review. A revised checklist keeps the previous answers in its history.
- **Morning follow-up** on Today opens the conversation or a deterministic reply template. Project cadence settings schedule one staff action at a time and pause after client responses. Booking and closing end the sales cadence.
- **Capture** saves a pasted conversation, contact channel and next action together. Install the CRM from your phone browser for a home-screen shortcut. Supported browsers can share text directly into Capture.
- **Video review** publishes a specific available video version for timestamped feedback and approval in the portal. Publish a fresh review when the file or payment access changes. Resolve client notes in the CRM project.
- **Reports** compares project opportunities, bookings and recorded receipts by normalized source and campaign, with date filters and response times. Website forms capture campaign labels and the referring host while removing URL query strings from stored page paths.
- **Project earnings** combines recorded receipts, entered expenses and logged time. Set staff internal hourly cost assumptions to include labor. The contribution calculation is receipts minus recorded costs and labor assumptions, before overhead and tax.
- **Editing workload** combines daily editing blocks, staff capacity, existing tasks and bookings in Central Time. Plan work here and manage shoot availability in Schedule.
- **Open money** (`/crm/?view=money`, added 2026-11-17) lists every proposal, contract and invoice a client still has to decide, sign or pay, wherever it lives (a proposal page, HoneyBook, Stripe, Zelle, a bank transfer). Rows group into Your move, Overdue, Waiting on the client and On hold, with a total of open money and a line on Today. The list is kept by hand: nothing is imported from HoneyBook, email or a bank, and the screen sends nothing. Closing an item as Paid only ends the reminder; it records no payment on a project. Adding one needs only a client name and a title. Each item has a tracking code for its proposal page (`js/proposal-beacon.js`); the database stores only the first view, the last view and a count, never an IP address or device details, counts at most one view per item per 30 minutes, and skips test browsers, plain http, localhost and any browser opened once with `?notrack=1`. Migration: `20261118090000_crm_open_money.sql` (additive; staff-only table reached through functions, with one public view counter). Real items are entered through the screen or the database, never committed to this public repository.
- **Monthly packages** records included deliverables, fulfillment, remaining allowances and renewal tasks. Open a monthly work period from the package to create its linked project, then prepare its billing draft using the assigned provider. Clients see their period allowances in the portal.

The CRM adds a customer record linked to multiple jobs, email-optional manual leads, retry-safe public and manual intake, scheduled next actions, stage-driven preparation/delivery/rebooking tasks, an immutable activity history, and versioned quotes. Published quotes can be approved or declined in the existing client portal. Quote approval does not reserve a date or record a payment. No AI drafting is used.

Today highlights active projects without a next action, failed/stalled queued messages, held incoming replies, billing that needs confirmation, and payments needing booking review. Search and totals are calculated before pagination. HoneyBook balances require explicit manual recording; the app does not claim an automatic HoneyBook synchronization.

### Local verification

Use Node 22+ and Deno 2. Install dependencies with `npm ci`, then `npx playwright install chromium webkit`. Run `npm test`. Database suites use isolated PostgreSQL through PGlite with synthetic fixtures; browser suites intercept backend calls and never submit live messages or payments. On a Mac with Chrome already installed, use `PW_CHROME=1 npm run test:e2e`. For local preview, run `npm run dev` and open `/crm/`.

The new GitHub workflow runs syntax, unit, database, edge-function and browser checks before publishing. Only static application files are uploaded; tests, migrations, dependencies and developer files are excluded from the Pages artifact.

### Deployment order

1. Preserve the currently deployed function versions and confirm the installed base schema. The foundation migration captures the pre-release project, invoice, booking and queue records in protected `bk_crm_private.release_*_before` tables inside Supabase; browser roles cannot access them. Older feature migrations already exist in production even where historical migration tracking is incomplete. This repository's tests provide a synthetic prerequisite fixture, not a complete replacement for the original shared studio database.
2. Record the job IDs and current active states of the `bk-charge-balances` and mailer cron jobs. Pause both jobs using `cron.alter_job(job_id, active := false)`, then confirm any existing Edge Function invocations have finished before continuing. Pausing a schedule does not cancel an invocation already running. A completed cron row alone is insufficient: `net.http_post` dispatches asynchronously, so check its completed HTTP response and Edge execution logs. Keep the jobs paused through the backend rollout, including if a deployment fails.
3. Deploy the hardened `bk-create-checkout`, `bk-mailer`, and `bk-charge-balances` before the database changes, including their shared modules. Checkout and mail delivery fail closed until their matching migrations exist. The balance worker stays paused until the provider schema and receipt columns are installed; do not invoke it manually during rollout.
4. Apply the new migrations in filename order: `crm_foundation`, `crm_payment_integrity`, `crm_intake_retries`, `crm_inbound_email`, `crm_operational_health`. Apply the existing content-calendar migration only if its table is absent. These are additive and do not send messages or charge clients.
5. Deploy `bk-stripe-webhook` and `bk-inbound-email`, including their shared modules. Keep the existing server secrets in Supabase. Never put secret values in Git or browser code. Verify the installed migrations, provider routing, queue holds and hardened function versions before restoring only the cron jobs that were active before rollout. Do not manually drain either worker as a deployment check.
6. Publish the frontend only after the migrations and functions are ready. Verify staff/client access, health counts and the new pages using read-only checks. No production test sends or payments are required.

Existing billing is assigned only from deterministic evidence. Unknown projects require staff confirmation. Conflicting historical evidence stays flagged; an admin can reconcile it once with a recorded reason, preserving every historical invoice/payment. Never infer a provider from the amount alone.

### Incoming email connection

Portal replies work directly. Ordinary email replies can also return to the project using Resend Receiving:

- Connect and verify an incoming mail subdomain in Resend, with its required DNS records. This is separate from the existing outbound sending domain.
- Configure the signed `email.received` webhook to `bk-inbound-email` and store `RESEND_WEBHOOK_SECRET` in Supabase secrets. The receiving function also needs `RESEND_API_KEY`.
- Set the project-wide `CRM_INBOUND_DOMAIN` to the verified receiving domain. Enable outgoing reply routing only after receiving DNS and the signed webhook are verified, by setting `CRM_INBOUND_REPLY_TO_ENABLED=true`. Until then, outgoing email keeps the existing Gmail reply address. For rollback, disable that outgoing switch while retaining the receiver configuration so replies to previously issued addresses can still arrive.
- Project reply aliases use independent random capabilities, never portal tokens. The receiver verifies the raw webhook signature, fetches the authoritative email, checks sender authentication and matching project email, and prevents duplicate events/messages. Unverified or mismatched replies become staff review tasks. Attachments remain in Resend for manual review.

The migration holds all previously attempted, unsent legacy messages for delivery review, regardless of age. It does not blindly retry an old worker's ambiguous result. The new mailer fails closed until the snapshot migration is installed, so deploy it before applying that migration. Never manually drain the queue during rollout.

The mailer snapshots each outgoing request and uses a stable Resend idempotency key for retries. Resend retains those keys for 24 hours; ambiguous deliveries older than 23 hours are held for review instead of blindly retried.

### Rollback

Revert the frontend commit and redeploy its static files if necessary. Keep the additive CRM tables, recorded quotes, billing assignments and hardened payment workers. The old checkout and automatic-balance worker do not enforce project billing ownership; do not restore them and resume collection. Retain the canonical, idempotent mailer as well: restoring the unkeyed sender could duplicate ambiguous deliveries. If a backend regression affects one of these workers, leave its cron paused until a reviewed forward fix is deployed. Restore other function versions only when compatible with the retained schema. Do not drop tables containing new customer/workflow records.
