/* Taylormade — BOOK · schedule control panel
   Bookings · weekly availability · blackouts · services/pricing · email queue.
   Everything here writes the bk_* scheduling tables (staff-only RLS) that power
   the public booking calendar on www.taylormadecreative.net. */

const sb = window.supabase.createClient(BK.SUPABASE_URL, BK.SUPABASE_KEY);

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TZ = "America/Chicago";
const fmtDT = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const timeToMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2400);
}

/* ---------------- auth (same pattern as admin.js) ---------------- */
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
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  await Promise.all([loadBookings(), loadAvail(), loadSvcHours(), loadBlackouts(), loadCfg(), loadServices(), loadAddons(), loadEmails()]);
}

/* ---------------- bookings ---------------- */
async function loadBookings() {
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data, error } = await sb
    .from("bk_bookings")
    .select("*, bk_projects(id, client_name, client_email, title), bk_services(name)")
    .gte("starts_at", since)
    .order("starts_at", { ascending: true })
    .limit(40);
  const box = $("#bookings");
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED — SIGNED IN AS STAFF?</span>`; return; }
  if (!data.length) { box.innerHTML = `<span class="hud" style="color:var(--faint);">NO UPCOMING BOOKINGS YET — THEY'LL LAND HERE AS CLIENTS BOOK</span>`; return; }
  box.innerHTML = data.map((b) => `
    <div class="srow">
      <div>
        <b>${fmtDT(b.starts_at)} CT · ${esc(b.bk_services?.name || "Session")}</b>
        <small>${esc(b.bk_projects?.client_name || "")} · ${esc(b.bk_projects?.client_email || "")}${b.location ? " · " + esc(b.location) : ""}</small>
      </div>
      <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap;">
        <span class="chip ${esc(b.status)}">${esc(b.status.replace("_", " "))}</span>
        ${b.status === "requested" || b.status === "pending_payment"
          ? `<button class="btn btn-gold mini" data-act="confirm" data-id="${b.id}">Confirm</button>` : ""}
        ${b.status === "confirmed"
          ? `<button class="btn btn-ghost mini" data-act="complete" data-id="${b.id}">Completed</button>` : ""}
        ${b.status !== "cancelled" && b.status !== "completed"
          ? `<button class="btn btn-ghost mini" data-act="cancel" data-id="${b.id}">Cancel</button>` : ""}
      </div>
    </div>`).join("");
  box.querySelectorAll("button[data-act]").forEach((btn) => btn.addEventListener("click", async () => {
    const map = { confirm: "confirmed", complete: "completed", cancel: "cancelled" };
    const status = map[btn.dataset.act];
    if (status === "cancelled" && !confirm("Cancel this booking? Queued client emails for it will be dropped.")) return;
    const { error } = await sb.from("bk_bookings").update({ status }).eq("id", btn.dataset.id);
    if (error) { toast("Update failed: " + error.message); return; }
    toast(status === "confirmed" ? "Confirmed — confirmation + prep emails queued." : `Booking ${status}.`);
    loadBookings(); loadEmails();
  }));
}

