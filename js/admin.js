/* Taylormade — BOOK · studio dashboard (admin) */

const sb = window.supabase.createClient(BK.SUPABASE_URL, BK.SUPABASE_KEY);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const fmtD = (d) => d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const fmtLong = (d) => d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
const fmtTime = (d) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const dollars = (c) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
// "$12.4K" / "$124K" / "$1.2M" for the phone stat strip, where the exact total doesn't fit
const dollarsShort = (c) => {
  const d = c / 100;
  if (d < 10000) return dollars(c);
  if (d < 1e6) return `$${(d / 1000).toFixed(d < 1e5 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `$${(d / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
};
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");
const coarse = () => window.matchMedia("(pointer: coarse)").matches;
// "Dr. Melva K. Wallace" → "Melva": what the chat labels and reply box call the client
const firstName = (n) => ((n || "").replace(/^(dr|mr|mrs|ms|mx|miss)\.?\s+/i, "").trim().split(/\s+/)[0]) || "client";
const ICON_LINK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>`;
const ICON_ARROW = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>`;

const SERVICES = { music_video: "Music video", brand_content: "Brand content", photography: "Photography", event: "Event", digitals: "Digitals", other: "Other" };
const STATUSES = ["new", "quoted", "booked", "in_production", "delivered", "archived", "lost"];
const SLABEL = { new: "New", quoted: "Quoted", booked: "Booked", in_production: "Production", delivered: "Delivered", archived: "Archived", lost: "Lost" };

const state = { projects: [], filter: "active", q: "", sel: null, poll: null };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2400);
}

/* ---------------- auth ---------------- */
init();
async function init() {
  const { data } = await sb.auth.getSession();
  if (data.session) await boot();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginBtn"), err = $("#loginErr");
  err.textContent = ""; btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) { err.textContent = error.message || "Could not sign in."; return; }
  await boot();
});
$("#googleBtn").addEventListener("click", async () => {
  const err = $("#loginErr");
  err.textContent = "";
  // returns to this exact page; supabase-js picks the session up on the way back
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) err.textContent = error.message || "Could not start Google sign-in.";
});
$("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

async function boot() {
  // verify admin (RLS will return nothing for non-admins anyway)
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  const { data } = await sb.auth.getSession();
  const u = data.session?.user;
  if (u) {
    const name = u.user_metadata?.full_name || u.user_metadata?.name || "";
    const ini = name ? name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2) : (u.email || "?")[0];
    $("#avatar").textContent = ini.toUpperCase();
    $("#avatar").title = u.email || "";
  }
  renderFilters();
  await load();
  state.poll = setInterval(() => { if (!document.hidden) load(); }, 15000);
}

/* ---------------- data ---------------- */
// afterSend: Nelson just sent a reply, so redraw even though his cursor is still in the reply box
async function load(afterSend = false) {
  const { data, error } = await sb
    .from("bk_projects")
    .select("*, bk_invoices(*), bk_messages(*), bk_files(*), bk_galleries(*, bk_gallery_items(*))")
    .order("updated_at", { ascending: false });
  if (error) {
    toast("Load failed. Are you signed in as admin?");
    if (!state.projects.length) {
      $("#plist").removeAttribute("aria-busy");
      $("#plist").innerHTML = `<div class="plist-empty">Couldn't load the pipeline. Trying again every 15 seconds.</div>`;
    }
    return;
  }
  state.projects = data || [];
  const rowFocus = document.activeElement?.closest?.(".prow")?.dataset.id;
  renderStats();
  renderList();
  if (rowFocus) $(`.prow[data-id="${rowFocus}"]`)?.focus({ preventScroll: true });
  if (state.sel) {
    const p = state.projects.find((x) => x.id === state.sel);
    // never re-render the detail pane while Nelson is typing or uploading —
    // a rebuild would wipe half-typed fields or interrupt an upload
    const ae = document.activeElement;
    const typing = ae && $("#dpane").contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    // …nor while a contract draft is open in the editor — unsaved contract copy
    // must survive the poll even if focus wanders outside the textarea
    const editingContract = !!document.getElementById("ctEditor");
    if (p && (afterSend || !typing) && !state.uploading && !editingContract) renderDetail(p, true);
  }
  state.chatToEnd = false;
}

/* preserve form values + focus across detail re-renders */
const FORM_IDS = ["noteBox", "achatInput", "invTitle", "invAmt", "invKind", "fileLabel", "fileUrl", "galTitle", "galLimit", "galKind"];
function captureForms() {
  const ae = document.activeElement;
  const saved = {};
  FORM_IDS.forEach((id) => { const el = document.getElementById(id); if (el) saved[id] = el.value; });
  return {
    saved,
    serverNote: document.getElementById("noteBox")?.defaultValue,
    focusId: ae && FORM_IDS.includes(ae.id) ? ae.id : null,
    selStart: ae?.selectionStart, selEnd: ae?.selectionEnd,
  };
}
function restoreForms(cap) {
  if (!cap) return;
  FORM_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el || cap.saved[id] == null) return;
    if (id === "noteBox") {
      // restore unsaved typing only (typed value differs from the server copy it started from)
      if (cap.serverNote != null && cap.saved[id] !== cap.serverNote) el.value = cap.saved[id];
    } else if (cap.saved[id] !== "") {
      el.value = cap.saved[id];
    }
  });
  if (cap.focusId) {
    const el = document.getElementById(cap.focusId);
    if (el) {
      el.focus();
      try { el.setSelectionRange(cap.selStart, cap.selEnd); } catch (_) { /* selects/numbers */ }
    }
  }
}

const unreadCount = (p) => p.bk_messages.filter((m) => m.sender === "client" && !m.read_at).length;

