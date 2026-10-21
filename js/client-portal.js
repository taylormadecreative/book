/* Taylormade — BOOK · client portal (token access), 2026-10-21 look from Nelson's mockup.
 * The previous portal lives on as portal-v1.html (portal.html?look=v1 redirects there).
 * The hero headline and its one big button follow the project's stage: picking proofs,
 * photos ready, a contract to sign, an invoice to pay, picks sent, booked, in the edit. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const icon = (id, cls = "") => `<svg class="ico${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="#i-${id}"/></svg>`;

const params = new URLSearchParams(location.search);
const PID = params.get("p");
const TOKEN = params.get("t");
const JUST_PAID = params.get("paid") === "1";

const SERVICES = {
  music_video: "Music video", brand_content: "Brand content",
  photography: "Photography", event: "Event coverage",
  digitals: "Digitals session", other: "Custom project",
};
const PHOTO_SERVICES = ["photography", "digitals"];
const STATUS_LABEL = {
  new: "Inquiry", quoted: "Quote sent", booked: "Booked",
  in_production: "In production", delivered: "Delivered",
  archived: "Archived", lost: "Closed",
};
const PIPELINE = ["new", "quoted", "booked", "in_production", "delivered"];
const PIPE_LABEL = { new: "Inquiry", quoted: "Quoted", booked: "Booked", in_production: "Production", delivered: "Delivered" };
const TABS = ["photos", "details", "messages", "invoices"];

let data = null;   // last bk_portal payload
let media = null;  // what BKGallery.mount found
let heroKey = "", lastMsgKey = "", lastCtKey = null, lastInvKey = null, lastFilesKey = null;

// browser storage is a convenience only (private mode can refuse it)
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* fine */ } },
};
// "Welcome back" only once they've been here before
const RETURNING = (() => { const k = `bk_visit_${PID}`, seen = !!store.get(k); store.set(k, "1"); return seen; })();

const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const day = (d, o) => new Date(d + "T12:00:00").toLocaleDateString("en-US", o);
const longDate = (d) => (d ? day(d, { month: "long", day: "numeric", year: "numeric" }) : "To be set");
const shortDate = (d) => (d ? day(d, { weekday: "short", month: "short", day: "numeric" }) : "");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const firstName = (p) => (p.client_name || "").trim().split(/\s+/)[0] || "";
const initials = (p) => (p.client_name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
// "Dave Ladetto — Headshots" names the service better than the booking category does
const serviceName = (p) => {
  const tail = (p.title || "").split(" — ")[1];
  return (tail && tail.trim()) || SERVICES[p.service] || p.service || "Project";
};
const cityOf = (addr) => {
  const parts = addr.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) return addr;
  const state = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, "");
  return state ? `${parts[parts.length - 2]}, ${state}` : addr;
};
const shootPassed = (p) => !!p.event_date && new Date(p.event_date + "T23:59:59") < new Date();
const closed = (p) => p.status === "archived" || p.status === "lost";
// photo names carry the client's name; on their own page it's just noise
const displayName = (fn, project) => {
  const n = ((project && project.client_name) || "").trim();
  return n && fn.toLowerCase().startsWith(n.toLowerCase() + " ") ? fn.slice(n.length + 1) : fn;
};
// just back from checkout: the webhook may not have marked it paid yet
const processing = (inv) => inv.status === "sent" && JUST_PAID && inv.id === sessionStorage.getItem("bk_paying");
const unpaid = () => (data.invoices || []).filter((i) => i.status === "sent" && !processing(i))
  .sort((a, b) => (a.due_date || "9").localeCompare(b.due_date || "9"));
const safeUrl = (u) => /^https:\/\//i.test(u || "");

init();
async function init() {
  if (!PID || !TOKEN) return fail("missing");
  const root = $("#galleryRoot");
  root.addEventListener("bkgallery:sent", () => {
    if (media) { media.openProof = false; media.picksSent = true; media.proof = null; }
    renderHero();
  });
  const mounting = window.BKGallery
    ? BKGallery.mount(root, { mode: "token", project_id: PID, token: TOKEN }, { v2: true, displayName, emptyHTML: emptyPhotos }).catch(() => null)
    : Promise.resolve(null);
  try {
    data = await BK.rpc("bk_portal", { p_project: PID, p_token: TOKEN });
  } catch (err) {
    // only a refused link is "not found"; a dropped connection gets a retry
    return fail(/not.found|invalid input syntax/i.test(err && err.message) ? "missing" : "offline");
  }
  if (!data || !data.project) return fail("missing");
  media = await mounting;
  paidBanner();
  render();
  $("#loading").hidden = true;
  $("#app").hidden = false;
  $("#barRight").hidden = false;
  selectTab(initialTab());
  setInterval(refresh, 10000);
}

