// Stubbed UI test for the Studio content calendar (content.html). Serves the repo locally; every Supabase
// call is intercepted, so it never touches prod. The posts below are made up: real scripts never go in this public repo.
// Run: node tests/content.e2e.mjs   (SHOTS=<dir> saves stills)
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18753, BASE = `http://localhost:${PORT}`;
const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const SHOTS = process.env.SHOTS;
let browser, passed = 0;
const fail = async (m) => { console.error("FAIL:", m); try { await browser?.close(); } catch (_) {} srv.kill(); process.exit(1); };
const ok = (cond, m) => { if (!cond) { console.error("FAIL:", m); srv.kill(); process.exit(1); } passed++; };

const now = "2026-10-26T12:00:00Z";
const P = (id, post_date, extra = {}) => ({
  id, post_date, sort: 0, lane: "apps", pillar: "Teach", format: "talking_head", title: `Sample post ${id}`,
  hook: "A sample hook for the first frame.", script: "So this is the first beat of a sample script.\n\nAnd this is the second beat.",
  shots: "Film it in one take.\nA1 · Beat 1: direct to camera.\nA2 · Beat 2: over the shoulder.", cover: "A sample cover idea.", cta: "Link in bio",
  checks: ["Confirm the sample claim before posting."], notes_title: `Content Scripts · Sample run › Tue Oct 27 · Sample post ${id}`,
  captions: { instagram: "Sample Instagram caption.\n\n#one #two #three", tiktok: "sample tiktok caption #a #b", linkedin: "Sample LinkedIn caption.", threads: "sample threads caption" },
  status: "planned", notes: "", created_at: now, updated_at: now, ...extra,
});
const POSTS = () => [
  P("p1", "2026-10-27"),
  P("p2", "2026-10-28", { lane: "direction", status: "filmed", title: "A much longer sample title that wraps on small screens" }),
  P("p3", "2026-10-31", { lane: "photo", format: "bts_reel", script: "", notes_title: null, status: "edited", checks: [], title: "<img src=x onerror=window.pwned=1>" }),
  P("p4", "2026-11-02", { status: "posted", captions: { instagram: "Only Instagram here." } }),
];

browser = await chromium.launch();
async function open({ width = 1440, height = 900, posts = POSTS(), admin = true, loadFails = false, signedIn = true, path = "/content.html", refuse = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width, height }, hasTouch: width < 760, isMobile: width < 760 });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  // it's Tue Oct 27, 10 AM in Dallas, and time keeps moving. (Playwright's clock stalls supabase-js, so shift Date instead.)
  await ctx.addInitScript((target) => {
    const Real = Date, delta = target - Real.now();
    class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + delta); } static now() { return Real.now() + delta; } }
    window.Date = Shifted;
  }, Date.parse("2026-10-27T15:00:00Z"));
  if (signedIn) await ctx.addInitScript(() => {
    const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
      user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
    localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
  });
  const log = { patches: [], errors: [] };
  await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
    const req = route.request(), url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.includes("/rpc/bk_is_admin")) return json(admin);
    if (url.includes("/rest/v1/bk_content_posts")) {
      if (req.method() === "GET") return loadFails ? json({ message: "boom" }, 500) : json(posts);
      if (req.method() === "PATCH") {
        const body = JSON.parse(req.postData() || "{}"), id = new URL(url).searchParams.get("id")?.replace("eq.", "");
        log.patches.push({ id, body });
        if (refuse) return json([]);
        const row = posts.find((p) => p.id === id); Object.assign(row, body, { updated_at: new Date().toISOString() });
        return json([row]);
      }
    }
    if (url.includes("/auth/v1/")) return json({});
    return json({});
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) log.errors.push(m.text()); });
  await page.goto(BASE + path);
  return { ctx, page, log };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
