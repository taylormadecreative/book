// Stubbed UI test for a video held until its balance is paid (portal.html). Serves the repo locally;
// every Supabase call is intercepted, so it never touches prod.
// Run: node tests/video-unlock.e2e.mjs
//   PORTAL_SHOTS=<dir>        save screenshots (held + unlocked, desktop + phone) using installed Chrome
//   PORTAL_VIDEO_PREVIEW=<f>  serve a real preview mp4 (and PORTAL_VIDEO_CLEAN=<f> the original) for those shots
import { chromium, webkit } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18743;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const SHOTS = process.env.PORTAL_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let browser, failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };
const done = async () => { try { await browser?.close(); } catch (_) {} srv.kill(); };

/* ---------------- fixtures ---------------- */
const NAME = "Delilah Amaro";
const S = {
  held: () => ({ file: "Hide & Haunt Commercial.mp4" }),
  slow: () => ({ file: "Hide & Haunt Commercial.mp4", slow: true }),
  nopreview: () => ({ file: "Hide & Haunt Commercial.mp4", noPreview: true }),
  evil: () => ({ file: "<img src=x onerror=window.pwned=1>.mp4" }),
};
const state = {};
const get = (pid) => {
  if (state[pid]) return state[pid];
  const key = pid.slice(2);
  if (!S[key]) return null;
  const f = S[key]();
  return (state[pid] = {
    ...f,
    p: { id: pid, title: `${NAME} — Hide & Haunt Commercial`, status: "booked", service: "other", location: null,
      created_at: "2026-10-22T18:00:00Z", event_date: null, event_time: null, client_name: NAME },
    inv: [{ id: `inv-${key}`, kind: "balance", title: "Final balance", status: "sent", due_date: null, amount_cents: 75000, line_items: [] }],
    msgs: [{ id: "m1", sender: "studio", created_at: "2026-10-29T22:00:00Z", body: "Your Hide & Haunt commercial is up." }],
  });
};
// what bk-media sends: the preview and no download until the balance is paid, then the original
function galleries(s) {
  const paid = s.inv[0].status === "paid", inv = s.inv[0].id;
  const name = s.file;
  return [{ id: "gv", kind: "video", title: "Hide & Haunt commercial", locked: false, selection_limit: null,
    held: !paid, unlock: { invoice_id: inv, title: "Final balance", amount_cents: 75000, paid },
    items: [{ id: "v1", gallery_id: "gv", filename: name, size_bytes: 46855519, sort: 1, selected: false, thumb_url: null,
      url: paid ? "https://img.test/full/clean.mp4" : s.noPreview ? null : "https://img.test/full/preview/clip.mp4",
      download_url: paid ? `https://img.test/full/clean.mp4?download=${encodeURIComponent(name)}` : null }] }];
}
const calls = [];

