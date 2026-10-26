/* Taylormade — Studio · Content calendar: the days · the post (script, shots, captions, status, notes).
   Reads and writes bk_content_posts directly (admin-only RLS, like bk_projects in Studio). */
import { esc, LANES, FORMATS, STATUSES, STATUS_LABEL, PLATFORMS, CAPTION_LIMIT, FILTERS, todayISO, fmtDate, groupByWeek,
  sortPosts, matchesFilter, stats, filterCounts, pickDefault, scriptParas, wordCount, readTime, shotLines, postTimes,
  formatReminder, rowHtml, dayBefore } from "./content-view.js?v=2";

const sb = window.supabase.createClient(window.BK.SUPABASE_URL, window.BK.SUPABASE_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const COPY_ICON = $("#copyScript svg").outerHTML;
const CHECK_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>`;
const state = { posts: [], filter: "all", sel: null, plat: "instagram", today: todayISO(), loaded: false, hiddenAt: 0, listY: 0 };
// an unsaved note survives switching posts and reloads (same idea as the Inbox's reply drafts)
const noteKey = (id) => `content-note:${id}`;
const notes = {
  get(id) { try { return sessionStorage.getItem(noteKey(id)); } catch (_) { return null; } },
  set(id, v) { try { sessionStorage.setItem(noteKey(id), v); } catch (_) { /* private mode */ } },
  delete(id) { try { sessionStorage.removeItem(noteKey(id)); } catch (_) { /* ignore */ } },
};
const wide = () => window.matchMedia("(min-width: 760px)").matches;
const byId = (id) => state.posts.find((p) => p.id === id);
// re-rendering a button group mustn't throw keyboard focus back to the top of the page
function keepFocus(render) {
  const a = document.activeElement, key = a?.dataset && ["status", "plat", "filter"].find((k) => k in a.dataset);
  const group = key && a.closest("[id]")?.id, val = key && a.dataset[key];
  render();
  if (group) document.querySelector(`#${group} [data-${key}="${val}"]`)?.focus({ preventScroll: true });
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
async function table(build, retried = false) {
  const { data, error } = await build();
  if (error) {
    // an expired token after the phone wakes is normal: refresh and try once more
    if (/JWT|expired/i.test(error.message || "")) {
      if (!retried) { await sb.auth.refreshSession().catch(() => {}); return table(build, true); }
      // the sign-in can't be refreshed: say so and ask for it, instead of blaming the connection
      showLogin(); $("#loginErr").textContent = "Your sign-in ran out. Sign in again to keep going.";
    }
    throw error;
  }
  return data;
}

/* ---------- auth ---------- */
function showLogin() { $("#loginView").hidden = false; $("#topBar").hidden = true; $("#calView").hidden = true; }
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginBtn"); $("#loginErr").textContent = ""; btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) { $("#loginErr").textContent = error.message || "Could not sign in."; return; }
  boot();
});
$("#googleBtn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
  if (error) $("#loginErr").textContent = error.message || "Could not start Google sign-in.";
});
$("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.replace(location.pathname); });

(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) boot(); else showLogin();
})();

async function boot() {
  $("#loginView").hidden = true; $("#topBar").hidden = false; $("#calView").hidden = false;
  renderList(); // skeleton
  await load();
}

/* ---------- data ---------- */
async function load() {
  state.today = todayISO();
  try {
    const fresh = sortPosts(await table(() => sb.from("bk_content_posts").select("*").order("post_date").order("sort")));
    keepNoteDraft(); // anything typed while that was loading
    state.posts = fresh;
  } catch (_) {
    state.loaded = false;
    $("#list").removeAttribute("aria-busy");
    $("#list").innerHTML = `<div class="lempty"><p class="lempty-big">Couldn't load</p><p>The calendar didn't come back. Check the connection and try again.</p><button type="button" class="btn btn-gold btn-sm" id="retryBtn">Try again</button></div>`;
    $("#retryBtn").addEventListener("click", load);
    showWorkEmpty("Couldn't load", "Nothing to show until the calendar loads.");
    return;
  }
  state.loaded = true;
  if (!state.posts.length && !(await isAdmin())) {
    renderAll();
    showWorkEmpty("Not the studio account", "Sign in with the account that runs Studio to see the calendar.");
    $("#list").innerHTML = `<div class="lempty"><p class="lempty-big">Signed in, but not as admin</p><p>This account can't see the calendar.</p></div>`;
    return;
  }
  const want = new URLSearchParams(location.search).get("p");
  if (want && byId(want)) state.sel = want;
  else if (!state.sel || !byId(state.sel)) state.sel = wide() ? pickDefault(state.posts, state.today) : null;
  renderAll();
  if (want && byId(want) && !wide()) openPane(false);
  $(`.cc-row[data-id="${state.sel}"]`)?.scrollIntoView({ block: "nearest" });
}
async function isAdmin() {
  try { const { data, error } = await sb.rpc("bk_is_admin"); return error ? true : data === true; } catch (_) { return true; }
}

