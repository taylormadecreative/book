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
  return `${day} at ${t} CT`;
}
function monthDay(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(new Date(date + "T12:00:00Z"));
}
function firstName(item) { return item.project.client_name.trim().split(/\s+/)[0] || "there"; }
function what(item) {
  const t = item.project.title;
  return (t && t.includes(" — ") ? t.split(" — ").slice(1).join(" — ") : "") || SERVICE[item.project.service] || "Project";
}
// "your brand content project", or just "your project"
function yourProject(item) {
  const w = what(item).toLowerCase();
  return w === "project" ? "your project" : `your ${w} project`;
}
function booked(item) { return item.bookings.find((b) => b.status === "confirmed" || b.status === "completed") || null; }
function pricedService(item) {
  const b = item.bookings.find((x) => x.service && x.service.price_cents != null);
  return b ? b.service : null;
}
const wrap = (first, body) => `Hi ${first},\n\n${body}\n\n${SIGN}`;

// "message" when the client spoke last, else the latest alert's type (inquiry, payment, contract_signed, …)
export function situation(item) {
  const lastMsg = item.messages[item.messages.length - 1];
  const lastAlert = item.alerts[0];
  if (lastMsg && lastMsg.sender === "client" && (!lastAlert || lastMsg.created_at >= lastAlert.created_at)) return "message";
  return (lastAlert && lastAlert.type) || "other";
}

export function draftOptions(item, slots) {
  const opts = [{ kind: "suggested", label: "Suggested" }];
  if (situation(item) !== "inquiry") opts.push({ kind: "call", label: "Offer a call" });
  if (slots.length && pricedService(item)) opts.push({ kind: "times", label: "Send open times" });
  if (booked(item)) opts.push({ kind: "confirm", label: "Confirm booking" });
  opts.push({ kind: "blank", label: "Blank" });
  return opts;
}

export function buildDraft(item, slots, kind) {
  const first = firstName(item);
  const p = item.project;
  if (kind === "suggested") {
    // only a brand-new inquiry gets the "let's talk / written quote" pitch; paid, signed and
    // payment-problem items start from a thank-you or a blank reply (check admin first)
    const s = situation(item);
    if (s === "message") return wrap(first, "Thanks for your message. ");
    if (s === "inquiry") kind = "call";
    else if (s === "payment") {
      if (booked(item)) kind = "confirm";
      else return wrap(first, "Thank you, your payment came through. I'll follow up shortly with next steps.");
    } else kind = "blank";
  }
  if (kind === "call") {
    const onDate = p.event_date ? ` on ${monthDay(p.event_date)}` : "";
    return wrap(first,
      `Thanks so much for reaching out about ${yourProject(item)}${onDate}. I'd love to hear more about what you have in mind.\n\n` +
      `Could we hop on a quick call? That way I can put together a written quote that fits exactly what you need. What days and times work best for you?`);
  }
  if (kind === "times") {
    const s = pricedService(item);
    const price = s ? `${s.name} is ${money(s.price_cents)}${s.deposit_cents ? ` (${money(s.deposit_cents)} deposit to hold your spot)` : ""}. ` : "";
    const list = slots.slice(0, 6).map((x) => `• ${longWhen(x)}`).join("\n");
    return wrap(first, `${price}Here are a few open times:\n${list}\n\nYou can grab any of them here: ${BOOK_URL}`);
  }
  if (kind === "confirm") {
    const b = booked(item);
    if (b) {
      return wrap(first,
        `You're all set for ${b.service ? b.service.name : what(item)} on ${longWhen(b.starts_at)}. Thanks for booking. I'm looking forward to it.\n\n` +
        `If anything comes up before then, just reply here.`);
    }
  }
  return wrap(first, "");
}
