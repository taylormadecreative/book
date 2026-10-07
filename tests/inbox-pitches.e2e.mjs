// Stubbed UI test for the Pitches tab in /inbox/. Every Supabase call is intercepted — never touches prod.
// Run: node tests/inbox-pitches.e2e.mjs
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18732, BASE = `http://localhost:${PORT}`;
const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser;
const fail = async (m) => { console.error("FAIL:", m); try { await browser?.close(); } catch (_) {} srv.kill(); process.exit(1); };
const hash = (p) => createHash("sha256").update(["subject", "email_html", "fu1_html", "fu2_html", "dm_text"].map((k) => p[k] ?? "").join("\u0000")).digest("hex");

const EVIL = "<img src=x onerror=window.pwned=1>Layer & Loaf Bakery";
const ID = "22222222-2222-2222-2222-222222222222", DM_ID = "33333333-3333-3333-3333-333333333333", BAD_ID = "44444444-4444-4444-4444-444444444444";
const SENT_ID = "55555555-5555-5555-5555-555555555555", REND_ID = "66666666-6666-6666-6666-666666666666";
const ROWS = [
  { id: ID, org: EVIL, lane: "small_business", offer_id: "content-day", channel: "email", status: "ready", why: "Best of Dallas 2026", score_total: 12 },
  { id: DM_ID, org: "Fitting Room Vintage", lane: "small_business", offer_id: "content-day", channel: "dm", status: "dm_ready", why: "Vintage fitting room", score_total: 11 },
];
const PARTS = { subject: "The Layer & Loaf concept, layer by layer",
  email: { greeting: "Hi Sam,", paragraphs: ["First para.", "Second para."], cta_label: "See the concept", signoff: "Looking forward to connecting," },
  fu1: { greeting: "Hi Sam,", paragraphs: ["Follow one."], signoff: "Talk soon," }, fu2: { greeting: "Hi Sam,", paragraphs: ["Follow two."], signoff: "Talk soon," } };
const PITCH = { id: ID, channel: "email", status: "ready", offer_id: "content-day", why: "Best of Dallas 2026", parts: PARTS,
  score: { need: { n: 3, why: "launch", url: "https://example.com/a" }, money: { n: 2, why: "<b>x</b>", url: "javascript:alert(1)" },
    timing: { n: 3, why: "now", url: "https://example.com/t" }, reach: { n: 2, why: "owner email", url: "https://example.com/r" }, warmth: { n: 0, why: "cold", url: "" }, total: 10 },
  subject: PARTS.subject, email_html: "<html><body><p>Hi Sam,</p><script>parent.pwned=1</script></body></html>", fu1_html: "<p>F1</p>", fu2_html: "<p>F2</p>",
  dm_text: null, shots: ["p1/phone.jpg", "p1/desktop.jpg"], samples: [] };
PITCH.content_hash = hash(PITCH);
const ITEM = { pitch: PITCH, prospect: { org: EVIL, lane: "small_business", contact_name: "Sam", contact_role: "Owner", email: "sam@layerloaf.example",
  email_source_url: "https://layerloaf.example/about", instagram: "layerloaf" }, events: [], settings: { shadow: true, paused: false } };
const BAD = structuredClone(ITEM); BAD.pitch.id = BAD_ID; BAD.pitch.content_hash = "0".repeat(64);
const SENT = structuredClone(ITEM); Object.assign(SENT.pitch, { id: SENT_ID, status: "sent", step_done: 1, next_at: "2026-10-13T13:00:00Z" });
SENT.events = [{ kind: "sent", at: "2026-10-07T15:00:00Z", detail: { message_id: "<m1@x>" } }];
const REND = structuredClone(ITEM); Object.assign(REND.pitch, { id: REND_ID, status: "rendering" });
const DMP = { id: DM_ID, channel: "dm", status: "dm_ready", offer_id: "content-day", why: "Fur", parts: { dm: "Hey {{PROPOSAL_URL}}" }, score: {},
  subject: null, email_html: null, fu1_html: null, fu2_html: null, dm_text: "Hey https://taylormadecreative.github.io/proposals/fittingroomvintage/", shots: [], samples: [] };
DMP.content_hash = hash(DMP);
const DM = { pitch: DMP, prospect: { org: "Fitting Room Vintage", lane: "small_business", instagram: "fittingroomvintage" }, events: [], settings: { shadow: false, paused: false } };
const calls = [];

browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
await ctx.addInitScript(() => {
  const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
    user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
  localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
});
await ctx.route("**/instagram.com/**", (r) => r.fulfill({ status: 200, body: "ig" }));
await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
  const url = route.request().url();
  let body = null; try { body = route.request().postDataJSON(); } catch (_) { /* not JSON */ }
  const ok = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  const m = /\/rpc\/(\w+)/.exec(url); if (m) calls.push({ fn: m[1], body });
  if (url.includes("/rpc/bk_inbox_list")) return ok([]);
  if (url.includes("/rpc/bk_outreach_list")) return ok(ROWS);
  if (url.includes("/rpc/bk_outreach_item")) return ok({ [DM_ID]: DM, [BAD_ID]: BAD, [SENT_ID]: SENT, [REND_ID]: REND }[body.p_id] ?? ITEM);
  if (url.includes("/rpc/bk_outreach_")) return ok({ status: "ok" });
  if (url.includes("/storage/v1/object/sign/outreach")) return ok((body?.paths ?? []).map((p) => ({ path: p, signedURL: `/object/sign/outreach/${p}?token=t`, error: null })));
  if (url.includes("/auth/v1/")) return ok({ id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" });
  return ok({});
});
const page = await ctx.newPage();
const errors = [];
// The sandboxed email frames have no same-origin access by design, so Playwright's own init scripts (service-worker block + the auth seed above)
// throw inside them. That is the sandbox working; ignore only that message, anything else still fails the run.
page.on("pageerror", (e) => { if (!/sandboxed and lacks the 'allow-same-origin' flag/.test(e.message)) errors.push(e.message); });
const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

// list
await page.goto(`${BASE}/inbox/`);
await page.waitForSelector("#pitchesNav", { timeout: 8000 }).catch(() => fail("no Pitches chip in the inbox"));
await page.click("#pitchesNav");
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("pitches list never rendered"));
if (!page.url().includes("view=pitches")) await fail("URL is not ?view=pitches");
if (await page.evaluate(() => window.pwned)) await fail("org name ran as HTML in the list");
const listText = await page.textContent("#ptList");
if (!listText.includes("12/15") || !listText.includes("DM ready")) await fail("score or DM badge missing: " + listText);
if (await sideways()) await fail("pitches list scrolls sideways");

// detail
await page.click(`a.pt-row[data-pitch="${ID}"]`);
await page.waitForSelector("iframe.pt-mail", { timeout: 8000 }).catch(() => fail("email preview missing"));
const sb = await page.getAttribute("iframe.pt-mail", "sandbox");
if (sb === null || /allow-scripts|allow-same-origin/.test(sb)) await fail("preview iframe not sandboxed: " + sb);
await page.waitForTimeout(400);
if (await page.evaluate(() => window.pwned)) await fail("email HTML or org ran script in the app");
if (await page.locator('.pt-score a[href^="javascript"]').count()) await fail("javascript: source link rendered");
if (!(await page.textContent("#ptDetail")).includes("Preview mode")) await fail("preview-mode banner missing");
if (await page.locator(".pt-shots img").count() !== 2) await fail("proposal screenshots missing");
if (await page.isDisabled("#ptApprove")) await fail("Approve disabled although the hash matches");
if (await page.isVisible("#ptStop")) await fail("Stop follow-ups shown on a pitch that hasn't been sent");
if (await sideways()) await fail("detail scrolls sideways");

// approve → undo → nothing; approve → one call with the hash
await page.click("#ptApprove");
if (!(await page.textContent("#ptApprove")).includes("Approving in")) await fail("no countdown on Approve");
await page.click("#ptUndo");
await page.waitForTimeout(5600);
if (calls.some((c) => c.fn === "bk_outreach_approve")) await fail("Undo did not stop the approval");
await page.click("#ptApprove");
await page.waitForTimeout(5600);
const ap = calls.filter((c) => c.fn === "bk_outreach_approve");
if (ap.length !== 1 || ap[0].body.p_hash !== PITCH.content_hash || ap[0].body.p_id !== ID) await fail("approve call wrong: " + JSON.stringify(ap));
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("did not return to the list after approving"));

// Edit / Skip during the 5s countdown must cancel the approval
await page.goto(`${BASE}/inbox/?pitch=${ID}`);
await page.waitForSelector("#ptEdit:not([hidden])", { timeout: 8000 });
const n0 = calls.filter((c) => c.fn === "bk_outreach_approve").length;
await page.click("#ptApprove"); await page.click("#ptEdit"); await page.waitForTimeout(5600);
if (calls.filter((c) => c.fn === "bk_outreach_approve").length !== n0) await fail("Edit did not cancel the pending approval");
await page.goto(`${BASE}/inbox/?pitch=${ID}`);
await page.waitForSelector("#ptSkip:not([hidden])", { timeout: 8000 });
await page.click("#ptApprove"); await page.click("#ptSkip"); await page.click('#ptSkipReasons [data-reason="bad_timing"]');
await page.waitForTimeout(5600);
if (calls.filter((c) => c.fn === "bk_outreach_approve").length !== n0) await fail("Skip did not cancel the pending approval");
if (!calls.some((c) => c.fn === "bk_outreach_skip" && c.body.p_reason === "bad_timing")) await fail("skip RPC missing after approve->skip");
calls.length = 0;

// a pitch whose content doesn't match its hash can't be approved
await page.goto(`${BASE}/inbox/?pitch=${BAD_ID}`);
await page.waitForSelector("iframe.pt-mail", { timeout: 8000 }).catch(() => fail("stale pitch did not open"));
if (!(await page.isDisabled("#ptApprove"))) await fail("Approve enabled for content that doesn't match its hash");
if (!(await page.textContent("#ptDetail")).includes("changed while it loaded")) await fail("no stale warning");

