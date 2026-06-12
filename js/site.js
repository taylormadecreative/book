/* Taylormade — BOOK · index page (v2: interactive futurism) */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const motionOK = window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
const desktop = () => window.matchMedia("(min-width: 901px)").matches;

/* ---------- real delivered work (YouTube) ---------- */
const FILMS = [
  { id: "QzbYiE_m-iw", title: "Mariah.B — “Bizness”", kind: "MUSIC VIDEO", desc: "Direction, production, and edit. Cinematic storytelling with a bold visual identity." },
  { id: "dN1JEDfNi0k", title: "La Supreme Dallas — Grand Opening", kind: "EVENT FILM", desc: "Brand film and event coverage for a high-profile Dallas launch." },
  { id: "ai6gyONaabA", title: "TONI&GUY Academy", kind: "BRAND CONTENT", desc: "Fashion-forward hair and beauty content for TONI&GUY Academy." },
  { id: "of87wf29ueg", title: "Oribe", kind: "PRODUCT AD", desc: "Premium ad for the luxury hair care brand. Visuals matched to a high-end position." },
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
$("#workGrid").innerHTML = FILMS.map((f) => `
  <article class="work-card" data-anim>
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

/* ---------- render stills + lightbox ---------- */
$("#stillStrip").innerHTML = STILLS.map(([f, cap], i) => `
  <figure data-i="${i}" tabindex="0" role="button" aria-label="View: ${esc(cap)}">
    <img loading="lazy" src="assets/img/${f}" alt="${esc(cap)}"><figcaption>${esc(cap)}</figcaption>
  </figure>`).join("");

const lightbox = $("#lightbox");
function openLightbox(i) {
  const [f, cap] = STILLS[i];
  $("#lightboxImg").src = `assets/img/${f}`;
  $("#lightboxImg").alt = cap;
  $("#lightboxCap").textContent = cap.toUpperCase();
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeLightbox() {
  lightbox.hidden = true;
  document.body.style.overflow = "";
}
$("#stillStrip").addEventListener("click", (e) => {
  const fig = e.target.closest("figure[data-i]");
  if (fig) openLightbox(+fig.dataset.i);
});
$("#stillStrip").addEventListener("keydown", (e) => {
  const fig = e.target.closest("figure[data-i]");
  if (fig && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openLightbox(+fig.dataset.i); }
});
$("#lightboxClose").addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lightbox.hidden) closeLightbox(); });

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

$("#year").textContent = new Date().getFullYear();

/* ---------- custom cursor (desktop fine pointer) ---------- */
if (finePointer && motionOK) {
  const dot = $("#cursorDot"), ring = $("#cursorRing");
  let mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my, seen = false;
  document.addEventListener("mousemove", (e) => {
    mx = e.clientX; my = e.clientY; seen = true;
    dot.style.transform = `translate(${mx}px, ${my}px) translate(-50%, -50%)`;
  }, { passive: true });
  (function loop() {
    rx += (mx - rx) * 0.16;
    ry += (my - ry) * 0.16;
    ring.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`;
    if (!seen) { dot.classList.add("hidden"); ring.classList.add("hidden"); }
    else { dot.classList.remove("hidden"); ring.classList.remove("hidden"); }
    requestAnimationFrame(loop);
  })();
  document.addEventListener("mouseover", (e) => {
    ring.classList.toggle("hot", !!e.target.closest("a, button, .work-thumb, .strip figure, summary"));
  }, { passive: true });
  document.addEventListener("mouseleave", () => { seen = false; });
  document.addEventListener("mouseenter", () => { seen = true; });
}

/* ---------- magnetic CTAs ---------- */
if (finePointer && motionOK) {
  $$("[data-magnetic]").forEach((el) => {
    el.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
      const dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      el.style.transform = `translate(${dx * 6}px, ${dy * 5}px)`;
    });
    el.addEventListener("mouseleave", () => {
      el.style.transition = "transform 0.4s cubic-bezier(0.23, 1, 0.32, 1)";
      el.style.transform = "";
      setTimeout(() => { el.style.transition = ""; }, 400);
    });
  });
}

