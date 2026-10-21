// Stubbed UI test for the client portal (portal.html, 2026-10-21 look). Serves the repo locally;
// every Supabase call is intercepted, so it never touches prod.
// Run: node tests/portal-v2.e2e.mjs
//   PORTAL_IMAGES=<dir>  serve real photos (final-<n>.jpg / proof-<n>.jpg) instead of SVG stand-ins
//   PORTAL_SHOTS=<dir>   save screenshots of every stage at desktop + phone widths
import { chromium, webkit } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18742;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const IMAGES = process.env.PORTAL_IMAGES, SHOTS = process.env.PORTAL_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let browser, failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };
const done = async () => { try { await browser?.close(); } catch (_) {} srv.kill(); };

/* ---------------- fixtures ---------------- */
const now = "2026-10-20T19:26:11Z";
const NAME = "Dave Ladetto";
const proofNums = [6696, 6697, 6700, 6701, 6703, 6707, 6711, 6715, 6719, 6722, 6723, 6727, 6731, 6735, 6739, 6741, 6743, 6747];
const proofs = (gid, picked = []) => proofNums.map((n, i) => ({
  id: `${gid}-${n}`, gallery_id: gid, filename: `Untitled Session${n}.jpg`, size_bytes: 310874, sort: i + 1,
  selected: picked.includes(n), content_type: "image/jpeg", ...urls(`proof-${n}.jpg`, `Untitled Session${n}.jpg`),
}));
const finals = (gid) => [[6715, 33790824], [6722, 50822527], [6741, 36897507]].map(([n, size], i) => ({
  id: `${gid}-${n}`, gallery_id: gid, filename: `${NAME} Headshot ${n}.jpg`, size_bytes: size, sort: i + 1, selected: false,
  content_type: "image/jpeg", ...urls(`final-${n}.jpg`, `${NAME} Headshot ${n}.jpg`, true),
}));
function urls(file, dl, big) {
  return { url: `https://img.test/full/${file}`, thumb_url: `https://img.test/${big ? "full" : "thumb"}/${file}`,
    download_url: `https://img.test/full/${file}?download=${encodeURIComponent(dl)}` };
}
const project = (id, extra) => ({ id, title: `${NAME} — Headshots`, status: "delivered", service: "photography",
  location: "1623 Main St, Unit 207, Dallas, TX 75201", created_at: "2026-10-09T18:58:17Z", event_date: "2026-10-12",
  event_time: "2:00 PM", client_name: NAME, ...extra });
const paid = { id: "inv-paid", kind: "full", title: "Session payment", status: "paid", paid_at: "2026-10-09T18:58:40Z", due_date: "2026-10-12", amount_cents: 15000, line_items: [] };
const msgs = () => [
  { id: "m1", sender: "studio", created_at: "2026-10-09T23:07:49Z", body: "Hi Dave, thanks for booking! You're all set for Monday.\n\nSee you Monday!\nNelson" },
  { id: "m2", sender: "client", created_at: "2026-10-16T19:02:37Z", body: "Selected 3 images for editing from \"Headshots — Oct 12\". Ready when you are.\n\nUntitled Session6715.jpg\nUntitled Session6722.jpg\nUntitled Session6741.jpg" },
];
const future = new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10);

