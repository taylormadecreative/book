// bk-mailer — drains bk_email_queue: booking confirmations, shoot-prep and
// reminder emails, inquiry acknowledgments, and Nelson alerts. Sends via Resend
// from hello@taylormadecreative.net (domain already verified for the academy).
// Invoked by pg_cron every 10 minutes (pg_net) and ad hoc after checkout.
// Auth: x-mailer-secret header must match bk_config key 'mailer_secret'.
// Deployed to Supabase project pgqdmnmessbbzyszjfvr with verify_jwt=false.
// 2026-09-23: deposit + auto-balance — confirmation shows the deposit and when
// the balance is charged; new kinds balance_charged (receipt) and
// balance_failed (pay link), Nelson alert type balance_failed.
// 2026-09-27: every drain also mirrors confirmed bookings onto Nelson's Google
// Calendar (gcal.ts) and pulls cancelled ones back off.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { deliverMail, outgoingReplyTo, type MailRequest } from "../_shared/mail-delivery.ts";
import { syncCalendar } from "./gcal.ts";
import { replyBodyHtml, studioReplySubject } from "../_shared/inbox/reply_html.ts";

const FROM = "Taylormade Creative <hello@taylormadecreative.net>";
const NELSON = "taylormademd@gmail.com";
const PORTAL_BASE = "https://book.taylormadecreative.net";
const TZ = "America/Chicago";
const BATCH = 25;
const MAX_ATTEMPTS = 5;

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(iso));
}
function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit",
  }).format(new Date(iso)) + " CT";
}
function money(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
  });
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ------------------------------------------------------------------ template shell
// signed=false for Nelson's own Inbox replies, which already end "— Nelson"
function shell(heading: string, inner: string, signed = true): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f3ee;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#0a0a0c;padding:26px 32px;">
    <span style="font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:17px;letter-spacing:2px;color:#ffffff;">TAYLORMADE<span style="color:#e9b949;">/</span>CREATIVE</span>
  </td></tr>
  <tr><td style="height:4px;background:#e9b949;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:36px 32px 40px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1e;">
    ${inner}
  </td></tr>
  <tr><td style="background:#0a0a0c;padding:22px 32px;font-family:Arial,Helvetica,sans-serif;">
    <p style="margin:0;font-size:12px;line-height:1.7;color:#8a8a92;">Taylormade Creative · Dallas–Fort Worth<br>
    Photo · Video · AI Content · Web · Social · Workshops<br>
    Reply to this email any time — it comes straight to me.${signed ? " — Nelson" : ""}</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function h1(t: string): string {
  return `<h1 style="margin:0 0 14px;font-size:26px;line-height:1.25;color:#0a0a0c;">${t}</h1>`;
}
function p(t: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3a3a40;">${t}</p>`;
}
function btn(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr>
    <td style="background:#0a0a0c;border-radius:10px;">
      <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:.5px;color:#e9b949;text-decoration:none;">${label}</a>
    </td></tr></table>`;
}
function detailCard(rows: Array<[string, string]>): string {
  const trs = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:7px 0;font-size:12px;letter-spacing:1px;color:#8a8a92;text-transform:uppercase;vertical-align:top;width:110px;">${k}</td>
     <td style="padding:7px 0;font-size:15px;color:#0a0a0c;font-weight:bold;">${v}</td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f2;border-left:4px solid #e9b949;border-radius:8px;margin:6px 0 20px;"><tr><td style="padding:16px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${trs}</table>
  </td></tr></table>`;
}

// ------------------------------------------------------------------ context types
type Ctx = {
  kind: string;
  payload: Record<string, unknown>;
  project: {
    id: string; access_token: string; client_name: string; client_email: string;
    title: string | null; event_date: string | null; event_time: string | null;
    location: string | null; service: string;
  } | null;
  booking: {
    id: string; starts_at: string; duration_min: number; status: string;
    location: string | null;
    balance_cents: number | null; balance_status: string | null;
    bk_services: { name: string; prep_notes: string | null } | null;
  } | null;
};

// the balance is charged 24h before the shoot — say which day
function balanceDay(startsAt: string): string {
  const at = new Date(startsAt).getTime() - 24 * 3600 * 1000;
  if (at < Date.now() + 2 * 3600 * 1000) return "within the hour (your shoot is less than a day away)";
  return "on " + new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" })
    .format(new Date(at));
}

