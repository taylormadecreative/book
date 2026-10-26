// Stubbed UI test for storyboard review in the client portal (portal.html). Serves the repo locally;
// every Supabase call is intercepted, so it never touches prod. The stub mirrors what bk-media and the
// bk_storyboard_* functions decide (tests/storyboard-rpc.pglite.mjs tests those for real).
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
const PAY = "https://pay.test/invoice/hide-and-haunt-deposit";
const board = (gid, extra = {}) => ({ id: gid, kind: "storyboard", title: "Hide & Haunt storyboard v1", locked: false, selection_limit: null,
  review_outcome: null, reviewed_at: null, pay_url: null, ...extra,
  items: FRAMES.map((f) => ({ id: `${gid}-${f.meta.code}`, gallery_id: gid, filename: f.file, size_bytes: 400000, sort: f.sort, selected: false,
    content_type: "image/jpeg", meta: f.meta, client_note: (extra.notes || {})[f.meta.code] || null,
    url: `https://img.test/full/${f.file}`, thumb_url: `https://img.test/thumbs/${f.file}`, download_url: null })) });
const NAME = "Delilah Amaro";
const project = (id, extra) => ({ id, title: `${NAME} — Hide & Haunt Commercial`, status: "booked", service: "other", location: null,
  created_at: "2026-10-22T19:04:26Z", event_date: null, event_time: null, client_name: NAME, ...extra });
const msgs = () => [{ id: "m1", sender: "studio", created_at: "2026-10-24T21:01:29Z", body: "Hi Delilah, here's your quote." }];

const S = {
  board: () => ({ p: project("p-board"), galleries: [board("gb", { pay_url: PAY })] }),
  approve: () => ({ p: project("p-approve"), galleries: [board("ga", { pay_url: PAY })] }),
  nopay: () => ({ p: project("p-nopay"), galleries: [board("gn")] }),
  round2: () => ({ p: project("p-round2"), galleries: [
    board("g1", { locked: true, review_outcome: "changes", reviewed_at: "2026-10-27T15:00:00Z", notes: { "3C": "Make him look at the camera." } }),
    { ...board("g2"), title: "Hide & Haunt storyboard v2" }] }),
  approved: () => ({ p: project("p-approved"), galleries: [board("gd", { locked: true, review_outcome: "approved", reviewed_at: "2026-10-27T15:00:00Z", pay_url: PAY })] }),
  // Nelson still uploading: a draft (locked, never reviewed) and an empty board are never shown
  draft: () => ({ p: project("p-draft"), galleries: [board("gx", { locked: true }), { ...board("ge"), items: [] }] }),
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
const hiddenBoard = (g) => g.kind === "storyboard" && ((g.locked && !g.review_outcome) || !g.items.length);
const live = (s) => s.galleries.filter((g) => !hiddenBoard(g));

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
  await page.route("https://pay.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>HoneyBook invoice</title><h1>Deposit</h1>" }));
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
      galleries: JSON.parse(JSON.stringify(live(s).map(({ notes, ...g }) => g))) }] } });
    const boards = live(s).filter((g) => g.kind === "storyboard");
    const superseded = (g) => boards.indexOf(g) < boards.length - 1;
    if (body.action === "storyboard_note") {
      const g = s.galleries.find((x) => x.items.some((i) => i.id === body.item_id));
      if (!g) return route.fulfill({ status: 404, json: { error: "not_found" } });
      if (g.locked) return route.fulfill({ status: 409, json: { error: "locked" } });
      if (superseded(g)) return route.fulfill({ status: 409, json: { error: "superseded" } });
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
      if ((body.expect && body.expect !== outcome) || (Number.isInteger(body.expect_notes) && body.expect_notes !== noted.length)) {
        return route.fulfill({ status: 409, json: { error: "outcome_changed" } });
      }
      Object.assign(g, { locked: true, review_outcome: outcome, reviewed_at: new Date().toISOString() });
      s.msgs.push({ id: `mr${s.msgs.length}`, sender: "client", created_at: new Date().toISOString(),
        body: outcome === "approved" ? `I approved the storyboard "${g.title}" (${g.items.length} frames).` : `My notes on ${noted.length} frames of "${g.title}":` });
      return route.fulfill({ json: { ok: true, outcome, notes: noted.length, reviewed_at: g.reviewed_at, pay_url: outcome === "approved" ? g.pay_url : null } });
    }
    return route.fulfill({ status: 400, json: { error: "unknown_action" } });
  });
}

