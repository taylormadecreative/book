// Stubbed UI test for storyboard review in the client portal (portal.html). Serves the repo locally;
// every Supabase call is intercepted, so it never touches prod.
// Run: node tests/storyboard.e2e.mjs
//   STORYBOARD_IMAGES=<dir>  serve real frames (<dir>/full/frame-1A.jpg, <dir>/thumbs/…) and captions (<dir>/frames.json)
//   STORYBOARD_SHOTS=<dir>   save screenshots at desktop + phone widths
//   PW_WEBKIT=<playwright-core index.mjs>  also run the phone pass in WebKit (iPhone Safari's engine)
import { chromium } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const PORT = 18743;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const IMAGES = process.env.STORYBOARD_IMAGES, SHOTS = process.env.STORYBOARD_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let browser, failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };
const done = async () => { try { await browser?.close(); } catch (_) {} srv.kill(); };

/* ---------------- fixtures: the Hide & Haunt storyboard (27 frames, 8 scenes) ---------------- */
const FRAMES = IMAGES && existsSync(`${IMAGES}/frames.json`) ? JSON.parse(readFileSync(`${IMAGES}/frames.json`, "utf8"))
  : Array.from({ length: 27 }, (_, i) => ({ sort: i + 1, file: `frame-${i + 1}.jpg`, meta: { code: `${Math.floor(i / 4) + 1}${"ABCD"[i % 4]}`, tc: `0:${String(i * 2).padStart(2, "0")}–0:${String(i * 2 + 2).padStart(2, "0")}`, scene_no: Math.floor(i / 4) + 1, scene: `Scene name ${Math.floor(i / 4) + 1}`, action: `Action for frame ${i + 1}.`, line: i % 3 ? "" : `JAKE: "Line ${i + 1}"` } }));
const board = (gid, extra = {}) => ({ id: gid, kind: "storyboard", title: "Hide & Haunt storyboard v1", locked: false, selection_limit: null,
  review_outcome: null, reviewed_at: null, ...extra,
  items: FRAMES.map((f) => ({ id: `${gid}-${f.meta.code}`, gallery_id: gid, filename: f.file, size_bytes: 400000, sort: f.sort, selected: false,
    content_type: "image/jpeg", meta: f.meta, client_note: (extra.notes || {})[f.meta.code] || null,
    url: `https://img.test/full/${f.file}`, thumb_url: `https://img.test/thumbs/${f.file}`, download_url: null })) });
const NAME = "Delilah Amaro";
const project = (id, extra) => ({ id, title: `${NAME} — Hide & Haunt Commercial`, status: "booked", service: "other", location: null,
  created_at: "2026-10-22T19:04:26Z", event_date: null, event_time: null, client_name: NAME, ...extra });
const msgs = () => [{ id: "m1", sender: "studio", created_at: "2026-10-24T21:01:29Z", body: "Hi Delilah, here's your quote." }];

const S = {
  board: () => ({ p: project("p-board"), galleries: [board("gb")] }),
  approve: () => ({ p: project("p-approve"), galleries: [board("ga")] }),
  round2: () => ({ p: project("p-round2"), galleries: [
    board("g1", { locked: true, review_outcome: "changes", reviewed_at: "2026-10-27T15:00:00Z", notes: { "3C": "Make him look at the camera." } }),
    { ...board("g2"), title: "Hide & Haunt storyboard v2" }] }),
  approved: () => ({ p: project("p-approved"), galleries: [board("gd", { locked: true, review_outcome: "approved", reviewed_at: "2026-10-27T15:00:00Z" })] }),
};
const state = {};
const get = (pid) => {
  if (state[pid]) return state[pid];
  const key = pid.slice(2);
  if (!S[key]) return null;
  const { p, galleries } = S[key]();
  return (state[pid] = { p, inv: [], galleries, contracts: [], msgs: msgs(), files: [] });
};
const calls = [];
const SVG = (label, w = 1280, h = 720) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#3a3f47"/><text x="40" y="90" font-size="56" fill="#fff">${label}</text></svg>`;