function portalUrl(ctx: Ctx): string {
  return `${PORTAL_BASE}/portal.html?p=${ctx.project!.id}&t=${ctx.project!.access_token}`;
}
function firstName(ctx: Ctx): string {
  return esc((ctx.project?.client_name ?? "there").split(/\s+/)[0]);
}

// ------------------------------------------------------------------ renderers
function renderConfirmation(ctx: Ctx, amountCents: number | null): { subject: string; html: string } {
  const b = ctx.booking!;
  const svc = b.bk_services?.name ?? "Your session";
  const subject = `You're booked — ${svc}, ${fmtDate(b.starts_at)}`;
  const html = shell(subject,
    h1(`You're booked, ${firstName(ctx)}.`) +
    p(`Your ${esc(svc.toLowerCase())} with Taylormade Creative is locked in. Here are the details:`) +
    detailCard([
      ["Session", esc(svc)],
      ["Date", fmtDate(b.starts_at)],
      ["Time", fmtTime(b.starts_at)],
      ["Length", `${b.duration_min} minutes`],
      ["Location", b.location ? esc(b.location) : "We'll confirm the exact spot with you before the shoot"],
      ...(amountCents ? [[b.balance_cents ? "Deposit paid" : "Paid", money(amountCents)] as [string, string]] : []),
      ...(b.balance_cents && b.balance_status === "scheduled"
        ? [["Balance", `${money(b.balance_cents)} — charged to the same card ${balanceDay(b.starts_at)}`] as [string, string]]
        : []),
    ]) +
    p(`<b>What happens next:</b> a few days before your shoot you'll get a prep email with exactly how to show up ready, and a reminder the day before.${
      ctx.project?.service === "photography"
        ? " After the shoot, your proofs land in your private portal — you pick exactly which shots you want edited, and the finals come back the same way."
        : " Questions in the meantime? Your client portal has everything — messages, receipts, and your delivery when it's ready."
    }`) +
    btn(portalUrl(ctx), "OPEN YOUR CLIENT PORTAL"),
  );
  return { subject, html };
}

function renderPrep(ctx: Ctx): { subject: string; html: string } {
  const b = ctx.booking!;
  const svc = b.bk_services?.name ?? "Your session";
  const notes = b.bk_services?.prep_notes ??
    "Get a good night's rest, arrive 10 minutes early, and bring anything you want featured in the shoot. We'll handle the rest.";
  const subject = `Get ready — your ${svc.toLowerCase()} is ${fmtDate(b.starts_at)}`;
  const html = shell(subject,
    h1(`Your shoot is coming up, ${firstName(ctx)}.`) +
    p(`${esc(svc)} · <b>${fmtDate(b.starts_at)} at ${fmtTime(b.starts_at)}</b>${b.location ? " · " + esc(b.location) : ""}`) +
    p(`<b>How to come prepared:</b>`) +
    detailCard([["Prep", `<span style="font-weight:normal;line-height:1.7;">${esc(notes).replace(/\n/g, "<br>")}</span>`]]) +
    p(`If anything changed — timing, looks, creative direction — hit reply or drop a message in your portal and we'll adjust.`) +
    btn(portalUrl(ctx), "MESSAGE ME IN THE PORTAL"),
  );
  return { subject, html };
}

function renderReminder(ctx: Ctx): { subject: string; html: string } {
  const b = ctx.booking!;
  const svc = b.bk_services?.name ?? "Your session";
  const subject = `Tomorrow at ${fmtTime(b.starts_at)} — ${svc}`;
  const html = shell(subject,
    h1(`See you tomorrow, ${firstName(ctx)}.`) +
    detailCard([
      ["Session", esc(svc)],
      ["Time", fmtTime(b.starts_at)],
      ["Location", b.location ? esc(b.location) : "Check your portal for the location"],
    ]) +
    p(`Arrive about 10 minutes early so we can use every minute of your session. If something urgent comes up, reply to this email.`) +
    btn(portalUrl(ctx), "OPEN YOUR CLIENT PORTAL"),
  );
  return { subject, html };
}

