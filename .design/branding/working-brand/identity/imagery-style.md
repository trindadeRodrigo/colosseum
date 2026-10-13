# Imagery Style
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01 | Enriched: 2026-10-01 (`/gsp-visuals --imagery --enrich`) | Revised 2026-10-08 on `IDENTITY-2` (docs/GATES.md): wood in daylight replaces wood in the studio; renders sit on `night` with the honey glow; drawings use the text colour, honey and chalk

**Governing image (2026-10-08):** the daylight timber interior with the forest in the window (`../patterns/prototypes/assets/closing.jpg` in the prototype; a licensed or own photograph before anything goes public). Honey, amber, leaf and sky are all in it, and the palette is sampled from it. The black-studio shot of two species a moment before they lock stays as a *subject* (the pre-lock moment, the pin), not as the colour reference: renders of it are lit warm and placed on the cool `night` ground with the honey glow, so the two temperatures do the work the two species used to do.

**Principle (archetype.md):** joinery means *you can see how it works*. A beautiful image that explains nothing fails the brand. There are three image modes, each with one job:

| Mode | Job | Where |
|---|---|---|
| **Material**: photographs and 3D renders of real joints | *It holds*: material truth, warmth, craft | Marketing, video, social, consumer hero, partner deck |
| **Drawing**: 2D exploded views and orthographic line drawings | *Here's why it holds*: structural truth | Product UI, docs, explanations, video overlays |
| **Structure**: lattice patterns | *It's measured*: grid, rhythm | Marketing section grounds only (P1); the hatch for MOCK |

**On the mood board:** discover/ said "no 3D renders". The founder has since asked for them, and that wins on one condition: **renders must be material-real** (real species, real end grain, real light, real joint geometry). If a render could be mistaken for a crypto 3D asset (glass, chrome, floating, glowing, impossible geometry), it fails. **One model, two outputs:** every joint is modelled once in Blender, and both the renders and the 2D drawings come from that one model, so a drawing and a photo of the same joint always agree.

---

## 1. The joint set: five joints, five jobs

| # | Joint | Role in the brand | Product moment |
|---|---|---|---|
| **J1** | **Pinned through-tenon** (mortise, tenon and pin, *komisen*). The governing image | **Logo, plan, provenance.** **Mortise** = the goal's shape (constraint sheet). **Tenon** = the plan cut to fit it. **Pin** = the source that holds each number | Goal → plan → lock. The pin glyph on every figure |
| **J2** | **Half-lap cross** (two members notched halfway so they lie flush) | **Structure and measurement.** The unit cell of every lattice | Layout grid, Bearing heatmap, loading |
| **J3** | **Sliding dovetail, dropped in** (*ari-otoshi*: in from above, out along the same axis) | **The exit plan.** The way out is the way in, reversed, designed first | "Access to cash", exit-plan drawing |
| **J4** | **Keyed scarf splice** (*kanawa tsugi*: a section replaced while the building stands, locked by a driven key) | **Rebalance.** One section replaced while the structure carries load | Activity log hero, rebalance explanation |
| **J5** | **Bracket set** (*masugumi*: stacked blocks and arms carrying the eaves) | **Bearing.** Load through many small pieces; capacity measured, not assumed | Bearing hero, docs cover, risk deck |

**Not in the set:** decorative furniture dovetails, puzzle boxes, jigsaws, LEGO studs, screws, nails, glue, and any joint we can't name and explain in one sentence. Every joint shown is one of J1–J5.

---

## 2. Material mode: photography and 3D

