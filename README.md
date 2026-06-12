# TAYLORMADE / BOOK

Direct booking site + HoneyBook replacement for Taylormade Creative photo & video.
Live: **https://taylormadecreative.github.io/book/**

## The three surfaces

| URL | What it is |
| --- | --- |
| `/book/` | Marketing + booking page. Inquiry wizard creates a project + private portal instantly. |
| `/book/portal.html?p=…&t=…` | Client portal (tokenized link, no login): status tracker, invoices + pay, messages, delivery files. |
| `/book/admin.html` | Studio dashboard (your existing portal login): pipeline, invoices, messages, files, internal notes. |

## How a booking flows

1. Client submits the form → project lands in **admin.html** under "New", client gets their portal link on-screen.
2. You reply in Messages, set a quote → **Add + send** an invoice (50% deposit).
3. Client hits **Pay now** in their portal → Stripe Checkout → webhook marks it paid and auto-moves the project to **Booked**.
4. Day-of: send the balance invoice the same way. Deliver via **Files** (paste a Drive/Dropbox/frame.io link).
5. **Copy portal link** button in admin = the link you text/DM to any client (works for projects you create manually with **+ New project** too).

## Backend

- Supabase project `taylormade-studio` (pgqdmnmessbbzyszjfvr) — tables `bk_projects`, `bk_invoices`, `bk_messages`, `bk_files` (RLS: admin full, clients via token RPCs only).
- Edge functions: `bk-create-checkout`, `bk-stripe-webhook` (both deployed).

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