function renderInquiryAck(ctx: Ctx): { subject: string; html: string } {
  const pj = ctx.project!;
  const subject = `Got your inquiry — Taylormade Creative`;
  const html = shell(subject,
    h1(`Got it, ${firstName(ctx)}.`) +
    p(`Your project inquiry just landed in my pipeline and I'll personally get back to you within one business day with next steps and a custom quote.`) +
    detailCard([
      ["Project", esc(pj.title ?? "New project")],
      ...(pj.event_date ? [["Preferred date", `${pj.event_date}${pj.event_time ? " · " + esc(pj.event_time) : ""}`] as [string, string]] : []),
    ]) +
    p(`Everything about your project — messages, quotes, invoices, and final delivery — lives in your private client portal. Bookmark it:`) +
    btn(portalUrl(ctx), "OPEN YOUR CLIENT PORTAL"),
  );
  return { subject, html };
}

function renderBalanceCharged(ctx: Ctx, amountCents: number): { subject: string; html: string } {
  const b = ctx.booking!;
  const svc = b.bk_services?.name ?? "your session";
  const subject = `Balance paid — see you ${fmtDate(b.starts_at).split(",")[0]} · Taylormade Creative`;
  const html = shell(subject,
    h1(`You're all paid up, ${firstName(ctx)}.`) +
    p(`The remaining balance for your ${esc(svc.toLowerCase())} was charged to the card you booked with, as planned. Nothing else is owed.`) +
    detailCard([
      ["Charged", money(amountCents)],
      ["Session", esc(svc)],
      ["Date", fmtDate(b.starts_at)],
      ["Time", fmtTime(b.starts_at)],
    ]) +
    p(`Your receipt is in your client portal any time you need it.`) +
    btn(portalUrl(ctx), "OPEN YOUR CLIENT PORTAL"),
  );
  return { subject, html };
}

function renderBalanceFailed(ctx: Ctx, amountCents: number): { subject: string; html: string } {
  const b = ctx.booking!;
  const svc = b.bk_services?.name ?? "your session";
  const subject = `Action needed: your balance of ${money(amountCents)} · Taylormade Creative`;
  const html = shell(subject,
    h1(`Quick fix before your shoot, ${firstName(ctx)}.`) +
    p(`I tried to charge the remaining balance for your ${esc(svc.toLowerCase())} to the card you booked with, but it didn't go through. Your session is still on. Just pay the balance in your portal before the shoot. It takes a minute and you can use any card.`) +
    detailCard([
      ["Balance due", money(amountCents)],
      ["Session", esc(svc)],
      ["Date", fmtDate(b.starts_at)],
      ["Time", fmtTime(b.starts_at)],
    ]) +
    btn(portalUrl(ctx), "PAY THE BALANCE IN YOUR PORTAL") +
    p(`<span style="font-size:13px;color:#8a8a92;">Questions? Just reply to this email.</span>`),
  );
  return { subject, html };
}

function renderInvoiceSent(
  ctx: Ctx,
  inv: { title: string; amount_cents: number; due_date: string | null } | null,
): { subject: string; html: string } {
  const amt = inv ? money(inv.amount_cents) : "";
  const subject = `Your quote is ready${amt ? " — " + amt : ""} · Taylormade Creative`;
  const html = shell(subject,
    h1(`Your quote is ready, ${firstName(ctx)}.`) +
    p(`I put together the numbers for <b>${esc(ctx.project?.title ?? "your project")}</b>. Everything is itemized in your private portal, and you can pay securely by card right there — no accounts, no apps.`) +
    detailCard([
      ["Invoice", esc(inv?.title ?? "Invoice")],
      ["Amount", amt],
      ...(inv?.due_date ? [["Due", inv.due_date] as [string, string]] : []),
    ]) +
    p(`If anything about the scope or numbers needs adjusting, just reply to this email — we'll get it right before you pay a cent.`) +
    btn(portalUrl(ctx), "REVIEW & PAY IN YOUR PORTAL"),
  );
  return { subject, html };
}

