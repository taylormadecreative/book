// Dependency-injected payment logic. Tests use local fakes; no Stripe calls.
type Result = { data: any; error: any };
export type PaymentDB = {
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<Result>;
};
export type CheckoutStripe = { checkout: { sessions: {
  retrieve: (id: string) => Promise<any>;
  expire: (id: string) => Promise<any>;
  create: (params: any, options: { idempotencyKey: string }) => Promise<any>;
} } };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const RETURN_PREFIXES = [
  "https://jenelstudios.com/", "https://www.jenelstudios.com/",
  "https://studio.taylormadecreative.net/", "https://www.taylormadecreative.net/",
  "https://taylormadecreative.net/", "https://taylormadecreative.github.io/",
  "https://book.taylormadecreative.net/",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function checkout(req: Request, deps: { db: PaymentDB; stripe: CheckoutStripe; now?: () => number }) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const { db, stripe } = deps;
  const now = deps.now ?? Date.now;
  let body;
  try { body = await req.json(); } catch { return response({ error: "bad_request" }, 400); }
  const { invoice_id, token, return_url } = body ?? {};
  if (typeof invoice_id !== "string" || !UUID.test(invoice_id) || typeof token !== "string" || !UUID.test(token)) {
    return response({ error: "bad_request" }, 400);
  }
  try {
    const { data: inv, error } = await db.from("bk_invoices")
      .select("*, bk_projects!inner(id, access_token, client_email, title, billing_provider, external_billing_url)")
      .eq("id", invoice_id).single();
    if (error) return response({ error: error.code === "PGRST116" ? "not_found" : "read_failed" }, error.code === "PGRST116" ? 404 : 503);
    if (!inv || inv.bk_projects?.access_token !== token) return response({ error: "not_found" }, 404);
    const p = inv.bk_projects;
    if (p.billing_provider === "honeybook") {
      // A mislabeled external link must never bypass the provider boundary.
      const url = typeof p.external_billing_url === "string" && /^https:\/\/([a-z0-9-]+\.)*(hbportal\.co|honeybook\.com)(\/|$)/i.test(p.external_billing_url)
        ? p.external_billing_url : null;
      return response({ error: "external_payment_required", url }, 409);
    }
    if (p.billing_provider !== "stripe") return response({ error: "billing_provider_required" }, 409);
    if (inv.status === "paid") return response({ error: "already_paid" }, 409);
    if (inv.status !== "sent") return response({ error: "not_payable" }, 409);

    // Preserve the deployed saved-card consent and automatic balance behavior.
    let balance: { cents: number; chargeOn: string } | null = null;
    if (inv.kind === "deposit") {
      const { data: b, error: be } = await db.from("bk_bookings")
        .select("starts_at, balance_cents, balance_status").eq("invoice_id", inv.id).maybeSingle();
      if (be) return response({ error: "read_failed" }, 503);
      if (b?.balance_cents && b.balance_status === "scheduled") {
        const chargeAt = new Date(new Date(b.starts_at).getTime() - 24 * 3600 * 1000);
        balance = {
          cents: b.balance_cents,
          chargeOn: chargeAt.getTime() < now() + 2 * 3600 * 1000
            ? "within the hour, since your shoot is less than a day away"
            : "on " + new Intl.DateTimeFormat("en-US", {
              timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric",
            }).format(chargeAt) + ", the day before your shoot",
        };
      }
    }
    const portalUrl = "https://book.taylormadecreative.net/portal.html?p=" + p.id + "&t=" + token;
    let success = portalUrl + "&paid=1", cancel = portalUrl;
    if (typeof return_url === "string" && return_url.length <= 600 && RETURN_PREFIXES.some(prefix => return_url.startsWith(prefix))) {
      const sep = return_url.includes("?") ? "&" : "?";
      success = return_url + sep + "paid=1"; cancel = return_url + sep + "cancelled=1";
    }
    const n = Array.isArray(inv.line_items) ? inv.line_items.length : 0;
    const title = ((n > 0 && (inv.line_items[0]?.title || inv.line_items[0]?.label)) || inv.title || "Studio invoice")
      + (n > 1 ? " (+" + (n - 1) + " add-on" + (n > 2 ? "s" : "") + ")" : "");
    const params: any = {
      mode: "payment", customer_email: p.client_email,
      line_items: [{ price_data: { currency: "usd", product_data: { name: title }, unit_amount: inv.amount_cents }, quantity: 1 }],
      metadata: { invoice_id: inv.id, project_id: p.id },
      success_url: success, cancel_url: cancel,
    };
    if (balance) {
      const amount = "$" + (balance.cents / 100).toLocaleString("en-US", { minimumFractionDigits: balance.cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
      params.customer_creation = "always";
      params.payment_method_types = ["card"];
      params.payment_intent_data = { setup_future_usage: "off_session", metadata: { invoice_id: inv.id, project_id: p.id } };
      params.custom_text = { submit: { message: "This is your deposit. By paying, you authorize Taylormade Creative to charge the remaining " + amount + " to this same card " + balance.chargeOn + "." } };
    }
    const { data: attempt, error: prepareError } = await db.rpc("bk_prepare_checkout", {
      p_invoice: inv.id, p_token: token, p_params: params,
    });
    if (prepareError || !attempt) return response({ error: "checkout_unavailable" }, 503);
    if (attempt.error) return response(attempt, attempt.error === "not_found" ? 404 : 409);
    if (attempt.stripe_session_id) {
      // A failed read is never permission to create another payable session.
      const existing = await stripe.checkout.sessions.retrieve(attempt.stripe_session_id);
      if (existing.payment_status === "paid") return response({ error: "already_paid" }, 409);
      if (existing.status === "complete") return response({ error: "payment_processing" }, 409);
      if (existing.status === "open" && existing.url) return response({ url: existing.url });
      return response({ error: "checkout_expired" }, 409);
    }
    if (attempt.legacy_session_id) {
      let existing;
      try { existing = await stripe.checkout.sessions.retrieve(attempt.legacy_session_id); }
      catch (e) { if ((e as { code?: string }).code !== "resource_missing") throw e; }
      if (existing?.payment_status === "paid") return response({ error: "already_paid" }, 409);
      if (existing?.status === "complete") return response({ error: "payment_processing" }, 409);
      if (existing?.status === "open") {
        try { await stripe.checkout.sessions.expire(existing.id); }
        catch (e) {
          // Another concurrent request may have expired the same legacy session.
          const latest = await stripe.checkout.sessions.retrieve(existing.id);
          if (latest.status !== "expired") throw e;
        }
      }
    }
    // The DB persists the canonical parameters, expiry and random attempt ID.
    // Concurrent requests and a crash after create replay the same Stripe object.
    const session = await stripe.checkout.sessions.create(attempt.params, { idempotencyKey: "bk-checkout-" + attempt.id });
    if (!session.id || !session.url) return response({ error: "checkout_unavailable" }, 503);
    const { data: saved, error: saveError } = await db.rpc("bk_finish_checkout", { p_attempt: attempt.id, p_session: session.id });
    if (saveError || saved !== true) return response({ error: "checkout_unavailable" }, 503);
    return response({ url: session.url });
  } catch (e) {
    console.error("Checkout request failed", (e as { code?: string }).code ?? "upstream_error");
    return response({ error: "checkout_unavailable" }, 503);
  }
}

// Called only after the entrypoint verifies Stripe's signature.
export async function reconcileEvent(event: { id: string; type: string; data: { object: any } }, db: PaymentDB): Promise<boolean> {
  const s = event.data.object;
  if (event.type === "checkout.session.completed" && s.payment_status !== "paid") return true;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const { data, error } = await db.rpc("bk_record_checkout_payment", { p_event_id: event.id, p_session: s });
    return !error && ["applied", "attention", "duplicate"].includes(data?.status);
  }
  if (event.type === "checkout.session.async_payment_failed" && s.metadata?.invoice_id) {
    const { error } = await db.from("bk_invoices").update({ payment_note: "Payment attempt failed (async method) — ask client to retry" })
      .eq("id", s.metadata.invoice_id).eq("stripe_session_id", s.id).eq("status", "sent");
    return !error;
  }
  return true;
}
