// bk-create-checkout — creates a Stripe Checkout session for a booking invoice.
// Auth model: anonymous callers must present the project's access_token (same
// token that gates the client portal). verify_jwt is disabled for that reason.
// Deployed to Supabase project pgqdmnmessbbzyszjfvr.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const SITE_BASE = "https://taylormadecreative.github.io/book";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const { invoice_id, token } = await req.json();
    if (!invoice_id || !token) return json({ error: "bad_request" }, 400);

    const key = Deno.env.get("STRIPE_SECRET_KEY");
    if (!key) return json({ error: "payments_not_configured" }, 503);

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: inv, error } = await sb
      .from("bk_invoices")
      .select("*, bk_projects!inner(id, access_token, client_email, title)")
      .eq("id", invoice_id)
      .single();
    if (error || !inv) return json({ error: "not_found" }, 404);
    if (inv.bk_projects.access_token !== token) return json({ error: "not_found" }, 404);
    if (inv.status === "paid") return json({ error: "already_paid" }, 409);
    if (inv.status !== "sent") return json({ error: "not_payable" }, 409);

    const stripe = new Stripe(key);
    const portalUrl = `${SITE_BASE}/portal.html?p=${inv.bk_projects.id}&t=${token}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: inv.bk_projects.client_email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${inv.title} — ${inv.bk_projects.title ?? "Taylormade Creative"}`,
            },
            unit_amount: inv.amount_cents,
          },
          quantity: 1,
        },
      ],
      metadata: { invoice_id: inv.id, project_id: inv.bk_projects.id },
      success_url: `${portalUrl}&paid=1`,
      cancel_url: portalUrl,
    });

    await sb.from("bk_invoices").update({ stripe_session_id: session.id }).eq("id", inv.id);
    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
