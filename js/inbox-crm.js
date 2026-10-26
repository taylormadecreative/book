/* Taylormade — Inbox, CRM layout: conversations · thread + reply · client & deal.
   Reads the same tables the Studio dashboard reads; replies still go through bk_inbox_send (5s undo). */
import { esc, fmtWhen, fmtDay, smsHref, telHref, pushSupport, newKey, urlB64ToUint8Array, whatLabel } from "./inbox-view.js";
// versioned: a cached older module without these exports would stop the whole app from starting
import { buildDraft, draftOptions, greetName } from "./inbox-drafts.js?v=2";
import { initPitches } from "./inbox-pitches.js?v=2";
import { STAGES, STAGE_LABEL, FILTERS, BOOKING_LABEL, isBooked, replyIsEmpty, money, initials, firstName, stageChip, invoiceTotals,
  dayGroup, stats, mergeRow, matches, rowHtml, timeline } from "./inbox-crm-view.js?v=1";

const sb = window.supabase.createClient(window.BK.SUPABASE_URL, window.BK.SUPABASE_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const HOME = "/inbox/";
const SEND_DELAY_MS = 5000;
const PROJ_COLS = "id, client_name, client_email, client_phone, company, service, title, status, event_date, created_at, updated_at, inbox_handled_at, bk_invoices(amount_cents, status, paid_at)";
const ITEM_COLS = "id, status, notes_internal, access_token, referral_source, bk_invoices(id, title, kind, amount_cents, status, created_at, paid_at, due_date), bk_messages(sender, body, created_at)";
const state = {
  filter: "needs", q: "", needs: [], all: [], projects: new Map(), projectsOk: false, loaded: false,
  sel: null, item: null, extra: null, slots: [], key: newKey(), sending: false, sendingId: null, pending: null,
  draftLoading: false, listY: 0, pendingText: false, poll: null, seq: 0, listSeq: 0, writeAt: 0,
};
const wide = () => window.matchMedia("(min-width: 760px)").matches;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
const VIEWS = ["#loginView", "#crmView", "#pitchesView", "#pitchView", "#pitchEditView"];
function show(id) {
  VIEWS.forEach((v) => { $(v).hidden = v !== id; });
  $("#topBar").hidden = id === "#loginView";
  $("#pitchesNav").classList.toggle("on", id !== "#crmView" && id !== "#loginView");
  if (id !== "#crmView") { clearInterval(state.poll); state.poll = null; }
}
const draftKey = (id) => `inbox-draft:${id}`;
function saveDraft() { try { if (state.item) sessionStorage.setItem(draftKey(state.item.project.id), $("#draft").value); } catch (_) { /* private mode */ } }
function loadDraft(id) { try { return sessionStorage.getItem(draftKey(id)); } catch (_) { return null; } }
function clearDraft(id) { try { sessionStorage.removeItem(draftKey(id)); sessionStorage.removeItem(`inbox-key:${id}`); sessionStorage.removeItem(`inbox-typed:${id}`); } catch (_) { /* ignore */ } }
// "typed" = he wrote in it himself, so a template tap must ask twice; a remembered template alone swaps in one tap
function markTyped(id, on) { try { if (on) sessionStorage.setItem(`inbox-typed:${id}`, "1"); else sessionStorage.removeItem(`inbox-typed:${id}`); } catch (_) { /* ignore */ } }
function wasTyped(id) { try { return sessionStorage.getItem(`inbox-typed:${id}`) === "1"; } catch (_) { return false; } }
// the send key lives as long as the draft, so a send whose answer got lost can't go out twice
function sendKeyFor(id) {
  try {
    let k = sessionStorage.getItem(`inbox-key:${id}`);
    if (!k) { k = newKey(); sessionStorage.setItem(`inbox-key:${id}`, k); }
    return k;
  } catch (_) { return newKey(); }
}

async function rpc(fn, args, retried = false) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    // an expired token after the phone wakes is normal: refresh and try once more, never sign him out for it
    if (!retried && /JWT|expired/i.test(error.message)) { await sb.auth.refreshSession().catch(() => {}); return rpc(fn, args, true); }
    if (/forbidden/i.test(error.message)) { await sb.auth.signOut(); show("#loginView"); }
    throw error;
  }
  return data;
}
// direct table reads/writes (same as the Studio dashboard); retried once on an expired token
async function table(build, retried = false) {
  const { data, error } = await build();
  if (error) {
    if (!retried && /JWT|expired/i.test(error.message || "")) { await sb.auth.refreshSession().catch(() => {}); return table(build, true); }
    throw error;
  }
  return data;
}
const pitches = initPitches({ sb, rpc, show, toast, $, home: HOME });

/* ---------- auth ---------- */
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginBtn"); $("#loginErr").textContent = ""; btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) { $("#loginErr").textContent = error.message || "Could not sign in."; return; }
  route();
});
$("#googleBtn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + HOME + location.search } });
  if (error) $("#loginErr").textContent = error.message || "Could not start Google sign-in.";
});
const signOut = async () => { if (state.pending) firePending(state.pending); await sb.auth.signOut(); location.replace(HOME); };
$("#logoutBtn").addEventListener("click", signOut);

