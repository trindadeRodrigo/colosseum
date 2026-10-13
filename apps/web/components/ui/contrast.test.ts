import { describe, expect, it } from 'vitest';
import { contrast, parseColor, type Rgb } from './test/color';
import { resolve, sourceCss, variables } from './test/css';

// WCAG 2.2 AA for every pair of tokens the specs put together, in light and in dark, worked out from
// the values in globals.css. Text needs 4.5:1. A control edge, a focus ring, the pin, the hatch and a
// state glyph need 3:1 (1.4.11). `--border` (hair) is decoration and is never a control edge, so it
// is not in the list. A 14% tint is worked out over the card it sits on (a pill, a selected row).
//
// What is not in the list, by rule (color-system.md, IDENTITY-2): honey as text or as a thin line on
// light grounds (1.9:1 on white; honey-l is honey as text there), and plan-leg fills, which always
// carry a direct label (plan-leg.md) and so are never what tells a person what a leg is.

type Pair = { fg: string; bg: string; use: string; over?: string };

const GROUNDS = ['--background', '--card', '--muted'] as const;
const on = (fg: string, use: string, grounds: readonly string[] = GROUNDS): Pair[] =>
  grounds.map((bg) => ({ fg, bg, use }));

/** A tint over the card, the surface pills and rows sit on. */
const tint = (fg: string, bg: string, use: string): Pair => ({ fg, bg, use, over: '--card' });

/** Text: 4.5:1. */
export const TEXT: Pair[] = [
  ...on('--foreground', 'body text', [...GROUNDS, '--popover']),
  ...on('--muted-foreground', 'muted text, captions, source lines, placeholders', [
    '--background',
    '--card',
    '--popover',
  ]),
  ...on('--accent-foreground', 'links, the link action (honey-l / honey)', ['--card', '--popover']),
  ...on('--tf-honey-text', 'honey as text', ['--card', '--popover']),
  ...on('--destructive', 'error sentences, the destructive button'),
  ...on('--tf-status-on', 'status word and up delta: leaf', ['--background', '--card']),
  ...on('--tf-status-watch', 'status word: clay'),
  ...on('--tf-status-off', 'status word and down delta: madder'),
  ...on('--tf-sample-fg', 'the quiet line: "Sample figures"', ['--background', '--card']),
  { fg: '--card-foreground', bg: '--card', use: 'text on a card' },
  { fg: '--popover-foreground', bg: '--popover', use: 'the provenance popover' },
  { fg: '--secondary-foreground', bg: '--secondary', use: 'text in a well' },
  { fg: '--foreground', bg: '--accent', use: 'text on a hovered row' },
  { fg: '--primary-foreground', bg: '--primary', use: 'primary button: ink on honey, at rest' },
  { fg: '--primary-foreground', bg: '--tf-primary-hover', use: 'primary button, hover' },
  { fg: '--primary-foreground', bg: '--tf-primary-pressed', use: 'primary button, pressed' },
  tint('--tf-status-on', '--tf-status-on-bg', 'badge: on track'),
  tint('--tf-status-watch', '--tf-status-watch-bg', 'badge: watch'),
  tint('--tf-status-off', '--tf-status-off-bg', 'badge and tinted row: off track'),
  tint('--foreground', '--tf-honey-tint', 'cells of a selected row'),
  tint('--foreground', '--tf-status-watch-bg', 'cells of a row on watch'),
  tint('--foreground', '--tf-status-off-bg', 'the error summary; cells of a row off track'),
  tint('--muted-foreground', '--tf-honey-tint', 'muted cells of a selected row'),
  { fg: '--sidebar-foreground', bg: '--sidebar', use: 'docs navigation' },
  {
    fg: '--sidebar-primary-foreground',
    bg: '--sidebar-primary',
    use: 'docs navigation, filled item',
  },
  { fg: '--success', bg: '--background', use: 'success text' },
  // The day-mode AA fix (Oct 9): the day pairs IDENTITY-2 left below AA, carried there by darker honey-l,
  // muted-l, leaf-l and clay-l
  ...on('--accent-foreground', 'a link on paper, in a well, on a hovered row', [
    '--background',
    '--muted',
    '--accent',
  ]),
  { fg: '--muted-foreground', bg: '--muted', use: 'muted text in a well; a disabled button' },
  { fg: '--tf-status-on', bg: '--muted', use: 'leaf text in a well' },
  {
    fg: '--tf-status-on',
    bg: '--tf-status-on-bg',
    use: 'badge on paper: on track',
    over: '--background',
  },
  {
    fg: '--tf-status-watch',
    bg: '--tf-status-watch-bg',
    use: 'badge on paper: watch',
    over: '--background',
  },
  {
    fg: '--tf-status-off',
    bg: '--tf-status-off-bg',
    use: 'badge on paper: off track',
    over: '--background',
  },
  tint('--tf-honey-text', '--tf-honey-tint', 'selected chip: honey-l on the honey tint'),
  tint('--muted-foreground', '--tf-status-watch-bg', 'muted cells of a row on watch'),
  tint('--muted-foreground', '--tf-status-off-bg', 'muted cells of a row off track'),
  tint('--accent-foreground', '--tf-status-off-bg', '"Go to field" in the error summary'),
  { fg: '--sidebar-accent-foreground', bg: '--sidebar', use: 'docs navigation, current link' },
  {
    fg: '--sidebar-accent-foreground',
    bg: '--sidebar-accent',
    use: 'docs navigation, hovered item',
  },
  { fg: '--warning', bg: '--background', use: 'warning text' },
];

