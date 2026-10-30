// Stubbed UI test for a video held until its balance is paid (portal.html). Serves the repo locally;
// every Supabase call is intercepted, so it never touches prod.
// Run: node tests/video-unlock.e2e.mjs
//   PORTAL_SHOTS=<dir>        save screenshots (held + unlocked, desktop + phone) using installed Chrome
//   PORTAL_VIDEO_PREVIEW=<f>  serve a real preview mp4 (and PORTAL_VIDEO_CLEAN=<f> the original) for those shots
//   PORTAL_VIDEO_STILL=<f>    serve a real still (jpg) for the closed-preview shots
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
  gap: () => ({ file: "Hide & Haunt Commercial.mp4", slow: true, slowMs: 15000 }),
  twice: () => ({ file: "Hide & Haunt Commercial.mp4", alreadyPaid: true }),
  playing: () => ({ file: "Hide & Haunt Commercial.mp4" }),
  nopreview: () => ({ file: "Hide & Haunt Commercial.mp4", noPreview: true }),
  closed: () => ({ file: "Hide & Haunt Commercial.mp4", closed: true }),
  closednostill: () => ({ file: "Hide & Haunt Commercial.mp4", closed: true, noStill: true }),
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
// (a closed preview: no video at all, only the still as the thumb)
function galleries(s) {
  const paid = s.inv[0].status === "paid", inv = s.inv[0].id;
  const name = s.file;
  // her approved storyboard with its HoneyBook deposit link (paid before production)
  const board = { id: "gsb", kind: "storyboard", title: "Hide & Haunt storyboard v3", locked: true, selection_limit: null, review_outcome: "approved",
    reviewed_at: "2026-10-28T23:21:00Z", pay_url: "https://taylormadecreative.hbportal.co/flow/x", purpose: null,
    items: [{ id: "f1", gallery_id: "gsb", filename: "1A.png", sort: 1, selected: false, thumb_url: null, url: "https://img.test/full/1A.png", download_url: null,
      meta: { scene: 1, scene_title: "Arrival", code: "1A", tc: "0:00", action: "They walk up." }, client_note: null }] };
  return [board, { id: "gv", kind: "video", title: "Hide & Haunt commercial", locked: false, selection_limit: null,
    held: !paid, preview_closed: !paid && !!s.closed, unlock: { invoice_id: inv, title: "Final balance", amount_cents: 75000, paid, payable: s.inv[0].status === "sent" },
    items: [{ id: "v1", gallery_id: "gv", filename: name, size_bytes: 46855519, sort: 1, selected: false,
      thumb_url: !paid && s.closed && !s.noStill ? "https://img.test/full/preview/still.jpg" : null,
      url: paid ? "https://img.test/full/clean.mp4" : s.noPreview || s.closed ? null : "https://img.test/full/preview/clip.mp4",
      download_url: paid ? `https://img.test/full/clean.mp4?download=${encodeURIComponent(name)}` : null }] }];
}
const calls = [];
const media = []; // every img.test request (a closed preview must never fetch a video)
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function wire(page, errors) {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR|status of 40[039]|MEDIA_ERR|NotSupportedError|no supported source/i.test(m.text())) errors.push(m.text()); });
  await page.route("https://img.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    media.push(path);
    if (path.endsWith(".jpg")) {
      const still = process.env.PORTAL_VIDEO_STILL;
      return route.fulfill({ status: 200, contentType: still ? "image/jpeg" : "image/png", body: still ? readFileSync(still) : PIXEL });
    }
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
      // a second tap after the payment went through (the server refuses with already_paid)
      if (s.alreadyPaid) { markPaid(); return route.fulfill({ status: 409, json: { error: "already_paid" } }); }
      if (s.slow) setTimeout(markPaid, s.slowMs || 2500); else markPaid();
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
  ok((await text(page, "#heroCta .hero-note")) === "Preview now · clean download with your final payment", `${label}: hero says it's a preview`);
  ok((await page.locator("#heroCta .btn-gold use").getAttribute("href")) === "#i-play", `${label}: watch button has a play icon, not a download arrow`);
  ok((await text(page, "#heroCta .hero-pay")) === "Pay $750.00 and download", `${label}: hero balance button names what it buys`);
  ok((await text(page, ".g-block[data-kind='video'] .g-h")) === "Your video", `${label}: heading isn't "Final" while it's a preview`);
  ok((await page.locator(".g-video.is-held").count()) === 1, `${label}: held card`);
  ok((await page.locator(".g-video video").getAttribute("src")).includes("/preview/"), `${label}: plays the preview`);
  ok((await page.locator(".g-video .g-save, .g-video a[download], .g-video a[href*='download='], .g-dl").count()) === 0, `${label}: no download anywhere on the card`);
  const v = page.locator(".g-video video");
  ok(/nodownload/.test(await v.getAttribute("controlslist")), `${label}: controls without a download item`);
  ok((await v.getAttribute("disablepictureinpicture")) !== null, `${label}: no picture-in-picture`);
  ok(await v.evaluate((el) => !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), `${label}: right-click menu blocked on the video`);
  ok((await v.getAttribute("aria-label")) === "Watermarked preview: Hide & Haunt Commercial.mp4" || label === "evil", `${label}: the player has a name`);
  ok((await text(page, ".g-vtag")) === "Preview" && (await page.locator(".g-vtag.chip-due").count()) === 1, `${label}: Preview chip`);
  ok((await text(page, ".g-unlock .btn")) === "Pay $750.00 and download", `${label}: unlock button label`);
  ok((await page.locator(".g-unlock .btn").getAttribute("data-pay")) === inv, `${label}: unlock button pays the balance invoice`);
  ok(/final balance/.test(await text(page, ".g-unlock-ask")) && !/\$/.test(await text(page, ".g-unlock-ask")), `${label}: unlock copy names the balance once (the price is on the button)`);
  ok(await page.locator(".g-unlock-wait").isHidden(), `${label}: no "payment received" line before paying`);
}

