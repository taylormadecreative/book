/* Taylormade — Inbox · Pitches: read, approve, edit, skip outreach pitches. The exact email shows in a sandboxed frame;
   Approve sends the hash of what was shown, and the server refuses anything else. */
import { esc } from "./inbox-view.js";
import { OFFER, LANE, STATUS, SKIP_REASONS, hashInput, sha256Hex, safeHref, igHref, splitParas, joinParas,
  pitchRowHtml, scoreHtml, timelineHtml, mailFrame, pitchActions, shotsHtml } from "./inbox-pitches-view.js";

const UNDO_DELAY_MS = 5000;
const KEYS = [["email", "First email"], ["fu1", "Follow-up 1"], ["fu2", "Follow-up 2"]];

export function initPitches({ sb, rpc, show, toast, $, home = "/inbox/" }) {
  const st = { filter: "review", item: null, hashOk: false, timer: null, tick: null, seq: 0 };
  const toList = async () => { history.pushState({}, "", "?view=pitches"); await openPitches(); };

  async function openPitches() {
    cancelPending(); show("#pitchesView");
    $("#ptList").innerHTML = `<p class="ib-empty">Loading…</p>`;
    try {
      const rows = await rpc("bk_outreach_list", { p_filter: st.filter });
      $("#ptList").innerHTML = rows.length ? rows.map(pitchRowHtml).join("")
        : `<p class="ib-empty">${st.filter === "review" ? "Nothing to review. Your phone buzzes when the next batch is ready." : "Nothing here yet."}</p>`;
    } catch (_) {
      $("#ptList").innerHTML = `<div class="ib-empty"><p>Couldn't load pitches.</p><button type="button" class="btn btn-ghost retry">Try again</button></div>`;
    }
  }
  document.querySelectorAll("#pitchesView .chip[data-pfilter]").forEach((c) => c.addEventListener("click", () => {
    document.querySelectorAll("#pitchesView .chip[data-pfilter]").forEach((x) => x.classList.toggle("on", x === c));
    st.filter = c.dataset.pfilter; openPitches();
  }));
  $("#ptList").addEventListener("click", (e) => {
    if (e.target.closest("button.retry")) { openPitches(); return; }
    const a = e.target.closest("a.pt-row"); if (!a) return;
    e.preventDefault(); history.pushState({}, "", `?pitch=${a.dataset.pitch}`); openPitch(a.dataset.pitch);
  });
  $("#ptBack").addEventListener("click", toList);
  $("#ptInboxBtn").addEventListener("click", () => { history.pushState({}, "", home); window.dispatchEvent(new PopStateEvent("popstate")); });

  async function openPitch(id) {
    cancelPending(); show("#pitchView");
    const my = ++st.seq;
    $("#ptDetail").innerHTML = `<p class="ib-empty">Loading…</p>`; $("#ptActions").hidden = true; $("#ptErr").textContent = ""; $("#ptStatus").textContent = "";
    let item;
    try { item = await rpc("bk_outreach_item", { p_id: id }); }
    catch (_) {
      if (my !== st.seq) return;
      $("#ptDetail").innerHTML = `<div class="ib-empty"><p>Couldn't open this pitch.</p><button type="button" class="btn btn-ghost retry">Try again</button></div>`;
      $("#ptDetail .retry").addEventListener("click", () => openPitch(id));
      return;
    }
    if (my !== st.seq) return;
    const p = item.pitch;
    const hashOk = !!p.content_hash && (await sha256Hex(hashInput(p))) === p.content_hash;
    if (my !== st.seq) return;
    await render(item, hashOk, my);
  }

  async function signed(paths) {
    if (!paths?.length) return [];
    try { const { data } = await sb.storage.from("outreach").createSignedUrls(paths, 900); return (data ?? []).filter((d) => d.signedUrl).map((d) => ({ path: d.path, url: d.signedUrl })); }
    catch (_) { return []; }
  }

  async function render(item, hashOk, my) {
    const { pitch: p, prospect: pr, events, settings } = item;
    const [shots, samples] = await Promise.all([signed(p.shots), signed(p.samples)]);
    if (my !== st.seq) return;
    st.item = item; st.hashOk = hashOk; // the shown email and the approved hash always come from the same pitch
    const src = safeHref(pr.email_source_url), ig = igHref(pr.instagram);
    const who = [pr.contact_name, pr.contact_role].filter(Boolean).join(", ");
    $("#ptStatus").textContent = STATUS[p.status] ?? p.status;
    $("#ptDetail").innerHTML = `
      <h1 class="ib-name">${esc(pr.org)}</h1>
      <p class="ib-what">${esc(LANE[pr.lane] ?? pr.lane)} · ${esc(OFFER[p.offer_id] ?? p.offer_id)}</p>
      <div class="ib-contact">${esc(who)}${pr.email ? `${who ? " · " : ""}${esc(pr.email)}` : ""}${src ? ` · <a href="${esc(src)}" target="_blank" rel="noopener noreferrer">where the email was found</a>` : ""}${ig ? ` · <a href="${esc(ig)}" target="_blank" rel="noopener">@${esc(pr.instagram)}</a>` : ""}</div>
      ${settings?.shadow ? `<p class="pt-banner">Preview mode: approving sends this to <b>your</b> inbox, not to them.</p>` : ""}
      ${settings?.paused ? `<p class="pt-banner">Sending is paused.</p>` : ""}
      ${p.status === "held" ? `<p class="pt-banner pt-warn">Held: ${esc(p.hold_reason ?? "")}</p>` : ""}
      ${p.status === "rendering" ? `<p class="pt-banner">Re-rendering your edit. Your phone buzzes when it's ready to read again.</p>` : ""}
      ${p.status === "ready" && !st.hashOk ? `<p class="pt-banner pt-warn">This pitch changed while it loaded. Go back and open it again.</p>` : ""}
      <section class="ib-facts"><div class="fact"><span>Why them</span><p>${esc(p.why)}</p></div>${scoreHtml(p.score)}</section>
      ${p.channel === "email" ? `
        <h2 class="pt-h">First email</h2>
        <p class="pt-subject"><span>Subject</span> ${esc(p.subject)}</p>
        ${mailFrame(p.email_html, "First email, exactly as it will send")}
        <details class="pt-fu"><summary>Follow-up 1 · 4 business days later</summary><p class="pt-subject"><span>Subject</span> Re: ${esc(p.subject)}</p>${mailFrame(p.fu1_html, "Follow-up 1")}</details>
        <details class="pt-fu"><summary>Follow-up 2 · 6 business days after that</summary><p class="pt-subject"><span>Subject</span> Re: ${esc(p.subject)}</p>${mailFrame(p.fu2_html, "Follow-up 2")}</details>`
      : `<h2 class="pt-h">Instagram DM</h2><pre class="pt-dm">${esc(p.dm_text)}</pre>`}
      ${shots.length ? `<h2 class="pt-h">Their proposal page</h2><div class="pt-proposal">${shotsHtml(shots)}</div>` : ""}
      ${samples.length ? `<h2 class="pt-h">Sample work made for them</h2><div class="pt-shots">${samples.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener"><img src="${esc(s.url)}" alt="Concept made for ${esc(pr.org)}" loading="lazy"></a>`).join("")}</div>` : ""}
      ${timelineHtml(events)}`;
    renderActions();
  }

  function renderActions() {
    const p = st.item.pitch, s = p.status, a = pitchActions(s, p.channel);
    const on = (id, yes) => { $(id).hidden = !yes; };
    $("#ptActions").hidden = !a.any;
    on("#ptApprove", a.approve);
    $("#ptApprove").disabled = !st.hashOk;
    $("#ptApprove").textContent = p.channel === "dm" ? "Approve & publish page" : "Approve";
    on("#ptStop", a.stop);
    $("#ptStop").disabled = false; $("#ptStop").textContent = "Stop follow-ups";
    on("#ptUndo", false);
    on("#ptUnapprove", a.unapprove);
    on("#ptEdit", a.edit);
    on("#ptSkip", a.skip);
    on("#ptCopyDm", a.dm); on("#ptDmSent", a.dm);
    $("#ptSkipReasons").hidden = true;
    $("#ptNote").textContent = s === "sent" ? "Follow-ups keep going until they reply. Already talking to them another way? Stop the follow-ups."
      : s !== "approved" ? ""
      : p.channel === "dm" ? "Approved. The page goes live in a few minutes, then your phone buzzes to send the DM."
      : "Approved. It goes out in the next send window (8:00–4:30 weekdays).";
  }

  // Approve and Stop follow-ups wait 5 seconds with an Undo, like Send in the inbox.
  // Undo, Edit, Skip, Back and opening another pitch all cancel the pending action.
  function countdown(btn, label, undoMsg, run) {
    if (st.timer) return;
    let left = UNDO_DELAY_MS / 1000;
    st.undoMsg = undoMsg;
    btn.disabled = true; btn.textContent = `${label} in ${left}s`; $("#ptUndo").hidden = false;
    st.tick = setInterval(() => { left -= 1; if (left > 0) btn.textContent = `${label} in ${left}s`; }, 1000);
    st.timer = setTimeout(() => { clearInterval(st.tick); st.timer = null; $("#ptUndo").hidden = true; run(); }, UNDO_DELAY_MS);
  }
  function cancelPending() {
    if (!st.timer) return;
    clearTimeout(st.timer); clearInterval(st.tick); st.timer = null;
    if (st.item) renderActions();
  }
  $("#ptApprove").addEventListener("click", () => { if (st.hashOk) countdown($("#ptApprove"), "Approving", "Not approved", doApprove); });
  $("#ptStop").addEventListener("click", () => countdown($("#ptStop"), "Stopping", "Follow-ups continue", doStop));
  $("#ptUndo").addEventListener("click", () => { const m = st.undoMsg; cancelPending(); toast(m || "Cancelled"); });
  async function doApprove() {
    const p = st.item.pitch;
    try {
      await rpc("bk_outreach_approve", { p_id: p.id, p_hash: p.content_hash });
      toast(st.item.settings?.shadow ? "Approved. A preview goes to your inbox." : "Approved");
      await toList();
    } catch (e) { $("#ptErr").textContent = e.message || "Couldn't approve. Try again."; renderActions(); }
  }
  async function doStop() {
    try {
      await rpc("bk_outreach_stop", { p_id: st.item.pitch.id });
      toast("Follow-ups stopped");
      await toList();
    } catch (e) { $("#ptErr").textContent = e.message || "Couldn't stop them. Try again."; renderActions(); }
  }
  $("#ptUnapprove").addEventListener("click", async () => {
    try { await rpc("bk_outreach_unapprove", { p_id: st.item.pitch.id }); toast("Back in review"); await openPitch(st.item.pitch.id); }
    catch (e) { $("#ptErr").textContent = e.message || "Too late. It may already be sending."; }
  });
  $("#ptSkip").addEventListener("click", () => {
    cancelPending();
    $("#ptSkipReasons").innerHTML = SKIP_REASONS.map(([k, l]) => `<button type="button" class="chip" data-reason="${k}">${esc(l)}</button>`).join("");
    $("#ptSkipReasons").hidden = false;
  });
  $("#ptSkipReasons").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-reason]"); if (!b) return;
    cancelPending();
    try {
      await rpc("bk_outreach_skip", { p_id: st.item.pitch.id, p_reason: b.dataset.reason });
      toast(b.dataset.reason === "know_them" ? "Skipped. The agent won't contact them." : "Skipped");
      await toList();
    } catch (e2) { $("#ptErr").textContent = e2.message || "Couldn't skip. Try again."; }
  });
  $("#ptCopyDm").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(st.item.pitch.dm_text ?? ""); toast("DM copied. Paste it in Instagram."); }
    catch (_) { toast("Couldn't copy. Press and hold the DM to copy it."); }
    const ig = igHref(st.item.prospect.instagram); if (ig) window.open(ig, "_blank", "noopener");
  });
  $("#ptDmSent").addEventListener("click", async () => {
    try { await rpc("bk_outreach_dm_sent", { p_id: st.item.pitch.id }); toast("Logged"); await toList(); }
    catch (e) { $("#ptErr").textContent = e.message || "Couldn't save. Try again."; }
  });

  /* ---------- edit ---------- */
  $("#ptEdit").addEventListener("click", () => {
    cancelPending();
    const p = st.item.pitch, parts = p.parts ?? {};
    show("#pitchEditView");
    $("#peTitle").textContent = `Edit · ${st.item.prospect.org}`;
    $("#peErr").textContent = "";
    $("#peForm").innerHTML = p.channel === "dm"
      ? `<label for="pe-dm">Instagram DM</label><textarea id="pe-dm" rows="10" maxlength="1000">${esc(parts.dm ?? "")}</textarea>
         <p class="pt-hint">Keep {{PROPOSAL_URL}} where the page link goes.</p>`
      : `<label for="pe-subject">Subject</label><input id="pe-subject" maxlength="90" value="${esc(parts.subject ?? "")}">` +
        KEYS.map(([k, label]) => { const s = parts[k] ?? {}; return `<fieldset><legend>${esc(label)}</legend>
          <label for="pe-${k}-greeting">Greeting</label><input id="pe-${k}-greeting" maxlength="120" value="${esc(s.greeting ?? "")}">
          <label for="pe-${k}-body">Message <span class="pt-hint">(blank line between paragraphs)</span></label>
          <textarea id="pe-${k}-body" rows="10">${esc(joinParas(s.paragraphs))}</textarea>
          ${k === "email" ? `<label for="pe-email-cta">Button label</label><input id="pe-email-cta" maxlength="40" value="${esc(s.cta_label ?? "")}">` : ""}
          <label for="pe-${k}-signoff">Sign-off</label><input id="pe-${k}-signoff" maxlength="80" value="${esc(s.signoff ?? "")}"></fieldset>`; }).join("");
  });
  $("#peForm").addEventListener("submit", (e) => e.preventDefault());
  function readEditor() {
    const p = st.item.pitch;
    if (p.channel === "dm") return { ...p.parts, dm: $("#pe-dm").value.trim() };
    const out = { ...p.parts, subject: $("#pe-subject").value.trim() };
    for (const [k] of KEYS) {
      out[k] = { ...(p.parts?.[k] ?? {}), greeting: $(`#pe-${k}-greeting`).value.trim(), paragraphs: splitParas($(`#pe-${k}-body`).value),
        signoff: $(`#pe-${k}-signoff`).value.trim() };
    }
    out.email.cta_label = $("#pe-email-cta").value.trim();
    return out;
  }
  $("#peCancel").addEventListener("click", () => { history.pushState({}, "", `?pitch=${st.item.pitch.id}`); openPitch(st.item.pitch.id); });
  $("#peSave").addEventListener("click", async () => {
    const b = $("#peSave"); b.disabled = true; $("#peErr").textContent = "";
    try {
      await rpc("bk_outreach_edit", { p_id: st.item.pitch.id, p_parts: readEditor() });
      toast("Saved. Your phone buzzes when it's ready to read again.");
      await toList();
    } catch (e) { $("#peErr").textContent = e.message || "Couldn't save. Try again."; }
    finally { b.disabled = false; }
  });

  return { openPitches, openPitch };
}