/* ---------------- stats ---------------- */
function renderStats() {
  const ps = state.projects;
  const newCount = ps.filter((p) => p.status === "new").length;
  const unread = ps.reduce((n, p) => n + unreadCount(p), 0);
  const collected = ps.flatMap((p) => p.bk_invoices).filter((i) => i.status === "paid").reduce((n, i) => n + i.amount_cents, 0);
  const booked = ps.filter((p) => ["booked", "in_production"].includes(p.status)).length;
  const stat = (n, one, many, show = n) => `<div class="stat ${n ? "" : "zero"}"><b>${show}</b><span>${n === 1 ? one : many}</span></div>`;
  $("#stats").innerHTML =
    stat(newCount, "New inquiry", "New inquiries") +
    stat(unread, "Unread message", "Unread messages") +
    stat(booked, "Active project", "Active projects") +
    stat(collected, "Collected", "Collected", `<span class="full">${dollars(collected)}</span><span class="short" title="${dollars(collected)}">${dollarsShort(collected)}</span>`);
}

/* ---------------- list + filters ---------------- */
const FILTERS = [["active", "Active"], ["new", "New"], ["quoted", "Quoted"], ["booked", "Booked"], ["in_production", "Production"], ["delivered", "Delivered"], ["all", "All"]];
function renderFilters() {
  $("#filters").innerHTML = FILTERS.map(([v, l]) => `<button data-f="${v}" class="${state.filter === v ? "on" : ""}">${l}</button>`).join("");
}
$("#pSearch").addEventListener("input", (e) => {
  state.q = e.target.value;
  renderList();
});
$("#pSearch").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.target.value = ""; state.q = ""; renderList(); }
});
// "/" jumps to search from anywhere that isn't a text field
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || $("#appView").hidden) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  e.preventDefault();
  $("#pSearch").focus();
});
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f;
  renderFilters();
  renderList();
});

