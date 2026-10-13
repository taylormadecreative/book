// Stubbed UI test for the admin proofing picks view. Serves the repo locally; every Supabase call is intercepted — never touches prod.
// Run: node tests/admin-picks.e2e.mjs
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", "18741"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser;
const fail = async (m) => { console.error("FAIL:", m); try { await browser?.close(); } catch (_) {} srv.kill(); process.exit(1); };

const PID = "4610c6e8-1d05-4da1-a23d-a917ad51d7db", GID = "58480024-3d4a-4880-97d2-ac82a77a9143";
const EVIL = "<img src=x onerror=window.pwned=1>.jpg";
const now = new Date().toISOString();
// 411 proofs like the H+S gallery; picks are scattered and inserted out of order so the list must sort by frame
const PICKED = [402, 7, 150, 151, 33, 260, 300, 88, 377, 199];
const items = Array.from({ length: 411 }, (_, i) => {
  const name = i === 199 ? EVIL : i === 88 ? "Hoodies and stripes vanderbilt shoot6123 1.jpg" : `DSC0${4000 + i}.jpg`;
  return { id: `item-${i}`, gallery_id: GID, project_id: PID, storage_path: `${PID}/${GID}/0f8fad5b-d9cb-469f-a165-70867728950e-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    filename: name, content_type: "image/jpeg", size_bytes: 180000, sort: i + 1, created_at: now, selected: PICKED.includes(i) };
});
const proj = (id, title, galleries) => ({ id, title, client_name: "Buck", client_email: "n@x.com", client_phone: null, company: "Hoodies+Stripes",
  service: "photography", status: "in_production", event_date: "2026-10-04", event_time: null, location: null, budget_range: null, details: "",
  notes_internal: "", access_token: "tok", created_at: now, updated_at: now,
  bk_invoices: [], bk_messages: [], bk_files: [], bk_galleries: galleries });
const PROJECTS = [
  proj(PID, "Hoodies+Stripes — Vanderbilt Collection Shoot", [
    { id: GID, project_id: PID, kind: "proof", title: "Vanderbilt Collection — Oct 4", selection_limit: 10, locked: true, created_at: now, bk_gallery_items: items },
    { id: "g-final", project_id: PID, kind: "final", title: "Edited photos", selection_limit: null, locked: false, created_at: "2026-10-12T00:00:00Z",
      bk_gallery_items: [{ id: "f1", gallery_id: "g-final", project_id: PID, storage_path: `${PID}/g-final/x-EDIT1.jpg`, filename: "EDIT1.jpg", sort: 1, created_at: now, selected: false }] },
  ]),
  proj("p-none", "No picks yet", [
    { id: "g-open", project_id: "p-none", kind: "proof", title: "Open proofs", selection_limit: 10, locked: false, created_at: now,
      bk_gallery_items: items.slice(0, 12).map((it, i) => ({ ...it, id: `n-${i}`, gallery_id: "g-open", project_id: "p-none", selected: false })) },
  ]),
];

// a 2:3 portrait stand-in for each proof
const SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#3a5f8a"/><text x="20" y="60" font-size="28" fill="#fff">${label}</text></svg>`;
const imgHits = new Set();

browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:18741" });
await ctx.addInitScript(() => {
  const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
    user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
  localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
});
await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
  const req = route.request(), url = req.url();
  const ok = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/fake-img/")) {
    imgHits.add(decodeURIComponent(url.split("/fake-img/")[1].split("?")[0]));
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG(url.split("-").pop().slice(0, 20)) });
  }
  if (url.includes("/rest/v1/bk_projects")) return ok(PROJECTS);
  if (url.includes("/rest/v1/bk_contracts")) return ok([]);
  if (/\/storage\/v1\/object\/sign\/project-media$/.test(url.split("?")[0])) { // batch sign
    const { paths } = JSON.parse(req.postData() || "{}");
    return ok(paths.map((path) => ({ path, signedURL: `/fake-img/${encodeURIComponent(path)}?token=x`, error: null })));
  }
  if (url.includes("/storage/v1/object/sign/project-media/")) { // single sign (full size)
    const path = decodeURIComponent(url.split("/object/sign/project-media/")[1].split("?")[0]);
    return ok({ signedURL: `/object/sign/project-media/${encodeURIComponent(path)}?token=full` });
  }
  if (url.includes("/auth/v1/")) return ok({ id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" });
  return ok([]);
});
// supabase-js prefixes signed URLs with the storage base: send /storage/v1/fake-img/… back through the stub
await ctx.route("**/storage/v1/fake-img/**", (route) => {
  const url = route.request().url();
  imgHits.add(decodeURIComponent(url.split("/fake-img/")[1].split("?")[0]));
  return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG(decodeURIComponent(url).split("-").pop().slice(0, 18)) });
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:18741/admin.html");
await page.waitForSelector(`.prow[data-id="${PID}"]`, { timeout: 10000 }).catch(() => fail("project list never rendered"));
await page.click(`.prow[data-id="${PID}"]`);
await page.waitForSelector(".ga-picks", { timeout: 8000 }).catch(() => fail("no picks section on a gallery with picks"));
if (await page.evaluate(() => window.pwned)) await fail("a file name executed as HTML");

