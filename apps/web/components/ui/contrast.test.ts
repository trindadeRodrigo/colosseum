import { describe, expect, it } from 'vitest';
import { contrast, parseColor } from './test/color';
import { resolve, sourceCss, variables } from './test/css';

// WCAG 2.2 AA for every pair of tokens the specs put together, in light and in dark, worked out from
// the values in globals.css. Text needs 4.5:1. A control edge, a focus ring, the pin, the hatch and a
// plan-leg fill need 3:1 (1.4.11). `--border` (hair) is decoration and is never a control edge, so it
// is not in the list.

type Pair = { fg: string; bg: string; use: string };

const GROUNDS = ['--background', '--card', '--muted'] as const;
const on = (fg: string, use: string, grounds: readonly string[] = GROUNDS): Pair[] =>
  grounds.map((bg) => ({ fg, bg, use }));

/** Text: 4.5:1. */
export const TEXT: Pair[] = [
  ...on('--foreground', 'body text', [...GROUNDS, '--popover']),
  ...on('--muted-foreground', 'muted text, captions, source lines, placeholders', [
    ...GROUNDS,
    '--popover',
  ]),
  ...on('--primary', 'links, the link action'),
  ...on('--destructive', 'error sentences, the destructive button'),
  ...on('--tf-status-on', 'status word: on track'),
  ...on('--tf-status-watch', 'status word: watch'),
  ...on('--tf-status-off', 'status word: off track'),
  { fg: '--card-foreground', bg: '--card', use: 'text on a card' },
  { fg: '--popover-foreground', bg: '--popover', use: 'the provenance popover' },
  { fg: '--secondary-foreground', bg: '--secondary', use: 'text on the sunk surface' },
  { fg: '--accent-foreground', bg: '--accent', use: 'emphasis on a hovered row' },
  { fg: '--foreground', bg: '--accent', use: 'text on a hovered row or chip' },
  { fg: '--primary-foreground', bg: '--primary', use: 'primary button, at rest' },
  { fg: '--primary-foreground', bg: '--tf-primary-hover', use: 'primary button, hover' },
  { fg: '--primary-foreground', bg: '--tf-primary-pressed', use: 'primary button, pressed' },
  { fg: '--muted-foreground', bg: '--muted', use: 'a disabled button' },
  { fg: '--tf-mock-plate-fg', bg: '--tf-mock-plate', use: 'the word MOCK on its plate' },
  { fg: '--tf-status-on', bg: '--tf-status-on-bg', use: 'badge: on track' },
  { fg: '--tf-status-watch', bg: '--tf-status-watch-bg', use: 'badge and tinted row: watch' },
  { fg: '--tf-status-off', bg: '--tf-status-off-bg', use: 'badge and tinted row: off track' },
  { fg: '--foreground', bg: '--tf-status-watch-bg', use: 'cells of a row on watch' },
  {
    fg: '--foreground',
    bg: '--tf-status-off-bg',
    use: 'the error summary; cells of a row off track',
  },
  { fg: '--muted-foreground', bg: '--tf-status-watch-bg', use: 'muted cells of a row on watch' },
  { fg: '--muted-foreground', bg: '--tf-status-off-bg', use: 'muted cells of a row off track' },
  { fg: '--primary', bg: '--tf-status-off-bg', use: '"Go to field" in the error summary' },
  { fg: '--sidebar-foreground', bg: '--sidebar', use: 'docs navigation' },
  { fg: '--sidebar-primary', bg: '--sidebar', use: 'docs navigation, current link' },
  {
    fg: '--sidebar-primary-foreground',
    bg: '--sidebar-primary',
    use: 'docs navigation, filled item',
  },
  {
    fg: '--sidebar-accent-foreground',
    bg: '--sidebar-accent',
    use: 'docs navigation, hovered item',
  },
  { fg: '--info', bg: '--background', use: 'neutral notices (there is no blue)' },
  { fg: '--success', bg: '--background', use: 'success text' },
  { fg: '--warning', bg: '--background', use: 'warning text' },
];

/** Not text: 3:1. */
export const NON_TEXT: Pair[] = [
  ...on('--input', 'every control edge'),
  ...on('--ring', 'the focus ring'),
  ...on('--tf-pin-outline', 'the pin’s outline; the hollow pin'),
  ...on('--tf-pin', 'the solid pin'),
  ...on('--tf-hatch', 'the hatch'),
  { fg: '--tf-mock-plate-border', bg: '--tf-mock-plate', use: 'the plate’s edge' },
  ...on('--chart-1', 'plan leg 1', ['--background', '--card']),
  ...on('--chart-2', 'plan leg 2', ['--background', '--card']),
  ...on('--chart-3', 'plan leg 3', ['--background', '--card']),
  ...on('--chart-4', 'plan leg 4', ['--background', '--card']),
  ...on('--chart-5', 'the base-case line', ['--background', '--card']),
  ...on('--primary', 'the selected edge; the exit-plan rule; the send button'),
  ...on('--destructive', 'the edge of an invalid field'),
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
  return contrast(read(pair.fg), read(pair.bg));
}

type Row = Pair & { light: number; dark: number; min: number };
const rows = (pairs: Pair[], min: number): Row[] =>
  pairs.map((pair) => ({ ...pair, min, light: ratio(light, pair), dark: ratio(dark, pair) }));
const table = [...rows(TEXT, 4.5), ...rows(NON_TEXT, 3)];

describe('contrast: WCAG 2.2 AA in light and dark', () => {
  it('works the ratio out the way the spec’s own figures were', () => {
    const at = (fg: string, bg: string) =>
      contrast(parseColor(fg) as never, parseColor(bg) as never);
    expect(at('#1C1712', '#F6F1E8')).toBeCloseTo(15.81, 1); // ink on paper
    expect(at('#6E655B', '#EDE6DA')).toBeCloseTo(4.61, 1); // stone on paper-sunk, the tightest text
    expect(at('#8C7F70', '#EDE6DA')).toBeCloseTo(3.14, 1); // member on paper-sunk, the tightest edge
    expect(at('#C9AE86', '#F6F1E8')).toBeCloseTo(1.89, 1); // why hinoki-deep is not a light leg
    expect(at('#7A5A3A', '#0D0B09')).toBeCloseTo(3.13, 1); // why hardwood is never used on dark
    expect(at('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  });

  it.each(table.map((row) => [`${row.fg} on ${row.bg}`, row] as const))('%s', (_name, row) => {
    expect(row.light, `light: ${row.use}`).toBeGreaterThanOrEqual(row.min);
    expect(row.dark, `dark: ${row.use}`).toBeGreaterThanOrEqual(row.min);
  });

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
