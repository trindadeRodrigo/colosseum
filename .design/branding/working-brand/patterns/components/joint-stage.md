# Joint stage (pinned hero)
> Type: custom | Component: `<JointStage>` | Source: landing prototype `.stage` / `.sticky` / `#scene` (three.js)

The landing hero: the through-tenon joint (post, rail, pin in hardwood and hinoki) sits pinned behind the copy and **seats as you scroll steps 01–03**, then the stage releases and scrolls away with the page. It is the brand's lock animation (H2) driven by the reader, not by a timer.

## Anatomy

```
section.stage
├─ .sticky  (position: sticky; top: 0; height: 100svh; margin-bottom: -100svh; overflow: hidden)
│   └─ <canvas> 3D joint  |  <img>/<svg> 2D fallback       (aria-hidden)
└─ .stage-content (over the sticky layer, page grid)
    ├─ hero:   h1 (Newsreader, the screen's one serif line) + tagline + static scroll cue
    ├─ step 01 "We cut the pieces."          (min-height 80vh)
    ├─ step 02 "Your goal decides how they fit."
    ├─ step 03 "Every joint stays in sight."  ← compact nav trigger, joint fully seated
    └─ hold (45vh) → release
```

- **Copy column**: left 5 of 12 columns (max 560px hero, 420px steps), flush left; the joint occupies the right and the empty third. Step number Plex Mono 12px `--primary` ("01 · The pieces", sentence case), step title Newsreader 400 (each step is its own screen, so one serif line per screen holds), body `--muted-foreground`.
- **Progress**: `p = clamp(scrollY / (step03 centre − viewport/2), 0, 1)`; the joint pose is a function of `p` only (exploded → rail enters mortise → pin drops). Damped follow (`current += (p − current) × 0.08`).
- **Steps**: inactive steps at reduced emphasis (`opacity: .4` minimum; never below 4.5:1 for their text: use `--muted-foreground` colour change rather than opacity if contrast drops), active at full. 480ms `--ease-seat`.
- **Release**: after the hold, the sticky layer ends and the canvas scrolls away; the next section (showcase) has an opaque `--background` and higher z-index.

## Renderer and fallbacks

| Condition | Render |
|---|---|
| WebGL available, motion allowed | three.js scene (pinned version, self-hosted, not a CDN `<script>`), lazy-initialised after the first paint, faded in on its first frame; pixel ratio ≤ 2 (1.5 on phones and small GPUs); pause rendering when off-screen or tab hidden. The joint is drawn as a joiner's drawing: fills in the ground colour, a heavier outline, hidden edges dashed (gate `JOINT-3D`) |
| `prefers-reduced-motion: reduce` | **No scroll-linked motion.** The seated drawing, as an SVG still cut from the same scene, stands beside the copy. Steps scroll normally; no sticky |
| No WebGL (or only a software one), or low-power (`navigator.connection.saveData`) | The same drawing as SVG stills in the pinned layer: apart for the hero and steps 01–02, seated from step 03 (crossfade). Copy fully readable |
| JS off | The seated SVG still |
| Print | the static drawing |

## Constraints applied

- **No ambient loops**: the prototype's infinite `scroll-cue` animation becomes a static 1px line + "Scroll to see it fit" (or plays once on load and stops).
- **No gradient behind copy on mobile**: the prototype's `linear-gradient` plate under hero/step copy becomes a solid `--background` plate (opaque) with 24px padding, anchored to the bottom of the viewport.
- Wood textures belong to the 3D object only, never to the UI background. Scene background = `--background` (black `#0D0B09`; paper in light mode with the joint lit as on paper).
- No parallax on other elements; only the joint moves, on its own axes.
- No figures in the stage, so no pins; the stage makes no performance claims.

## Accessibility (WCAG 2.2 AA)

- Canvas `aria-hidden="true"`; the section has `aria-label="How tenonfi fits"`; all meaning is in the step text.
- 2.3.3 / reduced motion respected as above. 2.2.2: no auto-playing motion longer than 5s (motion is scroll-driven, stops when scrolling stops).
- Keyboard and screen-reader users reach every step in order; nothing depends on scroll position to be revealed (steps are in the DOM, only emphasis changes).
- Performance budget: stage JS (three + scene) ≤ 180 KB gzip, loaded after LCP; LCP element is the h1 text, not the canvas.

## Do / don't

| Do | Don't |
|---|---|
| Joint seats as the reader scrolls, then releases | Autoplaying loop or idle rotation |
| Static 2D drawing for reduced motion | Just slowing the animation down |
| Opaque plate behind copy on mobile | Gradient scrims |