// edit
await page.goto(`${BASE}/inbox/?pitch=${ID}`);
await page.waitForSelector("#ptEdit:not([hidden])", { timeout: 8000 });
await page.click("#ptEdit");
await page.waitForSelector("#pe-email-body");
if ((await page.inputValue("#pe-email-body")) !== "First para.\n\nSecond para.") await fail("editor did not load the paragraphs");
await page.fill("#pe-email-body", "New first.\n\nNew second.");
await page.click("#peSave");
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("did not return to the list after saving"));
const ed = calls.find((c) => c.fn === "bk_outreach_edit");
if (!ed || JSON.stringify(ed.body.p_parts.email.paragraphs) !== '["New first.","New second."]' || ed.body.p_parts.fu1.paragraphs[0] !== "Follow one."
    || ed.body.p_parts.email.cta_label !== "See the concept") await fail("edit payload wrong: " + JSON.stringify(ed));

// skip "I know them"
await page.goto(`${BASE}/inbox/?pitch=${ID}`);
await page.waitForSelector("#ptSkip:not([hidden])", { timeout: 8000 });
await page.click("#ptSkip");
await page.click('#ptSkipReasons [data-reason="know_them"]');
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("did not return to the list after skipping"));
if (!calls.some((c) => c.fn === "bk_outreach_skip" && c.body.p_reason === "know_them" && c.body.p_id === ID)) await fail("skip call wrong");

// DM ready: copy + I sent it
await page.goto(`${BASE}/inbox/?pitch=${DM_ID}`);
await page.waitForSelector("#ptCopyDm:not([hidden])", { timeout: 8000 }).catch(() => fail("Copy DM button missing"));
await page.click("#ptCopyDm");
const clip = await page.evaluate(() => navigator.clipboard.readText());
if (!clip.includes("/proposals/fittingroomvintage/")) await fail("DM not copied: " + clip);
await page.click("#ptDmSent");
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("did not return after DM sent"));
if (!calls.some((c) => c.fn === "bk_outreach_dm_sent" && c.body.p_id === DM_ID)) await fail("dm_sent call missing");

// re-rendering an edit: Skip is offered, Approve/Edit are not
calls.length = 0;
await page.goto(`${BASE}/inbox/?pitch=${REND_ID}`);
await page.waitForSelector("#ptSkip:not([hidden])", { timeout: 8000 }).catch(() => fail("Skip not offered while the edit re-renders"));
if (await page.isVisible("#ptApprove") || await page.isVisible("#ptEdit")) await fail("Approve/Edit shown while re-rendering");
await page.click("#ptSkip"); await page.click('#ptSkipReasons [data-reason="wrong_fit"]');
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("did not return to the list after skipping a re-rendering pitch"));
if (!calls.some((c) => c.fn === "bk_outreach_skip" && c.body.p_id === REND_ID && c.body.p_reason === "wrong_fit")) await fail("skip of a re-rendering pitch missing");

// sent: Stop follow-ups waits 5s with Undo; Undo and Back cancel it; otherwise exactly one call
await page.goto(`${BASE}/inbox/?pitch=${SENT_ID}`);
await page.waitForSelector("#ptStop:not([hidden])", { timeout: 8000 }).catch(() => fail("Stop follow-ups missing on a sent pitch"));
for (const b of ["#ptApprove", "#ptEdit", "#ptSkip", "#ptUnapprove"]) if (await page.isVisible(b)) await fail(`${b} shown on a sent pitch`);
const stops = () => calls.filter((c) => c.fn === "bk_outreach_stop");
await page.click("#ptStop");
if (!(await page.textContent("#ptStop")).includes("Stopping in")) await fail("no countdown on Stop follow-ups");
await page.click("#ptUndo");
await page.waitForTimeout(5600);
if (stops().length) await fail("Undo did not cancel Stop follow-ups");
if ((await page.textContent("#ptStop")) !== "Stop follow-ups" || await page.isDisabled("#ptStop")) await fail("Stop button not restored after Undo");
await page.click("#ptStop"); await page.click("#ptBack");
await page.waitForTimeout(5600);
if (stops().length) await fail("Back did not cancel Stop follow-ups");
await page.goto(`${BASE}/inbox/?pitch=${SENT_ID}`);
await page.waitForSelector("#ptStop:not([hidden])", { timeout: 8000 });
await page.click("#ptStop");
await page.waitForTimeout(5600);
if (stops().length !== 1 || stops()[0].body.p_id !== SENT_ID) await fail("stop call wrong: " + JSON.stringify(stops()));
await page.waitForSelector("a.pt-row", { timeout: 8000 }).catch(() => fail("did not return to the list after stopping follow-ups"));

// back to the regular inbox
await page.click("#ptInboxBtn");
await page.waitForSelector("#listView:not([hidden])", { timeout: 8000 }).catch(() => fail("‹ Inbox did not go back"));

if (errors.length) await fail("page errors: " + errors.join(" | "));
await browser.close(); srv.kill();
console.log("INBOX PITCHES E2E PASSED");