function renderContractSent(ctx: Ctx, title: string): { subject: string; html: string } {
  const subject = `Your contract is ready to sign · Taylormade Creative`;
  const html = shell(subject,
    h1(`One signature and we're official, ${firstName(ctx)}.`) +
    p(`The agreement for <b>${esc(ctx.project?.title ?? "your project")}</b> is ready in your private portal. Read it over, type your name to sign, and you're set — takes about a minute.`) +
    detailCard([["Document", esc(title || "Service Agreement")]]) +
    p(`Questions about anything in it? Reply to this email before you sign and we'll sort it out.`) +
    btn(portalUrl(ctx), "REVIEW & SIGN IN YOUR PORTAL"),
  );
  return { subject, html };
}

function renderNewMessage(ctx: Ctx): { subject: string; html: string } {
  const snippet = String(ctx.payload?.snippet ?? "");
  const subject = `New message from Taylormade Creative`;
  const html = shell(subject,
    h1(`You've got a message, ${firstName(ctx)}.`) +
    detailCard([["Nelson", `<span style="font-weight:normal;line-height:1.7;">${esc(snippet)}${snippet.length >= 200 ? "…" : ""}</span>`]]) +
    p(`Reply in your portal and it comes straight to me.`) +
    btn(portalUrl(ctx), "READ & REPLY IN YOUR PORTAL"),
  );
  return { subject, html };
}

// Nelson's reply from the Inbox app — the whole text, not a teaser
function renderStudioReply(ctx: Ctx, body: string): { subject: string; html: string } {
  const subject = studioReplySubject(ctx.project?.title ?? null, ctx.project?.service ?? "other");
  const html = shell(subject,
    `<div style="font-size:16px;line-height:1.7;color:#1a1a1e;margin:0 0 24px;">${replyBodyHtml(body)}</div>` +
    p(`Just reply to this email, or keep the conversation in your portal.`) +
    btn(portalUrl(ctx), "OPEN YOUR CLIENT PORTAL"),
  false);
  return { subject, html };
}

