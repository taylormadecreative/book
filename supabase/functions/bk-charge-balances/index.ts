// bk-charge-balances — charges the remaining balance on deposit bookings the
// day before the shoot, off-session, against the card saved at deposit
// checkout (bk-create-checkout v11 sets setup_future_usage=off_session).
//
// Invoked hourly by pg_cron ('bk-charge-balances'). Auth: x-mailer-secret must
// match bk_config.mailer_secret (same internal secret the mailer cron uses).
// Deployed with verify_jwt=false like every bk-* function.
//
// Per booking (status confirmed, balance_status scheduled, shoot < 24h away):
//   claim it (scheduled → charging, so two overlapping runs can't both charge)
//   → create/reuse a DRAFT balance invoice (draft = no "quote ready" email)
//   → PaymentIntent off_session + confirm, idempotency key per booking
//   success → invoice paid (DB triggers: booking balance_status=paid, Nelson
//             payment alert) + client receipt email
//   card declined (incl. needs authentication)
//           → invoice 'sent' so the client can pay it in their portal,
//             client "balance due" email + Nelson alert        (status failed)
//   no saved card / deposit not paid via Stripe / any non-card Stripe error
//           → Nelson alert only, client not emailed            (status attention)
//   already paid another way / balance invoice voided → never charged (waived)
//   network or rate-limit hiccup → retried next hour, max 3 tries, then attention
//   the BOOKING row is marked paid first after a successful charge — it is
//   what stops a second charge, not the invoice
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const TZ = "America/Chicago";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
type DB = ReturnType<typeof sb>;

const fmtWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));

async function queue(db: DB, row: Record<string, unknown>) {
  const { error } = await db.from("bk_email_queue").insert(row);
  if (error) console.error(`email queue insert failed (${row.kind}): ${error.message}`);
}

// the saved card lives on the deposit checkout's PaymentIntent
async function savedCard(stripe: Stripe, sessionId: string | null) {
  if (!sessionId) return null;
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  const pi = session.payment_intent as Stripe.PaymentIntent | null;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const pm = pi && (typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id);
  if (session.payment_status !== "paid" || pi?.status !== "succeeded") return null;
  if (!customer || !pm || pi.setup_future_usage !== "off_session") return null;
  return { customer, pm };
}

// Central calendar date (the portal shows due_date as-is)
const ctDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

type Booking = {
  id: string; project_id: string; starts_at: string; invoice_id: string | null;
  balance_cents: number; balance_invoice_id: string | null; balance_attempts: number;
  bk_services: { name: string } | null;
};

// Only a dropped connection or rate limit is worth retrying. Everything else
// (detached card, deleted customer, idempotency mismatch, a Stripe 500 that the
// idempotency key would just replay) gets a human instead of a silent loop.
const isTransient = (e: unknown) => {
  const t = (e as { type?: string })?.type;
  return t === "StripeConnectionError" || t === "StripeRateLimitError" ||
    (e as { code?: string })?.code === "lock_timeout";
};

async function alertNelson(db: DB, b: Booking, type: string, reason: string) {
  await queue(db, { kind: "nelson_alert", project_id: b.project_id, booking_id: b.id,
    payload: { type, amount_cents: b.balance_cents, reason, service_name: b.bk_services?.name ?? "a session",
               starts_at_ct: fmtWhen(b.starts_at) } });
}

// Stop auto-charging and tell Nelson. The client is NOT emailed: nothing was
// declined on their side, so a "your card failed" email would be false.
async function attention(db: DB, b: Booking, reason: string) {
  await db.from("bk_bookings").update({ balance_status: "attention", balance_error: reason.slice(0, 300) }).eq("id", b.id);
  await alertNelson(db, b, "balance_attention", reason);
  return "attention";
}

