// Stripe-signed settlement; ledger, invoice and booking updates commit together.
// Deploy with verify_jwt=false. Failed persistence returns 500 so Stripe retries.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { reconcileEvent } from "../_shared/payment-core.ts";
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return new Response("not configured", { status: 503 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    const { data: config, error: configError } = await db.from("bk_config").select("value").eq("key", "stripe_webhook_secret_bk").maybeSingle();
    if (configError) return new Response("retry", { status: 503 });
    const envSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const cfgSecret = config?.value;
    if (envSecret && cfgSecret && envSecret !== cfgSecret) {
      console.error("WEBHOOK SECRET CONFLICT: environment and database signing secrets differ; environment wins. Check deployment configuration.");
    }
    const whSecret = envSecret || cfgSecret;
    if (!whSecret) return new Response("not configured", { status: 503 });
    const signature = req.headers.get("stripe-signature");
    if (!signature) return new Response("missing signature", { status: 400 });
    const stripe = new Stripe(key);
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(await req.text(), signature, whSecret, undefined, Stripe.createSubtleCryptoProvider());
    } catch {
      console.error("SIGNATURE VERIFICATION FAILED: check Stripe endpoint and deployed signing-secret configuration.");
      return new Response("invalid signature", { status: 400 });
    }
    if (!await reconcileEvent(event, db)) return new Response("retry", { status: 500 });
    // Preserve immediate confirmation/attention delivery; cron remains the backstop.
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const { data: cfg } = await db.from("bk_config").select("value").eq("key", "mailer_secret").maybeSingle();
      if (cfg?.value) {
        await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/bk-mailer", {
          method: "POST", headers: { "Content-Type": "application/json", "x-mailer-secret": cfg.value },
          body: "{}", signal: AbortSignal.timeout(2000),
        }).catch(() => {});
      }
    }
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch {
    console.error("Webhook persistence failed; requesting Stripe retry.");
    return new Response("retry", { status: 500 });
  }
});