async function wire(page, errors) {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR|status of 40[03]|MEDIA_ERR|NotSupportedError|no supported source/i.test(m.text())) errors.push(m.text()); });
  await page.route("https://img.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const real = path.includes("/preview/") ? process.env.PORTAL_VIDEO_PREVIEW : process.env.PORTAL_VIDEO_CLEAN;
    if (real) return route.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(real) });
    return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) });
  });
  await page.route("**/rest/v1/rpc/**", async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON() || {};
    calls.push({ fn, body });
    if (fn === "bk_extra_edit_cents") return route.fulfill({ json: 3500 });
    const s = body.p_token === "tok" ? get(body.p_project) : null;
    if (!s) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "not_found" }) });
    if (fn === "bk_portal") return route.fulfill({ json: { project: s.p, invoices: s.inv, contracts: [], files: [], messages: s.msgs } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/functions/v1/**", async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON() || {};
    calls.push({ fn, body });
    if (fn === "bk-create-checkout") {
      // stands in for Stripe: back to the portal with paid=1; the webhook marks it paid now, or a moment later
      const pid = Object.keys(state).find((k) => state[k].inv.some((i) => i.id === body.invoice_id));
      const s = state[pid];
      const markPaid = () => { s.inv[0].status = "paid"; s.inv[0].paid_at = new Date().toISOString(); };
      if (s.slow) setTimeout(markPaid, 2500); else markPaid();
      return route.fulfill({ json: { url: `${BASE}/portal.html?p=${pid}&t=tok&paid=1` } });
    }
    const s = body.token === "tok" ? get(body.project_id) : null;
    if (!s) return route.fulfill({ status: 403, json: { error: "forbidden" } });
    if (body.action === "list") return route.fulfill({ json: { projects: [{ id: s.p.id, title: s.p.title, client_name: s.p.client_name, service: s.p.service, status: s.p.status, galleries: galleries(s) }] } });
    return route.fulfill({ status: 400, json: { error: "bad_action" } });
  });
}

const url = (pid, extra = "") => `${BASE}/portal.html?p=${pid}&t=tok${extra}`;
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/\s+/g, " ").trim();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const ready = (page) => page.waitForSelector("#app:not([hidden]) #galleryRoot .g-block");
// a frame from the middle of the film for screenshots (the first frames are dark)
const showFrame = (page) => page.evaluate(() => Promise.all([...document.querySelectorAll(".g-video video")].map((v) => new Promise((res) => {
  const go = () => { v.addEventListener("seeked", res, { once: true }); v.currentTime = 26; setTimeout(res, 3000); };
  if (v.readyState >= 1) go(); else { v.addEventListener("loadedmetadata", go, { once: true }); setTimeout(res, 4000); }
}))));

async function heldChecks(page, label, inv = "inv-held") {
  ok((await text(page, "#headline")) === "Your video is ready.", `${label}: headline`);
  ok((await text(page, "#heroCta .hero-note")).startsWith("Watermarked preview"), `${label}: hero says it's a preview`);
  ok((await text(page, "#heroCta .hero-pay")) === "Pay $750.00 · Final balance", `${label}: hero balance button`);
  ok((await page.locator(".g-video.is-held").count()) === 1, `${label}: held card`);
  ok((await page.locator(".g-video video").getAttribute("src")).includes("/preview/"), `${label}: plays the preview`);
  ok((await page.locator(".g-video .g-save, .g-video a[download], .g-video a[href*='download='], .g-dl").count()) === 0, `${label}: no download anywhere on the card`);
  const v = page.locator(".g-video video");
  ok(/nodownload/.test(await v.getAttribute("controlslist")), `${label}: controls without a download item`);
  ok((await v.getAttribute("disablepictureinpicture")) !== null, `${label}: no picture-in-picture`);
  ok(await v.evaluate((el) => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), `${label}: right-click menu blocked on the video`);
  ok((await text(page, ".g-vtag")) === "Preview", `${label}: Preview tag`);
  ok((await text(page, ".g-unlock .btn")) === "Pay $750.00 to download", `${label}: unlock button label`);
  ok((await page.locator(".g-unlock .btn").getAttribute("data-pay")) === inv, `${label}: unlock button pays the balance invoice`);
  ok((await text(page, ".g-unlock p")).includes("$750.00 balance"), `${label}: unlock copy names the balance`);
}

try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  const errors = [];
  const page = await ctx.newPage();
  await wire(page, errors);

  /* --- held: watch only --- */
  await page.goto(url("p-held"));
  await ready(page);
  await heldChecks(page, "desktop");
  ok((await text(page, ".g-fn")) === "Hide & Haunt Commercial.mp4", "file name shown");
  // the invoices tab lists the balance with its own Pay
  await page.click("#tab-invoices");
  ok(/Final balance/.test(await page.locator("#invoicesBlock, #panel-invoices").first().innerText()), "balance listed under Invoices");
  await page.click("#tab-photos");
  ok((await overflow(page)) <= 0, "no sideways scroll on desktop");

  /* --- pay from the card → back with paid=1 → the original and Download --- */
  await page.click(".g-unlock .btn");
  await page.waitForURL(/paid=1|p=p-held&t=tok$/);
  await ready(page);
  const co = calls.filter((c) => c.fn === "bk-create-checkout").pop();
  ok(co && co.body.invoice_id === "inv-held" && co.body.token === "tok", "checkout opened for the balance invoice");
  ok(!(await page.locator("#paidBanner").isHidden()), "payment banner shows");
  ok((await text(page, "#paidText")).startsWith("Payment received. Your full-quality video unlocks below"), "banner talks about the video: " + await text(page, "#paidText"));
  ok((await page.locator(".g-video.is-held").count()) === 0, "unlocked: no preview card");
  ok((await page.locator(".g-video video").getAttribute("src")).endsWith("/clean.mp4"), "unlocked: plays the original");
  ok((await page.locator(".g-video .g-save").getAttribute("href")).includes("download="), "unlocked: Download link");
  ok((await page.locator("#heroCta .hero-pay").count()) === 0, "unlocked: nothing left to pay in the hero");
  ok((await text(page, "#heroCta .hero-note")) === "1 video", "unlocked: hero note back to normal");

  /* --- webhook a moment late: the page unlocks itself on the next poll --- */
  await page.goto(url("p-slow"));
  await ready(page);
  await page.click(".g-unlock .btn");
  await page.waitForURL(/paid=1|p=p-slow&t=tok$/);
  await ready(page);
  ok((await page.locator(".g-video.is-held").count()) === 1, "late webhook: still the preview on return");
  ok((await text(page, "#paidText")).startsWith("Payment received. Your full-quality video unlocks below"), "late webhook: banner still names the video");
  ok((await page.locator("#heroCta .hero-pay").count()) === 0, "late webhook: no second Pay while it's processing");
  await page.waitForSelector(".g-video .g-save", { timeout: 16000 }).catch(() => {});
  ok((await page.locator(".g-video .g-save").count()) === 1 && (await page.locator(".g-video.is-held").count()) === 0, "late webhook: unlocks on the next poll without a reload");
  const lists = calls.filter((c) => c.fn === "bk-media" && c.body.project_id === "p-slow").length;
  await page.waitForTimeout(10500);
  ok(calls.filter((c) => c.fn === "bk-media" && c.body.project_id === "p-slow").length === lists, "after unlocking, the poll stops mounting the gallery again");

  /* --- preview not uploaded yet: a note, never a blank player --- */
  await page.goto(url("p-nopreview"));
  await ready(page);
  ok((await page.locator(".g-video video").count()) === 0 && /preview is on its way/.test(await text(page, ".g-vwait")), "missing preview shows a note");
  ok((await page.locator(".g-unlock .btn").count()) === 1, "missing preview still offers the balance");

  /* --- a file name can't inject markup --- */
  await page.goto(url("p-evil"));
  await ready(page);
  ok(!(await page.evaluate(() => window.pwned)), "file name is escaped");

  /* --- phone --- */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await wire(pp, errors);
  delete state["p-held"];
  await pp.goto(url("p-held"));
  await ready(pp);
  await heldChecks(pp, "phone");
  ok((await overflow(pp)) <= 0, "phone: no sideways scroll");
  const [bw, cw] = await pp.evaluate(() => [document.querySelector(".g-unlock .btn").getBoundingClientRect().width, document.querySelector(".g-unlock").getBoundingClientRect().width]);
  ok(cw - bw < 45, `phone: unlock button spans the card (${Math.round(bw)} of ${Math.round(cw)})`);
  ok((await pp.locator(".g-unlock .btn").evaluate((b) => b.getBoundingClientRect().height)) >= 44, "phone: unlock button is a real tap target");
  await phone.close();

  ok(errors.length === 0, "no page errors: " + errors.join(" | "));
  await browser.close();

  /* --- Safari engine --- */
  // this Playwright's WebKit build may not be downloaded; PW_WEBKIT=<path to another playwright(-core)/index.mjs> borrows one
  browser = await webkit.launch().catch(async () => process.env.PW_WEBKIT && (await import(process.env.PW_WEBKIT)).webkit.launch()).catch(() => null);
  if (!browser) throw new Error("no WebKit build available (set PW_WEBKIT)");
  const wk = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const wp = await wk.newPage();
  const werr = [];
  await wire(wp, werr);
  delete state["p-held"];
  await wp.goto(url("p-held"));
  await ready(wp);
  await heldChecks(wp, "webkit");
  ok((await overflow(wp)) <= 0, "webkit: no sideways scroll");
  ok(werr.length === 0, "webkit: no page errors: " + werr.join(" | "));
  await browser.close();

  /* --- screenshots in real Chrome (plays H.264) --- */
  if (SHOTS) {
    browser = await chromium.launch({ channel: "chrome" });
    for (const [w, h, tag] of [[1440, 1000, "desktop"], [390, 844, "phone"]]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: tag === "phone" });
      const sp = await c.newPage();
      await wire(sp, []);
      delete state["p-held"];
      await sp.goto(url("p-held"));
      await ready(sp);
      await showFrame(sp);
      await sp.screenshot({ path: `${SHOTS}/held-${tag}.png` });
      await sp.locator(".g-video").screenshot({ path: `${SHOTS}/held-card-${tag}.png` });
      state["p-held"].inv[0].status = "paid";
      await sp.goto(url("p-held"));
      await ready(sp);
      await showFrame(sp);
      await sp.locator(".g-video").screenshot({ path: `${SHOTS}/unlocked-card-${tag}.png` });
      await c.close();
    }
    await browser.close();
  }
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await done();
}
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
