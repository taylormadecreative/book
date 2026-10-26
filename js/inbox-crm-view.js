/* Taylormade — Inbox CRM · pure view helpers (tested in tests/inbox-crm-view_test.js) */
import { esc, ago, whatLabel } from "./inbox-view.js";

const TZ = "America/Chicago";
export const STAGES = ["new", "quoted", "booked", "in_production", "delivered", "archived", "lost"];
export const STAGE_LABEL = { new: "New", quoted: "Quoted", booked: "Booked", in_production: "Production", delivered: "Delivered", archived: "Archived", lost: "Lost" };
const STAGE_TONE = { new: "", quoted: "st-quoted", booked: "st-gold", in_production: "st-gold", delivered: "st-green", archived: "st-dim", lost: "st-dim" };
// what each nelson_alert type means, in his words; tone drives the color on the timeline
export const ALERT = {
  inquiry: ["New inquiry", ""], payment: ["Payment came in", "good"], contract_signed: ["Contract signed", "good"],
  balance_failed: ["Balance payment failed", "bad"], balance_attention: ["Balance not charged", "bad"],
  payment_unreconciled: ["Paid but not booked", "bad"], payment_orphan: ["Paid but not booked", "bad"],
  payment_stuck: ["Started booking, didn't pay", "bad"],
};
export const FILTERS = [["needs", "Needs reply"], ["leads", "Leads"], ["booked", "Booked"], ["delivered", "Delivered"], ["unpaid", "Unpaid"], ["all", "All"]];
export const BOOKING_LABEL = { requested: "Requested", pending_payment: "Not paid yet", confirmed: "Confirmed", completed: "Done", cancelled: "Canceled" };
// a date only becomes "the shoot" once it's booked; before that it's the date they asked for
export const isBooked = (status) => ["booked", "in_production", "delivered"].includes(status);

// a reply that's only "Hi Name," and "— Nelson" (Blank, or a template he never filled in) must not go out
export function replyIsEmpty(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^(hi|hey|hello)\b.*,$/i.test(lines[0])) lines.shift();
  while (lines.length && /^[—-]+\s*nelson$/i.test(lines[lines.length - 1])) lines.pop();
  const body = lines.join(" ").trim();
  return !body || /^thanks for your message\.?$/i.test(body);
}