function fail(kind) {
  $("#loading").hidden = true;
  $("#noAccess").hidden = kind !== "missing";
  $("#offline").hidden = kind !== "offline";
}
$("#retry").addEventListener("click", () => location.reload());

async function refresh() {
  if (document.hidden) return;
  try {
    const next = await BK.rpc("bk_portal", { p_project: PID, p_token: TOKEN });
    if (next && next.project) { data = next; render(); }
  } catch (_) { /* transient; keep the last view */ }
}

// gallery-core calls this when the project has no galleries yet
function emptyPhotos(project) {
  const svc = (project && project.service) || (data && data.project.service);
  const st = (project && project.status) || (data && data.project.status);
  if (st === "archived" || st === "lost") {
    return `<div class="empty">${icon("camera", "empty-ico")}<h2 class="sec-h">Nothing here</h2>
      <p>This project is closed, so no photos or video were added to it.</p></div>`;
  }
  if (svc && !PHOTO_SERVICES.includes(svc)) {
    return `<div class="empty">${icon("camera", "empty-ico")}<h2 class="sec-h">Your video lands here</h2>
      <p>When the edit is done, Nelson uploads it to this page so you can watch it and download it.</p></div>`;
  }
  return `<div class="empty">${icon("camera", "empty-ico")}<h2 class="sec-h">Your photos land here</h2>
    <p>After the shoot, Nelson uploads your proofs to this page so you can pick your favorites. Your finished photos show up here too.</p></div>`;
}

/* ---------------- stage ---------------- */
function stage() {
  const p = data.project;
  if (media && media.openProof) return "picking"; // picks are the one thing waiting on them, even on a second round
  if (media && media.delivered) return "ready";
  if ((data.contracts || []).some((c) => c.status === "sent")) return "sign";
  if (unpaid().length) return "pay";
  if (media && media.picksSent) return "editing";
  if ((data.files || []).some((f) => safeUrl(f.url)) && p.status === "delivered") return "files";
  if (closed(p)) return "closed";
  if (p.status === "delivered") return "delivered";
  if (p.status === "new") return "new";
  if (p.status === "quoted" && !(data.invoices || []).length) return "quoted";
  if (p.status === "in_production" || shootPassed(p)) return "edit";
  return "booked";
}

/* ---------------- render ---------------- */
function render() {
  const p = data.project;
  $("#avatar").textContent = initials(p);
  $("#whoName").textContent = firstName(p);
  $("#whoFull").textContent = p.client_name || "";
  renderHero();
  renderRail();
  renderDetails();
  renderInvoices();
  renderContracts();
  renderFiles();
  renderMessages();
  // a delivered project with only links: the "photos land here" note would say the opposite
  $("#galleryRoot").hidden = !$("#galleryRoot .g-block") && !$("#filesBlock").hidden;
}