// 1. names list: 10, frame order, no .jpg
const names = await page.$$eval(".ga-names li", (els) => els.map((e) => e.textContent));
const want = PICKED.slice().sort((a, b) => a - b).map((i) => items[i].filename.replace(/\.[^.]+$/, ""));
if (JSON.stringify(names) !== JSON.stringify(want)) await fail(`names list wrong:\n${names.join("\n")}\nwanted\n${want.join("\n")}`);
if (names.some((n) => /\.jpg$/i.test(n))) await fail("names still end in .jpg");
if ((await page.textContent(".ga-picks-head b")) !== "10") await fail("pick count header wrong");

// 2. picks gallery: exactly the 10 picks, loaded, uncropped portrait
await page.waitForFunction(() => [...document.querySelectorAll(".ga-pick img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 })
  .catch(() => fail("pick photos never loaded"));
const pickBoxes = await page.$$eval(".ga-pick img", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }));
if (pickBoxes.length !== 10) await fail(`expected 10 pick photos, got ${pickBoxes.length}`);
if (pickBoxes.some(([w, h]) => h / w < 1.4)) await fail(`pick photos are cropped, not 2:3: ${JSON.stringify(pickBoxes[0])}`);
const caps = await page.$$eval(".ga-pick figcaption", (els) => els.map((e) => e.textContent));
if (JSON.stringify(caps) !== JSON.stringify(want)) await fail("captions don't match the names list");

// 3. full set folded away, and its 401 other photos NOT downloaded while folded
const all = page.locator(`details.ga-all[data-galall="${GID}"]`);
if (await all.evaluate((d) => d.open)) await fail("full set should start folded");
if (!(await all.locator("summary").textContent()).includes("All 411 proofs")) await fail("summary label wrong");
await page.waitForTimeout(800);
const unpickedLoaded = [...imgHits].map((p) => decodeURIComponent(p)).filter((p) => p.includes(GID)).filter((p) => !items.some((it) => it.selected && p.includes(it.storage_path.split("/").pop())));
if (unpickedLoaded.length) await fail(`${unpickedLoaded.length} unpicked photos downloaded while the full set was folded`);
await page.screenshot({ path: "/tmp/admin-picks-desktop.png", fullPage: false });
await page.locator(".ga-picks").screenshot({ path: "/tmp/admin-picks-section.png" });

// 4. open the full set → grid shows with picks ringed; survives the 15s re-render; closing survives too
await all.locator("summary").click();
await page.waitForFunction(() => document.querySelectorAll(".ga-all .ga-cell").length === 411, null, { timeout: 5000 }).catch(() => fail("full grid missing after opening"));
if ((await page.locator(".ga-all .ga-cell.sel").count()) !== 10) await fail("full grid doesn't ring the 10 picks");
await page.locator(".ga-all .ga-cell").first().scrollIntoViewIfNeeded();
await page.waitForFunction(() => { const i = document.querySelector(".ga-all .ga-cell img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 })
  .catch(() => fail("full-grid photos don't load once opened"));
await page.evaluate(() => load());
await page.waitForTimeout(400);
if (!(await page.locator(`details.ga-all[data-galall="${GID}"]`).evaluate((d) => d.open))) await fail("re-render snapped the opened full set shut");
await page.locator(`details.ga-all[data-galall="${GID}"] summary`).click();
await page.evaluate(() => load());
await page.waitForTimeout(400);
if (await page.locator(`details.ga-all[data-galall="${GID}"]`).evaluate((d) => d.open)) await fail("re-render re-opened a closed full set");

// 5. Copy picks → names without .jpg
await page.click(`[data-copypicks="${GID}"]`);
const clip = await page.evaluate(() => navigator.clipboard.readText());
if (clip !== want.join("\n")) await fail(`clipboard wrong:\n${clip}`);

// 6. clicking a pick opens the full-size proof in a new tab (not the thumb)
const [tab] = await Promise.all([ctx.waitForEvent("page"), page.locator(".ga-pick").first().click()]);
await tab.waitForURL(/token=full/, { timeout: 5000 }).catch(() => fail(`new tab didn't land on the full-size URL: ${tab.url()}`));
if (!decodeURIComponent(decodeURIComponent(tab.url())).includes(items[7].storage_path)) await fail(`opened the wrong photo: ${tab.url()}`);
await tab.close();

// 7. other galleries unchanged: the final gallery has no picks block or fold
if (await page.locator('details[data-galall="g-final"]').count()) await fail("final gallery got folded");
if ((await page.locator(".ga-picks").count()) !== 1) await fail("picks block showed on a non-picked gallery");

// 8. a proofing gallery with no picks yet looks like before: plain grid, no fold
await page.click('.prow[data-id="p-none"]');
await page.waitForTimeout(500);
if (await page.locator(".ga-picks, details.ga-all").count()) await fail("no-picks gallery shows a picks block or fold");
if ((await page.locator(".ga-grid .ga-cell").count()) !== 12) await fail("no-picks gallery grid missing");

// 9. phone width: no sideways scroll, names stay readable
await page.setViewportSize({ width: 390, height: 844 });
await page.click(`.prow[data-id="${PID}"]`);
await page.waitForSelector(".ga-picks");
if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) await fail("admin scrolls sideways at phone width");
await page.locator(".ga-picks").scrollIntoViewIfNeeded();
await page.locator(".ga-picks").screenshot({ path: "/tmp/admin-picks-phone.png" });

if (errors.length) await fail(`page errors: ${errors.join(" | ")}`);
console.log("PASS admin picks: names list (10, frame order, no .jpg), picks-only gallery (uncropped), full set folded + lazy, fold survives re-render, Copy picks, full-size tab, other galleries unchanged, phone width");
await browser.close();
srv.kill();