/* ---------- routing ---------- */
async function route() {
  const { data } = await sb.auth.getSession();
  if (!data.session) { show("#loginView"); return; }
  const qs = new URLSearchParams(location.search);
  if (qs.get("pitch")) { await pitches.openPitch(qs.get("pitch")); return; }
  if (qs.get("view") === "pitches") { await pitches.openPitches(); return; }
  await openCrm(qs.get("p"));
}
window.addEventListener("popstate", route);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || $("#crmView").hidden) return;
  if (state.pendingText) { $("#sentIt").hidden = false; state.pendingText = false; $("#sentIt").scrollIntoView({ block: "center" }); }
  loadList(); refreshOpen();
});
$("#pitchesNav").addEventListener("click", (e) => {
  e.preventDefault(); history.pushState({}, "", "?view=pitches"); pitches.openPitches(); paintPending();
});
$("#brandLink").addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault(); history.pushState({}, "", HOME); route();
});

async function openCrm(id) {
  show("#crmView");
  setupAlertsButton().catch(() => { $("#alertsBtn").hidden = true; });
  if (!state.poll) state.poll = setInterval(() => { if (!document.hidden && !$("#crmView").hidden) { loadList(); refreshOpen(); } }, 20000);
  if (id) {
    setPane("work");
    if (id !== state.sel || !state.item) openItem(id);
    if (!state.loaded) await loadList();
    revealRow(id);
  } else {
    setPane("list");
    if (!wide()) { state.sel = null; }
    await loadList();
    // a computer has room for both: open the top conversation instead of an empty page
    if (wide() && !state.sel) {
      const first = visibleRows()[0];
      if (first) { history.replaceState({}, "", `?p=${first.id}`); openItem(first.id); renderList(); }
      else showEmpty();
    }
  }
}
function setPane(p) { $("#crmView").dataset.pane = p; }
function showEmpty() {
  state.sel = null; state.item = null;
  $("#workEmpty").hidden = false; $("#whead").hidden = true; $("#wbody").hidden = true; $("#wbar").hidden = true;
}

