/* Taylormade — Inbox · reply templates filled from real booking data (tested in tests/inbox-drafts_test.js).
   Facts only: a price appears only when the booking system has one; no policies, turnaround times or addresses. */
const TZ = "America/Chicago";
const BOOK_URL = "https://www.taylormadecreative.net/book/";
const SERVICE = { music_video: "Music Video", brand_content: "Brand Content", photography: "Photography", event: "Event", other: "Project" };
const SIGN = "— Nelson";

function money(c) { return "$" + (c % 100 ? (c / 100).toFixed(2) : String(c / 100)); }
function longWhen(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }).format(d);
  const t = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${t}`;
}
function monthDay(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(new Date(date + "T12:00:00Z"));
}
function firstName(item) { return item.project.client_name.trim().split(/\s+/)[0] || "there"; }
function what(item) {
  const t = item.project.title;
  return (t && t.includes(" — ") ? t.split(" — ").slice(1).join(" — ") : "") || SERVICE[item.project.service] || "your project";
}
function booked(item) { return item.bookings.find((b) => b.status === "confirmed" || b.status === "completed") || null; }
function pricedService(item) {
  const b = item.bookings.find((x) => x.service && x.service.price_cents != null);
  return b ? b.service : null;
}
const wrap = (first, body) => `Hi ${first},\n\n${body}\n\n${SIGN}`;

export function situation(item) {
  const lastMsg = item.messages[item.messages.length - 1];
  const lastAlert = item.alerts[0];
  if (lastMsg && lastMsg.sender === "client" && (!lastAlert || lastMsg.created_at >= lastAlert.created_at)) return "message";
  if (lastAlert && lastAlert.type === "payment") return "paid";
  if (lastAlert && lastAlert.type === "inquiry") return "inquiry";
  return "other";
}

export function draftOptions(item, slots) {
  const opts = [{ kind: "suggested", label: "Suggested" }, { kind: "call", label: "Offer a call" }];
  if (slots.length && pricedService(item)) opts.push({ kind: "times", label: "Send open times" });
  if (booked(item)) opts.push({ kind: "confirm", label: "Confirm booking" });
  opts.push({ kind: "blank", label: "Blank" });
  return opts;
}

export function buildDraft(item, slots, kind) {
  const first = firstName(item);
  const p = item.project;
  if (kind === "suggested") {
    const s = situation(item);
    if (s === "message") return wrap(first, "Thanks for your message! ");
    if (s === "paid" && booked(item)) kind = "confirm";
    else kind = "call";
  }
  if (kind === "call") {
    const forDate = p.event_date ? ` for ${monthDay(p.event_date)}` : "";
    return wrap(first,
      `Thanks so much for reaching out about ${what(item)}${forDate}. I'd love to hear more about what you have in mind.\n\n` +
      `Could we hop on a quick call? That way I can put together a written quote that fits exactly what you need. What days and times work best for you?`);
  }
  if (kind === "times") {
    const s = pricedService(item);
    const price = s ? `${s.name} is ${money(s.price_cents)}${s.deposit_cents ? ` (${money(s.deposit_cents)} deposit to hold your spot)` : ""}.\n\n` : "";
    const list = slots.slice(0, 6).map((x) => `• ${longWhen(x)}`).join("\n");
    return wrap(first, `Thanks for reaching out! ${price}Here are a few open times:\n${list}\n\nYou can grab any of them here: ${BOOK_URL}`);
  }
  if (kind === "confirm") {
    const b = booked(item);
    if (b) {
      return wrap(first,
        `You're all set for ${b.service ? b.service.name : what(item)} on ${longWhen(b.starts_at)}. Thank you for booking — I'm looking forward to it!\n\n` +
        `If anything comes up before then, just reply here.`);
    }
  }
  return wrap(first, "");
}
