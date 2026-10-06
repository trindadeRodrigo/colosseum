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

describe('tokens: globals.css says what working-brand.yml says', () => {
  describe('semantic colours (shadcn names)', () => {
    const specLight = upper(scalars(['tokens', 'color']));
    const specDark = upper(scalars(['dark_mode', 'color']));

    it('reads all 34 of each from the .yml', () => {
      expect(Object.keys(specLight)).toHaveLength(34);
      expect(Object.keys(specDark)).toHaveLength(34);
      expect(specLight.background).toBe('#F6F1E8');
      expect(specDark.primary).toBe('#E6D3B7');
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
        '--tf-primary-hover': d ? brand['primary-hover-d'] : brand['primary-hover'],
        '--tf-primary-pressed': d ? brand['hinoki-deep'] : brand.heartwood,
        '--tf-pin-outline': pinOf('live', mode).outline,
        '--tf-pin': pinOf('live', mode).pin?.split(' ')[0],
        '--tf-hatch': d ? brand['stone-d'] : brand.stone,
        '--tf-mock-plate': d ? brand.char : brand['paper-raised'],
        '--tf-mock-plate-fg': d ? brand.washi : brand.ink,
        '--tf-mock-plate-border': d ? brand['stone-d'] : brand.stone,
        '--tf-status-on': status['on-track']?.[mode],
        '--tf-status-on-bg': status['on-track']?.[`bg-${mode}`],
        '--tf-status-watch': status.watch?.[mode],
        '--tf-status-watch-bg': status.watch?.[`bg-${mode}`],
        '--tf-status-off': status['off-track']?.[mode],
        '--tf-status-off-bg': status['off-track']?.[`bg-${mode}`],
        '--tf-layer-sunk': sunk,
        '--tf-layer-ground': ground,
        '--tf-layer-raised': raised,
        ...Object.fromEntries(ramp.map((v, i) => [`--tf-heat-${i + 1}`, v])),
      };
    };

    it('the pin, the hatch and the plate are stone, with the pin in the species opposite the ground', () => {
      expect(pinOf('live', 'light')).toMatchObject({ outline: '#6E655B', pin: '#7A5A3A SOLID' });
      expect(pinOf('live', 'dark')).toMatchObject({ outline: '#A49A8E', pin: '#E6D3B7 SOLID' });
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
  });

  describe('shape, spacing, motion', () => {
    const shape = scalars(['tokens', 'shape']);
    const spacing = scalars(['tokens', 'spacing']);
    const motion = scalars(['tokens', 'motion']);

    it('radius: 2px, and 0 for the small step; the composer alone is 20px with a round button', () => {
      expect(light.get('--radius')).toBe(shape['border-radius-lg']);
      expect(shape['border-radius-md']).toBe('2px');
      expect(theme.get('--radius-sm')).toBe(shape['border-radius-sm']);
      expect(theme.get('--radius-md')).toBe('var(--radius)');
      expect(theme.get('--radius-lg')).toBe('var(--radius)');
      expect(light.get('--tf-radius-composer')).toBe(shape['border-radius-composer']);
      expect(light.get('--tf-radius-round')).toBe(shape['border-radius-round']);
      // a stray rounded-full or rounded-xl comes out square
      for (const step of ['xl', '2xl', '3xl', '4xl', 'full'])
        expect(theme.get(`--radius-${step}`)).toBe('var(--radius)');
    });

    it('borders and the focus ring', () => {
      expect(light.get('--tf-border-width')).toBe(shape['border-width']);
      expect(light.get('--tf-border-width-key')).toBe(shape['border-width-key']);
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
      expect(light.get('--tf-font-sans')).toMatch(/^var\(--font-plex-sans, "IBM Plex Sans"\)/);
      expect(light.get('--tf-font-display')).toMatch(/^var\(--font-newsreader, "Newsreader"\)/);
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
      const levels = level('scale-expressive').filter(([name]) => name !== 'label-mock');
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
        'source',
      ]);
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

    it('the MOCK label: mono, 500, 12.5px, 0.08em, uppercase', () => {
      const mock = Object.fromEntries(level('scale-expressive'))['label-mock'];
      expect(mock).toMatchObject({
        face: 'mono',
        weight: '500',
        tracking: '0.08em',
        transform: 'uppercase',
      });
      let plate = '';
      css.walkAtRules('utility', (rule) => {
        if (rule.params === 'tf-mock-plate') plate = rule.toString();
      });
      expect(normal(plate)).toContain(
        normal(`font: 500 ${mock?.size} / ${mock?.['line-height']} var(--tf-font-mono)`),
      );
      expect(plate).toContain('letter-spacing: 0.08em');
      expect(plate).toContain('text-transform: uppercase');
    });

    it('the productive scale (Bearing): fixed sizes', () => {
      for (const [name, spec] of level('scale-productive')) {
        expect(normal(theme.get(`--text-${name}`) ?? ''), name).toBe(normal(spec.size as string));
        expect(normal(theme.get(`--text-${name}--line-height`) ?? ''), name).toBe(
          normal(spec['line-height'] as string),
        );
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
      expect(embed).not.toMatch(/--font-(sans|display|mono|condensed)|Plex|Newsreader/);
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
