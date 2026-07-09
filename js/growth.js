/* Taylormade — BOOK · growth dashboard
   Money summary · make-more nudges · newsletter list · email campaigns.
   Reads the bk_money_summary / bk_growth_nudges RPCs (staff-checked inside)
   and writes bk_subscribers / bk_campaigns (staff-only RLS). Campaign sends
   go through the bk-campaign-send edge function, ~90 emails per run. */

const sb = window.supabase.createClient(BK.SUPABASE_URL, BK.SUPABASE_KEY);

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TZ = "America/Chicago";
const fmtDT = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtD = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (ym) => { const [y, m] = (ym || "").split("-").map(Number); return m ? `${MONTHS[m - 1]} ’${String(y).slice(2)}` : esc(ym); };
const fmtMoney = (cents) => {
  const n = Math.round(cents || 0);
  const whole = n % 100 === 0;
  return "$" + (n / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
};
const prettyService = (s) => { const t = (s || "").replace(/_/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : "—"; };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2400);
}

/* ---------------- auth (same pattern as schedule.js) ---------------- */
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
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  await Promise.all([loadMoney(), loadNudges(), loadSubscribers()]);
  await loadCampaigns(); // after subscribers — send buttons show the active count
}

/* ---------------- money ---------------- */
async function loadMoney() {
  const box = $("#money");
  const { data, error } = await sb.rpc("bk_money_summary");
  if (error || !data) { box.innerHTML = `<span class="hud">LOAD FAILED — SIGNED IN AS STAFF?</span>`; return; }

  const tiles = [
    [fmtMoney(data.collected_total), "Collected all-time"],
    [fmtMoney(data.collected_this_month), "This month"],
    [fmtMoney(data.collected_30d), "Last 30 days"],
    [fmtMoney(data.outstanding), "Outstanding", `${data.outstanding_count || 0} unpaid invoice${data.outstanding_count === 1 ? "" : "s"}`],
    [fmtMoney(data.avg_paid), "Avg paid per project"],
    [String(data.upcoming_7d), "Shoots next 7 days"],
    [(data.subscribers ?? 0).toLocaleString("en-US"), "Newsletter subscribers"],
  ];

  const monthly = [...(data.monthly || [])].sort((a, b) => (a.month < b.month ? -1 : 1)).slice(-12);
  const max = Math.max(1, ...monthly.map((m) => m.cents || 0));
  const byService = [...(data.by_service || [])].sort((a, b) => (b.cents || 0) - (a.cents || 0));

  box.innerHTML = `
    <div class="stat-grid">${tiles.map(([n, l, sub]) => `
      <div class="stat"><span class="n">${n}</span>${sub ? `<small>${sub}</small>` : ""}<span class="l">${l}</span></div>`).join("")}
    </div>
    <div class="money-grid2" style="margin-top:1.3rem;">
      <div>
        <span class="fldl" style="margin-bottom:.5rem;">Collected by month</span>
        ${monthly.length ? monthly.map((m) => `
          <div class="bar-row">
            <span class="bm">${fmtMonth(m.month)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(((m.cents || 0) / max) * 100).toFixed(1)}%;"></div></div>
            <span class="bar-amt">${m.cents ? fmtMoney(m.cents) : "—"}</span>
          </div>`).join("") : `<span class="hud" style="color:var(--faint);">NO PAYMENTS RECORDED YET</span>`}
      </div>
      <div>
        <span class="fldl" style="margin-bottom:.5rem;">By service</span>
        ${byService.length ? byService.map((s) => `
          <div class="srow"><b>${esc(prettyService(s.service))}</b><span class="bar-amt">${fmtMoney(s.cents)}</span></div>`).join("") : `<span class="hud" style="color:var(--faint);">NO PAYMENTS RECORDED YET</span>`}
      </div>
    </div>`;
}