function visibleProjects() {
  let ps = state.projects;
  if (state.filter === "active") ps = ps.filter((p) => !["archived", "lost"].includes(p.status));
  else if (state.filter !== "all") ps = ps.filter((p) => p.status === state.filter);
  const q = state.q.trim().toLowerCase();
  if (!q) return ps;
  // every word has to match somewhere: "wallace photo" finds Dr. Wallace's photography project
  const words = q.split(/\s+/);
  return ps.filter((p) => {
    const hay = [p.client_name, p.company, p.client_email, p.client_phone, p.title, p.location, SERVICES[p.service]]
      .filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const ST_CLASS = { new: "st-new", quoted: "st-quoted", booked: "st-gold", in_production: "st-gold", delivered: "st-green", archived: "st-dim", lost: "st-dim" };

function renderList() {
  const ps = visibleProjects();
  const q = state.q.trim();
  $("#plist").removeAttribute("aria-busy");
  $("#plist").innerHTML = ps.length ? ps.map((p) => {
    const n = unreadCount(p);
    return `
    <button class="prow ${state.sel === p.id ? "sel" : ""}" data-id="${p.id}" ${state.sel === p.id ? `aria-current="true"` : ""}>
      <span><b>${esc(p.client_name)}${!p.company ? "" : (p.client_name + p.company).length > 24 ? `<span class="co">${esc(p.company)}</span>` : ` · ${esc(p.company)}`}</b>
      <small>${esc(SERVICES[p.service] || p.service)} · ${fmtD(p.event_date)}</small></span>
      <span class="meta">
        ${n ? `<span class="unread" aria-label="${n} unread">${n}</span>` : ""}
        <span class="st ${ST_CLASS[p.status] || ""}">${SLABEL[p.status] || esc(p.status)}</span>
      </span>
    </button>`;
  }).join("")
    : q ? `<div class="plist-empty">No projects match “${esc(q)}”.<button type="button" data-clearq>Clear search</button></div>`
    : `<div class="plist-empty">Nothing in this view yet.</div>`;
}
$("#plist").addEventListener("click", (e) => {
  if (e.target.closest("[data-clearq]")) { $("#pSearch").value = ""; state.q = ""; renderList(); $("#pSearch").focus(); return; }
  const r = e.target.closest(".prow");
  if (!r) return;
  state.sel = r.dataset.id;
  renderList();
  const p = state.projects.find((x) => x.id === state.sel);
  renderDetail(p);
  $("#dpane h1")?.focus({ preventScroll: true });
  markRead(p);
  // stacked mobile layout: the detail pane renders below the fold — go to it
  if (window.matchMedia("(max-width: 960px)").matches) {
    $("#dpane").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

async function markRead(p) {
  const ids = p.bk_messages.filter((m) => m.sender === "client" && !m.read_at).map((m) => m.id);
  if (!ids.length) return;
  await sb.from("bk_messages").update({ read_at: new Date().toISOString() }).in("id", ids);
  p.bk_messages.forEach((m) => { if (ids.includes(m.id)) m.read_at = new Date().toISOString(); });
  renderStats(); renderList();
}

/* ---------------- detail ---------------- */
function portalUrl(p) {
  return `${location.origin}${location.pathname.replace(/admin\.html$/, "")}portal.html?p=${p.id}&t=${p.access_token}`;
}

function renderDetail(p, keepScroll = false) {
  const pane = $("#dpane");
  const formCap = keepScroll ? captureForms() : null;
  const h1Focus = document.activeElement?.matches?.("#dpane h1");
  const chatBox = keepScroll ? $("#achatScroll")?.scrollTop : null;
  const inv = p.bk_invoices.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const msgs = p.bk_messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const files = p.bk_files.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const paid = inv.filter((i) => i.status === "paid").reduce((n, i) => n + i.amount_cents, 0);
  const heading = `${p.client_name}${p.company ? ` — ${p.company}` : ""}`;
  const who = firstName(p.client_name);
  // a divider each time the conversation moves to a new day
  let lastDay = "";
  const thread = msgs.map((m) => {
    const day = new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const sep = day !== lastDay ? `<div class="chat-day">${day}</div>` : "";
    lastDay = day;
    return `${sep}
                <div class="msg ${m.sender}"><span class="msg-body">${esc(m.body).trim().split(/\n[ \t]*\n+/).map((para) => `<span class="msg-p">${para}</span>`).join("")}</span>
                <time datetime="${esc(m.created_at)}">${m.sender === "studio" ? "You" : esc(who)} · ${fmtTime(m.created_at)}</time></div>`;
  }).join("");
  const head = (n, title, aside = "") => `<div class="acard-head"><span class="num">${n}</span><h3>${title}</h3>${aside}</div>`;

  pane.innerHTML = `
    <div class="dhead">
      <div>
        <div class="crumb">Project<span>/</span>${p.id.slice(0, 8).toUpperCase()}</div>
        <h1 class="${heading.length > 26 ? "long" : ""}" tabindex="-1">${esc(heading)}</h1>
        <div class="sub">${esc(SERVICES[p.service] || p.service)}${p.event_date ? `<span>·</span>${fmtLong(p.event_date)}` : ""}</div>
      </div>
      <div class="dactions">
        <button class="btn btn-ghost back-list" id="backList">← Pipeline</button>
        <select id="statusSel" aria-label="Project status">${STATUSES.map((s) => `<option value="${s}" ${p.status === s ? "selected" : ""}>${SLABEL[s]}</option>`).join("")}</select>
        <button class="btn btn-ghost" id="copyPortal">${ICON_LINK}Copy portal link</button>
      </div>
    </div>

    <div class="dgrid">
      <div class="dcol">
        <section data-k="brief" class="acard">
          ${head("01", "Client brief")}
          <div class="kv2">
            <div><span>Email</span><a href="mailto:${esc(p.client_email)}">${esc(p.client_email)}</a></div>
            <div><span>Phone</span>${p.client_phone ? `<a href="tel:${esc(p.client_phone)}">${esc(p.client_phone)}</a>` : "—"}</div>
            <div><span>Shoot date</span>${fmtD(p.event_date)}</div>
            <div><span>Location</span>${esc(p.location || "—")}</div>
            <div><span>Budget</span>${esc(p.budget_range || "—")}</div>
            <div><span>Source</span>${esc(p.referral_source || "—")}</div>
            ${p.details ? `<div class="wide"><span>The vision</span>${esc(p.details)}</div>` : ""}
          </div>
        </section>

        <section data-k="invoices" class="acard">
          ${head("02", "Invoices", `<span class="aside">${money(paid)} paid</span>`)}
          ${inv.length ? inv.map((i) => `
            <div class="ainv">
              <div><div class="t">${esc(i.title)}<span class="pill ${i.status === "paid" ? "green" : i.status === "sent" ? "gold" : i.status === "void" ? "red" : ""}">${i.status}</span></div>
              <small>${esc(cap(i.kind))}${i.paid_at ? ` · paid ${fmtD(i.paid_at)}` : ""}</small></div>
              <span class="a">${money(i.amount_cents)}</span>
              <div class="acts">
                ${i.status === "draft" ? `<button data-inv-send="${i.id}">Send</button>` : ""}
                ${i.status === "sent" ? `<button data-inv-paid="${i.id}">Mark paid</button>` : ""}
                ${i.status !== "void" && i.status !== "paid" ? `<button data-inv-void="${i.id}">Void</button>` : ""}
              </div>
            </div>`).join("") : `<p class="acard-empty">No invoices yet.</p>`}
          <div class="inv-new">
            <input id="invTitle" placeholder="Invoice title" aria-label="Invoice title">
            <label class="money-in"><span>$</span><input id="invAmt" type="number" min="1" step="0.01" placeholder="0.00" aria-label="Amount in dollars"></label>
            <select id="invKind" aria-label="Invoice type"><option value="deposit">Deposit</option><option value="balance">Balance</option><option value="full">Full</option><option value="custom">Custom</option></select>
            <button class="btn btn-gold" id="invCreate">Add &amp; send</button>
          </div>
        </section>

        <section data-k="contracts" class="acard">
          ${head("03", "Contracts")}
          <div id="ctBox"><span class="hud">Loading…</span></div>
        </section>

        <section data-k="notes" class="acard notes">
          ${head("04", "Internal notes")}
          <textarea id="noteBox" placeholder="Only you can see this…" aria-label="Internal notes">${esc(p.notes_internal || "")}</textarea>
          <button class="btn btn-ghost btn-sm" id="noteSave">Save notes</button>
        </section>
      </div>

      <div class="dcol">
        <section data-k="messages" class="acard">
          ${head("05", "Messages <small>· Client line</small>")}
          <div class="achat">
            <div class="chat-scroll" id="achatScroll">
              ${msgs.length ? thread : `<div class="chat-none">No messages yet.</div>`}
            </div>
            <form id="achatForm">
              <textarea id="achatInput" rows="1" placeholder="Reply to ${esc(who)}…" maxlength="4000" aria-label="Reply to ${esc(p.client_name)}"></textarea>
              <button class="btn btn-gold" type="submit">Send ${ICON_ARROW}</button>
            </form>
          </div>
        </section>

        <section data-k="files" class="acard">
          ${head("06", "Files &amp; delivery")}
          ${files.length ? files.map((f) => `
            <div class="file-row">
              <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.label)}</a>
              <button data-file-del="${f.id}">Remove</button>
            </div>`).join("") : `<p class="acard-empty">Share project files and delivery links.</p>`}
          <div class="file-add">
            <input id="fileLabel" placeholder="Label" aria-label="Link label">
            <input id="fileUrl" placeholder="Paste a delivery link…" aria-label="Delivery link (Drive, Dropbox, frame.io)">
            <button class="btn btn-ink" id="fileAdd">Add</button>
          </div>
        </section>
      </div>
    </div>
    ${galleriesCard(p)}`;

  // the project pane scrolls on its own now: a different project starts at its top
  if (!keepScroll) { pane.scrollTop = 0; if (window.matchMedia("(min-width: 961px)").matches) window.scrollTo(0, 0); }
  if (keepScroll && chatBox != null && $("#achatScroll") && !state.chatToEnd) $("#achatScroll").scrollTop = chatBox;
  else if ($("#achatScroll")) $("#achatScroll").scrollTop = $("#achatScroll").scrollHeight;
  state.chatToEnd = false;

  restoreForms(formCap);
  if (h1Focus) $("#dpane h1").focus({ preventScroll: true });
  numberCards();
  autosize($("#achatInput"));
  wireDetail(p);
  hydrateThumbs();
  if (ctState.projectId === p.id) renderContracts(p); // instant paint from cache
  loadContracts(p); // then refresh from the DB
}

// Cards are numbered in reading order: the reference layout in two columns (01-04 left, 05-06 right),
// and brief, messages, invoices… when the pane is one column (see the container query in admin.css).
const ONE_COL_ORDER = ["brief", "messages", "invoices", "contracts", "notes", "files"];
const TWO_COL_ORDER = ["brief", "invoices", "contracts", "notes", "messages", "files"];
function numberCards() {
  const pane = $("#dpane");
  if (!pane.querySelector("[data-k]")) return;
  const cs = getComputedStyle(pane);
  const inner = pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const order = inner <= 900 ? ONE_COL_ORDER : TWO_COL_ORDER;
  order.forEach((k, i) => {
    const num = pane.querySelector(`[data-k="${k}"] .num`);
    if (num) num.textContent = String(i + 1).padStart(2, "0");
  });
}
new ResizeObserver(() => numberCards()).observe($("#dpane"));

// the reply box grows with what Nelson types, up to its max-height
function autosize(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, 180)}px`;
}

/* ---------------- galleries (photos & video) ---------------- */
const GAL_KIND = { proof: "Proofing", final: "Edited photos", video: "Video" };

// Once a client has picked, a proofing gallery leads with just the picks and folds the full set away.
// Remember which full sets Nelson opened so the 15s re-render doesn't snap them shut.
const galShowAll = new Set();
// The name without ".jpg" — what Nelson searches for in Capture One to find the original.
const pickName = (it) => (it.filename || it.storage_path.split("/").pop().replace(/^[0-9a-f-]{36}-/, "")).replace(/\.[^.]+$/, "");

function galleriesCard(p) {
  const gals = (p.bk_galleries || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  const blocks = gals.length ? gals.map((g) => {
    const items = (g.bk_gallery_items || []).slice()
      .sort((a, b) => (a.sort - b.sort) || a.created_at.localeCompare(b.created_at));
    const picks = g.kind === "proof" ? items.filter((i) => i.selected) : [];
    const sel = picks.length;
    const isVideo = g.kind === "video";
    const meta = g.kind === "proof"
      ? `<span class="pill ${sel ? "gold" : ""}">${sel} selected${g.selection_limit != null ? ` / ${g.selection_limit}` : ""}</span>`
      : `<span class="pill">${items.length} item${items.length === 1 ? "" : "s"}</span>`;
    const lockBtn = g.kind === "proof"
      ? `<button class="ga-lock" data-lock="${g.id}" data-on="${g.locked}">${g.locked ? "Locked" : "Open"}</button>` : "";
    const copyBtn = g.kind === "proof" && sel
      ? `<button class="ga-lock" data-copypicks="${g.id}" title="Copy the picked file names, without .jpg">Copy picks</button>` : "";
    const cells = isVideo
      ? items.map((it) => `
          <div class="ga-vrow" data-path="${esc(it.storage_path)}">
            <span class="ga-fn">${esc(it.filename || "Video")}</span>
            <button class="ga-itemdel" data-itemdel="${it.id}" title="Remove">&#10005;</button>
          </div>`).join("")
      : items.map((it) => `
          <figure class="ga-cell ${it.selected ? "sel" : ""}" data-path="${esc(it.storage_path)}">
            <img alt="${esc(it.filename || "")}" data-ph loading="lazy">
            ${it.selected ? `<span class="ga-tick">&#10003;</span>` : ""}
            <button class="ga-itemdel" data-itemdel="${it.id}" title="Remove">&#10005;</button>
          </figure>`).join("");
    const grid = `
        <div class="${isVideo ? "ga-vlist" : "ga-grid"}">
          ${cells}
          <label class="ga-add">
            <input type="file" class="vh" multiple accept="${isVideo ? "video/*" : "image/*"}" data-upload="${g.id}">
            <span>&#43; Upload</span>
          </label>
        </div>`;
    const body = sel ? `
        <div class="ga-picks">
          <div class="ga-picks-head"><span class="hud">Client picks</span><b>${sel}</b></div>
          <ol class="ga-names">${picks.map((it) => `<li>${esc(pickName(it))}${it.extra ? ` <span class="ga-x">extra</span>` : ""}</li>`).join("")}</ol>
          <div class="ga-pgrid">${picks.map((it) => `
            <figure class="ga-pick" data-path="${esc(it.storage_path)}" title="Open full size">
              <img alt="${esc(pickName(it))}" data-ph>
              <figcaption>${esc(pickName(it))}</figcaption>
            </figure>`).join("")}
          </div>
        </div>
        <details class="ga-all" data-galall="${g.id}" ${galShowAll.has(g.id) ? "open" : ""}>
          <summary>All ${items.length} proofs</summary>
          ${grid}
        </details>` : grid;
    return `
      <div class="ga">
        <div class="ga-head">
          <div><span class="hud">${GAL_KIND[g.kind] || g.kind}</span><b>${esc(g.title)}</b></div>
          <div class="ga-meta">${meta}${copyBtn}${lockBtn}<button class="ga-del" data-galdel="${g.id}" title="Delete gallery">&#10005;</button></div>
        </div>
        ${body}
        <div class="ga-prog" data-prog="${g.id}" hidden></div>
      </div>`;
  }).join("") : `<p class="acard-empty">No galleries yet. Proofing lets the client pick shots; edited photos and video are for delivery.</p>`;

  return `
    <section class="acard ga-card">
      <div class="acard-head"><span class="num">07</span><h3>Galleries <small>· Photos &amp; video</small></h3></div>
      ${blocks}
      <div class="ga-new">
        <select id="galKind" aria-label="Gallery type">
          <option value="proof">Proofing (client picks)</option>
          <option value="final">Edited photos</option>
          <option value="video">Video</option>
        </select>
        <input id="galTitle" placeholder="Gallery title" aria-label="Gallery title">
        <input id="galLimit" type="number" min="1" placeholder="Pick limit (optional)" aria-label="Pick limit">
        <button class="btn btn-gold" id="galCreate">New gallery</button>
      </div>
    </section>`;
}

// Grid thumbnails sit next to the original under thumbs/ (same name); older uploads have none.
const thumbPath = (path) => path.replace(/([^/]+)$/, "thumbs/$1");

// The detail pane re-renders on every 15s poll. Re-signing each time would hand the browser
// brand-new URLs and re-download every photo, so keep each signed URL for most of its hour.
const thumbCache = new Map(); // storage path → { url, exp }
async function hydrateThumbs() {
  const imgs = [...$("#dpane").querySelectorAll("[data-path] img[data-ph]")];
  if (!imgs.length) return;
  const now = Date.now();
  const fresh = (path) => { const c = thumbCache.get(path); return c && c.exp > now ? c.url : null; };
  const need = [...new Set(imgs.map((img) => img.closest("[data-path]").dataset.path).filter((path) => !fresh(path)))];
  if (need.length) {
    const bucket = sb.storage.from("project-media");
    const exp = now + 50 * 60 * 1000;
    const { data: thumbs } = await bucket.createSignedUrls(need.map(thumbPath), 3600);
    const missing = [];
    need.forEach((path) => {
      const t = (thumbs || []).find((d) => d.path === thumbPath(path));
      if (t && t.signedUrl) thumbCache.set(path, { url: t.signedUrl, exp });
      else missing.push(path);
    });
    if (missing.length) {
      const { data: full } = await bucket.createSignedUrls(missing, 3600);
      (full || []).forEach((d) => { if (d.signedUrl) thumbCache.set(d.path, { url: d.signedUrl, exp }); });
    }
  }
  imgs.forEach((img) => {
    const url = fresh(img.closest("[data-path]").dataset.path);
    if (url) img.src = url;
  });
}

// preview JPEG for the client + admin grids; null if the browser can't decode the file.
// Proofs: 480px wide (hundreds per set). Finals: 1620px on the long edge, because the client
// portal shows each edit as a big card and opens it in the viewer from the same file.
async function makeThumb(file, final) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = final ? Math.min(1, 1620 / Math.max(bmp.width, bmp.height)) : Math.min(1, 480 / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise((res) => c.toBlob(res, "image/jpeg", final ? 0.82 : 0.74));
  } catch (_) {
    return null;
  }
}

function safeName(name) {
  return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

const MAX_UPLOAD_BYTES = 600 * 1024 * 1024; // 600MB per file

async function uploadToGallery(p, galleryId, files) {
  const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  if (tooBig.length) {
    toast(`${tooBig.length} file${tooBig.length === 1 ? " is" : "s are"} over 600MB, skipped. Compress and retry.`);
    files = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  }
  if (!files.length) return;
  const prog = $(`[data-prog="${galleryId}"]`);
  state.uploading = true;
  let done = 0, failed = 0;
  const total = files.length;
  const show = () => { if (prog) { prog.hidden = false; prog.textContent = `Uploading ${done}/${total}${failed ? ` (${failed} failed)` : ""}…`; } };
  show();
  // find current max sort in this gallery
  const gal = (p.bk_galleries || []).find((g) => g.id === galleryId);
  let sort = ((gal?.bk_gallery_items || []).reduce((m, i) => Math.max(m, i.sort), 0)) + 1;
  for (const file of files) {
    const key = `${p.id}/${galleryId}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const up = await sb.storage.from("project-media").upload(key, file, {
      contentType: file.type || "application/octet-stream", upsert: false,
    });
    if (up.error) { failed++; done++; show(); continue; }
    if (gal?.kind !== "video" && /^image\//.test(file.type)) {
      const thumb = await makeThumb(file, gal?.kind === "final");
      // a missing thumb is fine: the grids fall back to the full image
      if (thumb) await sb.storage.from("project-media").upload(thumbPath(key), thumb, { contentType: "image/jpeg", upsert: true });
    }
    const ins = await sb.from("bk_gallery_items").insert({
      gallery_id: galleryId, project_id: p.id, storage_path: key,
      filename: file.name, content_type: file.type, size_bytes: file.size, sort: sort++,
    });
    if (ins.error) { failed++; }
    done++; show();
  }
  state.uploading = false;
  if (prog) prog.hidden = true;
  toast(failed ? `${total - failed} uploaded, ${failed} failed` : `${total} uploaded. Live for the client.`);
  await load();
}

function wireDetail(p) {
  $("#statusSel").addEventListener("change", async (e) => {
    const { error } = await sb.from("bk_projects").update({ status: e.target.value }).eq("id", p.id);
    if (error) { toast("Update failed"); return; }
    toast(`Status → ${SLABEL[e.target.value]}`);
    await load();
  });

  $("#copyPortal").addEventListener("click", async () => {
    await navigator.clipboard.writeText(portalUrl(p));
    toast("Portal link copied. Text it to the client.");
  });

  // back to the row he came from, not the top of a long list
  $("#backList").addEventListener("click", () => {
    const row = document.querySelector(".prow.sel");
    (row || document.querySelector(".lpane")).scrollIntoView({ behavior: "smooth", block: row ? "center" : "start" });
  });

  $("#invCreate").addEventListener("click", async () => {
    const title = $("#invTitle").value.trim() || "Invoice";
    const amt = Math.round(parseFloat($("#invAmt").value) * 100);
    if (!amt || amt <= 0) { toast("Enter an amount"); return; }
    const { error } = await sb.from("bk_invoices").insert({
      project_id: p.id, title, amount_cents: amt, kind: $("#invKind").value, status: "sent",
      line_items: [{ label: title, amount_cents: amt }],
    });
    if (error) { toast("Invoice failed"); return; }
    $("#invTitle").value = ""; $("#invAmt").value = "";
    toast("Invoice sent. It's in the client portal.");
    await load();
  });

  $("#dpane").querySelectorAll("[data-inv-send]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("bk_invoices").update({ status: "sent" }).eq("id", b.dataset.invSend);
    toast("Invoice sent"); await load();
  }));
  $("#dpane").querySelectorAll("[data-inv-paid]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("bk_invoices").update({ status: "paid", paid_at: new Date().toISOString(), payment_note: "Marked paid manually" }).eq("id", b.dataset.invPaid);
    toast("Marked paid"); await load();
  }));
  $("#dpane").querySelectorAll("[data-inv-void]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Void this invoice? The client won't be able to pay it.")) return;
    await sb.from("bk_invoices").update({ status: "void" }).eq("id", b.dataset.invVoid);
    toast("Invoice voided"); await load();
  }));

  $("#noteSave").addEventListener("click", async () => {
    await sb.from("bk_projects").update({ notes_internal: $("#noteBox").value }).eq("id", p.id);
    toast("Notes saved");
  });

  $("#achatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#achatInput");
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    const { error } = await sb.from("bk_messages").insert({ project_id: p.id, sender: "studio", body });
    if (error) { input.value = body; toast("Send failed"); return; }
    state.chatToEnd = true;
    await load(true);
  });
  $("#achatInput").addEventListener("input", (e) => autosize(e.target));
  // Enter sends on a keyboard; on the phone Return is a new line (there's no Shift+Return) and Send sends
  $("#achatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse()) { e.preventDefault(); $("#achatForm").requestSubmit(); }
  });

  $("#fileAdd").addEventListener("click", async () => {
    const label = $("#fileLabel").value.trim(), url = $("#fileUrl").value.trim();
    if (!label || !/^https?:\/\//.test(url)) { toast("Need a label and a full https:// link"); return; }
    await sb.from("bk_files").insert({ project_id: p.id, label, url });
    $("#fileLabel").value = ""; $("#fileUrl").value = "";
    toast("Link added. It's live in the portal."); await load();
  });
  $("#dpane").querySelectorAll("[data-file-del]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("bk_files").delete().eq("id", b.dataset.fileDel);
    await load();
  }));

  /* galleries */
  const galCreate = $("#galCreate");
  if (galCreate) galCreate.addEventListener("click", async () => {
    const kind = $("#galKind").value;
    const title = $("#galTitle").value.trim() || GAL_KIND[kind];
    const limRaw = $("#galLimit").value.trim();
    const row = { project_id: p.id, kind, title };
    if (kind === "proof" && limRaw) row.selection_limit = Math.max(1, parseInt(limRaw, 10) || 0);
    const { error } = await sb.from("bk_galleries").insert(row);
    if (error) { toast("Could not create gallery"); return; }
    $("#galTitle").value = ""; $("#galLimit").value = "";
    toast(`${GAL_KIND[kind]} gallery created`);
    await load();
  });

  $("#dpane").querySelectorAll("[data-upload]").forEach((inp) =>
    inp.addEventListener("change", () => {
      if (inp.files && inp.files.length) uploadToGallery(p, inp.dataset.upload, [...inp.files]);
    }));

  $("#dpane").querySelectorAll("[data-itemdel]").forEach((b) => b.addEventListener("click", async () => {
    // on a phone the × is always showing, so a stray tap needs a check
    if (coarse() && !confirm("Remove this file from the gallery?")) return;
    const cell = b.closest("[data-path]");
    if (cell) await sb.storage.from("project-media").remove([cell.dataset.path, thumbPath(cell.dataset.path)]);
    await sb.from("bk_gallery_items").delete().eq("id", b.dataset.itemdel);
    await load();
  }));

  $("#dpane").querySelectorAll("[data-copypicks]").forEach((b) => b.addEventListener("click", async () => {
    const gal = (p.bk_galleries || []).find((g) => g.id === b.dataset.copypicks);
    const names = (gal?.bk_gallery_items || []).filter((i) => i.selected)
      .sort((a, z) => a.sort - z.sort).map(pickName);
    try {
      await navigator.clipboard.writeText(names.join("\n"));
      toast(`Copied ${names.length} file name${names.length === 1 ? "" : "s"}`);
    } catch (_) { toast("Couldn't copy. Check clipboard permission."); }
  }));

  $("#dpane").querySelectorAll("[data-galall]").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) galShowAll.add(d.dataset.galall); else galShowAll.delete(d.dataset.galall);
  }));

  // A pick opens full size in a new tab. Open the tab first, inside the click, so it isn't popup-blocked.
  $("#dpane").querySelectorAll(".ga-pick").forEach((fig) => fig.addEventListener("click", async () => {
    const tab = window.open("", "_blank");
    const { data } = await sb.storage.from("project-media").createSignedUrl(fig.dataset.path, 3600);
    if (!tab) return;
    if (data?.signedUrl) { tab.opener = null; tab.location.href = data.signedUrl; }
    else { tab.close(); toast("Couldn't open that photo"); }
  }));

  $("#dpane").querySelectorAll("[data-lock]").forEach((b) => b.addEventListener("click", async () => {
    const on = b.dataset.on !== "true";
    await sb.from("bk_galleries").update({ locked: on }).eq("id", b.dataset.lock);
    toast(on ? "Proofing locked" : "Proofing reopened");
    await load();
  }));

  $("#dpane").querySelectorAll("[data-galdel]").forEach((b) => b.addEventListener("click", async () => {
    const gid = b.dataset.galdel;
    const gal = (p.bk_galleries || []).find((g) => g.id === gid);
    if (!confirm(`Delete "${gal?.title || "this gallery"}" and all its media? This cannot be undone.`)) return;
    const paths = (gal?.bk_gallery_items || []).flatMap((i) => [i.storage_path, thumbPath(i.storage_path)]);
    if (paths.length) await sb.storage.from("project-media").remove(paths);
    await sb.from("bk_galleries").delete().eq("id", gid); // cascades item rows
    toast("Gallery deleted");
    await load();
  }));
}