const url = (pid) => `${BASE}/portal.html?p=${pid}&t=tok`;
const text = async (page, sel) => ((await page.locator(sel).first().textContent()) || "").replace(/\s+/g, " ").trim();
const seen = async (page, sel) => ((await page.locator(sel).first().innerText()) || "").replace(/\s+/g, " ").trim();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const frame = (code) => `.sb-frame[data-id$="-${code}"]`;
const waitImgs = (page, n = 6) => page.waitForFunction((n) => [...document.querySelectorAll(".sb-shot img")].slice(0, n).every((i) => i.complete && i.naturalWidth), n);
const armed = (page) => page.evaluate(() => { const b = document.querySelector(".sb-bar.live"); return !!b && b.classList.contains("armed") && getComputedStyle(b).visibility === "visible"; });
const toEnd = async (page) => { await page.evaluate(() => document.querySelector(".sb-end").scrollIntoView({ block: "end" })); await page.waitForSelector(".sb-bar [data-sb=review]"); };
const reviewSent = () => calls.filter((c) => c.body.action === "storyboard_submit").length;
const idx = (c) => FRAMES.findIndex((f) => f.meta.code === c) + 1;

try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  const errors = [];
  const page = await ctx.newPage();
  await wire(page, errors);

  /* --- Delilah's first look --- */
  await page.goto(url("p-board"));
  await page.waitForSelector("#app:not([hidden])");
  await waitImgs(page);
  ok((await text(page, "#headline")) === "Your storyboard is ready.", "storyboard headline: " + await text(page, "#headline"));
  ok((await text(page, "#heroCta .btn")) === "Review your storyboard", "hero button");
  ok((await text(page, "#heroCta .hero-note")) === "27 frames · approve it or request changes", "hero note");
  ok((await text(page, "#pTitle")) === "Delilah Amaro — Hide & Haunt Commercial", "project title");
  ok((await text(page, "#tab-photos .t-long")) === "Storyboard", "first tab is called Storyboard");
  ok((await page.locator(".tab[aria-selected=true]").getAttribute("id")) === "tab-photos", "storyboard tab opens first");
  ok((await page.locator(".sb-scene").count()) === 8 && (await page.locator(".sb-frame").count()) === 27, "8 scenes, 27 frames");
  ok((await text(page, ".sb-scene-n")) === "Scene 01" && (await text(page, ".sb-scene-h h3")) === FRAMES[0].meta.scene, "scene label + name");
  ok(/The story is set, so notes are about how a shot looks/.test(await text(page, ".g-intro")), "intro says what notes are for");
  ok((await page.locator(".sb a[href]").count()) === 0, "no download links anywhere in the storyboard");
  ok(!/Shoot date/.test(await page.locator("#railFacts").innerText()), "no 'Shoot date: To be set' for a project with no shoot");
  // featured frames: Nelson's picks + odd runs, and no row left with a hole
  const feats = await page.$$eval(".sb-feat", (els) => els.map((e) => e.dataset.id.split("-").pop()));
  if (IMAGES) ok(JSON.stringify(feats) === JSON.stringify(["3E", "4C", "5A", "6C", "7A", "8B", "8C"]), "featured frames: " + feats.join(","));
  const holes = await page.evaluate(() => [...document.querySelectorAll(".sb-frames")].some((l) => {
    let run = 0;
    for (const li of l.children) { if (li.classList.contains("sb-feat")) { if (run % 2) return true; run = 0; } else run++; }
    return run % 2 === 1;
  }));
  ok(!holes, "every row is full (pairs + featured frames)");
  if (IMAGES) ok((await page.$eval(`${frame("1D")} .sb-line`, (e) => e.textContent)).includes("“Bro, this place is HUGE!”"), "dialogue gets typographic quotes");
  if (IMAGES) ok(JSON.stringify(await page.$$eval(`${frame("4C")} .sb-cue .sb-who`, (els) => els.map((e) => e.textContent))) === '["ANNOUNCER","SOUND"]', "two cues in one caption get a line each");
  if (IMAGES) ok((await text(page, `${frame("5B")} .sb-who`)) === "SEEKER (whispering)", "a stage direction stays in the speaker label");
  ok(!(await armed(page)), "the review bar waits: not over the intro on the first screen");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/1-open-1536.png` });
    // the middle of the board: featured frames between pairs (scenes 3, 5, 7)
    for (const n of [3, 5, 7]) {
      const sc = page.locator(`.sb-scene:nth-child(${n})`);
      await sc.scrollIntoViewIfNeeded();
      await page.evaluate((n) => Promise.all([...document.querySelectorAll(`.sb-scene:nth-child(${n}) img`)].map((i) => { i.loading = "eager"; return i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }); })), n);
      await sc.screenshot({ path: `${SHOTS}/1-scene-${n}.png` });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  }

  // hero button brings the storyboard into view, and the bar shows up as a scene guide
  await page.click("#heroCta .btn");
  await page.waitForTimeout(800);
  ok((await page.evaluate(() => Math.abs(document.querySelector(".sb").getBoundingClientRect().top))) < 140, "hero button scrolls to the storyboard");
  ok(await armed(page), "bar shows once the frames do");
  ok((await seen(page, ".sb-bar .g-count")) === "Scene 01 of 08 · no notes yet", "bar shows the scene: " + await seen(page, ".sb-bar .g-count"));
  ok((await text(page, ".sb-bar [data-sb=next]")) === "Next scene" && !(await page.locator(".sb-bar [data-sb=review]").count()), "no Approve before she's seen the frames");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-scene-guide-1536.png` });
  await page.click(".sb-bar [data-sb=next]");
  await page.waitForTimeout(900);
  ok((await seen(page, ".sb-bar .g-count")).startsWith("Scene 02 of 08"), "Next scene moves on: " + await seen(page, ".sb-bar .g-count"));
  ok((await page.evaluate(() => document.activeElement.dataset.sb)) === "next", "focus stays on Next scene");

  // request a change on 3C
  await page.click(`${frame("3C")} [data-sb=edit]`);
  ok((await page.evaluate(() => document.activeElement.tagName)) === "TEXTAREA", "note box opens focused");
  ok((await text(page, `${frame("3C")} label`)) === "What should change in 3C?", "note label names the frame");
  ok((await seen(page, ".sb-bar .g-count")) === "Note open on 3C" && (await text(page, ".sb-bar [data-sb=goto]")) === "Go to note", "bar asks to finish the note");
  ok(!(await page.locator(".sb-bar .btn-gold").count()), "no second gold button while a note is open");
  await page.fill(`${frame("3C")} textarea`, "Make him look right at the camera.");
  await page.keyboard.press("Escape");
  ok(/Save or cancel this note first/.test(await text(page, ".g-toast")) && await page.locator(`${frame("3C")} textarea`).count() === 1, "Escape doesn't throw away typed words");
  await page.click(`${frame("3C")} [type=submit]`);
  await page.waitForSelector(`${frame("3C")}.has-note`);
  ok((await text(page, `${frame("3C")} .sb-note-t`)) === "Make him look right at the camera.", "saved note shows on the frame");
  ok((await text(page, `${frame("3C")} .sb-tag`)) === "Change requested", "change tag");
  ok(calls.some((c) => c.body.action === "storyboard_note" && c.body.item_id === "gb-3C" && c.body.note === "Make him look right at the camera."), "note saved to the server");
  ok(/Note saved on 3C/.test(await text(page, ".g-toast")), "toast confirms the save");
  ok(/· 1 change requested$/.test(await seen(page, ".sb-bar .g-count")), "bar counts the change: " + await seen(page, ".sb-bar .g-count"));
  if (SHOTS) await page.locator(frame("3C")).screenshot({ path: `${SHOTS}/3-note-frame.png` });

  // edit: Escape on an unchanged box closes it; Cancel with typed words asks first
  await page.click(`${frame("3C")} [data-sb=edit]`);
  ok((await page.inputValue(`${frame("3C")} textarea`)) === "Make him look right at the camera.", "edit opens with the saved note");
  await page.keyboard.press("Escape");
  ok(await page.locator(`${frame("3C")} textarea`).count() === 0, "Escape closes an unchanged note");
  await page.click(`${frame("1A")} [data-sb=edit]`);
  await page.click(`${frame("1A")} [data-sb=cancel]`);
  ok(await page.locator(`${frame("1A")} textarea`).count() === 0 && (await page.evaluate(() => document.activeElement.dataset.sb)) === "edit", "Cancel on an empty note closes and returns focus");
  await page.click(`${frame("1B")} [data-sb=edit]`);
  await page.fill(`${frame("1B")} textarea`, "Warmer light.");
  await page.click(`${frame("1B")} [data-sb=cancel]`);
  ok((await text(page, `${frame("1B")} [data-sb=cancel]`)) === "Discard changes?" && await page.locator(`${frame("1B")} textarea`).count() === 1, "Cancel with typed words asks first");
  await page.click(`${frame("1B")} [data-sb=cancel]`);
  ok(await page.locator(`${frame("1B")} textarea`).count() === 0 && !(await page.locator(`${frame("1B")}.has-note`).count()), "second tap discards");

  // remove takes two taps
  await page.click(`${frame("2A")} [data-sb=edit]`);
  await page.fill(`${frame("2A")} textarea`, "Closer on the scanner.");
  await page.click(`${frame("2A")} [type=submit]`);
  await page.waitForSelector(`${frame("2A")}.has-note`);
  await page.click(`${frame("2A")} [data-sb=remove]`);
  ok((await text(page, `${frame("2A")} [data-sb=remove]`)) === "Yes, remove it" && await page.locator(`${frame("2A")}.has-note`).count() === 1, "Remove asks once");
  await page.click(`${frame("2A")} [data-sb=remove]`);
  await page.waitForFunction(() => !document.querySelector('.sb-frame[data-id$="-2A"].has-note'));
  ok(/Note removed from 2A/.test(await text(page, ".g-toast")), "second tap removes");

  // viewer: frame, caption, line, her note, labels; Request a change jumps back to the note box
  await page.click(`${frame("3C")} .sb-shot`);
  await page.waitForSelector(".g-lightbox:not([hidden])");
  ok((await text(page, ".g-lb-count")) === `${idx("3C")} / 27`, "viewer opens on 3C");
  ok((await text(page, ".g-lb-name")) === `Scene 03 · ${FRAMES[idx("3C") - 1].meta.scene}`, "viewer names the scene (padded like the page)");
  ok((await page.getAttribute(".g-lightbox", "aria-label")) === "Storyboard viewer" && (await page.getAttribute(".g-lb-nav.next", "aria-label")) === "Next frame", "viewer labels say frame, not photo");
  ok((await text(page, ".sb-lb-cap b")) === `3C · ${FRAMES[idx("3C") - 1].meta.tc}`, "viewer caption");
  ok(/Your note Make him look right at the camera\./.test(await text(page, ".sb-lb-note")), "viewer shows her note");
  ok((await text(page, ".sb-lb-ask")) === "Edit your note", "viewer offers to edit the note");
  ok((await page.locator(".g-lb-bar a").count()) === 0, "no download in the viewer");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  if (IMAGES) ok((await text(page, ".g-lb-count")) === `${idx("3E")} / 27` && /RUN!/.test(await text(page, ".sb-lb-line")), "the dialogue line shows in the viewer");
  await page.click(".sb-lb-ask");
  ok(await page.locator(".g-lightbox").isHidden(), "Request a change closes the viewer");
  const opened = await page.evaluate(() => document.activeElement.closest(".sb-frame")?.dataset.id);
  ok(opened === `gb-${FRAMES[idx("3C") + 1].meta.code}`, "and opens the note on that frame: " + opened);
  const lateCode = opened.split("-").pop();

  // a half-written note survives a reload
  await page.fill(`${frame(lateCode)} textarea`, "Louder scream");
  await page.reload();
  await page.waitForSelector(".sb-frame");
  ok((await page.inputValue(`${frame(lateCode)} textarea`)) === "Louder scream", "unsaved note is back after a reload");
  await page.waitForTimeout(800);
  ok(/Your unsaved note is still here/.test(await text(page, ".g-toast")), "and she's told");
  ok(await page.locator(`${frame("3C")}.has-note`).count() === 1, "saved note survives a reload");
  await page.click(`${frame(lateCode)} [data-sb=cancel]`); await page.click(`${frame(lateCode)} [data-sb=cancel]`);

  // the end: Approve/Send only once every frame has been on screen
  await toEnd(page);
  ok((await seen(page, ".sb-bar .g-count")) === "27 frames · 1 change requested", "bar at the end: " + await seen(page, ".sb-bar .g-count"));
  ok((await text(page, ".sb-bar [data-sb=review]")) === "Send 1 change to Nelson", "bar offers to send");
  // a double tap can't send: Yes waits a beat, focus starts on Keep reviewing
  const box = await page.locator(".sb-bar [data-sb=review]").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  ok((await page.evaluate(() => document.activeElement.dataset.sb)) === "back", "focus starts on Keep reviewing");
  const yes = await page.locator(".sb-bar [data-sb=send]").boundingBox();
  await page.mouse.click(yes.x + yes.width / 2, yes.y + yes.height / 2);
  await page.waitForTimeout(300);
  ok(reviewSent() === 0, "a fast second tap on Yes does nothing");
  ok(/Send your 1 note to Nelson\? He'll go over it and send updated frames back here\./.test(await text(page, ".sb-bar .g-confirm")), "confirm says what happens next");
  await page.click(".sb-bar [data-sb=back]");
  ok((await page.evaluate(() => document.activeElement.dataset.sb)) === "review", "Keep reviewing returns focus");
  // a reload remembers she's been to the end
  await page.reload();
  await page.waitForSelector(".sb-frame");
  await page.click("#heroCta .btn");
  await page.waitForTimeout(800);
  ok((await text(page, ".sb-bar [data-sb=review]")) === "Send 1 change to Nelson", "after a reload she doesn't have to scroll the whole thing again");
  await page.click(".sb-bar [data-sb=review]");
  await page.click(".sb-bar [data-sb=send]");
  await page.waitForSelector(".sb-bar:not(.live)");
  ok(calls.some((c) => c.body.action === "storyboard_submit" && c.body.expect === "changes" && c.body.expect_notes === 1), "submit sent with the note count");
  ok((await text(page, ".sb-bar .g-sent")) === "Notes sent · 1 change", "bar shows notes sent");
  ok((await text(page, ".sb-status .g-sent")) === "Notes sent · 1 change" && /Nelson is going over your notes/.test(await text(page, ".sb-status")), "status at the top too");
  await page.waitForTimeout(800);
  ok((await page.evaluate(() => Math.abs(document.querySelector(".sb").getBoundingClientRect().top))) < 140, "sending lands them on the status");
  ok((await text(page, "#headline")) === "Your notes are with Nelson.", "hero follows");
  ok(await page.locator(".sb [data-sb]").count() === 0 && await page.locator(".sb .g-intro").count() === 0, "read only once sent");
  ok(state["p-board"].msgs.some((m) => /^My notes on 1 frame/.test(m.body)), "a message lands in the thread");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-sent-1536.png` });
  await page.click(".sb-status [data-open-messages]");
  ok((await page.locator(".tab[aria-selected=true]").getAttribute("id")) === "tab-messages", "Message Nelson opens the thread");

  /* --- approve: straight to the deposit on HoneyBook --- */
  await page.goto(url("p-approve"));
  await page.waitForSelector(".sb-frame");
  await toEnd(page);
  ok((await seen(page, ".sb-bar .g-count")) === "27 frames · no notes yet", "bar at the end with no notes");
  await page.click(".sb-bar [data-sb=review]");
  ok((await text(page, ".sb-bar .g-confirm")) === "Approve the storyboard? Notes close after this, and you'll go straight to your deposit invoice on HoneyBook. Production starts once it's paid.", "approve confirm names the deposit");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-approve-confirm-1536.png` });
  await page.click(".sb-bar [data-sb=send]");
  await page.waitForURL(PAY, { timeout: 6000 });
  ok(page.url() === PAY, "approving opens her deposit invoice");
  ok(calls.some((c) => c.body.action === "storyboard_submit" && c.body.expect === "approved" && c.body.expect_notes === 0), "approve sent");
  ok(state["p-approve"].msgs.some((m) => m.body === 'I approved the storyboard "Hide & Haunt storyboard v1" (27 frames).'), "Nelson's message in her voice");

  /* --- coming back after approving --- */
  await page.goto(url("p-approved"));
  await page.waitForSelector(".sb-frame");
  ok((await text(page, "#headline")) === "Storyboard approved." && (await text(page, "#heroCta .btn")) === "Pay your deposit", "hero offers the deposit");
  ok((await text(page, "#heroCta .hero-note")) === "On HoneyBook · production starts once it's paid", "hero note");
  ok((await page.getAttribute(".sb-status .sb-pay", "href")) === PAY && await page.locator(".sb [data-sb]").count() === 0, "status links the deposit, read only");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/6-approved-1536.png` });
  await page.click("#heroCta .btn");
  await page.waitForURL(PAY, { timeout: 6000 });
  ok(page.url() === PAY, "Pay your deposit opens the invoice");

  /* --- no deposit link set yet --- */
  await page.goto(url("p-nopay"));
  await page.waitForSelector(".sb-frame");
  await toEnd(page);
  await page.click(".sb-bar [data-sb=review]");
  ok((await text(page, ".sb-bar .g-confirm")) === "Approve the storyboard? Notes close after this. Next is your deposit, and production starts once it's paid.", "confirm without a link");
  await page.click(".sb-bar [data-sb=send]");
  await page.waitForSelector(".sb-bar:not(.live)");
  ok(/^Storyboard approved/.test(await text(page, ".sb-status .g-sent")) && /Next is your deposit/.test(await text(page, ".sb-status")), "approved status without a link");
  ok((await text(page, "#headline")) === "Storyboard approved." && /Nelson will send your invoice/.test(await text(page, "#heroCta")), "hero without a link");

  /* --- round two: the earlier round folds away, read only --- */
  await page.goto(url("p-round2"));
  await page.waitForSelector(".sb-frame");
  ok((await text(page, "#headline")) === "Your storyboard is ready.", "round two is up for review");
  ok(await page.locator(".sb-old").count() === 1 && /Earlier version/.test(await text(page, ".sb-past .g-h")), "earlier round folds away");
  ok(/1 change sent/.test(await text(page, ".sb-old summary small")), "earlier round summary");
  ok(await page.locator(".sb-past [data-sb]").count() === 0, "earlier round takes no notes");
  ok(await page.locator(".sb-bar").count() === 1, "only the current round has a review bar");

  /* --- Nelson still uploading: nothing shows --- */
  await page.goto(url("p-draft"));
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForTimeout(600);
  ok(await page.locator(".sb").count() === 0 && (await text(page, "#headline")) !== "Your storyboard is ready.", "a draft or empty storyboard is never shown");

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
    ok(!(await armed(ph)), `${name} phone: bar not over the intro`);
    if (SHOTS) await ph.screenshot({ path: `${SHOTS}/7-phone-${name}-top.png` });
    const cols = await ph.evaluate(() => getComputedStyle(document.querySelector(".sb-frames")).gridTemplateColumns.split(" ").length);
    ok(cols === 1, `${name} phone: one frame per row`);
    ok((await ph.evaluate(() => document.querySelector(".sb-ask").getBoundingClientRect().height)) >= 44, `${name} phone: 44px tap target`);
    await ph.evaluate(() => document.querySelector(".sb-scene:nth-child(3)").scrollIntoView());
    await ph.waitForTimeout(400);
    ok(await armed(ph), `${name} phone: bar shows in the frames`);
    const bar = await ph.evaluate(() => { const r = document.querySelector(".sb-bar").getBoundingClientRect(); return { bottom: r.bottom, h: r.height }; });
    ok(bar.bottom <= 844 && bar.bottom > 700 && bar.h <= 72, `${name} phone: one compact row at the bottom (${Math.round(bar.bottom)}, ${Math.round(bar.h)}px)`);
    ok((await seen(ph, ".sb-bar .g-count")) === "Scene 03 of 08", `${name} phone: short scene count (${await seen(ph, ".sb-bar .g-count")})`);
    if (SHOTS) await ph.screenshot({ path: `${SHOTS}/8-phone-${name}-guide.png` });
    await ph.tap(`${frame("3C")} [data-sb=edit]`);
    await ph.fill(`${frame("3C")} textarea`, "Make him look right at the camera.");
    ok((await ph.evaluate(() => getComputedStyle(document.querySelector(".sb-bar")).visibility)) === "hidden", `${name} phone: bar steps aside while a note is open`);
    if (SHOTS) { await ph.evaluate(() => document.querySelector('.sb-frame[data-id$="-3C"]').scrollIntoView({ block: "center" })); await ph.screenshot({ path: `${SHOTS}/9-phone-${name}-note.png` }); }
    await ph.tap(`${frame("3C")} [type=submit]`);
    await ph.waitForSelector(`${frame("3C")}.has-note`);
    await ph.tap(`${frame("4B")} .sb-shot`);
    await ph.waitForSelector(".g-lightbox:not([hidden])");
    ok(await ph.locator(".sb-lb-step").count() === 2 && await ph.locator(".sb-lb-step").first().isVisible(), `${name} phone viewer: previous/next buttons`);
    await ph.tap(".sb-lb-step[data-step='1']");
    ok((await text(ph, ".g-lb-count")) === `${idx("4B") + 1} / 27`, `${name} phone viewer: next steps a frame`);
    if (SHOTS) await ph.screenshot({ path: `${SHOTS}/10-phone-${name}-viewer.png` });
    ok((await overflow(ph)) <= 0, `${name} phone viewer: no sideways scroll`);
    await ph.tap(".g-lb-close");
    await toEnd(ph);
    ok((await seen(ph, ".sb-bar .g-count")) === "1 change" && /^Send 1 change$/.test(await seen(ph, ".sb-bar [data-sb=review]")), `${name} phone: short end state (${await seen(ph, ".sb-bar .g-count")} / ${await seen(ph, ".sb-bar [data-sb=review]")})`);
    if (SHOTS) await ph.screenshot({ path: `${SHOTS}/11-phone-${name}-end.png` });
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
