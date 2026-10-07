import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import { hashInput, sha256Hex, safeHref, igHref, gmailHref, splitParas, joinParas, pitchRowHtml, scoreHtml, timelineHtml, mailFrame, previewDoc, pitchActions, shotsHtml } from "../js/inbox-pitches-view.js";

Deno.test("sha256Hex", async () => {
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
Deno.test("the approval hash matches the Mac's (same vectors as pitch/test/hash.test.mjs)", async () => {
  assertEquals(await sha256Hex(hashInput({ subject: "Hello", email_html: "<p>a</p>", fu1_html: "<p>b</p>", fu2_html: "<p>c</p>", dm_text: null })),
    "b3693aecd629eca1be1c91589ebc31dbdbb0d10ef2fac2769254aa61cebe2254");
  assertEquals(await sha256Hex(hashInput({ dm_text: "Hi there https://x.y/" })), "1d4ca3c3dcb941ed503f756fde9409ae7ebc1613cb970c8bdce6a3e512c5cff1");
});
Deno.test("links: only https, valid handles, Gmail search by Message-ID", () => {
  assertEquals(safeHref("https://ok.example/a"), "https://ok.example/a");
  assertEquals(safeHref("javascript:alert(1)"), null);
  assertEquals(safeHref("http://plain.example"), null);
  assertEquals(igHref("layer.loaf"), "https://www.instagram.com/layer.loaf/");
  assertEquals(igHref("bad handle"), null);
  assertEquals(gmailHref("<r1@mail.example>"), "https://mail.google.com/mail/u/0/#search/rfc822msgid%3Ar1%40mail.example");
  assertEquals(gmailHref(null), null);
});
Deno.test("paragraph editing round-trips", () => {
  assertEquals(splitParas("One.\n\n\nTwo\nlines.\n\n  \nThree."), ["One.", "Two\nlines.", "Three."]);
  assertEquals(joinParas(["a", "b"]), "a\n\nb");
});
Deno.test("rows and scores escape everything", () => {
  const row = pitchRowHtml({ id: "x", org: "<img src=x onerror=1>Layer Loaf", lane: "small_business", offer_id: "content-day", channel: "dm", status: "held", hold_reason: "<b>why</b>", score_total: 12 });
  assert(!row.includes("<img src=x"));
  assertStringIncludes(row, "12/15"); assertStringIncludes(row, "DM"); assertStringIncludes(row, "Held"); assertStringIncludes(row, "&lt;b&gt;why");
  const sc = scoreHtml({ need: { n: 3, why: "<i>x</i>", url: "javascript:alert(1)" }, money: { n: 2, why: "ok", url: "https://s.example" } });
  assert(!sc.includes("javascript:")); assertStringIncludes(sc, "&lt;i&gt;x"); assertStringIncludes(sc, 'href="https://s.example"');
  assertStringIncludes(sc, "Warmth 0/3");
});
Deno.test("timeline links a reply to Gmail", () => {
  const t = timelineHtml([{ kind: "reply", at: "2026-10-07T15:00:00Z", detail: { message_id: "<r1@m.example>" } }], new Date("2026-10-07T17:00:00Z"));
  assertStringIncludes(t, "They replied"); assertStringIncludes(t, "rfc822msgid%3Ar1%40m.example"); assertStringIncludes(t, "2h");
});
Deno.test("the email preview is sandboxed and its HTML stays inside the attribute", () => {
  const f = mailFrame(`<p class="x">it's "quoted"</p><script>parent.x=1</script>`, "First email");
  assertStringIncludes(f, 'sandbox="allow-popups allow-popups-to-escape-sandbox"');
  assert(!/allow-scripts|allow-same-origin/.test(f));
  assert(!f.includes('<p class="x">'));
  assertStringIncludes(f, "&lt;script&gt;");
});
Deno.test("preview opens links in a new tab without touching the approval hash", async () => {
  const withHead = previewDoc("<html><head><title>x</title></head><body><a href=\"https://a.example\">a</a></body></html>");
  assertStringIncludes(withHead, '<head><base target="_blank"><title>');
  assertEquals(previewDoc("<p>hi</p>"), '<base target="_blank"><p>hi</p>');
  const f = mailFrame("<p>hi</p>", "t");
  assertStringIncludes(f.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"'), '<base target="_blank">');
  const p = { subject: "S", email_html: "<p>hi</p>", fu1_html: "<p>b</p>", fu2_html: "<p>c</p>", dm_text: null };
  assertEquals(hashInput(p), "S\u0000<p>hi</p>\u0000<p>b</p>\u0000<p>c</p>\u0000");
});
Deno.test("actions by status: Skip while an edit re-renders, Stop only while follow-ups are still to come", () => {
  const on = (st, ch = "email") => Object.entries(pitchActions(st, ch)).filter(([, v]) => v).map(([k]) => k).sort().join(",");
  assertEquals(on("ready"), "any,approve,edit,skip");
  assertEquals(on("rendering"), "any,skip");
  assertEquals(on("approved"), "any,edit,skip,unapprove");
  assertEquals(on("held"), "any,edit,skip");
  assertEquals(on("dm_ready", "dm"), "any,dm,skip");
  assertEquals(on("sent"), "any,stop");
  for (const st of ["sending", "done", "cancelled", "skipped"]) assertEquals(on(st), "", st);
  assertEquals(pitchActions("sent", "dm").stop, false);
});

Deno.test("proposal captures: phone segments stack in one scrolling phone window, in order; the desktop view stands alone, uncropped", () => {
  const h = shotsHtml([{ path: "p/phone-01.jpg", url: "https://s/1" }, { path: "p/phone-02.jpg", url: "https://s/2" }, { path: "p/desktop.jpg", url: "https://s/d" }]);
  const phone = h.slice(h.indexOf('class="pt-phone-scroll"'), h.indexOf("</div>"));
  assert(phone.indexOf("https://s/1") >= 0 && phone.indexOf("https://s/1") < phone.indexOf("https://s/2"));
  assert(!phone.includes("https://s/d"));
  assertStringIncludes(h.slice(h.indexOf('class="pt-desk"')), "https://s/d");
});
Deno.test("proposal captures: an older single phone.jpg still shows; nothing at all renders nothing; urls are escaped", () => {
  assertStringIncludes(shotsHtml([{ path: "p/phone.jpg", url: "https://s/1" }]), 'class="pt-phone-scroll"');
  assertEquals(shotsHtml([]), "");
  assert(!shotsHtml([{ path: "p/phone-01.jpg", url: 'https://s/"><script>' }]).includes("<script>"));
});
