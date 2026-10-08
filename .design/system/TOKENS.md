# Tokens
> Design System Analysis | Generated: 2026-10-01

## Token Source

**Token source:** none in code. `apps/web/app/globals.css` contains only `@import "tailwindcss";`. No `tailwind.config.*`, no `@theme` block, no CSS custom properties, no `theme.ts` / `tokens.json`.
**Format:** Tailwind v4 default theme consumed directly as utility classes (plus raw hex in SVG).

## Token Coverage

| Category | Defined? | Details |
|----------|----------|---------|
| Colors | no | Tailwind defaults used ad hoc: `gray-{50,100,200,300,400,500,600,700,900}`, `black`, `white`, `blue-700` (links), `green-{100,700,800}`, `red-700`, `amber-{50,100,800,900}`. ScheduleChart hard-codes hex: `#111827 #9ca3af #f59e0b #ef4444 #8b5cf6 #10b981 #e5e7eb #6b7280` |
| Typography | no | No `next/font`, no font-family set → browser default sans. Sizes: `text-xs/sm/xl/2xl`; weights `font-medium/semibold`; SVG text `fontSize="10"` |
| Spacing | no (defaults) | Tailwind default scale: `p-1/2/3/4`, `px-3 py-1.5`, `gap-2/3/5`, `space-y-1/3/4/6/8`, `mt-0.5/1/2/3`, `py-1/3/6` |
| Radii | no (defaults) | Single value: `rounded` (0.25rem) everywhere |
| Shadows | no | None used |
| Dark mode | no | No `dark:` classes, no next-themes, no `prefers-color-scheme`; `bg-white text-gray-900` hard-set on `<body>` |

**Coverage: 0/6 categories tokenized.**

Other: breakpoints only `sm:` (grid columns); container `max-w-4xl`; `max-w-[14rem]` arbitrary value in risk sheet; `tracking-wide`, `uppercase`, `antialiased`.

## Theme Configuration

```css
/* apps/web/app/globals.css — entire file */
@import "tailwindcss";
```

```js
// apps/web/postcss.config.mjs
export default { plugins: { '@tailwindcss/postcss': {} } };
```

Tailwind v4 is CSS-first: tokens would go in an `@theme { --color-*: …; --font-*: …; }` block in `globals.css`, not a JS config.

## Prior GSP Tokens

`.design/branding/working-brand/patterns/` is **empty** (Patterns phase 4 pending). Identity-phase token sources exist and are the intended input for `/gsp-brand-guidelines`:

| Brand | File | Categories |
|-------|------|------------|
| working-brand (provisional name **Tenonfi**) | `.design/branding/working-brand/identity/palettes.json` | Colors (revised 2026-10-08, IDENTITY-2): honey `#F5A83A` as the one brand colour, night / paper grounds, leaf / clay / madder / chalk scales plus named tokens, with contrast ratios |
| working-brand | `.design/branding/working-brand/identity/typography.md` | Typography (revised 2026-10-08, IDENTITY-2): Inter Tight (display, big numbers), Inter (UI), IBM Plex Mono (numbers, provenance, MOCK label); three scales (Expressive 16px/1.333, Productive 13px/1.125, Embedded partner-1em/1.2) with fluid `clamp()` values; tabular figures |
| working-brand | `.design/branding/working-brand/identity/color-system.md` | Color roles / semantic mapping |

None of these are wired into `apps/web` yet.