// a closed preview: nothing plays, a still under a lock, the same Pay
async function closedChecks(page, label, inv = "inv-closed") {
  ok((await text(page, "#headline")) === "Your video is ready.", `${label}: headline`);
  ok((await text(page, "#heroCta .hero-note")) === "Preview closed · your clean file downloads right after", `${label}: hero says the preview is closed`);
  ok((await text(page, "#heroCta .btn-gold")) === "Pay $750.00 and download", `${label}: the main hero button is the payment, not Watch`);
  ok((await page.locator("#heroCta .btn-gold").getAttribute("data-pay")) === inv && (await page.locator("#heroCta .btn-gold use").getAttribute("href")) === "#i-card", `${label}: hero button pays the balance (card icon)`);
  ok((await page.locator("#heroCta .hero-pay").count()) === 0 && (await page.locator("#heroCta [data-pay]").count()) === 1, `${label}: one Pay in the hero, not two`);
  ok((await page.locator(".g-video.is-held").count()) === 1, `${label}: held card`);
  ok((await page.locator(".g-video video, video").count()) === 0, `${label}: no video player anywhere`);
  ok((await text(page, ".g-vclosed-tag")) === "Preview closed", `${label}: lock label on the frame`);
  ok((await page.locator(".g-vclosed img").getAttribute("src") || "").endsWith("/still.jpg"), `${label}: the still sits behind the lock`);
  ok((await text(page, ".g-vtag")) === "Balance due", `${label}: chip says what's left`);
  ok((await page.locator(".g-video .g-save, .g-video a[download], .g-video a[href*='download='], .g-dl").count()) === 0, `${label}: no download anywhere on the card`);
  const ask = await text(page, ".g-unlock-ask");
  ok(ask.startsWith("Your preview is closed.") && /final balance/.test(ask) && !/as often as you like/.test(ask) && !/\$/.test(ask), `${label}: closed copy: ` + ask);
  ok((await text(page, ".g-unlock .btn")) === "Pay $750.00 and download", `${label}: unlock button label`);
  ok((await page.locator(".g-unlock .btn").getAttribute("data-pay")) === inv, `${label}: unlock button pays the balance invoice`);
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
  ok((await page.locator(".sb-pay").count()) === 0 && !/Next is your deposit/.test(await page.locator("#galleryRoot").innerText()), "the approved storyboard no longer asks for the deposit once the video is here");
  ok(/Storyboard approved/.test(await page.locator("#galleryRoot").innerText()), "the storyboard still shows it was approved");
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
  ok((await text(page, "#paidText")).startsWith("Payment received, thank you. Your final video is below, ready to download"), "banner talks about the video: " + await text(page, "#paidText"));
  ok((await page.locator(".g-video.is-held").count()) === 0, "unlocked: no preview card");
  ok((await page.locator(".g-video video").getAttribute("src")).endsWith("/clean.mp4"), "unlocked: plays the original");
  ok((await page.locator(".g-video .g-save").getAttribute("href")).includes("download="), "unlocked: Download link");
  ok((await page.locator("#heroCta .hero-pay").count()) === 0, "unlocked: nothing left to pay in the hero");
  ok((await text(page, "#heroCta .hero-note")) === "1 video", "unlocked: hero note back to normal");
  ok((await text(page, ".g-block[data-kind='video'] .g-h")) === "Final video", "unlocked: heading says Final video");
  const [vw, lw] = await page.evaluate(() => [document.querySelector(".g-video").getBoundingClientRect().width, document.querySelector(".g-videos").getBoundingClientRect().width]);
  ok(Math.abs(vw - lw) < 2, `unlocked: the paid video keeps the full width (${Math.round(vw)} of ${Math.round(lw)})`);

  /* --- webhook a moment late: the page unlocks itself on the next poll --- */
  await page.goto(url("p-slow"));
  await ready(page);
  await page.click(".g-unlock .btn");
  await page.waitForURL(/paid=1|p=p-slow&t=tok$/);
  await ready(page);
  ok((await page.locator(".g-video.is-held").count()) === 1, "late webhook: still the preview on return");
  ok((await text(page, "#paidText")).includes("will be ready to download below in a few seconds"), "late webhook: banner says it's on its way: " + await text(page, "#paidText"));
  ok((await page.locator("#heroCta .hero-pay").count()) === 0, "late webhook: no second Pay in the hero while it's processing");
  ok(await page.locator(".g-unlock .btn").isHidden(), "late webhook: the card doesn't offer the same payment again");
  ok((await page.locator(".g-unlock-wait").isVisible()) && /Payment received/.test(await text(page, ".g-unlock-wait")), "late webhook: the card says the payment is in");
  ok((await text(page, "#heroCta .hero-note")) === "Payment received · your download is on its way", "late webhook: hero note says it's on its way");
  // the swap is quiet: no loading skeleton flashes in while it happens
  await page.evaluate(() => { window.__skel = 0; new MutationObserver(() => { if (document.querySelector("#galleryRoot .g-skel")) window.__skel++; }).observe(document.querySelector("#galleryRoot"), { childList: true, subtree: true }); });
  await page.waitForSelector(".g-video .g-save", { timeout: 16000 }).catch(() => {});
  ok((await page.locator(".g-video .g-save").count()) === 1 && (await page.locator(".g-video.is-held").count()) === 0, "late webhook: unlocks on the next poll without a reload");
  ok((await page.evaluate(() => window.__skel)) === 0, "late webhook: no skeleton flash during the swap");
  ok((await text(page, "#paidText")) === "Payment received, thank you. Your final video is ready to download below.", "late webhook: the status line announces the unlock");
  const lists = calls.filter((c) => c.fn === "bk-media" && c.body.project_id === "p-slow").length;
  await page.waitForTimeout(10500);
  ok(calls.filter((c) => c.fn === "bk-media" && c.body.project_id === "p-slow").length === lists, "after unlocking, the poll stops mounting the gallery again");

  /* --- a reload in the gap still knows the payment is in --- */
  await page.goto(url("p-gap"));
  await ready(page);
  await page.click(".g-unlock .btn");
  await page.waitForURL(/paid=1|p=p-gap&t=tok$/);
  await ready(page);
  await page.reload();
  await ready(page);
  ok(!page.url().includes("paid=1"), "reload: the paid flag is gone from the address");
  ok(await page.locator(".g-unlock .btn").isHidden(), "reload in the gap: still no second Pay on the card");
  ok((await page.locator("#heroCta .hero-pay").count()) === 0, "reload in the gap: still no second Pay in the hero");

  /* --- a second tap after the payment already went through --- */
  await page.goto(url("p-twice"));
  await ready(page);
  await page.click(".g-unlock .btn");
  await page.waitForSelector(".g-video .g-save", { timeout: 8000 }).catch(() => {});
  ok((await page.locator(".g-video .g-save").count()) === 1, "already paid: the page catches up and unlocks instead of saying Try again");

  /* --- never cut off the preview mid-play --- */
  await page.goto(url("p-playing"));
  await ready(page);
  await page.evaluate(() => { const v = document.querySelector(".g-video video"); Object.defineProperty(v, "paused", { configurable: true, get: () => false }); });
  state["p-playing"].inv[0].status = "paid";
  await page.waitForTimeout(11000);
  ok((await page.locator(".g-video.is-held").count()) === 1, "playing: the preview keeps playing after the payment lands");
  await page.evaluate(() => { const v = document.querySelector(".g-video video"); Object.defineProperty(v, "paused", { configurable: true, get: () => true }); v.dispatchEvent(new Event("pause")); });
  await page.waitForSelector(".g-video .g-save", { timeout: 5000 }).catch(() => {});
  ok((await page.locator(".g-video .g-save").count()) === 1, "playing: it unlocks as soon as she pauses");

  /* --- preview not uploaded yet: a note, never a blank player --- */
  await page.goto(url("p-nopreview"));
  await ready(page);
  ok((await page.locator(".g-video video").count()) === 0 && /preview is on its way/.test(await text(page, ".g-vwait")), "missing preview shows a note");
  ok((await page.locator(".g-unlock .btn").count()) === 1, "missing preview still offers the balance");

  /* --- preview closed: nothing plays; paying still brings the clean file --- */
  media.length = 0;
  await page.goto(url("p-closed"));
  await ready(page);
  await closedChecks(page, "closed");
  ok(!media.some((m) => m.endsWith(".mp4")), "closed: the page never requests a video file: " + media.join(", "));
  await page.click("#heroCta .btn-gold");
  await page.waitForURL(/paid=1|p=p-closed&t=tok$/);
  ok(calls.filter((c) => c.fn === "bk-create-checkout").pop()?.body.invoice_id === "inv-closed", "closed: the hero button opens checkout for the balance");
  await ready(page);
  ok((await page.locator(".g-video.is-held").count()) === 0 && (await page.locator(".g-vclosed").count()) === 0, "closed → paid: the lock is gone");
  ok((await page.locator(".g-video video").getAttribute("src")).endsWith("/clean.mp4"), "closed → paid: plays the original");
  ok((await page.locator(".g-video .g-save").getAttribute("href")).includes("download="), "closed → paid: Download link");

  /* --- closed with no still uploaded: a plain dark frame with the lock --- */
  await page.goto(url("p-closednostill"));
  await ready(page);
  ok((await page.locator(".g-vclosed img").count()) === 0 && (await text(page, ".g-vclosed-tag")) === "Preview closed", "closed, no still: the lock on a dark frame");
  const frameH = await page.locator(".g-vclosed").evaluate((el) => el.getBoundingClientRect().height);
  ok(frameH > 200, `closed, no still: the frame keeps its 16:9 size (${Math.round(frameH)}px)`);

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
  await heldChecks(pp, "phone", "inv-held");
  ok((await overflow(pp)) <= 0, "phone: no sideways scroll");
  const [bw, cw] = await pp.evaluate(() => [document.querySelector(".g-unlock .btn").getBoundingClientRect().width, document.querySelector(".g-unlock").getBoundingClientRect().width]);
  ok(cw - bw < 45, `phone: unlock button spans the card (${Math.round(bw)} of ${Math.round(cw)})`);
  ok((await pp.locator(".g-unlock .btn").evaluate((b) => b.getBoundingClientRect().height)) >= 44, "phone: unlock button is a real tap target");
  delete state["p-closed"];
  await pp.goto(url("p-closed"));
  await ready(pp);
  await closedChecks(pp, "phone closed");
  ok((await overflow(pp)) <= 0, "phone closed: no sideways scroll");
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
  delete state["p-closed"];
  await wp.goto(url("p-closed"));
  await ready(wp);
  await closedChecks(wp, "webkit closed");
  ok((await overflow(wp)) <= 0, "webkit closed: no sideways scroll");
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
      delete state["p-closed"];
      await sp.goto(url("p-closed"));
      await ready(sp);
      await sp.waitForTimeout(400);
      await sp.screenshot({ path: `${SHOTS}/closed-${tag}.png` });
      await sp.locator(".g-video").screenshot({ path: `${SHOTS}/closed-card-${tag}.png` });
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
