// bk-create-checkout — creates (or reuses) a Stripe Checkout session for a booking invoice.
// Auth model: anonymous callers must present the project's access_token (same
// token that gates the client portal). verify_jwt is disabled for that reason.
// v8: optional return_url (whitelisted to Taylormade domains) so the new
// www.taylormadecreative.net booking flow can land on its own success page.
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

const SITE_BASE = "https://book.taylormadecreative.net";
const ALLOWED_RETURN_PREFIXES = [
  "https://www.taylormadecreative.net/",
  "https://taylormadecreative.net/",
  "https://taylormadecreative.github.io/",
  "https://book.taylormadecreative.net/",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const { invoice_id, token, return_url } = await req.json();
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

    // Reuse an existing open session instead of minting a second payable one —
    // closes the double-payment window between redirect and webhook.
    if (inv.stripe_session_id) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(inv.stripe_session_id);
        if (existing.payment_status === "paid") return json({ error: "already_paid" }, 409);
        if (existing.status === "open" && existing.url) return json({ url: existing.url });
      } catch (_) { /* expired or invalid — fall through and create fresh */ }
    }

    const portalUrl = `${SITE_BASE}/portal.html?p=${inv.bk_projects.id}&t=${token}`;
    let successUrl = `${portalUrl}&paid=1`;
    let cancelUrl = portalUrl;
    if (
      typeof return_url === "string" &&
      ALLOWED_RETURN_PREFIXES.some((p) => return_url.startsWith(p)) &&
      return_url.length <= 600
    ) {
      const sep = return_url.includes("?") ? "&" : "?";
      successUrl = `${return_url}${sep}paid=1`;
      cancelUrl = `${return_url}${sep}cancelled=1`;
    }

    // the buyer's own name doesn't belong in the product string — prefer the
    // invoice's first line item ("Digitals Session · Jul 10, 2026 2:00 PM")
    const nLines = Array.isArray(inv.line_items) ? inv.line_items.length : 0;
    const lineTitle =
      ((nLines > 0 && inv.line_items[0]?.title) ||
        `${inv.title} — ${inv.bk_projects.title ?? "Taylormade Creative"}`) +
      (nLines > 1 ? ` (+${nLines - 1} add-on${nLines > 2 ? "s" : ""})` : "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: inv.bk_projects.client_email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: lineTitle },
            unit_amount: inv.amount_cents,
          },
          quantity: 1,
        },
      ],
      metadata: { invoice_id: inv.id, project_id: inv.bk_projects.id },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    await sb.from("bk_invoices").update({ stripe_session_id: session.id }).eq("id", inv.id);
    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
