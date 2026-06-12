# DESIGN.md — TAYLORMADE/BOOK

## Register and strategy
Brand register (index). Aesthetic: **"Viewfinder" cinematic HUD futurism**. A camera operator's world: near-black surface, warm white type, one gold. Committed color strategy: gold carries identity moments (CTAs, brackets, the digitals band) on a near-black field; never floods body copy. Film grain overlay, viewfinder corner brackets, ticking timecode, REC pulse, filmstrip sprockets.

## Color (OKLCH-minded; never #000/#fff)
- `--bg` #08080a, `--bg-2` #0e0e12, `--bg-3` #15151b (blue-black, warm-tinted)
- `--text` #f4f1ea warm white; `--muted` #a09c91; `--faint` #6d6a62
- `--gold` #e9b949 (deep #c2922a); `--green` #57d9a3 paid; `--red` #ff5c5c REC/errors only
- Gold on black >= 8:1 contrast. Solid gold for emphasis (no gradient text).

## Type
- Display: **Unbounded** 700/800, uppercase, tight leading. Hero clamps to ~7vw.
- Body/UI: **Familjen Grotesk** 400-700, body capped ~60ch.
- HUD microtype: **Martian Mono** 400/500, 0.55-0.65rem, 0.2em tracking, uppercase. Used for eyebrows, timecodes, captions, labels only.

## Motion (Emil-calibrated)
- transform/opacity only; ease `cubic-bezier(.23,1,.32,1)`; UI under 320ms; no bounce.
- GSAP + ScrollTrigger for scroll choreography: pinned filmstrip horizontal scrub, hero parallax, staggered reveals, process line draw. ALL gated behind `prefers-reduced-motion: no-preference` and killed on mobile where they fight touch scrolling.
- Custom cursor (gold dot + trailing ring) desktop-with-fine-pointer only. Magnetic pull on primary CTAs, max 6px translate.
- Micro: scale 0.97 on press, underline wipes, REC pulse, marquee pauses on hover.

## Layout
- Full-bleed sections, varied vertical rhythm (process tighter, work looser, digitals band loud).
- Filmstrip rail with sprocket borders for stills; lightbox on click with HUD caption.
- Asymmetric service rows (number / copy / tags), not card grids.
- Mobile-first: single column under 900px, filmstrip becomes swipe rail, scrub effects disabled.

## Banned (plus impeccable's bans)
Public pricing except the $100 digitals flat rate. Supplier names. Street addresses. Fake scarcity or invented stats. Purple gradients, glassmorphism, hero-metric template, identical card grids, side-stripe borders, gradient text, em dashes in copy.
