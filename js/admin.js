/* Taylormade — BOOK · studio dashboard (admin) */

const sb = window.supabase.createClient(BK.SUPABASE_URL, BK.SUPABASE_KEY);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const fmtD = (d) => d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

const SERVICES = { music_video: "Music video", brand_content: "Brand content", photography: "Photography", event: "Event", digitals: "Digitals", other: "Other" };
const STATUSES = ["new", "quoted", "booked", "in_production", "delivered", "archived", "lost"];
const SLABEL = { new: "New", quoted: "Quoted", booked: "Booked", in_production: "Production", delivered: "Delivered", archived: "Archived", lost: "Lost" };

const state = { projects: [], filter: "active", sel: null, poll: null };

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
$("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

async function boot() {
  // verify admin (RLS will return nothing for non-admins anyway)
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  renderFilters();
  await load();
  state.poll = setInterval(() => { if (!document.hidden) load(); }, 15000);
}

/* ---------------- data ---------------- */
async function load() {
  const { data, error } = await sb
    .from("bk_projects")
    .select("*, bk_invoices(*), bk_messages(*), bk_files(*), bk_galleries(*, bk_gallery_items(*))")
    .order("updated_at", { ascending: false });
  if (error) { toast("Load failed — are you signed in as admin?"); return; }
  state.projects = data || [];
  renderStats();
  renderList();
  if (state.sel) {
    const p = state.projects.find((x) => x.id === state.sel);
    // never re-render the detail pane while Nelson is typing or uploading —
    // a rebuild would wipe half-typed fields or interrupt an upload
    const ae = document.activeElement;
    const typing = ae && $("#dpane").contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    if (p && !typing && !state.uploading) renderDetail(p, true);
  }
}

/* preserve form values + focus across detail re-renders */
const FORM_IDS = ["noteBox", "achatInput", "invTitle", "invAmt", "invKind", "fileLabel", "fileUrl"];
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
  $("#stats").innerHTML = `
    <span class="pill ${newCount ? "gold" : ""}">${newCount} new</span>
    <span class="pill ${unread ? "gold" : ""}">${unread} unread</span>
    <span class="pill">${booked} active</span>
    <span class="pill green">${money(collected)} collected</span>`;
}

/* ---------------- list + filters ---------------- */
const FILTERS = [["active", "Active"], ["new", "New"], ["quoted", "Quoted"], ["booked", "Booked"], ["in_production", "Production"], ["delivered", "Delivered"], ["all", "All"]];
function renderFilters() {
  $("#filters").innerHTML = FILTERS.map(([v, l]) => `<button data-f="${v}" class="${state.filter === v ? "on" : ""}">${l}</button>`).join("");
}
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f;
  renderFilters();
  renderList();
});

function visibleProjects() {
  if (state.filter === "all") return state.projects;
  if (state.filter === "active") return state.projects.filter((p) => !["archived", "lost"].includes(p.status));
  return state.projects.filter((p) => p.status === state.filter);
}