/* ---------------- contracts (e-sign) ---------------- */
const CT_PILL = { draft: "", sent: "gold", signed: "green", void: "red" };
const ctState = { projectId: null, list: [], templates: null, editing: null, viewing: null, picking: false };

async function loadContracts(p) {
  if (ctState.projectId !== p.id) {
    ctState.projectId = p.id;
    ctState.list = [];
    ctState.editing = null;
    ctState.viewing = null;
    ctState.picking = false;
  }
  const { data, error } = await sb.from("bk_contracts").select("*").eq("project_id", p.id).order("created_at");
  if (state.sel !== p.id || !$("#ctBox")) return; // switched projects while fetching
  if (error) { $("#ctBox").innerHTML = `<p class="acard-empty">Contracts didn't load. They'll retry on the next refresh.</p>`; return; }
  ctState.list = data || [];
  renderContracts(p);
}

function ctViewBlock(c) {
  return `
    <div class="ct-viewbox">
      <pre class="doc">${esc(c.body || "")}</pre>
      ${c.status === "signed" ? `
        <div class="ct-sigblock">
          <span class="hud"><span class="tick">&#10003;</span> Signed</span>
          <div style="font-size:0.9rem;font-weight:600;margin-top:0.35rem;">${esc(c.signer_name || "")} · ${fmtD(c.signed_at)}</div>
          ${c.body_sha256 ? `<div class="hud" style="margin-top:0.35rem;color:var(--faint);">SHA-256 ${esc(c.body_sha256.slice(0, 16))}…</div>` : ""}
        </div>` : ""}
    </div>`;
}