### Photography (real joints)
| Element | Night ground (the pre-lock still, renders) | Daylight (the governing register) |
|---|---|---|
| **Set** | Black velvet, 1.5 m clear behind the subject. Subject on a black acrylic riser. In post the ground is lifted to `night` #0C0D12 with a warm glow upper right so it matches the UI | Real timber interiors in daylight, the structure framing a view (the governing image); or an unbleached card sweep (≈ #EFE7D9, grading to `paper` #F7F5F0) for product stills |
| **Key** | One small softbox (≈ 30 × 60 cm) with a 40° grid, upper left: ≈ 45° azimuth, 50° elevation, 0.8–1 m from subject. Tungsten-balanced LED, 3,200–3,600 K. Raking enough to show saw marks on end grain | Large overhead diffuser (≥ 1 × 1 m) or north window on an overcast day, 5,000–5,600 K |
| **Fill** | White card or V-flat camera right, ≈ 3 stops under the key. No rim, no kicker, no coloured gel | Bounce card camera right, ≈ 1.5 stops under. Soft contact shadow kept |
| **Camera** | 90–105 mm macro, tripod, tethered. ISO 100, f/8–f/11, **focus-stacked** (5–9 frames) so the whole joint is sharp and the pin is crisp. Colour checker in the first frame of each setup | Same |
| **Shot list** | J1 apart (≈ 15 mm), J1 locked, J1 pin half in · J2 pair apart and flush · J3 lifted 20 mm on its axis · J4 key half-driven · one macro of each species' end grain | J1 locked (light pages), J3 lifted |

- **Subject rules:** pieces are shown **apart a moment before they lock** and **locked**. Secondary subjects: daylight timber interiors where the structure **frames a view** (photo9 logic). Hands only when measuring, fitting or sliding a piece; short clean nails, no rings, no jewellery, sleeves out of frame. Never faces, phones, handshakes, piggy banks or couples.
- **Grade:** warm, white balance to the checker, then +5 to +10 saturation on the wood so it reads as honey and amber, never muddy. No teal-orange, no vignette, no added grain, no clarity/texture sliders above +10. Retouch dust and fibres only; never fill gaps or "fix" the fit (a photo that lies about the fit breaks the brand).
- **Licensing:** master.jpg, the Kuma photographs and the temple brackets are **mood only, not for use**. Shipped photography is our own or licensed, with the licence on file next to the asset (§6).

### 3D (Blender 4.x, Cycles)
| Element | Spec |
|---|---|
| **Units and geometry** | Metric, mm (unit scale 0.001). Real proportions: post 45 × 45, rail 45 × 60, tenon ≈ ⅓ of rail thickness, pin Ø 9. Built from boxes + booleans, then applied. Edges: Bevel modifier 0.4 mm, 2 segments, angle-limited (never a chamfered-chassis look). Zero gap when locked; 0.1 mm clearance only to stop z-fighting |
| **Species** | Pale: **hinoki** (or spruce/cypress), fine straight grain, satin and slightly translucent, lit so it reads as `wood` #E9C48E to honey. Dark: warm mid-brown hardwood (**keyaki, cherry or sapele**) toward `wood-deep` #B9803F, open grain visible. **The pin is always the other species** from the member it passes through |
| **Materials** | Principled BSDF, roughness 0.45–0.55, specular default, no coat. Hinoki subsurface weight 0.03, radius scaled to mm. CC0 scans (Poly Haven / ambientCG) at real-world scale (hinoki growth rings 1–3 mm apart). **End grain is a separate material** on end faces (box-projected ring texture), never stretched side grain. Bump from the grain map at 0.1–0.2; no displacement |
| **Light (night)** | Area light 0.3 × 0.6 m, upper left, ≈ 45° azimuth / 50° elevation, 3,400 K via Blackbody. Fill: 2 × 2 m area camera right, ≈ 3 stops under, neutral. World strength 0; the ground plate is `night` #0C0D12 and the honey glow is added in comp (never a coloured light on the wood). No rim, no bloom, no volumetrics |
| **Light (day)** | Sweep plane in `paper` tone with a curved back, or an HDRI of an overcast forest edge. One 2 × 2 m area overhead, 5,200 K, plus a weak camera-right bounce. Contact shadows soft but present |
| **Camera** | 3/4 from above: ≈ 30° elevation, 30–40° azimuth, 85–100 mm. Orthographic camera for technical stills. f/5.6–f/8 equivalent, focus on the pin |
| **Render** | 512 samples (stills 1,024), OpenImageDenoise, AgX "Medium High Contrast", Filmic as fallback. Output 16-bit EXR multilayer (beauty, AO, cryptomatte) → graded → 16-bit PNG master. Motion blur on (shutter 0.5) for animation |
| **Motion** | **Single axis, one piece at a time.** Slide, decelerate, **seat**; then the pin or key enters. F-curves hand-set to match `cubic-bezier(0.2,0,0,1)`, no overshoot handles. No bounce, spin, orbit or particles. Camera static, or push-in ≤ 3% |
| **Never** | Glass, chrome, metal fasteners, gloss lacquer, floating debris, depth fog, coins, embossed logos, kanji marks |