function renderHero() {
  const p = data.project;
  const st = stage();
  const f = media && media.finals;
  const vids = (media && media.videos) || 0;
  const photoWork = PHOTO_SERVICES.includes(p.service);
  let h, cta = "";
  if (st === "ready") {
    h = f && vids ? "Your photos and video are ready."
      : f ? (f.count === 1 ? "Your photo is ready." : "Your photos are ready.")
      : (vids === 1 ? "Your video is ready." : "Your videos are ready.");
    if (f) {
      const note = f.count > 1 ? `ZIP file${f.mb ? ` · ${f.mb} MB` : ""}` : `Full resolution${f.mb ? ` · ${f.mb} MB` : ""}`;
      cta = heroButton("download", f.count > 1 ? `Download all ${f.count} photos` : "Download your photo", note, 'data-act="download"');
    } else {
      cta = heroButton("arrow-down", vids === 1 ? "Watch your video" : "Watch your videos", plural(vids, "video"), 'data-act="video"');
    }
  } else if (st === "picking") {
    h = "Pick your favorites.";
    const pr = media.proof;
    cta = heroButton("arrow-down", "Start picking", `${plural(pr.count, "proof")} · ${pr.limit != null ? `pick up to ${pr.limit}` : "pick the ones you want edited"}`, 'data-act="pick"');
  } else if (st === "sign") {
    h = "Your contract is ready.";
    const c = data.contracts.find((x) => x.status === "sent");
    cta = heroButton("pen", "Review and sign", c.title, 'data-act="sign"');
  } else if (st === "pay") {
    const inv = unpaid()[0];
    h = inv.kind === "deposit" && !shootPassed(p) ? "Lock in your date."
      : ["new", "quoted"].includes(p.status) ? "Your quote is ready." : "Your invoice is ready.";
    cta = heroButton("card", `Pay ${money(inv.amount_cents)}`, `${inv.title}${inv.due_date ? ` · Due ${shortDate(inv.due_date)}` : ""}`, `data-pay="${esc(inv.id)}"`);
  } else if (st === "editing") {
    h = "Your picks are in.";
    cta = heroAside("Nelson is editing your picks. Your finished photos will show up on this page.");
  } else if (st === "files") {
    h = "Your files are ready.";
    cta = heroButton("link", "Open your files", plural(data.files.filter((x) => safeUrl(x.url)).length, "link"), 'data-act="files"');
  } else if (st === "booked") {
    h = "You're booked.";
    if (p.event_date) {
      cta = `<div class="hero-when">
        <span class="eyebrow">Shoot day</span>
        <strong>${esc(shortDate(p.event_date))}${p.event_time ? ` · ${esc(p.event_time)}` : ""}</strong>
      </div>`;
    }
  } else if (st === "edit") {
    h = "In the edit.";
    cta = heroAside(photoWork ? "Nelson is working on your photos. Your proofs will show up on this page."
      : "Nelson is working on your edit. It will show up on this page when it's done.");
  } else if (st === "delivered") {
    h = "Your project is delivered.";
    if (media && media.error) cta = heroAside("Your photos didn't load just now.", `<button class="btn btn-line" type="button" data-act="reload">Try again</button>`);
  } else if (st === "quoted") {
    h = "Your quote is on the way.";
    cta = heroAside("When Nelson sends it, you can review and pay it right here.");
  } else if (st === "closed") {
    h = "This project is closed.";
  } else {
    h = "We got your request.";
    cta = heroAside("Your quote will show up on this page. Questions in the meantime? Message Nelson.");
  }
  const eyebrow = firstName(p) ? `${RETURNING ? "Welcome back" : "Welcome"}, ${firstName(p)}` : (RETURNING ? "Welcome back" : "Welcome");
  const title = p.title || `${p.client_name} · ${SERVICES[p.service] || "Project"}`;
  const status = STATUS_LABEL[p.status] || p.status;
  const key = [st, h, cta, eyebrow, title, status, p.status].join("|");
  // never rebuild mid-download or mid-checkout: the busy button would reset
  if (key === heroKey || $("#heroCta [aria-busy], #heroCta [disabled]")) return;
  heroKey = key;
  $("#eyebrow").textContent = eyebrow;
  $("#headline").textContent = h;
  $("#pTitle").textContent = title;
  $("#pStatus").textContent = status;
  $("#pStatus").dataset.status = p.status;
  $("#heroCta").innerHTML = cta;
  $("#heroCta").hidden = !cta;
  $("#heroCta").classList.toggle("is-aside", cta.includes("hero-aside"));
  renderTracker(p);

  const ready = st === "ready";
  const about = ready ? (media.finals && vids ? "your photos and video" : media.finals ? "your photos" : "your video") : "your project";
  $("#helpH").textContent = ready ? "Need a change?" : "Got a question?";
  $("#helpP").textContent = `Send Nelson a message about ${about}.`;
}

function heroButton(ic, label, note, attrs) {
  return `<button class="btn btn-gold btn-xl" type="button" ${attrs}>${icon(ic)}<span class="label" aria-live="polite">${esc(label)}</span></button>
    ${note ? `<span class="hero-note">${esc(note)}</span>` : ""}`;
}
function heroAside(text, extra = "") {
  return `<p class="hero-aside">${esc(text)}</p>${extra}`;
}

