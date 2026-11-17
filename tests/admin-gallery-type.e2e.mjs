// Client, project and file details in this fixture are synthetic.
// Stubbed UI test for choosing a gallery type in admin. Serves the repo locally; every Supabase call is intercepted — never touches prod.
// Why: proofs and finished edits looked alike in admin but behave opposite in the client's portal (a set of
// proofs went up as edited photos, so the client could download everything and pick nothing).
// Run: node tests/admin-gallery-type.e2e.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const srv = spawn("python3", ["-m", "http.server", "18743"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser, passed = 0, total = 0;
const ok = (c, m) => { total++; if (c) passed++; else console.error("FAIL:", m); };
const done = async () => { console.log(`${passed}/${total} checks passed`); try { await browser?.close(); } catch (_) {} srv.kill(); process.exit(passed === total ? 0 : 1); };

const now = new Date().toISOString();
const PID = "00000000-0000-4000-8000-0000000000a1";
const item = (gid, i, selected = false) => ({ id: `${gid}-i${i}`, gallery_id: gid, project_id: PID, storage_path: `${PID}/${gid}/x-SYN${1000 + i}.jpg`,
  filename: `SYN${1000 + i}.jpg`, content_type: "image/jpeg", size_bytes: 1000, sort: i + 1, created_at: now, selected });
const GALS = [
  { id: "g-final", project_id: PID, kind: "final", title: "Synthetic birthday set", selection_limit: null, locked: false, created_at: "2026-11-01T00:00:00Z",
    bk_gallery_items: [0, 1, 2].map((i) => item("g-final", i)) },
  { id: "g-open", project_id: PID, kind: "proof", title: "Open proofs", selection_limit: 5, locked: false, created_at: "2026-11-02T00:00:00Z",
    bk_gallery_items: [0, 1].map((i) => item("g-open", i)) },
  { id: "g-picked", project_id: PID, kind: "proof", title: "Proofs with picks", selection_limit: 3, locked: false, created_at: "2026-11-03T00:00:00Z",
    bk_gallery_items: [0, 1].map((i) => item("g-picked", i, i === 0)) },
];
const PROJECTS = [{ id: PID, title: "Synthetic Client — Birthday", client_name: "Synthetic Client", client_email: "client@example.test", client_phone: null,
  company: null, service: "photography", status: "booked", event_date: "2026-11-15", event_time: null, location: null, budget_range: null, details: "",
  notes_internal: "", access_token: "tok", created_at: now, updated_at: now, bk_invoices: [], bk_messages: [], bk_files: [], bk_galleries: GALS },
  { id: "p-other", title: "Another client", client_name: "Other Client", client_email: "o@example.test", client_phone: null, company: null, service: "photography",
    status: "booked", event_date: null, event_time: null, location: null, budget_range: null, details: "", notes_internal: "", access_token: "t2",
    created_at: now, updated_at: now, bk_invoices: [], bk_messages: [], bk_files: [], bk_galleries: [] }];