**Image provenance (our rule applied to ourselves):** renders are credited as renders and never captioned or implied to be photographs. Generative-AI images are for **internal concepting only, never shipped**: they invent impossible joints.

---

## 3. Drawing mode: 2D exploded views and orthographic drawings

| Convention | Rule |
|---|---|
| **Source** | Line art comes from the Blender model: Grease Pencil **Line Art** modifier (orthographic or 30° axonometric camera) → SVG export → cleaned in Figma or code to the weights below. Hidden edges come from the Line Art "occlusion" pass, set to dashed |
| **Projection** | Axonometric (30°) for marketing and video. Orthographic (elevation or plan) inside the product |
| **Line weights** (at 1×, non-scaling) | **1.5 px** key member outline · **1 px** visible edges · **0.5 px** (1 px in `hair`) secondary edges, grid, dimensions · **dashed 4/2** hidden edges and projections |
| **Colour** | Lines in `ink` / `text`. The key member in `honey`; secondary members in `wood` / `wood-deep` flat fills; dimension lines and the "today" marker in `chalk` / `chalk-l`. No shading or grain; the only gradient is the honey curve fill on charts |
| **Assembly axis** | Dash-dot centre line along each piece's axis. Exploded pieces sit apart by 1–1.5× member thickness |
| **Dimension lines** | Hairline, 45° architect's ticks, extension lines with a 2 px gap, value in **Plex Mono** above the line. Dimensions = **constraints**: amount, date, exit window |
| **Callouts** | Square tags with number + leader. In the product: leg name · weight · pin glyph |
| **Section hatch** | 45°, hairline in `muted` / `muted-l`, 4 px pitch. **Reserved for MOCK** (and, with the word "stale", stale data). Never decoration, never a real section |
| **Dashed / solid** | Dashed = **projected**. Solid = measured or live |

**Iconography:** owned by `/gsp-icons` (icon-system.md). The pin glyph is a provenance mark, not an icon, and is never reused (logo-directions.md).

---

## 4. The assembly story, mapped to the product flow

One motion vocabulary: pieces move on one axis, seat, then the pin goes in. UI (2D, fast), video (3D, slow), drawings (static, exploded).

| Step | Product | Joint / image | UI motion (2D) | Video (3D) |
|---|---|---|---|---|
| 1 **Goal** | Constraint sheet confirmed | J1 **mortise** empty, dimension lines for amount, date, exit window | Dimension lines draw in (200 ms each, staggered) | The empty mortise, lit, waiting |
| 2 **Pieces cut** | Solver returns legs | Tenons exploded on their axes, one per leg, numbered callouts | Legs fade in at exploded positions (160 ms, 60 ms stagger) | Each leg piece apart, cut faces sharp |
| 3 **Lock** | Plan accepted, executing | Tenons slide in and seat; the **pin** goes in = sources attached | Slide 280–360 ms `--ease-seat`; pin after 100–140 ms over 160 ms | H2 |
| 4 **Exit plan** | "Access to cash" before investing | J3 with lift-out path dashed: "out ≤ 7 days · cost ≤ 0.5%" (illustrative) | Lift-out path draws upward, dashed | Dovetail lifts out and drops back |
| 5 **Rebalance** | Activity: "I moved…" | J4: one section out, re-cut section in, key driven | One leg out, new leg in, log line with explorer link | Splice assembled, key last |

"Why this plan?" reverses step 3 (pieces part 12–24 px, callouts fade in) and closes back to locked. **Reduced motion:** every slide becomes a 120 ms crossfade; the pin appears without travel. **Never:** confetti, counting-up figures, parallax wood, ambient loops, spring physics. UI labels stay plain ("Building your plan", "Rebalanced"), never "cutting" or "joints" (voice-and-tone.md).

**Motion tokens:** `--ease-seat: cubic-bezier(0.2,0,0,1)` · `--dur-slide: 320ms` · `--dur-pin: 160ms` · `--delay-pin: 120ms` · `--dur-fade: 160ms` · `--dur-reduced: 120ms`. Animate `transform` and `opacity` only.

---

## 5. Pattern system: kumiko and lattice as structure

Every pattern is hairline (`line-l` / `line`) only, never honey, so it stays structure, not ornament.