function renderList() {
  const ps = visibleProjects();
  $("#plist").innerHTML = ps.length ? ps.map((p) => `
    <button class="prow ${state.sel === p.id ? "sel" : ""}" data-id="${p.id}">
      <span><b>${esc(p.client_name)}${p.company ? ` · ${esc(p.company)}` : ""}</b>
      <small>${SERVICES[p.service] || p.service} · ${fmtD(p.event_date)}</small></span>
      <span class="meta">
        ${unreadCount(p) ? `<span class="unread">${unreadCount(p)}</span><br>` : ""}
        <span class="pill ${["booked", "in_production"].includes(p.status) ? "gold" : p.status === "delivered" ? "green" : ""}">${SLABEL[p.status]}</span>
      </span>
    </button>`).join("")
    : `<div class="dempty" style="margin-top:3rem;">NOTHING HERE YET</div>`;
}
$("#plist").addEventListener("click", (e) => {
  const r = e.target.closest(".prow");
  if (!r) return;
  state.sel = r.dataset.id;
  renderList();
  const p = state.projects.find((x) => x.id === state.sel);
  renderDetail(p);
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
  const chatBox = keepScroll ? $("#achatScroll")?.scrollTop : null;
  const inv = p.bk_invoices.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const msgs = p.bk_messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const files = p.bk_files.sort((a, b) => a.created_at.localeCompare(b.created_at));

  pane.innerHTML = `
    <div class="dhead">
      <div>
        <span class="hud">FILE ${p.id.slice(0, 8).toUpperCase()} <span class="tick">/</span> ${esc(SERVICES[p.service] || p.service).toUpperCase()}</span>
        <h2>${esc(p.client_name)}${p.company ? ` — ${esc(p.company)}` : ""}</h2>
      </div>
      <div class="dactions">
        <button class="btn btn-ghost back-list" id="backList">← Pipeline</button>
        <select id="statusSel">${STATUSES.map((s) => `<option value="${s}" ${p.status === s ? "selected" : ""}>${SLABEL[s]}</option>`).join("")}</select>
        <button class="btn btn-ghost" id="copyPortal">Copy portal link</button>
      </div>
    </div>

    <div class="dgrid">
      <div>
        <div class="acard">
          <h3>CLIENT <b>BRIEF</b></h3>
          <div class="kv2">
            <div><span>Email</span><a href="mailto:${esc(p.client_email)}">${esc(p.client_email)}</a></div>
            <div><span>Phone</span>${p.client_phone ? `<a href="tel:${esc(p.client_phone)}">${esc(p.client_phone)}</a>` : "—"}</div>
            <div><span>Shoot date</span>${fmtD(p.event_date)}</div>
            <div><span>Location</span>${esc(p.location || "—")}</div>
            <div><span>Budget</span>${esc(p.budget_range || "—")}</div>
            <div><span>Source</span>${esc(p.referral_source || "—")}</div>
            ${p.details ? `<div class="wide"><span>The vision</span>${esc(p.details)}</div>` : ""}
          </div>
        </div>

        <div class="acard">
          <h3>INVOICES <b>· ${money(inv.filter((i) => i.status === "paid").reduce((n, i) => n + i.amount_cents, 0))} PAID</b></h3>
          ${inv.length ? inv.map((i) => `
            <div class="ainv">
              <div><div class="t">${esc(i.title)} <span class="pill ${i.status === "paid" ? "green" : i.status === "sent" ? "gold" : i.status === "void" ? "red" : ""}" style="margin-left:0.4em;">${i.status}</span></div>
              <small style="color:var(--faint);">${i.kind}${i.paid_at ? ` · paid ${fmtD(i.paid_at)}` : ""}</small></div>
              <span class="a">${money(i.amount_cents)}</span>
              <div class="acts">
                ${i.status === "draft" ? `<button data-inv-send="${i.id}">Send</button>` : ""}
                ${i.status === "sent" ? `<button data-inv-paid="${i.id}">Mark paid</button>` : ""}
                ${i.status !== "void" && i.status !== "paid" ? `<button data-inv-void="${i.id}">Void</button>` : ""}
              </div>
            </div>`).join("") : `<p style="color:var(--faint);font-size:0.85rem;margin:0;">No invoices yet.</p>`}
          <div class="inv-new">
            <input id="invTitle" placeholder="Title (e.g. Booking deposit)">
            <input id="invAmt" type="number" min="1" step="0.01" placeholder="$">
            <select id="invKind"><option value="deposit">Deposit</option><option value="balance">Balance</option><option value="full">Full</option><option value="custom">Custom</option></select>
            <button class="btn btn-gold" id="invCreate">Add + send</button>
          </div>
        </div>

        <div class="acard notes">
          <h3>INTERNAL <b>NOTES</b></h3>
          <textarea id="noteBox" placeholder="Only you see this…">${esc(p.notes_internal || "")}</textarea>
          <button class="btn btn-ghost" id="noteSave" style="margin-top:0.6rem;font-size:0.8rem;padding:0.5em 1.2em;">Save notes</button>
        </div>
      </div>

      <div>
        <div class="acard">
          <h3>MESSAGES <b>· CLIENT LINE</b></h3>
          <div class="achat">
            <div class="chat-scroll" id="achatScroll">
              ${msgs.length ? msgs.map((m) => `
                <div class="msg ${m.sender}">${esc(m.body)}
                <time>${m.sender === "studio" ? "You" : esc(p.client_name)} · ${new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div>`).join("")
                : `<div style="color:var(--faint);font-size:0.85rem;margin:auto;">No messages yet.</div>`}
            </div>
            <form id="achatForm">
              <textarea id="achatInput" placeholder="Reply to ${esc(p.client_name)}…" maxlength="4000"></textarea>
              <button class="btn btn-gold" type="submit" style="align-self:flex-end;">Send</button>
            </form>
          </div>
        </div>

        <div class="acard">
          <h3>FILES <b>&amp; DELIVERY</b></h3>
          ${files.map((f) => `
            <div class="file-row">
              <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.label)}</a>
              <button data-file-del="${f.id}">remove</button>
            </div>`).join("")}
          <div class="file-add">
            <input id="fileLabel" placeholder="Label">
            <input id="fileUrl" placeholder="https:// link (Drive, Dropbox, frame.io…)">
            <button class="btn btn-ghost" id="fileAdd" style="font-size:0.8rem;padding:0.5em 1em;">Add</button>
          </div>
        </div>
      </div>
    </div>
    ${galleriesCard(p)}`;

  if (keepScroll && chatBox != null && $("#achatScroll")) $("#achatScroll").scrollTop = chatBox;
  else if ($("#achatScroll")) $("#achatScroll").scrollTop = $("#achatScroll").scrollHeight;

  restoreForms(formCap);
  wireDetail(p);
  hydrateThumbs();
}