/* ---------- list ---------- */
async function loadList() {
  const mine = ++state.listSeq; // only the newest load may draw: an older poll must not bring back a row he just handled
  if (!state.loaded) $("#list").innerHTML = skeleton();
  const [needs, all, projs] = await Promise.allSettled([
    rpc("bk_inbox_list", { p_filter: "needs", p_before: null }),
    rpc("bk_inbox_list", { p_filter: "all", p_before: null }),
    table(() => sb.from("bk_projects").select(PROJ_COLS).order("updated_at", { ascending: false }).limit(400)),
  ]);
  if (mine !== state.listSeq) return;
  if (needs.status === "rejected") {
    if (!state.loaded) {
      $("#list").removeAttribute("aria-busy");
      $("#list").innerHTML = `<div class="lempty"><p>Couldn't load the inbox.</p><button type="button" class="btn btn-ghost btn-sm retry">Try again</button></div>`;
    }
    return;
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  state.needs = list(needs.value);
  if (all.status === "fulfilled") state.all = list(all.value);
  if (projs.status === "fulfilled" && Array.isArray(projs.value)) { state.projects = new Map(projs.value.map((p) => [p.id, p])); state.projectsOk = true; }
  state.loaded = true;
  $("#list").removeAttribute("aria-busy");
  renderStats(); renderFilters(); renderList();
}
function skeleton() {
  return Array.from({ length: 6 }, () => `<div class="crow-sk" aria-hidden="true"><i></i><span><b></b><b></b><b></b></span></div>`).join("");
}
function allRows() {
  const act = new Map(state.all.map((r) => [r.id, r]));
  state.needs.forEach((r) => act.set(r.id, r));
  const waiting = new Set(state.needs.map((r) => r.id));
  const ids = new Set([...act.keys(), ...state.projects.keys()]);
  return [...ids].map((id) => mergeRow(act.get(id), state.projects.get(id), waiting.has(id)))
    .filter((r) => r.client_name)
    .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
}
const IN = { leads: ["new", "quoted"], booked: ["booked", "in_production"], delivered: ["delivered"] };
function visibleRows() {
  const rows = allRows();
  if (state.q.trim()) return rows.filter((r) => matches(r, state.q)); // search looks through everything
  if (state.filter === "needs") return rows.filter((r) => r.waiting);
  if (IN[state.filter]) return rows.filter((r) => IN[state.filter].includes(r.status));
  if (state.filter === "unpaid") return rows.filter((r) => r.due > 0);
  return rows;
}
function renderFilters() {
  const rows = allRows();
  const n = { needs: rows.filter((r) => r.waiting).length, all: rows.length };
  Object.keys(IN).forEach((k) => { n[k] = rows.filter((r) => IN[k].includes(r.status)).length; });
  n.unpaid = rows.filter((r) => r.due > 0).length;
  $("#filters").innerHTML = FILTERS
    .filter(([k]) => k === "needs" || k === "all" || (state.projectsOk && (k !== "unpaid" || n.unpaid)))
    .map(([k, label]) => `<button type="button" data-f="${k}" aria-pressed="${state.filter === k && !state.q.trim()}">${label}<span>${n[k]}</span></button>`).join("")
    + `<a class="lf-pitches" href="?view=pitches" data-pitches>Pitches</a>`;
}
function renderList() {
  const rows = visibleRows(), now = new Date();
  const q = state.q.trim();
  $("#listCount").textContent = q ? `${rows.length} found` : "";
  if (!rows.length) {
    $("#list").innerHTML = q
      ? `<div class="lempty"><p>No one matches “${esc(q)}”.</p><button type="button" class="btn btn-ghost btn-sm" data-clearq>Clear search</button></div>`
      : state.filter === "needs"
        ? `<div class="lempty"><p class="lempty-big">All caught up.</p><p>Nobody is waiting on a reply.</p><button type="button" class="btn btn-ghost btn-sm" data-f="all">See every conversation</button></div>`
        : `<div class="lempty"><p>${{ leads: "No open leads right now.", booked: "Nothing booked right now.", delivered: "Nothing delivered yet.", unpaid: "Every invoice is paid." }[state.filter] || "Nothing here yet."}</p></div>`;
    return;
  }
  let group = null, html = "";
  rows.forEach((r) => {
    const g = q ? null : dayGroup(r.at, now);
    if (g && g !== group) { group = g; html += `<p class="lgroup">${g}</p>`; }
    html += rowHtml(r, { now, sel: r.id === state.sel });
  });
  const focusId = document.activeElement?.closest?.(".crow")?.dataset.id;
  $("#list").innerHTML = html;
  if (focusId) $(`.crow[data-id="${focusId}"]`)?.focus({ preventScroll: true });
}
function renderStats() {
  const s = stats(state.projectsOk ? [...state.projects.values()] : [], state.needs.length);
  // each number is also a shortcut to the rows behind it
  const stat = (n, label, shortLabel, shown = n, f = "") =>
    `<${f ? `button type="button" data-f="${f}"` : "div"} class="crm-stat${n ? "" : " zero"}"><b>${shown}</b><span><span class="lbl-long">${label}</span><span class="lbl-short">${shortLabel}</span></span></${f ? "button" : "div"}>`;
  const waiting = state.needs.length >= 30 ? "30+" : String(s.waiting);
  $("#stats").innerHTML = $("#statsMini").innerHTML = stat(s.waiting, "Waiting on you", "Waiting", waiting, "needs")
    + (state.projectsOk
      ? stat(s.newLeads, s.newLeads === 1 ? "New lead this week" : "New leads this week", "New leads", s.newLeads, "leads")
        + stat(s.unpaid, "Unpaid invoices", "Unpaid", `<span class="n-long">${money(s.unpaid)}</span><span class="n-short">${money(s.unpaid, true)}</span>`, s.unpaid ? "unpaid" : "")
        + stat(s.collected, `Collected in ${s.monthName.slice(0, 3)}`, "Collected", `<span class="n-long">${money(s.collected)}</span><span class="n-short">${money(s.collected, true)}</span>`)
      : "");
}

const statClick = (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  setFilter(b.dataset.f);
};
$("#stats").addEventListener("click", statClick);
$("#statsMini").addEventListener("click", statClick);
$("#filters").addEventListener("click", (e) => {
  if (e.target.closest("[data-pitches]")) { e.preventDefault(); $("#pitchesNav").click(); return; }
  const b = e.target.closest("[data-f]"); if (!b) return;
  setFilter(b.dataset.f);
});
function setFilter(f) {
  state.filter = f;
  if (state.q) { state.q = ""; $("#search").value = ""; }
  renderFilters(); renderList();
  $("#list").scrollTop = 0;
  $("#srStatus").textContent = `${visibleRows().length} in ${(FILTERS.find(([k]) => k === f) || [, "All"])[1]}`;
}
$("#search").addEventListener("input", (e) => { state.q = e.target.value; renderFilters(); renderList(); });
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.target.value = ""; state.q = ""; renderFilters(); renderList(); }
  if (e.key === "Enter") { const first = $(".crow"); if (first) { e.preventDefault(); first.click(); } }
});
$("#list").addEventListener("click", (e) => {
  if (e.target.closest("button.retry")) { loadList(); return; }
  if (e.target.closest("[data-clearq]")) { $("#search").value = ""; state.q = ""; renderFilters(); renderList(); $("#search").focus(); return; }
  const f = e.target.closest("[data-f]"); if (f) { setFilter(f.dataset.f); return; }
  const a = e.target.closest("a.crow"); if (!a) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let a new tab open
  e.preventDefault(); go(a.dataset.id);
});
function go(id, { keys = false } = {}) {
  if (id === state.sel && $("#crmView").dataset.pane === "work") return;
  if (!wide() && $("#crmView").dataset.pane === "list") state.listY = window.scrollY;
  // ↑ ↓ walking the list shouldn't pile up Back steps
  history[keys ? "replaceState" : "pushState"]({}, "", `?p=${id}`);
  setPane("work"); openItem(id, { focus: !keys }); revealRow(id);
}
// a link to a conversation outside the current filter (an alert, an earlier project) switches to All so it shows as selected
function revealRow(id) {
  if (!state.q.trim() && state.loaded && !visibleRows().some((r) => r.id === id) && allRows().some((r) => r.id === id)) {
    state.filter = "all"; renderFilters();
  }
  renderList();
  $(`.crow[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}
// "/" searches; ↑ ↓ (or j k) walk the list on a computer
document.addEventListener("keydown", (e) => {
  if ($("#crmView").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (/^(INPUT|TEXTAREA)$/.test(tag)) return;
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); return; }
  if (tag === "SELECT") return;
  if (e.key === "r" && state.item && !$("#composer").hidden) { e.preventDefault(); $("#draft").focus(); return; }
  if (!wide() || !["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && !ae.closest(".lpane")) return;
  const rows = visibleRows(); if (!rows.length) return;
  const i = rows.findIndex((r) => r.id === state.sel);
  const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" || e.key === "j" ? 1 : -1)))];
  if (!next || next.id === state.sel) return;
  const onRow = !!document.activeElement?.closest?.(".crow");
  e.preventDefault(); go(next.id, { keys: true });
  const row = $(`.crow[data-id="${next.id}"]`);
  row?.scrollIntoView({ block: "nearest" });
  if (onRow) row?.focus({ preventScroll: true });
});

/* ---------- one conversation ---------- */
async function openItem(id, { fresh = false, focus = false } = {}) {
  const seq = ++state.seq;
  // nothing from the last client may show (or send) while this one loads
  state.draftLoading = true; state.slots = []; $("#draft").value = ""; $("#tpls").innerHTML = "";
  $("#smsBtn").hidden = true; $("#callBtn").hidden = true; paintPending();
  state.sel = id; state.item = null; state.extra = null;
  $("#workEmpty").hidden = true; $("#whead").hidden = false; $("#wbody").hidden = false; $("#wbar").hidden = false;
  $("#wbar").classList.remove("show-name");
  setTab("thread");
  $("#wname").textContent = ""; $("#crumb").textContent = ""; $("#wsub").textContent = ""; $("#wstage").innerHTML = "";
  $("#thread").innerHTML = `<div class="thread-sk" aria-hidden="true"><i></i><i></i><i class="r"></i></div>`;
  $("#side").innerHTML = ""; $("#sentIt").hidden = true; $("#draftErr").textContent = "";
  $("#composer").hidden = true;
  let item, extra = null;
  try {
    const [a, b] = await Promise.allSettled([
      rpc("bk_inbox_item", { p_project: id }),
      table(() => sb.from("bk_projects").select(ITEM_COLS).eq("id", id).maybeSingle()),
    ]);
    if (a.status === "rejected") throw a.reason;
    item = a.value; extra = b.status === "fulfilled" ? b.value : null;
  } catch (_) {
    if (seq !== state.seq) return;
    $("#thread").innerHTML = `<div class="lempty"><p>Couldn't open this conversation.</p><button type="button" class="btn btn-ghost btn-sm retry">Try again</button></div>`;
    $("#thread .retry").addEventListener("click", () => openItem(id));
    return;
  }
  if (seq !== state.seq) return; // he already moved on to another conversation
  if (extra && extra.bk_messages) extra.bk_messages.sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  state.item = item; state.extra = extra;
  state.key = sendKeyFor(id);
  $("#composer").hidden = false; // before the thread draws, so "scroll to the newest" measures the real height
  $("#replyLabel").textContent = `Reply to ${greetName(item.project.client_name)}`;
  renderHead(); renderThread(true); renderSide();
  if (focus) $("#wname").focus({ preventScroll: true });
  $("#srStatus").textContent = `Opened ${item.project.client_name}`;
  state.slots = await openSlots(item);
  if (seq !== state.seq) return;
  // fresh = he just sent from here: the thread shows his reply, and the box starts empty instead of re-suggesting
  const saved = fresh ? null : loadDraft(id);
  renderTemplates(saved != null || fresh ? "" : "suggested");
  setDraft(fresh ? "" : saved != null ? saved : buildDraft(item, state.slots, "suggested"));
  $("#draft").dataset.dirty = saved != null && wasTyped(id) ? "1" : "0";
  $("#draft").scrollTop = 0;
  state.draftLoading = false; paintPending();
  showNewest();
}
// open on the newest thing they said or did; a brand-new inquiry (just the brief) opens at the top
function showNewest() {
  const seq = state.seq;
  const go = () => {
    if (seq !== state.seq) return;
    const box = $("#thread");
    if (wide()) { box.scrollTop = box.scrollHeight; return; }
    const items = box.querySelectorAll(".bub, .tev");
    if (items.length) items[items.length - 1].scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
  };
  go();
  // fonts arriving late reflow the thread: land on the newest message again once they're in
  if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(go);
}
// a quiet refresh while a conversation is open: new messages show up without touching the reply box
async function refreshOpen() {
  const id = state.sel; if (!id || !state.item || state.sending || (state.pending && state.pending.id === id)) return;
  const seq = state.seq, t0 = Date.now();
  const [a, b] = await Promise.allSettled([
    rpc("bk_inbox_item", { p_project: id }),
    table(() => sb.from("bk_projects").select(ITEM_COLS).eq("id", id).maybeSingle()),
  ]);
  if (seq !== state.seq || a.status === "rejected" || state.writeAt >= t0) return; // a save happened meanwhile: this read is stale
  const extra = b.status === "fulfilled" ? b.value : state.extra;
  if (extra && extra.bk_messages) extra.bk_messages.sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  const before = timeline(state.item, state.extra).length;
  state.item = a.value; state.extra = extra;
  renderHead();
  if (timeline(state.item, state.extra).length !== before) renderThread(false);
  // the side panel holds the notes box and the stage menu: never redraw it under his hands
  const ae = document.activeElement;
  if (!($("#side").contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) && !notesDirty()) renderSide();
}