async function chargeOne(db: DB, stripe: Stripe, b: Booking): Promise<string> {
  // Billing routing is fixed per project, including every automatic balance.
  const { data: project, error: providerError } = await db.from("bk_projects")
    .select("billing_provider").eq("id", b.project_id).single();
  if (providerError) throw new Error("billing provider read failed");
  if (project?.billing_provider !== "stripe") {
    return await attention(db, b, "Automatic Stripe charging is disabled: confirm this project's billing provider and collect through that provider.");
  }
  const svcName = b.bk_services?.name ?? "Session";

  // already settled another way (Nelson recorded a paid Balance / Full invoice)?
  const { data: otherPaid } = await db.from("bk_invoices").select("id")
    .eq("project_id", b.project_id).eq("status", "paid").in("kind", ["balance", "full"])
    .neq("id", b.balance_invoice_id ?? "00000000-0000-0000-0000-000000000000").limit(1);
  if (otherPaid?.length) {
    await db.from("bk_bookings").update({ balance_status: "waived", balance_error: "paid another way — not charged" }).eq("id", b.id);
    return "waived_paid_elsewhere";
  }

  // deposit must have gone through Stripe checkout — that's where the card is
  const { data: dep } = await db.from("bk_invoices")
    .select("status, stripe_session_id").eq("id", b.invoice_id ?? "").maybeSingle();
  if (!dep || dep.status !== "paid") {
    return await attention(db, b, "the deposit invoice isn't marked paid, so there's no card to charge — collect the balance by hand");
  }

  // balance invoice: reuse on retry (only while still a draft), else create one
  let invoiceId = b.balance_invoice_id;
  if (invoiceId) {
    const { data: bi } = await db.from("bk_invoices").select("status").eq("id", invoiceId).maybeSingle();
    if (bi?.status === "void") {
      await db.from("bk_bookings").update({ balance_status: "waived", balance_error: "balance invoice voided — not charged" }).eq("id", b.id);
      return "waived_void";
    }
    if (bi?.status === "paid") {
      await db.from("bk_bookings").update({ balance_status: "paid", balance_error: null }).eq("id", b.id);
      return "already_paid";
    }
    if (bi?.status !== "draft") {
      return await attention(db, b, `balance invoice is '${bi?.status ?? "missing"}', not draft — check it before charging`);
    }
  } else {
    const { data: inv, error } = await db.from("bk_invoices").insert({
      project_id: b.project_id,
      title: "Remaining balance",
      line_items: [{ title: `${svcName} · ${fmtWhen(b.starts_at)} — remaining balance`, amount_cents: b.balance_cents }],
      amount_cents: b.balance_cents,
      kind: "balance",
      status: "draft",
      due_date: ctDate(b.starts_at),
    }).select("id").single();
    if (error || !inv) throw new Error(`balance invoice insert failed: ${error?.message}`);
    invoiceId = inv.id as string;
    // must be linked BEFORE any charge: the paid/void/"no quote email" triggers key on it
    const { error: linkErr } = await db.from("bk_bookings").update({ balance_invoice_id: invoiceId }).eq("id", b.id);
    if (linkErr) throw new Error(`balance invoice link failed: ${linkErr.message}`);
  }

  // card actually declined → client gets a pay link in their portal
  const fail = async (reason: string) => {
    await db.from("bk_invoices").update({ status: "sent", payment_note: `Auto-charge failed: ${reason}` })
      .eq("id", invoiceId).eq("status", "draft");
    await db.from("bk_bookings").update({ balance_status: "failed", balance_error: reason.slice(0, 300) }).eq("id", b.id);
    await queue(db, { kind: "balance_failed", project_id: b.project_id, booking_id: b.id,
      payload: { invoice_id: invoiceId, amount_cents: b.balance_cents } });
    await alertNelson(db, b, "balance_failed", reason);
    return "failed";
  };

  const card = await savedCard(stripe, dep.stripe_session_id);
  if (!card) return await attention(db, b, "no saved card on the deposit payment — collect the balance by hand");

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create({
      amount: b.balance_cents,
      currency: "usd",
      customer: card.customer,
      payment_method: card.pm,
      payment_method_types: ["card"],
      off_session: true,
      confirm: true,
      description: `${svcName} — remaining balance`,
      metadata: { invoice_id: invoiceId, project_id: b.project_id, booking_id: b.id, kind: "balance" },
    }, { idempotencyKey: `bk-balance-${b.id}` });
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    if (err?.type === "StripeCardError") return await fail(err.message ?? err.code ?? "card declined");
    if (isTransient(e)) throw e;
    return await attention(db, b, `Stripe error: ${err?.message ?? String(e)}`);
  }

  await db.from("bk_bookings").update({ balance_payment_intent: pi.id }).eq("id", b.id);
  if (pi.status !== "succeeded") return await fail(`payment ${pi.status}`);

  // money moved: the BOOKING is the source of truth for "don't charge again",
  // so mark it paid by id first. A throw here retries into the same
  // idempotency key, which replays this PaymentIntent — never a second charge.
  const { error: bkErr } = await db.from("bk_bookings")
    .update({ balance_status: "paid", balance_error: null, balance_payment_intent: pi.id }).eq("id", b.id);
  if (bkErr) throw new Error(`booking paid update failed: ${bkErr.message}`);

  const { data: paidRows, error: upErr } = await db.from("bk_invoices").update({
    status: "paid",
    paid_at: new Date().toISOString(),
    paid_amount_cents: pi.amount_received,
    payment_note: `Charged automatically to the saved card (${pi.id})`,
  }).eq("id", invoiceId).in("status", ["draft", "sent"]).select("id");
  if (upErr || !paidRows?.length) {
    await queue(db, { kind: "nelson_alert", project_id: b.project_id, booking_id: b.id,
      payload: { type: "payment_unreconciled", subject: "Balance charged but invoice not marked paid",
                 detail: `Charged ${pi.id} for invoice ${invoiceId}${upErr ? ` (${upErr.message})` : " (invoice was no longer draft/sent)"}; mark it paid by hand. The client will not be charged again.`,
                 amount_cents: b.balance_cents, payment_intent: pi.id, invoice_id: invoiceId } });
  }
  await queue(db, { kind: "balance_charged", project_id: b.project_id, booking_id: b.id,
    payload: { invoice_id: invoiceId, amount_cents: b.balance_cents } });
  return "charged";
}

