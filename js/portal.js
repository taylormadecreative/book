/* Taylormade — BOOK · client portal (token access) */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const params = new URLSearchParams(location.search);
const PID = params.get("p");
const TOKEN = params.get("t");

const SERVICES = {
  music_video: "Music video", brand_content: "Brand content",
  photography: "Photography", event: "Event coverage",
  digitals: "Digitals session", other: "Custom project",
};
const STATUS_LABEL = {
  new: "Inquiry received", quoted: "Quote sent", booked: "Booked",
  in_production: "In production", delivered: "Delivered",
  archived: "Archived", lost: "Closed",
};
const PIPELINE = ["new", "quoted", "booked", "in_production", "delivered"];
const PIPE_LABEL = { new: "Inquiry", quoted: "Quoted", booked: "Booked", in_production: "Production", delivered: "Delivered" };

let lastMsgCount = -1;

init();
async function init() {
  if (!PID || !TOKEN) return fail();
  if (params.get("paid") === "1") $("#paidBanner").hidden = false;
  try {
    const data = await BK.rpc("bk_portal", { p_project: PID, p_token: TOKEN });
    render(data);
    $("#loading").hidden = true;
    $("#app").hidden = false;
    setInterval(refresh, 10000);
  } catch (_) { fail(); }
}

function fail() {
  $("#loading").hidden = true;
  $("#noAccess").hidden = false;
}

async function refresh() {
  if (document.hidden) return;
  try {
    const data = await BK.rpc("bk_portal", { p_project: PID, p_token: TOKEN });
    render(data);
  } catch (_) { /* transient; keep last view */ }
}

function render(data) {
  const p = data.project;
  $("#pId").textContent = p.id.slice(0, 8).toUpperCase();
  $("#pTitle").textContent = p.title || `${p.client_name} — ${SERVICES[p.service] || "Project"}`;
  $("#pStatus").textContent = STATUS_LABEL[p.status] || p.status;

  // tracker
  const idx = PIPELINE.indexOf(p.status);
  $("#tracker").innerHTML = PIPELINE.map((s, i) => {
    const cls = idx < 0 ? "" : i < idx ? "done" : i === idx ? "now" : "";
    return `${i ? `<div class="link ${i <= idx ? "done" : ""}"></div>` : ""}
      <div class="node ${cls}"><div class="dot"></div><span>${PIPE_LABEL[s]}</span></div>`;
  }).join("");

  // details
  const fmtDate = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "TBD";
  $("#pDetails").innerHTML = `
    <div><span>Service</span><strong>${esc(SERVICES[p.service] || p.service)}</strong></div>
    <div><span>Shoot date</span><strong>${fmtDate(p.event_date)}</strong></div>
    <div><span>Call time</span><strong>${esc(p.event_time || "TBD")}</strong></div>
    <div><span>Location</span><strong>${esc(p.location || "TBD")}</strong></div>`;

  // invoices — skip rebuild while a checkout request is in flight (a disabled
  // Pay button must not be replaced by a fresh enabled one mid-request)
  const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const paying = sessionStorage.getItem("bk_paying");
  if (!$("#pInvoices").querySelector("[data-pay][disabled]")) $("#pInvoices").innerHTML = data.invoices.length
    ? data.invoices.map((inv) => {
        if (inv.status === "paid" && inv.id === paying) sessionStorage.removeItem("bk_paying");
        // just back from Stripe: webhook may not have landed yet — never offer
        // a second payment on the invoice that was just paid
        const processing = inv.status === "sent" && inv.id === paying && params.get("paid") === "1";
        return `
      <div class="inv">
        <div>
          <div class="inv-t">${esc(inv.title)}</div>
          <div class="inv-li">${(inv.line_items || []).map((li) => esc(li.label)).join(" · ") || (inv.kind === "deposit" ? "Booking deposit" : "")}</div>
          ${inv.due_date && inv.status !== "paid" ? `<div class="inv-li">Due ${fmtDate(inv.due_date)}</div>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:1rem;">
          <span class="inv-amt">${money(inv.amount_cents)}</span>
          ${inv.status === "paid"
            ? `<span class="pill green">Paid</span>`
            : processing
              ? `<span class="pill gold">Processing…</span>`
              : `<button class="btn btn-gold" data-pay="${inv.id}">Pay now</button>`}
        </div>
      </div>`;
      }).join("")
    : `<p style="color:var(--faint);font-size:0.9rem;margin:0;">No invoices yet — your custom quote lands here.</p>`;

  // files
  $("#pFiles").innerHTML = data.files.length
    ? data.files.map((f) => `
      <div class="file-row">
        <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.label)}</a>
        <span class="hud">OPEN ↗</span>
      </div>`).join("")
    : `<p style="color:var(--faint);font-size:0.9rem;margin:0;">Final delivery links will show up here.</p>`;

  // messages
  if (data.messages.length !== lastMsgCount) {
    lastMsgCount = data.messages.length;
    const scroll = $("#chatScroll");
    scroll.innerHTML = data.messages.length
      ? data.messages.map((m) => `
        <div class="msg ${m.sender}">
          ${esc(m.body)}
          <time>${m.sender === "studio" ? "Nelson" : "You"} · ${new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
        </div>`).join("")
      : `<div class="chat-empty">No messages yet. Say what's up — this goes straight to Nelson.</div>`;
    scroll.scrollTop = scroll.scrollHeight;
  }
}

/* pay */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-pay]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Opening…";
  sessionStorage.setItem("bk_paying", btn.dataset.pay);
  try {
    const res = await fetch(`${BK.FUNCTIONS_BASE}/bk-create-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: btn.dataset.pay, token: TOKEN }),
    });
    const out = await res.json();
    if (out.url) { location.href = out.url; return; }
    btn.textContent = out.error === "payments_not_configured"
      ? "Payments coming online — message Nelson"
      : "Try again";
    btn.disabled = false;
  } catch (_) {
    btn.textContent = "Try again";
    btn.disabled = false;
  }
});

/* send message */
$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chatInput");
  const body = input.value.trim();
  if (!body) return;
  input.value = "";
  try {
    await BK.rpc("bk_portal_send", { p_project: PID, p_token: TOKEN, p_body: body });
    await refresh();
  } catch (_) {
    input.value = body; // restore so the client can retry
  }
});
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#chatForm").requestSubmit();
  }
});
