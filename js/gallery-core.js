/* Taylormade — BOOK · shared gallery renderer
 * Used by both the token portal (portal.html) and the logged-in hub (gallery.html).
 * Talks only to the bk-media edge function; no direct DB/storage access.
 *
 *   BKGallery.mount(containerEl, access)
 *     access = { mode:"token", project_id, token }
 *           | { mode:"session", jwt }        // Supabase access_token
 */
(function () {
  const esc = (s) =>
    (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KIND_LABEL = { proof: "Proofing", final: "Edited photos", video: "Video" };

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
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._h);
    toastEl._h = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  /* lightbox (single shared instance) */
  let lb;
  function lightbox(url, cap) {
    if (!lb) {
      lb = document.createElement("div");
      lb.className = "g-lightbox";
      lb.hidden = true;
      lb.innerHTML = `<button class="g-lb-close" aria-label="Close">&#10005;</button><img alt=""><div class="g-lb-cap hud"></div>`;
      document.body.appendChild(lb);
      lb.addEventListener("click", (e) => { if (e.target === lb || e.target.closest(".g-lb-close")) close(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    }
    function close() { lb.hidden = true; document.body.style.overflow = ""; }
    lb.querySelector("img").src = url;
    lb.querySelector(".g-lb-cap").textContent = cap || "";
    lb.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function galleryBlock(access, project, g) {
    const wrap = document.createElement("section");
    wrap.className = "g-block";
    const selCount = g.items.filter((i) => i.selected).length;

    const head = document.createElement("div");
    head.className = "g-block-head";
    head.innerHTML = `
      <div>
        <div class="hud"><span class="tick">●</span> ${esc(KIND_LABEL[g.kind] || g.kind)}</div>
        <h3>${esc(g.title)}</h3>
      </div>
      <div class="g-block-meta"></div>`;
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

    // proof + final share a grid
    const grid = document.createElement("div");
    grid.className = "g-grid";
    g.items.forEach((it) => {
      const cell = document.createElement("figure");
      cell.className = "g-cell" + (it.selected ? " sel" : "");
      cell.dataset.id = it.id;
      const img = `<img loading="lazy" src="${esc(it.url)}" alt="${esc(it.filename || "")}">`;
      if (g.kind === "proof") {
        cell.innerHTML = img + `<button class="g-pick" aria-label="Select">&#10003;</button>`;
        if (!g.locked) {
          cell.querySelector(".g-pick").addEventListener("click", (e) => {
            e.stopPropagation();
            togglePick(access, g, it, cell, wrap);
          });
        }
        cell.querySelector("img").addEventListener("click", () => lightbox(it.url, it.filename));
      } else {
        cell.innerHTML = img + `<a class="g-cell-dl" href="${esc(it.download_url || it.url)}" aria-label="Download">&#8595;</a>`;
        cell.querySelector("img").addEventListener("click", () => lightbox(it.url, it.filename));
      }
      grid.appendChild(cell);
    });
    wrap.appendChild(grid);

    if (g.kind === "proof") {
      const bar = document.createElement("div");
      bar.className = "g-selbar";
      wrap.appendChild(bar);
      renderSelbar(access, g, wrap);
    }
    return wrap;
  }

  function renderSelbar(access, g, wrap) {
    const bar = wrap.querySelector(".g-selbar");
    if (!bar) return;
    const cells = [...wrap.querySelectorAll(".g-cell")];
    const n = cells.filter((c) => c.classList.contains("sel")).length;
    const lim = g.selection_limit;
    if (g.locked) {
      bar.innerHTML = `<span class="pill green">Selections sent ✓ &nbsp;${n} chosen</span>
        <span class="g-selnote">Nelson is editing your picks. Final images land in “Edited photos”.</span>`;
      return;
    }
    bar.innerHTML = `
      <span class="g-count">${n}${lim != null ? ` / ${lim}` : ""} selected</span>
      <button class="btn btn-gold g-submit"${n < 1 ? " disabled" : ""}>Submit selections</button>`;
    bar.querySelector(".g-submit").addEventListener("click", () => submitPicks(access, g, wrap));
  }

  async function togglePick(access, g, it, cell, wrap) {
    const want = !cell.classList.contains("sel");
    const lim = g.selection_limit;
    const cur = wrap.querySelectorAll(".g-cell.sel").length;
    if (want && lim != null && cur >= lim) {
      toast(`You can pick up to ${lim}. Deselect one first.`);
      return;
    }
    cell.classList.toggle("sel", want); // optimistic
    renderSelbar(access, g, wrap);
    try {
      await call(access, { action: "toggle_select", item_id: it.id, selected: want });
      it.selected = want;
    } catch (err) {
      cell.classList.toggle("sel", !want); // revert
      renderSelbar(access, g, wrap);
      toast(err.message === "limit_reached" ? `Limit is ${lim}.` : "Could not save that pick. Try again.");
    }
  }

  async function submitPicks(access, g, wrap) {
    const btn = wrap.querySelector(".g-submit");
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    try {
      const r = await call(access, { action: "submit_selections", gallery_id: g.id });
      g.locked = true;
      renderSelbar(access, g, wrap);
      wrap.querySelectorAll(".g-pick").forEach((b) => b.remove());
      toast(`Sent ${r.count} pick${r.count === 1 ? "" : "s"} to Nelson.`);
    } catch (_) {
      if (btn) { btn.disabled = false; btn.textContent = "Submit selections"; }
      toast("Could not submit. Try again.");
    }
  }

  async function mount(container, access) {
    container.innerHTML = `<div class="g-loading hud">LOADING YOUR MEDIA…</div>`;
    let data;
    try {
      data = await call(access, { action: "list" });
    } catch (_) {
      container.innerHTML = `<p class="g-empty">Couldn't load your media right now. Refresh to try again.</p>`;
      return;
    }
    const projects = data.projects || [];
    container.innerHTML = "";
    const hasAny = projects.some((p) => (p.galleries || []).length);
    if (!hasAny) {
      container.innerHTML = `<p class="g-empty">Nothing here yet. Once we shoot and Nelson uploads, your proofs, edits, and video show up here.</p>`;
      return;
    }
    const multi = projects.length > 1;
    projects.forEach((p) => {
      if (!(p.galleries || []).length) return;
      if (multi) {
        const h = document.createElement("h2");
        h.className = "g-project-title";
        h.textContent = p.title || p.client_name;
        container.appendChild(h);
      }
      ["proof", "final", "video"].forEach((kind) => {
        p.galleries.filter((g) => g.kind === kind).forEach((g) => {
          container.appendChild(galleryBlock(access, p, g));
        });
      });
    });
  }

  window.BKGallery = { mount };
})();