function renderHead() {
  const it = state.item, p = it.project, x = state.extra;
  $("#crumb").innerHTML = `Project <span>/</span> ${esc(p.id.slice(0, 8).toUpperCase())}`;
  const name = $("#wname"); name.textContent = p.client_name; name.classList.toggle("long", p.client_name.length > 22);
  $("#wbarName").textContent = p.client_name;
  const booked = isBooked(x ? x.status : null);
  const bits = [whatLabel(p), p.company, p.event_date ? `${booked ? "Shoot" : "Asked for"} ${fmtDay(p.event_date)}` : null].filter(Boolean);
  $("#wsub").innerHTML = bits.map((b) => `<b>${esc(b)}</b>`).join(`<span aria-hidden="true">·</span>`);
  $("#wstage").innerHTML = stageChip(x ? x.status : null);
  $$(".js-mark").forEach((b) => { b.textContent = p.inbox_handled_at ? "Mark unread" : "Mark handled"; });
  $("#studioBtn").href = `/admin.html?p=${encodeURIComponent(p.id)}`;
}

function renderThread(toEnd) {
  const it = state.item, p = it.project;
  const box = $("#thread");
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const who = esc(firstName(p.client_name));
  let day = null, html = "";
  timeline(it, state.extra).forEach((e) => {
    const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }).format(new Date(e.at));
    if (d !== day) { day = d; html += `<p class="tday"><span>${esc(d)}</span></p>`; }
    const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(new Date(e.at));
    if (e.kind === "brief") html += briefHtml(p, time);
    else if (e.kind === "msg") {
      html += `<div class="bub ${e.sender === "studio" ? "mine" : "theirs"}"><p>${esc(e.body)}</p><span>${e.sender === "studio" ? "You" : who} · ${esc(time)}</span></div>`;
    } else html += `<p class="tev ${e.tone ? "tev-" + e.tone : ""}"><span>${esc(e.label)} · ${esc(time)}</span></p>`;
  });
  box.innerHTML = html;
  if (toEnd || atEnd) box.scrollTop = box.scrollHeight;
}
function briefHtml(p, time) {
  const facts = [
    ["Date they asked for", [fmtDay(p.event_date), p.event_time].filter(Boolean).join(" · ")],
    ["Location", p.location], ["Budget", p.budget_range],
  ].filter(([, v]) => v);
  return `<article class="brief">
    <p class="brief-tag">Inquiry · ${esc(time)}</p>
    <h3>${esc(whatLabel(p))}</h3>
    ${p.details ? `<p class="brief-body">${esc(p.details)}</p>` : `<p class="brief-body brief-none">No message with the inquiry.</p>`}
    ${facts.length ? `<dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
  </article>`;
}

const ICON = {
  mail: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="11" rx="1.5"/><path d="m3.5 5.5 6.5 5 6.5-5"/></svg>`,
  phone: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.6 3.5H4.5a1 1 0 0 0-1 1.1 12.5 12.5 0 0 0 11.9 11.9 1 1 0 0 0 1.1-1v-2.1a1 1 0 0 0-.8-1l-2.4-.5a1 1 0 0 0-1 .4l-.7 1a9 9 0 0 1-4-4l1-.7a1 1 0 0 0 .4-1l-.5-2.4a1 1 0 0 0-1-.8Z"/></svg>`,
  copy: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="9.5" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/></svg>`,
  link: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>`,
  out: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11l6-6M6 5h5v5"/></svg>`,
};
function renderSide() {
  const it = state.item, p = it.project, x = state.extra;
  const t = x ? invoiceTotals(x.bk_invoices) : null;
  const pct = t && t.invoiced ? Math.round((t.paid / t.invoiced) * 100) : 0;
  const tel = telHref(p.client_phone);
  const firstSeen = [p.created_at, ...it.past_projects.map((q) => q.created_at)].filter(Boolean).sort()[0];
  const since = firstSeen ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "long", year: "numeric" }).format(new Date(firstSeen)) : "";
  // "client" once anything was ever booked; before that they've only reached out
  const everBooked = isBooked(x && x.status) || it.past_projects.some((q) => isBooked(q.status));
  const booked = isBooked(x && x.status);
  const keepTime = (t) => String(t).replace(/ (AM|PM)$/, "\u00a0$1");
  const fact = (k, v) => v ? `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : "";
  const card = (n, title, body, aside = "") => `<section class="scard"><header><span class="num">${n}</span><h3>${title}</h3>${aside}</header>${body}</section>`;
  let n = 0; const num = () => String(++n).padStart(2, "0");

  const contact = card(num(), "Client", `
    <div class="who"><span class="mono-av big" aria-hidden="true">${esc(initials(p.client_name))}</span>
      <div><b>${esc(p.client_name)}</b>${p.company ? `<span>${esc(p.company)}</span>` : ""}${since ? `<span>${everBooked ? "Client since" : "First reached out"} ${esc(since)}${it.past_projects.length ? ` · ${it.past_projects.length + 1} projects` : ""}</span>` : ""}</div></div>
    <ul class="clines">
      <li>${ICON.mail}<a href="mailto:${esc(p.client_email)}">${esc(p.client_email)}</a><button type="button" class="icon-btn" data-copy="${esc(p.client_email)}" aria-label="Copy email">${ICON.copy}</button></li>
      ${p.client_phone ? `<li>${ICON.phone}${tel ? `<a href="${esc(tel)}">${esc(p.client_phone)}</a>` : esc(p.client_phone)}<button type="button" class="icon-btn" data-copy="${esc(p.client_phone)}" aria-label="Copy phone number">${ICON.copy}</button></li>` : ""}
    </ul>`);

  const deal = card(num(), "Deal", `
    ${x ? `<label class="stage-sel"><span>Stage</span><select id="stageSel">${STAGES.map((s) => `<option value="${s}"${x.status === s ? " selected" : ""}>${STAGE_LABEL[s]}</option>`).join("")}</select></label>` : ""}
    ${t ? (t.count ? `<div class="money">
        <div><span>Invoiced</span><b>${money(t.invoiced)}</b></div>
        <div><span>Paid</span><b class="ok">${money(t.paid)}</b></div>
        <div><span>Unpaid</span><b class="${t.due ? "due" : ""}">${money(t.due)}</b></div>
        <div class="bar" role="img" aria-label="${pct}% paid"><i style="transform:scaleX(${pct / 100})"></i></div>
      </div>` : `<p class="side-none">No invoices yet. <a href="/admin.html?p=${esc(p.id)}" target="_blank" rel="noopener">Send one from Studio</a>.</p>`) : ""}
    <dl class="facts">
      ${fact(booked ? "Shoot date" : "Asked for", [fmtDay(p.event_date), p.event_time].filter(Boolean).join(" · "))}
      ${fact("Location", p.location)}
      ${fact("Budget", p.budget_range)}
      ${fact("Came in", keepTime(fmtWhen(p.created_at)))}
      ${fact("Source", x && x.referral_source)}
    </dl>`);

  const bookings = it.bookings.length ? card(num(), "Bookings", `<ul class="slist">${it.bookings.map((b) =>
    `<li><b>${esc(b.service ? b.service.name : "Session")}</b><span>${esc(fmtWhen(b.starts_at))}</span><em class="pill-${esc(b.status)}">${esc(BOOKING_LABEL[b.status] || b.status)}</em></li>`).join("")}</ul>`) : "";

  const history = it.past_projects.length ? card(num(), "Earlier projects", `<ul class="slist">${it.past_projects.map((q) =>
    `<li><a href="?p=${esc(q.id)}" data-go="${esc(q.id)}"><b>${esc(whatLabel(q))}</b></a><span>${esc(fmtDay((q.created_at || "").slice(0, 10)))}</span>${stageChip(q.status)}</li>`).join("")}</ul>`) : "";

  const notes = x ? card(num(), "Private notes", `
    <textarea id="noteBox" rows="4" maxlength="4000" placeholder="Only you see this. Sizes, preferences, what they liked last time." aria-label="Private notes">${esc(x.notes_internal || "")}</textarea>
    <div class="note-acts"><span id="noteState" aria-live="polite"></span><button type="button" class="btn btn-ink btn-sm" id="noteSave" disabled>Save note</button></div>`) : "";

  const links = `<div class="slinks">
    ${x && x.access_token ? `<button type="button" class="btn btn-ghost btn-sm" id="copyPortal">${ICON.link}Copy portal link</button>` : ""}
    <a class="btn btn-ghost btn-sm" href="/admin.html?p=${esc(p.id)}" target="_blank" rel="noopener">Invoices &amp; contracts in Studio ${ICON.out}</a>
  </div>`;

  $("#side").innerHTML = contact + deal + bookings + history + notes + links;
  const nb = $("#noteBox");
  if (nb) {
    nb.dataset.server = x.notes_internal || "";
    let kept = null; try { kept = sessionStorage.getItem(`inbox-note:${p.id}`); } catch (_) { /* private mode */ }
    if (kept != null && kept !== nb.dataset.server) { nb.value = kept; $("#noteSave").disabled = false; $("#noteState").textContent = "Not saved yet"; }
  }
}
function notesDirty() { const nb = $("#noteBox"); return !!nb && nb.value !== nb.dataset.server; }

$("#side").addEventListener("click", async (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) { copy(c.dataset.copy, "Copied"); return; }
  const g = e.target.closest("[data-go]");
  if (g && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); go(g.dataset.go); return; }
  if (e.target.closest("#copyPortal")) {
    const p = state.item.project, x = state.extra;
    copy(`${location.origin}/portal.html?p=${p.id}&t=${x.access_token}`, "Portal link copied");
    return;
  }
  if (e.target.closest("#noteSave")) saveNote();
});
$("#side").addEventListener("input", (e) => {
  if (e.target.id !== "noteBox") return;
  noteDraft(state.item.project.id, notesDirty() ? e.target.value : null);
  $("#noteSave").disabled = !notesDirty(); $("#noteState").textContent = notesDirty() ? "Not saved yet" : "";
});
$("#side").addEventListener("change", async (e) => {
  if (e.target.id !== "stageSel") return;
  const sel = e.target, id = state.item.project.id, prev = state.extra.status, next = sel.value;
  sel.disabled = true; state.writeAt = Date.now();
  try {
    await saveProject(id, { status: next });
    const pr = state.projects.get(id); if (pr) pr.status = next;
    if (state.item && state.item.project.id === id) { state.extra.status = next; renderHead(); }
    renderFilters(); renderList(); renderStats();
    toast(`Moved to ${STAGE_LABEL[next]}`);
  } catch (_) { sel.value = prev; toast("Couldn't change the stage. Try again."); }
  finally { sel.disabled = false; sel.blur(); }
});
// an update RLS refuses comes back as success with 0 rows: ask for the row back so that reads as a failure
async function saveProject(id, patch) {
  const rows = await table(() => sb.from("bk_projects").update(patch).eq("id", id).select("id"));
  if (!rows || !rows.length) throw new Error("not saved");
}
async function saveNote() {
  const nb = $("#noteBox"), btn = $("#noteSave"), id = state.item.project.id, v = nb.value;
  btn.disabled = true; btn.textContent = "Saving…"; state.writeAt = Date.now();
  try {
    await saveProject(id, { notes_internal: v || null });
    noteDraft(id, null);
    if (state.item && state.item.project.id === id) {
      state.extra.notes_internal = v; nb.dataset.server = v;
      $("#noteState").textContent = "Saved";
    } else toast("Note saved");
  } catch (_) {
    if (state.item && state.item.project.id === id) { $("#noteState").textContent = "Couldn't save. Try again."; btn.disabled = false; }
    else toast("A note didn't save. Open that conversation and try again.");
  } finally { btn.textContent = "Save note"; }
}
// unsaved notes survive switching conversations, like reply drafts do
function noteDraft(id, v) {
  try { if (v == null) sessionStorage.removeItem(`inbox-note:${id}`); else sessionStorage.setItem(`inbox-note:${id}`, v); } catch (_) { /* private mode */ }
}
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch (_) { toast("Couldn't copy. Press and hold to copy instead."); }
}

/* tabs (phones and tablets: Messages | Client & deal) */
function setTab(tab) {
  $("#wbody").dataset.tab = tab;
  $$(".wtabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
}
$(".wtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

// real open times for a booked session service (anon RPC the public booking widget already uses)
async function openSlots(it) {
  const b = it.bookings.find((x) => x.service && x.service.kind === "session");
  if (!b) return [];
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  try {
    const r = await window.BK.rpc("bk_open_slots", { p_service: b.service.slug, p_from: today, p_to: to });
    return (r && r.slots) || [];
  } catch (_) { return []; }
}

/* ---------- reply ---------- */
function renderTemplates(on = "") {
  $("#tpls").innerHTML = draftOptions(state.item, state.slots)
    .map((o) => `<button type="button" class="tchip" data-kind="${esc(o.kind)}" aria-pressed="${o.kind === on}">${esc(o.label)}</button>`).join("");
}
function pressTemplate(kind) { $$("#tpls .tchip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === kind))); }
$("#tpls").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]"); if (!b || state.draftLoading || here(state.pending)) return;
  const box = $("#draft");
  if (box.value.trim() && box.dataset.dirty === "1" && !confirmReplace()) return;
  setDraft(buildDraft(state.item, state.slots, b.dataset.kind)); box.dataset.dirty = "0"; box.scrollTop = 0;
  markTyped(state.item.project.id, false);
  pressTemplate(b.dataset.kind);
});
// replacing edited text needs a second tap on the same chip within 3s (no browser dialogs)
let armed = 0;
function confirmReplace() {
  if (Date.now() - armed < 3000) { armed = 0; return true; }
  armed = Date.now(); toast("Tap again to replace your edits"); return false;
}
function setDraft(text) {
  $("#draft").value = text; $("#count").textContent = `${text.length} / 4000`;
  const p = state.item.project;
  const sms = smsHref(p.client_phone, text), tel = telHref(p.client_phone);
  $("#smsBtn").hidden = !sms; if (sms) $("#smsBtn").href = sms;
  $("#callBtn").hidden = !tel; if (tel) $("#callBtn").href = tel;
  saveDraft();
}
$("#draft").addEventListener("input", () => {
  $("#draft").dataset.dirty = "1"; markTyped(state.item.project.id, true); setDraft($("#draft").value);
  if ($("#draftErr").textContent) $("#draftErr").textContent = "";
});
$("#draft").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#sendBtn").click(); }
});
$("#backBtn").addEventListener("click", backToList);
function backToList() {
  history.pushState({}, "", HOME); setPane("list");
  const was = state.sel; state.sel = null; renderList(); paintPending();
  // land where he left the list, on the row he opened
  window.scrollTo(0, state.listY || 0);
  if (was) $(`.crow[data-id="${was}"]`)?.focus({ preventScroll: true });
}

/* Send holds for 5 seconds with an Undo, so a stray tap never emails a client. The countdown belongs to the reply,
   not the screen: moving to another conversation keeps it going, and a floating bar keeps Undo in reach. */
const here = (pend) => !!pend && state.sel === pend.id && !$("#crmView").hidden && (wide() || $("#crmView").dataset.pane === "work");
function paintPending() {
  const pend = state.pending, on = here(pend), btn = $("#sendBtn");
  btn.classList.toggle("is-pending", on); $("#composer").classList.toggle("is-pending", on);
  btn.disabled = on || state.sending;
  btn.style.setProperty("--send-elapsed", on ? `${-(SEND_DELAY_MS / 1000 - pend.left)}s` : "0s");
  $("#sendLabel").textContent = on ? `Sending in ${pend.left}s` : state.sending && state.sendingId === state.sel ? "Sending…" : "Send email";
  $("#undoSend").hidden = !on;
  $("#draft").readOnly = on;
  $("#undoBar").hidden = !pend || on;
  if (pend && !on) $("#undoBarText").textContent = `Sending to ${pend.name} in ${pend.left}s`;
}
$("#sendBtn").addEventListener("click", () => {
  if (!state.item || state.draftLoading || (state.pending && state.pending.id === state.item.project.id)) return;
  const body = $("#draft").value.trim();
  if (replyIsEmpty(body)) { $("#draftErr").textContent = "Add your answer first. Right now it's only a greeting and your sign-off."; $("#draft").focus(); return; }
  if (state.pending) firePending(state.pending); // another reply was still counting down: let it go now
  $("#draftErr").textContent = "";
  const p = state.item.project, fromKeys = ["sendBtn", "draft"].includes(document.activeElement?.id);
  const pend = { id: p.id, name: greetName(p.client_name), email: p.client_email, key: state.key, body, left: SEND_DELAY_MS / 1000 };
  pend.tick = setInterval(() => { pend.left = Math.max(1, pend.left - 1); paintPending(); }, 1000);
  pend.timer = setTimeout(() => firePending(pend), SEND_DELAY_MS);
  state.pending = pend; paintPending();
  if (fromKeys) $("#undoSend").focus(); // Send just disabled itself: keep keyboard focus somewhere useful
});
function firePending(pend) {
  clearTimeout(pend.timer); clearInterval(pend.tick);
  if (state.pending === pend) state.pending = null;
  doSend(pend);
}
function undoPending() {
  const pend = state.pending; if (!pend) return;
  clearTimeout(pend.timer); clearInterval(pend.tick); state.pending = null;
  paintPending(); toast(`Not sent to ${pend.name}`);
  if (state.sel === pend.id && !$("#composer").hidden) $("#draft").focus();
}
$("#undoSend").addEventListener("click", undoPending);
$("#undoBarBtn").addEventListener("click", undoPending);
async function doSend(pend) {
  state.sending = true; state.sendingId = pend.id; state.writeAt = Date.now(); paintPending();
  try {
    await rpc("bk_inbox_send", { p_project: pend.id, p_body: pend.body, p_key: pend.key });
    clearDraft(pend.id);
    toast(`Sent to ${pend.email}`);
    await loadList();
    if (state.sel === pend.id) {
      // a phone goes back to the list for the next one (as before); a computer shows the reply in the thread, box cleared
      if (!wide() && $("#crmView").dataset.pane === "work") backToList();
      else await openItem(pend.id, { fresh: true });
    }
  } catch (e) {
    const why = e && e.message ? ` (${e.message})` : "";
    if (state.sel === pend.id) $("#draftErr").textContent = `Couldn't send. Your reply is still here, so try again.${why}`;
    else toast(`Your reply to ${pend.name} didn't send. Open it and try again.`);
  } finally { state.sending = false; state.sendingId = null; paintPending(); }
}
$("#smsBtn").addEventListener("click", () => { state.pendingText = true; });
$("#callBtn").addEventListener("click", () => { state.pendingText = true; });
$("#sentItYes").addEventListener("click", () => mark(true));
$("#sentItNo").addEventListener("click", () => { $("#sentIt").hidden = true; });
$$(".js-mark").forEach((b) => b.addEventListener("click", () => { if (state.item) mark(!state.item.project.inbox_handled_at); }));
// phones: once the big name scrolls under the bars, the slim bar carries it
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([e]) => { $("#wbar").classList.toggle("show-name", !e.isIntersecting && e.boundingClientRect.top < 200); },
    { rootMargin: "-112px 0px 0px 0px" }).observe($("#wname"));
}
async function mark(handled) {
  const id = state.item && state.item.project.id; if (!id) return;
  state.writeAt = Date.now();
  try {
    await rpc("bk_inbox_mark", { p_project: id, p_handled: handled });
    toast(handled ? "Marked handled" : "Marked unread");
    if (state.item && state.item.project.id === id) {
      $("#sentIt").hidden = true;
      state.item.project.inbox_handled_at = handled ? new Date().toISOString() : null;
      renderHead();
    }
    await loadList();
  } catch (_) { toast("Couldn't update. Try again."); }
}

