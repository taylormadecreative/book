// Stubbed UI test for the Inbox CRM (/inbox/). Serves the repo locally; every Supabase call is intercepted, never prod.
// Run: node tests/inbox-crm.e2e.mjs        Screenshots: SHOTS=/some/dir node tests/inbox-crm.e2e.mjs
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { build } from "./fixtures/inbox-crm-fixture.mjs";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18732, BASE = `http://localhost:${PORT}/inbox/`;
const SHOTS = process.env.SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser, checks = 0;
const fail = async (m) => { console.error("FAIL:", m); try { await browser?.close(); } catch (_) {} srv.kill(); process.exit(1); };
const ok = async (cond, m) => { checks++; if (!(await cond)) await fail(m); };

const launch = process.env.PW_CHROME ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {};
browser = await chromium.launch(launch);

async function newPage(viewport, { evil = false } = {}) {
  const fx = build(Date.now(), { evil });
  const log = { sends: [], patches: [], marks: [], itemCalls: 0 };
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(() => {
    const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
      user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
    localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => (SHOTS ? r.continue() : r.fulfill({ status: 200, body: "" })));
  await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
    const req = route.request(), url = req.url(), method = req.method();
    const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(req.postData() || "{}"); } catch (_) { return {}; } };
    if (url.includes("/rpc/bk_inbox_list")) return json(body().p_filter === "all" ? fx.all : fx.needs);
    if (url.includes("/rpc/bk_inbox_item")) { log.itemCalls++; const it = fx.items[body().p_project]; return it ? json(it.item) : json({ message: "not found" }, 400); }
    if (url.includes("/rpc/bk_inbox_send")) { log.sends.push(body()); return json({ id: "m1", duplicate: false }); }
    if (url.includes("/rpc/bk_inbox_mark")) {
      const b = body(); log.marks.push(b);
      const handled = b.p_handled ? new Date().toISOString() : null;
      fx.items[b.p_project].item.project.inbox_handled_at = handled;
      const row = fx.all.find((r) => r.id === b.p_project); if (row) row.inbox_handled_at = handled;
      fx.needs = b.p_handled ? fx.needs.filter((r) => r.id !== b.p_project) : fx.needs.concat(row ? [row] : []);
      return json(null);
    }
    if (url.includes("/rpc/bk_open_slots")) return json({ timezone: "America/Chicago", slots: [] });
    if (url.includes("/rpc/bk_outreach_list")) return json([]);
    if (url.includes("/rpc/bk_inbox_vapid_key")) return json(null);
    if (url.includes("/rest/v1/bk_projects")) {
      if (method === "PATCH") {
        const m = url.match(/id=eq\.([0-9a-f-]+)/), b = body(); log.patches.push({ id: m && m[1], ...b });
        if (m && fx.items[m[1]]) Object.assign(fx.items[m[1]].extra, b);
        return json(m ? [{ id: m[1] }] : []);
      }
      const m = url.match(/id=eq\.([0-9a-f-]+)/);
      if (m) return json(fx.items[m[1]] ? fx.items[m[1]].extra : null);
      return json(fx.projects);
    }
    if (url.includes("/auth/v1/")) return json({ id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { page, ctx, fx, log, errors };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shot = async (page, name, opts = {}) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, ...opts }); };
// the composer stays hidden while a conversation loads, so a visible "Hi …" draft belongs to the open one
const draftReady = (page) => page.waitForFunction(() => !document.querySelector("#composer").hidden && document.querySelector("#draft").value.startsWith("Hi "), null, { timeout: 8000 });