/* ---------- top: stats + filters ---------- */
function renderStats() {
  const s = stats(state.posts);
  // the stats are the status filters: tap one to see just those posts, tap it again for all
  const cell = (f, n, label, extra = "") => `<button type="button" class="crm-stat${n ? "" : " zero"}" data-filter="${f}" aria-pressed="${state.filter === f}"><b>${n}${extra}</b><span class="lbl-long">${label}</span><span class="lbl-short">${label}</span></button>`;
  const html = state.posts.length ? cell("film", s.film, "To film") + cell("post", s.post, "To post") + cell("posted", s.posted, "Posted", `<small>/${s.total}</small>`) : "";
  $("#stats").innerHTML = html; $("#statsMini").innerHTML = html;
  const first = state.posts[0], last = state.posts[state.posts.length - 1];
  const runs = first ? (first.post_date === last.post_date ? fmtDate(first.post_date).short : `${fmtDate(first.post_date).short.slice(4)}–${fmtDate(last.post_date).short.slice(4)}`) : "";
  $("#runLabel").textContent = runs;
}
function renderFilters() {
  const c = filterCounts(state.posts);
  $("#filters").innerHTML = FILTERS.map(([k, label]) =>
    `<button type="button" data-filter="${k}" aria-pressed="${state.filter === k}">${label} <span>${c[k]}</span></button>`).join("");
}
document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-filter]");
  if (!f) return;
  state.filter = state.filter === f.dataset.filter && f.classList.contains("crm-stat") ? "all" : f.dataset.filter;
  keepFocus(() => { renderStats(); renderFilters(); renderList(); });
});