/* ---------------- galleries (photos & video) ---------------- */
const GAL_KIND = { proof: "Proofing", final: "Edited photos", video: "Video" };

function galleriesCard(p) {
  const gals = (p.bk_galleries || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  const blocks = gals.length ? gals.map((g) => {
    const items = (g.bk_gallery_items || []).slice()
      .sort((a, b) => (a.sort - b.sort) || a.created_at.localeCompare(b.created_at));
    const sel = items.filter((i) => i.selected).length;
    const isVideo = g.kind === "video";
    const meta = g.kind === "proof"
      ? `<span class="pill ${sel ? "gold" : ""}">${sel} selected${g.selection_limit != null ? ` / ${g.selection_limit}` : ""}</span>`
      : `<span class="pill">${items.length} item${items.length === 1 ? "" : "s"}</span>`;
    const lockBtn = g.kind === "proof"
      ? `<button class="ga-lock" data-lock="${g.id}" data-on="${g.locked}">${g.locked ? "Locked" : "Open"}</button>` : "";
    const cells = isVideo
      ? items.map((it) => `
          <div class="ga-vrow" data-path="${esc(it.storage_path)}">
            <span class="ga-fn">${esc(it.filename || "Video")}</span>
            <button class="ga-itemdel" data-itemdel="${it.id}" title="Remove">&#10005;</button>
          </div>`).join("")
      : items.map((it) => `
          <figure class="ga-cell ${it.selected ? "sel" : ""}" data-path="${esc(it.storage_path)}">
            <img alt="${esc(it.filename || "")}" data-ph>
            ${it.selected ? `<span class="ga-tick">&#10003;</span>` : ""}
            <button class="ga-itemdel" data-itemdel="${it.id}" title="Remove">&#10005;</button>
          </figure>`).join("");
    return `
      <div class="ga">
        <div class="ga-head">
          <div><span class="hud">${GAL_KIND[g.kind] || g.kind}</span><b>${esc(g.title)}</b></div>
          <div class="ga-meta">${meta}${lockBtn}<button class="ga-del" data-galdel="${g.id}" title="Delete gallery">&#10005;</button></div>
        </div>
        <div class="${isVideo ? "ga-vlist" : "ga-grid"}">
          ${cells}
          <label class="ga-add">
            <input type="file" multiple accept="${isVideo ? "video/*" : "image/*"}" data-upload="${g.id}" hidden>
            <span>&#43; Upload</span>
          </label>
        </div>
        <div class="ga-prog" data-prog="${g.id}" hidden></div>
      </div>`;
  }).join("") : `<p style="color:var(--faint);font-size:0.85rem;margin:0 0 1rem;">No galleries yet. Create one below — proofing lets the client pick shots; finals and video are for delivery.</p>`;

  return `
    <div class="acard ga-card">
      <h3>GALLERIES <b>· PHOTOS &amp; VIDEO</b></h3>
      ${blocks}
      <div class="ga-new">
        <select id="galKind">
          <option value="proof">Proofing (client picks)</option>
          <option value="final">Edited photos</option>
          <option value="video">Video</option>
        </select>
        <input id="galTitle" placeholder="Gallery title">
        <input id="galLimit" type="number" min="1" placeholder="Pick limit (optional)">
        <button class="btn btn-gold" id="galCreate" style="font-size:0.82rem;">New gallery</button>
      </div>
    </div>`;
}

async function hydrateThumbs() {
  const cells = [...$("#dpane").querySelectorAll("[data-path] img[data-ph]")];
  if (!cells.length) return;
  const paths = cells.map((img) => img.closest("[data-path]").dataset.path);
  const { data } = await sb.storage.from("project-media").createSignedUrls(paths, 3600);
  (data || []).forEach((d, i) => { if (d.signedUrl) cells[i].src = d.signedUrl; });
}

function safeName(name) {
  return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}

async function uploadToGallery(p, galleryId, files) {
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
    const ins = await sb.from("bk_gallery_items").insert({
      gallery_id: galleryId, project_id: p.id, storage_path: key,
      filename: file.name, content_type: file.type, size_bytes: file.size, sort: sort++,
    });
    if (ins.error) { failed++; }
    done++; show();
  }
  state.uploading = false;
  if (prog) prog.hidden = true;
  toast(failed ? `${total - failed} uploaded, ${failed} failed` : `${total} uploaded — live for the client`);
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
    toast("Portal link copied — text it to the client");
  });

  $("#backList").addEventListener("click", () => {
    document.querySelector(".lpane").scrollIntoView({ behavior: "smooth", block: "start" });
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
    toast("Invoice sent — visible in client portal");
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
    await load();
  });
  $("#achatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#achatForm").requestSubmit(); }
  });

  $("#fileAdd").addEventListener("click", async () => {
    const label = $("#fileLabel").value.trim(), url = $("#fileUrl").value.trim();
    if (!label || !/^https?:\/\//.test(url)) { toast("Need a label and a full https:// link"); return; }
    await sb.from("bk_files").insert({ project_id: p.id, label, url });
    $("#fileLabel").value = ""; $("#fileUrl").value = "";
    toast("File added — live in portal"); await load();
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
    const cell = b.closest("[data-path]");
    if (cell) await sb.storage.from("project-media").remove([cell.dataset.path]);
    await sb.from("bk_gallery_items").delete().eq("id", b.dataset.itemdel);
    await load();
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
    const paths = (gal?.bk_gallery_items || []).map((i) => i.storage_path);
    if (paths.length) await sb.storage.from("project-media").remove(paths);
    await sb.from("bk_galleries").delete().eq("id", gid); // cascades item rows
    toast("Gallery deleted");
    await load();
  }));
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