| ID | Pattern | Job | Densities |
|---|---|---|---|
| **P1** | **Square kumiko** (orthogonal half-lap grid, J2) | Layout grid made visible | **Coarse:** cell = 1 column of the 12-col grid, section grounds. **Medium:** 24 px, loading and empty states only. **Fine (8 px): print and video only** (moiré on screen) |
| **P2** | **Stacked offset** (members stepped one unit) | Section ends; hero blocks offset one column | Step = 1 column (marketing), 8 px (docs) | *(retired 2026-10-08, `IDENTITY-2`)*
| **P3** | **Receding grid** (lattice in depth) | Bearing landing hero, video interstitials, deck covers | One density per composition; ≥ 40% of frame empty | *(retired 2026-10-08, `IDENTITY-2`)*
| **P4** | **Section hatch** (45°) | **MOCK and stale only** | 4 px pitch |
| **P5** | **Bracket set** | Bearing imagery only (photo/render). Never a repeat | n/a |

| Surface | P1 coarse | P1 medium | P2 | P3 | P4 |
|---|---|---|---|---|---|
| Marketing | Section grounds | No | Yes | Bearing page only | On MOCK |
| Consumer plan / goal card | No | Loading only | No | No | On MOCK fields |
| API docs | Page margins only | No | Section ends | No | On MOCK examples |
| Partner embed | No | No | No | No | **Always** (survives white-label) |
| Bearing dashboard | No (the heatmap *is* P1, as data) | Loading only | No | Landing only | No-sample cells |
| Video / social | Yes | Yes | Yes | Yes | On any MOCK figure |

**Hard rules:** (1) **Never behind numbers, text, form fields, charts, the provenance popover or the disclaimer**; a pattern stops ≥ 1 grid unit from any figure. (2) Only P4 is diagonal. (3) Banned motifs: asanoha, kikkō (also reads as crypto hex), seigaiha, shippō, sakura, crests, wood-grain wallpaper. (4) Patterns don't move, except the P1-medium loader and video. (5) Density comes from the table, never scaled up for "more texture".