function ctEditorBlock(c) {
  return `
    <div class="ct-editor" id="ctEditor">
      <input id="ctTitle" value="${esc(c.title)}" maxlength="200" aria-label="Contract title" placeholder="Contract title">
      <textarea id="ctBodyBox" aria-label="Contract body">${esc(c.body || "")}</textarea>
      <div class="ct-eacts">
        <button class="btn btn-ghost" id="ctSave">Save</button>
        <button class="btn btn-gold" id="ctSend">Send to client</button>
        <button class="btn btn-ghost danger" id="ctDelete">Delete</button>
      </div>
    </div>`;
}

function renderContracts(p) {
  const box = $("#ctBox");
  if (!box || ctState.projectId !== p.id) return;

  const rows = ctState.list.length ? ctState.list.map((c) => `
    <div class="ainv">
      <div>
        <div class="t">${esc(c.title)}<span class="pill ${CT_PILL[c.status] || ""}">${c.status}</span></div>
        <small>${
          c.status === "signed" ? `Signed by ${esc(c.signer_name || "")} · ${fmtD(c.signed_at)}`
          : c.status === "sent" ? `Sent ${fmtD(c.sent_at)} · waiting on the client`
          : c.status === "void" ? "Voided"
          : "Draft: the client can't see this yet"}</small>
      </div>
      <div class="acts">
        ${c.status === "draft" && ctState.editing !== c.id ? `<button data-ct-edit="${c.id}">Edit</button>` : ""}
        ${c.status !== "draft" ? `<button data-ct-view="${c.id}">${ctState.viewing === c.id ? "Hide" : "View"}</button>` : ""}
        ${c.status === "sent" ? `<button data-ct-void="${c.id}">Void</button>` : ""}
      </div>
    </div>
    ${ctState.viewing === c.id ? ctViewBlock(c) : ""}
    ${ctState.editing === c.id ? ctEditorBlock(c) : ""}`).join("")
    : `<p class="acard-empty">No contracts yet. Start from a template and send for signature.</p>`;

  const foot = ctState.picking
    ? ((ctState.templates || []).length ? `
      <div class="ct-new">
        <select id="ctPickSel" aria-label="Contract template">
          ${ctState.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}
        </select>
        <button class="btn btn-gold" id="ctPickCreate">Create draft</button>
        <button class="btn btn-ghost" id="ctPickCancel">Cancel</button>
      </div>`
      : `<div class="ct-new">
        <p class="acard-empty">No templates found. Add one to bk_contract_templates first.</p>
        <button class="btn btn-ghost btn-sm" id="ctPickCancel">Close</button>
      </div>`)
    : `<div class="ct-new"><button class="btn btn-ghost btn-sm" id="ctNewBtn">+ New contract</button></div>`;

  box.innerHTML = rows + foot;
  wireContracts(p);
}