function renderTracker(p) {
  const idx = PIPELINE.indexOf(p.status);
  const done = p.status === "delivered";
  $("#tracker").innerHTML = PIPELINE.map((s, i) => {
    const state = idx < 0 ? "todo" : i < idx || (done && i === idx) ? "done" : i === idx ? "now" : "todo";
    const said = state === "done" ? "done" : state === "now" ? "current step" : "not yet";
    return `<li class="tk ${state}"${state === "now" ? ' aria-current="step"' : ""}>
      <span class="tk-dot">${state === "done" ? icon("check") : ""}</span>
      <span class="tk-label">${PIPE_LABEL[s]}<span class="vh">, ${said}</span></span>
      ${i < PIPELINE.length - 1 ? `<span class="tk-line${i < idx ? " on" : ""}" aria-hidden="true"></span>` : ""}
    </li>`;
  }).join("");
}

function renderRail() {
  const p = data.project;
  const when = p.event_date ? `${longDate(p.event_date)}${p.event_time && !shootPassed(p) ? ` · ${p.event_time}` : ""}` : "To be set";
  const rows = [
    ["camera", "Service", esc(serviceName(p))],
    ["calendar", "Shoot date", esc(when)],
  ];
  // after the shoot the street address is noise here (Project details keeps it): "…, Dallas, TX 75201" → "Dallas, TX"
  const loc = p.location && shootPassed(p) ? cityOf(p.location) : p.location;
  if (loc) rows.push(["pin", "Location", esc(loc)]);
  (data.invoices || []).slice(0, 3).forEach((inv) => {
    rows.push(["card", esc(inv.title), `<span class="amt">${money(inv.amount_cents)}</span>${chip(inv)}`]);
  });
  $("#railFacts").innerHTML = rows.map(([ic, k, v]) =>
    `<li>${icon(ic, "fact-ico")}<div><span class="fact-k">${k}</span><span class="fact-v">${v}</span></div></li>`).join("");
}

function chip(inv) {
  return inv.status === "paid" ? `<span class="chip chip-paid">Paid</span>`
    : processing(inv) ? `<span class="chip chip-due">Processing</span>`
    : `<span class="chip chip-due">Due</span>`;
}