/* ---------- the days ---------- */
function renderList() {
  const list = $("#list");
  if (!state.loaded) { list.setAttribute("aria-busy", "true"); list.innerHTML = '<div class="crow-sk"><i></i><span><b></b><b></b></span></div>'.repeat(6); return; }
  list.removeAttribute("aria-busy");
  if (!state.posts.length) {
    list.innerHTML = `<div class="lempty"><p class="lempty-big">Nothing planned yet</p><p>When Claude builds your next run of posts, they land here, one row per day.</p></div>`;
    return;
  }
  const shown = state.posts.filter((p) => matchesFilter(p, state.filter));
  if (!shown.length) {
    list.innerHTML = `<div class="lempty"><p class="lempty-big">None here</p><p>No posts match this filter.</p><button type="button" class="btn btn-ghost btn-sm" data-filter="all">Show all</button></div>`;
    return;
  }
  list.innerHTML = groupByWeek(shown, state.today).map((g) =>
    `<h2 class="lgroup">${esc(g.name)} <span>${esc(g.range)}</span></h2>${g.posts.map((p) => rowHtml(p, { sel: p.id === state.sel, today: state.today })).join("")}`).join("");
}
$("#list").addEventListener("click", (e) => {
  const row = e.target.closest(".cc-row");
  if (!row || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  select(row.dataset.id, true);
});

function select(id, fromList) {
  if (!byId(id)) return;
  keepNoteDraft();
  state.sel = id;
  const url = `${location.pathname}?p=${encodeURIComponent(id)}`;
  if (!wide() && fromList) { state.listY = window.scrollY; history.pushState({ p: id }, "", url); }
  else history.replaceState({ p: id }, "", url);
  $$(".cc-row").forEach((r) => { const on = r.dataset.id === id; r.classList.toggle("is-sel", on); on ? r.setAttribute("aria-current", "true") : r.removeAttribute("aria-current"); });
  renderPost();
  if (!wide()) openPane(true);
  else if (fromList) $("#pTitle").focus({ preventScroll: true });
}
function openPane(scrollTop) {
  $("#calView").dataset.pane = "work";
  $("#wbar").hidden = false;
  if (scrollTop) window.scrollTo(0, 0);
}
function closePane() {
  if (!history.state?.p && new URLSearchParams(location.search).get("p")) history.replaceState(null, "", location.pathname);
  $("#calView").dataset.pane = "list";
  $("#wbar").hidden = true;
  requestAnimationFrame(() => {
    window.scrollTo(0, state.listY || 0);
    $(`.cc-row[data-id="${state.sel}"]`)?.focus({ preventScroll: true });
  });
}
$("#backBtn").addEventListener("click", () => { if (history.state?.p) history.back(); else closePane(); });
window.addEventListener("popstate", () => {
  if (wide()) return;
  const id = new URLSearchParams(location.search).get("p");
  if (id && byId(id)) { state.sel = id; renderPost(); openPane(true); } else closePane();
});
// the slim phone bar names the post once its big title has scrolled away
const titleWatch = new IntersectionObserver(([e]) => $("#wbar").classList.toggle("show-name", !e.isIntersecting), { rootMargin: "-120px 0px 0px 0px" });
titleWatch.observe($("#pTitle"));

/* ---------- the post ---------- */
function showWorkEmpty(big, small) {
  $("#whead").hidden = true; $("#pBody").hidden = true; $("#workEmpty").hidden = false;
  $("#workEmpty").innerHTML = `<p class="work-empty-tag">${esc(big)}</p><p>${esc(small)}</p>`;
}
function renderAll() { renderStats(); renderFilters(); renderList(); renderPost(); }

function renderPost() {
  const p = byId(state.sel);
  if (!p) {
    if (state.loaded) state.posts.length ? showWorkEmpty("Pick a day", "Choose a post on the left to see its script, shots and captions.") : showWorkEmpty("Nothing planned yet", "Your next run of posts will show up here.");
    return;
  }
  const d = fmtDate(p.post_date);
  $("#workEmpty").hidden = true; $("#whead").hidden = false; $("#pBody").hidden = false;
  $("#crumb").innerHTML = `Content<span>/</span>${esc(d.long)}${p.post_date === state.today ? "<span>/</span>Today" : ""}`;
  $("#pTitle").textContent = p.title;
  $("#pTitle").classList.toggle("long", p.title.length > 30);
  $("#wbarName").textContent = p.title;
  $("#pSub").innerHTML = [LANES[p.lane] || p.lane, FORMATS[p.format] || p.format, p.pillar].filter(Boolean).map((x) => `<b>${esc(x)}</b>`).join("<span>·</span>");
  renderStatus(p);

  // 01 hook & cover
  $("#pHook").textContent = p.hook || "No on-screen hook for this one.";
  $("#pHook").classList.toggle("is-none", !p.hook);
  const by = p.format === "bts_reel" ? "Cut by" : p.format === "talking_head" ? "Film by" : "";
  $("#pFacts").innerHTML = [[by, by && fmtDate(dayBefore(p.post_date)).long], ["Cover", p.cover], ["Call to action", p.cta]].filter(([k, v]) => k && v)
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");

  // 02 script
  const paras = scriptParas(p.script);
  $("#scriptMeta").textContent = paras.length ? `${wordCount(p.script)} words · ${readTime(p.script)}` : "";
  $("#pScript").innerHTML = paras.length ? paras.map((x) => `<li><p>${esc(x)}</p></li>`).join("")
    : `<li class="cc-none">No script. This one is a BTS cut with no talking; the shot list below is the edit.</li>`;
  $("#scriptFoot").hidden = !paras.length;
  $("#notesWhere").innerHTML = p.notes_title
    ? `<span>In Apple Notes</span>${esc(p.notes_title)}` : "";
  resetCopy($("#copyScript"));

  // 03 shots
  $("#pShots").innerHTML = shotLines(p.shots).map((s) => s.code
    ? `<li><span class="cc-code">${esc(s.code)}</span><span>${esc(s.text)}</span></li>`
    : `<li class="cc-note"><span>${esc(s.text)}</span></li>`).join("") || `<li class="cc-note"><span>No shot list.</span></li>`;

  // 04 captions
  renderCaption(p);
  // 05 checks
  const items = [formatReminder(p.format), ...(p.checks || [])].filter(Boolean);
  $("#pChecks").innerHTML = items.length ? items.map((c, i) => `<li${i === 0 && formatReminder(p.format) ? ' class="cc-standing"' : ""}>${esc(c)}</li>`).join("") : `<li class="cc-standing">Nothing to confirm.</li>`;
  // 06 notes (an unsaved note survives moving between posts)
  const v = notes.get(p.id) ?? p.notes ?? "";
  if ($("#noteBox").value !== v) $("#noteBox").value = v; // same text: leave the caret where he is typing
  noteDirty();
}

function renderStatus(p) {
  $("#statusGroup").innerHTML = STATUSES.map((s, i) =>
    `<button type="button" data-status="${s}" aria-pressed="${p.status === s}"${STATUSES.indexOf(p.status) > i ? ' class="is-past"' : ""}>${STATUS_LABEL[s]}</button>`).join("");
}
const statusSeq = new Map(); // post id → number of its latest tap; older answers are ignored
function showStatus(id) {
  const p = byId(id);
  keepFocus(() => { if (p && state.sel === id) renderStatus(p); renderStats(); renderFilters(); refreshRow(id); });
}
$("#statusGroup").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-status]");
  const p = byId(state.sel);
  if (!b || !p || b.dataset.status === p.status) return;
  const id = p.id, want = b.dataset.status, before = p.status, seq = (statusSeq.get(id) || 0) + 1;
  statusSeq.set(id, seq);
  p.status = want; // show it at once; correct it if the save fails
  showStatus(id);
  try {
    const rows = await table(() => sb.from("bk_content_posts").update({ status: want }).eq("id", id).select("id, status, updated_at"));
    if (!rows?.length) throw new Error("refused");
    if (statusSeq.get(id) !== seq) return; // a newer tap owns this post now
    const cur = byId(id); if (cur) Object.assign(cur, rows[0]);
    showStatus(id);
    toast(`Marked ${STATUS_LABEL[want].toLowerCase()}`);
  } catch (_) {
    if (statusSeq.get(id) !== seq) return;
    let real = before; // ask the database what it says rather than guess
    try { const r = await table(() => sb.from("bk_content_posts").select("id, status, updated_at").eq("id", id)); real = r?.find((x) => x.id === id)?.status || before; } catch (_) { /* keep before */ }
    if (statusSeq.get(id) !== seq) return;
    const cur = byId(id); if (cur) cur.status = real;
    showStatus(id);
    toast("Didn't save. Check the connection and try again.");
  }
});
function refreshRow(id) {
  const p = byId(id), row = $(`.cc-row[data-id="${id}"]`);
  if (!p || !row) return renderList();
  if (!matchesFilter(p, state.filter)) return renderList();
  const focused = document.activeElement === row;
  row.outerHTML = rowHtml(p, { sel: p.id === state.sel, today: state.today });
  if (focused) $(`.cc-row[data-id="${id}"]`)?.focus({ preventScroll: true });
}