async function wire(page, errors) {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR|status of 40[039]/.test(m.text())) errors.push(m.text()); });
  await page.route("https://img.test/**", (route) => {
    const u = new URL(route.request().url());
    const [, dir, file] = u.pathname.split("/");
    const p = IMAGES && `${IMAGES}/${dir}/${file}`;
    if (p && existsSync(p)) return route.fulfill({ status: 200, contentType: "image/jpeg", body: readFileSync(p) });
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG(file) });
  });
  await page.route("**/rest/v1/rpc/**", async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON() || {};
    calls.push({ fn, body });
    if (fn === "bk_extra_edit_cents") return route.fulfill({ json: 3500 });
    const s = body.p_token === "tok" ? get(body.p_project) : null;
    if (!s) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "not_found" }) });
    if (fn === "bk_portal") return route.fulfill({ json: { project: s.p, invoices: s.inv, contracts: s.contracts, files: s.files, messages: s.msgs } });
    if (fn === "bk_portal_send") { s.msgs.push({ id: `m${s.msgs.length + 1}`, sender: "client", created_at: new Date().toISOString(), body: body.p_body }); return route.fulfill({ json: null }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/functions/v1/**", async (route) => {
    const body = route.request().postDataJSON() || {};
    calls.push({ fn: "bk-media", body });
    const s = body.token === "tok" ? get(body.project_id) : null;
    if (!s) return route.fulfill({ status: 403, json: { error: "forbidden" } });
    if (body.action === "list") return route.fulfill({ json: { projects: [{ id: s.p.id, title: s.p.title, client_name: s.p.client_name, service: s.p.service, status: s.p.status,
      galleries: JSON.parse(JSON.stringify(s.galleries.map(({ notes, ...g }) => g))) }] } });
    // mirrors bk-media: storyboards only, open only; the outcome comes from what's saved
    if (body.action === "storyboard_note") {
      const g = s.galleries.find((x) => x.items.some((i) => i.id === body.item_id));
      if (!g) return route.fulfill({ status: 404, json: { error: "not_found" } });
      if (g.locked) return route.fulfill({ status: 409, json: { error: "locked" } });
      const it = g.items.find((i) => i.id === body.item_id);
      const note = (body.note || "").trim().slice(0, 1000);
      it.client_note = note || null;
      return route.fulfill({ json: { ok: true, note: note || null } });
    }
    if (body.action === "storyboard_submit") {
      const g = s.galleries.find((x) => x.id === body.gallery_id);
      if (g.locked) return route.fulfill({ status: 409, json: { error: "already_submitted" } });
      const noted = g.items.filter((i) => i.client_note);
      const outcome = noted.length ? "changes" : "approved";
      if (body.expect && body.expect !== outcome) return route.fulfill({ status: 409, json: { error: "outcome_changed" } });
      Object.assign(g, { locked: true, review_outcome: outcome, reviewed_at: new Date().toISOString() });
      s.msgs.push({ id: `mr${s.msgs.length}`, sender: "client", created_at: new Date().toISOString(),
        body: outcome === "approved" ? `Approved the storyboard "${g.title}".` : `Requested changes on ${noted.length} frames` });
      return route.fulfill({ json: { ok: true, outcome, notes: noted.length, reviewed_at: g.reviewed_at } });
    }
    return route.fulfill({ status: 400, json: { error: "unknown_action" } });
  });
}

const url = (pid) => `${BASE}/portal.html?p=${pid}&t=tok`;
const text = async (page, sel) => ((await page.locator(sel).first().textContent()) || "").replace(/\s+/g, " ").trim();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const frame = (code) => `.sb-frame[data-id$="-${code}"]`;
// lazy frames below the fold only load near the screen (WebKit is stricter than Chromium), so wait on the first few
const waitImgs = (page, n = 6) => page.waitForFunction((n) => [...document.querySelectorAll(".sb-shot img")].slice(0, n).every((i) => i.complete && i.naturalWidth), n);

try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  const errors = [];
  const page = await ctx.newPage();
  await wire(page, errors);

  /* --- open storyboard: Delilah's first look --- */
  await page.goto(url("p-board"));
  await page.waitForSelector("#app:not([hidden])");
  await waitImgs(page);
  ok((await text(page, "#headline")) === "Your storyboard is ready.", "storyboard headline: " + await text(page, "#headline"));
  ok((await text(page, "#heroCta .btn")) === "Review your storyboard", "hero button");
  ok((await text(page, "#heroCta .hero-note")) === "27 frames · approve it or request changes", "hero note: " + await text(page, "#heroCta .hero-note"));
  ok((await text(page, "#pTitle")) === "Delilah Amaro — Hide & Haunt Commercial", "project title");
  ok((await page.locator("#tab-photos").getAttribute("aria-label")) === "Storyboard" && (await text(page, "#tab-photos .t-long")) === "Storyboard", "first tab is called Storyboard");
  ok((await page.locator(".tab[aria-selected=true]").getAttribute("id")) === "tab-photos", "storyboard tab opens first");
  ok((await page.locator(".sb-scene").count()) === 8, "8 scenes");
  ok((await page.locator(".sb-frame").count()) === 27, "27 frames");
  const lone = await page.evaluate(() => [...document.querySelectorAll(".sb-frames")].filter((l) => l.children.length % 2).every((l) => {
    const r = l.lastElementChild.getBoundingClientRect(), w = l.getBoundingClientRect().width; return Math.abs(r.width - w) < 2; }));
  ok(lone, "an odd last frame spans the full row (no hole in the grid)");
  ok((await text(page, ".sb-scene-h h3")) === (FRAMES[0].meta.scene), "first scene name");
  ok((await text(page, ".sb-scene-n")) === "Scene 01", "scene number label");
  ok((await page.locator(".sb a[href]").count()) === 0, "no download links anywhere in the storyboard");
  ok(!/Shoot date/.test(await page.locator("#railFacts").innerText()), "no 'Shoot date: To be set' for a project with no shoot");
  ok((await page.locator(".sb-bar .g-count").innerText()) === "27 frames · no changes requested", "bar count");
  ok((await text(page, ".sb-bar [data-sb=review]")) === "Approve storyboard", "bar offers approve with no notes");
  ok(await page.locator(".sb-bar.live").count() === 1, "review bar is live (sticky) while open");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/1-open-1536.png` });
    await page.screenshot({ path: `${SHOTS}/1-open-1536-full.png`, fullPage: true });
  }

  // hero button brings the storyboard into view
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click("#heroCta .btn");
  await page.waitForTimeout(700);
  ok((await page.evaluate(() => Math.abs(document.querySelector(".sb").getBoundingClientRect().top))) < 140, "hero button scrolls to the storyboard");

  // request a change on 3C
  await page.click(`${frame("3C")} [data-sb=edit]`);
  ok((await page.evaluate(() => document.activeElement.tagName)) === "TEXTAREA", "note box opens focused");
  ok((await text(page, `${frame("3C")} label`)) === "What should change in 3C?", "note label names the frame");
  await page.fill(`${frame("3C")} textarea`, "Make him look right at the camera.");
  await page.click(`${frame("3C")} [type=submit]`);
  await page.waitForSelector(`${frame("3C")}.has-note`);
  ok((await text(page, `${frame("3C")} .sb-note-t`)) === "Make him look right at the camera.", "saved note shows on the frame");
  ok((await text(page, `${frame("3C")} .sb-tag`)) === "Change requested", "change tag");
  ok(calls.some((c) => c.body.action === "storyboard_note" && c.body.item_id === "gb-3C" && c.body.note === "Make him look right at the camera."), "note saved to the server");
  ok((await page.locator(".sb-bar .g-count").innerText()) === "27 frames · 1 change requested", "bar counts the change");
  ok((await text(page, ".sb-bar [data-sb=review]")) === "Send 1 change to Nelson", "bar switches to send");
  ok(/Note saved on 3C/.test(await text(page, ".g-toast")), "toast confirms the save");
  if (SHOTS) await page.locator(frame("3C")).screenshot({ path: `${SHOTS}/2-note-frame.png` });

  // edit it, Escape on an unchanged box closes it, Cancel closes
  await page.click(`${frame("3C")} [data-sb=edit]`);
  ok((await page.inputValue(`${frame("3C")} textarea`)) === "Make him look right at the camera.", "edit opens with the saved note");
  await page.keyboard.press("Escape");
  ok(await page.locator(`${frame("3C")} textarea`).count() === 0, "Escape closes an unchanged note");
  await page.click(`${frame("1A")} [data-sb=edit]`);
  await page.click(`${frame("1A")} [data-sb=cancel]`);
  ok(await page.locator(`${frame("1A")} textarea`).count() === 0 && (await page.evaluate(() => document.activeElement.dataset.sb)) === "edit", "Cancel closes and returns focus");
  await page.click(`${frame("1A")} [data-sb=edit]`);
  await page.click(`${frame("1A")} [type=submit]`);
  ok(await page.locator(`${frame("1A")} textarea`).count() === 0 && !(await page.locator(`${frame("1A")}.has-note`).count()), "saving an empty note just closes it");

  // viewer: opens on the frame, caption, arrows, the note button jumps back to the note box
  await page.click(`${frame("3C")} .sb-shot`);
  await page.waitForSelector(".g-lightbox:not([hidden])");
  const idx3C = FRAMES.findIndex((f) => f.meta.code === "3C") + 1;
  ok((await text(page, ".g-lb-count")) === `${idx3C} / 27`, "viewer opens on 3C");
  ok((await text(page, ".g-lb-name")) === `Scene 3 · ${FRAMES[idx3C - 1].meta.scene}`, "viewer names the scene: " + await text(page, ".g-lb-name"));
  ok((await text(page, ".sb-lb-cap b")) === `3C · ${FRAMES[idx3C - 1].meta.tc}`, "viewer caption");
  ok((await text(page, ".sb-lb-ask")) === "Edit your note", "viewer offers to edit the note");
  ok((await page.locator(".g-lb-bar a").count()) === 0, "no download in the viewer");
  await page.keyboard.press("ArrowRight");
  ok((await text(page, ".g-lb-count")) === `${idx3C + 1} / 27` && (await text(page, ".sb-lb-ask")) === "Request a change", "arrow steps to the next frame");
  await page.click(".sb-lb-ask");
  ok(await page.locator(".g-lightbox").isHidden(), "Request a change closes the viewer");
  const nextCode = FRAMES[idx3C].meta.code;
  ok((await page.evaluate(() => document.activeElement.closest(".sb-frame")?.dataset.id)) === `gb-${nextCode}`, "and opens the note on that frame");

  // an unsaved note blocks the review until it's saved or cancelled
  await page.fill(`${frame(nextCode)} textarea`, "half a thought");
  await page.click(".sb-bar [data-sb=review]");
  await page.click(".sb-bar [data-sb=send]");
  ok(/Save or cancel your open note first/.test(await text(page, ".g-toast")), "unsaved note blocks sending");
  ok((await page.evaluate(() => document.activeElement.tagName)) === "TEXTAREA", "and focuses it");
  ok(!calls.some((c) => c.body.action === "storyboard_submit"), "nothing was sent");
  await page.click(`${frame(nextCode)} [data-sb=cancel]`);

  // reload: the note is still there
  await page.reload();
  await page.waitForSelector(".sb-frame");
  ok(await page.locator(`${frame("3C")}.has-note`).count() === 1, "note survives a reload");
  ok((await text(page, ".sb-bar [data-sb=review]")) === "Send 1 change to Nelson", "bar after reload");

  // send the notes
  await page.click(".sb-bar [data-sb=review]");
  ok(/Send your 1 note to Nelson\? He'll update that frame/.test(await text(page, ".sb-bar .g-confirm")), "confirm says what happens next");
  await page.click(".sb-bar [data-sb=back]");
  ok((await page.evaluate(() => document.activeElement.dataset.sb)) === "review", "Keep reviewing returns focus");
  await page.click(".sb-bar [data-sb=review]");
  await page.click(".sb-bar [data-sb=send]");
  await page.waitForSelector(".sb-bar:not(.live)");
  ok(calls.some((c) => c.body.action === "storyboard_submit" && c.body.expect === "changes"), "submit sent with notes");
  ok((await text(page, ".sb-bar .g-sent")) === "Notes sent · 1 change", "bar shows notes sent");
  ok(await page.locator(".sb-status").isVisible() && (await text(page, ".sb-status .g-sent")) === "Notes sent · 1 change", "status shows at the top of the storyboard too");
  await page.waitForTimeout(700);
  ok((await page.evaluate(() => Math.abs(document.querySelector(".sb").getBoundingClientRect().top))) < 140, "sending lands them on the status at the top");
  ok((await text(page, "#headline")) === "Your notes are with Nelson.", "hero follows: " + await text(page, "#headline"));
  ok(await page.locator(".sb [data-sb]").count() === 0, "no edit controls once sent");
  ok(await page.locator(`${frame("3C")} .sb-note-t`).count() === 1, "the note stays visible, read only");
  ok(await page.locator(".sb .g-intro").count() === 0, "intro drops once sent");
  ok(state["p-board"].msgs.some((m) => /Requested changes/.test(m.body)), "a message lands in the thread");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-sent-1536.png` });
  await page.reload();
  await page.waitForSelector(".sb-frame");
  ok((await text(page, "#headline")) === "Your notes are with Nelson." && (await text(page, "#tab-photos .t-long")) === "Storyboard", "sent state after reload");

  /* --- approve path --- */
  await page.goto(url("p-approve"));
  await page.waitForSelector(".sb-frame");
  await page.click(".sb-bar [data-sb=review]");
  ok((await text(page, ".sb-bar .g-confirm")) === "Approve the storyboard? Once it's approved, the story is locked and Nelson starts production.", "approve confirm restates the story lock");
  await page.click(".sb-bar [data-sb=send]");
  await page.waitForSelector(".sb-bar:not(.live)");
  ok(calls.some((c) => c.body.action === "storyboard_submit" && c.body.expect === "approved"), "approve sent");
  ok(/^Storyboard approved/.test(await text(page, ".sb-bar .g-sent")), "approved chip");
  ok((await text(page, "#headline")) === "Storyboard approved.", "approved hero");
  ok(/Storyboard approved\. Nelson has it\./.test(await text(page, ".g-toast")), "approve toast");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-approved-1536.png` });

  /* --- remove a note: back to approve --- */
  await page.goto(url("p-board").replace("p-board", "p-round2"));
  await page.waitForSelector(".sb-frame");
  ok((await text(page, "#headline")) === "Your storyboard is ready.", "round two: the new version is up for review");
  ok(await page.locator(".sb-old").count() === 1 && /Earlier version/.test(await text(page, ".sb-past .g-h")), "earlier round folds away");
  ok(/1 change sent/.test(await text(page, ".sb-old summary small")), "earlier round summary");
  ok(await page.locator(".sb-bar").count() === 1, "only the current round has a review bar");
  await page.click(`.sb:not(.sb-past) ${frame("2B")} [data-sb=edit]`);
  await page.fill(`.sb:not(.sb-past) ${frame("2B")} textarea`, "Brighter.");
  await page.click(`.sb:not(.sb-past) ${frame("2B")} [type=submit]`);
  await page.waitForSelector(`.sb:not(.sb-past) ${frame("2B")}.has-note`);
  await page.click(`.sb:not(.sb-past) ${frame("2B")} [data-sb=remove]`);
  await page.waitForFunction(() => !document.querySelector(".sb:not(.sb-past) .sb-frame.has-note"));
  ok((await text(page, ".sb:not(.sb-past) .sb-bar [data-sb=review]")) === "Approve storyboard", "removing the only note brings back approve");

  /* --- already approved --- */
  await page.goto(url("p-approved"));
  await page.waitForSelector(".sb-frame");
  ok((await text(page, "#headline")) === "Storyboard approved." && await page.locator(".sb [data-sb]").count() === 0, "approved project loads read only");

  ok(!errors.length, "no console errors: " + errors.join(" | "));

  /* --- phone --- */
  const phones = [["chromium", browser]];
  if (process.env.PW_WEBKIT) {
    const { webkit } = await import(process.env.PW_WEBKIT);
    phones.push(["webkit", await webkit.launch()]);
  }
  for (const [name, b] of phones) {
    const pctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: name === "chromium", hasTouch: true });
    const ph = await pctx.newPage();
    const perr = [];
    await wire(ph, perr);
    delete state["p-board"];
    await ph.goto(url("p-board"));
    await ph.waitForSelector(".sb-frame");
    await waitImgs(ph, 1);
    ok((await overflow(ph)) <= 0, `${name} phone: no sideways scroll`);
    const cols = await ph.evaluate(() => getComputedStyle(document.querySelector(".sb-frames")).gridTemplateColumns.split(" ").length);
    ok(cols === 1, `${name} phone: one frame per row`);
    const askW = await ph.evaluate(() => document.querySelector(".sb-ask").getBoundingClientRect().height);
    ok(askW >= 44, `${name} phone: tap target ${askW}px`);
    if (SHOTS) await ph.screenshot({ path: `${SHOTS}/5-phone-${name}-top.png` });
    await ph.evaluate(() => document.querySelector(".sb-scene:nth-child(3)").scrollIntoView());
    await ph.waitForTimeout(300);
    const barBottom = await ph.evaluate(() => document.querySelector(".sb-bar").getBoundingClientRect().bottom);
    ok(barBottom <= 844 && barBottom > 700, `${name} phone: review bar sticks to the bottom (${Math.round(barBottom)})`);
    const barH = await ph.evaluate(() => document.querySelector(".sb-bar").getBoundingClientRect().height);
    ok(barH <= 72, `${name} phone: review bar is one compact row (${Math.round(barH)}px)`);
    ok((await ph.locator(".sb-bar .g-count").innerText()) === "No changes", `${name} phone: short count`);
    await ph.tap(`${frame("3C")} [data-sb=edit]`);
    await ph.fill(`${frame("3C")} textarea`, "Make him look right at the camera.");
    if (SHOTS) { await ph.evaluate(() => document.querySelector('.sb-frame[data-id$="-3C"]').scrollIntoView({ block: "center" })); await ph.screenshot({ path: `${SHOTS}/6-phone-${name}-note.png` }); }
    await ph.tap(`${frame("3C")} [type=submit]`);
    await ph.waitForSelector(`${frame("3C")}.has-note`);
    await ph.tap(`${frame("4B")} .sb-shot`);
    await ph.waitForSelector(".g-lightbox:not([hidden])");
    if (SHOTS) await ph.screenshot({ path: `${SHOTS}/7-phone-${name}-viewer.png` });
    ok((await overflow(ph)) <= 0, `${name} phone viewer: no sideways scroll`);
    ok(!perr.length, `${name} phone: no console errors: ` + perr.join(" | "));
    await pctx.close();
    if (b !== browser) await b.close();
  }
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await done();
  console.log(`${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}