function renderDetails() {
  const p = data.project;
  const shot = shootPassed(p);
  // once the shoot day has passed, an unfilled call time or location is noise, not "to be set"
  const rows = [
    ["Service", serviceName(p)],
    ["Shoot date", p.event_date ? day(p.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "To be set"],
    ["Call time", p.event_time || (shot ? "" : "To be set")],
    ["Location", p.location || (shot ? "" : "To be set")],
    ["Status", STATUS_LABEL[p.status] || p.status],
    ["Project number", p.id.slice(0, 8).toUpperCase()],
  ].filter(([, v]) => v);
  $("#pDetails").innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
}

function renderInvoices() {
  const p = data.project;
  const inv = data.invoices || [];
  // booked or later with nothing billed here (paid another way): no Invoices tab at all
  const hide = !inv.length && ["booked", "in_production", "delivered", "archived", "lost"].includes(p.status);
  $("#tab-invoices").hidden = hide;
  if (hide && currentTab() === "invoices") selectTab("photos");
  const box = $("#pInvoices");
  // rebuild only on change (the poll would drop keyboard focus), and never under a Pay mid-request
  const key = JSON.stringify(inv.map((i) => [i.id, i.status, i.amount_cents, i.due_date, i.title, processing(i)])) + p.status;
  if (key === lastInvKey || box.querySelector("[data-pay][disabled]")) return;
  lastInvKey = key;
  const paying = sessionStorage.getItem("bk_paying");
  box.innerHTML = inv.length ? inv.map((i) => {
    if (i.status === "paid" && i.id === paying) sessionStorage.removeItem("bk_paying");
    const lines = (i.line_items || []).map((li) => esc(li.label)).join(" · ") || (i.kind === "deposit" ? "Booking deposit" : "");
    return `<div class="inv">
      ${icon("card", "fact-ico")}
      <div class="inv-main">
        <b>${esc(i.title)}</b>
        ${lines ? `<small>${lines}</small>` : ""}
        <small>${i.status === "paid" && i.paid_at ? `Paid ${new Date(i.paid_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
          : i.due_date ? `Due ${longDate(i.due_date)}` : ""}</small>
      </div>
      <div class="inv-side">
        <span class="amt">${money(i.amount_cents)}</span>
        ${i.status === "paid" || processing(i) ? chip(i) : `<button class="btn btn-gold" type="button" data-pay="${esc(i.id)}"><span class="label">Pay now</span></button>`}
      </div>
    </div>`;
  }).join("") : `<div class="empty empty-sm">${icon("card", "empty-ico")}<p>${closed(p)
      ? "There are no invoices on this project."
      : "No invoices yet. When Nelson sends your quote, it shows up here and you can pay it in a tap."}</p></div>`;
}

function renderContracts() {
  const contracts = data.contracts || [];
  $("#contractsBlock").hidden = !contracts.length;
  // rebuild only when the set or a status changes, so the poll never wipes a half-typed signature
  const key = contracts.map((c) => `${c.id}:${c.status}`).join("|");
  if (!contracts.length || key === lastCtKey) return;
  lastCtKey = key;
  const signedOn = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" }) : "");
  $("#pContracts").innerHTML = contracts.map((c) => `
    <div class="ct">
      <div class="ct-head">
        <b>${esc(c.title)}</b>
        ${c.status === "signed" ? `<span class="chip chip-paid">Signed</span>` : `<span class="chip chip-due">Needs your signature</span>`}
      </div>
      <div class="ct-doc" tabindex="0" aria-label="${esc(c.title)}, full contract text">${esc(c.body)}</div>
      ${c.status === "signed"
        ? `<p class="ct-signed">${icon("check")}Signed by ${esc(c.signer_name || "")} on ${signedOn(c.signed_at)}</p>`
        : c.status !== "sent" ? ""
        : `<form class="ct-sign" data-sign-form="${esc(c.id)}">
          <div class="field">
            <label for="sig-name-${esc(c.id)}">Type your full legal name</label>
            <input id="sig-name-${esc(c.id)}" data-sig-name autocomplete="name" maxlength="120" required>
          </div>
          <label class="ct-agree" for="sig-agree-${esc(c.id)}">
            <input type="checkbox" id="sig-agree-${esc(c.id)}" data-sig-agree required>
            <span>I agree that typing my name here is my electronic signature</span>
          </label>
          <button class="btn btn-gold" type="submit" disabled><span class="label">Sign contract</span></button>
          <p class="form-err" role="alert" hidden></p>
        </form>`}
    </div>`).join("");
}

function renderFiles() {
  const files = (data.files || []).filter((f) => safeUrl(f.url)); // only real web links, never javascript: and friends
  $("#filesBlock").hidden = !files.length;
  const key = JSON.stringify(files.map((f) => [f.url, f.label]));
  if (key === lastFilesKey) return;
  lastFilesKey = key;
  $("#pFiles").innerHTML = files.map((f) => `
    <a class="link-row" href="${esc(f.url)}" target="_blank" rel="noopener">
      ${icon("link", "fact-ico")}<span>${esc(f.label)}</span>${icon("out")}
    </a>`).join("");
}

/* messages: the thread only grows, so new ones are appended (a log, not a re-read of the whole chat) */
const msgHTML = (m) => `
    <div class="msg ${m.sender === "studio" ? "them" : "me"}">
      <p class="msg-body">${esc(m.body)}</p>
      <time datetime="${esc(m.created_at)}">${m.sender === "studio" ? "Nelson" : "You"} · ${new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
    </div>`;
const msgId = (m) => m.id || m.created_at;
const SEEN_KEY = `bk_seen_${PID}`;
const lastStudio = () => (data.messages || []).filter((m) => m.sender === "studio").map((m) => m.created_at).sort().pop() || "";

function renderMessages() {
  const msgs = data.messages || [];
  const key = msgs.map(msgId).join("|");
  if (key !== lastMsgKey) {
    const scroll = $("#chatScroll");
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    if (lastMsgKey && key.startsWith(lastMsgKey + "|")) {
      const have = lastMsgKey.split("|").length;
      scroll.insertAdjacentHTML("beforeend", msgs.slice(have).map(msgHTML).join(""));
    } else {
      scroll.innerHTML = msgs.length ? msgs.map(msgHTML).join("")
        : `<div class="empty empty-sm">${icon("chat", "empty-ico")}<p>No messages yet. Ask Nelson anything about your project.</p></div>`;
    }
    if (atBottom || !lastMsgKey) scroll.scrollTop = scroll.scrollHeight;
    lastMsgKey = key;
  }
  // a dot on the tab when Nelson has written since they last looked
  const latest = lastStudio();
  if (!store.get(SEEN_KEY)) store.set(SEEN_KEY, latest); // first visit: what's here now counts as seen
  if (currentTab() === "messages") store.set(SEEN_KEY, latest);
  const unread = latest && latest > (store.get(SEEN_KEY) || "");
  $("#tab-messages").classList.toggle("has-new", !!unread);
  $("#msgDot").textContent = unread ? ", new message from Nelson" : "";
}

/* ---------------- paid banner ---------------- */
function paidBanner() {
  if (!JUST_PAID) return;
  const inv = (data.invoices || []).find((i) => i.id === sessionStorage.getItem("bk_paying"));
  $("#paidText").textContent = inv && inv.kind === "deposit"
    ? "Payment received. Your date is locked in, and your receipt is on its way to your email."
    : "Payment received. Thank you! Your receipt is on its way to your email.";
  $("#paidBanner").hidden = false;
  // a reload shouldn't keep thanking them
  params.delete("paid");
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}

/* ---------------- tabs ---------------- */
const currentTab = () => ($(".tab[aria-selected='true']") || {}).dataset?.tab;
const tabOk = (t) => TABS.includes(t) && !$(`#tab-${t}`).hidden;

function initialTab() {
  const want = location.hash.slice(1);
  if (tabOk(want)) return want;
  const st = stage();
  const hasMedia = !!$("#galleryRoot .g-block");
  if (st === "pay" && tabOk("invoices")) return "invoices";
  if (st === "sign") return "details";
  if (["ready", "picking", "editing", "files", "delivered"].includes(st) || hasMedia) return "photos";
  return "details";
}

function selectTab(name, { focus = false } = {}) {
  if (!tabOk(name)) name = "photos";
  $$(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  TABS.forEach((t) => { $(`#panel-${t}`).hidden = t !== name; });
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  if (focus) $(`#tab-${name}`).focus();
  if (name === "messages") {
    const s = $("#chatScroll");
    s.scrollTop = s.scrollHeight;
    if (data) renderMessages(); // clears the new-message dot
  }
}

$(".tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t) selectTab(t.dataset.tab);
});
$(".tabs").addEventListener("keydown", (e) => {
  const tabs = $$(".tab").filter((t) => !t.hidden);
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let j = null;
  if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
  else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = tabs.length - 1;
  if (j == null) return;
  e.preventDefault();
  selectTab(tabs[j].dataset.tab, { focus: true });
});
window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (tabOk(t) && t !== currentTab()) selectTab(t); });

// switch tab, then bring the panel (or one thing in it) into view
function goTo(tab, target) {
  selectTab(tab);
  const el = target || $(`#panel-${tab}`);
  requestAnimationFrame(() => el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

function openMessages() {
  closeMenu();
  goTo("messages", $(".tabs"));
  $("#chatInput").focus({ preventScroll: true });
}

/* ---------------- hero + page actions ---------------- */
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-messages]")) { openMessages(); return; }
  const act = e.target.closest("#heroCta [data-act]");
  if (!act) return;
  const a = act.dataset.act;
  if (a === "download" && media && media.finals) media.finals.download(act);
  else if (a === "pick" && media && media.proof) goTo("photos", media.proof.el);
  else if (a === "video") goTo("photos", $("#galleryRoot .g-block[data-kind='video']"));
  else if (a === "sign") goTo("details", $("#contractsBlock"));
  else if (a === "files") goTo("photos", $("#filesBlock"));
  else if (a === "reload") location.reload();
});

/* ---------------- account menu ---------------- */
const whoBtn = $("#whoBtn"), whoMenu = $("#whoMenu");
function closeMenu(refocus) {
  if (whoMenu.hidden) return;
  whoMenu.hidden = true;
  whoBtn.setAttribute("aria-expanded", "false");
  if (refocus) whoBtn.focus();
}
whoBtn.addEventListener("click", () => {
  const open = whoMenu.hidden;
  whoMenu.hidden = !open;
  whoBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) whoMenu.querySelector("button, a").focus();
});
document.addEventListener("click", (e) => { if (!e.target.closest(".who")) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !whoMenu.hidden) closeMenu(true); });
whoMenu.addEventListener("focusout", (e) => { if (!e.relatedTarget || !e.relatedTarget.closest(".who")) closeMenu(); });

/* ---------------- pay ---------------- */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-pay]");
  if (!btn) return;
  const label = btn.querySelector(".label") || btn;
  const was = label.textContent;
  btn.dataset.was = was;
  btn.disabled = true;
  label.textContent = "Opening checkout…";
  sessionStorage.setItem("bk_paying", btn.dataset.pay);
  try {
    const res = await fetch(`${BK.FUNCTIONS_BASE}/bk-create-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: btn.dataset.pay, token: TOKEN }),
    });
    const out = await res.json();
    if (out.url) { location.href = out.url; return; }
    label.textContent = out.error === "payments_not_configured" ? "Payments are coming online. Message Nelson." : "Try again";
  } catch (_) {
    label.textContent = "Try again";
  }
  btn.disabled = false;
  setTimeout(() => { if (!btn.disabled) label.textContent = was; }, 4000);
});
// Back from checkout can restore this page from cache with the button still saying "Opening checkout…"
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  $$("[data-pay][disabled]").forEach((b) => { b.disabled = false; (b.querySelector(".label") || b).textContent = b.dataset.was || "Pay now"; });
  heroKey = ""; lastInvKey = null;
  if (data) { renderHero(); renderInvoices(); }
});

/* ---------------- messages ---------------- */
const coarse = matchMedia("(pointer: coarse)");
$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chatInput");
  const btn = $("#chatForm button[type=submit]");
  const body = input.value.trim();
  if (!body || btn.disabled) return;
  btn.disabled = true;
  $("#chatErr").hidden = true;
  try {
    await BK.rpc("bk_portal_send", { p_project: PID, p_token: TOKEN, p_body: body });
    input.value = "";
    await refresh();
    const s = $("#chatScroll");
    s.scrollTop = s.scrollHeight;
  } catch (_) {
    $("#chatErr").hidden = false; // the text stays in the box so they can retry
  }
  btn.disabled = false;
});
$("#chatInput").addEventListener("keydown", (e) => {
  // keyboards with a real Enter send; on phones Return adds a line and the button sends
  if (e.key === "Enter" && !e.shiftKey && !coarse.matches && !e.isComposing) {
    e.preventDefault();
    $("#chatForm").requestSubmit();
  }
});

/* ---------------- sign contracts (listeners on the static container survive re-renders) ---------------- */
const pContracts = $("#pContracts");
const syncSignBtn = (form) => {
  const name = form.querySelector("[data-sig-name]").value.trim();
  const agree = form.querySelector("[data-sig-agree]").checked;
  form.querySelector("button[type=submit]").disabled = !(name && agree);
};
const onFieldChange = (e) => { const f = e.target.closest("form[data-sign-form]"); if (f) syncSignBtn(f); };
pContracts.addEventListener("input", onFieldChange);
pContracts.addEventListener("change", onFieldChange);
pContracts.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-sign-form]");
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector("button[type=submit]");
  const label = btn.querySelector(".label");
  const err = form.querySelector(".form-err");
  const name = form.querySelector("[data-sig-name]").value.trim();
  if (!name || !form.querySelector("[data-sig-agree]").checked || btn.disabled) return;
  btn.disabled = true;
  label.textContent = "Signing…";
  err.hidden = true;
  try {
    const out = await BK.rpc("bk_portal_sign_contract", { p_project: PID, p_token: TOKEN, p_contract: form.dataset.signForm, p_signer_name: name });
    if (!out || out.ok !== true) throw new Error((out && out.error) || "sign_failed");
    label.textContent = "Signed";
    await refresh(); // pulls the signed state and re-renders the contract
  } catch (_) {
    btn.disabled = false;
    label.textContent = "Sign contract";
    err.textContent = "Your signature didn't go through. Give it another try, or message Nelson and he'll sort it out.";
    err.hidden = false;
  }
});