function renderCaption(p) {
  const caps = p.captions || {};
  $("#platforms").innerHTML = PLATFORMS.map(([k, label]) =>
    `<button type="button" data-plat="${k}" aria-pressed="${state.plat === k}"${caps[k] ? "" : " disabled"}>${label}</button>`).join("");
  if (!caps[state.plat]) state.plat = (PLATFORMS.find(([k]) => caps[k]) || PLATFORMS[0])[0];
  $$("#platforms [data-plat]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.plat === state.plat)));
  const text = caps[state.plat] || "";
  $("#pCaption").textContent = text || "No caption for this platform.";
  $("#pCaption").classList.toggle("is-none", !text);
  const t = postTimes(p.post_date)[state.plat];
  $("#capWhen").innerHTML = `<span>Suggested time</span>${esc(t)} Central`;
  const n = [...text].length, max = CAPTION_LIMIT[state.plat];
  $("#capCount").textContent = text ? `${n.toLocaleString()} / ${max.toLocaleString()}` : "";
  $("#capCount").classList.toggle("is-over", n > max);
  $("#copyCaption").disabled = !text;
  resetCopy($("#copyCaption"));
}
$("#platforms").addEventListener("click", (e) => {
  const b = e.target.closest("[data-plat]");
  if (!b || b.disabled) return;
  state.plat = b.dataset.plat;
  keepFocus(() => renderCaption(byId(state.sel)));
});

/* ---------- copy ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove(); return ok;
  }
}
function resetCopy(btn) { clearTimeout(btn._t); btn.classList.remove("is-done"); btn.innerHTML = `${COPY_ICON}<span>${btn.dataset.label}</span>`; }
async function doCopy(btn, text, what) {
  if (!text) return;
  if (!(await copyText(text))) { toast("Couldn't copy. Select the text and copy it by hand."); return; }
  btn.classList.add("is-done"); btn.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
  $("#srStatus").textContent = `${what} copied`;
  clearTimeout(btn._t); btn._t = setTimeout(() => resetCopy(btn), 1800);
}
// the script copies as spoken lines only, one paragraph each, the way Taylormade Camera wants it
$("#copyScript").addEventListener("click", (e) => { const p = byId(state.sel); doCopy(e.currentTarget, scriptParas(p?.script).join("\n\n"), "Script"); });
$("#copyCaption").addEventListener("click", (e) => { const p = byId(state.sel); doCopy(e.currentTarget, p?.captions?.[state.plat] || "", "Caption"); });

/* ---------- notes ---------- */
function noteDirty() {
  const p = byId(state.sel);
  const dirty = !!p && $("#noteBox").value !== (p.notes || "");
  $("#noteSave").disabled = !dirty;
  $("#noteState").textContent = dirty ? "Not saved yet" : (p?.notes ? "Saved" : "");
  return dirty;
}
function keepNoteDraft() {
  const p = byId(state.sel);
  if (!p) return;
  if ($("#noteBox").value !== (p.notes || "")) notes.set(p.id, $("#noteBox").value); else notes.delete(p.id);
}
// notes save themselves a moment after he stops typing and when he leaves the box (like Apple Notes)
let noteTimer = 0, noteSaving = false, noteAgain = false;
$("#noteBox").addEventListener("input", () => { noteDirty(); keepNoteDraft(); clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 1200); });
$("#noteBox").addEventListener("blur", () => { clearTimeout(noteTimer); if (noteDirty()) saveNote(); });
$("#noteBox").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); clearTimeout(noteTimer); saveNote(); } });
$("#noteSave").addEventListener("click", () => { clearTimeout(noteTimer); saveNote(); });
async function saveNote() {
  const p = byId(state.sel);
  if (!p || !noteDirty()) return;
  if (noteSaving) { noteAgain = true; return; }
  const id = p.id, text = $("#noteBox").value;
  noteSaving = true; $("#noteSave").disabled = true; $("#noteState").textContent = "Saving…";
  try {
    const rows = await table(() => sb.from("bk_content_posts").update({ notes: text }).eq("id", id).select("id, notes, updated_at"));
    if (!rows?.length) throw new Error("refused");
    const cur = byId(id); if (cur) Object.assign(cur, rows[0]);
    if (notes.get(id) === text) notes.delete(id);
    if (state.sel === id) noteDirty();
  } catch (_) {
    if (state.sel === id) { $("#noteSave").disabled = false; $("#noteState").textContent = "Didn't save. Try again."; }
    else toast("A note didn't save. Open that post and try again.");
  } finally {
    noteSaving = false;
    if (noteAgain) { noteAgain = false; saveNote(); }
  }
}
window.addEventListener("pagehide", keepNoteDraft);

/* ---------- keep it fresh ---------- */
// coming back to the tab (say, after posting from the phone) reloads quietly; a note being typed is kept
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { state.hiddenAt = Date.now(); return; }
  if (state.loaded && Date.now() - state.hiddenAt > 60000) load();
});
// moving between phone and computer layouts
window.matchMedia("(min-width: 760px)").addEventListener("change", (m) => {
  if (m.matches) { $("#calView").dataset.pane = "list"; $("#wbar").hidden = true; if (!state.sel) { state.sel = pickDefault(state.posts, state.today); renderAll(); } }
});
// "j" / "k" step through the days on a computer, like the Inbox's list
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || !wide()) return;
  if (e.key !== "j" && e.key !== "k") return;
  const rows = $$(".cc-row"); const i = rows.findIndex((r) => r.dataset.id === state.sel);
  const next = rows[e.key === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)];
  if (next) { select(next.dataset.id, false); next.scrollIntoView({ block: "nearest" }); }
});
