/* Taylormade — BOOK · index page */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- real delivered work (YouTube) ---------- */
const FILMS = [
  { id: "QzbYiE_m-iw", title: "Mariah.B — “Bizness”", kind: "MUSIC VIDEO", desc: "Direction, production, and edit. Cinematic storytelling with a bold visual identity." },
  { id: "dN1JEDfNi0k", title: "La Supreme Dallas — Grand Opening", kind: "EVENT FILM", desc: "Brand film and event coverage for a high-profile Dallas launch." },
  { id: "ai6gyONaabA", title: "TONI&GUY Academy", kind: "BRAND CONTENT", desc: "Fashion-forward hair and beauty content for TONI&GUY Academy." },
  { id: "of87wf29ueg", title: "Oribe", kind: "PRODUCT AD", desc: "Premium ad for the luxury hair care brand — visuals matched to a high-end position." },
  { id: "P9gSy5sHEoc", title: "Marviano Cosmetics", kind: "BRAND FILM", desc: "Elevated beauty content blending product showcase with aspirational lifestyle." },
  { id: "5HZQp4vuAyI", title: "It's a Secret Med Spa", kind: "PROMO", desc: "Promotional campaign built on compelling visuals and strategic storytelling." },
];

const STILLS = [
  ["toni-guy-editorial.jpg", "TONI&GUY — editorial"],
  ["fashion-22.jpg", "Fashion — editorial"],
  ["sports-portrait.jpg", "Sports — portrait"],
  ["konjo-1.jpg", "Konjo — campaign"],
  ["beauty-sunglasses.jpg", "Beauty — campaign"],
  ["jordan-footlocker.jpg", "Jordan × Foot Locker"],
  ["fashion-15.jpg", "Fashion — editorial"],
  ["neutrogena-1.jpg", "Neutrogena — product"],
  ["takis-graphic.jpg", "Takis — campaign"],
  ["fashion-30.jpg", "Fashion — editorial"],
  ["goldwell-1.jpg", "Goldwell — product"],
  ["diameco-1.jpg", "Diameco — beauty"],
  ["myx-product.jpg", "MYX — product"],
  ["fashion-38.jpg", "Fashion — editorial"],
  ["jordan-iv.jpg", "Jordan IV — product"],
  ["konjo-2.jpg", "Konjo — campaign"],
];

/* ---------- render films (click-to-play facade) ---------- */
$("#workGrid").innerHTML = FILMS.map((f, i) => `
  <article class="work-card rv" style="transition-delay:${(i % 3) * 70}ms">
    <div class="work-thumb vf" data-yt="${f.id}" role="button" tabindex="0" aria-label="Play: ${esc(f.title)}">
      <span class="vf-b"></span>
      <img loading="lazy" src="https://i.ytimg.com/vi/${f.id}/hqdefault.jpg" alt="${esc(f.title)}">
      <span class="play"><b></b></span>
    </div>
    <div class="work-info">
      <span class="hud">${f.kind}</span>
      <h3>${esc(f.title)}</h3>
      <p>${esc(f.desc)}</p>
    </div>
  </article>`).join("");

function playVideo(el) {
  const id = el.dataset.yt;
  el.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" title="Video player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
}
$("#workGrid").addEventListener("click", (e) => {
  const t = e.target.closest(".work-thumb[data-yt]");
  if (t) playVideo(t);
});
$("#workGrid").addEventListener("keydown", (e) => {
  const t = e.target.closest(".work-thumb[data-yt]");
  if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); playVideo(t); }
});

/* ---------- render stills ---------- */
$("#stillStrip").innerHTML = STILLS.map(([f, cap]) => `
  <figure><img loading="lazy" src="assets/img/${f}" alt="${esc(cap)}"><figcaption>${esc(cap)}</figcaption></figure>`).join("");

/* ---------- nav ---------- */
$("#burger").addEventListener("click", () => document.body.classList.toggle("menu-open"));
$$("#navLinks a").forEach((a) => a.addEventListener("click", () => document.body.classList.remove("menu-open")));

/* ---------- marquee: duplicate track for seamless loop ---------- */
const track = $("#marqueeTrack");
track.innerHTML += track.innerHTML;

/* ---------- timecode ticker ---------- */
const t0 = performance.now();
setInterval(() => {
  const ms = performance.now() - t0;
  const f = Math.floor((ms % 1000) / 41.7), s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  $("#timecode").textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}, 120);

/* ---------- reveal on scroll ---------- */
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}), { threshold: 0.12 });
$$(".rv").forEach((el) => io.observe(el));

$("#year").textContent = new Date().getFullYear();

/* ============================================================
   booking wizard
   ============================================================ */
const state = { step: 1, service: null };
const LABELS = { 1: "THE SHOOT", 2: "THE DETAILS", 3: "CONTACT" };

function showStep(n) {
  state.step = n;
  $$(".bstep").forEach((f) => f.classList.toggle("active", +f.dataset.step === n));
  $("#stepNow").textContent = `0${n}`;
  $("#stepLabel").textContent = LABELS[n];
  $("#stepBar").style.transform = `scaleX(${n / 3})`;
  $("#bookForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#svcPick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  $$("#svcPick button").forEach((x) => x.classList.remove("sel"));
  b.classList.add("sel");
  state.service = b.dataset.v;
  $("#next1").disabled = false;
});

$("#next1").addEventListener("click", () => showStep(2));
$("#next2").addEventListener("click", () => showStep(3));
$$("[data-back]").forEach((b) => b.addEventListener("click", () => showStep(state.step - 1)));

$("#bookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#bookErr");
  err.textContent = "";
  const name = $("#fName").value.trim();
  const email = $("#fEmail").value.trim();
  if (!name) { err.textContent = "Drop your name so I know who I'm talking to."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "That email doesn't look right — double-check it."; return; }

  const btn = $("#submitBtn");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const r = await BK.rpc("bk_submit_inquiry", {
      p_name: name,
      p_email: email,
      p_service: state.service,
      p_phone: $("#fPhone").value.trim() || null,
      p_company: $("#fCompany").value.trim() || null,
      p_event_date: $("#fDate").value || null,
      p_location: $("#fLocation").value.trim() || null,
      p_budget: $("#fBudget").value || null,
      p_details: $("#fDetails").value.trim() || null,
      p_source: $("#fSource").value || null,
    });
    const url = `${location.origin}${location.pathname.replace(/index\.html$/, "").replace(/\/$/, "")}/portal.html?p=${r.id}&t=${r.token}`;
    $("#portalLink").textContent = url;
    $("#portalLink").href = url;
    $("#portalBtn").href = url;
    $("#bookForm").hidden = true;
    $("#bookDone").hidden = false;
  } catch (ex) {
    err.textContent = "Something glitched on send. Try again, or just DM me @taylormade_creative.";
    btn.disabled = false;
    btn.textContent = "Send it";
  }
});
