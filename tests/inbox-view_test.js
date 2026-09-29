import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import { esc, ago, fmtWhen, smsHref, telHref, pushSupport, newKey, listRowHtml } from "../js/inbox-view.js";

const now = new Date("2026-09-23T18:00:00Z");

Deno.test("ago", () => {
  assertEquals(ago("2026-09-23T17:59:30Z", now), "now");
  assertEquals(ago("2026-09-23T17:45:00Z", now), "15m");
  assertEquals(ago("2026-09-23T16:00:00Z", now), "2h");
  assertEquals(ago("2026-09-20T18:00:00Z", now), "3d");
});

Deno.test("fmtWhen is Central time", () => {
  assertEquals(fmtWhen("2026-10-02T19:00:00Z"), "Fri, Oct 2 · 2:00 PM");
});

Deno.test("sms and tel hrefs keep only dialable chars and encode the body", () => {
  assertEquals(telHref("(214) 555-0101"), "tel:2145550101");
  assertEquals(smsHref("+1 214 555 0101", "Hi & bye"), "sms:+12145550101&body=Hi%20%26%20bye");
  assertEquals(telHref(null), null);
  assertEquals(telHref("abc"), null);
});

Deno.test("pushSupport", () => {
  assertEquals(pushSupport({ sw: true, push: true, notif: true, standalone: true, ios: true }), "ok");
  assertEquals(pushSupport({ sw: true, push: false, notif: false, standalone: false, ios: true }), "install");
  assertEquals(pushSupport({ sw: true, push: true, notif: true, standalone: false, ios: true }), "install");
  assertEquals(pushSupport({ sw: true, push: true, notif: true, standalone: false, ios: false }), "ok");
  assertEquals(pushSupport({ sw: false, push: false, notif: false, standalone: false, ios: false }), "unsupported");
});

Deno.test("newKey is unique and 8–80 chars", () => {
  const a = newKey(), b = newKey();
  assert(a !== b && a.length >= 8 && a.length <= 80);
});

Deno.test("list row escapes client text and shows the unread dot", () => {
  const html = listRowHtml({ id: "p1", client_name: "<img src=x onerror=alert(1)>", title: "X — Headshots",
    service: "photography", inbox_handled_at: null, last_at: "2026-09-23T16:00:00Z", last_kind: "message",
    last_summary: "<b>hi</b>" }, now);
  assert(!html.includes("<img"));
  assertStringIncludes(html, "&lt;img");
  assertStringIncludes(html, "&lt;b&gt;hi&lt;/b&gt;");
  assertStringIncludes(html, 'class="dot"');
  assertStringIncludes(html, "2h");
  assertEquals(esc(`"'&`), "&quot;&#39;&amp;");
});

Deno.test("fmtDay formats a plain date without timezone drift", async () => {
  const { fmtDay } = await import("../js/inbox-view.js");
  assertEquals(fmtDay("2026-10-12"), "Mon, Oct 12");
  assertEquals(fmtDay(null), "");
});
