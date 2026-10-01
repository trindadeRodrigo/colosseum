# Disclaimer block
> Type: custom | Component: `<Disclaimer>` | Text: `DISCLAIMER` from `@colosseum/schemas` (`packages/schemas/src/constants.ts`) | Replaces: footer micro-text in `app/layout.tsx`

The product is not licensed advice, and it says so in full, at body size, where the plan is. The text lives in one constant and is never typed, edited or paraphrased in UI code.

## Anatomy

```
┌──────────────────────────────────────────────────────────────┐  1px --border box, 2px radius, 16px/24px padding, bg transparent
│ Not advice                                                   │  Plex Sans 600 caption (optional heading, from the copy dictionary)
│ This tool is not licensed investment advice. It structures   │  DISCLAIMER[language], Plex Sans 400 body (16px), --foreground
│ and explains an allocation from a goal you state; the        │  max 66ch
│ decision and custody are yours. The distributor embedding    │
│ this tool holds the client relationship.                     │
└──────────────────────────────────────────────────────────────┘
```

- Renders `DISCLAIMER[lang]` where `lang` is the view's language (`pt` | `en`). If the view is bilingual, render both, each in its own `<p lang>`.
- Body size: 1rem in app/docs, **≥ 1em** in the embed. Colour `--foreground` (not muted: it must be read).
- Hairline box (`--border`), no fill, no icon (`Shield`, `Info` as a promise, warning triangles are banned), no pattern behind it.

## Placement

| Surface | Where |
|---|---|
| Plan view (`/plans/[id]`) | **directly under the plan** (after allocation, schedule and exit plan, before activity) |
| Embed | same position, inside the shell, ≥ 1em |
| API docs (`/docs`) | top of the reference section, and in the OpenAPI `info.description` (from the same constant) |
| Landing showcase / simulator | once under the showcase section and once in the simulator panel, because they show plans |
| Monitor | under the plan summary card |
| Global footer | not a substitute. A footer may link to "Terms", but the block must appear in the places above |

`DISCLAIMER_SHORT` (also in `constants.ts`) may appear only as a one-line pointer inside a compact panel (e.g. the showcase pane foot) **in addition to** a full block on the same page, never instead of it.

## States

None interactive. It is not collapsible, dismissible or hidden behind "Read more".

## Enforcement

- A test renders PlanView, the embed page and `/docs` and asserts the exact `DISCLAIMER` string is present and its computed font-size ≥ the body size.
- A grep check fails on hard-coded variants ("not investment advice", "não é consultoria") in `apps/web` outside the constant (the current landing prototype's "Simulation. Not investment advice." becomes `DISCLAIMER_SHORT` + the block).

## Accessibility

`<aside aria-label="Disclaimer">` (or `role="note"`). Contrast ink 15.81 / washi 15.56. Language marked with `lang`.

## Do / don't

| Do | Don't |
|---|---|
| `{DISCLAIMER[lang]}` verbatim, body size, under the plan | 12px grey footer text |
| Hairline box | A warning-yellow banner, a shield icon |
| Both languages when the view is bilingual | A paraphrase in a component |