const S = {
  ready: () => ({ p: project("p-ready"), inv: [paid], galleries: [
    { id: "gp", kind: "proof", title: "Headshots — Oct 12", locked: true, selection_limit: 3, items: proofs("gp", [6715, 6722, 6741]) },
    { id: "gf", kind: "final", title: "Headshots — Edits", locked: false, selection_limit: null, items: finals("gf") }] }),
  picking: () => ({ p: project("p-picking", { status: "in_production" }), inv: [paid], galleries: [
    { id: "go", kind: "proof", title: "Headshots — Oct 12", locked: false, selection_limit: 3, items: proofs("go") }] }),
  editing: () => ({ p: project("p-editing", { status: "in_production" }), inv: [paid], galleries: [
    { id: "ge", kind: "proof", title: "Headshots — Oct 12", locked: true, selection_limit: 3, items: proofs("ge", [6715, 6722, 6741]) }] }),
  pay: () => ({ p: project("p-pay", { status: "quoted", title: "Marisol Vega — Brand Content Day", event_date: future, client_name: "Marisol Vega", service: "brand_content" }),
    inv: [{ id: "inv-dep", kind: "deposit", title: "50% deposit", status: "sent", due_date: future, amount_cents: 75000, line_items: [{ label: "Brand content day, half up front" }] }], galleries: [] }),
  sign: () => ({ p: project("p-sign", { status: "quoted", event_date: future }), inv: [{ id: "inv-s", kind: "deposit", title: "50% deposit", status: "sent", due_date: future, amount_cents: 75000 }],
    contracts: [{ id: "ct1", title: "Photography agreement", status: "sent", body: "1. Scope\nOne studio headshot session.\n\n2. Delivery\nThree retouched finals.", signer_name: null, signed_at: null }], galleries: [] }),
  booked: () => ({ p: project("p-booked", { status: "booked", event_date: future }), inv: [paid], galleries: [] }),
  fresh: () => ({ p: project("p-new", { status: "new", event_date: null, event_time: null, location: null, title: "Andre Okafor — Music video", client_name: "Andre Okafor", service: "music_video" }), inv: [], galleries: [] }),
  video: () => ({ p: project("p-video", { title: "Andre Okafor — Music video", client_name: "Andre Okafor", service: "music_video" }), inv: [paid], galleries: [
    { id: "gv", kind: "video", title: "Final cut", locked: false, selection_limit: null, items: [{ id: "v1", filename: "Andre Okafor Final Cut.mp4", size_bytes: 9e7, sort: 1, selected: false, url: "https://img.test/full/clip.mp4", thumb_url: null, download_url: "https://img.test/full/clip.mp4?download=x" }] }] }),
  delivered: () => ({ p: project("p-delivered"), inv: [paid], galleries: [] }),
  files: () => ({ p: project("p-files", { title: "Andre Okafor — Music video", client_name: "Andre Okafor", service: "music_video" }), inv: [paid], galleries: [],
    files: [{ url: "https://drive.example.com/final-cut", label: "Final cut (4K)" }, { url: "javascript:alert(1)", label: "Bad link" }] }),
  late: () => ({ p: project("p-late", { status: "booked" }), inv: [{ id: "inv-late", kind: "deposit", title: "50% deposit", status: "sent", due_date: "2026-10-01", amount_cents: 7500 }], galleries: [] }),
  round2: () => ({ p: project("p-round2"), inv: [paid], galleries: [
    { id: "gf2", kind: "final", title: "Headshots — Edits", locked: false, selection_limit: null, items: finals("gf2") },
    { id: "go2", kind: "proof", title: "Round two", locked: false, selection_limit: 2, items: proofs("go2") }] }),
  evil: () => ({ p: project("p-evil", { title: "<img src=x onerror=window.pwned=1> — Headshots", client_name: "<b>Evil</b> Name" }), inv: [paid],
    msgs: [{ id: "x1", sender: "client", created_at: now, body: "<img src=x onerror=window.pwned=1>" }], galleries: [] }),
};
const state = {};
const get = (pid) => {
  if (state[pid]) return state[pid];
  const key = pid.slice(2) === "new" ? "fresh" : pid.slice(2);
  if (!S[key]) return null;
  const { p, inv, galleries, contracts, msgs: m, files } = S[key]();
  return (state[pid] = { p, inv, galleries, contracts: contracts || [], msgs: m || msgs(), files: files || [] });
};
const calls = [];

const SVG = (label, w = 480, h = 720) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#7d8796"/><text x="20" y="60" font-size="28" fill="#fff">${label}</text></svg>`;