/* ---------- alerts ---------- */
function env() {
  return {
    sw: "serviceWorker" in navigator, push: "PushManager" in window, notif: "Notification" in window,
    standalone: window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    ios: /iPhone|iPad|iPod/.test(navigator.userAgent),
  };
}
function alertsLabel(text, on) { $("#alertsLabel").textContent = text; $("#alertsBtn").classList.toggle("on", !!on); }
async function setupAlertsButton() {
  const btn = $("#alertsBtn"), note = $("#alertsNote");
  const support = pushSupport(env());
  if (support === "install") {
    alertsLabel("Get alerts"); note.hidden = true;
    btn.onclick = () => { note.hidden = false; note.textContent = "Tap Share, then Add to Home Screen. Open Inbox from your home screen, sign in once more there, and turn on alerts."; };
    return;
  }
  if (support === "unsupported") { btn.hidden = true; return; }
  await navigator.serviceWorker.register("/inbox/sw.js", { scope: "/inbox/" });
  const reg = await navigator.serviceWorker.ready; // subscribe on an ACTIVE worker (first install)
  const sub = await reg.pushManager.getSubscription();
  const on = sub && Notification.permission === "granted";
  alertsLabel(on ? "Alerts on" : "Turn on alerts", on);
  btn.onclick = () => enableAlerts(reg);
}
async function enableAlerts(reg) {
  const note = $("#alertsNote");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { note.hidden = false; note.textContent = "Alerts are blocked. Turn them on in Settings → Notifications → Inbox."; return; }
    const key = await rpc("bk_inbox_vapid_key", {});
    if (!key) { note.hidden = false; note.textContent = "Alerts aren't set up on the server yet."; return; }
    const appKey = urlB64ToUint8Array(key);
    let sub = await reg.pushManager.getSubscription();
    // a subscription made with an old server key would silently never deliver: replace it
    if (sub && sub.options && sub.options.applicationServerKey &&
        new Uint8Array(sub.options.applicationServerKey).join() !== appKey.join()) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const j = sub.toJSON();
    await rpc("bk_inbox_subscribe", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent });
    await reg.showNotification("✅ Inbox alerts are on", { body: "You'll get one of these for every inquiry, payment and client message.", icon: "/assets/img/inbox-192.png" });
    alertsLabel("Alerts on", true); note.hidden = true;
  } catch (e) {
    note.hidden = false; note.textContent = "Couldn't turn on alerts: " + (e.message || "unknown error");
  }
}

route();