### CSS / SVG recipes
```css
/* P1 square kumiko. Patterns live on a ::before layer of the section, never on a content box. */
.lattice { position: relative; isolation: isolate; --cell: var(--col); --c: var(--tf-line-l); }
[data-theme="dark"] .lattice { --c: var(--tf-line); }
.lattice::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: linear-gradient(to right, var(--c) 1px, transparent 1px),
                    linear-gradient(to bottom, var(--c) 1px, transparent 1px);
  background-size: var(--cell) var(--cell); background-position: var(--grid-origin, 0 0); }
.lattice--medium { --cell: 24px; }               /* loading + empty states only */
.lattice--margins::before {                       /* docs: margins only, centre column clear */
  mask-image: linear-gradient(to right, #000 var(--margin), transparent var(--margin),
              transparent calc(100% - var(--margin)), #000 calc(100% - var(--margin))); }
/* --col = (min(100vw, var(--page-max)) - 2 * var(--margin)) / 12, set once on :root; snap to whole px. */

/* P2 stacked offset: three hairlines 4 px apart, each one step longer, right-aligned. */
.step-rule { --step: var(--col); height: 9px; background:
  linear-gradient(var(--c), var(--c)) right 0   / calc(100% - 2 * var(--step)) 1px no-repeat,
  linear-gradient(var(--c), var(--c)) right 4px / calc(100% - var(--step)) 1px no-repeat,
  linear-gradient(var(--c), var(--c)) right 8px / 100% 1px no-repeat; }

/* P3 receding grid (web): a P1 plane laid back in perspective, fading out. Static. */
.recede { perspective: 900px; overflow: hidden; }
.recede > .plane { height: 140%; transform: rotateX(62deg); transform-origin: 50% 100%;
  mask-image: linear-gradient(to top, #000 10%, transparent 75%); } /* .plane also gets .lattice */

/* P4 hatch = MOCK. Sits in a 6 px gutter band beside the value, never under the digits. */
.mock-band { width: 6px; background: repeating-linear-gradient(45deg,
  var(--stone) 0 1px, transparent 1px 4px); }
```
```svg
<!-- Drawings: hatch and fine kumiko as SVG patterns (fine = print/video exports only) -->
<pattern id="p4-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" stroke-width="0.75"/></pattern>
<pattern id="p1-fine" width="8" height="8" patternUnits="userSpaceOnUse">
  <path d="M8 0H0V8" fill="none" stroke="currentColor" stroke-width="0.5"/></pattern>
```
- **Kumiko with member thickness (video, print, deck covers only):** draw each member as two hairlines 3 px apart and break the crossing lines at half-laps (the vertical passes over on even rows, under on odd), so it reads as wood laid in a lattice, not graph paper. Generate it as SVG from code, never trace a photograph.
- **Enforcement (lint, matches the product's rule culture):** a DOM test fails if any element with `data-pin` or `data-figure` has a `.lattice` / `.recede` ancestor closer than the section, or if P4 appears without the word MOCK or stale within the same component.
- **Loader "the lattice assembles":** a 3 × 3 P1-medium cell as inline SVG: four horizontals slide in on x, then four verticals drop in on y, each 240 ms `--ease-seat`, 60 ms stagger; hold 400 ms, 160 ms crossfade, repeat. Shown only for waits > 400 ms, with a text label ("Building your plan…") and `role="status"`. Reduced motion: static lattice + label.

---

## 6. Image processing and implementation

| Topic | Rule |
|---|---|
| **Masters** | 16-bit PNG/TIFF in sRGB (Display P3 masters allowed, exported to sRGB). Kept with a sidecar `*.provenance.json`: `{ kind: "photo" \| "render", author, licence, source_file, made_at }` |
| **Delivery formats** | AVIF (q ≈ 55) → WebP (q ≈ 78) → JPEG (q ≈ 82) via `next/image` / `<picture>`. `srcset` widths 640, 960, 1280, 1920, 2560, 3600. Strip EXIF/GPS; keep copyright in XMP |
| **Black level** | On `night` UI grounds, map the image's black point to #0C0D12 (RGB 12, 13, 18) so the frame edge disappears. Video and social keep true #000 |
| **Paper level** | Paper-ground images grade the sweep to #F7F5F0 ± 2 so they sit on `paper` with no visible box |
| **Overlays and masks** | **None.** No gradient scrims, duotones, blend modes or blob masks on photos and renders. Text never sits on an image; compositions leave empty ground (H1's left third) and text sits there. Radius 0–2 px, matching cards |
| **Drawings (SVG)** | Inline SVG, `currentColor` + CSS vars so the theme swap is free. `vector-effect: non-scaling-stroke`, `stroke-linecap: square`, `stroke-linejoin: miter`. Hairlines on half-pixels. SVGO keeps `viewBox` and group ids (`#mortise`, `#leg-1…n`, `#pin-n`, `#axis-n`). Figures in drawings are **HTML overlays**, not SVG text, so the pin and provenance popover work and nothing gets a pattern behind it |
| **Theme variants** | Each Material image ships black + paper versions. `<picture>` with `prefers-color-scheme` sources for the system theme; an explicit `[data-theme]` swaps `src` in the client, so only the active variant downloads |
| **Responsive art direction** | ≥ 1024 px: 3:2 with the empty third for text. 640–1023: 16:9, text above. < 640: 1:1 (or 4:5 crop from 1:1), text above, never over. `object-fit: cover` with `object-position` set per asset so the pin is never cropped |
| **Loading** | Reserve space with `aspect-ratio`; placeholder is the flat ground colour of the variant (#0C0D12 or #EFECE5). No blur-up (it reads as fog). Fade in 160 ms. LCP hero: `priority` / `fetchpriority="high"`; everything else lazy |
| **Video** | MP4 H.264 (CRF 20, `+faststart`) + WebM VP9 (CRF 33), `muted playsinline loop`, `preload="metadata"`, poster = H1. Autoplay only when `prefers-reduced-motion: no-preference`; otherwise the poster with a play control. Landing loop ≤ 2 MB at 1080p |
| **Captions and alt** | A small Plex Mono credit under every Material image: "Render · Blender" or "Photo · {author}". Alt text says what the joint does in plain words ("Two pieces of wood, cut to fit, about to lock; a pale pin holds them"), not "beautiful joinery" |

---

## 7. Production for Oct 4: what to make, and how

**Tools, decided.** **Blender (Cycles)** for stills and animation, and Line Art for drawings (J1 model ≈ 3 h). **SVG** (Figma or code) for logo, pin glyph, patterns, drawings and UI motion. **Spline: no** (glossy, toy-like, the category's tool). **three.js in-app: not before Oct 9**; export each joint as GLB (Draco, 2K baked textures, ≤ 1.5 MB) so it's ready. **Photography:** order a two-species J1 sample now; if it arrives before Oct 10, shoot H1 for real (§2) and replace the render.

| Asset | Job | Deliverables | Specs | Done when |
|---|---|---|---|---|
| **H1 "Before it locks"** (still) | Video end card, landing hero, X header, deck cover | 3:2 3600 × 2400 master; crops 1:1 2400, 16:9 3840 × 2160, 9:16 2160 × 3840, OG 1200 × 630, X header 1500 × 500; night + day variants | J1: hardwood rail and hinoki post ≈ 15 mm apart on the tenon axis; hinoki pin already through the tenon end. §2 light, 85 mm, focus on pin and tenon end grain. Left third empty. On night, the honey glow upper right in comp | Pin sharp at 100%; end grain shows rings; no edge clipping; the ground reads as `night`, not neutral black; crops keep the pin ≥ 10% from any edge |
| **H2 "Lock"** (animation) | Video resolution beat, landing loop | 6 s, 24 fps (144 frames), 1080p + 4K; 1:1 and 9:16 social cuts; loop version; poster = frames 1 and 144 | 0–1.0 s hold (H1 framing) → 1.0–2.4 s rail slides ≈ 60 mm, last 4 mm slowest, **seats** → 2.6–3.3 s pin slides down its axis → hold to 6.0 s. Loop: 0.5 s crossfade last → first. No click or ding sound | No overshoot frame; light unchanged across the shot; loop ≤ 2 MB at 1080p; reduced-motion shows poster |
| **H3 "Your plan, exploded"** (SVG) | "Why this plan?", video overlay, docs | Axonometric 1200 × 800 (marketing, video); orthographic 640 × 400 (product); light + dark via `currentColor`; ≤ 12 KB gzipped each | Post with empty mortise, dimensions "$40,000 · June 2028" and exit "≤ 7 days"; three tenons with callouts ① USDY 42% ② Kamino USDC 38% ③ Cash 20%; one leg hatched with the line "sample"; J3 lift-out dashed | Marketing version labelled "Illustrative"; product version binds every value to the plan API (no literal figures in the SVG); groups animate §4 steps 1–3 |
| **H4 "Bearing"** (SVG + render) | Bearing landing, risk deck, video Bearing beat | (a) Heatmap component; (b) J5 still 3600 × 2400 on black + P3 as a separate SVG layer | (a) 24 × 7 cells, 1 px `line` lattice gaps, the night → honey → pale ramp from color-system.md, no-sample cells empty with an en dash and a "no sample" label (the hatch means MOCK), Plex Mono axes, every cell's value reachable with its pin. (b) J5 in warm wood on night, H1 light | Heatmap is data, never a backdrop; no P3 behind the heatmap; render credited "Render · Blender" |

**Next (Oct 5–10, before the video lock):** **H5** J3 exit lift-out and **H6** J4 re-true splice, as SVG animations following §4, drawn from the same Blender models.

---

## Anti-patterns

- **Japanese clichés:** kanji or kana as decoration, torii, ensō brush circles, red hanko seals, sakura, waves, brush-script type, washi-paper texture overlays, "zen" stones, Mt. Fuji. The joinery is the reference; the culture is not a costume.
- **Crypto 3D:** glass, chrome, glow, floating coins, orbiting cameras, particle trails, neon rim light.
- **Woodworking clichés:** furniture dovetails, rustic barn wood, workshop "maker" shots, wood-grain UI backgrounds.
- **Patterns** behind numbers, text or charts; diagonal anything except MOCK hatch; patterns that move outside the loader.
- **Image handling:** gradient scrims, duotones, blur-up, vignettes, text set on an image, a render captioned as a photo, a shipped AI image.

---

## Related
- [color-system.md](./color-system.md) · [typography.md](./typography.md) · [logo-directions.md](./logo-directions.md) · [brand-applications.md](./brand-applications.md) · icon-system.md (from `/gsp-icons --enrich`)
