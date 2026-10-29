/* Taylormade — BOOK · shared gallery renderer
 * Used by both the token portal (portal.html) and the logged-in hub (gallery.html).
 * Talks only to the bk-media edge function; no direct DB/storage access.
 *
 *   BKGallery.mount(containerEl, access, opts?) → Promise<{ openProof, delivered, picksSent, finals, videos, proof, unlock }>
 *     access = { mode:"token", project_id, token }
 *           | { mode:"session", jwt }        // Supabase access_token
 *     opts.v2 = the 2026-10 client portal look (portal.html): section headings, captioned
 *       finals, sent picks folded into one row once edits land, line icons. gallery.html
 *       and portal-v1.html leave it off and keep the original look.
 *     finals = { count, mb, download(btn) } for the hero "Download all" button (v2 drops
 *       the in-gallery one), proof = { el, count, limit } of the open proof set.
 *     opts.extras = { cents, request(galleryId, itemIds) } offers extra edits past the included
 *       picks (v2 only): picked locally, then one request once they confirm the total.
 *     Fires "bkgallery:sent" on the container when picks are sent.
 *   Storyboards (kind "storyboard", v2 only): frames in story order grouped by scene, each with its
 *     caption (item.meta) and an optional change note. One review either approves the storyboard or
 *     sends the notes to Nelson; it fires "bkgallery:reviewed" { outcome }. mount() also returns
 *     storyboard = { el, count, state: "open" | "approved" | "changes", notes }.
 *   Held video (gallery.held, set by bk-media): the video waits on a balance (gallery.unlock). It plays a
 *     watermarked preview with no download and, in v2, a Pay button (data-pay, handled by the page).
 *     mount() returns unlock = { invoiceId, held } for a video with a balance, so the page can name the
 *     payment and mount again once that invoice is paid.
 */