/* ---------- service hover preview ---------- */
if (finePointer) {
  const preview = $("#svcPreview");
  let px = 0, py = 0, tx = 0, ty = 0, raf = null;
  function move() {
    px += (tx - px) * 0.18;
    py += (ty - py) * 0.18;
    preview.style.left = `${px + 26}px`;
    preview.style.top = `${py - 115}px`;
    raf = requestAnimationFrame(move);
  }
  $$(".svc").forEach((row) => {
    row.addEventListener("mouseenter", () => {
      preview.src = row.dataset.preview;
      preview.classList.add("on");
      if (!raf) { px = tx; py = ty; move(); }
    });
    row.addEventListener("mouseleave", () => {
      preview.classList.remove("on");
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    });
    row.addEventListener("mousemove", (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
  });
}

/* ---------- FAQ height animation ---------- */
$$(".faq-list details").forEach((d) => {
  const body = d.querySelector(".faq-body");
  d.querySelector("summary").addEventListener("click", (e) => {
    if (!motionOK) return; // native toggle
    e.preventDefault();
    if (d.open) {
      const h = body.offsetHeight;
      body.style.height = `${h}px`;
      requestAnimationFrame(() => {
        body.style.transition = "height 0.32s cubic-bezier(0.23, 1, 0.32, 1)";
        body.style.height = "0px";
      });
      body.addEventListener("transitionend", () => {
        d.open = false;
        body.style.height = ""; body.style.transition = "";
      }, { once: true });
    } else {
      d.open = true;
      const h = body.offsetHeight;
      body.style.height = "0px";
      requestAnimationFrame(() => {
        body.style.transition = "height 0.32s cubic-bezier(0.23, 1, 0.32, 1)";
        body.style.height = `${h}px`;
      });
      body.addEventListener("transitionend", () => {
        body.style.height = ""; body.style.transition = "";
      }, { once: true });
    }
  });
});

/* ---------- GSAP scroll choreography ---------- */
function initGsap() {
  if (!window.gsap || !window.ScrollTrigger || !motionOK) {
    // fallback: simple reveal
    const io = new IntersectionObserver((es) => es.forEach((en) => {
      if (en.isIntersecting) { en.target.style.opacity = 1; en.target.style.transform = "none"; io.unobserve(en.target); }
    }), { threshold: 0.1 });
    $$("[data-anim], .step, .svc, .section-head").forEach((el) => io.observe(el));
    return;
  }
  gsap.registerPlugin(ScrollTrigger);

  // hero parallax
  gsap.to("#heroImg", {
    yPercent: 8, scale: 1.06, ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
  gsap.to(".hero-ghost", {
    yPercent: 30, ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });

  // section heads rise
  $$(".section-head").forEach((el) => {
    gsap.from(el, {
      y: 36, opacity: 0, duration: 0.8, ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 84%" },
    });
  });

  // film cards: scale-in stagger
  ScrollTrigger.batch("#workGrid .work-card", {
    start: "top 88%",
    onEnter: (els) => gsap.fromTo(els,
      { y: 44, opacity: 0, scale: 0.96 },
      { y: 0, opacity: 1, scale: 1, duration: 0.7, stagger: 0.08, ease: "power3.out", overwrite: true }),
  });

  // services rows: line-by-line
  $$(".svc").forEach((el) => {
    gsap.from(el, {
      x: -28, opacity: 0, duration: 0.7, ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 88%" },
    });
  });

  // process steps stagger
  ScrollTrigger.batch(".step", {
    start: "top 88%",
    onEnter: (els) => gsap.fromTo(els,
      { y: 30, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.6, stagger: 0.09, ease: "power3.out", overwrite: true }),
  });

  // digitals band: price pop
  gsap.from(".digitals-copy > *", {
    y: 30, opacity: 0, duration: 0.7, stagger: 0.08, ease: "power3.out",
    scrollTrigger: { trigger: ".digitals", start: "top 75%" },
  });
  gsap.from(".digitals-form", {
    y: 40, opacity: 0, duration: 0.8, delay: 0.15, ease: "power3.out",
    scrollTrigger: { trigger: ".digitals", start: "top 75%" },
  });

  // outro ghost drift
  gsap.from(".outro-ghost", {
    yPercent: 24, ease: "none",
    scrollTrigger: { trigger: ".outro", start: "top bottom", end: "bottom top", scrub: true },
  });

  // pinned filmstrip horizontal scrub (desktop only)
  ScrollTrigger.matchMedia({
    "(min-width: 901px)": function () {
      document.documentElement.classList.add("scrub");
      const strip = $("#stillStrip");
      const wrap = $("#stripWrap");
      const dist = () => strip.scrollWidth - wrap.clientWidth + 80;
      gsap.to(strip, {
        x: () => -dist(), ease: "none",
        scrollTrigger: {
          trigger: wrap, start: "top 18%", end: () => `+=${dist()}`,
          pin: true, scrub: 0.6, invalidateOnRefresh: true, anticipatePin: 1,
        },
      });
    },
    "(max-width: 900px)": function () {
      document.documentElement.classList.remove("scrub");
    },
  });
}
if (document.readyState === "complete") initGsap();
else window.addEventListener("load", initGsap);

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

// Enter before step 3 must advance, never submit (implicit-submit guard)
$("#bookForm").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.tagName === "TEXTAREA") return;
  if (state.step < 3) {
    e.preventDefault();
    if (state.step === 1 && !state.service) return;
    showStep(state.step + 1);
  }
});

const LIMITS = [
  ["fName", 120, "Your name is a bit long for the form. Shorten it under 120 characters."],
  ["fPhone", 40, "That phone number looks too long. Keep it under 40 characters."],
  ["fCompany", 160, "The brand name is too long. Keep it under 160 characters."],
  ["fLocation", 240, "Keep the location under 240 characters. You can give me the full rundown in your portal."],
  ["fDetails", 4000, "Love the detail, but keep the vision under 4,000 characters. We'll go deeper in your portal."],
];

$("#bookForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.step !== 3) { showStep(3); return; }
  const err = $("#bookErr");
  err.textContent = "";
  const name = $("#fName").value.trim();
  const email = $("#fEmail").value.trim();
  if (!name) { err.textContent = "Drop your name so I know who I'm talking to."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "That email doesn't look right. Double-check it."; return; }
  for (const [id, max, msg] of LIMITS) {
    if ($("#" + id).value.length > max) { err.textContent = msg; return; }
  }

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

/* ============================================================
   digitals instant booking ($100, priced server-side)
   ============================================================ */
$("#digitalsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#dgErr");
  err.textContent = "";
  const name = $("#dgName").value.trim();
  const email = $("#dgEmail").value.trim();
  if (!name) { err.textContent = "Drop your name first."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "That email doesn't look right."; return; }

  const btn = $("#dgBtn");
  btn.disabled = true;
  btn.textContent = "Booking…";
  try {
    const r = await BK.rpc("bk_book_digitals", {
      p_name: name,
      p_email: email,
      p_phone: $("#dgPhone").value.trim() || null,
      p_event_date: $("#dgDate").value || null,
    });
    const url = `${location.origin}${location.pathname.replace(/index\.html$/, "").replace(/\/$/, "")}/portal.html?p=${r.id}&t=${r.token}`;
    location.href = url; // straight to the portal, where the $100 invoice is waiting
  } catch (ex) {
    err.textContent = "Booking glitched. Try again, or DM me @taylormade_creative.";
    btn.disabled = false;
    btn.textContent = "Book digitals — $100";
  }
});
