import { describe, expect, it } from 'vitest';
import { parseColor, toHex } from './test/color';
import { resolve, sourceCss, variables } from './test/css';
import { block, inlineList, inlineMap, normal, scalars } from './test/spec';

// globals.css against working-brand.yml. The .yml is the source of truth of the design system: a
// token that drifts from it fails here.

const css = sourceCss();
const light = variables(css, (s) => s === ':root' || s === '.light');
const dark = new Map([...light, ...variables(css, (s) => s === '.dark')]);
const theme = new Map<string, string>();
css.walkAtRules('theme', (rule) => {
  rule.walkDecls((decl) => {
    theme.set(decl.prop, decl.value.replace(/\s+/g, ' ').trim());
  });
});

const hex = (vars: Map<string, string>, name: string): string => {
  const value = vars.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  const color = parseColor(resolve(value, vars));
  if (!color) throw new Error(`${name}: ${value} is not a colour`);
  return toHex(color);
};
const upper = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.toUpperCase()]));
/** A colour as written, for the ones with alpha (the 14% tints): spaces and case do not count. */
const flat = (value: string | undefined) => (value ?? '').replace(/\s+/g, '').toLowerCase();

describe('tokens: globals.css says what working-brand.yml says', () => {
  describe('semantic colours (shadcn names)', () => {
    const specLight = upper(scalars(['tokens', 'color']));
    const specDark = upper(scalars(['dark_mode', 'color']));

    it('reads all 34 of each from the .yml', () => {
      expect(Object.keys(specLight)).toHaveLength(34);
      expect(Object.keys(specDark)).toHaveLength(34);
      expect(specLight.background).toBe('#F7F5F0');
      // honey, the one brand colour, in both modes, with ink on it (IDENTITY-2)
      for (const spec of [specLight, specDark]) {
        expect(spec.primary).toBe('#F5A83A');
        expect(spec['primary-foreground']).toBe('#15161C');
      }
    });

    it('light: every one is defined on :root with the value of the .yml', () => {
      for (const [name, want] of Object.entries(specLight))
        expect(`${name} ${hex(light, `--${name}`)}`).toBe(`${name} ${want}`);
    });

    it('dark: every one is defined on .dark with the value of the .yml', () => {
      const own = variables(css, (s) => s === '.dark');
      for (const [name, want] of Object.entries(specDark)) {
        expect(own.has(`--${name}`), `--${name} on .dark`).toBe(true);
        expect(`${name} ${hex(dark, `--${name}`)}`).toBe(`${name} ${want}`);
      }
    });

    it('maps every one into the Tailwind theme under the same name', () => {
      for (const name of Object.keys(specLight))
        expect(theme.get(`--color-${name}`), `--color-${name}`).toBe(`var(--${name})`);
    });
  });

  describe('brand extensions', () => {
    const brand = upper(scalars(['tokens', 'brand-color']));
    const status = Object.fromEntries(
      Object.entries(scalars(['tokens', 'status'])).map(([k, v]) => [k, upper(inlineMap(v))]),
    );
    const pinOf = (state: string, mode: string) =>
      upper(inlineMap(scalars(['tokens', 'provenance', state])[mode] as string));
    const layers = (key: string) =>
      inlineList(scalars(['tokens', 'elevation'])[key] as string).map((v) => v.toUpperCase());
    const heat = (key: string) =>
      inlineList(scalars(['tokens', 'scales'])[key] as string).map((v) => v.toUpperCase());

    const expected = (mode: 'light' | 'dark'): Record<string, string | undefined> => {
      const d = mode === 'dark';
      const [sunk, ground, raised] = layers(d ? 'layers-dark' : 'layers-light');
      const ramp = heat(d ? 'heatmap-dark' : 'heatmap-light');
      return {
        '--tf-honey': brand.honey,
        '--tf-honey-hover': brand['honey-hover'],
        '--tf-honey-deep': brand['honey-deep'],
        '--tf-honey-text': d ? brand.honey : brand['honey-l'],
        '--tf-primary-hover': brand['honey-hover'],
        '--tf-primary-pressed': brand['honey-deep'],
        ...Object.fromEntries(
          [
            'night',
            'night-2',
            'night-3',
            'line',
            'line-2',
            'paper',
            'paper-2',
            'paper-3',
            'line-l',
            'line-l2',
            'ink',
            'text',
            'muted',
            'muted-2',
            'muted-l',
            'wood',
            'wood-deep',
          ].map((name) => [`--tf-${name}`, brand[name]]),
        ),
        '--tf-mark-cut': d ? brand.night : brand.ink,
        '--tf-leaf': d ? brand.leaf : brand['leaf-l'],
        '--tf-clay': d ? brand.clay : brand['clay-l'],
        '--tf-madder': d ? brand.madder : brand['madder-l'],
        '--tf-chalk': d ? brand.chalk : brand['chalk-l'],
        '--tf-pin-outline': pinOf('live', mode).outline,
        '--tf-pin': pinOf('live', mode).pin?.split(' ')[0],
        '--tf-hatch': d ? brand.muted : brand['muted-l'],
        '--tf-sample-fg': d ? brand.muted : brand['muted-l'],
        '--tf-status-on': status['on-track']?.[mode],
        '--tf-status-watch': status.watch?.[mode],
        '--tf-status-off': status['off-track']?.[mode],
        '--tf-layer-sunk': sunk,
        '--tf-layer-ground': ground,
        '--tf-layer-raised': raised,
        ...Object.fromEntries(ramp.map((v, i) => [`--tf-heat-${i + 1}`, v])),
      };
    };

    it('the pin is honey on night and honey-l on day, in an outline of muted-2 / line-l2', () => {
      expect(pinOf('live', 'light')).toMatchObject({
        outline: '#C9C4B9',
        pin: '#A8640A SOLID SQUARE',
      });
      expect(pinOf('live', 'dark')).toMatchObject({
        outline: '#6E7282',
        pin: '#F5A83A SOLID SQUARE',
      });
    });

    it.each(['light', 'dark'] as const)(
      '%s: every --tf- colour has the value of the .yml',
      (mode) => {
        const vars = mode === 'dark' ? dark : light;
        for (const [name, want] of Object.entries(expected(mode))) {
          expect(want, `${name} in the .yml`).toMatch(/^#[0-9A-F]{6}$/);
          expect(`${name} ${hex(vars, name)}`).toBe(`${name} ${want}`);
        }
      },
    );

    it.each(['light', 'dark'] as const)(
      '%s: the 14%% tints are the .yml tints, and each status badge sits on its own',
      (mode) => {
        const vars = mode === 'dark' ? dark : light;
        const raw = scalars(['tokens', 'brand-color']);
        for (const name of ['honey-tint', 'leaf-tint', 'clay-tint', 'madder-tint', 'chalk-tint']) {
          expect(raw[name], name).toMatch(/^rgba\(.*,\s*0\.14\)$/);
          expect(flat(vars.get(`--tf-${name}`)), name).toBe(flat(raw[name]));
        }
        expect(flat(vars.get('--tf-status-on-bg'))).toBe(flat(status['on-track']?.tint));
        expect(flat(vars.get('--tf-status-watch-bg'))).toBe(flat(status.watch?.tint));
        expect(flat(vars.get('--tf-status-off-bg'))).toBe(flat(status['off-track']?.tint));
      },
    );

    it('light is the only gradient: the glow (glow-l on day), the curve fill, and nothing else', () => {
      const raw = scalars(['tokens', 'brand-color']);
      expect(flat(light.get('--tf-glow'))).toBe(flat(raw['glow-l']));
      expect(flat(dark.get('--tf-glow'))).toBe(flat(raw.glow));
      expect(flat(light.get('--tf-glow-l'))).toBe(flat(raw['glow-l']));
      expect(flat(light.get('--tf-curve-fill'))).toBe(flat(raw['curve-fill']));
      const gradients: string[] = [];
      css.walkDecls((decl) => {
        if (/gradient\(/.test(decl.value)) gradients.push(decl.prop);
      });
      expect([...new Set(gradients)].sort()).toEqual([
        '--tf-curve-fill',
        '--tf-glow',
        '--tf-glow-l',
        'background-image', // the hatch
      ]);
    });
  });

  describe('shape, spacing, motion', () => {
    const shape = scalars(['tokens', 'shape']);
    const spacing = scalars(['tokens', 'spacing']);
    const motion = scalars(['tokens', 'motion']);

    it('radius: soft, not square. 6, 8, 10 and 16px, pills, and the 20px typing box', () => {
      expect(light.get('--radius')).toBe(shape['border-radius-md']);
      expect(shape['border-radius-md']).toBe('8px');
      expect(light.get('--tf-radius-sm')).toBe(shape['border-radius-sm']);
      expect(light.get('--tf-radius-lg')).toBe(shape['border-radius-lg']);
      expect(light.get('--tf-radius-xl')).toBe(shape['border-radius-xl']);
      expect(light.get('--tf-radius-pill')).toBe(shape['border-radius-pill']);
      expect(light.get('--tf-radius-composer')).toBe(shape['border-radius-composer']);
      expect(theme.get('--radius-sm')).toBe('var(--tf-radius-sm)');
      expect(theme.get('--radius-md')).toBe('var(--radius)');
      expect(theme.get('--radius-lg')).toBe('var(--tf-radius-lg)');
      expect(theme.get('--radius-xl')).toBe('var(--tf-radius-xl)');
      expect(theme.get('--radius-full')).toBe('var(--tf-radius-pill)');
      expect(theme.get('--radius-asset')).toBe('var(--tf-radius-pill)');
      expect(shape['border-radius-asset']).toBe(shape['border-radius-pill']);
      // nothing above 16px but pills and the typing box: a stray rounded-3xl comes out 16px
      for (const step of ['2xl', '3xl', '4xl'])
        expect(theme.get(`--radius-${step}`)).toBe('var(--tf-radius-xl)');
    });

    it('borders and the focus ring', () => {
      expect(light.get('--tf-border-width')).toBe(shape['border-width']);
      expect(light.get('--tf-focus-ring-width')).toBe(shape['focus-ring-width']);
      expect(light.get('--tf-focus-ring-offset')).toBe(shape['focus-ring-offset']);
    });

    it('no shadows', () => {
      const elevation = scalars(['tokens', 'elevation']);
      for (const step of ['sm', 'md', 'lg', 'xl']) {
        expect(elevation[`shadow-${step}`]).toBe('none');
        expect(theme.get(`--shadow-${step}`)).toBe('none');
      }
      for (const step of ['2xs', 'xs', '2xl']) expect(theme.get(`--shadow-${step}`)).toBe('none');
      // the one shadow, for popovers and the composer
      expect(normal(light.get('--tf-shadow-popover') ?? '')).toBe(
        normal(elevation['shadow-popover'] as string),
      );
      expect(theme.get('--shadow-popover')).toBe('var(--tf-shadow-popover)');
    });

    it('spacing: the 4px grid, nine steps, and the row heights', () => {
      const scale = inlineList(spacing.scale as string);
      expect(scale).toHaveLength(9);
      scale.forEach((px, i) => {
        expect(light.get(`--space-${i + 1}`)).toBe(`${px}px`);
      });
      expect(light.get('--tf-row-dense')).toBe(spacing['row-dense']);
      expect(light.get('--tf-row-comfortable')).toBe(spacing['row-comfortable']);
      expect(light.get('--tf-hit-min')).toBe(spacing['hit-area-min']);
    });

    it('motion: 160ms for colour, 320ms for a slide, one easing with no overshoot', () => {
      expect(light.get('--tf-dur-fade')).toBe(motion['duration-fast']);
      expect(light.get('--tf-dur-slide')).toBe(motion['duration-normal']);
      expect(light.get('--tf-delay-pin')).toBe(motion['delay-pin']);
      expect(light.get('--tf-dur-reduced')).toBe(motion['duration-reduced']);
      expect(light.get('--tf-stagger')).toBe(motion.stagger);
      expect(normal(light.get('--tf-ease-seat') ?? '')).toBe(normal(motion.easing as string));
      expect(theme.get('--ease-seat')).toBe('var(--tf-ease-seat)');
      expect(theme.get('--default-transition-duration')).toBe(motion['duration-fast']);
      expect(normal(theme.get('--default-transition-timing-function') ?? '')).toBe(
        normal(motion.easing as string),
      );
    });
  });

  describe('type', () => {
    const typography = scalars(['tokens', 'typography']);

    it('the three stacks are the .yml stacks, after the variable next/font sets', () => {
      const stack = (name: string) =>
        (light.get(name) ?? '').replace(/^var\(--font-[\w-]+, "[^"]+"\),\s*/, '');
      expect(stack('--tf-font-sans')).toBe(typography['font-family-primary']);
      expect(stack('--tf-font-display')).toBe(typography['font-family-display']);
      expect(stack('--tf-font-mono')).toBe(typography['font-family-mono']);
      expect(light.get('--tf-font-sans')).toMatch(/^var\(--font-inter, "Inter"\)/);
      expect(light.get('--tf-font-display')).toMatch(/^var\(--font-inter-tight, "Inter Tight"\)/);
      expect(light.get('--tf-font-mono')).toMatch(/^var\(--font-plex-mono, "IBM Plex Mono"\)/);
      for (const face of ['sans', 'display', 'mono', 'condensed'])
        expect(theme.get(`--font-${face}`)).toBe(`var(--tf-font-${face})`);
    });

    it('the condensed stack names the same families as the .yml', () => {
      const names = (stack: string) =>
        stack
          .replace(/var\(--font-[\w-]+, ("[^"]+")\)/g, '$1')
          .split(',')
          .map((s) => s.trim());
      expect(new Set(names(light.get('--tf-font-condensed') ?? ''))).toEqual(
        new Set(names(typography['font-family-condensed'] as string)),
      );
    });

    const level = (scale: string) =>
      Object.entries(scalars(['tokens', 'typography', scale])).map(
        ([name, value]) => [name, inlineMap(value)] as const,
      );

    it('the expressive scale: size, line height and tracking of every level', () => {
      const levels = level('scale-expressive');
      expect(levels.map(([name]) => name)).toEqual([
        'display',
        'h1',
        'h2',
        'h3',
        'h4',
        'body-lg',
        'body',
        'body-sm',
        'caption',
        'figure-lg',
        'sample-line',
        'source',
      ]);
      // the display levels are Inter Tight 600, never a serif (IDENTITY-2)
      for (const [name, spec] of levels)
        if (spec.face === 'display') expect(spec.weight, name).toBe('600');
      for (const [name, spec] of levels) {
        expect(normal(theme.get(`--text-${name}`) ?? ''), name).toBe(normal(spec.size as string));
        expect(normal(theme.get(`--text-${name}--line-height`) ?? ''), name).toBe(
          normal(spec['line-height'] as string),
        );
        const tracking = theme.get(`--text-${name}--letter-spacing`);
        if (spec.tracking === '0') expect(tracking, name).toBeUndefined();
        else expect(tracking, name).toBe(spec.tracking);
      }
    });

    it('no plate carries the word MOCK (gate MOCK-QUIET): no utility for one, and no level in the .yml', () => {
      expect(Object.keys(scalars(['tokens', 'typography', 'scale-expressive']))).not.toContain(
        'label-mock',
      );
      const utilities: string[] = [];
      css.walkAtRules('utility', (rule) => {
        utilities.push(rule.params);
      });
      expect(utilities).not.toContain('tf-mock-plate');
      expect(css.toString()).not.toMatch(/--tf-mock-plate/);
    });

    it('the productive scale (Bearing): fixed sizes', () => {
      for (const [name, spec] of level('scale-productive')) {
        expect(normal(theme.get(`--text-${name}`) ?? ''), name).toBe(normal(spec.size as string));
        expect(normal(theme.get(`--text-${name}--line-height`) ?? ''), name).toBe(
          normal(spec['line-height'] as string),
        );
        if (spec.tracking)
          expect(theme.get(`--text-${name}--letter-spacing`), name).toBe(spec.tracking);
      }
    });

    it('the embedded scale, in em of the partner’s text', () => {
      const spec = scalars(['tokens', 'typography', 'scale-embedded']);
      let embed = '';
      css.walkAtRules('utility', (rule) => {
        if (rule.params === 'tf-embed') embed = rule.toString();
      });
      for (const [name, value] of Object.entries(spec))
        expect(normal(embed), name).toContain(normal(`--tf-${name}: ${value}`));
    });

    it('the embed takes the partner’s face, or the system’s, never ours (rule 7)', () => {
      let embed = '';
      css.walkAtRules('utility', (rule) => {
        if (rule.params === 'tf-embed') embed = rule.toString();
      });
      expect(normal(embed)).toContain(
        normal('font-family: var(--embed-font, var(--tf-embed-system-font))'),
      );
      expect(normal(embed)).toMatch(/--tf-embed-system-font:\s*system-ui/);
      expect(embed).not.toMatch(/--font-(sans|display|mono|condensed)|Plex|Inter/);
      // and every type class inside it falls back the same way
      const whole = css.toString();
      expect(whole).not.toContain('var(--embed-font, inherit)');
    });

    it('the measures', () => {
      const measure = scalars(['tokens', 'typography', 'measure']);
      expect(light.get('--tf-measure-body')).toBe(measure.body);
      expect(light.get('--tf-measure-docs')).toBe(measure.docs);
      expect(light.get('--tf-measure-display')).toBe(measure.display);
    });
  });

  it('reads the .yml the way it is written', () => {
    expect(block(['tokens', 'shape']).length).toBeGreaterThan(5);
    expect(normal('clamp(3.5rem, 2.9820rem + 2.2099vw, 4.75rem)')).toBe(
      normal('clamp(3.5rem,2.982rem + 2.2099vw,4.75rem)'),
    );
  });
});
