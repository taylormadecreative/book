// Stubbed UI test for the admin Close preview / Reopen preview button on a held video. Serves the repo
// locally; every Supabase call is intercepted, so it never touches prod.
// Run: node tests/admin-video-preview.e2e.mjs
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18744;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
let browser, failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };

const PID = "b4c7708b-0000-4000-8000-000000000001", GID = "590580de-0000-4000-8000-000000000002", INV = "2b356fa5-0000-4000-8000-000000000003";
const now = new Date().toISOString();
const gal = { id: GID, project_id: PID, kind: "video", title: "Hide & Haunt commercial", selection_limit: null, locked: false, created_at: now,
  unlock_invoice_id: INV, preview_closed_at: null,
  bk_gallery_items: [{ id: "v1", gallery_id: GID, project_id: PID, storage_path: `${PID}/${GID}/x-hide-and-haunt-commercial.mp4`, filename: "Hide & Haunt Commercial.mp4", sort: 1, created_at: now, selected: false }] };
const inv = { id: INV, project_id: PID, title: "Final balance", kind: "custom", status: "sent", amount_cents: 75000, line_items: [], created_at: now };
const project = { id: PID, title: "Delilah Amaro — Hide & Haunt Commercial", client_name: "Delilah Amaro", client_email: "d@x.test", client_phone: null, company: null,
  service: "other", status: "in_production", event_date: null, event_time: null, location: null, budget_range: null, details: "",
  notes_internal: "", access_token: "tok", created_at: now, updated_at: now, bk_invoices: [inv], bk_messages: [], bk_files: [], bk_galleries: [gal] };
const patches = [];
let refuse = false; // the database quietly refuses the write (no row back)

try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const s = { access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer",
      user: { id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" } };
    localStorage.setItem("sb-pgqdmnmessbbzyszjfvr-auth-token", JSON.stringify(s));
  });
  await ctx.route("**/pgqdmnmessbbzyszjfvr.supabase.co/**", async (route) => {
    const req = route.request(), url = req.url();
    const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (url.includes("/rest/v1/bk_galleries") && req.method() === "PATCH") {
      const body = JSON.parse(req.postData() || "{}");
      patches.push({ url, body });
      if (refuse) return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      if ("preview_closed_at" in body) gal.preview_closed_at = body.preview_closed_at;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: GID }]) });
    }
    if (url.includes("/rest/v1/bk_projects")) return json([project]);
    if (url.includes("/auth/v1/")) return json({ id: "u1", email: "n@x.com", aud: "authenticated", role: "authenticated" });
    return json([]);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dialogs = [];
  let answer = true;
  page.on("dialog", (d) => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
  await page.goto(`http://127.0.0.1:${PORT}/admin.html`);
  await page.waitForSelector(`.prow[data-id="${PID}"]`, { timeout: 10000 });
  await page.click(`.prow[data-id="${PID}"]`);
  await page.waitForSelector("[data-preview]", { timeout: 8000 }).catch(() => {});
  const pill = async () => (await page.locator(".ga-meta .pill.gold, .ga-meta .pill.green").last().textContent()).trim();
  const btn = page.locator(`[data-preview="${GID}"]`);

  // open preview: the button offers to close it
  ok((await pill()) === "Preview only until Final balance is paid", "open: pill says preview only: " + await pill());
  ok((await btn.textContent()).trim() === "Stop client preview", "open: button offers Stop client preview");
  ok(/until it's paid/.test(await btn.getAttribute("title")), "open: button explains itself on hover");

  // cancel the confirm: nothing is written
  answer = false;
  await btn.click();
  await page.waitForTimeout(300);
  ok(dialogs.length === 1 && /blurred still/.test(dialogs[0]) && patches.length === 0, "stop asks first; cancel writes nothing");
  answer = true;

  // the database refuses quietly: no success toast, nothing changes
  refuse = true;
  await btn.click();
  await page.waitForTimeout(500);
  ok(/Couldn't change that/.test(await page.locator("#toast, .toast").first().textContent().catch(() => "")), "a refused write says it failed: " + await page.locator("#toast, .toast").first().textContent().catch(() => ""));
  ok((await btn.textContent()).trim() === "Stop client preview", "a refused write leaves the button as it was");
  patches.length = 0;
  refuse = false;

  // stop it
  await btn.click();
  await page.waitForFunction(() => document.querySelector("[data-preview]")?.textContent.trim() === "Let client watch again", null, { timeout: 5000 }).catch(() => {});
  const p1 = patches.pop();
  ok(p1 && p1.url.includes(`id=eq.${GID}`) && typeof p1.body.preview_closed_at === "string" && !Number.isNaN(Date.parse(p1.body.preview_closed_at)) && Object.keys(p1.body).length === 1,
    "close: writes only preview_closed_at = now on that gallery: " + JSON.stringify(p1));
  ok(/^Preview stopped [A-Z][a-z]{2} \d{1,2}, \d{4} until Final balance is paid$/.test(await pill()), "stopped: pill says when: " + await pill());
  ok((await btn.textContent()).trim() === "Let client watch again", "stopped: button offers to let the client watch again");
  ok(/Preview stopped/.test(await page.locator("#toast, .toast").first().textContent().catch(() => "")), "stop: toast confirms");

  // let her watch again (no confirm needed to give access back)
  const before = dialogs.length;
  await btn.click();
  await page.waitForFunction(() => document.querySelector("[data-preview]")?.textContent.trim() === "Stop client preview", null, { timeout: 5000 }).catch(() => {});
  ok(dialogs.length === before, "watching again doesn't ask");
  const p2 = patches.pop();
  ok(p2 && p2.body.preview_closed_at === null, "reopen: clears preview_closed_at: " + JSON.stringify(p2));
  ok((await pill()) === "Preview only until Final balance is paid", "reopened: pill back to preview only");

  // paid: nothing to close any more
  inv.status = "paid";
  await page.reload();
  await page.waitForSelector(`.prow[data-id="${PID}"]`, { timeout: 10000 });
  await page.click(`.prow[data-id="${PID}"]`);
  await page.waitForSelector(".ga-meta .pill.green", { timeout: 8000 }).catch(() => {});
  ok((await page.locator("[data-preview]").count()) === 0, "paid: no Close preview button");
  ok((await page.locator(".ga-meta .pill.green").textContent()).trim() === "Paid · client can download", "paid: green pill");
  ok(errors.length === 0, "no page errors: " + errors.join(" | "));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  try { await browser?.close(); } catch (_) {}
  srv.kill();
}
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
