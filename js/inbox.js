/* Taylormade — Inbox app: alerts + replies pre-filled from real booking data. Spec: docs/superpowers/specs/2026-09-23-inbox-app-design.md */
import { esc, fmtWhen, fmtDay, smsHref, telHref, pushSupport, newKey, urlB64ToUint8Array, listRowHtml, whatLabel } from "./inbox-view.js";
import { buildDraft, draftOptions } from "./inbox-drafts.js";

const sb = window.supabase.createClient(window.BK.SUPABASE_URL, window.BK.SUPABASE_KEY);
const $ = (s) => document.querySelector(s);
const state = { filter: "needs", rows: [], item: null, slots: [], key: newKey(), sending: false, pendingText: false, poll: null };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
function show(id) { ["#loginView", "#listView", "#detailView"].forEach((v) => { $(v).hidden = v !== id; }); }
const draftKey = (id) => `inbox-draft:${id}`;
function saveDraft() { try { if (state.item) sessionStorage.setItem(draftKey(state.item.project.id), $("#draft").value); } catch (_) { /* private mode */ } }
function loadDraft(id) { try { return sessionStorage.getItem(draftKey(id)); } catch (_) { return null; } }
function clearDraft(id) { try { sessionStorage.removeItem(draftKey(id)); } catch (_) { /* ignore */ } }

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    if (/forbidden|JWT|not authenticated/i.test(error.message)) { await sb.auth.signOut(); show("#loginView"); }
    throw error;
  }
  return data;
}

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
  const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + "/inbox/" + location.search } });
  if (error) $("#loginErr").textContent = error.message || "Could not start Google sign-in.";
});
$("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.replace("/inbox/"); });

/* ---------- routing ---------- */
async function route() {
  const { data } = await sb.auth.getSession();
  if (!data.session) { show("#loginView"); return; }
  const id = new URLSearchParams(location.search).get("p");
  if (id) await openItem(id); else await openList();
}
window.addEventListener("popstate", route);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (state.pendingText) { $("#sentIt").hidden = false; state.pendingText = false; }
  if (!$("#listView").hidden) loadList();
});

/* ---------- list ---------- */
async function openList() {
  show("#listView");
  // alerts are optional: a blocked/failed service worker must never keep the list from loading
  setupAlertsButton().catch(() => { $("#alertsBtn").hidden = true; });
  await loadList();
  clearInterval(state.poll); state.poll = setInterval(() => { if (!document.hidden && !$("#listView").hidden) loadList(); }, 20000);
}
async function loadList(more = false) {
  try {
    const before = more && state.rows.length ? state.rows[state.rows.length - 1].last_at : null;
    const rows = await rpc("bk_inbox_list", { p_filter: state.filter, p_before: before });
    state.rows = more ? state.rows.concat(rows) : rows;
    const now = new Date();
    $("#list").innerHTML = state.rows.length
      ? state.rows.map((r) => listRowHtml(r, now)).join("")
      : `<p class="ib-empty">${state.filter === "needs" ? "You're all caught up." : "Nothing here yet."}</p>`;
    $("#moreBtn").hidden = rows.length < 30;
  } catch (e) { if (!$("#listView").hidden) $("#list").innerHTML = `<p class="ib-empty">Couldn't load the inbox. Pull to refresh.</p>`; }
}
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c));
  state.filter = c.dataset.filter; loadList();
}));
$("#moreBtn").addEventListener("click", () => loadList(true));
$("#list").addEventListener("click", (e) => {
  const a = e.target.closest("a.row"); if (!a) return;
  e.preventDefault(); history.pushState({}, "", `?p=${a.dataset.id}`); openItem(a.dataset.id);
});