/** Not text: 3:1. */
export const NON_TEXT: Pair[] = [
  ...on('--ring', 'the focus ring: chalk, on both grounds'),
  ...on('--info', 'guides and the "today" line: chalk', ['--background', '--card']),
  ...on('--tf-pin', 'the solid pin'),
  ...on('--tf-hatch', 'the hatch'),
  ...on('--chart-5', 'the base-case line', ['--background', '--card']),
  ...on('--destructive', 'the edge of an invalid field; the stress line'),
  ...on('--tf-status-on', 'the on-track glyph', ['--background', '--card']),
  ...on('--tf-status-watch', 'the watch glyph'),
  ...on('--tf-status-off', 'the off-track glyph'),
];

/**
 * Pairs the specs put together that the day values do not carry to AA, each with what it measures.
 * They are not passes: they are listed so that they stay in sight, and the test fails when one of
 * them is fixed (or gets worse), so the list can only shrink. The text gaps IDENTITY-2 left (honey-l,
 * muted-l and leaf-l in wells, on paper and on tints) closed when those three and clay-l were
 * darkened (the day-mode AA fix of Oct 9); they now sit in TEXT above. Night passes every one.
 */
export const GAPS: (Pair & { min: number; light: number })[] = [
  // a control is told by its well (`--secondary`) and its label; its edge alone is a hairline
  {
    fg: '--input',
    bg: '--card',
    use: 'a control edge on a card (night 1.64)',
    min: 3,
    light: 1.74,
  },
  {
    fg: '--input',
    bg: '--background',
    use: 'a control edge on the page (night 1.74)',
    min: 3,
    light: 1.6,
  },
];

const css = sourceCss();
const light = variables(css, (s) => s === ':root' || s === '.light');
const dark = new Map([...light, ...variables(css, (s) => s === '.dark')]);

function ratio(vars: Map<string, string>, pair: Pair): number {
  const read = (name: string) => {
    const color = parseColor(resolve(vars.get(name) ?? '', vars));
    if (!color) throw new Error(`${name} is not a colour in globals.css`);
    return color;
  };
  const bg = read(pair.bg);
  // a translucent tint is what it looks like over the surface beneath it
  const under = pair.over ? read(pair.over) : bg;
  const seen = (top: Rgb, base: Rgb): Rgb =>
    top.a >= 1
      ? top
      : {
          r: top.r * top.a + base.r * (1 - top.a),
          g: top.g * top.a + base.g * (1 - top.a),
          b: top.b * top.a + base.b * (1 - top.a),
          a: 1,
        };
  return contrast(read(pair.fg), seen(bg, under));
}

type Row = Pair & { light: number; dark: number; min: number };
const rows = (pairs: Pair[], min: number): Row[] =>
  pairs.map((pair) => ({ ...pair, min, light: ratio(light, pair), dark: ratio(dark, pair) }));
const table = [...rows(TEXT, 4.5), ...rows(NON_TEXT, 3)];

describe('contrast: WCAG 2.2 AA in light and dark', () => {
  it('works the ratio out the way the spec’s own figures were', () => {
    const at = (fg: string, bg: string) =>
      contrast(parseColor(fg) as never, parseColor(bg) as never);
    // color-system.md's figures
    expect(at('#15161C', '#F7F5F0')).toBeCloseTo(16.57, 1); // ink on paper
    expect(at('#15161C', '#F5A83A')).toBeCloseTo(9.06, 1); // ink on honey: the primary button
    expect(at('#9D5A00', '#FFFFFF')).toBeCloseTo(5.39, 1); // honey-l on white: honey as text
    expect(at('#676A75', '#FFFFFF')).toBeCloseTo(5.39, 1); // muted-l on white
    expect(at('#2A73B0', '#FFFFFF')).toBeCloseTo(5.03, 1); // chalk-l on white: the focus ring
    // why white never sits on honey, and honey is never small text on a light ground
    expect(at('#FFFFFF', '#F5A83A')).toBeLessThan(2.1);
    expect(at('#F5A83A', '#FFFFFF')).toBeLessThan(2.1);
    expect(at('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  });

  it.each(table.map((row) => [`${row.fg} on ${row.bg}`, row] as const))('%s', (_name, row) => {
    expect(row.light, `light: ${row.use}`).toBeGreaterThanOrEqual(row.min);
    expect(row.dark, `dark: ${row.use}`).toBeGreaterThanOrEqual(row.min);
  });

  it.each(GAPS.map((gap) => [`${gap.fg} on ${gap.bg}`, gap] as const))(
    'known gap in day mode, still as measured: %s',
    (_name, gap) => {
      const day = ratio(light, gap);
      expect(day, `light: ${gap.use}`).toBeLessThan(gap.min);
      expect(day, `light: ${gap.use}`).toBeCloseTo(gap.light, 1);
      // the night passes the text pairs; a control edge is a hairline in both
      if (gap.fg !== '--input')
        expect(ratio(dark, gap), `dark: ${gap.use}`).toBeGreaterThanOrEqual(gap.min);
    },
  );

  it('prints the table', () => {
    const lines = table.map(
      (r) =>
        `| ${r.fg.replace('--', '')} | ${r.bg.replace('--', '')} | ${r.use} | ${r.min} | ${r.light.toFixed(2)} | ${r.dark.toFixed(2)} |`,
    );
    console.log(
      [
        '| foreground | background | use | AA needs | light | dark |',
        '|---|---|---|---|---|---|',
        ...lines,
      ].join('\n'),
    );
    expect(table.length).toBe(TEXT.length + NON_TEXT.length);
  });
});
