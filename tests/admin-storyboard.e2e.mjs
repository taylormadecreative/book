// Stubbed UI test for storyboards in admin: a draft the client can't see, Send to client, the deposit
// link approving leads to, client notes, Reopen only on the latest round. Every Supabase call is intercepted.
// Run: node tests/admin-storyboard.e2e.mjs
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", "18742"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser, failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };

const PID = "b4c7708b-ea4d-433f-9349-44728eccb801";
const now = new Date().toISOString();
const frames = (gid, n, notes = {}) => Array.from({ length: n }, (_, i) => {
  const code = `${Math.floor(i / 3) + 1}${"ABC"[i % 3]}`;
  return { id: `${gid}-${i}`, gallery_id: gid, project_id: PID, storage_path: `${PID}/${gid}/x-frame-${code}.jpg`, filename: `frame-${code}.jpg`,
    content_type: "image/jpeg", size_bytes: 300000, sort: i + 1, created_at: now, selected: false,
    meta: { code, tc: `0:0${i % 10}–0:1${i % 10}` }, client_note: notes[code] || null };
});
const gal = (id, extra) => ({ id, project_id: PID, kind: "storyboard", title: "Hide & Haunt storyboard", selection_limit: null, locked: false,
  review_outcome: null, reviewed_at: null, pay_url: null, created_at: now, bk_gallery_items: [], ...extra });
let GALS = [
  gal("g-v1", { title: "Hide & Haunt storyboard v1", locked: true, review_outcome: "changes", reviewed_at: now, created_at: "2026-10-26T10:00:00Z",
    bk_gallery_items: frames("g-v1", 6, { "1C": "Make him look right at the camera.", "2B": "<b>bolder</b> mask" }) }),
  gal("g-v2", { title: "Hide & Haunt storyboard v2", locked: true, created_at: "2026-10-27T10:00:00Z", bk_gallery_items: frames("g-v2", 6) }),
];
const PROJECTS = () => [{ id: PID, title: "Delilah Amaro — Hide & Haunt Commercial", client_name: "Delilah Amaro", client_email: "d@x.com", client_phone: null,
  company: null, service: "other", status: "booked", event_date: null, event_time: null, location: null, budget_range: null, details: "",
  notes_internal: "", access_token: "tok", created_at: now, updated_at: now, bk_invoices: [], bk_messages: [], bk_files: [], bk_galleries: GALS }];
const patches = [], inserts = [];

browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
    user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
  localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
});
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#3a3f47"/></svg>`;
await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
  const req = route.request(), url = req.url();
  const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/rest/v1/bk_projects")) return json(PROJECTS());
  if (url.includes("/rest/v1/bk_galleries") && req.method() === "PATCH") {
    const id = /id=eq\.([^&]+)/.exec(url)[1], body = JSON.parse(req.postData());
    patches.push({ id, body });
    GALS = GALS.map((g) => (g.id === id ? { ...g, ...body } : g));
    return json([]);
  }
  if (url.includes("/rest/v1/bk_galleries") && req.method() === "POST") {
    const body = JSON.parse(req.postData());
    inserts.push(body);
    return json([]);
  }
  if (url.includes("/rest/v1/bk_contracts")) return json([]);
  if (/\/storage\/v1\/object\/sign\/project-media$/.test(url.split("?")[0])) {
    const { paths } = JSON.parse(req.postData() || "{}");
    return json(paths.map((path) => ({ path, signedURL: `/fake-img/${encodeURIComponent(path)}?token=x`, error: null })));
  }
  if (url.includes("/auth/v1/")) return json({ id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" });
  return json([]);
});
await ctx.route("**/storage/v1/fake-img/**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }));

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const card = (gid) => page.locator(".ga", { has: page.locator(`[data-payurl="${gid}"]`) });
try {
  await page.goto("http://localhost:18742/admin.html");
  await page.waitForSelector(`.prow[data-id="${PID}"]`, { timeout: 10000 });
  await page.click(`.prow[data-id="${PID}"]`);
  await page.waitForSelector("[data-payurl]");
  ok(await page.evaluate(() => !window.pwned) && !(await page.locator(".ga-notes b b").count()), "a client note shows as text, not HTML");

  // v1: reviewed, notes listed by frame; v2 is still a draft, so v1 is the latest round the client can see
  ok(/2 changes sent/.test(await card("g-v1").locator(".pill").textContent()), "v1 pill counts the changes sent");
  const notes = await card("g-v1").locator(".ga-notes li").allInnerTexts();
  ok(notes.length === 2 && notes[0].startsWith("1C · ") && notes[0].includes("Make him look right at the camera."), "client notes list by frame: " + JSON.stringify(notes));
  ok((await card("g-v1").locator("[data-lock]").textContent()) === "Reopen for review", "v1 (latest live round) can reopen");

  // v2: a draft
  ok(/Draft · 6 frames · client can't see it/.test(await card("g-v2").locator(".pill").textContent()), "v2 shows as a draft");
  ok((await card("g-v2").locator("[data-lock]").textContent()) === "Send to client", "a draft offers Send to client");
  await page.locator(".ga").first().screenshot({ path: "/private/tmp/claude-501/-Users-nelsontaylor/67f392f8-6a23-41d6-9dab-7fce3fea8741/scratchpad/sbshots/admin-v1.png" }).catch(() => {});

  // deposit link: refused unless https, saved when it is
  const inp = page.locator('[data-payurl="g-v2"]');
  await inp.fill("honeybook.com/invoice");
  await inp.press("Tab");
  await page.waitForTimeout(200);
  ok(!patches.some((p) => p.body.pay_url !== undefined), "a link without https:// isn't saved");
  ok(/Paste the full https:\/\/ link/.test(await page.textContent("#toast")), "and Nelson is told");
  await inp.fill("https://taylormadecreative.hbportal.co/app/invoice/abc123");
  await inp.press("Tab");
  await page.waitForTimeout(300);
  ok(patches.some((p) => p.id === "g-v2" && p.body.pay_url === "https://taylormadecreative.hbportal.co/app/invoice/abc123"), "deposit link saved on the storyboard");

  // Send to client: opens the draft, clears any review, says no message went out
  await card("g-v2").locator("[data-lock]").click();
  await page.waitForTimeout(400);
  const sent = patches.find((p) => p.id === "g-v2" && p.body.locked === false);
  ok(sent && sent.body.review_outcome === null && sent.body.reviewed_at === null, "Send to client unlocks it fresh");
  ok(/live in the client's portal\. No message was sent\./.test(await page.textContent("body")), "toast says no message went out");
  ok(/6 frames · waiting on client/.test(await card("g-v2").locator(".pill").textContent()), "v2 now waits on the client");
  ok(!(await card("g-v1").locator("[data-lock]").count()), "v1 no longer offers Reopen (v2 is the current round)");
  ok((await page.inputValue('[data-payurl="g-v2"]')) === "https://taylormadecreative.hbportal.co/app/invoice/abc123", "deposit link shows after the refresh");

  // a new storyboard starts as a draft
  await page.selectOption("#galKind", "storyboard");
  await page.fill("#galTitle", "Hide & Haunt storyboard v3");
  await page.click("#galCreate");
  await page.waitForTimeout(400);
  ok(inserts.length === 1 && inserts[0].kind === "storyboard" && inserts[0].locked === true, "a new storyboard is created as a draft");

  // phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll at phone width");
  ok(!errors.length, "no page errors: " + errors.join(" | "));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  srv.kill();
  console.log(`${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}