function renderNelsonAlert(ctx: Ctx): { subject: string; html: string } {
  const pl = ctx.payload ?? {};
  const pj = ctx.project;
  const type = String(pl.type ?? "event");
  const who = pj ? `${pj.client_name} <${pj.client_email}>` : "unknown";
  let subject: string; let lead: string;
  if (type === "payment") {
    const amt = typeof pl.amount_cents === "number" ? money(pl.amount_cents) : "";
    subject = `💰 Payment received${amt ? " — " + amt : ""} · ${pj?.title ?? ""}`;
    lead = `<b>${amt || "A payment"}</b> just cleared for <b>${esc(pj?.title ?? "a project")}</b> (${esc(who)}). ${String(pl.invoice_title ? "Invoice: " + esc(String(pl.invoice_title)) + "." : "")}`;
  } else if (type === "inquiry") {
    subject = `📥 New inquiry · ${pj?.title ?? "website"}`;
    lead = `New project inquiry from <b>${esc(who)}</b> — service: ${esc(String(pl.service ?? "n/a"))}. Reply within one business day (the client was told to expect that).`;
  } else if (type === "contract_signed") {
    subject = `✍️ Contract signed · ${pj?.title ?? ""}`;
    lead = `<b>${esc(String(pl.signer ?? "The client"))}</b> just signed <b>${esc(String(pl.title ?? "the agreement"))}</b> for ${esc(pj?.title ?? "a project")}. Name, timestamp, and device details are on record.`;
  } else if (type === "payment_unreconciled") {
    // raised by bk-stripe-webhook when money arrives that it cannot attach to a booking
    const amt = typeof pl.amount_cents === "number" ? money(pl.amount_cents) : "a payment";
    subject = `🚨 MONEY TAKEN, NOT BOOKED — ${amt}`;
    lead = `<b>${esc(String(pl.subject ?? "A payment could not be reconciled"))}.</b><br><br>` +
      `${esc(String(pl.detail ?? ""))}<br><br>` +
      `Stripe session: <code>${esc(String(pl.session_id ?? "n/a"))}</code><br>` +
      `Payment intent: <code>${esc(String(pl.payment_intent ?? "n/a"))}</code><br>` +
      `Invoice id: <code>${esc(String(pl.invoice_id ?? "none"))}</code><br>` +
      `Client email: ${esc(String(pl.customer_email ?? "unknown"))}<br><br>` +
      `<b>The client has paid and is expecting a confirmation.</b> Reconcile this by hand in the admin dashboard, then email them.`;
  } else if (type === "payment_stuck") {
    // raised by the bk_alert_stuck_payments sweep — a hold expired without ever being paid
    subject = `⚠️ Booking hold expired unpaid — ${String(pl.client_name ?? "a client")}`;
    lead = `A booking for <b>${esc(String(pl.service_name ?? "a session"))}</b> on <b>${esc(String(pl.starts_at_ct ?? "an upcoming date"))}</b> ` +
      `was held for <b>${esc(String(pl.client_name ?? "a client"))}</b> (${esc(String(pl.client_email ?? "no email"))}) and its 30-minute payment hold has now expired, ` +
      `so the calendar slot has been released.<br><br>` +
      `Usually this just means someone opened checkout and walked away — no action needed. ` +
      `<b>But if Stripe shows a payment from them, the webhook did not land and you must reconcile it by hand before that slot gets resold.</b><br><br>` +
      `Invoice id: <code>${esc(String(pl.invoice_id ?? "n/a"))}</code>`;
  } else if (type === "payment_orphan") {
    // the worse half of the sweep: money is in, no shoot on the calendar
    subject = `🚨 PAID BUT NOT BOOKED — ${String(pl.client_name ?? "a client")}`;
    lead = `<b>${esc(String(pl.client_name ?? "A client"))}</b> (${esc(String(pl.client_email ?? "no email"))}) has <b>paid</b> for ` +
      `<b>${esc(String(pl.service_name ?? "a session"))}</b> on <b>${esc(String(pl.starts_at_ct ?? "an upcoming date"))}</b>, ` +
      `but the booking never moved out of <code>pending_payment</code> and its hold has expired — so the slot is loose and may get resold.<br><br>` +
      `<b>Fix this one first.</b> Confirm the booking in the admin dashboard, then email them the confirmation and the studio address.<br><br>` +
      `Invoice id: <code>${esc(String(pl.invoice_id ?? "n/a"))}</code> (status: ${esc(String(pl.invoice_status ?? "unknown"))})`;
  } else if (type === "balance_failed") {
    const amt = typeof pl.amount_cents === "number" ? money(pl.amount_cents) : "The balance";
    subject = `⚠️ Balance auto-charge failed — ${amt} · ${pj?.client_name ?? ""}`;
    lead = `The automatic balance charge for <b>${esc(String(pl.service_name ?? "a session"))}</b> on <b>${esc(String(pl.starts_at_ct ?? "an upcoming date"))}</b> ` +
      `(${esc(who)}) did not go through: <i>${esc(String(pl.reason ?? "unknown"))}</i>.<br><br>` +
      `The client was emailed a link to pay <b>${amt}</b> in their portal, and the invoice is open there now. ` +
      `If it isn't paid by shoot time, collect it in person.`;
  } else if (type === "balance_attention") {
    const amt = typeof pl.amount_cents === "number" ? money(pl.amount_cents) : "The balance";
    subject = `⚠️ Balance not auto-charged — ${amt} · ${pj?.client_name ?? ""}`;
    lead = `The balance for <b>${esc(String(pl.service_name ?? "a session"))}</b> on <b>${esc(String(pl.starts_at_ct ?? "an upcoming date"))}</b> ` +
      `(${esc(who)}) was <b>not</b> charged automatically: <i>${esc(String(pl.reason ?? "unknown"))}</i>.<br><br>` +
      `The client was <b>not</b> emailed about it. Collect <b>${amt}</b> yourself: add a Balance invoice in the admin dashboard (it emails them a pay link), or take it at the shoot.`;
  } else if (type === "test") {
    subject = `✅ Booking email automation is live`;
    lead = `This is the end-to-end test of the new bk-mailer pipeline on taylormadecreative.net. Queue → Resend → inbox all working.`;
  } else {
    subject = `Taylormade booking event`;
    lead = esc(JSON.stringify(pl));
  }
  const html = shell(subject,
    // subject interpolates client-supplied names — escape before it becomes markup
    h1(esc(subject.replace(/^[^\w]*\s/, ""))) + p(lead) +
    btn(`${PORTAL_BASE}/admin.html`, "OPEN ADMIN DASHBOARD"),
  );
  return { subject, html };
}