export function money(cents, short = false) {
  const d = (cents || 0) / 100;
  if (short && d >= 10000) return `$${(d / 1000).toFixed(d < 1e5 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `$${Math.round(d).toLocaleString("en-US")}`;
}
export function initials(name) {
  const parts = String(name || "").replace(/^(dr|mr|mrs|ms|mx|miss)\.?\s+/i, "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const a = parts[0][0], b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || "");
  return (a + b).toUpperCase();
}
export function firstName(name) {
  return (String(name || "").replace(/^(dr|mr|mrs|ms|mx|miss)\.?\s+/i, "").trim().split(/\s+/)[0]) || "client";
}
export function stageChip(status) {
  if (!status || !STAGE_LABEL[status]) return "";
  return `<span class="st ${STAGE_TONE[status]}">${STAGE_LABEL[status]}</span>`;
}

// invoiced = everything sent or paid (drafts and voids don't count); due = sent and not paid
export function invoiceTotals(invoices) {
  const live = (invoices || []).filter((i) => i.status === "sent" || i.status === "paid");
  const invoiced = live.reduce((n, i) => n + (i.amount_cents || 0), 0);
  const paid = live.filter((i) => i.status === "paid").reduce((n, i) => n + (i.amount_cents || 0), 0);
  return { invoiced, paid, due: invoiced - paid, count: live.length };
}

// the calendar day in Dallas, as "2026-10-26" (one formatter, reused: the list draws this per row)
const CT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function ctDay(d) { return CT_DAY.format(d); }
export function dayGroup(iso, now = new Date()) {
  const d = new Date(iso);
  const today = ctDay(now), day = ctDay(d);
  if (day === today) return "Today";
  if (day === ctDay(new Date(now.getTime() - 86400e3))) return "Yesterday";
  const diff = (Date.parse(today) - Date.parse(day)) / 86400e3;
  return diff < 7 ? "This week" : "Earlier";
}

export function stats(projects, needsCount, now = new Date()) {
  const ps = projects || [];
  const weekAgo = now.getTime() - 7 * 86400e3;
  const month = ctDay(now).slice(0, 7);
  const inv = ps.flatMap((p) => p.bk_invoices || []);
  return {
    waiting: needsCount,
    newLeads: ps.filter((p) => Date.parse(p.created_at) >= weekAgo && !["archived", "lost"].includes(p.status)).length,
    unpaid: inv.filter((i) => i.status === "sent").reduce((n, i) => n + (i.amount_cents || 0), 0),
    collected: inv.filter((i) => i.status === "paid" && i.paid_at && ctDay(new Date(i.paid_at)).slice(0, 7) === month)
      .reduce((n, i) => n + (i.amount_cents || 0), 0),
    monthName: new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long" }).format(now),
  };
}

// one conversation row: the RPC's latest activity merged with the project row (either may be missing)
export function mergeRow(act, proj, waiting) {
  const base = proj || act;
  const t = invoiceTotals(proj && proj.bk_invoices);
  return {
    id: base.id, client_name: base.client_name, title: base.title, service: base.service,
    company: proj ? proj.company : null, email: proj ? proj.client_email : null, phone: proj ? proj.client_phone : null,
    status: proj ? proj.status : null, created_at: proj ? proj.created_at : null,
    at: (act && act.last_at) || (proj && (proj.updated_at || proj.created_at)),
    last_kind: act ? act.last_kind : null, last_summary: act ? act.last_summary : null,
    waiting, due: t.due,
  };
}

export function matches(row, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [row.client_name, row.company, row.email, row.phone, row.title, whatLabel(row), STAGE_LABEL[row.status]].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function lastLine(row) {
  if (row.last_kind === "message") return `“${row.last_summary ?? ""}”`;
  if (row.last_kind === "alert") return (ALERT[row.last_summary] || ["Update"])[0];
  return row.status === "new" ? "New project" : STAGE_LABEL[row.status] || "";
}

export function rowHtml(row, { now = new Date(), sel = false } = {}) {
  const due = row.due > 0 ? ` · <span class="crow-due">${money(row.due)} unpaid</span>` : "";
  return `<a class="crow${row.waiting ? " is-waiting" : ""}${sel ? " is-sel" : ""}" href="?p=${esc(row.id)}" data-id="${esc(row.id)}"${sel ? ' aria-current="true"' : ""}>
    <span class="mono-av" aria-hidden="true">${esc(initials(row.client_name))}</span>
    <span class="crow-main">
      <span class="crow-top"><span class="crow-name">${esc(row.client_name)}</span><span class="crow-ago">${row.waiting ? '<span class="sr-only">Needs reply, </span>' : ""}${esc(ago(row.at, now))}</span></span>
      <span class="crow-mid"><span class="crow-what">${esc(whatLabel(row))}${row.company ? " · " + esc(row.company) : ""}${due}</span>${stageChip(row.status)}</span>
      <span class="crow-line">${esc(lastLine(row))}</span>
    </span>
  </a>`;
}

// everything that happened on a project, oldest first: the inquiry, messages both ways, money, alerts
export function timeline(item, extra) {
  const p = item.project;
  const ev = [{ kind: "brief", at: p.created_at }];
  const msgs = extra && extra.bk_messages ? extra.bk_messages : item.messages;
  msgs.forEach((m) => ev.push({ kind: "msg", at: m.created_at, sender: m.sender, body: m.body }));
  const invoices = extra && extra.bk_invoices;
  (item.alerts || []).forEach((a) => {
    if (a.type === "inquiry") return; // the brief already opens the thread
    if (a.type === "payment" && invoices) return; // the invoice rows say it with the amount
    const [label, tone] = ALERT[a.type] || ["Update", ""];
    ev.push({ kind: "event", at: a.created_at, label, tone });
  });
  (invoices || []).forEach((i) => {
    if (i.status === "draft" || i.status === "void") return;
    ev.push({ kind: "event", at: i.created_at, label: `Invoice sent · ${i.title} · ${money(i.amount_cents)}`, tone: "money" });
    if (i.status === "paid" && i.paid_at) ev.push({ kind: "event", at: i.paid_at, label: `Paid · ${money(i.amount_cents)}`, tone: "good" });
  });
  return ev.filter((e) => e.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === "brief" ? -1 : b.kind === "brief" ? 1 : 0));
}
