// bk-stripe-webhook — marks booking invoices paid when Stripe Checkout settles.
// Authenticated by Stripe webhook signature, not JWT. v7: the signing secret is
// read from STRIPE_WEBHOOK_SECRET (env) when set, otherwise from bk_config
// (key='stripe_webhook_secret_bk'), which bk-setup-webhook provisions when it
// creates the endpoint. Also pings bk-mailer after a successful payment so the
// booking confirmation email goes out immediately instead of on the next cron.
// DB triggers (bk_invoice_paid → bk_booking_confirmed_*) do the state changes
// and queue the client emails; this function only marks the invoice paid.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function getConfig(db: ReturnType<typeof sb>, key: string): Promise<string> {
  const { data } = await db.from("bk_config").select("value").eq("key", key).maybeSingle();
  return (data?.value as string | undefined) ?? "";
}

async function markPaid(session: Stripe.Checkout.Session): Promise<boolean> {
  const invoiceId = session.metadata?.invoice_id;
  const projectId = session.metadata?.project_id;
  if (!invoiceId) return true; // not ours; ack
  const db = sb();

  const { data: inv, error: readErr } = await db
    .from("bk_invoices")
    .select("id, kind, status, amount_cents")
    .eq("id", invoiceId)
    .single();
  if (readErr || !inv) return false; // let Stripe retry
  if (inv.status === "paid") return true; // idempotent
  if (session.amount_total != null && session.amount_total !== inv.amount_cents) {
    console.error(`amount mismatch: session ${session.amount_total} vs invoice ${inv.amount_cents}`);
    return false;
  }

  const { error: updErr } = await db
    .from("bk_invoices")
    .update({ status: "paid", paid_at: new Date().toISOString(), payment_note: "Paid via Stripe Checkout" })
    .eq("id", invoiceId)
    .eq("status", "sent");
  if (updErr) return false;

  // a settled deposit (or digitals full payment) moves the project into "booked"
  if ((inv.kind === "deposit" || inv.kind === "full") && projectId) {
    await db
      .from("bk_projects")
      .update({ status: "booked" })
      .eq("id", projectId)
      .in("status", ["new", "quoted"]);
  }

  // fire-and-forget: drain the queue now so the confirmation lands immediately
  try {
    const secret = await getConfig(db, "mailer_secret");
    if (secret) {
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/bk-mailer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mailer-secret": secret },
        body: "{}",
      }).catch(() => {});
    }
  } catch (_) { /* cron will pick it up */ }

  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return new Response("not configured", { status: 503 });

  const db = sb();
  const whSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ||
    await getConfig(db, "stripe_webhook_secret_bk");
  if (!whSecret) return new Response("not configured", { status: 503 });

  const stripe = new Stripe(key);
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      whSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (e) {
    console.error("signature verification failed", e);
    return new Response("invalid signature", { status: 400 });
  }

  let ok = true;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    // async methods (ACH etc.) complete the session before funds settle —
    // only mark paid when Stripe says the payment itself is settled
    if (session.payment_status === "paid") ok = await markPaid(session);
  } else if (event.type === "checkout.session.async_payment_succeeded") {
    ok = await markPaid(event.data.object as Stripe.Checkout.Session);
  } else if (event.type === "checkout.session.async_payment_failed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const invoiceId = session.metadata?.invoice_id;
    if (invoiceId) {
      await db
        .from("bk_invoices")
        .update({ payment_note: "Payment attempt failed (async method) — ask client to retry" })
        .eq("id", invoiceId)
        .eq("status", "sent");
    }
  }

  if (!ok) return new Response("retry", { status: 500 }); // Stripe retries
  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