(function () {
  const esc = (s) =>
    (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const KIND_LABEL = { proof: "Proofing", final: "Edited photos", video: "Video" };
  const RESIGN_AFTER_MS = 90 * 60 * 1000; // signed URLs live 2h; refresh well before that
  // the zip helper for "Download all" loads on demand from js/vendor/, next to this file
  const CORE_SRC = (document.currentScript && document.currentScript.src) || new URL("js/gallery-core.js", location.href).href;
  let V2 = false; // set by mount(…, { v2: true })
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
  const ICON = {
    check: svg("M5 12.5l4.5 4.5L19 7.5"),
    download: svg("M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"),
    expand: svg("M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6"),
    chevron: svg("M9.5 5.5L16 12l-6.5 6.5"),
    prev: svg("M14.5 5.5L8 12l6.5 6.5"),
    close: svg("M6.5 6.5l11 11M17.5 6.5l-11 11"),
    pen: svg("M4.5 19.5l1-4L15.5 5.5l3 3-10 10zM13.5 7.5l3 3"),
    down: svg("M5.5 9.5L12 16l6.5-6.5"),
  };
  const CHECK = () => (V2 ? ICON.check : "&#10003;");
  const SMALL = matchMedia("(max-width: 900px), (pointer: coarse)");
  // signed links expire after 2h: a stale Download re-signs first, then follows the fresh link
  async function freshDownload(e, ctx, it) {
    if (!ctx.stale()) return;
    e.preventDefault();
    await ctx.resign();
    location.href = it.download_url || it.url;
  }

  function call(access, payload) {
    const headers = { "Content-Type": "application/json", apikey: window.BK.SUPABASE_KEY };
    const body = { ...payload };
    if (access.mode === "token") {
      body.project_id = access.project_id;
      body.token = access.token;
      headers.Authorization = `Bearer ${window.BK.SUPABASE_KEY}`;
    } else {
      headers.Authorization = `Bearer ${access.jwt}`;
    }
    return fetch(`${window.BK.FUNCTIONS_BASE}/bk-media`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "request_failed");
      return j;
    });
  }

  let toastEl;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "g-toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._h);
    toastEl._h = setTimeout(() => toastEl.classList.remove("show"), Math.max(2800, msg.length * 55));
  }

  const pickedCount = (g) => g.items.filter((i) => i.selected).length;
  const canPick = (g) => g.kind === "proof" && !g.locked;
  const pickable = (ctx) => ctx.mode === "extras" || canPick(ctx.g);
  const isOn = (it) => !!(it.selected || it.extraPending);
  // extra edits past the included picks: offered when the page passes a price and the set has a limit
  const xCount = (ctx) => (ctx.extra ? ctx.extra.size : 0);
  const extrasOn = (ctx) => V2 && !!(ctx.opts && ctx.opts.extras && ctx.opts.extras.cents) && ctx.g.selection_limit != null;
  const dollars = (c) => `$${c % 100 ? (c / 100).toFixed(2) : c / 100}`;
  const xPrice = (ctx) => dollars(ctx.opts.extras.cents);
  const xTotal = (ctx) => dollars(xCount(ctx) * ctx.opts.extras.cents);

  /* ---------------- picking (shared by grid + lightbox) ---------------- */
  async function setPick(ctx, it, want) {
    const { g } = ctx;
    // extras stay on this device until they confirm the total: nothing is saved or charged per tap
    if (ctx.mode === "extras" || (!want && it.extraPending)) {
      it.extraPending = want;
      if (want) ctx.extra.add(it.id); else ctx.extra.delete(it.id);
      syncPick(ctx, it);
      return;
    }
    if (!canPick(g) || it.selected === want) return;
    const lim = g.selection_limit;
    if (want && lim != null && pickedCount(g) >= lim) {
      if (extrasOn(ctx)) {
        it.extraPending = true;
        ctx.extra.add(it.id);
        syncPick(ctx, it);
        if (!ctx.xNoted) { ctx.xNoted = true; toast(`Added as an extra edit (${xPrice(ctx)}). Your first ${lim} picks are included.`); }
        return;
      }
      toast(`That's ${lim} picks, the max. Unpick one to swap it.`);
      return;
    }
    it.selected = want; // optimistic
    syncPick(ctx, it);
    try {
      await call(ctx.access, { action: "toggle_select", item_id: it.id, selected: want });
      // an included pick freed up: the first extra moves into it
      if (!want && xCount(ctx)) {
        const next = g.items.find((x) => x.extraPending);
        if (next) { next.extraPending = false; ctx.extra.delete(next.id); await setPick(ctx, next, true); }
      }
    } catch (err) {
      it.selected = !want; // revert
      syncPick(ctx, it);
      toast(err.message === "limit_reached" ? `You can pick up to ${lim}.`
        : err.message === "locked" ? "These picks were already sent."
        : "Couldn't save that pick. Try again.");
    }
  }

  // reflect one item's pick state everywhere it shows
  function syncPick(ctx, it) {
    const cell = ctx.wrap.querySelector(`.g-cell[data-id="${it.id}"]`);
    if (cell) {
      cell.classList.toggle("sel", !!it.selected);
      cell.classList.toggle("xtra", !!it.extraPending);
      const b = cell.querySelector(".g-pick");
      if (b) b.setAttribute("aria-pressed", isOn(it) ? "true" : "false");
    }
    renderTools(ctx);
    renderSelbar(ctx);
    if (lb.ctx === ctx) renderLightbox();
  }

  /* ---------------- lightbox (single shared instance) ---------------- */
  const lb = { el: null, ctx: null, list: [], i: 0, returnFocus: null };

  function buildLightbox() {
    const el = document.createElement("div");
    el.className = "g-lightbox";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Photo viewer");
    el.innerHTML = `
      <div class="g-lb-top">
        <span class="g-lb-count"></span>
        <span class="g-lb-name"></span>
        <button class="g-lb-close" aria-label="Close viewer">${V2 ? ICON.close : "&#10005;"}</button>
      </div>
      <div class="g-lb-stage">
        <button class="g-lb-nav prev" aria-label="Previous photo">${V2 ? ICON.prev : "&#8249;"}</button>
        <img alt="">
        <button class="g-lb-nav next" aria-label="Next photo">${V2 ? ICON.chevron : "&#8250;"}</button>
      </div>
      <div class="g-lb-bar"></div>`;
    document.body.appendChild(el);

    el.querySelector(".g-lb-close").addEventListener("click", closeLightbox);
    el.querySelector(".prev").addEventListener("click", () => step(-1));
    el.querySelector(".next").addEventListener("click", () => step(1));
    // click on the dark backdrop (not the photo or controls) closes
    el.querySelector(".g-lb-stage").addEventListener("click", (e) => {
      if (e.target.classList.contains("g-lb-stage")) closeLightbox();
    });
    el.querySelector(".g-lb-bar").addEventListener("click", (e) => {
      if (e.target.closest(".g-lb-dl") && lb.ctx) { freshDownload(e, lb.ctx, lb.list[lb.i]); return; }
      const st = e.target.closest("[data-step]");
      if (st) { const d = +st.dataset.step; step(d); lb.el.querySelector(`[data-step="${d}"]`)?.focus(); return; }
      // storyboard: "Request a change" closes the viewer and opens the note under that frame
      if (e.target.closest(".sb-lb-ask") && lb.ctx) {
        const ctx = lb.ctx, it = lb.list[lb.i];
        closeLightbox();
        if (ctx.openNote && it) ctx.openNote(it);
        return;
      }
      if (e.target.closest(".g-lb-pick")) {
        const it = lb.list[lb.i];
        if (it) setPick(lb.ctx, it, !isOn(it));
      }
    });

    // swipe left/right on touch screens (ignored while pinch-zooming)
    let x0 = null, y0 = null;
    const stage = el.querySelector(".g-lb-stage");
    stage.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      if (x0 == null || (window.visualViewport && window.visualViewport.scale > 1.05)) { x0 = null; return; }
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) step(dx < 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener("keydown", (e) => {
      if (el.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && pickable(lb.ctx)) {
        const it = lb.list[lb.i];
        if (it) setPick(lb.ctx, it, !isOn(it));
      } else if (e.key === "Tab") trapFocus(e);
    });
    return el;
  }

  function trapFocus(e) {
    const f = [...lb.el.querySelectorAll("button, a[href]")].filter((n) => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!lb.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  async function openLightbox(ctx, list, index, fromEl) {
    if (!lb.el) lb.el = buildLightbox();
    if (ctx.stale()) await ctx.resign();
    lb.ctx = ctx; lb.list = list; lb.i = index;
    lb.returnFocus = fromEl || null;
    lb.el.hidden = false;
    document.body.style.overflow = "hidden";
    renderLightbox();
    lb.el.querySelector(".g-lb-close").focus({ preventScroll: true });
  }

  function closeLightbox() {
    if (!lb.el || lb.el.hidden) return;
    lb.el.hidden = true;
    document.body.style.overflow = "";
    const ctx = lb.ctx, it = lb.list[lb.i];
    lb.ctx = null;
    if (ctx) {
      // the "Picked" view may have changed while the viewer was open
      if (ctx.filter === "picked") applyFilter(ctx);
      const cell = it && ctx.wrap.querySelector(`[data-id="${it.id}"]`);
      const target = (cell && !cell.hidden && cell.querySelector(".g-open, .sb-shot")) || lb.returnFocus;
      if (target) {
        target.focus({ preventScroll: true });
        target.closest("[data-id]")?.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function step(d) {
    if (!lb.list.length) return;
    lb.i = (lb.i + d + lb.list.length) % lb.list.length;
    renderLightbox();
  }

  function renderLightbox() {
    const { ctx, list, i } = lb;
    const it = list[i];
    if (!ctx || !it) return;
    const g = ctx.g;
    const img = lb.el.querySelector("img");
    const many = list.length > 1;
    lb.el.querySelectorAll(".g-lb-nav").forEach((b) => { b.hidden = !many; });
    const sb = g.kind === "storyboard";
    lb.el.classList.toggle("is-sb", sb);
    const unit = sb ? ctx.noun || "frame" : "photo";
    lb.el.setAttribute("aria-label", sb ? (unit === "image" ? "Location viewer" : "Storyboard viewer") : "Photo viewer");
    lb.el.querySelector(".g-lb-nav.prev").setAttribute("aria-label", `Previous ${unit}`);
    lb.el.querySelector(".g-lb-nav.next").setAttribute("aria-label", `Next ${unit}`);
    lb.el.querySelector(".g-lb-count").textContent = `${i + 1} / ${list.length}`;
    lb.el.querySelector(".g-lb-name").textContent = (ctx.lbName ? ctx.lbName(it) : ctx.shown ? ctx.shown(it) : it.filename) || "";
    img.alt = g.kind === "storyboard" ? `${ctx.noun === "image" ? "Image" : "Frame"} ${frameLabel(it)}, ${i + 1} of ${list.length}` : `Photo ${i + 1} of ${list.length}`;

    // show the cached thumbnail instantly, then swap in the full image. v2 on a phone keeps a
    // final on its 1620px display copy: the originals run 30-50MB, too much to decode on an iPhone.
    const light = V2 && (g.kind === "final" || g.kind === "storyboard") && SMALL.matches;
    const pick = (x) => (light ? x.thumb_url || x.url : x.url);
    if (img.dataset.id !== it.id) {
      img.dataset.id = it.id;
      img.src = it.thumb_url || it.url;
      if (it.thumb_url && it.url && !light) {
        const full = new Image();
        full.onload = () => { if (img.dataset.id === it.id) img.src = it.url; };
        full.src = it.url;
      }
      // warm the neighbours so arrowing through feels instant
      [1, -1].forEach((d) => {
        const n = list[(i + d + list.length) % list.length];
        if (n && pick(n)) new Image().src = pick(n);
      });
    }

    const bar = lb.el.querySelector(".g-lb-bar");
    if (sb) {
      const m = it.meta || {};
      const cap = `<p class="sb-lb-cap"><b>${esc([frameLabel(it), m.tc].filter(Boolean).join(" · "))}</b>${m.action ? `<span>${esc(curly(m.action))}</span>` : ""}${m.line ? `<span class="sb-lb-line">${lineHTML(m.line)}</span>` : ""}${it.client_note ? `<span class="sb-lb-note"><i>Your note</i> ${esc(it.client_note)}</span>` : ""}</p>`;
      const act = ctx.editable && ctx.editable()
        ? `<button class="g-lb-pick sb-lb-ask${it.client_note ? " on" : ""}" type="button">${ICON.pen}${it.client_note ? "Edit your note" : "Request a change"}</button>`
        : it.client_note ? `<span class="g-lb-tally">Change requested</span>` : "";
      const stepBtn = (d) => many ? `<button class="sb-lb-step" type="button" data-step="${d}" aria-label="${d < 0 ? "Previous" : "Next"} ${ctx.noun || "frame"}">${d < 0 ? ICON.prev : ICON.chevron}</button>` : "";
      bar.innerHTML = cap + `<div class="sb-lb-row">${stepBtn(-1)}${act}${stepBtn(1)}</div>`;
      return;
    }
    if (g.kind === "proof") {
      const n = pickedCount(g), lim = g.selection_limit, x = xCount(ctx);
      const choosing = ctx.mode === "extras";
      const tally = choosing ? `${x} extra edit${x === 1 ? "" : "s"}${x ? ` · ${xTotal(ctx)}` : ""}`
        : `${n}${lim != null ? ` of ${lim}` : ""} picked${x ? ` + ${x} extra` : ""}`;
      if (g.locked && !choosing) {
        bar.innerHTML = `<span class="g-lb-tally">${it.selected ? `${V2 ? "" : "✓ "}One of your picks` : "Picks sent"} · ${tally}</span>`;
      } else {
        const full = !choosing && lim != null && n >= lim && !it.selected;
        const label = it.selected ? `${CHECK()} Picked`
          : it.extraPending ? `${CHECK()} Extra edit added`
          : choosing || (full && extrasOn(ctx)) ? `Add as an extra edit · ${xPrice(ctx)}`
          : "Pick this photo";
        bar.innerHTML = `
          <button class="g-lb-pick${isOn(it) ? " on" : ""}" aria-pressed="${isOn(it) ? "true" : "false"}">${label}</button>
          <span class="g-lb-tally">${tally}<span class="g-lb-hint"> · press P to pick, arrows to browse</span></span>`;
      }
    } else if (it.download_url) {
      bar.innerHTML = `<a class="btn btn-gold g-lb-dl" href="${esc(it.download_url)}">${V2 ? ICON.download : ""}Download</a>`;
    } else {
      bar.innerHTML = "";
    }
  }

  /* ---------------- gallery block ---------------- */
  function galleryBlock(access, project, g, resign, stale, opts = {}) {
    const wrap = document.createElement("section");
    wrap.className = "g-block";
    wrap.dataset.kind = g.kind;
    const shown = (it) => (opts.displayName ? opts.displayName(it.filename || "", project) : it.filename) || "";
    const ctx = { access, project, g, wrap, filter: "all", confirming: false, resign, stale, shown, opts,
      extra: new Set(), mode: opts.extrasFor ? "extras" : null, real: opts.extrasFor || g, done: opts.extrasDone };

    // v2: once edits land, the sent picks fold into one row that opens them in the viewer
    if (V2 && g.picksOnly && g.delivered) {
      wrap.classList.add("g-block-orig");
      const n = g.items.length;
      wrap.innerHTML = `
        <button class="g-orig" type="button">
          <span class="g-orig-thumbs" aria-hidden="true">${g.items.slice(0, 3).map((it) =>
            `<img loading="lazy" decoding="async" src="${esc(it.thumb_url || it.url)}" alt="">`).join("")}</span>
          <span class="g-orig-text"><b>Your original selections</b><small>${esc(g.title)} · ${n} selected</small></span>
          <span class="g-orig-cta">View selections ${ICON.chevron}</span>
        </button>${extrasOn(ctx) ? `
        <div class="g-more"><span>Want another photo edited? Extra edits are ${xPrice(ctx)} each.</span>
          <button class="btn btn-ghost g-addx" type="button">Add extra edits</button></div>` : ""}`;
      wrap.querySelector(".g-orig").addEventListener("click", (e) => openLightbox(ctx, g.items.slice(), 0, e.currentTarget));
      wrap.querySelector(".g-addx")?.addEventListener("click", () => openExtras(ctx));
      return wrap;
    }

    const lim = g.selection_limit;
    const intro = g.kind !== "proof" || !g.items.length ? ""
      : ctx.mode === "extras" ? `<p class="g-intro">Tap the photos you want edited too. They're <b>${xPrice(ctx)}</b> each, and you'll see the total before anything is charged.</p>`
      : g.locked ? ""
      : `<p class="g-intro">Tap any photo to see it big. ${lim != null
          ? `Pick up to <b>${lim}</b> for editing`
          : "Pick your favorites for editing"}, then send them to Nelson.${extrasOn(ctx) ? ` Want more? Extra edits are ${xPrice(ctx)} each.` : ""}</p>`;

    const head = document.createElement("div");
    head.className = "g-block-head";
    if (V2) {
      const n = g.items.length, s = (w) => (n === 1 ? w : w + "s");
      const h = ctx.mode === "extras" ? "Add extra edits"
        : g.kind === "final" ? "Final photos" : g.kind === "video" ? (n > 1 ? "Final videos" : "Final video")
        : g.picksOnly ? "Your picks" : g.locked ? "Your proofs" : "Pick your favorites";
      const sub = ctx.mode === "extras" ? `${g.title} · ${n} more ${s("photo")} to choose from`
        : !n ? g.title
        : g.kind === "final" ? `${n} edited ${s("photo")} · Full resolution`
        : g.kind === "video" ? `${g.title} · ${n} ${s("video")}`
        : g.picksOnly ? `${g.title} · ${n} selected`
        : `${g.title} · ${n} ${s("proof")}`;
      head.innerHTML = `<div><h2 class="g-h" tabindex="-1">${esc(h)}</h2><p class="g-sub">${esc(sub)}</p>${intro}</div>`;
    } else {
      head.innerHTML = `
      <div>
        <div class="hud"><span class="tick">●</span> ${esc(g.picksOnly ? "Your picks" : KIND_LABEL[g.kind] || g.kind)}</div>
        <h3>${esc(g.title)}</h3>
        ${intro}
      </div>`;
    }
    wrap.appendChild(head);

    if (!g.items.length) {
      const empty = document.createElement("p");
      empty.className = "g-empty";
      empty.textContent =
        g.kind === "proof" ? "Your proofs will appear here once Nelson uploads them."
        : g.kind === "video" ? "Your video will land here when it's delivered."
        : "Your edited photos will appear here.";
      wrap.appendChild(empty);
      return wrap;
    }

    if (g.kind === "video") {
      const list = document.createElement("div");
      list.className = "g-videos";
      g.items.forEach((it) => {
        const card = document.createElement("div");
        card.className = "g-video";
        if (g.held) {
          // the watermarked preview: watch only until the balance is paid (the server sends no original and no download)
          card.classList.add("is-held");
          const u = g.unlock;
          const amt = u ? money(u.amount_cents) : "";
          card.innerHTML = `
          ${it.url
            ? `<video controls controlslist="nodownload noremoteplayback" disablepictureinpicture disableremoteplayback playsinline preload="metadata" src="${esc(it.url)}"></video>`
            : `<div class="g-vwait"><span>Your preview is on its way. Refresh in a minute.</span></div>`}
          <div class="g-cap">
            <span class="g-fn">${esc((V2 ? shown(it) : it.filename) || "Video")}</span>
            <span class="g-vtag">Preview</span>
          </div>
          <div class="g-unlock">
            <p>${u
              ? `This is a watermarked preview. Pay your ${esc(amt)} balance and the full-quality video replaces it right here, ready to download.`
              : "This is a watermarked preview. Your download unlocks once your balance is paid."}</p>
            ${u && V2 ? `<button class="btn btn-gold btn-lg" type="button" data-pay="${esc(u.invoice_id)}"><span class="label">Pay ${esc(amt)} to download</span></button>` : ""}
          </div>`;
          const v = card.querySelector("video");
          if (v) v.addEventListener("contextmenu", (e) => e.preventDefault());
          list.appendChild(card);
          return;
        }
        card.innerHTML = V2 ? `
          <video controls preload="metadata" playsinline src="${esc(it.url)}"></video>
          <div class="g-cap">
            <span class="g-fn">${esc(shown(it) || "Video")}</span>
            <a class="g-save" href="${esc(it.download_url || it.url)}">${ICON.download}<span>Download</span></a>
          </div>` : `
          <video controls preload="metadata" playsinline src="${esc(it.url)}"></video>
          <div class="g-video-row">
            <span class="g-fn">${esc(it.filename || "Video")}</span>
            <a class="btn btn-gold g-dl" href="${esc(it.download_url || it.url)}">Download</a>
          </div>`;
        card.addEventListener("click", (e) => { if (e.target.closest(".g-save, .g-dl")) freshDownload(e, ctx, it); });
        list.appendChild(card);
      });
      wrap.appendChild(list);
      return wrap;
    }

    // finals: one button for the whole set (v2 puts it in the page hero instead)
    if (!V2 && g.kind === "final" && g.items.length > 1) {
      const mb = Math.round(g.items.reduce((s, it) => s + (it.size_bytes || 0), 0) / 1048576);
      const row = document.createElement("div");
      row.className = "g-dlall-row";
      row.innerHTML = `
        <button class="btn btn-gold g-dlall">Download all ${g.items.length} photos</button>
        <span class="g-dlall-note">One zip file${mb ? ` · ${mb} MB` : ""}</span>`;
      row.querySelector(".g-dlall").addEventListener("click", (e) => zipDownload(ctx, g.items, g.title, e.currentTarget));
      wrap.appendChild(row);
    }

    // proof: All / Picked filter (only while picking; sent picks already show just the picks)
    if (g.kind === "proof" && !g.locked && ctx.mode !== "extras") {
      const tools = document.createElement("div");
      tools.className = "g-tools";
      tools.setAttribute("role", "group");
      tools.setAttribute("aria-label", "Show");
      wrap.appendChild(tools);
      tools.addEventListener("click", (e) => {
        const b = e.target.closest("[data-filter]");
        if (!b) return;
        ctx.filter = b.dataset.filter;
        renderTools(ctx);
        applyFilter(ctx);
      });
      renderTools(ctx);
    }

    // proof + final share a grid
    const grid = document.createElement("div");
    grid.className = "g-grid" + (g.kind === "final" ? " g-grid-final" : "");
    g.items.forEach((it, idx) => {
      const cell = document.createElement("figure");
      cell.className = "g-cell" + (g.kind === "final" ? " final" : "") + (it.selected ? " sel" : "") + (it.extraPending ? " xtra" : "");
      cell.dataset.id = it.id;
      const n = idx + 1;
      const fin = V2 && g.kind === "final";
      cell.innerHTML = `
        <button class="g-open" aria-label="View photo ${n}${it.filename ? ` (${esc(shown(it))})` : ""}">
          <img loading="lazy" decoding="async" src="${esc(it.thumb_url || it.url)}" alt="">${fin ? `<span class="g-expand" aria-hidden="true">${ICON.expand}</span>` : ""}
        </button>` +
        (g.kind === "proof"
          ? (g.locked ? "" : `<button class="g-pick" aria-pressed="${isOn(it) ? "true" : "false"}" aria-label="${ctx.mode === "extras" ? "Add" : "Pick"} photo ${n}"><span>${CHECK()}</span></button>`)
          : fin
            ? `<figcaption class="g-cap"><span class="g-fn">${esc(shown(it))}</span><a class="g-save" href="${esc(it.download_url || it.url)}" aria-label="Download ${esc(shown(it) || `photo ${n}`)}">${ICON.download}<span>Download</span></a></figcaption>`
            : `<a class="g-save" href="${esc(it.download_url || it.url)}" aria-label="Download photo ${n}"><span aria-hidden="true">&#8595;</span> Download</a>`);
      grid.appendChild(cell);
    });
    grid.addEventListener("click", (e) => {
      const cell = e.target.closest(".g-cell");
      if (!cell) return;
      const it = g.items.find((x) => x.id === cell.dataset.id);
      if (!it) return;
      if (e.target.closest(".g-pick")) { setPick(ctx, it, !isOn(it)); return; }
      if (e.target.closest(".g-save")) { freshDownload(e, ctx, it); return; }
      const opener = e.target.closest(".g-open");
      if (opener) {
        const list = visibleItems(ctx);
        openLightbox(ctx, list, Math.max(0, list.indexOf(it)), opener);
      }
    });
    // size cells to the photos' own shape (portrait shoots stop getting cropped to squares)
    const first = grid.querySelector("img");
    if (first) {
      const setRatio = () => {
        if (first.naturalWidth && first.naturalHeight) grid.style.setProperty("--g-ar", `${first.naturalWidth} / ${first.naturalHeight}`);
      };
      first.complete ? setRatio() : first.addEventListener("load", setRatio, { once: true });
    }
    wrap.appendChild(grid);

    // v2 phones swipe through the finals sideways (client.css); dots say which one is in view
    if (V2 && g.kind === "final" && g.items.length > 1) {
      const dots = document.createElement("div");
      dots.className = "g-dots";
      dots.setAttribute("aria-hidden", "true");
      dots.innerHTML = g.items.map((_, i) => `<i${i ? "" : ' class="on"'}></i>`).join("");
      wrap.appendChild(dots);
      let raf = 0;
      grid.addEventListener("scroll", () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const cell = grid.querySelector(".g-cell");
          if (!cell) return;
          const step = cell.getBoundingClientRect().width + parseFloat(getComputedStyle(grid).columnGap || 0);
          const max = grid.scrollWidth - grid.clientWidth;
          // the last card can't reach the left edge, so the end of the scroll counts as "last"
          const at = grid.scrollLeft >= max - 2 ? g.items.length - 1 : Math.round(grid.scrollLeft / step);
          [...dots.children].forEach((d, i) => d.classList.toggle("on", i === at));
        });
      }, { passive: true });
    }

    const none = document.createElement("p");
    none.className = "g-empty g-none";
    none.hidden = true;
    none.textContent = "No picks yet. Tap the check on any photo, or open one and hit Pick.";
    wrap.appendChild(none);

    if (g.kind === "proof") {
      const bar = document.createElement("div");
      bar.className = "g-selbar";
      bar.setAttribute("aria-live", "polite");
      wrap.appendChild(bar);
      bar.addEventListener("click", (e) => {
        if (e.target.closest(".g-submit")) { ctx.confirming = true; renderSelbar(ctx); bar.querySelector(".g-send")?.focus(); }
        else if (e.target.closest(".g-cancel")) { ctx.confirming = false; renderSelbar(ctx); bar.querySelector(".g-submit")?.focus(); }
        else if (e.target.closest(".g-send")) (ctx.mode === "extras" ? submitExtras : submitPicks)(ctx);
        else if (e.target.closest(".g-xcancel")) ctx.done(false);
        else if (e.target.closest(".g-addx")) openExtras(ctx);
        else if (e.target.closest(".g-showpicks")) { ctx.filter = "picked"; renderTools(ctx); applyFilter(ctx); wrap.scrollIntoView({ block: "start" }); }
      });
      renderSelbar(ctx);
    }
    return wrap;
  }

  const visibleItems = (ctx) => ctx.filter === "picked" ? ctx.g.items.filter(isOn) : ctx.g.items.slice();

  function renderTools(ctx) {
    const tools = ctx.wrap.querySelector(".g-tools");
    if (!tools) return;
    const n = pickedCount(ctx.g) + xCount(ctx);
    tools.innerHTML = `
      <button data-filter="all" aria-pressed="${ctx.filter === "all"}">All <span>${ctx.g.items.length}</span></button>
      <button data-filter="picked" aria-pressed="${ctx.filter === "picked"}">Picked <span>${n}</span></button>`;
  }

  function applyFilter(ctx) {
    const picked = ctx.filter === "picked";
    let shown = 0;
    ctx.wrap.querySelectorAll(".g-cell").forEach((cell) => {
      const hide = picked && !cell.classList.contains("sel") && !cell.classList.contains("xtra");
      cell.hidden = hide;
      if (!hide) shown++;
    });
    ctx.wrap.querySelector(".g-none").hidden = shown > 0;
  }

  function renderSelbar(ctx) {
    const bar = ctx.wrap.querySelector(".g-selbar");
    if (!bar) return;
    const g = ctx.g;
    const n = pickedCount(g);
    const lim = g.selection_limit;
    const x = xCount(ctx), xs = x === 1 ? "" : "s";
    if (ctx.mode === "extras") {
      bar.classList.add("live");
      if (ctx.confirming && x) {
        bar.innerHTML = `
        <span class="g-confirm">Add ${x} extra edit${xs} for ${xTotal(ctx)}? You'll pay on the next step.</span>
        <span class="g-actions">
          <button class="btn btn-ghost g-cancel">Back</button>
          <button class="btn btn-gold g-send">Yes, add ${x}</button>
        </span>`;
        return;
      }
      ctx.confirming = false;
      bar.innerHTML = `
      <span class="g-count">${x ? `${x} extra edit${xs} · ${xTotal(ctx)}` : "Tap photos to add them"}</span>
      <span class="g-actions">
        <button class="btn btn-ghost g-xcancel">Cancel</button>
        <button class="btn btn-gold g-submit"${x ? "" : " disabled"}>Add ${x ? `${x} · ${xTotal(ctx)}` : "extra edits"}</button>
      </span>`;
      return;
    }
    if (g.locked) {
      bar.classList.remove("live");
      bar.innerHTML = V2
        ? `<span class="g-sent">${ICON.check} Picks sent · ${n} chosen</span>${extrasOn(ctx) // the page hero says what happens next
          ? `<button class="btn btn-ghost g-addx" type="button">Add extra edits · ${xPrice(ctx)} each</button>` : ""}`
        : `<span class="pill green">Picks sent ✓ &nbsp;${n} chosen</span>
        <span class="g-selnote">${g.delivered ? "Your edited versions are up top in “Edited photos”."
          : "Nelson is editing your picks. Final images land in “Edited photos”."}</span>`;
      return;
    }
    bar.classList.toggle("live", n > 0 || x > 0);
    if (ctx.confirming && n > 0) {
      bar.innerHTML = `
        <span class="g-confirm">${x
          ? `Send ${n} pick${n === 1 ? "" : "s"} + ${x} extra edit${xs} (${xTotal(ctx)})? Picks lock once they're sent, and you'll pay for the extras right here.`
          : `Send these ${n} to Nelson? Picks lock once they're sent.`}</span>
        <span class="g-actions">
          <button class="btn btn-ghost g-cancel">Keep picking</button>
          <button class="btn btn-gold g-send">Yes, send ${n + x}</button>
        </span>`;
      return;
    }
    ctx.confirming = false;
    bar.innerHTML = `
      <span class="g-count">${n}${lim != null ? ` of ${lim}` : ""} picked${x ? ` + ${x} extra · ${xTotal(ctx)}` : ""}</span>
      <span class="g-actions">
        ${n ? `<button class="btn btn-ghost g-showpicks">Review picks</button>` : ""}
        <button class="btn btn-gold g-submit"${n < 1 ? " disabled" : ""}>Send ${n + x ? n + x + " " : ""}pick${n + x === 1 ? "" : "s"} to Nelson</button>
      </span>`;
  }

  /* ---------------- finals: the whole set as one zip ---------------- */
  // Built in the browser from the signed links: storage caps a single file at 50MB, so there's
  // no stored zip. JPEGs don't shrink in a zip, so this is only packaging.
  // the button's text (or its .label child, so an icon survives) shows progress
  async function zipDownload(ctx, all, title, btn) {
    const labelEl = btn.querySelector(".label") || btn;
    const label = labelEl.textContent;
    const say = (t) => { labelEl.textContent = t; };
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    say("Getting ready…");
    try {
      if (ctx.stale()) await ctx.resign();
      const { downloadZip } = await import(new URL("vendor/client-zip.js", CORE_SRC).href);
      const items = all.filter((it) => it.url);
      let n = 0;
      async function* files() {
        for (const it of items) {
          say(`Preparing ${++n} of ${items.length}…`);
          const r = await fetch(it.url);
          if (!r.ok) throw new Error("fetch_failed");
          yield { name: it.filename || `photo-${n}.jpg`, input: r };
        }
      }
      const blob = await downloadZip(files()).blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(title || "Photos").replace(/[\\/:*?"<>|]+/g, "-")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // keep the file around long enough for a phone's "Download?" prompt to be answered
      setTimeout(() => URL.revokeObjectURL(a.href), 10 * 60 * 1000);
      toast("Your zip is downloading.");
    } catch (_) {
      toast("Couldn't build the zip. Try again, or use Download under each photo.");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      say(label);
    }
  }

  // a sent set reopens as a chooser of the photos that aren't picks yet
  function openExtras(ctx) {
    const g = ctx.real;
    const pool = (g.all || g.items).filter((i) => !i.selected);
    if (!pool.length) { toast("Every photo in this set is already one of your picks."); return; }
    pool.forEach((i) => { i.extraPending = false; });
    const gx = { ...g, items: pool, locked: false, picksOnly: false, delivered: false };
    const back = (added) => {
      pool.forEach((i) => { i.extraPending = false; });
      if (added) { g.items = (g.all || g.items).filter((i) => i.selected); g.picksOnly = true; }
      const fresh = galleryBlock(ctx.access, ctx.project, g, ctx.resign, ctx.stale, { ...ctx.opts, extrasFor: null, extrasDone: null });
      chooser.replaceWith(fresh);
      fresh.querySelector(".g-h, .g-orig")?.focus({ preventScroll: true });
    };
    const chooser = galleryBlock(ctx.access, ctx.project, gx, ctx.resign, ctx.stale, { ...ctx.opts, extrasFor: g, extrasDone: back });
    ctx.wrap.replaceWith(chooser);
    chooser.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    chooser.querySelector(".g-h")?.focus({ preventScroll: true });
  }

  async function submitExtras(ctx) {
    const ids = [...ctx.extra];
    const btn = ctx.wrap.querySelector(".g-send");
    if (!ids.length) return;
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    try {
      const r = await ctx.opts.extras.request(ctx.real.id, ids);
      ctx.g.items.forEach((i) => { if (ctx.extra.has(i.id)) { i.selected = true; i.extra = true; } });
      ctx.extra.clear();
      toast(`Added ${r.count} extra edit${r.count === 1 ? "" : "s"}. Pay ${dollars(r.amount_cents)} at the top of the page to lock ${r.count === 1 ? "it" : "them"} in.`);
      ctx.done(true);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = `Yes, add ${ids.length}`; }
      toast(err.message === "nothing_to_add" ? "Those are already in your picks." : "Couldn't add those just now. Try again.");
    }
  }

  // picks are locked in: drop the pick controls (v2 also narrows the set to the picks, as a reload would)
  function afterSent(ctx) {
    const { g, wrap } = ctx;
    wrap.querySelectorAll(".g-pick").forEach((b) => b.remove());
    wrap.querySelector(".g-intro")?.remove();
    wrap.querySelectorAll(".g-cell").forEach((cell) => {
      const it = g.items.find((x) => x.id === cell.dataset.id);
      if (it) { cell.classList.toggle("sel", !!it.selected); cell.classList.remove("xtra"); }
    });
    if (V2) {
      g.picksOnly = true;
      wrap.querySelector(".g-tools")?.remove();
      ctx.filter = "picked";
      applyFilter(ctx);
      const h = wrap.querySelector(".g-h"), sub = wrap.querySelector(".g-sub");
      if (h) h.textContent = "Your picks";
      if (sub) sub.textContent = `${g.title} · ${pickedCount(g)} selected`;
    }
    renderSelbar(ctx);
    wrap.dispatchEvent(new CustomEvent("bkgallery:sent", { bubbles: true }));
  }

  async function submitPicks(ctx) {
    const { g, wrap } = ctx;
    const btn = wrap.querySelector(".g-send");
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    try {
      const r = await call(ctx.access, { action: "submit_selections", gallery_id: g.id });
      g.locked = true;
      ctx.confirming = false;
      let more = "";
      if (xCount(ctx) && extrasOn(ctx)) {
        const ids = [...ctx.extra];
        try {
          const xr = await ctx.opts.extras.request(g.id, ids);
          g.items.forEach((i) => { if (ctx.extra.has(i.id)) { i.selected = true; i.extra = true; } });
          more = ` Pay ${dollars(xr.amount_cents)} at the top of the page for your extra edit${xr.count === 1 ? "" : "s"}.`;
        } catch (_) {
          more = " Your extra edits didn't go through. Tap Add extra edits to try again.";
        }
        g.items.forEach((i) => { i.extraPending = false; });
        ctx.extra.clear();
      }
      afterSent(ctx);
      toast(`Sent ${r.count} pick${r.count === 1 ? "" : "s"} to Nelson.${more}`);
    } catch (err) {
      if (err.message === "already_submitted") {
        g.locked = true; ctx.confirming = false;
        afterSent(ctx);
        toast("These picks were already sent.");
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = `Yes, send ${pickedCount(g)}`; }
      toast("Couldn't send. Try again.");
    }
  }

  /* ---------------- storyboard (v2): frames in story order, a change note per frame, one review ---------------- */
  // captions come from item.meta: { code, tc, scene_no, scene, action, line, feature }; admin uploads may have none
  function frameLabel(it) { return (it.meta && it.meta.code) || `#${it.sort || ""}`; }
  const tcEnds = (tc) => (tc || "").split(/\s*[–-]\s*/);
  // straight quotes in a caption are set as typographic ones, on screen only
  const curly = (s) => String(s || "").replace(/"([^"]*)"/g, "“$1”").replace(/(\w)'(\w)/g, "$1’$2");
  // "JAKE: "Bro…"" → the speaker set as a small label, the line as written. One caption can carry
  // several cues ("ANNOUNCER: … SOUND: …"): each gets its own label and line.
  const lineHTML = (line) => curly(line).trim()
    .split(/\s+(?=[A-Z][A-Z0-9 .'\/&-]{0,30}(?:\s*\([^)]{1,24}\))?:\s)/)
    .map((seg) => {
      // "SEEKER (whispering): …" keeps its stage direction in the label
      const m = /^([A-Z][A-Z0-9 .'\/&-]{0,30}(?:\s*\([^)]{1,24}\))?):\s*([\s\S]+)$/.exec(seg);
      return `<span class="sb-cue">${m ? `<span class="sb-who">${esc(m[1])}</span> ${esc(m[2])}` : esc(seg)}</span>`;
    }).join("");
  const sbNotes = (g) => g.items.filter((i) => i.client_note).length;
  // Nelson's still building it (locked, never reviewed), or it has no frames yet: not for the client
  const sbHidden = (g) => g.kind === "storyboard" && ((g.locked && !g.review_outcome) || !g.items.length);
  // the deposit invoice approving leads to (HoneyBook); only a plain https link is followed
  const safePay = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dayOf = (t) => (t ? new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "");
  const pad2 = (x) => String(x).padStart(2, "0");
  // a half-written note survives a reload, or iPhone Safari dropping the tab (it skips beforeunload)
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  };
  const draftKey = (id) => `bk-sb-draft:${id}`;
  let sbGuard = false;
  function guardDrafts() {
    if (sbGuard) return;
    sbGuard = true;
    window.addEventListener("beforeunload", (e) => {
      const dirty = [...document.querySelectorAll(".sb-form textarea")].some((t) => t.value.trim() !== (t.dataset.saved || ""));
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function storyboardBlock(access, project, g, resign, stale, opts = {}) {
    guardDrafts();
    const wrap = document.createElement("section");
    wrap.className = "g-block sb" + (opts.superseded ? " sb-past" : "");
    wrap.dataset.kind = "storyboard";
    const byId = (id) => g.items.find((x) => x.id === id);
    const scenes = [];
    g.items.forEach((it) => {
      const m = it.meta || {};
      const key = m.scene_no != null ? String(m.scene_no) : (m.scene || "");
      let sc = scenes[scenes.length - 1];
      if (!sc || sc.key !== key) scenes.push((sc = { key, no: m.scene_no, name: m.scene || "", items: [] }));
      sc.items.push(it);
    });
    const sceneOf = (it) => scenes.find((sc) => sc.items.includes(it));
    // notes only change on the current round while it's open; an earlier round is read only
    const editable = () => !g.locked && !opts.superseded;
    // a location review (reference images of the place every shot is built in) uses the same review
    // with its own words; it has no deposit step
    const loc = g.purpose === "location";
    const noun = loc ? "image" : "frame", Noun = loc ? "Image" : "Frame";
    const nouns = (k) => `${k} ${noun}${k === 1 ? "" : "s"}`;
    const endKey = `bk-sb-end:${g.id}`;
    const ctx = {
      access, project, g, wrap, resign, stale, editable, noun, confirming: false, editing: new Set(), obs: [],
      scene: 0, seenEnd: !editable() || store.get(endKey) === "1",
      lbName: (it) => { const sc = sceneOf(it); return !sc || !sc.key ? g.title : sc.no != null ? `Scene ${pad2(sc.no)} · ${sc.name}` : sc.name; },
    };
    ctx.openNote = (it) => openNote(it);

    // a note she was writing before a reload comes back open, with her words in it
    const restored = new Map();
    g.items.forEach((it) => {
      const d = store.get(draftKey(it.id));
      if (d == null) return;
      if (editable() && d.trim() !== (it.client_note || "")) { restored.set(it.id, d); ctx.editing.add(it.id); }
      else store.set(draftKey(it.id), null);
    });
    const restoredN = restored.size;

    // a featured frame spans the row: the ones Nelson flags (meta.feature), plus the last frame of any
    // odd run, so a row never ends with a hole
    const feat = new Set();
    scenes.forEach((sc) => {
      let run = [];
      const close = () => { if (run.length % 2) feat.add(run[run.length - 1].id); run = []; };
      sc.items.forEach((it) => { if (it.meta && it.meta.feature) { close(); feat.add(it.id); } else run.push(it); });
      close();
    });

    const n = g.items.length;
    const k0 = sbNotes(g);
    const sid = `sb-st-${g.id}`;
    const head = document.createElement("div");
    head.className = "g-block-head";
    head.innerHTML = opts.superseded
      ? `<div><h2 class="g-h" tabindex="-1">Earlier version</h2><p class="g-sub">${esc(g.title)} · ${nouns(n)}</p></div>`
      : `<div><h2 class="g-h" tabindex="-1" aria-describedby="${esc(sid)}">${loc ? "Your location" : "Your storyboard"}</h2><p class="g-sub">${esc(g.title)} · ${nouns(n)}</p><div class="sb-status" id="${esc(sid)}" hidden></div>${editable() && n ? `
        <p class="g-intro">${loc
          ? "This is the building every shot of your commercial happens in: the outside, the fun side, the neighborhood side and the whole place from above. Tap an image to see it big. Want something different? Hit <b>Request a change</b> on that image and tell Nelson what you'd like. When it looks right, approve it at the end."
          : "Every shot of your commercial, in order. Tap a frame to see it big. The story is set, so notes are about how a shot looks: the people, framing, colors, props. Hit <b>Request a change</b> on any frame and tell Nelson what you'd like. When it all looks right, approve it at the end."}</p>` : ""}</div>`;
    wrap.appendChild(head);

    if (!n) {
      const empty = document.createElement("p");
      empty.className = "g-empty";
      empty.textContent = "Your storyboard frames will show up here once Nelson uploads them.";
      wrap.appendChild(empty);
      return { wrap, ctx };
    }

    const frameHTML = (it) => {
      const m = it.meta || {};
      const code = esc(frameLabel(it));
      const big = feat.has(it.id);
      // a featured frame runs twice as wide: the full image on a computer, the preview on a phone
      const src = big && !SMALL.matches ? it.url || it.thumb_url : it.thumb_url || it.url;
      return `<li class="sb-frame${big ? " sb-feat" : ""}${it.client_note ? " has-note" : ""}" data-id="${esc(it.id)}">
        <button class="sb-shot" type="button" aria-label="View ${noun} ${code} big">
          <img loading="lazy" decoding="async" src="${esc(src)}" alt="">
          <span class="sb-code" aria-hidden="true">${code}</span>
          <span class="g-expand" aria-hidden="true">${ICON.expand}</span>
        </button>
        <div class="sb-copy">
          ${m.tc ? `<p class="sb-tc"><span class="vh">${Noun} ${code}, </span>${esc(m.tc)}</p>` : `<p class="vh">${Noun} ${code}</p>`}
          ${m.action ? `<p class="sb-action">${esc(curly(m.action))}</p>` : ""}
          ${m.line ? `<p class="sb-line">${lineHTML(m.line)}</p>` : ""}
        </div>
        <div class="sb-fb">${fbHTML(it)}</div>
      </li>`;
    };
    const scenesHTML = scenes.map((sc, i) => {
      const first = tcEnds((sc.items[0].meta || {}).tc)[0], last = tcEnds((sc.items[sc.items.length - 1].meta || {}).tc).pop();
      const range = first && last ? `${first}–${last}` : "";
      const id = `sb-${g.id}-${i}`;
      return `<section class="sb-scene"${sc.key ? ` aria-labelledby="${esc(id)}"` : ""}>
        ${sc.key ? `<header class="sb-scene-h">
          <span class="sb-scene-n">Scene ${esc(sc.no != null ? pad2(sc.no) : pad2(i + 1))}</span>
          <h3 id="${esc(id)}">${esc(sc.name)}</h3>
          ${range ? `<span class="sb-scene-tc">${esc(range)}</span>` : ""}
        </header>` : ""}
        <ol class="sb-frames">${sc.items.map(frameHTML).join("")}</ol>
      </section>`;
    }).join("");

    const body = document.createElement("div");
    body.className = "sb-scenes";
    // the end marker: once it's on screen she has seen every frame, and the bar offers the review
    body.innerHTML = scenesHTML + `<div class="sb-end" aria-hidden="true"></div>`;
    if (opts.superseded) {
      // an earlier round stays reachable, folded under one row
      const det = document.createElement("details");
      det.className = "sb-old";
      const when = dayOf(g.reviewed_at);
      det.innerHTML = `<summary><span><b>${esc(g.title)}</b><small>${g.review_outcome === "approved" ? "Approved" : `${k0} change${k0 === 1 ? "" : "s"} sent`}${when ? ` · ${esc(when)}` : ""}</small></span><span class="g-orig-cta">Show frames ${ICON.chevron}</span></summary>`;
      det.appendChild(body);
      wrap.appendChild(det);
    } else {
      wrap.appendChild(body);
      const bar = document.createElement("div");
      bar.className = "g-selbar sb-bar";
      wrap.appendChild(bar);
    }
    renderBar();
    watch();
    if (restoredN) setTimeout(() => toast(`Your unsaved note${restoredN === 1 ? " is" : "s are"} still here. Save when you're ready.`), 700);

    function fbHTML(it) {
      const code = esc(frameLabel(it));
      if (editable() && ctx.editing.has(it.id)) {
        const fid = `sb-n-${esc(it.id)}`;
        const text = restored.has(it.id) ? restored.get(it.id) : it.client_note || "";
        restored.delete(it.id);
        return `<form class="sb-form" data-note-form novalidate>
          <label for="${fid}">What should change in ${code}?</label>
          <textarea id="${fid}" rows="3" maxlength="1000" data-saved="${esc(it.client_note || "")}" placeholder="Say what you'd like different in this shot.">${esc(text)}</textarea>
          <div class="sb-form-row">
            <button class="btn btn-gold" type="submit"><span class="label">Save note</span></button>
            <button class="btn btn-ghost" type="button" data-sb="cancel">Cancel</button>
          </div>
          <p class="form-err" role="alert" hidden></p>
        </form>`;
      }
      if (it.client_note) {
        return `<div class="sb-note">
          <span class="sb-tag">${ICON.pen}Change requested</span>
          <p class="sb-note-t">${esc(it.client_note)}</p>
          ${editable() ? `<div class="sb-note-acts">
            <button class="sb-link" type="button" data-sb="edit">Edit note</button>
            <button class="sb-link" type="button" data-sb="remove">Remove</button>
          </div>` : ""}
        </div>`;
      }
      return editable() ? `<button class="btn btn-ghost sb-ask" type="button" data-sb="edit">${ICON.pen}<span>Request a change</span></button>` : "";
    }

    function refreshFrame(it) {
      const li = wrap.querySelector(`.sb-frame[data-id="${it.id}"]`);
      if (!li) return null;
      li.classList.toggle("has-note", !!it.client_note);
      li.querySelector(".sb-fb").innerHTML = fbHTML(it);
      return li;
    }

    // after the review: what happened, and what's next (top of the storyboard and at the end)
    function statusHTML() {
      const k = sbNotes(g), ks = k === 1 ? "" : "s";
      const when = dayOf(g.reviewed_at);
      const ask = `<button class="sb-msg" type="button" data-open-messages>Message Nelson</button>`;
      if (g.review_outcome === "approved" && loc) {
        return `<span class="g-sent">${ICON.check}Location approved${when ? ` · ${esc(when)}` : ""}</span><span class="g-selnote">Nelson is updating your storyboard in this building. It will show up here. Questions? ${ask}</span>`;
      }
      if (g.review_outcome === "approved") {
        const pay = safePay(g.pay_url);
        return `<span class="g-sent">${ICON.check}Storyboard approved${when ? ` · ${esc(when)}` : ""}</span>` + (pay
          ? `<a class="btn btn-gold sb-pay" href="${esc(pay)}">Pay your deposit</a><span class="g-selnote">On HoneyBook. Production starts once it's paid.</span>`
          : `<span class="g-selnote">Next is your deposit. Production starts once it's paid. Questions? ${ask}</span>`);
      }
      return `<span class="g-sent sb-sent-ch">${ICON.pen}Notes sent · ${k} change${ks}</span><span class="g-selnote">Nelson is going over your notes. Updated ${noun}s will show up here. Questions? ${ask}</span>`;
    }

    function barHTML() {
      if (g.locked) return statusHTML();
      const k = sbNotes(g), ks = k === 1 ? "" : "s";
      const noted = k ? `${k} change${ks} requested` : "no notes yet";
      if (ctx.confirming) {
        const pay = safePay(g.pay_url);
        return `<span class="g-confirm">${k
          ? `Send your ${k} note${ks} to Nelson? He'll go over ${k === 1 ? "it" : "them"} and send updated ${noun}s back here.`
          : loc ? "Approve the location? Nelson will build your updated storyboard in this building."
          : pay ? "Approve the storyboard? Notes close after this, and you'll go straight to your deposit invoice on HoneyBook. Production starts once it's paid."
          : "Approve the storyboard? Notes close after this. Next is your deposit, and production starts once it's paid."}</span>
          <span class="g-actions">
            <button class="btn btn-ghost" type="button" data-sb="back">Keep reviewing</button>
            <button class="btn btn-gold" type="button" data-sb="send"><span class="label">${k ? `Yes, send ${k}` : "Yes, approve"}</span></button>
          </span>`;
      }
      // a note box is open: finish it first (the review would leave it out)
      const open = [...ctx.editing].map(byId).find(Boolean);
      if (open) {
        return `<span class="g-count">Note open on ${esc(frameLabel(open))}</span>
          <span class="g-actions"><button class="btn btn-ghost" type="button" data-sb="goto">Go to note</button></span>`;
      }
      // until she's seen the last frame, the bar walks her through the scenes
      if (!ctx.seenEnd) {
        const i = Math.min(ctx.scene, scenes.length - 1), last = i >= scenes.length - 1;
        const where = scenes.length > 1 ? `Scene ${pad2(i + 1)} of ${pad2(scenes.length)}` : nouns(n);
        return `<span class="g-count">${where}<span class="sb-long"> · ${noted}</span></span>
          <span class="g-actions"><button class="btn btn-ghost sb-next" type="button" data-sb="next">${last ? "To the last frame" : "Next scene"}${ICON.down}</button></span>`;
      }
      // phones show the short version ("1 change" + "Send 1 change") so the bar stays one row
      return `<span class="g-count"><span class="sb-long">${nouns(n)} · ${noted}</span><span class="sb-short">${k ? `${k} change${ks}` : "No notes yet"}</span></span>
        <span class="g-actions">
          <button class="btn btn-gold" type="button" data-sb="review">${k ? `Send ${k} change${ks}<span class="sb-long"> to Nelson</span>` : loc ? "Approve location" : "Approve storyboard"}</button>
        </span>`;
    }

    function renderBar() {
      const bar = wrap.querySelector(".sb-bar");
      if (!bar) return;
      const a = document.activeElement;
      const keep = a && bar.contains(a) && a.dataset ? a.dataset.sb : null;
      bar.classList.toggle("live", !g.locked);
      // phones put the bar away while a note is open (the keyboard needs the room). This follows the
      // open/close taps, never focus: a style change mid-tap makes a phone drop the tap on Save.
      wrap.classList.toggle("sb-editing", !g.locked && ctx.editing.size > 0);
      bar.innerHTML = barHTML();
      if (keep) bar.querySelector(`[data-sb="${keep}"]`)?.focus({ preventScroll: true });
      if (g.locked) {
        const top = wrap.querySelector(".sb-status");
        if (top) { top.innerHTML = bar.innerHTML; top.hidden = false; }
      }
    }

    // the bar shows once the frames do (on the first screen it would sit over the intro), follows the
    // scene she's on, and offers the review once the last frame has been on screen
    function watch() {
      const bar = wrap.querySelector(".sb-bar");
      if (!bar || !editable()) return;
      if (!("IntersectionObserver" in window)) { bar.classList.add("armed"); ctx.seenEnd = true; renderBar(); return; }
      const sceneEls = [...body.querySelectorAll(".sb-scene")];
      const arm = new IntersectionObserver(([e]) => {
        bar.classList.toggle("armed", e.isIntersecting || e.boundingClientRect.top < 0);
      }, { rootMargin: "0px 0px -50% 0px" });
      arm.observe(body);
      const follow = new IntersectionObserver((es) => {
        const hit = es.filter((e) => e.isIntersecting).pop();
        const i = hit ? sceneEls.indexOf(hit.target) : -1;
        if (i < 0 || i === ctx.scene) return;
        ctx.scene = i;
        if (!ctx.seenEnd && !ctx.confirming && !ctx.editing.size) renderBar();
      }, { rootMargin: "-40% 0px -55% 0px" });
      sceneEls.forEach((el) => follow.observe(el));
      ctx.obs.push(arm, follow);
      if (!ctx.seenEnd) {
        const end = new IntersectionObserver(([e]) => {
          if (!e.isIntersecting) return;
          ctx.seenEnd = true;
          store.set(endKey, "1");
          end.disconnect();
          if (!ctx.confirming) renderBar();
        });
        end.observe(body.querySelector(".sb-end"));
        ctx.obs.push(end);
      }
    }

    function openNote(it) {
      if (!editable() || !it) return;
      ctx.editing.add(it.id);
      ctx.confirming = false;
      const li = refreshFrame(it);
      renderBar();
      const ta = li && li.querySelector("textarea");
      if (!ta) return;
      li.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }

    function closeNote(it) {
      ctx.editing.delete(it.id);
      const li = refreshFrame(it);
      renderBar();
      li?.querySelector("[data-sb='edit']")?.focus({ preventScroll: true });
    }

    // this tab is behind (sent or replaced from another device): show them the current state
    function staleReload(code) {
      toast(code === "superseded" ? "Nelson posted a newer version. Reloading so you can see it."
        : "This storyboard was already sent to Nelson. Reloading.");
      setTimeout(() => location.reload(), 1800);
    }

    async function saveNote(it, text) {
      const li = wrap.querySelector(`.sb-frame[data-id="${it.id}"]`);
      const form = li && li.querySelector("[data-note-form]");
      const note = (text || "").trim();
      if (form && !note && !it.client_note) { store.set(draftKey(it.id), null); closeNote(it); return; }
      const btn = form ? form.querySelector("[type=submit]") : li && li.querySelector("[data-sb='remove']");
      const err = form && form.querySelector(".form-err");
      const label = btn && (btn.querySelector(".label") || btn);
      const was = label && label.textContent;
      if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); label.textContent = form ? "Saving…" : "Removing…"; }
      if (err) err.hidden = true;
      try {
        const r = await call(access, { action: "storyboard_note", item_id: it.id, note });
        it.client_note = r.note || null;
        store.set(draftKey(it.id), null);
        closeNote(it);
        toast(it.client_note ? `Note saved on ${frameLabel(it)}.` : `Note removed from ${frameLabel(it)}.`);
      } catch (e) {
        if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); label.textContent = was; }
        if (e.message === "locked" || e.message === "superseded") { staleReload(e.message); return; }
        if (err) { err.textContent = "Couldn't save your note. Check your connection and try again."; err.hidden = false; }
        else toast("Couldn't remove that note. Try again.");
      }
    }

    async function submitReview() {
      // an open note that isn't saved would be left out: ask for it first
      const draft = [...wrap.querySelectorAll(".sb-form textarea")].find((t) => t.value.trim() !== (t.dataset.saved || ""));
      if (draft) {
        ctx.confirming = false;
        renderBar();
        toast("Save or cancel your open note first.");
        draft.focus();
        return;
      }
      const k = sbNotes(g);
      const btn = wrap.querySelector(".sb-bar [data-sb='send']");
      const label = btn && btn.querySelector(".label");
      if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); label.textContent = "Sending…"; }
      try {
        const r = await call(access, { action: "storyboard_submit", gallery_id: g.id, expect: k ? "changes" : "approved", expect_notes: k });
        g.locked = true;
        g.review_outcome = r.outcome;
        g.reviewed_at = r.reviewed_at;
        if (r.pay_url) g.pay_url = r.pay_url;
        ctx.confirming = false;
        ctx.editing.clear();
        ctx.obs.forEach((o) => o.disconnect());
        g.items.forEach((it) => store.set(draftKey(it.id), null));
        g.items.forEach(refreshFrame);
        wrap.querySelector(".g-intro")?.remove();
        renderBar();
        const pay = r.outcome === "approved" && !loc && safePay(g.pay_url);
        wrap.dispatchEvent(new CustomEvent("bkgallery:reviewed", { bubbles: true, detail: { outcome: r.outcome, notes: r.notes, payUrl: pay || null } }));
        if (pay) {
          // approving leads straight on to the deposit, as the confirm said
          toast("Storyboard approved. Opening your deposit invoice…");
          setTimeout(() => location.assign(pay), 1400);
          return;
        }
        // land on the status at the top; the heading reads it out (aria-describedby)
        wrap.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
        wrap.querySelector(".g-h")?.focus({ preventScroll: true });
      } catch (e) {
        if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); label.textContent = k ? `Yes, send ${k}` : "Yes, approve"; }
        if (e.message === "outcome_changed") {
          toast("Your notes changed on another device. Reloading so you can see them.");
          setTimeout(() => location.reload(), 1800);
          return;
        }
        if (e.message === "already_submitted" || e.message === "superseded") { staleReload(e.message); return; }
        toast("Couldn't send that. Check your connection and try again.");
      }
    }

    wrap.addEventListener("click", (e) => {
      const shot = e.target.closest(".sb-shot");
      if (shot) {
        const it = byId(shot.closest("[data-id]").dataset.id);
        openLightbox(ctx, g.items.slice(), Math.max(0, g.items.indexOf(it)), shot);
        return;
      }
      const b = e.target.closest("[data-sb]");
      if (!b || b.disabled) return;
      const a = b.dataset.sb;
      const li = b.closest("[data-id]");
      const it = li && byId(li.dataset.id);
      if (a === "edit") openNote(it);
      else if (a === "cancel") {
        // typed words don't vanish on one tap
        const ta = li.querySelector("textarea");
        if (ta && ta.value.trim() !== (ta.dataset.saved || "") && !b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Discard changes?"; return; }
        store.set(draftKey(it.id), null);
        closeNote(it);
      } else if (a === "remove") {
        if (!b.dataset.sure) {
          b.dataset.sure = "1";
          b.textContent = "Yes, remove it";
          clearTimeout(b._t);
          b._t = setTimeout(() => { if (b.isConnected && b.dataset.sure) { delete b.dataset.sure; b.textContent = "Remove"; } }, 4000);
          return;
        }
        saveNote(it, "");
      } else if (a === "goto") {
        const ta = wrap.querySelector(".sb-form textarea");
        if (ta) { ta.closest(".sb-frame").scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" }); ta.focus({ preventScroll: true }); }
      } else if (a === "next") {
        const nx = body.querySelectorAll(".sb-scene")[ctx.scene + 1];
        (nx || body.querySelector(".sb-end")).scrollIntoView({ block: nx ? "start" : "end", behavior: reduced() ? "auto" : "smooth" });
      } else if (a === "review") {
        ctx.confirming = true;
        renderBar();
        // a second tap lands where the first one did: Yes wakes up after a beat, and focus starts on Keep reviewing
        const yes = wrap.querySelector(".sb-bar [data-sb='send']");
        yes.classList.add("sb-wait");
        setTimeout(() => yes.classList.remove("sb-wait"), 650);
        wrap.querySelector(".sb-bar [data-sb='back']")?.focus();
      } else if (a === "back") { ctx.confirming = false; renderBar(); wrap.querySelector(".sb-bar [data-sb='review']")?.focus(); }
      else if (a === "send" && !b.classList.contains("sb-wait")) submitReview();
    });
    wrap.addEventListener("submit", (e) => {
      const f = e.target.closest("[data-note-form]");
      if (!f) return;
      e.preventDefault();
      const it = byId(f.closest("[data-id]").dataset.id);
      if (!f.querySelector("[type=submit]").disabled) saveNote(it, f.querySelector("textarea").value);
    });
    wrap.addEventListener("input", (e) => {
      const ta = e.target.closest(".sb-form textarea");
      if (!ta) return;
      store.set(draftKey(ta.closest("[data-id]").dataset.id), ta.value.trim() !== (ta.dataset.saved || "") ? ta.value : null);
      const c = ta.form.querySelector("[data-sb='cancel'][data-sure]");
      if (c) { delete c.dataset.sure; c.textContent = "Cancel"; }
    });
    wrap.addEventListener("keydown", (e) => {
      const ta = e.target.closest(".sb-form textarea");
      if (!ta) return;
      const it = byId(ta.closest("[data-id]").dataset.id);
      if (e.key === "Escape") {
        e.preventDefault();
        if (ta.value.trim() === (ta.dataset.saved || "")) closeNote(it);
        else toast("Save or cancel this note first.");
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.form.requestSubmit(); }
    });
    return { wrap, ctx };
  }

  async function mount(container, access, opts = {}) {
    V2 = !!opts.v2;
    const none = { openProof: false, delivered: false, picksSent: false, finals: null, videos: 0, proof: null, storyboard: null, unlock: null };
    container.innerHTML = V2
      ? `<div class="g-skel" aria-hidden="true"><i></i><i></i><i></i></div>`
      : `<div class="g-loading hud">LOADING YOUR MEDIA…</div>`;
    let data;
    try {
      data = await call(access, { action: "list" });
    } catch (_) {
      container.innerHTML = `<p class="g-empty">Couldn't load your ${V2 ? "photos" : "media"} right now. Refresh to try again.</p>`;
      return { ...none, error: true };
    }
    let signedAt = Date.now();
    const projects = data.projects || [];
    const byId = new Map();
    projects.forEach((p) => (p.galleries || []).forEach((g) => g.items.forEach((it) => byId.set(it.id, it))));

    // fresh links for a long session, written into the same item objects (thumbs already shown stay put)
    const stale = () => Date.now() - signedAt > RESIGN_AFTER_MS;
    const resign = async () => {
      try {
        const fresh = await call(access, { action: "list" });
        (fresh.projects || []).forEach((p) => (p.galleries || []).forEach((g) => g.items.forEach((f) => {
          const it = byId.get(f.id);
          if (it) { it.url = f.url; it.thumb_url = f.thumb_url; it.download_url = f.download_url; }
        })));
        signedAt = Date.now();
      } catch (_) { /* keep the old links; the viewer still shows the thumbnail */ }
    };

    container.innerHTML = "";
    // storyboards are reviewed in the v2 portal only; the older pages leave them out
    if (!V2) projects.forEach((p) => { p.galleries = (p.galleries || []).filter((g) => g.kind !== "storyboard"); });
    // a storyboard Nelson hasn't sent yet, or one with no frames, isn't shown (the server leaves them out too)
    else projects.forEach((p) => { p.galleries = (p.galleries || []).filter((g) => !sbHidden(g)); });
    const hasAny = projects.some((p) => (p.galleries || []).length);
    if (!hasAny) {
      const custom = typeof opts.emptyHTML === "function" ? opts.emptyHTML(projects[0]) : opts.emptyHTML;
      container.innerHTML = custom || `<p class="g-empty">Nothing here yet. Once we shoot and Nelson uploads, your proofs, edits, and video show up here.</p>`;
      return none;
    }
    const multi = projects.length > 1;
    let openProof = false, delivered = false, picksSent = false, videos = 0, proof = null, finalCtx = null, storyboard = null, unlock = null;
    const finalItems = [];
    const deliverable = (g) => g.kind === "final" || g.kind === "video";
    // what they came for first: proofs waiting on picks or a storyboard to review, then edits + video,
    // then a reviewed storyboard, then proofs already sent (hundreds of photos; the edits shouldn't sit under it)
    const rank = (g) => g.kind === "proof" ? (g.locked ? 3 : 0) : g.kind === "storyboard" ? (g.locked ? 2.5 : 0) : g.kind === "final" ? 1 : 2;
    projects.forEach((p) => {
      if (!(p.galleries || []).length) return;
      if (multi) {
        const h = document.createElement("h2");
        h.className = "g-project-title";
        h.textContent = p.title || p.client_name;
        container.appendChild(h);
      }
      const gotEdits = p.galleries.some((g) => deliverable(g) && g.items.length);
      // a newer review replaces an older one of the same kind (storyboard or location); the older round folds away
      const purposeOf = (g) => g.purpose || "storyboard";
      const latestOf = {};
      p.galleries.filter((g) => g.kind === "storyboard").forEach((g) => { latestOf[purposeOf(g)] = g; });
      p.galleries.forEach((g) => {
        // once picks are sent, show just the chosen ones (a proof set can be hundreds of photos)
        if (g.kind === "proof") g.all = g.items.slice();
        if (g.kind === "proof" && g.locked && g.items.some((i) => i.selected)) {
          g.items = g.items.filter((i) => i.selected);
          g.picksOnly = true;
        }
        g.delivered = gotEdits;
      });
      p.galleries.slice().sort((a, b) => rank(a) - rank(b)).forEach((g) => {
        if (g.kind === "storyboard") {
          const superseded = g !== latestOf[purposeOf(g)];
          const { wrap } = storyboardBlock(access, p, g, resign, stale, { ...opts, superseded });
          if (!superseded) {
            const sb = { el: wrap, count: g.items.length, notes: sbNotes(g), payUrl: safePay(g.pay_url), purpose: purposeOf(g),
              reviewedAt: g.reviewed_at || "", state: !g.locked ? "open" : g.review_outcome === "approved" ? "approved" : "changes" };
            // the hero follows the review waiting on her; with none open, the latest one reviewed
            if (!storyboard || (sb.state === "open" && storyboard.state !== "open")
              || (sb.state !== "open" && storyboard.state !== "open" && sb.reviewedAt > storyboard.reviewedAt)) storyboard = sb;
          }
          container.appendChild(wrap);
          return;
        }
        if (deliverable(g) && g.items.length) delivered = true;
        if (g.picksOnly) picksSent = true;
        if (g.kind === "video") videos += g.items.length;
        if (g.kind === "video" && g.unlock && g.items.length && (!unlock || (g.held && !unlock.held))) unlock = { invoiceId: g.unlock.invoice_id, held: !!g.held };
        if (g.kind === "final") finalItems.push(...g.items);
        const block = galleryBlock(access, p, g, resign, stale, opts);
        if (g.kind === "proof" && !g.locked && g.items.length) {
          openProof = true;
          if (!proof) proof = { el: block, count: g.items.length, limit: g.selection_limit };
        }
        if (g.kind === "final" && !finalCtx) finalCtx = { resign, stale };
        container.appendChild(block);
      });
    });
    const finals = finalItems.length ? {
      count: finalItems.length,
      mb: Math.round(finalItems.reduce((s, it) => s + (it.size_bytes || 0), 0) / 1048576),
      // one zip of every edited photo, named after the project (a single photo just downloads)
      download: async (btn) => {
        if (finalItems.length > 1) return zipDownload(finalCtx, finalItems, (projects[0] && projects[0].title) || "Photos", btn);
        if (finalCtx.stale()) await finalCtx.resign();
        location.href = finalItems[0].download_url || finalItems[0].url;
      },
    } : null;
    return { openProof, delivered, picksSent, finals, videos, proof, storyboard, unlock };
  }

  window.BKGallery = { mount };
})();
