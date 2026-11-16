// Token-authorized Stripe Checkout. Deploy with verify_jwt=false.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { checkout, response } from "../_shared/payment-core.ts";
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({});
  if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return response({ error: "payments_not_configured" }, 503);
  return await checkout(req, {
    db: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }),
    stripe: new Stripe(key),
  });
});
