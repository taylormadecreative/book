// bk-stripe-webhook — marks booking invoices paid when Stripe Checkout completes.
// Authenticated by Stripe webhook signature (STRIPE_WEBHOOK_SECRET), not JWT.
// Deployed to Supabase project pgqdmnmessbbzyszjfvr.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  const whSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!key || !whSecret) return new Response("not configured", { status: 503 });

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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const invoiceId = session.metadata?.invoice_id;
    const projectId = session.metadata?.project_id;
    if (invoiceId) {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: inv } = await sb
        .from("bk_invoices")
        .update({ status: "paid", paid_at: new Date().toISOString(), payment_note: "Paid via Stripe Checkout" })
        .eq("id", invoiceId)
        .select("kind")
        .single();
      // a paid deposit moves the project into "booked"
      if (inv?.kind === "deposit" && projectId) {
        await sb
          .from("bk_projects")
          .update({ status: "booked" })
          .eq("id", projectId)
          .in("status", ["new", "quoted"]);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