const MAX_TRIES = 3;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = sb();

  const { data: cfg } = await db.from("bk_config").select("value").eq("key", "mailer_secret").maybeSingle();
  if (!cfg?.value || req.headers.get("x-mailer-secret") !== cfg.value) return json({ error: "unauthorized" }, 401);

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return json({ error: "payments_not_configured" }, 503);
  const stripe = new Stripe(key);

  const now = Date.now();

  // a run that died mid-charge leaves 'charging' behind; hand it back after
  // 30 min. Safe to retry: the PaymentIntent idempotency key is per booking,
  // so a charge that did go through comes back as the same PaymentIntent.
  await db.from("bk_bookings").update({ balance_status: "scheduled" })
    .eq("balance_status", "charging")
    .lt("balance_attempted_at", new Date(now - 30 * 60 * 1000).toISOString());
  // missed the window entirely (outage, repeated errors): tell Nelson once
  const { data: missed } = await db.from("bk_bookings")
    .select("id, project_id, starts_at, invoice_id, balance_cents, balance_invoice_id, balance_attempts, bk_services(name)")
    .eq("balance_status", "scheduled")
    .in("status", ["confirmed", "completed"])
    .lt("starts_at", new Date(now - 12 * 3600 * 1000).toISOString())
    .limit(25);
  for (const m of (missed ?? []) as unknown as Booking[]) {
    await attention(db, m, "the automatic balance charge never ran before the shoot — collect it by hand");
  }

  const { data: due, error } = await db.from("bk_bookings")
    .select("id, project_id, starts_at, invoice_id, balance_cents, balance_invoice_id, balance_attempts, bk_services(name)")
    .eq("status", "confirmed")
    .eq("balance_status", "scheduled")
    .lte("starts_at", new Date(now + 24 * 3600 * 1000).toISOString())
    .gte("starts_at", new Date(now - 12 * 3600 * 1000).toISOString())
    .limit(25);
  if (error) return json({ error: "read_failed", detail: error.message }, 500);

  const results: Record<string, string> = {};
  for (const b of (due ?? []) as unknown as Booking[]) {
    // claim: only one run may move scheduled → charging
    const tries = (b.balance_attempts ?? 0) + 1;
    const { data: claimed } = await db.from("bk_bookings")
      .update({ balance_status: "charging", balance_attempted_at: new Date().toISOString(), balance_attempts: tries })
      .eq("id", b.id).eq("balance_status", "scheduled").eq("status", "confirmed").select("id");
    if (!claimed?.length) continue;
    try {
      results[b.id] = await chargeOne(db, stripe, b);
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 300);
      console.error(`balance charge error for booking ${b.id} (try ${tries}): ${msg}`);
      const soon = new Date(b.starts_at).getTime() - Date.now() < 6 * 3600 * 1000;
      if (tries >= MAX_TRIES || soon) {
        results[b.id] = await attention(db, b, `couldn't confirm the charge after ${tries} tries (${msg}). Check Stripe for a payment from this client FIRST — a charge may have gone through — then collect by hand only if there isn't one`);
      } else {
        await db.from("bk_bookings").update({ balance_status: "scheduled", balance_error: msg }).eq("id", b.id);
        results[b.id] = "retry_next_run";
      }
    }
  }

  // fire the mailer now so receipts / pay links don't wait for its cron
  if (Object.keys(results).length) {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/bk-mailer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mailer-secret": String(cfg.value) },
      body: "{}",
    }).catch(() => {}); // the mailer's own 10-minute cron is the backstop
  }
  return json({ checked: (due ?? []).length, results });
});
