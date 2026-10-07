/* Taylormade — Inbox · Pitches: pure view helpers (tested in tests/inbox-pitches-view_test.js) */
import { esc, ago } from "./inbox-view.js";

export const LANE = { university: "University", company: "Company", nonprofit: "Nonprofit", small_business: "Small business", warm: "Warm" };
export const OFFER = { "content-day": "Content Day", "corporate-video": "Corporate video", "team-headshots": "Team headshots",
  "video-podcast": "Video podcast", "event-coverage": "Event coverage", "team-ai-workshops": "Team AI workshop", "academy-partner": "Academy partnership" };
export const STATUS = { rendering: "Re-rendering", ready: "To review", approved: "Approved", sending: "Sending", sent: "Sent", done: "Done",
  dm_ready: "DM ready", skipped: "Skipped", cancelled: "Stopped", held: "Held" };
export const SKIP_REASONS = [["wrong_fit", "Wrong fit"], ["bad_timing", "Bad timing"], ["know_them", "I know them"], ["other", "Other"]];
const SCORE = [["need", "Need"], ["money", "Money"], ["timing", "Timing"], ["reach", "Reach"], ["warmth", "Warmth"]];
const EVENT = { approved: "You approved it", unapproved: "You took the approval back", edited: "You edited it", edited_ready: "Re-rendered after your edit",
  skipped: "Skipped", dm_ready: "Page went live — ready to DM", dm_sent: "You sent the DM", sent: "First email sent", fu1_sent: "Follow-up 1 sent",
  fu2_sent: "Follow-up 2 sent", shadow_sent: "Preview sent to your inbox", reply: "They replied", auto_reply: "Auto-reply (follow-ups continue)",
  opt_out: "They said no thanks", bounce: "Email bounced", cancelled: "Stopped", held: "Held", error: "Problem" };

// must match ~/taylormade-creative/outreach/pitch/lib/hash.mjs
export const HASH_FIELDS = ["subject", "email_html", "fu1_html", "fu2_html", "dm_text"];
export function hashInput(p) { return HASH_FIELDS.map((k) => p[k] ?? "").join("\u0000"); }
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeHref(u) { return /^https:\/\/[^\s"'<>]+$/i.test(String(u ?? "")) ? String(u) : null; }
export function igHref(h) { return /^[A-Za-z0-9._]{1,30}$/.test(String(h ?? "")) ? `https://www.instagram.com/${h}/` : null; }
export function gmailHref(messageId) {
  const id = String(messageId ?? "").replace(/^<|>$/g, "");
  return id ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent("rfc822msgid:" + id)}` : null;
}
// which buttons a pitch shows, by status (Skip also while an edit re-renders; Stop only while follow-ups are still to come)
export function pitchActions(status, channel) {
  return {
    any: ["ready", "approved", "held", "dm_ready", "rendering", "sent"].includes(status),
    approve: status === "ready",
    unapprove: status === "approved",
    edit: ["ready", "approved", "held"].includes(status),
    skip: ["ready", "approved", "held", "dm_ready", "rendering"].includes(status),
    dm: status === "dm_ready",
    stop: status === "sent" && channel === "email",
  };
}
export function splitParas(text) { return String(text ?? "").split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean); }
export function joinParas(list) { return (list ?? []).join("\n\n"); }

export function pitchRowHtml(row) {
  const badge = row.status && row.status !== "ready" ? ` <span class="pt-badge pt-${esc(row.status)}">${esc(STATUS[row.status] ?? row.status)}</span>` : "";
  const dm = row.channel === "dm" ? ` <span class="pt-badge">DM</span>` : "";
  const line = row.status === "held" ? row.hold_reason : row.why;
  return `<a class="row pt-row" href="?pitch=${esc(row.id)}" data-pitch="${esc(row.id)}">
    <span class="dot-gap"></span>
    <span class="row-main">
      <span class="row-top"><span class="row-name">${esc(row.org)}</span><span class="row-ago">${esc(row.score_total ?? "?")}/15</span></span>
      <span class="row-what">${esc(LANE[row.lane] ?? row.lane)} · ${esc(OFFER[row.offer_id] ?? row.offer_id)}${dm}${badge}</span>
      <span class="row-line">${esc(line ?? "")}</span>
    </span>
  </a>`;
}
export function scoreHtml(score) {
  return `<ul class="pt-score">${SCORE.map(([k, label]) => {
    const s = (score ?? {})[k] ?? {};
    const href = safeHref(s.url);
    return `<li><b>${esc(label)} ${esc(s.n ?? 0)}/3</b> ${esc(s.why ?? "")}${href ? ` <a href="${esc(href)}" target="_blank" rel="noopener noreferrer">source</a>` : ""}</li>`;
  }).join("")}</ul>`;
}
export function timelineHtml(events, now = new Date()) {
  if (!events?.length) return "";
  return `<h2 class="pt-h">What's happened</h2><ol class="pt-timeline">${events.map((e) => {
    const g = e.kind === "reply" || e.kind === "opt_out" ? gmailHref(e.detail?.message_id) : null;
    const extra = e.detail?.reason ? ` — ${esc(e.detail.reason)}` : e.detail?.why ? ` — ${esc(e.detail.why)}` : "";
    return `<li><span>${esc(ago(e.at, now))}</span> ${esc(EVENT[e.kind] ?? e.kind)}${extra}${g ? ` · <a href="${esc(g)}" target="_blank" rel="noopener">Open in Gmail</a>` : ""}</li>`;
  }).join("")}</ol>`;
}
// preview only: links open a new tab instead of navigating the frame. The approval hash is over the stored email_html, never this.
export function previewDoc(html) {
  const h = String(html ?? ""), base = '<base target="_blank">';
  return /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, (m) => m + base) : base + h;
}
export function mailFrame(html, title) {
  return `<iframe class="pt-mail" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" loading="lazy" title="${esc(title)}" srcdoc="${esc(previewDoc(html))}"></iframe>`;
}