/* ---------- detail ---------- */
function factRow(label, value) {
  return value ? `<div class="fact"><span>${esc(label)}</span><p>${esc(value)}</p></div>` : "";
}
function renderFacts(it) {
  const p = it.project;
  const b = it.bookings[0];
  const thread = it.messages.map((m) => `<div class="msg ${m.sender}"><span>${m.sender === "client" ? esc(p.client_name.split(/\s+/)[0]) : "You"} · ${esc(fmtWhen(m.created_at))}</span><p>${esc(m.body)}</p></div>`).join("");
  $("#facts").innerHTML = `
    <h1 class="ib-name">${esc(p.client_name)}</h1>
    <p class="ib-what">${esc(whatLabel(p))}${p.company ? " · " + esc(p.company) : ""}</p>
    <div class="ib-contact">${esc(p.client_email)}${p.client_phone ? " · " + esc(p.client_phone) : ""}</div>
    ${b ? factRow("Booked", `${b.service?.name ?? "Session"} · ${fmtWhen(b.starts_at)} · ${b.status}`) : ""}
    ${factRow("Date they asked for", [fmtDay(p.event_date), p.event_time].filter(Boolean).join(" · "))}
    ${factRow("Location", p.location)}
    ${factRow("Budget", p.budget_range)}
    ${factRow("Their message", p.details)}
    ${it.past_projects.length ? factRow("History", `${it.past_projects.length} earlier project${it.past_projects.length > 1 ? "s" : ""}`) : ""}
    ${thread ? `<div class="ib-thread">${thread}</div>` : ""}`;
}
async function openItem(id) {
  show("#detailView"); clearInterval(state.poll);
  $("#facts").innerHTML = `<p class="ib-empty">Loading…</p>`; $("#sentIt").hidden = true; $("#draftErr").textContent = "";
  try { state.item = await rpc("bk_inbox_item", { p_project: id }); }
  catch (_) { $("#facts").innerHTML = `<p class="ib-empty">Couldn't open this one.</p>`; return; }
  state.key = newKey();
  renderFacts(state.item);
  const p = state.item.project;
  $("#markBtn").textContent = p.inbox_handled_at ? "Mark unread" : "Mark handled";
  state.slots = await openSlots(state.item);
  renderTemplates();
  const saved = loadDraft(id);
  setDraft(saved != null ? saved : buildDraft(state.item, state.slots, "suggested"));
  $("#draft").dataset.dirty = saved != null ? "1" : "0";
}
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
function renderTemplates() {
  $("#tpls").innerHTML = draftOptions(state.item, state.slots)
    .map((o) => `<button type="button" class="chip" data-kind="${esc(o.kind)}">${esc(o.label)}</button>`).join("");
}
$("#tpls").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  const box = $("#draft");
  if (box.value.trim() && box.dataset.dirty === "1" && !confirmReplace()) return;
  setDraft(buildDraft(state.item, state.slots, b.dataset.kind)); box.dataset.dirty = "0"; box.focus();
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
$("#draft").addEventListener("input", () => { $("#draft").dataset.dirty = "1"; setDraft($("#draft").value); });
$("#backBtn").addEventListener("click", () => { history.pushState({}, "", "/inbox/"); openList(); });

$("#sendBtn").addEventListener("click", async () => {
  if (state.sending) return;
  const body = $("#draft").value.trim();
  if (!body) { $("#draftErr").textContent = "Write something first."; return; }
  state.sending = true; const btn = $("#sendBtn"); btn.disabled = true; btn.textContent = "Sending…";
  try {
    await rpc("bk_inbox_send", { p_project: state.item.project.id, p_body: body, p_key: state.key });
    clearDraft(state.item.project.id);
    toast(`Sent to ${state.item.project.client_email}`);
    history.pushState({}, "", "/inbox/"); await openList();
  } catch (e) {
    $("#draftErr").textContent = e.message || "Couldn't send. Your reply is still here — try again.";
  } finally { state.sending = false; btn.disabled = false; btn.textContent = "Send email"; }
});
$("#smsBtn").addEventListener("click", () => { state.pendingText = true; });
$("#sentItYes").addEventListener("click", () => mark(true));
$("#sentItNo").addEventListener("click", () => { $("#sentIt").hidden = true; });
$("#markBtn").addEventListener("click", () => mark(!state.item.project.inbox_handled_at));
async function mark(handled) {
  try {
    await rpc("bk_inbox_mark", { p_project: state.item.project.id, p_handled: handled });
    toast(handled ? "Marked handled" : "Marked unread");
    history.pushState({}, "", "/inbox/"); await openList();
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
async function setupAlertsButton() {
  const btn = $("#alertsBtn"), note = $("#alertsNote");
  const support = pushSupport(env());
  if (support === "install") {
    btn.textContent = "Get alerts"; note.hidden = true;
    btn.onclick = () => { note.hidden = false; note.textContent = "Tap Share, then Add to Home Screen. Open Inbox from your home screen and turn on alerts there."; };
    return;
  }
  if (support === "unsupported") { btn.hidden = true; return; }
  const reg = await navigator.serviceWorker.register("/inbox/sw.js", { scope: "/inbox/" });
  const sub = await reg.pushManager.getSubscription();
  btn.textContent = sub && Notification.permission === "granted" ? "Alerts on ✓" : "Turn on alerts";
  btn.onclick = () => enableAlerts(reg);
}
async function enableAlerts(reg) {
  const note = $("#alertsNote");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { note.hidden = false; note.textContent = "Alerts are blocked. Turn them on in Settings → Notifications → Inbox."; return; }
    const key = await rpc("bk_inbox_vapid_key", {});
    if (!key) { note.hidden = false; note.textContent = "Alerts aren't set up on the server yet."; return; }
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
    const j = sub.toJSON();
    await rpc("bk_inbox_subscribe", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent });
    await reg.showNotification("✅ Inbox alerts are on", { body: "You'll feel a buzz like this for every booking and inquiry.", icon: "/assets/img/inbox-192.png" });
    $("#alertsBtn").textContent = "Alerts on ✓"; note.hidden = true;
  } catch (e) {
    note.hidden = false; note.textContent = "Couldn't turn on alerts: " + (e.message || "unknown error");
  }
}

route();