function wireContracts(p) {
  const box = $("#ctBox");
  if (!box) return;

  const newBtn = $("#ctNewBtn");
  if (newBtn) newBtn.addEventListener("click", async () => {
    if (!ctState.templates) {
      const { data, error } = await sb.from("bk_contract_templates").select("id, name, body").order("name");
      if (error) { toast("Could not load templates"); return; }
      ctState.templates = data || [];
    }
    ctState.picking = true;
    renderContracts(p);
  });

  const pickCancel = $("#ctPickCancel");
  if (pickCancel) pickCancel.addEventListener("click", () => { ctState.picking = false; renderContracts(p); });

  const pickCreate = $("#ctPickCreate");
  if (pickCreate) pickCreate.addEventListener("click", async () => {
    const tpl = (ctState.templates || []).find((t) => t.id === $("#ctPickSel").value);
    if (!tpl) { toast("Pick a template"); return; }
    pickCreate.disabled = true;
    const { data, error } = await sb.from("bk_contracts")
      .insert({ project_id: p.id, title: tpl.name, body: tpl.body, status: "draft" })
      .select()
      .single();
    if (error) { pickCreate.disabled = false; toast("Could not create the draft"); return; }
    ctState.picking = false;
    ctState.editing = data.id;
    await loadContracts(p);
  });

  box.querySelectorAll("[data-ct-edit]").forEach((b) => b.addEventListener("click", () => {
    ctState.editing = b.dataset.ctEdit;
    renderContracts(p);
  }));

  box.querySelectorAll("[data-ct-view]").forEach((b) => b.addEventListener("click", () => {
    ctState.viewing = ctState.viewing === b.dataset.ctView ? null : b.dataset.ctView;
    renderContracts(p);
  }));

  box.querySelectorAll("[data-ct-void]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Void this contract? The client will no longer be able to sign it.")) return;
    const { error } = await sb.from("bk_contracts").update({ status: "void" }).eq("id", b.dataset.ctVoid);
    if (error) { toast("Void failed"); return; }
    toast("Contract voided.");
    await loadContracts(p);
  }));

  const ctSave = $("#ctSave");
  if (ctSave) ctSave.addEventListener("click", async () => {
    const title = $("#ctTitle").value.trim() || "Contract";
    const body = $("#ctBodyBox").value;
    const { error } = await sb.from("bk_contracts").update({ title, body }).eq("id", ctState.editing);
    if (error) { toast("Save failed"); return; }
    ctState.editing = null;
    toast("Draft saved.");
    await loadContracts(p);
  });

  const ctSend = $("#ctSend");
  if (ctSend) ctSend.addEventListener("click", async () => {
    const title = $("#ctTitle").value.trim() || "Contract";
    const body = $("#ctBodyBox").value;
    if (!body.trim()) { toast("The contract body is empty."); return; }
    if ((body.includes("[REVIEW") || body.includes("[DESCRIBE")) &&
        !confirm("Heads up: this contract still has [DESCRIBE…] or [REVIEW…] placeholders in it.\n\nSend it to the client anyway?")) return;
    ctSend.disabled = true;
    const { error } = await sb.from("bk_contracts")
      .update({ title, body, status: "sent", sent_at: new Date().toISOString() })
      .eq("id", ctState.editing);
    ctSend.disabled = false;
    if (error) { toast("Send failed"); return; }
    ctState.editing = null;
    toast("Contract sent. The client gets an email automatically.");
    await loadContracts(p);
  });

  const ctDelete = $("#ctDelete");
  if (ctDelete) ctDelete.addEventListener("click", async () => {
    if (!confirm("Delete this draft contract? This cannot be undone.")) return;
    const { error } = await sb.from("bk_contracts").delete().eq("id", ctState.editing);
    if (error) { toast("Delete failed"); return; }
    ctState.editing = null;
    toast("Draft deleted.");
    await loadContracts(p);
  });
}

/* ---------------- new project ---------------- */
$("#newProjBtn").addEventListener("click", () => { $("#newProj").hidden = !$("#newProj").hidden; });
$("#npCancel").addEventListener("click", () => { $("#newProj").hidden = true; });
$("#npCreate").addEventListener("click", async () => {
  const name = $("#npName").value.trim(), email = $("#npEmail").value.trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("Name + valid email required"); return; }
  const { error } = await sb.from("bk_projects").insert({
    client_name: name, client_email: email.toLowerCase(),
    client_phone: $("#npPhone").value.trim() || null,
    service: $("#npService").value,
    event_date: $("#npDate").value || null,
    location: $("#npLocation").value.trim() || null,
    title: `${name} — ${SERVICES[$("#npService").value]}`,
  });
  if (error) { toast("Create failed"); return; }
  $("#newProj").hidden = true;
  ["npName", "npEmail", "npPhone", "npDate", "npLocation"].forEach((id) => { $("#" + id).value = ""; });
  toast("Project created");
  await load();
});