/* ---------------- make more (nudges) ---------------- */
async function loadNudges() {
  const box = $("#nudges");
  const { data, error } = await sb.rpc("bk_growth_nudges");
  if (error || !data) { box.innerHTML = `<span class="hud">LOAD FAILED — SIGNED IN AS STAFF?</span>`; return; }

  const link = `<a class="plink" href="admin.html">open pipeline →</a>`;
  const groups = [];
  const group = (title, rows, render) => {
    if (!rows || !rows.length) return;
    groups.push(`
      <div class="ngroup">
        <h4>${title} <span class="chip">${rows.length}</span></h4>
        ${rows.map((r) => `<div class="srow"><div>${render(r)}</div>${link}</div>`).join("")}
      </div>`);
  };
  const hoursText = (h) => (h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hour${h === 1 ? "" : "s"}`);

  group("MONEY SITTING <b>UNPAID</b>", data.stale_unpaid, (r) =>
    `<b>${fmtMoney(r.amount_cents)} · ${esc(r.title)} — ${esc(r.client)}</b><small>unpaid ${r.days} day${r.days === 1 ? "" : "s"} → nudge them</small>`);
  group("INQUIRIES <b>WAITING ON YOU</b>", data.unanswered_inquiries, (r) =>
    `<b>${esc(r.title)} — ${esc(r.client)}</b><small>no reply for ${hoursText(r.hours)} → answer while it's warm</small>`);
  group("BOOKED, <b>NO CONTRACT</b>", data.missing_contracts, (r) =>
    `<b>${esc(r.title)} — ${esc(r.client)}</b><small>booked${r.starts_at ? " for " + fmtD(r.starts_at) : ""} · no contract on file → send one</small>`);
  group("TIME TO <b>REBOOK</b>", data.rebook, (r) =>
    `<b>${esc(r.client)}${r.email ? ` <small style="display:inline;">· ${esc(r.email)}</small>` : ""}</b><small>${esc(r.title)} was ${r.days} days ago → check in about the next one</small>`);

  box.innerHTML = groups.length
    ? `<div class="ngrid">${groups.join("")}</div>`
    : `<span class="hud" style="color:var(--faint);">Clean board — nothing sitting on the table.</span>`;
}

/* ---------------- newsletter list ---------------- */
let subs = [];
let activeCount = 0;

async function loadSubscribers() {
  const box = $("#subs");
  const { data, error } = await sb
    .from("bk_subscribers")
    .select("id, email, name, source, created_at, unsubscribed_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  subs = data || [];
  activeCount = subs.filter((s) => !s.unsubscribed_at).length;
  $("#subCount").textContent = activeCount.toLocaleString("en-US");
  if (!subs.length) { box.innerHTML = `<span class="hud" style="color:var(--faint);">NO SUBSCRIBERS YET — ADD ONE BELOW OR IMPORT VIA CSV LATER</span>`; return; }
  box.innerHTML = `<table class="qtable">
    <tr><th>Email</th><th>Name</th><th>Source</th><th>Joined</th><th>Status</th></tr>
    ${subs.map((s) => `<tr>
      <td>${esc(s.email)}</td>
      <td>${esc(s.name || "—")}</td>
      <td>${esc(s.source || "—")}</td>
      <td>${fmtD(s.created_at)}</td>
      <td>${s.unsubscribed_at ? `<span class="chip unsub">unsubscribed</span>` : `<span class="chip active">active</span>`}</td>
    </tr>`).join("")}
  </table>`;
}

$("#subExport").addEventListener("click", () => {
  const rows = subs.filter((s) => !s.unsubscribed_at);
  if (!rows.length) { toast("No active subscribers to export."); return; }
  const cell = (v) => { const s = (v ?? "").toString(); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = ["email,name,source,created_at", ...rows.map((r) => [r.email, r.name, r.source, r.created_at].map(cell).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${rows.length} active subscriber${rows.length === 1 ? "" : "s"}.`);
});

$("#subAdd").addEventListener("click", async () => {
  const email = $("#subEmail").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Enter a valid email."); return; }
  const { error } = await sb.from("bk_subscribers").insert({ email, name: $("#subName").value.trim() || null, source: "import" });
  if (error) { toast(error.code === "23505" ? "Already on the list." : "Add failed: " + error.message); return; }
  $("#subEmail").value = $("#subName").value = "";
  toast("Added to the list.");
  await loadSubscribers();
  loadCampaigns(); // send-button counts follow the active count
});

/* ---------------- campaigns ---------------- */
let campaigns = [];
let editingId = null;

async function loadCampaigns() {
  const box = $("#campaigns");
  const { data, error } = await sb.from("bk_campaigns").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) { box.innerHTML = `<span class="hud">LOAD FAILED</span>`; return; }
  campaigns = data || [];
  if (!campaigns.length) { box.innerHTML = `<span class="hud" style="color:var(--faint);">NO CAMPAIGNS YET — WRITE THE FIRST ONE BELOW</span>`; return; }

  box.innerHTML = campaigns.map((c) => {
    const line = c.status === "sent"
      ? `sent${c.sent_at ? " " + fmtDT(c.sent_at) + " CT" : ""} · ${c.sent_count ?? 0}/${c.total_count ?? 0} emails sent`
      : c.status === "sending"
        ? `${c.sent_count ?? 0}/${c.total_count ?? 0} sent so far — click Continue to keep going`
        : `draft · saved ${fmtD(c.created_at)}`;
    return `<div class="srow">
      <div><b>${esc(c.subject)}</b><small>${line}</small></div>
      <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap;">
        <span class="chip ${esc(c.status)}">${esc(c.status)}</span>
        <button class="btn btn-ghost mini" data-test="${c.id}">Send test to me</button>
        ${c.status === "draft" || c.status === "sending"
          ? `<button class="btn btn-gold mini" data-send="${c.id}">${c.status === "sending" ? "Continue send" : `Send to ${activeCount} subscriber${activeCount === 1 ? "" : "s"}`}</button>` : ""}
        ${c.status === "draft" ? `<button class="btn btn-ghost mini" data-edit="${c.id}">Edit</button>` : ""}
      </div>
    </div>`;
  }).join("");

  box.querySelectorAll("[data-test]").forEach((btn) => btn.addEventListener("click", () => runSend(btn, btn.dataset.test, "test")));
  box.querySelectorAll("[data-send]").forEach((btn) => btn.addEventListener("click", () => {
    const c = campaigns.find((x) => String(x.id) === btn.dataset.send);
    if (!c) return;
    const q = c.status === "sending"
      ? `Continue sending "${c.subject}"?`
      : `Send "${c.subject}" to ${activeCount} subscriber${activeCount === 1 ? "" : "s"}?`;
    if (!confirm(q)) return;
    runSend(btn, btn.dataset.send, "send");
  }));
  box.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => startEdit(btn.dataset.edit)));
}

async function runSend(btn, id, mode) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === "test" ? "Sending test…" : "Sending…";
  try {
    const { data } = await sb.auth.getSession();
    const session = data.session;
    if (!session) throw new Error("Signed out — sign in again.");
    const res = await fetch(`${BK.FUNCTIONS_BASE}/bk-campaign-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ campaign_id: id, mode }),
    });
    let out = {};
    try { out = await res.json(); } catch (_) { /* non-JSON error body */ }
    if (!res.ok || !out.ok) throw new Error(out.error || out.message || `Send failed (${res.status})`);
    if (mode === "test") {
      toast(out.test_sent_to ? `Test sent to ${out.test_sent_to}.` : "Test sent.");
    } else {
      const errCount = Array.isArray(out.errors) ? out.errors.length : (typeof out.errors === "number" ? out.errors : 0);
      let msg = out.finished
        ? `Sent ${out.sent_now} — done.`
        : `Sent ${out.sent_now}, ${out.remaining} remaining — click again to continue.`;
      if (errCount) msg += ` ${errCount} failed.`;
      toast(msg);
      loadCampaigns();
    }
  } catch (e) {
    toast(e.message || "Send failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* ---------------- compose ---------------- */
function startEdit(id) {
  const c = campaigns.find((x) => String(x.id) === String(id));
  if (!c || c.status !== "draft") return;
  editingId = c.id;
  $("#cSubject").value = c.subject || "";
  $("#cPreheader").value = c.preheader || "";
  $("#cBody").value = c.body || "";
  $("#composeLabel").textContent = "EDITING DRAFT";
  $("#cSave").textContent = "Update draft";
  $("#cCancel").hidden = false;
  $("#compose").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resetCompose() {
  editingId = null;
  $("#cSubject").value = $("#cPreheader").value = $("#cBody").value = "";
  $("#composeLabel").textContent = "NEW CAMPAIGN";
  $("#cSave").textContent = "Save draft";
  $("#cCancel").hidden = true;
}

$("#cCancel").addEventListener("click", resetCompose);

$("#cSave").addEventListener("click", async () => {
  const subject = $("#cSubject").value.trim();
  const body = $("#cBody").value.trim();
  if (!subject) { toast("Give it a subject line."); return; }
  if (!body) { toast("Write the email body first."); return; }
  const payload = { subject, preheader: $("#cPreheader").value.trim() || null, body };
  const btn = $("#cSave");
  btn.disabled = true;
  const { error } = editingId
    ? await sb.from("bk_campaigns").update(payload).eq("id", editingId).eq("status", "draft")
    : await sb.from("bk_campaigns").insert({ ...payload, status: "draft" });
  btn.disabled = false;
  if (error) { toast("Save failed: " + error.message); return; }
  toast(editingId ? "Draft updated." : "Draft saved.");
  resetCompose();
  loadCampaigns();
});