const inserts = [], patches = [];
browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
    user: { id: "u1", email: "staff@example.test", aud: "authenticated", role: "authenticated" } };
  localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
});
await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
  const req = route.request(), url = req.url();
  const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/rest/v1/bk_galleries")) {
    if (req.method() === "POST") { inserts.push(JSON.parse(req.postData())); return json([]); }
    if (req.method() === "PATCH") {
      const id = new URL(url).searchParams.get("id").replace(/^eq\./, "");
      const body = JSON.parse(req.postData());
      patches.push({ id, body, filters: [...new URL(url).searchParams.entries()] });
      const g = GALS.find((x) => x.id === id);
      Object.assign(g, body); // the next load shows the change
      return json([{ id }]);
    }
  }
  if (url.includes("/rest/v1/bk_projects")) return json(PROJECTS);
  if (/\/storage\/v1\/object\/sign\/project-media$/.test(url.split("?")[0])) {
    const { paths } = JSON.parse(req.postData() || "{}");
    return json(paths.map((path) => ({ path, signedURL: "/fake-img/x.svg?token=x", error: null })));
  }
  if (url.includes("/auth/v1/")) return json({ id: "u1", email: "staff@example.test", aud: "authenticated", role: "authenticated" });
  return json([]);
});
await ctx.route("**/storage/v1/fake-img/**", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="6"/>` }));

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:18743/admin.html");
await page.waitForSelector(`.prow[data-id="${PID}"]`, { timeout: 10000 });
await page.click(`.prow[data-id="${PID}"]`);
await page.waitForSelector(".ga-types", { timeout: 8000 });
const card = (gid) => page.locator(".ga", { has: page.locator(`[data-galdel="${gid}"]`) });

// 1. each gallery says what the client can do, in plain words
ok((await card("g-final").locator(".ga-head .hud").textContent()) === "Finished edits", "final labeled Finished edits");
ok(/She downloads these\. No picking\./.test(await card("g-final").locator(".ga-says").textContent()), "final says she downloads, can't pick");
ok(/She picks up to 5\. No downloads\./.test(await card("g-open").locator(".ga-says").textContent()), "open proofs say pick up to 5, no downloads");
ok((await card("g-open").locator(".ga-head .hud").textContent()) === "Proofs to pick from", "proof labeled Proofs to pick from");

// 2. new gallery: nothing pre-chosen, button waits for a choice
ok(!(await page.locator('input[name="galKind"]:checked').count()), "no type is pre-chosen");
ok(await page.isDisabled("#galCreate"), "create waits for a choice");
ok((await page.textContent("#galCreate")) === "Choose what it's for", "button asks for the choice");
ok(await page.isHidden("#galLimit"), "pick limit hidden until proofs");
await page.check('input[name="galKind"][value="proof"]');
ok(await page.isVisible("#galLimit"), "pick limit shows for proofs");
ok((await page.textContent("#galCreate")) === "Create proofs gallery", "button names the type");
await page.check('input[name="galKind"][value="final"]');
ok(await page.isHidden("#galLimit"), "pick limit hides for finished edits");
ok((await page.textContent("#galCreate")) === "Create finished edits gallery", "button follows the choice");

if (process.env.SHOT) { await page.check('input[name="galKind"][value="proof"]'); await page.locator(".ga-card").screenshot({ path: process.env.SHOT + "/ga-desktop.png" }); }
// 3. the choice survives the 15s re-render while typing, then resets after create
await page.check('input[name="galKind"][value="proof"]');
await page.fill("#galTitle", "Birthday proofs");
await page.fill("#galLimit", "5");
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
await page.waitForTimeout(16500); // one poll
ok((await page.locator('input[name="galKind"]:checked').getAttribute("value")) === "proof", "choice survives a re-render");
await page.click("#galCreate");
await page.waitForTimeout(500);
ok(inserts.length === 1 && inserts[0].kind === "proof" && inserts[0].selection_limit === 5 && inserts[0].title === "Birthday proofs", "creates proofs with the limit: " + JSON.stringify(inserts[0]));
ok(/She can pick, not download/.test(await page.textContent("#toast")), "toast says what she can do");
ok(!(await page.locator('input[name="galKind"]:checked').count()) && await page.isDisabled("#galCreate"), "next gallery starts unchosen again");

// 4. a choice never follows him to another client
await page.check('input[name="galKind"][value="final"]');
await page.click('.prow[data-id="p-other"]');
await page.waitForSelector(".ga-types");
ok(!(await page.locator('input[name="galKind"]:checked').count()), "another client's form starts unchosen");
await page.click(`.prow[data-id="${PID}"]`);
await page.waitForSelector(".ga-types");

// 5. switch a finished-edits set to proofs: two taps, guarded write
const sw = card("g-final").locator("[data-galswitch]");
ok((await sw.textContent()) === "Make these proofs to pick from", "final offers switch to proofs");
await sw.click();
ok(/Tap again/.test(await sw.textContent()) && patches.length === 0, "first tap only arms it");
await sw.click();
await page.waitForTimeout(600);
const p1 = patches.find((x) => x.id === "g-final");
ok(p1 && p1.body.kind === "proof" && p1.filters.some(([k, v]) => k === "kind" && v === "eq.final"), "switch writes kind=proof, guarded on kind=final: " + JSON.stringify(p1));
ok(/She picks as many as she wants\. No downloads\./.test(await card("g-final").locator(".ga-says").textContent()), "now reads as proofs");

// 6. pick limit edits in place
await card("g-final").locator("[data-gallimit]").fill("5");
await card("g-final").locator("[data-gallimit]").press("Enter");
await page.waitForTimeout(600);
ok(patches.some((x) => x.id === "g-final" && x.body.selection_limit === 5), "limit saved");
{ const t = await card("g-final").locator(".ga-says").textContent(); ok(/She picks up to 5\./.test(t), "header shows the new limit: " + t + " " + JSON.stringify(patches.filter((x) => x.id === "g-final").map((x) => x.body))); }

// 7. proofs she's already picked from can't flip (her picks would vanish from her portal)
ok(!(await card("g-picked").locator("[data-galswitch]").count()), "no switch once she has picks");
ok((await card("g-open").locator("[data-galswitch]").textContent()) === "Make these finished edits", "unpicked proofs can switch to edits");

// 8. phone width: chooser stacks, nothing overflows
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const over = await page.evaluate(() => [...document.querySelectorAll(".ga-type, .ga-new-row > *")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 1));
ok(!over, "nothing overflows at phone width");
if (process.env.SHOT) await page.locator(".ga-card").screenshot({ path: process.env.SHOT + "/ga-phone.png" });

ok(!errors.length, "no page errors: " + errors.join(" | "));
await done();