// ------------------------------------------------------------------ send
// ------------------------------------------------------------------ entry
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = sb();

  const { data: cfg } = await db.from("bk_config").select("value").eq("key", "mailer_secret").maybeSingle();
  const secret = cfg?.value as string | undefined;
  if (!secret || req.headers.get("x-mailer-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const { data: due, error: qErr } = await db
    .from("bk_email_queue")
    .select("id, kind, payload, project_id, booking_id, attempts")
    .is("sent_at", null)
    .lte("send_at", new Date().toISOString())
    .lt("attempts", MAX_ATTEMPTS)
    .eq("delivery_legacy_review", false)
    .order("send_at", { ascending: true })
    .limit(BATCH);
  if (qErr) return json({ error: "queue_read_failed", detail: qErr.message }, 500);

  let sent = 0, failed = 0, skipped = 0;
  for (const row of due ?? []) {
    try {
      // hydrate context
      let project: Ctx["project"] = null;
      let booking: Ctx["booking"] = null;
      let amountCents: number | null = null;
      if (row.project_id) {
        const { data } = await db.from("bk_projects")
          .select("id, access_token, client_name, client_email, title, event_date, event_time, location, service")
          .eq("id", row.project_id).maybeSingle();
        project = data as Ctx["project"];
      }
      if (row.booking_id) {
        const { data } = await db.from("bk_bookings")
          .select("id, starts_at, duration_min, status, location, invoice_id, balance_cents, balance_status, bk_services(name, prep_notes)")
          .eq("id", row.booking_id).maybeSingle();
        booking = data as unknown as Ctx["booking"];
        const invId = (data as { invoice_id?: string } | null)?.invoice_id;
        if (invId && row.kind === "confirmation") {
          const { data: inv } = await db.from("bk_invoices").select("amount_cents, paid_amount_cents, status, payment_note").eq("id", invId).maybeSingle();
          if (inv?.status === "paid") {
            amountCents = inv.paid_amount_cents ?? inv.amount_cents;
            // promo-discounted checkouts recorded by the legacy webhook
            // record the true charge in payment_note — the "Paid" figure must
            // match the buyer's card statement, not the invoice face value
            const collected = /\(collected \$([0-9,]+\.[0-9]{2})\)/.exec(inv.payment_note ?? "");
            if (inv.paid_amount_cents == null && collected) amountCents = Math.round(parseFloat(collected[1].replace(/,/g, "")) * 100);
          }
        }
      }
      const ctx: Ctx = { kind: row.kind, payload: row.payload ?? {}, project, booking };

      // guards
      const clientKinds = ["confirmation", "prep", "reminder", "inquiry_ack", "balance_charged", "balance_failed"];
      if (clientKinds.includes(row.kind) && !project) throw new Error("missing project");
      if (["confirmation", "prep", "reminder", "balance_charged", "balance_failed"].includes(row.kind)) {
        if (!booking) throw new Error("missing booking");
        if (booking.status !== "confirmed" && booking.status !== "completed") {
          await db.from("bk_email_queue").update({
            sent_at: new Date().toISOString(),
            last_error: `skipped: booking status ${booking.status}`,
          }).eq("id", row.id);
          skipped++; continue;
        }
      }

      let rendered: { subject: string; html: string };
      let to: string;
      switch (row.kind) {
        case "confirmation": rendered = renderConfirmation(ctx, amountCents); to = project!.client_email; break;
        case "prep": rendered = renderPrep(ctx); to = project!.client_email; break;
        case "reminder": rendered = renderReminder(ctx); to = project!.client_email; break;
        case "inquiry_ack": rendered = renderInquiryAck(ctx); to = project!.client_email; break;
        case "invoice_sent": {
          if (!project) throw new Error("missing project");
          const invId = String((row.payload as Record<string, unknown>)?.invoice_id ?? "");
          const { data: qInv } = await db.from("bk_invoices")
            .select("title, amount_cents, due_date, status")
            .eq("id", invId).maybeSingle();
          if (!qInv || qInv.status !== "sent") {
            // paid or voided before the email went out — nothing to ask for
            await db.from("bk_email_queue").update({
              sent_at: new Date().toISOString(),
              last_error: `skipped: invoice ${qInv?.status ?? "missing"}`,
            }).eq("id", row.id);
            skipped++; continue;
          }
          rendered = renderInvoiceSent(ctx, qInv); to = project.client_email; break;
        }
        case "new_message": {
          if (!project) throw new Error("missing project");
          rendered = renderNewMessage(ctx); to = project.client_email; break;
        }
        case "studio_reply": {
          if (!project) throw new Error("missing project");
          const msgId = String((row.payload as Record<string, unknown>)?.message_id ?? "");
          const { data: msg } = await db.from("bk_messages").select("body").eq("id", msgId).maybeSingle();
          if (!msg) throw new Error("missing message");
          rendered = renderStudioReply(ctx, msg.body); to = project.client_email; break;
        }
        case "contract_sent": {
          if (!project) throw new Error("missing project");
          const cId = String((row.payload as Record<string, unknown>)?.contract_id ?? "");
          const { data: c } = await db.from("bk_contracts").select("status, title").eq("id", cId).maybeSingle();
          if (!c || c.status !== "sent") {
            await db.from("bk_email_queue").update({
              sent_at: new Date().toISOString(),
              last_error: `skipped: contract ${c?.status ?? "missing"}`,
            }).eq("id", row.id);
            skipped++; continue;
          }
          rendered = renderContractSent(ctx, c.title); to = project.client_email; break;
        }
        case "balance_charged":
        case "balance_failed": {
          const amt = Number((row.payload as Record<string, unknown>)?.amount_cents ?? 0);
          const invId = String((row.payload as Record<string, unknown>)?.invoice_id ?? "");
          const { data: bInv } = await db.from("bk_invoices").select("status").eq("id", invId).maybeSingle();
          // a "please pay" email for a balance that got paid in the meantime helps nobody
          if (row.kind === "balance_failed" && bInv?.status !== "sent") {
            await db.from("bk_email_queue").update({
              sent_at: new Date().toISOString(),
              last_error: `skipped: balance invoice ${bInv?.status ?? "missing"}`,
            }).eq("id", row.id);
            skipped++; continue;
          }
          rendered = row.kind === "balance_charged" ? renderBalanceCharged(ctx, amt) : renderBalanceFailed(ctx, amt);
          to = project!.client_email; break;
        }
        case "nelson_alert": rendered = renderNelsonAlert(ctx); to = NELSON; break;
        default: throw new Error(`unknown kind ${row.kind}`);
      }

      const replyTo=await outgoingReplyTo({fallback:NELSON,projectId:row.project_id,kind:row.kind,
        enabled:Deno.env.get("CRM_INBOUND_REPLY_TO_ENABLED"),domain:Deno.env.get("CRM_INBOUND_DOMAIN")},
        (projectId,domain)=>db.rpc("bk_crm_email_reply_route",{p_project:projectId,p_domain:domain}));
      const draft:MailRequest={from:FROM,to:[to],reply_to:replyTo,subject:rendered.subject,html:rendered.html};
      const canonical=await db.rpc("bk_crm_mail_request",{p_queue:row.id,p_request:draft});
      if(canonical.error || !canonical.data) throw new Error(canonical.error?.message || "Could not prepare email delivery");
      const err = await deliverMail(canonical.data as MailRequest, row.id, Deno.env.get("RESEND_API_KEY"));
      if (err) {
        failed++;
        await db.from("bk_email_queue").update({
          attempts: (row.attempts ?? 0) + 1, last_error: err,
        }).eq("id", row.id);
      } else {
        sent++;
        await db.from("bk_email_queue").update({
          sent_at: new Date().toISOString(), last_error: null,
          attempts: (row.attempts ?? 0) + 1,
        }).eq("id", row.id);
      }
    } catch (e) {
      failed++;
      await db.from("bk_email_queue").update({
        attempts: (row.attempts ?? 0) + 1,
        last_error: String((e as Error).message ?? e).slice(0, 300),
      }).eq("id", row.id);
    }
  }

  let calendar: unknown = null;
  try {
    calendar = await syncCalendar(db);
  } catch (e) {
    calendar = { error: String((e as Error).message ?? e).slice(0, 300) };
  }
  if (calendar && typeof calendar === "object" && ("error" in calendar || ((calendar as { errors?: string[] }).errors ?? []).length)) {
    console.error("gcal sync", JSON.stringify(calendar));
  }

  return json({ processed: (due ?? []).length, sent, failed, skipped, calendar });
});
