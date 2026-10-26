/* Taylormade — Studio · Content calendar · pure view helpers (tested in tests/content-view_test.js) */

const TZ = "America/Chicago";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const LANES = { apps: "Apps", photo: "Photo sessions", direction: "Creative direction", other: "Other" };
export const FORMATS = { talking_head: "Talking head", bts_reel: "BTS reel", carousel: "Carousel", still: "Still" };
export const STATUSES = ["planned", "filmed", "edited", "posted"];
export const STATUS_LABEL = { planned: "Planned", filmed: "Filmed", edited: "Edited", posted: "Posted" };
const STATUS_TONE = { planned: "", filmed: "st-quoted", edited: "st-gold", posted: "st-green" };
export const PLATFORMS = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["linkedin", "LinkedIn"], ["threads", "Threads"]];
export const CAPTION_LIMIT = { instagram: 2200, tiktok: 4000, linkedin: 3000, threads: 500 };
// the pills are All + the lanes; the status filters live on the stats (To film, To post, Posted)
export const FILTERS = [["all", "All"], ["apps", "Apps"], ["photo", "Photo"], ["direction", "Direction"]];

// "2026-10-27" for right now in Dallas, whatever the device clock's zone is
export function todayISO(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// dates are calendar days, so do the math at noon UTC where no zone or DST can tip them over
const at = (iso) => new Date(`${iso}T12:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const dayBefore = (s) => addDays(s, -1);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function fmtDate(s) {
  const d = at(s);
  return { dow: DOW[d.getUTCDay()], day: String(d.getUTCDate()), mon: MON[d.getUTCMonth()],
    short: `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`,
    long: `${DOW_LONG[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}` };
}
// weeks run Monday to Sunday, like his posting rhythm
export const weekStart = (s) => addDays(s, -((at(s).getUTCDay() + 6) % 7));
const range = (a, b) => {
  const x = at(a), y = at(b);
  return x.getUTCMonth() === y.getUTCMonth()
    ? `${MON[x.getUTCMonth()]} ${x.getUTCDate()}–${y.getUTCDate()}`
    : `${MON[x.getUTCMonth()]} ${x.getUTCDate()}–${MON[y.getUTCMonth()]} ${y.getUTCDate()}`;
};
export function weekLabel(start, today) {
  const diff = Math.round((at(start) - at(weekStart(today))) / 864e5 / 7);
  const name = diff === 0 ? "This week" : diff === 1 ? "Next week" : diff === -1 ? "Last week" : `Week of ${MON[at(start).getUTCMonth()]} ${at(start).getUTCDate()}`;
  return { name, range: range(start, addDays(start, 6)) };
}
export function groupByWeek(posts, today) {
  const out = [];
  for (const p of posts) {
    const w = weekStart(p.post_date);
    if (!out.length || out[out.length - 1].start !== w) out.push({ start: w, ...weekLabel(w, today), posts: [] });
    out[out.length - 1].posts.push(p);
  }
  return out;
}

export const sortPosts = (posts) => [...posts].sort((a, b) => a.post_date.localeCompare(b.post_date) || (a.sort || 0) - (b.sort || 0));

export function matchesFilter(p, f) {
  if (f === "film") return p.status === "planned";
  if (f === "post") return p.status === "filmed" || p.status === "edited";
  if (f === "posted") return p.status === "posted";
  if (f in LANES) return p.lane === f;
  return true;
}
export function stats(posts) {
  const n = (f) => posts.filter((p) => matchesFilter(p, f)).length;
  return { film: n("film"), post: n("post"), posted: n("posted"), total: posts.length };
}
export const filterCounts = (posts) => Object.fromEntries(FILTERS.map(([k]) => [k, posts.filter((p) => matchesFilter(p, k)).length]));

// the post a computer opens to: today's, else the next one coming up, else the latest
export function pickDefault(posts, today) {
  const s = sortPosts(posts);
  return (s.find((p) => p.post_date === today) || s.find((p) => p.post_date > today) || s[s.length - 1])?.id ?? null;
}

export const scriptParas = (script) => String(script || "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
export const wordCount = (script) => (String(script || "").match(/[A-Za-z0-9’']+/g) || []).length;
// about 2.6 spoken words a second at his pace; rounded to 5s so it reads as an estimate
export function readTime(script) {
  const w = wordCount(script);
  if (!w) return "";
  const s = Math.max(5, Math.round(w / 2.6 / 5) * 5);
  return s < 60 ? `about ${s} sec` : `about ${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} sec` : ""}`;
}
// "A2 · Beat 2: over the shoulder…" → { code: "A2", text: "Beat 2: over the shoulder…" }; other lines are plain notes
export function shotLines(shots) {
  return String(shots || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^([A-Z]\d{1,2})\s*[·:.-]\s*(.+)$/);
    return m ? { code: m[1], text: m[2] } : { code: "", text: l };
  });
}

// suggested posting times (Central), from his daily content engine playbook: LinkedIn 8:30 weekdays and 10 weekends,
// Instagram 11:30, Threads 15 minutes after, TikTok 6. Shown as suggestions, not rules.
export function postTimes(s) {
  const wk = [0, 6].includes(at(s).getUTCDay());
  return { linkedin: wk ? "10:00 AM" : "8:30 AM", instagram: "11:30 AM", threads: "11:45 AM", tiktok: "6:00 PM" };
}
// standing reminder by format, shown above the post's own checks
export function formatReminder(format) {
  if (format === "talking_head") return "Add the music in the app (trending audio), sitting low under your voice. Cover and caption go up with it.";
  if (format === "bts_reel") return "Add the music in the app (trending audio) and keep the sound effects at 20–40% under it. Cover and caption go up with it.";
  return "";
}

export function statusChip(status) {
  return `<span class="st ${STATUS_TONE[status] || ""}">${esc(STATUS_LABEL[status] || status)}</span>`;
}
export function rowHtml(p, { sel = false, today = "" } = {}) {
  const d = fmtDate(p.post_date);
  const cls = ["crow", "cc-row", sel ? "is-sel" : "", p.post_date === today ? "is-today" : "", p.status === "posted" ? "is-done" : ""].filter(Boolean).join(" ");
  return `<a class="${cls}" href="?p=${esc(p.id)}" data-id="${esc(p.id)}"${sel ? ' aria-current="true"' : ""}>
  <span class="cc-date" aria-hidden="true"><i>${esc(d.dow)}</i><b>${esc(d.day)}</b></span>
  <span class="crow-main">
    <span class="crow-top"><span class="crow-name">${esc(p.title)}</span>${statusChip(p.status)}</span>
    <span class="crow-what"><span class="sr-only">${esc(d.long)}${p.post_date === today ? ", today" : ""}. </span>${p.post_date === today ? '<em class="cc-today">Today</em> · ' : ""}${esc(LANES[p.lane] || p.lane)} · ${esc(FORMATS[p.format] || p.format)}</span>
  </span>
</a>`;
}
