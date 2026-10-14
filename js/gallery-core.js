/* Taylormade — BOOK · shared gallery renderer
 * Used by both the token portal (portal.html) and the logged-in hub (gallery.html).
 * Talks only to the bk-media edge function; no direct DB/storage access.
 *
 *   BKGallery.mount(containerEl, access) → Promise<{ openProof: boolean, delivered: boolean }>
 *     access = { mode:"token", project_id, token }
 *           | { mode:"session", jwt }        // Supabase access_token
 */
(function () {
  const esc = (s) =>
    (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KIND_LABEL = { proof: "Proofing", final: "Edited photos", video: "Video" };
  const RESIGN_AFTER_MS = 90 * 60 * 1000; // signed URLs live 2h; refresh well before that

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
    toastEl._h = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  const pickedCount = (g) => g.items.filter((i) => i.selected).length;
  const canPick = (g) => g.kind === "proof" && !g.locked;

  /* ---------------- picking (shared by grid + lightbox) ---------------- */
  async function setPick(ctx, it, want) {
    const { g } = ctx;
    if (!canPick(g) || it.selected === want) return;
    const lim = g.selection_limit;
    if (want && lim != null && pickedCount(g) >= lim) {
      toast(`That's ${lim} picks, the max. Unpick one to swap it.`);
      return;
    }
    it.selected = want; // optimistic
    syncPick(ctx, it);
    try {
      await call(ctx.access, { action: "toggle_select", item_id: it.id, selected: want });
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
      const b = cell.querySelector(".g-pick");
      if (b) b.setAttribute("aria-pressed", it.selected ? "true" : "false");
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
        <button class="g-lb-close" aria-label="Close viewer">&#10005;</button>
      </div>
      <div class="g-lb-stage">
        <button class="g-lb-nav prev" aria-label="Previous photo">&#8249;</button>
        <img alt="">
        <button class="g-lb-nav next" aria-label="Next photo">&#8250;</button>
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
      if (e.target.closest(".g-lb-pick")) {
        const it = lb.list[lb.i];
        if (it) setPick(lb.ctx, it, !it.selected);
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
      else if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && canPick(lb.ctx.g)) {
        const it = lb.list[lb.i];
        if (it) setPick(lb.ctx, it, !it.selected);
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
      const cell = it && ctx.wrap.querySelector(`.g-cell[data-id="${it.id}"]`);
      const target = (cell && !cell.hidden && cell.querySelector(".g-open")) || lb.returnFocus;
      if (target) {
        target.focus({ preventScroll: true });
        target.closest(".g-cell")?.scrollIntoView({ block: "nearest" });
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
    lb.el.querySelector(".g-lb-count").textContent = `${i + 1} / ${list.length}`;
    lb.el.querySelector(".g-lb-name").textContent = it.filename || "";
    img.alt = `Photo ${i + 1} of ${list.length}`;

    // show the cached thumbnail instantly, then swap in the full image
    if (img.dataset.id !== it.id) {
      img.dataset.id = it.id;
      img.src = it.thumb_url || it.url;
      if (it.thumb_url && it.url) {
        const full = new Image();
        full.onload = () => { if (img.dataset.id === it.id) img.src = it.url; };
        full.src = it.url;
      }
      // warm the neighbours so arrowing through feels instant
      [1, -1].forEach((d) => {
        const n = list[(i + d + list.length) % list.length];
        if (n && n.url) new Image().src = n.url;
      });
    }

    const bar = lb.el.querySelector(".g-lb-bar");
    if (g.kind === "proof") {
      const n = pickedCount(g), lim = g.selection_limit;
      const tally = `${n}${lim != null ? ` of ${lim}` : ""} picked`;
      if (g.locked) {
        bar.innerHTML = `<span class="g-lb-tally">${it.selected ? "✓ One of your picks" : "Picks sent"} · ${tally}</span>`;
      } else {
        bar.innerHTML = `
          <button class="g-lb-pick${it.selected ? " on" : ""}" aria-pressed="${it.selected ? "true" : "false"}">
            ${it.selected ? "&#10003; Picked" : "Pick this photo"}
          </button>
          <span class="g-lb-tally">${tally}<span class="g-lb-hint"> · press P to pick, arrows to browse</span></span>`;
      }
    } else if (it.download_url) {
      bar.innerHTML = `<a class="btn btn-gold g-lb-dl" href="${esc(it.download_url)}">Download</a>`;
    } else {
      bar.innerHTML = "";
    }
  }

  /* ---------------- gallery block ---------------- */
  function galleryBlock(access, project, g, resign, stale) {
    const wrap = document.createElement("section");
    wrap.className = "g-block";
    const ctx = { access, g, wrap, filter: "all", confirming: false, resign, stale };

    const lim = g.selection_limit;
    const intro = g.kind !== "proof" || !g.items.length ? ""
      : g.locked ? ""
      : `<p class="g-intro">Tap any photo to see it big. ${lim != null
          ? `Pick up to <b>${lim}</b> for editing`
          : "Pick your favorites for editing"}, then send them to Nelson.</p>`;

    const head = document.createElement("div");
    head.className = "g-block-head";
    head.innerHTML = `
      <div>
        <div class="hud"><span class="tick">●</span> ${esc(KIND_LABEL[g.kind] || g.kind)}</div>
        <h3>${esc(g.title)}</h3>
        ${intro}
      </div>`;
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
        card.innerHTML = `
          <video controls preload="metadata" playsinline src="${esc(it.url)}"></video>
          <div class="g-video-row">
            <span class="g-fn">${esc(it.filename || "Video")}</span>
            <a class="btn btn-gold g-dl" href="${esc(it.download_url || it.url)}">Download</a>
          </div>`;
        list.appendChild(card);
      });
      wrap.appendChild(list);
      return wrap;
    }

    // proof: All / Picked filter
    if (g.kind === "proof") {
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
    grid.className = "g-grid";
    g.items.forEach((it, idx) => {
      const cell = document.createElement("figure");
      cell.className = "g-cell" + (it.selected ? " sel" : "");
      cell.dataset.id = it.id;
      const n = idx + 1;
      cell.innerHTML = `
        <button class="g-open" aria-label="View photo ${n}${it.filename ? ` (${esc(it.filename)})` : ""}">
          <img loading="lazy" decoding="async" src="${esc(it.thumb_url || it.url)}" alt="">
        </button>` +
        (g.kind === "proof"
          ? (g.locked ? "" : `<button class="g-pick" aria-pressed="${it.selected ? "true" : "false"}" aria-label="Pick photo ${n}"><span>&#10003;</span></button>`)
          : `<a class="g-cell-dl" href="${esc(it.download_url || it.url)}" aria-label="Download photo ${n}">&#8595;</a>`);
      grid.appendChild(cell);
    });
    grid.addEventListener("click", (e) => {
      const cell = e.target.closest(".g-cell");
      if (!cell) return;
      const it = g.items.find((x) => x.id === cell.dataset.id);
      if (!it) return;
      if (e.target.closest(".g-pick")) { setPick(ctx, it, !it.selected); return; }
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
        else if (e.target.closest(".g-send")) submitPicks(ctx);
        else if (e.target.closest(".g-showpicks")) { ctx.filter = "picked"; renderTools(ctx); applyFilter(ctx); wrap.scrollIntoView({ block: "start" }); }
      });
      renderSelbar(ctx);
    }
    return wrap;
  }

  const visibleItems = (ctx) => ctx.filter === "picked" ? ctx.g.items.filter((i) => i.selected) : ctx.g.items.slice();

  function renderTools(ctx) {
    const tools = ctx.wrap.querySelector(".g-tools");
    if (!tools) return;
    const n = pickedCount(ctx.g);
    tools.innerHTML = `
      <button data-filter="all" aria-pressed="${ctx.filter === "all"}">All <span>${ctx.g.items.length}</span></button>
      <button data-filter="picked" aria-pressed="${ctx.filter === "picked"}">Picked <span>${n}</span></button>`;
  }

  function applyFilter(ctx) {
    const picked = ctx.filter === "picked";
    let shown = 0;
    ctx.wrap.querySelectorAll(".g-cell").forEach((cell) => {
      const hide = picked && !cell.classList.contains("sel");
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
    if (g.locked) {
      bar.classList.remove("live");
      bar.innerHTML = `<span class="pill green">Picks sent ✓ &nbsp;${n} chosen</span>
        <span class="g-selnote">Nelson is editing your picks. Final images land in “Edited photos”.</span>`;
      return;
    }
    bar.classList.toggle("live", n > 0);
    if (ctx.confirming && n > 0) {
      bar.innerHTML = `
        <span class="g-confirm">Send these ${n} to Nelson? You can't change picks after.</span>
        <span class="g-actions">
          <button class="btn btn-ghost g-cancel">Keep picking</button>
          <button class="btn btn-gold g-send">Yes, send ${n}</button>
        </span>`;
      return;
    }
    ctx.confirming = false;
    bar.innerHTML = `
      <span class="g-count">${n}${lim != null ? ` of ${lim}` : ""} picked</span>
      <span class="g-actions">
        ${n ? `<button class="btn btn-ghost g-showpicks">Review picks</button>` : ""}
        <button class="btn btn-gold g-submit"${n < 1 ? " disabled" : ""}>Send ${n ? n + " " : ""}pick${n === 1 ? "" : "s"} to Nelson</button>
      </span>`;
  }

  async function submitPicks(ctx) {
    const { g, wrap } = ctx;
    const btn = wrap.querySelector(".g-send");
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    try {
      const r = await call(ctx.access, { action: "submit_selections", gallery_id: g.id });
      g.locked = true;
      ctx.confirming = false;
      wrap.querySelectorAll(".g-pick").forEach((b) => b.remove());
      wrap.querySelector(".g-intro")?.remove();
      renderSelbar(ctx);
      toast(`Sent ${r.count} pick${r.count === 1 ? "" : "s"} to Nelson.`);
    } catch (err) {
      if (err.message === "already_submitted") {
        g.locked = true; ctx.confirming = false;
        wrap.querySelectorAll(".g-pick").forEach((b) => b.remove());
        renderSelbar(ctx);
        toast("These picks were already sent.");
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = `Yes, send ${pickedCount(g)}`; }
      toast("Couldn't send. Try again.");
    }
  }

  async function mount(container, access) {
    container.innerHTML = `<div class="g-loading hud">LOADING YOUR MEDIA…</div>`;
    let data;
    try {
      data = await call(access, { action: "list" });
    } catch (_) {
      container.innerHTML = `<p class="g-empty">Couldn't load your media right now. Refresh to try again.</p>`;
      return { openProof: false, delivered: false };
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
    const hasAny = projects.some((p) => (p.galleries || []).length);
    if (!hasAny) {
      container.innerHTML = `<p class="g-empty">Nothing here yet. Once we shoot and Nelson uploads, your proofs, edits, and video show up here.</p>`;
      return { openProof: false, delivered: false };
    }
    const multi = projects.length > 1;
    let openProof = false, delivered = false;
    // what they came for first: proofs waiting on picks, then edits + video, then proofs already sent
    // (a sent proof set can be hundreds of photos; the edits shouldn't sit under it)
    const rank = (g) => g.kind === "proof" ? (g.locked ? 3 : 0) : g.kind === "final" ? 1 : 2;
    projects.forEach((p) => {
      if (!(p.galleries || []).length) return;
      if (multi) {
        const h = document.createElement("h2");
        h.className = "g-project-title";
        h.textContent = p.title || p.client_name;
        container.appendChild(h);
      }
      p.galleries.slice().sort((a, b) => rank(a) - rank(b)).forEach((g) => {
        if (g.kind === "proof" && !g.locked && g.items.length) openProof = true;
        if (g.kind !== "proof" && g.items.length) delivered = true;
        container.appendChild(galleryBlock(access, p, g, resign, stale));
      });
    });
    return { openProof, delivered };
  }

  window.BKGallery = { mount };
})();