/* ---------------- availability ---------------- */
let availRules = [];
async function loadAvail() {
  const { data, error } = await sb.from("bk_availability_rules").select("*").order("dow");
  if (error) { $("#avail").innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  availRules = data || [];
  const byDow = {};
  availRules.forEach((r) => { (byDow[r.dow] ||= []).push(r); });
  $("#avail").innerHTML = DOW.map((name, dow) => {
    const r = (byDow[dow] || [])[0];
    const on = r ? r.active : false;
    return `
    <div class="avrow" data-dow="${dow}" data-id="${r ? r.id : ""}">
      <span class="day">${name}</span>
      <input type="checkbox" ${on ? "checked" : ""} aria-label="${name} open">
      <input type="time" value="${r ? minToTime(r.start_min) : "10:00"}" step="1800" aria-label="${name} start">
      <input type="time" value="${r ? minToTime(r.end_min) : "18:00"}" step="1800" aria-label="${name} end">
      <button class="btn btn-ghost mini" data-save>Save</button>
    </div>`;
  }).join("");
  $("#avail").querySelectorAll("[data-save]").forEach((btn) => btn.addEventListener("click", async () => {
    const row = btn.closest(".avrow");
    const dow = +row.dataset.dow;
    const id = row.dataset.id;
    const [chk, start, end] = [row.querySelector("input[type=checkbox]"), ...row.querySelectorAll("input[type=time]")];
    const start_min = timeToMin(start.value), end_min = timeToMin(end.value);
    if (end_min <= start_min) { toast("End must be after start."); return; }
    const payload = { dow, start_min, end_min, active: chk.checked };
    const q = id
      ? sb.from("bk_availability_rules").update(payload).eq("id", id)
      : sb.from("bk_availability_rules").insert(payload);
    const { error } = await q;
    if (error) { toast("Save failed: " + error.message); return; }
    toast(`${DOW[dow]} saved.`);
    loadAvail();
  }));
}

/* ---------------- digitals hours (per-service override of weekly availability) ---------------- */
let digitalsSvcId = null;
async function loadSvcHours() {
  const box = $("#svcHours");
  if (!box) return;
  if (!digitalsSvcId) {
    const { data, error } = await sb.from("bk_services").select("id").eq("slug", "digitals").single();
    if (error || !data) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
    digitalsSvcId = data.id;
  }
  const { data, error } = await sb.from("bk_service_hours").select("*").eq("service_id", digitalsSvcId).order("dow");
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  const byDow = {};
  (data || []).forEach((r) => { (byDow[r.dow] ||= []).push(r); });
  box.innerHTML = DOW.map((name, dow) => {
    const r = (byDow[dow] || [])[0];
    const on = r ? r.active : false;
    return `
    <div class="avrow" data-dow="${dow}" data-id="${r ? r.id : ""}">
      <span class="day">${name}</span>
      <input type="checkbox" ${on ? "checked" : ""} aria-label="${name} digitals open">
      <input type="time" value="${r ? minToTime(r.start_min) : "09:00"}" step="1800" aria-label="${name} digitals start">
      <input type="time" value="${r ? minToTime(r.end_min) : "21:00"}" step="1800" aria-label="${name} digitals end">
      <button class="btn btn-ghost mini" data-save>Save</button>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-save]").forEach((btn) => btn.addEventListener("click", async () => {
    const row = btn.closest(".avrow");
    const dow = +row.dataset.dow;
    const id = row.dataset.id;
    const [chk, start, end] = [row.querySelector("input[type=checkbox]"), ...row.querySelectorAll("input[type=time]")];
    const start_min = timeToMin(start.value), end_min = timeToMin(end.value);
    if (end_min <= start_min) { toast("End must be after start."); return; }
    const payload = { service_id: digitalsSvcId, dow, start_min, end_min, active: chk.checked };
    const q = id
      ? sb.from("bk_service_hours").update(payload).eq("id", id)
      : sb.from("bk_service_hours").insert(payload);
    const { error } = await q;
    if (error) { toast("Save failed: " + error.message); return; }
    toast(`Digitals ${DOW[dow]} saved.`);
    loadSvcHours();
  }));
}

/* ---------------- blackouts ---------------- */
async function loadBlackouts() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb.from("bk_blackouts").select("*").gte("ends_on", today).order("starts_on");
  const box = $("#blackouts");
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  box.innerHTML = data.length ? data.map((b) => `
    <div class="srow">
      <div><b>${b.starts_on}${b.ends_on !== b.starts_on ? " → " + b.ends_on : ""}</b>${b.reason ? `<small>${esc(b.reason)}</small>` : ""}</div>
      <button class="btn btn-ghost mini" data-id="${b.id}">Remove</button>
    </div>`).join("") : `<span class="hud" style="color:var(--faint);">NO BLOCKED DATES</span>`;
  box.querySelectorAll("button[data-id]").forEach((btn) => btn.addEventListener("click", async () => {
    const { error } = await sb.from("bk_blackouts").delete().eq("id", btn.dataset.id);
    if (error) { toast("Remove failed: " + error.message); return; }
    toast("Unblocked."); loadBlackouts();
  }));
}
$("#boAdd").addEventListener("click", async () => {
  const from = $("#boFrom").value, to = $("#boTo").value || from;
  if (!from) { toast("Pick a start date."); return; }
  if (to < from) { toast("End is before start."); return; }
  const { error } = await sb.from("bk_blackouts").insert({ starts_on: from, ends_on: to, reason: $("#boReason").value.trim() || null });
  if (error) { toast("Block failed: " + error.message); return; }
  $("#boFrom").value = $("#boTo").value = $("#boReason").value = "";
  toast("Dates blocked."); loadBlackouts();
});

/* ---------------- config ---------------- */
const CFG_FIELDS = [
  ["min_notice_hours", "Min notice (hours)"],
  ["max_advance_days", "Book ahead (days)"],
  ["slot_step_min", "Slot step (min)"],
  ["buffer_min", "Buffer between (min)"],
];
async function loadCfg() {
  const { data, error } = await sb.from("bk_config").select("key, value").in("key", CFG_FIELDS.map((f) => f[0]));
  if (error) { $("#cfg").innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  $("#cfg").innerHTML = CFG_FIELDS.map(([k, label]) => `
    <div><span class="fldl">${label}</span><input class="fldi" type="number" min="0" data-key="${k}" value="${esc(map[k] ?? "")}"></div>`).join("");
}
$("#cfgSave").addEventListener("click", async () => {
  const inputs = [...$("#cfg").querySelectorAll("input[data-key]")];
  for (const inp of inputs) {
    const v = String(Math.max(0, parseInt(inp.value || "0", 10)));
    const { error } = await sb.from("bk_config").update({ value: v }).eq("key", inp.dataset.key);
    if (error) { toast("Save failed: " + error.message); return; }
  }
  toast("Booking rules saved.");
});

/* ---------------- services ---------------- */
async function loadServices() {
  const { data, error } = await sb.from("bk_services").select("*").order("sort");
  const box = $("#services");
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  box.innerHTML = data.map((s) => `
    <details class="svcd" data-id="${s.id}">
      <summary>
        <span><b>${esc(s.name)}</b> <small style="color:var(--muted);">· ${esc(s.slug)}</small></span>
        <span class="chip ${s.active ? "confirmed" : ""}">${s.kind === "session" ? "instant book" : "inquiry"}${s.active ? "" : " · hidden"}</span>
      </summary>
      <div class="svc-edit">
        <div><label>Name</label><input data-f="name" value="${esc(s.name)}" maxlength="120"></div>
        <div><label>Kind</label><select data-f="kind">
          <option value="session" ${s.kind === "session" ? "selected" : ""}>Session (instant book)</option>
          <option value="project" ${s.kind === "project" ? "selected" : ""}>Project (inquiry)</option>
        </select></div>
        <div><label>Duration (min)</label><input data-f="duration_min" type="number" min="15" max="720" value="${s.duration_min}"></div>
        <div><label>Price ($, blank = none)</label><input data-f="price" type="number" min="0" step="1" value="${s.price_cents != null ? s.price_cents / 100 : ""}"></div>
        <div><label>Weekend price ($, blank = same as weekday)</label><input data-f="wkprice" type="number" min="0" step="1" value="${s.weekend_price_cents != null ? s.weekend_price_cents / 100 : ""}"></div>
        <div><label>Deposit ($, blank = full price due)</label><input data-f="deposit" type="number" min="0" step="1" value="${s.deposit_cents != null ? s.deposit_cents / 100 : ""}"></div>
        <div><label>Visible on site</label><select data-f="active"><option value="true" ${s.active ? "selected" : ""}>Yes</option><option value="false" ${s.active ? "" : "selected"}>No</option></select></div>
        <div style="grid-column: 1 / -1;"><label>Tagline (shown on booking cards)</label><input data-f="tagline" value="${esc(s.tagline || "")}" maxlength="240"></div>
        <div style="grid-column: 1 / -1;"><label>Prep email notes (sent 3 days before the shoot)</label><textarea data-f="prep_notes" rows="3" maxlength="1500">${esc(s.prep_notes || "")}</textarea></div>
        <div style="grid-column: 1 / -1;"><button class="btn btn-gold mini" data-save-svc>Save service</button></div>
      </div>
    </details>`).join("");
  box.querySelectorAll("[data-save-svc]").forEach((btn) => btn.addEventListener("click", async () => {
    const d = btn.closest("details");
    const get = (f) => d.querySelector(`[data-f="${f}"]`).value;
    const priceRaw = get("price"), depRaw = get("deposit"), wkRaw = get("wkprice");
    const payload = {
      name: get("name").trim(),
      kind: get("kind"),
      duration_min: Math.min(720, Math.max(15, parseInt(get("duration_min") || "60", 10))),
      price_cents: priceRaw === "" ? null : Math.round(parseFloat(priceRaw) * 100),
      weekend_price_cents: wkRaw === "" ? null : Math.round(parseFloat(wkRaw) * 100),
      deposit_cents: depRaw === "" ? null : Math.round(parseFloat(depRaw) * 100),
      active: get("active") === "true",
      tagline: get("tagline").trim() || null,
      prep_notes: get("prep_notes").trim() || null,
    };
    if (payload.kind === "session" && payload.price_cents == null && payload.deposit_cents == null) {
      toast("A session needs a price or a deposit to be instantly bookable."); return;
    }
    const { error } = await sb.from("bk_services").update(payload).eq("id", d.dataset.id);
    if (error) { toast("Save failed: " + error.message); return; }
    toast("Service saved — live on the site now.");
    loadServices();
  }));
}

/* ---------------- email log ---------------- */
async function loadEmails() {
  const { data, error } = await sb
    .from("bk_email_queue")
    .select("kind, send_at, sent_at, attempts, last_error, bk_projects(client_name)")
    .order("created_at", { ascending: false })
    .limit(30);
  const box = $("#emails");
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  if (!data.length) { box.innerHTML = `<span class="hud" style="color:var(--faint);">NO EMAILS YET</span>`; return; }
  box.innerHTML = `<table class="qtable">
    <tr><th>Type</th><th>Client</th><th>Scheduled</th><th>Status</th></tr>
    ${data.map((q) => `<tr>
      <td>${esc(q.kind)}</td>
      <td>${esc(q.bk_projects?.client_name || "—")}</td>
      <td>${fmtDT(q.send_at)}</td>
      <td>${q.sent_at
        ? (q.last_error && q.last_error.startsWith("skipped") ? `<span class="chip">${esc(q.last_error)}</span>` : `<span class="chip confirmed">sent ${fmtDT(q.sent_at)}</span>`)
        : q.last_error ? `<span class="chip err">retrying (${q.attempts}) · ${esc(q.last_error.slice(0, 60))}</span>` : `<span class="chip pending_payment">queued</span>`}</td>
    </tr>`).join("")}
  </table>`;
}


/* ---------------- studio add-ons (rentable gear) ---------------- */
async function loadAddons() {
  const { data, error } = await sb.from("bk_addons").select("*").order("sort");
  const box = $("#addons");
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  box.innerHTML = data.length ? data.map((a) => `
    <div class="srow" data-id="${a.id}">
      <div style="display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;">
        <input class="fldi" data-f="name" value="${esc(a.name)}" maxlength="80" style="width:180px;">
        <input class="fldi" data-f="price" type="number" min="0" step="1" value="${a.price_cents != null ? a.price_cents / 100 : ""}" placeholder="on request" style="width:110px;">
        <label style="display:flex; gap:.4rem; align-items:center; font-size:.8rem; color:var(--muted);">
          <input type="checkbox" data-f="active" ${a.active ? "checked" : ""}> visible
        </label>
      </div>
      <div style="display:flex; gap:.5rem;">
        <button class="btn btn-gold mini" data-save-addon>Save</button>
        <button class="btn btn-ghost mini" data-del-addon>Remove</button>
      </div>
    </div>`).join("") : `<span class="hud" style="color:var(--faint);">NO GEAR YET</span>`;
  box.querySelectorAll("[data-save-addon]").forEach((btn) => btn.addEventListener("click", async () => {
    const row = btn.closest(".srow");
    const priceRaw = row.querySelector('[data-f="price"]').value;
    const payload = {
      name: row.querySelector('[data-f="name"]').value.trim(),
      price_cents: priceRaw === "" ? null : Math.round(parseFloat(priceRaw) * 100),
      active: row.querySelector('[data-f="active"]').checked,
    };
    if (payload.name.length < 2) { toast("Give the gear a name."); return; }
    const { error } = await sb.from("bk_addons").update(payload).eq("id", row.dataset.id);
    if (error) { toast("Save failed: " + error.message); return; }
    toast("Gear saved — live on the booking page.");
    loadAddons();
  }));
  box.querySelectorAll("[data-del-addon]").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Remove this gear from the rental list?")) return;
    const { error } = await sb.from("bk_addons").delete().eq("id", btn.closest(".srow").dataset.id);
    if (error) { toast("Remove failed: " + error.message); return; }
    toast("Removed."); loadAddons();
  }));
}
$("#adAdd").addEventListener("click", async () => {
  const name = $("#adName").value.trim();
  const priceRaw = $("#adPrice").value;
  if (name.length < 2) { toast("Give the gear a name."); return; }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || ("gear-" + Math.random().toString(36).slice(2, 8));
  const { error } = await sb.from("bk_addons").insert({
    slug, name, price_cents: priceRaw === "" ? null : Math.round(parseFloat(priceRaw) * 100),
  });
  if (error) { toast("Add failed: " + error.message); return; }
  $("#adName").value = $("#adPrice").value = "";
  toast("Gear added."); loadAddons();
});
