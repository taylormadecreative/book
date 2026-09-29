import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildDraft, draftOptions, situation } from "../js/inbox-drafts.js";

const project = { id: "p1", client_name: "Jasmine Reed", client_email: "j@x.com", client_phone: null, company: null,
  service: "brand_content", title: "Jasmine Reed — Brand Content", event_date: "2026-10-12", event_time: null,
  location: null, budget_range: "$1–3k", details: "Launch video", created_at: "2026-09-23T15:00:00Z", inbox_handled_at: null };
const inquiry = { project, bookings: [], messages: [], alerts: [{ type: "inquiry", created_at: "2026-09-23T15:00:00Z" }], past_projects: [] };
const headshots = { name: "Headshots", slug: "headshots", kind: "session", price_cents: 15000, deposit_cents: null };
const paid = { ...inquiry, project: { ...project, client_name: "Marcus T", title: "Marcus T — Headshots", event_date: null },
  bookings: [{ id: "b1", starts_at: "2026-10-02T19:00:00Z", duration_min: 30, status: "confirmed", balance_cents: null, balance_status: null, service: headshots }],
  alerts: [{ type: "payment", created_at: "2026-09-23T15:00:00Z" }] };
const SLOTS = ["2026-09-25T15:00:00Z", "2026-09-25T15:30:00Z"];

Deno.test("situation reads the latest event", () => {
  assertEquals(situation(inquiry), "inquiry");
  assertEquals(situation(paid), "paid");
  const msg = { ...paid, messages: [{ sender: "client", body: "Can I bring a friend?", created_at: "2026-09-24T10:00:00Z" }] };
  assertEquals(situation(msg), "message");
});

Deno.test("project inquiry: suggested reply offers a call + written quote and never a dollar amount", () => {
  const d = buildDraft(inquiry, [], "suggested");
  assert(d.startsWith("Hi Jasmine,"));
  assertStringIncludes(d, "Brand Content for October 12");
  assertStringIncludes(d, "written quote");
  assert(!d.includes("$"), "no price may appear when the booking system has none");
  assert(d.trimEnd().endsWith("— Nelson"));
});

Deno.test("paid booking: suggested reply confirms the real day and time in Central", () => {
  const d = buildDraft(paid, [], "suggested");
  assertStringIncludes(d, "Hi Marcus,");
  assertStringIncludes(d, "You're all set for Headshots on Friday, October 2 at 2:00 PM");
});

Deno.test("open times list real slots and the real price only", () => {
  const d = buildDraft(paid, SLOTS, "times");
  assertStringIncludes(d, "Headshots is $150.");
  assertStringIncludes(d, "• Friday, September 25 at 10:00 AM");
  assertStringIncludes(d, "• Friday, September 25 at 10:30 AM");
  assertStringIncludes(d, "https://www.taylormadecreative.net/book/");
});

Deno.test("deposit is mentioned only when the service has one", () => {
  const withDep = { ...paid, bookings: [{ ...paid.bookings[0], service: { ...headshots, name: "Birthday Mini", price_cents: 15000, deposit_cents: 7500 } }] };
  assertStringIncludes(buildDraft(withDep, SLOTS, "times"), "Birthday Mini is $150 ($75 deposit to hold your spot).");
  assert(!buildDraft(paid, SLOTS, "times").includes("deposit"));
});

Deno.test("options only include what the facts support", () => {
  assertEquals(draftOptions(inquiry, []).map((o) => o.kind), ["suggested", "call", "blank"]);
  assertEquals(draftOptions(paid, SLOTS).map((o) => o.kind), ["suggested", "call", "times", "confirm", "blank"]);
});

Deno.test("client message: a reply shell with their first name", () => {
  const msg = { ...paid, messages: [{ sender: "client", body: "Can I bring a friend?", created_at: "2026-09-24T10:00:00Z" }] };
  const d = buildDraft(msg, [], "suggested");
  assertEquals(d, "Hi Marcus,\n\nThanks for your message! \n\n— Nelson");
});

Deno.test("a blank-ish name falls back to 'there'", () => {
  const d = buildDraft({ ...inquiry, project: { ...project, client_name: "   " } }, [], "blank");
  assertEquals(d, "Hi there,\n\n\n\n— Nelson");
});
