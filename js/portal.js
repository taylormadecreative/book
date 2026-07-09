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
let lastCtKey = null;

init();
async function init() {
  if (!PID || !TOKEN) return fail();
  if (params.get("paid") === "1") $("#paidBanner").hidden = false;
  try {
    const data = await BK.rpc("bk_portal", { p_project: PID, p_token: TOKEN });
    render(data);
    $("#loading").hidden = true;
    $("#app").hidden = false;
    mountMedia();
    setInterval(refresh, 10000);
  } catch (_) { fail(); }
}

/* photos & video — mounted once, via the same token that gates this portal */
function mountMedia() {
  if (!window.BKGallery) return;
  const root = $("#galleryRoot");
  if (!root) return;
  $("#mediaCard").hidden = false;
  BKGallery.mount(root, { mode: "token", project_id: PID, token: TOKEN });
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

  // contracts — e-sign. Rebuild only when the set or statuses change so the
  // 10s poll never wipes a half-typed signature.
  const contracts = data.contracts || [];
  const cCard = $("#contractsCard");
  if (cCard) {
    cCard.hidden = !contracts.length;
    const ctKey = contracts.map((c) => `${c.id}:${c.status}`).join("|");
    if (contracts.length && ctKey !== lastCtKey) {
      lastCtKey = ctKey;
      const fmtSigned = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" }) : "";
      $("#pContracts").innerHTML = contracts.map((c) => `
        <div class="ct">
          <div class="ct-head">
            <strong>${esc(c.title)}</strong>
            ${c.status === "signed" ? `<span class="pill green">Signed</span>` : `<span class="pill gold">Awaiting signature</span>`}
          </div>
          <div class="ct-doc" tabindex="0" aria-label="${esc(c.title)} — full contract text">${esc(c.body)}</div>
          ${c.status === "signed"
            ? `<div class="ct-signed">&#10003; Signed by ${esc(c.signer_name || "")} on ${fmtSigned(c.signed_at)}</div>`
            : `
          <form class="ct-sign" data-sign-form="${esc(c.id)}">
            <span class="hud">SIGN <span class="tick">/</span> E-SIGNATURE</span>
            <div class="field">
              <label for="sig-name-${esc(c.id)}">Type your full legal name</label>
              <input id="sig-name-${esc(c.id)}" data-sig-name autocomplete="name" maxlength="120" required>
            </div>
            <label class="ct-agree" for="sig-agree-${esc(c.id)}">
              <input type="checkbox" id="sig-agree-${esc(c.id)}" data-sig-agree required>
              <span>I agree that typing my name here is my electronic signature</span>
            </label>
            <button class="btn btn-gold" type="submit" disabled>Sign contract</button>
            <p class="ct-err" hidden></p>
          </form>`}
        </div>`).join("");
    }
  }

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

/* sign contracts — listeners live on the static container so they survive re-renders */
const pContracts = $("#pContracts");
if (pContracts) {
  // Sign stays disabled until both the typed name and the agreement box are in
  const syncSignBtn = (form) => {
    const name = form.querySelector("[data-sig-name]").value.trim();
    const agree = form.querySelector("[data-sig-agree]").checked;
    form.querySelector("button[type=submit]").disabled = !(name && agree);
  };
  const onFieldChange = (e) => {
    const form = e.target.closest("form[data-sign-form]");
    if (form) syncSignBtn(form);
  };
  pContracts.addEventListener("input", onFieldChange);
  pContracts.addEventListener("change", onFieldChange);

  pContracts.addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-sign-form]");
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const err = form.querySelector(".ct-err");
    const name = form.querySelector("[data-sig-name]").value.trim();
    if (!name || !form.querySelector("[data-sig-agree]").checked || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Signing…";
    err.hidden = true;
    try {
      const out = await BK.rpc("bk_portal_sign_contract", {
        p_project: PID, p_token: TOKEN, p_contract: form.dataset.signForm, p_signer_name: name,
      });
      if (!out || out.ok !== true) throw new Error((out && out.error) || "sign_failed");
      btn.textContent = "Signed ✓";
      await refresh(); // pulls the signed state and re-renders this card
    } catch (_) {
      btn.disabled = false;
      btn.textContent = "Sign contract";
      err.textContent = "Your signature didn't go through — give it another try, or send Nelson a message and he'll sort it out.";
      err.hidden = false;
    }
  });
}