/* ---------- desktop ---------- */
{
  const { page, fx, log, errors } = await newPage({ width: 1512, height: 900 }, { evil: !SHOTS });
  await page.goto(BASE);
  await page.waitForSelector("a.crow", { timeout: 8000 }).catch(() => fail("list never rendered"));
  await ok(page.evaluate(() => !window.pwned), "client name executed as HTML");
  // a computer opens the top conversation by itself
  await page.waitForFunction(() => /\?p=/.test(location.search), null, { timeout: 8000 }).catch(() => fail("desktop did not open the first conversation"));
  await draftReady(page).catch(() => fail("draft never filled"));
  const first = fx.needs[0];
  await ok(page.url().includes(first.id), "opened a conversation that isn't the top one");
  await ok((await page.textContent("#wname")).includes("Imani Okafor"), "header name wrong");
  await ok(page.isVisible(".side .scard"), "client & deal column missing on desktop");
  await ok(!(await page.isVisible(".wtabs")), "tabs visible on a wide screen");
  await ok((await page.textContent("#stats")).includes("Waiting on you"), "stats missing");
  await ok((await page.$eval("#stats .crm-stat b", (b) => b.textContent)) === String(fx.needs.length), "waiting count wrong");
  await ok((await page.$$eval(".lgroup", (g) => g.map((x) => x.textContent))).includes("Today"), "day groups missing");
  await ok((await page.$$eval("a.crow.is-waiting", (r) => r.length)) === fx.needs.length, "waiting rows count wrong");
  await ok(page.isVisible(".brief"), "inquiry brief not in the thread");
  await ok((await page.textContent(".brief")).includes("body oil"), "brief text missing");
  await ok((await page.$$eval(".slist a[data-go]", (a) => a.length)) === 1, "earlier project missing");
  await ok((await page.getAttribute("#studioBtn", "href")) === `/admin.html?p=${first.id}`, "Open in Studio link wrong");
  await ok(noSideScroll(page), "desktop scrolls sideways");
  await page.waitForTimeout(SHOTS ? 600 : 50);
  await shot(page, "1-desktop-new-inquiry");

  // money conversation: Dr. Alana Price
  const price = fx.id(3);
  await page.click(`a.crow[data-id="${price}"]`);
  await page.waitForFunction(() => document.querySelector("#composer").hidden || /Price/.test(document.querySelector("#wname").textContent));
  await draftReady(page);
  await ok(page.url().includes(price), "row click didn't route");
  await ok((await page.inputValue("#draft")).startsWith("Hi Dr. Price,"), "doctor greeting wrong: " + (await page.inputValue("#draft")).slice(0, 20));
  await ok(page.evaluate(() => { const t = document.querySelector("#thread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 4; }), "thread didn't open on the newest message");
  const money = await page.$$eval(".money b", (b) => b.map((x) => x.textContent));
  await ok(money.join("|") === "$520|$450|$70", "money totals wrong: " + money.join("|"));
  await ok((await page.inputValue("#noteBox")).includes("department"), "private note not loaded");
  await ok((await page.$$eval(".tev", (e) => e.map((x) => x.textContent).join(" "))).includes("Paid · $450"), "paid event missing");
  await ok((await page.$eval(".bub.theirs", (b) => b.textContent)).includes("DSC06421"), "client message missing");
  await page.waitForTimeout(SHOTS ? 400 : 50);
  await shot(page, "2-desktop-money-and-notes");

  // stage change writes the status and moves the row's chip
  await page.selectOption("#stageSel", "archived");
  await page.waitForFunction(() => /Moved to Archived/.test(document.querySelector("#toast").textContent));
  await ok(log.patches.some((p) => p.id === price && p.status === "archived"), "stage PATCH not sent");
  await ok((await page.textContent(`a.crow[data-id="${price}"] .st`)).trim() === "Archived", "row chip didn't update");
  await page.selectOption("#stageSel", "delivered");
  await page.waitForFunction(() => /Moved to Delivered/.test(document.querySelector("#toast").textContent));

  // notes: Save only lights up after a change; an unsaved note survives a trip to another conversation
  await ok(page.isDisabled("#noteSave"), "Save note enabled before any change");
  await page.fill("#noteBox", "Prefers email. Invoice goes to the department.\nLikes the warm grade.");
  await ok(!(await page.isDisabled("#noteSave")), "Save note stayed disabled");
  await page.click(`a.crow[data-id="${fx.id(2)}"]`); await page.waitForFunction(() => /Marcus/.test(document.querySelector("#wname").textContent)); await draftReady(page);
  await page.click(`a.crow[data-id="${price}"]`); await page.waitForFunction(() => /Price/.test(document.querySelector("#wname").textContent)); await draftReady(page);
  await ok((await page.inputValue("#noteBox")).includes("warm grade"), "unsaved note lost after switching conversations");
  await ok(!(await page.isDisabled("#noteSave")), "restored note isn't marked unsaved");
  await page.click("#noteSave");
  await page.waitForFunction(() => document.querySelector("#noteState").textContent === "Saved");
  await ok(log.patches.some((p) => p.id === price && /warm grade/.test(p.notes_internal || "")), "notes PATCH not sent");

  // copy portal link
  await page.click("#copyPortal");
  await page.waitForFunction(() => /Portal link copied/.test(document.querySelector("#toast").textContent));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await ok(clip.includes(`/portal.html?p=${price}&t=`), "portal link wrong: " + clip);

  // filters
  await page.click('#filters [data-f="leads"]');
  const leads = await page.$$eval("a.crow", (r) => r.map((x) => x.dataset.id));
  await ok(leads.length === 2 && leads.includes(fx.id(1)) && leads.includes(fx.id(2)), "Leads filter wrong: " + leads.length);
  await page.click('#filters [data-f="all"]');
  await ok((await page.$$eval("a.crow", (r) => r.length)) === fx.projects.length, "All should list every project");
  // the Unpaid number is a shortcut to the rows that owe money
  await page.click('#stats [data-f="unpaid"]');
  const unpaid = await page.$$eval("a.crow", (r) => r.map((x) => x.dataset.id).sort());
  await ok(unpaid.join() === [fx.id(2), fx.id(3), fx.id(5)].sort().join(), "Unpaid shortcut wrong: " + unpaid.length);
  await ok((await page.$eval('#filters [aria-pressed="true"]', (b) => b.dataset.f)) === "unpaid", "Unpaid pill not pressed");
  // search looks through everything, Esc clears, "/" focuses
  await page.click(".thread");
  await page.keyboard.press("/");
  await ok(page.evaluate(() => document.activeElement.id === "search"), "/ didn't focus search");
  await page.keyboard.type("walker");
  await ok((await page.$$eval("a.crow", (r) => r.length)) === 1, "search didn't narrow");
  await page.keyboard.press("Escape");
  await ok((await page.inputValue("#search")) === "", "Esc didn't clear search");
  await page.fill("#search", "zzqx");
  await ok(page.isVisible("[data-clearq]"), "no-match state missing");
  await page.click("[data-clearq]");

  // ↓ walks the list
  await page.click('#filters [data-f="needs"]');
  await page.click(`a.crow[data-id="${fx.needs[0].id}"]`); await draftReady(page);
  await page.click(".thread");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((id) => location.search.includes(id), fx.needs[1].id);
  await draftReady(page);

  // templates: an untouched draft swaps in one tap; edited text needs a second tap
  await page.click('#tpls [data-kind="blank"]');
  await ok(!(await page.inputValue("#draft")).includes("Thanks for your message"), "blank template didn't replace");
  await page.fill("#draft", "Hi Marcus, the 21st works.\n\n— Nelson");
  await page.click('#tpls [data-kind="suggested"]');
  await ok((await page.inputValue("#draft")).includes("the 21st works"), "edited reply replaced on first tap");
  await page.fill("#draft", "Hi Marcus, the 21st works. I'll run camera.\n\n— Nelson");

  // Send waits 5s with Undo
  await page.click("#sendBtn");
  await page.waitForTimeout(1200);
  await ok(page.isVisible("#undoSend"), "Undo not shown");
  await shot(page, "3-desktop-sending-with-undo");
  await page.click("#undoSend");
  await page.waitForTimeout(5200);
  await ok(log.sends.length === 0, "Undo didn't cancel the send");
  await ok((await page.inputValue("#draft")).includes("I'll run camera"), "draft lost after Undo");
  await page.click("#sendBtn"); await page.click("#sendBtn", { force: true });
  await page.waitForFunction(() => /Sent to/.test(document.querySelector("#toast").textContent), null, { timeout: 9000 });
  await ok(log.sends.length === 1 && log.sends[0].p_body.includes("run camera"), `expected exactly one send, got ${log.sends.length}`);
  // after a send on a computer the box starts empty (no re-suggested pitch)
  await page.waitForFunction(() => !document.querySelector("#composer").hidden && document.querySelector("#draft").value === "");

  // a reply that's only the greeting and sign-off never goes out
  await page.click('#tpls [data-kind="blank"]');
  await page.click("#sendBtn");
  await ok((await page.textContent("#draftErr")).includes("Add your answer"), "blank reply wasn't stopped");
  await ok(!(await page.isVisible("#undoSend")), "blank reply started counting down");

  // the countdown belongs to the reply: moving to another conversation keeps it going, with Undo in a floating bar
  await page.fill("#draft", "Hi Marcus,\n\nLocked for the 21st.\n\n— Nelson");
  await page.click("#sendBtn");
  await page.click(`a.crow[data-id="${fx.id(1)}"]`);
  await page.waitForFunction(() => /Imani/.test(document.querySelector("#wname").textContent)); await draftReady(page);
  await ok(page.isVisible("#undoBar"), "no floating Undo after moving away mid-countdown");
  await ok((await page.textContent("#undoBarText")).includes("Marcus"), "floating Undo doesn't say who");
  await ok(!(await page.isVisible("#undoSend")), "the other client's composer shows the countdown");
  await ok(!(await page.isDisabled("#sendBtn")), "the other client's Send is stuck disabled");
  await page.waitForTimeout(5200);
  await ok(log.sends.length === 2 && log.sends[1].p_project === fx.id(2) && log.sends[1].p_body.includes("Locked"), "moving away dropped or misrouted the send");
  await ok(!(await page.isVisible("#undoBar")), "floating Undo stayed after sending");
  // …and Undo from the floating bar really cancels
  await page.click(`a.crow[data-id="${fx.id(2)}"]`);
  await page.waitForFunction(() => /Marcus/.test(document.querySelector("#wname").textContent)); await draftReady(page);
  await page.fill("#draft", "Hi Marcus,\n\nOne more thing.\n\n— Nelson");
  await page.click("#sendBtn");
  await page.click(`a.crow[data-id="${fx.id(1)}"]`);
  await page.waitForSelector("#undoBar:not([hidden])");
  await page.waitForTimeout(SHOTS ? 350 : 0);
  await page.waitForFunction(() => { const u = document.querySelector("#undoBar"), b = u.getBoundingClientRect(); return b.bottom <= innerHeight && b.top > innerHeight / 2 && getComputedStyle(u).opacity === "1"; }, null, { timeout: 2000 })
    .catch(() => fail("floating Undo isn't on screen"));
  // it must not sit on top of the reply box's buttons
  await ok(page.evaluate(() => { const u = document.querySelector("#undoBar").getBoundingClientRect(), c = document.querySelector(".composer-acts").getBoundingClientRect(); return u.right < c.left || u.left > c.right || u.bottom < c.top || u.top > c.bottom; }), "floating Undo covers the reply buttons");
  await shot(page, "3b-desktop-undo-follows-you");
  await page.click("#undoBarBtn");
  await page.waitForTimeout(5400);
  await ok(log.sends.length === 2, "floating Undo didn't cancel");
  await page.click(`a.crow[data-id="${fx.id(2)}"]`);
  await page.waitForFunction(() => /Marcus/.test(document.querySelector("#wname").textContent)); await draftReady(page);
  await ok((await page.inputValue("#draft")).includes("One more thing"), "undone reply wasn't kept as a draft");

  // Mark handled takes it out of Needs reply
  const before = await page.$$eval("a.crow", (r) => r.length);
  await page.click("#markBtn");
  await page.waitForFunction(() => /Marked handled/.test(document.querySelector("#toast").textContent));
  await page.waitForFunction((n) => document.querySelectorAll("a.crow").length === n - 1, before);
  await ok(log.marks.length === 1, "mark RPC not called");

  // reload on a deep link opens that exact conversation
  await page.goto(`${BASE}?p=${fx.id(5)}`);
  await draftReady(page);
  await ok((await page.textContent("#wname")).includes("Theo Walker"), "deep link opened the wrong conversation");
  await ok(page.isVisible(`a.crow.is-sel[data-id="${fx.id(5)}"]`), "a deep link outside Needs reply didn't show its row as selected");
  await ok((await page.$eval('#filters [aria-pressed="true"]', (b) => b.dataset.f)) === "all", "deep link didn't switch to All");

  // Pitches still open from the top bar and come back
  await page.click("#pitchesNav");
  await page.waitForSelector("#pitchesView:not([hidden])");
  await ok(page.isVisible("#topBar"), "top bar gone on Pitches");
  await page.click("#ptInboxBtn");
  await page.waitForSelector("#crmView:not([hidden])");
  await ok(errors.length === 0, "page errors: " + errors.join(" | "));
}

/* ---------- laptop + tablet widths ---------- */
for (const vp of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 820, height: 1180 }]) {
  const { page, errors } = await newPage(vp);
  await page.goto(BASE);
  await page.waitForSelector("a.crow"); await draftReady(page);
  await ok(noSideScroll(page), `sideways scroll at ${vp.width}`);
  const tabs = await page.isVisible(".wtabs");
  await ok(vp.width < 1180 ? tabs : !tabs, `tabs wrong at ${vp.width}`);
  if (tabs) {
    await page.click('[data-tab="side"]');
    await ok(page.isVisible("#stageSel"), `Client & deal tab empty at ${vp.width}`);
    await ok(!(await page.isVisible("#composer")), `composer visible on the deal tab at ${vp.width}`);
    await shot(page, `5-${vp.width}-deal-tab`);
    await page.click('[data-tab="thread"]');
  }
  await page.waitForTimeout(SHOTS ? 400 : 50);
  await shot(page, `4-${vp.width}-messages`);
  await ok(errors.length === 0, `page errors at ${vp.width}: ` + errors.join(" | "));
}

/* ---------- phones ---------- */
for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const { page, fx, errors } = await newPage(vp);
  await page.goto(BASE);
  await page.waitForSelector("a.crow");
  await ok(!/\?p=/.test(page.url()), "phone opened a conversation by itself");
  await ok(!(await page.isVisible("#work")), "work surface visible on the phone list");
  await ok(page.isVisible("#statsMini .crm-stat"), "phone stats missing");
  await ok(page.isVisible(".lf-pitches"), "Pitches pill missing on the phone");
  await ok(noSideScroll(page), `phone list scrolls sideways at ${vp.width}`);
  await page.waitForTimeout(SHOTS ? 400 : 50);
  await shot(page, `6-phone-${vp.width}-list`);
  await page.click(`a.crow[data-id="${fx.id(2)}"]`);
  await draftReady(page);
  await ok(!(await page.isVisible(".lpane")), "list still showing over the conversation");
  await ok(page.isVisible("#backBtn") && page.isVisible(".wtabs"), "phone header controls missing");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const newest = await page.evaluate(() => { const b = [...document.querySelectorAll(".bub")].pop().getBoundingClientRect(); return { top: Math.round(b.top), sy: scrollY, ih: innerHeight }; });
  await ok(newest.top >= 0 && newest.top < newest.ih, "phone didn't open on the newest message " + JSON.stringify(newest));
  await ok(noSideScroll(page), `phone conversation scrolls sideways at ${vp.width}`);
  await shot(page, `7-phone-${vp.width}-conversation`);
  await shot(page, `7b-phone-${vp.width}-conversation-full`, { fullPage: true });
  await page.click('[data-tab="side"]');
  await ok(page.isVisible("#stageSel"), "phone deal tab empty");
  await shot(page, `8-phone-${vp.width}-deal`, { fullPage: true });
  await page.click("#backBtn");
  await page.waitForSelector(".lpane", { state: "visible" });
  await ok(!/\?p=/.test(page.url()), "back didn't return to the list");
  await page.goBack(); await draftReady(page);
  await ok(page.isVisible("#work"), "browser Back to a conversation didn't reopen it");
  // sending from a phone goes back to the list for the next one
  await page.click('[data-tab="thread"]');
  await page.fill("#draft", "Hi Marcus,\n\nThe 21st works.\n\n— Nelson");
  await page.click("#sendBtn");
  await page.waitForFunction(() => /Sent to/.test(document.querySelector("#toast").textContent), null, { timeout: 9000 });
  await page.waitForSelector(".lpane", { state: "visible" });
  await ok(!/\?p=/.test(page.url()), "phone stayed in the conversation after sending");
  await ok(errors.length === 0, `phone page errors: ` + errors.join(" | "));
}

console.log(`INBOX CRM TESTS PASSED (${checks} checks)`);
await browser.close(); srv.kill();