const noOverflow = async (page, label) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: sideways scroll`);

/* ---------- desktop ---------- */
{
  const { ctx, page, log } = await open();
  await page.waitForSelector(".cc-row");
  ok((await page.$$(".cc-row")).length === 4, "4 rows");
  // inbox-crm.css gives the sign-in a display, so [hidden] has to win or it sits under the app
  ok(await page.$eval("#loginView", (v) => getComputedStyle(v).display === "none"), "sign-in hidden once signed in");
  ok((await page.textContent("#runLabel")) === "Oct 27–Nov 2", "run label");
  ok((await page.$$eval(".lgroup", (h) => h.map((x) => x.textContent.trim()))).join("|") === "This week Oct 26–Nov 1|Next week Nov 2–8", "week groups");
  ok(await page.$eval('.cc-row[data-id="p1"]', (r) => r.classList.contains("is-today") && r.classList.contains("is-sel")), "today's post opens itself");
  ok((await page.textContent("#pTitle")) === "Sample post p1", "title");
  ok((await page.textContent("#crumb")).includes("Today"), "crumb says today");
  ok((await page.$$eval("#stats .crm-stat b", (b) => b.map((x) => x.textContent))).join(",") === "1,2,1/4", "stats");
  ok((await page.$$("#pScript li")).length === 2, "two beats");
  ok((await page.textContent("#notesWhere")).includes("Content Scripts · Sample run › Tue Oct 27 · Sample post p1"), "Apple Notes pointer");
  ok((await page.textContent("#pFacts")).includes("Film byMonday, Oct 26"), "film-by day");
  ok((await page.$$("#pShots .cc-code")).length === 2, "shot codes");
  ok((await page.$$("#pChecks li")).length === 2, "reminder + check");
  ok(!(await page.evaluate(() => window.pwned)), "no XSS");
  ok(await page.$eval('.cc-row[data-id="p3"] .crow-name', (n) => n.textContent.includes("<img")), "title shown as text");
  await shot(page, "desk-1440");

  // copy the script: spoken lines only, a blank line between beats
  await page.click("#copyScript");
  await page.waitForSelector("#copyScript.is-done");
  ok((await page.evaluate(() => navigator.clipboard.readText())) === "So this is the first beat of a sample script.\n\nAnd this is the second beat.", "script copied clean");

  // captions per platform
  await page.click('#platforms [data-plat="linkedin"]');
  ok((await page.textContent("#pCaption")) === "Sample LinkedIn caption.", "linkedin caption");
  ok((await page.textContent("#capWhen")).includes("Suggested time8:30 AM"), "linkedin weekday time");
  ok(await page.evaluate(() => document.activeElement?.dataset?.plat === "linkedin"), "focus stays on the platform button");
  await page.click("#copyCaption");
  ok((await page.evaluate(() => navigator.clipboard.readText())) === "Sample LinkedIn caption.", "caption copied");

  // status: one tap, saved, chip and stats follow
  await page.click('#statusGroup [data-status="filmed"]');
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("filmed"));
  ok(log.patches.at(-1).id === "p1" && log.patches.at(-1).body.status === "filmed", "status PATCH");
  ok((await page.textContent('.cc-row[data-id="p1"] .st')) === "Filmed", "row chip updated");
  ok((await page.$$eval("#stats .crm-stat b", (b) => b.map((x) => x.textContent))).join(",") === "0,3,1/4", "stats updated");
  ok(await page.evaluate(() => document.activeElement?.dataset?.status === "filmed"), "focus stays on the status button");

  // notes save themselves after a pause, and again when he leaves the box
  await page.fill("#noteBox", "Take 3 was the one.");
  ok((await page.textContent("#noteState")) === "Not saved yet", "dirty note");
  await page.waitForFunction(() => document.querySelector("#noteState").textContent === "Saved", null, { timeout: 5000 });
  ok(log.patches.at(-1).body.notes === "Take 3 was the one.", "note autosaved");
  await page.type("#noteBox", " Then cut it.");
  await page.click('.cc-row[data-id="p2"]'); // leaving the box saves it
  ok((await page.inputValue("#noteBox")) === "", "other post's note empty");
  ok((await page.$eval("#pTitle", (h) => h.classList.contains("long"))), "long title shrinks");
  await page.waitForTimeout(400);
  ok(log.patches.at(-1).body.notes === "Take 3 was the one. Then cut it.", "blur saved the note");
  await page.click('.cc-row[data-id="p1"]');
  ok((await page.inputValue("#noteBox")) === "Take 3 was the one. Then cut it.", "saved note shows");

  // a BTS reel has no script to copy
  await page.click('.cc-row[data-id="p3"]');
  ok(await page.$eval("#scriptFoot", (f) => f.hidden), "no copy for BTS");
  ok((await page.textContent("#pScript")).includes("No script"), "BTS explains itself");
  ok(new URL(page.url()).searchParams.get("p") === "p3", "URL follows the post");

  // a platform with no caption can't be picked
  await page.click('.cc-row[data-id="p4"]');
  ok(await page.$eval('#platforms [data-plat="tiktok"]', (b) => b.disabled), "missing caption disabled");
  ok((await page.textContent("#pCaption")) === "Only Instagram here.", "falls back to a caption that exists");

  // the stats are the status filters; the pills are All + the lanes
  ok((await page.$$eval("#filters button", (b) => b.map((x) => x.dataset.filter))).join(",") === "all,apps,photo,direction", "pills");
  await page.click('#stats [data-filter="film"]');
  ok((await page.$$(".cc-row")).length === 0, "nothing left to film");
  ok((await page.getAttribute('#stats [data-filter="film"]', "aria-pressed")) === "true", "stat shows it's on");
  ok((await page.textContent("#list")).includes("None here"), "filter empty state");
  await page.click('#list [data-filter="all"]');
  ok((await page.$$(".cc-row")).length === 4, "show all");
  await page.click('#stats [data-filter="post"]');
  ok((await page.$$(".cc-row")).length === 3, "stat filters to post");
  await page.click('#stats [data-filter="post"]');
  ok((await page.$$(".cc-row")).length === 4, "tapping the stat again clears it");
  await page.click('#filters [data-filter="photo"]');
  ok((await page.$$(".cc-row")).length === 1, "lane filter");
  await page.click('#filters [data-filter="all"]');

  // j / k
  await page.click('.cc-row[data-id="p1"]');
  await page.keyboard.press("j");
  ok((await page.textContent("#pTitle")).startsWith("A much longer"), "j moves down");
  await page.keyboard.press("k");
  ok((await page.textContent("#pTitle")) === "Sample post p1", "k moves up");

  for (const w of [1512, 1280, 1024, 820]) { await page.setViewportSize({ width: w, height: 860 }); await noOverflow(page, `w${w}`); await shot(page, `desk-${w}`); }
  ok(!log.errors.length, "console errors: " + log.errors.join(" | "));
  await ctx.close();
}

/* ---------- a refused save puts the status back ---------- */
{
  const { ctx, page } = await open({ refuse: true });
  await page.waitForSelector(".cc-row");
  await page.click('#statusGroup [data-status="posted"]');
  await page.waitForFunction(() => document.querySelector("#toast").textContent.startsWith("Didn't save"));
  ok((await page.getAttribute('#statusGroup [data-status="planned"]', "aria-pressed")) === "true", "status reverted to what the database says");
  ok((await page.textContent('.cc-row[data-id="p1"] .st')) === "Planned", "chip reverted");
  await ctx.close();
}

/* ---------- phone ---------- */
{
  const { ctx, page, log } = await open({ width: 390, height: 844 });
  await page.waitForSelector(".cc-row");
  ok(await page.$eval(".work", (w) => getComputedStyle(w).display === "none"), "phone starts on the list");
  await shot(page, "phone-list");
  await page.tap('.cc-row[data-id="p2"]');
  ok(await page.$eval(".lpane", (w) => getComputedStyle(w).display === "none"), "phone shows the post");
  ok(!(await page.$eval("#wbar", (b) => b.hidden)), "back bar");
  await shot(page, "phone-post");
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(150);
  await shot(page, "phone-post-scrolled");
  await noOverflow(page, "phone post");
  const copyH = await page.$eval("#copyScript", (b) => b.getBoundingClientRect().height);
  ok(copyH >= 44, "copy is thumb-sized");
  const statusH = await page.$eval('#statusGroup button', (b) => b.getBoundingClientRect().height);
  ok(statusH >= 44, "status is thumb-sized");
  await page.tap("#backBtn");
  await page.waitForFunction(() => document.querySelector("#calView").dataset.pane === "list");
  ok(!new URL(page.url()).searchParams.get("p"), "back returns to the list");
  await page.setViewportSize({ width: 360, height: 740 });
  await noOverflow(page, "phone 360 list");
  ok(!log.errors.length, "phone console errors: " + log.errors.join(" | "));
  await ctx.close();
}
{
  const { ctx, page } = await open({ width: 390, height: 844, path: "/content.html?p=p3" });
  await page.waitForSelector(".cc-row", { state: "attached" }); // the list is hidden behind the open post
  await page.waitForFunction(() => document.querySelector("#calView").dataset.pane === "work");
  ok((await page.textContent("#pTitle")).includes("<img"), "deep link opens the post on a phone");
  await page.tap("#backBtn");
  await page.waitForFunction(() => document.querySelector("#calView").dataset.pane === "list");
  ok(!new URL(page.url()).searchParams.get("p"), "closing a linked post clears it from the URL");
  await page.tap('.cc-row[data-id="p1"]');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector("#calView").dataset.pane === "list");
  ok(true, "phone Back from a post returns to the list, not the linked post");
  await ctx.close();
}

/* ---------- empty, not admin, load error, signed out ---------- */
{
  const { ctx, page } = await open({ posts: [] });
  await page.waitForFunction(() => document.querySelector("#list").textContent.includes("Nothing planned yet"));
  ok((await page.textContent("#workEmpty")).includes("Nothing planned yet"), "empty work surface");
  ok((await page.textContent("#stats")) === "", "no stats when empty");
  await shot(page, "empty");
  await ctx.close();
}
{
  const { ctx, page } = await open({ posts: [], admin: false });
  await page.waitForFunction(() => document.querySelector("#list").textContent.includes("not as admin"));
  passed++;
  await ctx.close();
}
{
  const { ctx, page } = await open({ loadFails: true });
  await page.waitForSelector("#retryBtn");
  ok((await page.textContent("#list")).includes("Couldn't load"), "load error");
  await ctx.close();
}
{
  const { ctx, page } = await open({ signedIn: false });
  await page.waitForSelector("#loginView:not([hidden])");
  ok(await page.$eval("#topBar", (b) => b.hidden), "signed out sees only sign-in");
  await shot(page, "login");
  await ctx.close();
}

await browser.close(); srv.kill();
console.log(`content.e2e: ${passed} checks passed`);
