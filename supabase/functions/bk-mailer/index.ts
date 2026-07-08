// bk-mailer — drains bk_email_queue: booking confirmations, shoot-prep and
// reminder emails, inquiry acknowledgments, and Nelson alerts. Sends via Resend
// from hello@taylormadecreative.net (domain already verified for the academy).
// Invoked by pg_cron every 10 minutes (pg_net) and ad hoc after checkout.
// Auth: x-mailer-secret header must match bk_config key 'mailer_secret'.
// Deployed to Supabase project pgqdmnmessbbzyszjfvr with verify_jwt=false.
import { createClient } from "npm:@supabase/supabase-js@2";

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
function shell(heading: string, inner: string): string {
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
    Reply to this email any time — it comes straight to me. — Nelson</p>
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
    bk_services: { name: string; prep_notes: string | null } | null;
  } | null;
};

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
      ...(amountCents ? [["Paid", money(amountCents)] as [string, string]] : []),
    ]) +
    p(`<b>What happens next:</b> a few days before your shoot you'll get a prep email with exactly how to show up ready, and a reminder the day before. Questions in the meantime? Your client portal has everything — messages, receipts, and your delivery when it's ready.`) +
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
    detailCard([["Prep", `<span style="font-weight:normal;line-height:1.7;">${esc(notes)}</span>`]]) +
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
  } else if (type === "test") {
    subject = `✅ Booking email automation is live`;
    lead = `This is the end-to-end test of the new bk-mailer pipeline on taylormadecreative.net. Queue → Resend → inbox all working.`;
  } else {
    subject = `Taylormade booking event`;
    lead = esc(JSON.stringify(pl));
  }
  const html = shell(subject,
    h1(subject.replace(/^[^\w]*\s/, "")) + p(lead) +
    btn(`${PORTAL_BASE}/admin.html`, "OPEN ADMIN DASHBOARD"),
  );
  return { subject, html };
}

// ------------------------------------------------------------------ send
async function sendResend(to: string, subject: string, html: string): Promise<string | null> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return "RESEND_API_KEY not set";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: NELSON, subject, html }),
  });
  if (!r.ok) return `resend ${r.status}: ${(await r.text()).slice(0, 300)}`;
  return null;
}

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
          .select("id, starts_at, duration_min, status, location, invoice_id, bk_services(name, prep_notes)")
          .eq("id", row.booking_id).maybeSingle();
        booking = data as unknown as Ctx["booking"];
        const invId = (data as { invoice_id?: string } | null)?.invoice_id;
        if (invId && row.kind === "confirmation") {
          const { data: inv } = await db.from("bk_invoices").select("amount_cents, status").eq("id", invId).maybeSingle();
          if (inv?.status === "paid") amountCents = inv.amount_cents;
        }
      }
      const ctx: Ctx = { kind: row.kind, payload: row.payload ?? {}, project, booking };

      // guards
      const clientKinds = ["confirmation", "prep", "reminder", "inquiry_ack"];
      if (clientKinds.includes(row.kind) && !project) throw new Error("missing project");
      if (["confirmation", "prep", "reminder"].includes(row.kind)) {
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
        case "nelson_alert": rendered = renderNelsonAlert(ctx); to = NELSON; break;
        default: throw new Error(`unknown kind ${row.kind}`);
      }

      const err = await sendResend(to, rendered.subject, rendered.html);
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

  return json({ processed: (due ?? []).length, sent, failed, skipped });
});
