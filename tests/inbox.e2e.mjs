// Stubbed UI test for /inbox/. Serves the repo locally; every Supabase call is intercepted — never touches prod.
// Run: node tests/inbox.e2e.mjs
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", "18731"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser;
const fail = async (m) => { console.error("FAIL:", m); try { await browser?.close(); } catch (_) {} srv.kill(); process.exit(1); };

const EVIL = "<img src=x onerror=window.pwned=1>Jasmine";
const ROW = { id: "11111111-1111-1111-1111-111111111111", client_name: EVIL, title: "Jasmine — Brand Content",
  service: "brand_content", inbox_handled_at: null, last_at: new Date(Date.now() - 7200e3).toISOString(), last_kind: "alert", last_summary: "inquiry" };
const ITEM = { project: { id: ROW.id, client_name: EVIL, client_email: "j@x.com", client_phone: "214 555 0101", company: null,
  service: "brand_content", title: ROW.title, event_date: "2026-10-12", event_time: null, location: null, budget_range: null,
  details: "Launch <b>video</b>", created_at: ROW.last_at, inbox_handled_at: null },
  bookings: [], messages: [], alerts: [{ type: "inquiry", created_at: ROW.last_at }], past_projects: [] };
let sends = 0;

browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
await ctx.addInitScript(() => {
  const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
    user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
  localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
});
await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
  const url = route.request().url();
  const ok = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/rpc/bk_inbox_list")) return ok([ROW]);
  if (url.includes("/rpc/bk_inbox_item")) return ok(ITEM);
  if (url.includes("/rpc/bk_inbox_send")) { sends++; await new Promise((r) => setTimeout(r, 500)); return ok({ id: "m1", duplicate: sends > 1 }); }
  if (url.includes("/rpc/bk_open_slots")) return ok({ timezone: "America/Chicago", slots: [] });
  if (url.includes("/auth/v1/")) return ok({ id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" });
  return ok({});
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:18731/inbox/");
await page.waitForSelector("a.row", { timeout: 8000 }).catch(() => fail("list never rendered (still on login?)"));
if (await page.evaluate(() => window.pwned)) await fail("client name executed as HTML in the list");
if (!(await page.textContent("a.row")).includes("2h")) await fail("waiting time missing");
if (!(await page.locator("a.row .dot").count())) await fail("unread dot missing");
if (await page.isVisible("#loginView")) await fail("sign-in form still visible while signed in");
if (await page.isVisible("#moreBtn")) await fail("Load more visible with fewer than 30 rows");
if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) await fail("list scrolls sideways at phone width");
await page.screenshot({ path: "/tmp/inbox-list.png" });

await page.click("a.row");
await page.waitForFunction(() => document.querySelector("#draft").value.startsWith("Hi "));
if (await page.evaluate(() => window.pwned)) await fail("client name executed as HTML in the detail");
const draft = await page.inputValue("#draft");
if (!draft.includes("Brand Content for October 12") || !draft.includes("written quote") || draft.includes("$")) await fail("suggested draft wrong: " + draft);
if (!(await page.getAttribute("#smsBtn", "href")).startsWith("sms:2145550101&body=Hi%20")) await fail("sms link wrong");
if (await page.isVisible("#sentIt")) await fail("'Sent it by text?' shows before texting");
if (await page.isVisible("#loginView")) await fail("sign-in form visible in detail");
if (!(await page.textContent("#facts")).includes("Mon, Oct 12")) await fail("requested date not formatted");
if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) await fail("detail scrolls sideways at phone width");
const chips = await page.$$eval("#tpls .chip", (b) => b.map((x) => x.dataset.kind));
if (chips.join() !== "suggested,call,blank") await fail("template chips wrong: " + chips);

// unedited → one tap swaps; edited → first tap only warns, second tap replaces
await page.click('#tpls [data-kind="blank"]');
if ((await page.inputValue("#draft")).includes("written quote")) await fail("blank chip did not replace");
await page.fill("#draft", "Hi Jasmine, my own words.\n\n— Nelson");
await page.click('#tpls [data-kind="call"]');
if (!(await page.inputValue("#draft")).includes("my own words")) await fail("edited reply was replaced on first tap");
await page.click('#tpls [data-kind="call"]');
if (!(await page.inputValue("#draft")).includes("written quote")) await fail("second tap did not replace");
await page.screenshot({ path: "/tmp/inbox-detail.png", fullPage: true });

// double tap Send → exactly one request while pending
await page.click("#sendBtn"); await page.click("#sendBtn", { force: true });
await page.waitForSelector("#listView:not([hidden])");
if (sends !== 1) await fail(`expected 1 send request, got ${sends}`);
if (!(await page.textContent("#toast")).includes("Sent to j@x.com")) await fail("no sent toast");

// reload, open again: still works (static checks pass on pages whose buttons do nothing)
await page.reload(); await page.waitForSelector("a.row"); await page.click("a.row");
await page.waitForFunction(() => document.querySelector("#draft").value.length > 0);
if (errors.length) await fail("page errors: " + errors.join(" | "));

console.log("INBOX UI TESTS PASSED");
await browser.close(); srv.kill();
