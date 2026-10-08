# Joint stage (pinned hero)
> Type: custom | Component: `<JointStage>` | Source: landing prototype `.stage` / `.sticky` / `#scene` (three.js) | Revised 2026-10-08 (honey on night)

The landing hero: the through-tenon joint sits pinned behind the copy and **seats as you scroll steps 01–03**, then the stage releases and scrolls away with the page. It is the brand's lock animation (H2) driven by the reader, not by a timer.

## Anatomy

```
section.stage
├─ .sticky  (position: sticky; top: 0; height: 100svh; margin-bottom: -100svh; overflow: hidden)
│   └─ <canvas> 3D joint  |  <img>/<svg> 2D fallback       (aria-hidden)
└─ .stage-content (over the sticky layer, page grid)
    ├─ hero:   h1 (Inter Tight 600 display) + tagline + static scroll cue
    ├─ step 01 "We cut the pieces."          (min-height 80vh)
    ├─ step 02 "Your goal decides how they fit."
    ├─ step 03 "Every joint stays in sight."  ← compact nav trigger, joint fully seated
    └─ hold (45vh) → release
```

- **Copy column**: left 5 of 12 columns (max 560px hero, 420px steps), flush left; the joint occupies the right and the empty third, where the honey glow sits. Step number Plex Mono 12px `--tf-honey-text` ("01 · The pieces", sentence case), step title Inter Tight 600 `text-h2`, body `--muted-foreground`. No serif anywhere.
- **Hero copy**: "Tell it the goal. Get the portfolio cut for it." in `text-display`; the standfirst "A plan made to measure, with an exit plan before it invests, in your own vault. Every number carries its source." in body-lg muted. The composer may sit directly beneath it (the product in the first viewport).
- **Progress**: `p = clamp(scrollY / (step03 centre − viewport/2), 0, 1)`; the joint pose is a function of `p` only (exploded → rail enters mortise → pin drops). Damped follow (`current += (p − current) × 0.08`).
- **Steps**: inactive steps at reduced emphasis (`opacity: .4` minimum; never below 4.5:1 for their text: use `--muted-foreground` colour change rather than opacity if contrast drops), active at full. 480ms `--ease-seat`.
- **Release**: after the hold, the sticky layer ends and the canvas scrolls away; the next section (showcase) has an opaque `--background` and higher z-index.

## Materials

- **3D joint**: lit timber in `--tf-wood` / `--tf-wood-deep` (the only place wood colours appear in a screen), the post reading honey in the key light, the pin in honey. Scene background = `--background` (night `#0C0D12`; paper in light mode with the joint lit as on paper), with the brand `--tf-glow` behind the joint, off-centre to the right: it is the one gradient allowed, and it is light, not a second colour.
- **2D fallback**: the J1 line drawing: lines in `currentColor`, the post in honey, the pin a honey square, dimension lines in chalk with Plex Mono labels. SVG, `vector-effect: non-scaling-stroke`, square caps.

## Renderer and fallbacks

| Condition | Render |
|---|---|
| WebGL available, motion allowed | three.js scene (pinned version, self-hosted, not a CDN `<script>`), lazy-initialised when the stage is near the viewport; pixel ratio ≤ 2; pause rendering when off-screen or tab hidden |
| `prefers-reduced-motion: reduce` | **No scroll-linked motion.** Show the 2D drawing in two static states: exploded for the hero/steps 01–02, seated from step 03 (120ms crossfade). Steps scroll normally; no sticky |
| No WebGL / JS off / low-power (`navigator.connection.saveData`) | Static 2D seated drawing (SVG), no sticky. Copy fully readable |
| Print | the static drawing |

## Constraints applied

- **No ambient loops**: the prototype's infinite `scroll-cue` animation becomes a static 1px line + "Scroll to see it fit" (or plays once on load and stops).
- **No gradient scrim behind copy on mobile**: the prototype's `linear-gradient` plate under hero/step copy becomes a solid `--background` plate (opaque) with 24px padding, anchored to the bottom of the viewport. The glow stays behind the joint, never behind text.
- Wood textures and wood colours belong to the 3D object only, never to the UI. No wood-grain backgrounds.
- No parallax on other elements; only the joint moves, on its own axes. No bounce, no overshoot.
- No figures in the stage, so no pins; the stage makes no performance claims.

## Accessibility (WCAG 2.2 AA)

- Canvas `aria-hidden="true"`; the section has `aria-label="How tenonfi fits"`; all meaning is in the step text.
- 2.3.3 / reduced motion respected as above. 2.2.2: no auto-playing motion longer than 5s (motion is scroll-driven, stops when scrolling stops).
- Keyboard and screen-reader users reach every step in order; nothing depends on scroll position to be revealed (steps are in the DOM, only emphasis changes).
- Text on the glow: the glow peaks at 22% honey over night (`#2D2318`-ish) and sits in the empty third; copy stays on plain night (text 17.2) or on the opaque plate.
- Performance budget: stage JS (three + scene) ≤ 180 KB gzip, loaded after LCP; LCP element is the h1 text, not the canvas.

## Do / don't

| Do | Don't |
|---|---|
| Joint seats as the reader scrolls, then releases | Autoplaying loop or idle rotation |
| Static 2D drawing for reduced motion | Just slowing the animation down |
| Opaque plate behind copy on mobile; the glow behind the joint | Gradient scrims under text; a two-hue or blue gradient |
| Inter Tight 600 headline | A serif headline |