async function wire(page, errors) {
  page.on("pageerror", (e) => errors.push(String(e)));
  // 400/403 are the stubs saying no on purpose (wrong token, a 4th pick past the limit)
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR|status of 40[03]/.test(m.text())) errors.push(m.text()); });
  await page.route("https://img.test/**", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    const p = IMAGES && `${IMAGES}/${file}`;
    if (p && existsSync(p)) return route.fulfill({ status: 200, contentType: "image/jpeg", body: readFileSync(p) });
    if (file.endsWith(".mp4")) return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) });
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG(file) });
  });
  await page.route("**/rest/v1/rpc/**", async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON() || {};
    calls.push({ fn, body });
    const s = body.p_token === "tok" ? get(body.p_project) : null;
    if (!s) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "not_found" }) });
    if (fn === "bk_portal") return route.fulfill({ json: { project: s.p, invoices: s.inv, contracts: s.contracts, files: s.files, messages: s.msgs } });
    if (fn === "bk_portal_send") { s.msgs.push({ id: `m${s.msgs.length + 1}`, sender: "client", created_at: new Date().toISOString(), body: body.p_body }); return route.fulfill({ json: null }); }
    if (fn === "bk_portal_sign_contract") {
      const c = s.contracts.find((x) => x.id === body.p_contract);
      Object.assign(c, { status: "signed", signer_name: body.p_signer_name, signed_at: new Date().toISOString() });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/functions/v1/**", async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON() || {};
    calls.push({ fn, body });
    if (fn === "bk-create-checkout") return route.fulfill({ json: { error: "payments_not_configured" } });
    const s = body.token === "tok" ? get(body.project_id) : null;
    if (!s) return route.fulfill({ status: 403, json: { error: "forbidden" } });
    if (body.action === "list") return route.fulfill({ json: { projects: [{ id: s.p.id, title: s.p.title, client_name: s.p.client_name, service: s.p.service, status: s.p.status, galleries: s.galleries }] } });
    const item = s.galleries.flatMap((g) => g.items).find((i) => i.id === body.item_id);
    if (body.action === "toggle_select") {
      const g = s.galleries.find((x) => x.id === item.gallery_id);
      if (body.selected && g.items.filter((i) => i.selected).length >= g.selection_limit) return route.fulfill({ status: 400, json: { error: "limit_reached" } });
      item.selected = body.selected;
      return route.fulfill({ json: { ok: true } });
    }
    if (body.action === "submit_selections") {
      const g = s.galleries.find((x) => x.id === body.gallery_id);
      g.locked = true;
      return route.fulfill({ json: { count: g.items.filter((i) => i.selected).length } });
    }
    return route.fulfill({ status: 400, json: { error: "bad_action" } });
  });
}

const url = (pid, extra = "") => `${BASE}/portal.html?p=${pid}&t=tok${extra}`;
const text = async (page, sel) => (await page.locator(sel).first().textContent()).replace(/\s+/g, " ").trim();
async function overflow(page) { return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); }

try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 1024 }, acceptDownloads: true });
  const errors = [];
  const page = await ctx.newPage();
  await wire(page, errors);

  /* --- delivered: Dave's page, the mockup --- */
  await page.goto(url("p-ready"));
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => [...document.querySelectorAll(".g-cell.final img")].every((i) => i.complete && i.naturalWidth));
  ok((await text(page, "#headline")) === "Your photos are ready.", "ready headline");
  ok((await text(page, "#eyebrow")) === "Welcome, Dave", "first visit: Welcome, first name");
  ok((await text(page, "#pStatus")) === "Delivered", "status pill");
  ok((await text(page, "#heroCta .btn")).includes("Download all 3 photos"), "hero download label");
  ok((await text(page, "#heroCta .hero-note")) === "ZIP file · 116 MB", "zip size note matches the mockup (116 MB)");
  ok((await page.locator(".tk.done").count()) === 5, "all five stages done when delivered");
  ok((await page.locator(".tab[aria-selected=true]").innerText()) === "Photos & video", "photos tab first");
  ok((await page.locator(".g-cell.final").count()) === 3, "three final cards");
  ok((await page.locator(".g-cell.final .g-fn").allInnerTexts()).join() === "Headshot 6715.jpg,Headshot 6722.jpg,Headshot 6741.jpg", "card names drop the client's name");
  ok((await page.locator(".g-cell.final .g-save").first().getAttribute("href")).includes("download="), "card download link");
  ok((await page.locator(".g-orig").count()) === 1 && (await text(page, ".g-orig-text small")) === "Headshots — Oct 12 · 3 selected", "original selections row");
  ok((await page.locator(".g-dlall").count()) === 0, "no second download-all inside the gallery");
  const rail = await page.locator("#railFacts").innerText();
  ok(/Headshots/.test(rail) && /October 12, 2026/.test(rail) && /\$150\.00/.test(rail) && /Paid/.test(rail), "rail facts: " + rail.replace(/\n/g, " | "));
  ok(!/2:00 PM/.test(rail), "no call time in the rail after the shoot");
  ok((await text(page, "#helpH")) === "Need a change?", "help card heading when delivered");
  ok((await page.locator("#tab-invoices").isVisible()), "invoices tab shows with a paid invoice");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ready-1536.png` });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ready-1536-full.png`, fullPage: true });

  // download all → one zip
  const dl = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#heroCta .btn");
  const file = await dl;
  ok(file.suggestedFilename() === "Dave Ladetto — Headshots.zip", "zip name: " + file.suggestedFilename());
  await page.waitForFunction(() => !document.querySelector("#heroCta .btn[aria-busy]"));
  ok((await text(page, "#heroCta .btn")).includes("Download all 3 photos"), "button label restored after zip");

  // viewer from the expand card, Escape closes and focus comes back
  await page.click(".g-cell.final:nth-child(2) .g-open");
  await page.waitForSelector(".g-lightbox:not([hidden])");
  ok((await text(page, ".g-lb-count")) === "2 / 3", "viewer opens on the clicked photo");
  ok((await text(page, ".g-lb-name")) === "Headshot 6722.jpg", "viewer name matches the card");
  ok((await page.locator(".g-lb-bar a.g-lb-dl").count()) === 1, "viewer has a download");
  await page.keyboard.press("ArrowRight");
  ok((await text(page, ".g-lb-count")) === "3 / 3", "arrow key steps");
  await page.keyboard.press("Escape");
  ok(await page.locator(".g-lightbox").isHidden(), "Escape closes viewer");
  await page.click(".g-orig");
  ok((await text(page, ".g-lb-count")) === "1 / 3" && /Picks sent/.test(await text(page, ".g-lb-bar")) === false, "View selections opens the 3 picks");
  await page.click(".g-lb-close");

  // tabs: click, keys, hash, reload keeps the tab
  await page.click("#tab-details");
  ok(await page.locator("#panel-details").isVisible() && (await page.locator("#panel-photos").isHidden()), "details tab shows its panel");
  ok(/2:00 PM/.test(await text(page, "#pDetails")) && /1623 Main St/.test(await text(page, "#pDetails")), "details keep call time + address");
  await page.focus("#tab-details");
  await page.keyboard.press("ArrowRight");
  ok((await page.evaluate(() => document.activeElement.id)) === "tab-messages", "arrow moves to messages tab");
  ok(page.url().endsWith("#messages"), "hash follows the tab");
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  ok((await page.locator(".tab[aria-selected=true]").innerText()) === "Messages", "reload keeps the messages tab");
  ok((await text(page, "#eyebrow")) === "Welcome back, Dave", "return visit: Welcome back");
  ok((await page.locator(".msg.me").count()) === 1 && (await page.locator(".msg.them").count()) === 1, "chat bubbles by sender");

  // message: type, Enter sends, shows up, box clears
  await page.fill("#chatInput", "These look great, thank you!");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg.me").length === 2);
  ok((await page.inputValue("#chatInput")) === "", "sent message clears the box");
  ok(calls.some((c) => c.fn === "bk_portal_send" && c.body.p_body === "These look great, thank you!"), "send RPC called");

  // the 10s poll must not wipe a half-typed message
  await page.fill("#chatInput", "half typed");
  await page.click("#tab-invoices");
  await page.focus(".tab[aria-selected=true]");
  state["p-ready"].msgs.push({ id: "m-new", sender: "studio", created_at: new Date().toISOString(), body: "Glad you like them!" });
  await page.waitForTimeout(10800);
  ok((await page.inputValue("#chatInput")) === "half typed", "poll keeps typed text");
  ok((await page.evaluate(() => document.activeElement.id)) === "tab-invoices", "poll keeps keyboard focus");
  ok(await page.locator("#tab-messages.has-new").count() === 1, "new reply puts a dot on Messages");
  await page.click("#tab-messages");
  ok(await page.locator("#tab-messages.has-new").count() === 0 && (await page.locator(".msg.them").count()) === 2, "opening Messages clears the dot and shows the reply");

  // Message Nelson (top bar) jumps to messages with the box focused
  await page.click("#tab-photos");
  await page.click(".cbar-msg");
  ok((await page.evaluate(() => document.activeElement.id)) === "chatInput", "Message Nelson focuses the message box");
  await page.click("#tab-photos");
  await page.click(".card-ink [data-open-messages]");
  ok((await page.evaluate(() => document.activeElement.id)) === "chatInput", "help card button focuses the message box");

  // account menu
  await page.click("#whoBtn");
  ok(await page.locator("#whoMenu").isVisible() && (await page.getAttribute("#whoBtn", "aria-expanded")) === "true", "menu opens");
  ok((await text(page, "#whoFull")) === NAME && (await text(page, "#avatar")) === "DL", "menu name + initials");
  await page.keyboard.press("Escape");
  ok(await page.locator("#whoMenu").isHidden() && (await page.evaluate(() => document.activeElement.id)) === "whoBtn", "Escape closes menu, focus returns");
  await page.click("#whoBtn");
  await page.mouse.click(700, 600);
  ok(await page.locator("#whoMenu").isHidden(), "outside click closes menu");

  /* --- picking --- */
  await page.goto(url("p-picking"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Pick your favorites.", "picking headline");
  ok((await text(page, "#heroCta .hero-note")) === "18 proofs · pick up to 3", "picking note");
  ok((await text(page, ".g-h")) === "Pick your favorites", "proof section heading");
  ok((await page.locator(".tk.now .tk-label").innerText()).startsWith("Production"), "current stage marked");
  await page.click("#heroCta .btn");
  for (const n of [1, 2, 3]) await page.click(`.g-cell:nth-child(${n}) .g-pick`);
  await page.click(".g-cell:nth-child(4) .g-pick");
  ok(/max/.test(await text(page, ".g-toast")), "4th pick blocked with a toast");
  ok((await text(page, ".g-count")) === "3 of 3 picked", "pick count");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/picking-1536.png` });
  await page.click(".g-submit");
  await page.click(".g-send");
  await page.waitForFunction(() => document.querySelector("#headline").textContent === "Your picks are in.");
  ok((await page.locator(".g-cell:not([hidden])").count()) === 3, "after sending, only the picks show");
  ok((await text(page, ".g-h")) === "Your picks", "heading switches to Your picks");
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your picks are in." && (await page.locator(".g-cell").count()) === 3, "picks state survives reload");

  /* --- editing (sent, no edits yet) --- */
  await page.goto(url("p-editing"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your picks are in." && (await page.locator("#heroCta .btn").count()) === 0 && /Nelson is editing/.test(await text(page, ".hero-aside")), "editing: headline + a line, no button");
  ok((await page.locator(".g-selnote").count()) === 0 && (await text(page, ".g-sent")) === "Picks sent · 3 chosen", "editing: one 'Nelson is editing' line, in the hero");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editing-1536.png` });

  /* --- pay --- */
  await page.goto(url("p-pay"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Lock in your date.", "deposit headline");
  ok((await text(page, "#heroCta .btn")).includes("Pay $750.00"), "pay button amount");
  ok((await page.locator(".tab[aria-selected=true]").innerText()) === "Invoices", "pay opens on invoices");
  ok((await text(page, "#railFacts")).includes("Brand Content Day"), "service from the title");
  await page.click("#heroCta .btn");
  await page.waitForFunction(() => /Message Nelson/.test(document.querySelector("#heroCta .btn").textContent));
  ok(calls.some((c) => c.fn === "bk-create-checkout" && c.body.invoice_id === "inv-dep"), "checkout called with the invoice");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pay-1536.png` });

  /* --- sign --- */
  await page.goto(url("p-sign"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your contract is ready.", "sign headline");
  ok((await page.locator(".tab[aria-selected=true]").innerText()) === "Project details", "sign opens on details");
  const signBtn = page.locator(".ct-sign button[type=submit]");
  ok(await signBtn.isDisabled(), "sign disabled until name + box");
  await page.fill("[data-sig-name]", "Dave Ladetto");
  await page.check("[data-sig-agree]");
  ok(await signBtn.isEnabled(), "sign enabled");
  await signBtn.click();
  await page.waitForSelector(".ct-signed");
  await page.waitForFunction(() => document.querySelector("#headline").textContent === "Lock in your date.");
  ok(true, "after signing, the hero moves on to the deposit");

  /* --- booked / new / video / bad link --- */
  await page.goto(url("p-booked"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "You're booked." && /Shoot day/i.test(await text(page, "#heroCta")), "booked hero");
  ok(/2:00 PM/.test(await text(page, "#railFacts")), "upcoming shoot shows the time in the rail");
  ok(await page.locator("#tab-invoices").isVisible(), "invoices tab with a paid invoice");
  ok((await page.locator(".tab[aria-selected=true]").innerText()) === "Project details", "booked opens on details");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/booked-1536.png` });

  await page.goto(url("p-new"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "We got your request." && (await text(page, "#eyebrow")) === "Welcome, Andre", "new inquiry hero");
  ok(await page.locator("#tab-invoices").isVisible() && /No invoices yet/.test(await page.locator("#pInvoices").innerText()), "new: invoices tab with empty state");

  await page.goto(url("p-video"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your video is ready." && (await text(page, "#heroCta .btn")).includes("Watch your video"), "video hero");
  ok((await page.locator(".g-video .g-save").count()) === 1, "video download");

  await page.goto(url("p-delivered"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your project is delivered.", "delivered with no gallery doesn't say In the edit");

  await page.goto(url("p-files"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your files are ready." && (await text(page, "#heroCta .hero-note")) === "1 link", "links-only delivery hero");
  ok(await page.locator("#galleryRoot").isHidden() && (await page.locator(".link-row").count()) === 1, "no 'photos land here' note, and the javascript: link is dropped");

  await page.goto(url("p-late"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Your invoice is ready.", "deposit after the shoot date isn't 'Lock in your date'");

  await page.goto(url("p-round2"));
  await page.waitForSelector("#app:not([hidden])");
  ok((await text(page, "#headline")) === "Pick your favorites.", "a second proof round outranks delivered");

  await page.goto(url("p-ready", "&paid=1"));
  await page.waitForSelector("#app:not([hidden])");
  ok(await page.locator("#paidBanner").isVisible() && !page.url().includes("paid=1"), "paid banner shows once and leaves the URL");

  await page.route("**/rest/v1/rpc/bk_portal", (r) => r.abort("internetdisconnected"));
  await page.goto(url("p-ready"));
  await page.waitForSelector("#offline:not([hidden])");
  ok(await page.locator("#noAccess").isHidden(), "offline says can't reach, not can't find");
  await page.unroute("**/rest/v1/rpc/bk_portal");

  await page.goto(url("p-evil"));
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#tab-messages");
  ok(!(await page.evaluate(() => window.pwned)), "no script injection from title, name or message");

  await page.goto(`${BASE}/portal.html?p=p-ready&t=wrong`);
  await page.waitForSelector("#noAccess:not([hidden])");
  ok(/can't find/.test(await text(page, "#noAccess h1")), "bad link shows the not-found page");

  await page.goto(url("p-ready", "&look=v1"));
  await page.waitForURL(/portal-v1\.html/);
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForSelector(".g-dlall");
  ok(true, "look=v1 falls back to the old portal, old gallery look intact");

  /* --- widths: no sideways scroll, phone layout --- */
  for (const w of [320, 375, 390, 768, 1024, 1280, 1536]) {
    await page.setViewportSize({ width: w, height: w < 700 ? 844 : 1000 });
    for (const pid of ["p-ready", "p-picking", "p-pay", "p-booked"]) {
      await page.goto(url(pid));
      await page.waitForSelector("#app:not([hidden])");
      await page.waitForTimeout(150);
      const o = await overflow(page);
      const wide = o > 0 ? await page.evaluate(() => { const W = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > W + 0.5 && e.getBoundingClientRect().width)
          .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}`).join(", "); }) : "";
      ok(o <= 0, `no horizontal scroll at ${w}px on ${pid} (+${o}px: ${wide})`);
      if (SHOTS && (w === 390 || w === 1024)) await page.screenshot({ path: `${SHOTS}/${pid.slice(2)}-${w}-full.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("p-ready"));
  await page.waitForSelector("#app:not([hidden])");
  const hb = await page.locator("#heroCta .btn").boundingBox();
  ok(hb && hb.width > 300, "phone: hero button spans the width");
  ok(await page.locator(".cbar-msg span").isHidden(), "phone: Message Nelson collapses to its icon");
  const tabsFit = await page.evaluate(() => { const t = document.querySelector(".tabs"); return t.scrollWidth <= t.clientWidth; });
  ok(tabsFit, "phone: all four tabs fit without sideways scrolling");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ready-390.png` });

  // after the 2h signed links go stale, a card's Download re-signs before following the link
  const stalePage = await ctx.newPage();
  await wire(stalePage, errors);
  await stalePage.clock.install();
  await stalePage.goto(url("p-ready"));
  await stalePage.waitForSelector("#app:not([hidden])");
  await stalePage.clock.fastForward("01:31:00");
  const lists = () => calls.filter((c) => c.fn === "bk-media" && c.body.action === "list" && c.body.project_id === "p-ready").length;
  const before = lists();
  await Promise.all([stalePage.waitForURL(/img\.test/), stalePage.click(".g-cell.final:first-child .g-save")]);
  ok(lists() === before + 1, "stale Download re-signs first");
  await stalePage.close();

  ok(errors.length === 0, "console errors: " + errors.join(" | "));
  await ctx.close();

  /* --- WebKit (iPhone Safari engine): the delivered page renders and the zip works --- */
  // this Playwright's WebKit build may not be downloaded; PW_WEBKIT=<path to another playwright(-core)/index.mjs> borrows one
  const wk = await webkit.launch().catch(async () => process.env.PW_WEBKIT && (await import(process.env.PW_WEBKIT)).webkit.launch()).catch(() => null);
  if (!wk) { console.warn("SKIP: no WebKit build available (set PW_WEBKIT)"); throw "skip-webkit"; }
  const wctx = await wk.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, hasTouch: true, isMobile: true });
  const wp = await wctx.newPage();
  const werr = [];
  await wire(wp, werr);
  await wp.goto(url("p-ready"));
  await wp.waitForSelector("#app:not([hidden])");
  ok((await text(wp, "#headline")) === "Your photos are ready.", "webkit: ready headline");
  ok((await overflow(wp)) <= 0, "webkit: no horizontal scroll");
  const wdl = wp.waitForEvent("download", { timeout: 15000 });
  await wp.tap("#heroCta .btn");
  ok(/\.zip$/.test((await wdl).suggestedFilename()), "webkit: zip downloads");
  ok(werr.length === 0, "webkit console errors: " + werr.join(" | "));
  await wk.close();
} catch (e) {
  if (e !== "skip-webkit") { failures++; console.error("CRASH:", e); }
}
await done();
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
