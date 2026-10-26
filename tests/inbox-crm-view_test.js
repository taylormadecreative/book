import { assert, assertEquals } from "jsr:@std/assert@1";
import { money, initials, invoiceTotals, dayGroup, stats, mergeRow, matches, lastLine, rowHtml, timeline, replyIsEmpty, isBooked } from "../js/inbox-crm-view.js";

Deno.test("money rounds to dollars and shortens big totals", () => {
  assertEquals(money(45000), "$450");
  assertEquals(money(125050), "$1,251");
  assertEquals(money(1240000, true), "$12.4K");
  assertEquals(money(990000, true), "$9,900");
  assertEquals(money(0), "$0");
});

Deno.test("initials skip titles and odd characters", () => {
  assertEquals(initials("Dr. Melva K. Wallace"), "MW");
  assertEquals(initials("Farida"), "FA");
  assertEquals(initials("<img src=x>Jas"), "IJ");
  assertEquals(initials(""), "?");
});

Deno.test("invoice totals count sent and paid only", () => {
  const t = invoiceTotals([
    { amount_cents: 45000, status: "paid" }, { amount_cents: 7000, status: "sent" },
    { amount_cents: 99999, status: "draft" }, { amount_cents: 5000, status: "void" },
  ]);
  assertEquals(t, { invoiced: 52000, paid: 45000, due: 7000, count: 2 });
  assertEquals(invoiceTotals(null).count, 0);
});

Deno.test("day groups follow the Dallas calendar", () => {
  const now = new Date("2026-10-26T15:00:00Z"); // 10 AM CT
  assertEquals(dayGroup("2026-10-26T06:00:00Z", now), "Today"); // 1 AM CT
  assertEquals(dayGroup("2026-10-26T04:00:00Z", now), "Yesterday"); // 11 PM CT the night before
  assertEquals(dayGroup("2026-10-21T15:00:00Z", now), "This week");
  assertEquals(dayGroup("2026-10-01T15:00:00Z", now), "Earlier");
});

Deno.test("stats: unpaid, this month's money, new leads", () => {
  const now = new Date("2026-10-26T15:00:00Z");
  const s = stats([
    { created_at: "2026-10-25T15:00:00Z", status: "new", bk_invoices: [{ amount_cents: 10000, status: "sent" }] },
    { created_at: "2026-10-24T15:00:00Z", status: "lost", bk_invoices: [] },
    { created_at: "2026-09-01T15:00:00Z", status: "delivered", bk_invoices: [
      { amount_cents: 45000, status: "paid", paid_at: "2026-10-02T15:00:00Z" },
      { amount_cents: 30000, status: "paid", paid_at: "2026-09-30T15:00:00Z" },
    ] },
  ], 4, now);
  assertEquals(s.waiting, 4);
  assertEquals(s.newLeads, 1);
  assertEquals(s.unpaid, 10000);
  assertEquals(s.collected, 45000);
  assertEquals(s.monthName, "October");
});

Deno.test("rows merge activity with the project and escape client text", () => {
  const act = { id: "p1", client_name: "<b>Jas</b>", title: "Jas — Brand Content", service: "brand_content", last_at: "2026-10-26T14:00:00Z", last_kind: "message", last_summary: "Hi <i>there</i>" };
  const proj = { id: "p1", client_name: "<b>Jas</b>", title: act.title, service: "brand_content", company: "Okafor & Co", client_email: "j@x.com", status: "quoted", created_at: "2026-10-20T14:00:00Z", bk_invoices: [{ amount_cents: 125000, status: "sent" }] };
  const r = mergeRow(act, proj, true);
  assertEquals(r.due, 125000);
  assertEquals(lastLine(r), "“Hi <i>there</i>”");
  const html = rowHtml(r, { now: new Date("2026-10-26T15:00:00Z"), sel: true });
  assert(!html.includes("<b>Jas") && html.includes("&lt;b&gt;Jas"));
  assert(html.includes("$1,250 unpaid") && html.includes("Quoted") && html.includes('aria-current="true"'));
  assert(matches(r, "okafor jas") && !matches(r, "wallace"));
  assertEquals(lastLine(mergeRow(null, { ...proj, status: "booked" }, false)), "Booked");
});

Deno.test("timeline: brief first, no duplicate payment, money events in order", () => {
  const item = {
    project: { created_at: "2026-10-01T10:00:00Z" },
    messages: [{ sender: "client", body: "hi", created_at: "2026-10-01T11:00:00Z" }],
    alerts: [{ type: "inquiry", created_at: "2026-10-01T10:00:00Z" }, { type: "payment", created_at: "2026-10-03T10:00:00Z" }, { type: "payment_stuck", created_at: "2026-10-04T10:00:00Z" }],
  };
  const extra = { bk_messages: item.messages, bk_invoices: [{ title: "Deposit", amount_cents: 50000, status: "paid", created_at: "2026-10-02T10:00:00Z", paid_at: "2026-10-03T10:00:00Z" }, { title: "Draft", amount_cents: 1, status: "draft", created_at: "2026-10-02T11:00:00Z" }] };
  const ev = timeline(item, extra);
  assertEquals(ev.map((e) => e.kind), ["brief", "msg", "event", "event", "event"]);
  assertEquals(ev[2].label, "Invoice sent · Deposit · $500");
  assertEquals(ev[3].label, "Paid · $500");
  assertEquals(ev[4].label, "Started booking, didn't pay");
  // without the invoice rows, the payment alert still shows
  assert(timeline(item, null).some((e) => e.label === "Payment came in"));
});

Deno.test("a reply that's only a greeting and sign-off counts as empty", () => {
  assert(replyIsEmpty("Hi Kendra,\n\n\n\n— Nelson"));
  assert(replyIsEmpty("Hi Dr. Price,\n\nThanks for your message. \n\n— Nelson"));
  assert(replyIsEmpty("   "));
  assert(!replyIsEmpty("Hi Kendra,\n\nSee you Friday.\n\n— Nelson"));
  assert(!replyIsEmpty("Hi Marcus, the 21st works."));
});

Deno.test("only booked work counts as a shoot", () => {
  assert(isBooked("booked") && isBooked("delivered") && !isBooked("new") && !isBooked("quoted") && !isBooked(null));
});
