/* Taylormade — Inbox · pure view helpers (tested in tests/inbox-view_test.js) */
const TZ = "America/Chicago";
const SERVICE = { music_video: "Music Video", brand_content: "Brand Content", photography: "Photography", event: "Event", other: "Project" };
const ALERT = {
  inquiry: "New inquiry", payment: "Paid", contract_signed: "Contract signed", balance_failed: "Balance failed",
  balance_attention: "Balance not charged", payment_unreconciled: "Paid but not booked", payment_orphan: "Paid but not booked",
  payment_stuck: "Hold expired",
};

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function ago(iso, now = new Date()) {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
export function fmtWhen(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(d);
  const t = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} · ${t}`;
}
function dial(phone) {
  const d = String(phone ?? "").replace(/[^\d+]/g, "");
  return d.replace(/\D/g, "").length >= 7 ? d : null;
}
export function telHref(phone) { const d = dial(phone); return d ? `tel:${d}` : null; }
export function smsHref(phone, body) { const d = dial(phone); return d ? `sms:${d}&body=${encodeURIComponent(body ?? "")}` : null; }
export function pushSupport({ sw, push, notif, standalone, ios }) {
  if (ios && !standalone) return "install"; // iOS only delivers web push to a home-screen install
  if (sw && push && notif) return "ok";
  return "unsupported";
}
export function newKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
}
export function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export function whatLabel(row) {
  const t = row.title && row.title.includes(" — ") ? row.title.split(" — ").slice(1).join(" — ") : "";
  return t || SERVICE[row.service] || "Project";
}
export function listRowHtml(row, now = new Date()) {
  const unread = !row.inbox_handled_at;
  const line = row.last_kind === "message" ? `“${row.last_summary ?? ""}”` : (ALERT[row.last_summary] ?? "Update");
  return `<a class="row${unread ? " unread" : ""}" href="?p=${esc(row.id)}" data-id="${esc(row.id)}">
    ${unread ? '<span class="dot" aria-label="Needs reply"></span>' : '<span class="dot-gap"></span>'}
    <span class="row-main">
      <span class="row-top"><span class="row-name">${esc(row.client_name)}</span><span class="row-ago">${esc(ago(row.last_at, now))}</span></span>
      <span class="row-what">${esc(whatLabel(row))}</span>
      <span class="row-line">${esc(line)}</span>
    </span>
  </a>`;
}
