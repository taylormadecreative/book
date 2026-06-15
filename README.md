# TAYLORMADE / BOOK

Direct booking site + HoneyBook replacement for Taylormade Creative photo & video.
Live: **https://taylormadecreative.github.io/book/**

## The surfaces

| URL | What it is |
| --- | --- |
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

1. Client submits the form → project lands in **admin.html** under "New", client gets their portal link on-screen.
2. You reply in Messages, set a quote → **Add + send** an invoice (50% deposit).
3. Client hits **Pay now** in their portal → Stripe Checkout → webhook marks it paid and auto-moves the project to **Booked**.
4. Day-of: send the balance invoice the same way. Deliver via **Files** (paste a Drive/Dropbox/frame.io link).
5. **Copy portal link** button in admin = the link you text/DM to any client (works for projects you create manually with **+ New project** too).

## Backend

- Supabase project `taylormade-studio` (pgqdmnmessbbzyszjfvr) — tables `bk_projects`, `bk_invoices`, `bk_messages`, `bk_files`, `bk_galleries`, `bk_gallery_items` (RLS: staff full; clients via token RPCs + the `bk-media` edge function only).
- Private storage bucket `project-media` (staff-only RLS; clients reach media only through `bk-media` signed URLs).
- Edge functions: `bk-create-checkout`, `bk-stripe-webhook`, `bk-media` (all deployed).

### Client email login (one-time setup for production)

Login uses Supabase's built-in email (magic link). The default sender works but is **rate-limited to a few
emails/hour** — fine for testing. For production, set up custom SMTP in Supabase → Project Settings → Auth →
SMTP (e.g. Resend, Postmark, SendGrid) so login links always arrive. The token portal link works with no email
at all, so clients are never blocked.

## ⚡ One-time Stripe setup (payments are wired, just add keys)

1. Stripe Dashboard → Developers → API keys → copy the **Secret key**.
2. Supabase Dashboard → project `taylormade-studio` → Edge Functions → Secrets → add
   `STRIPE_SECRET_KEY = sk_live_…`
3. Stripe Dashboard → Developers → Webhooks → Add endpoint:
   `https://pgqdmnmessbbzyszjfvr.supabase.co/functions/v1/bk-stripe-webhook`
   — select event `checkout.session.completed`, then copy the **Signing secret**.
4. Add a second Supabase secret: `STRIPE_WEBHOOK_SECRET = whsec_…`

Until then, Pay buttons show "Payments coming online — message Nelson" (nothing breaks).

## Notes

- Admin login = the same email/password you use for the studio content portal.
- A demo project ("E2E Test Booking", $500 invoice) is in the pipeline so you can see it working — archive it whenever.
- No public pricing anywhere by design; quotes happen per-project, like HoneyBook.
