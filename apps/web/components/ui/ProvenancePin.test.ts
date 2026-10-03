import { describe, expect, it } from 'vitest';
import { FIGURE, LIVE_SPECIMEN, MOCK_OBS, SANDBOX_OBS, STALE_SPECIMEN } from './fixtures/mock';
import { PIN_LABELS, type PinSource, pinLabel, pinState, sourceLine } from './ProvenancePin';
import { pin } from './test/cases';
import { all, classes, html, name, one, render, role, tag, text, ui } from './test/html';

const NBSP = ' ';

describe('ProvenancePin (provenance-pin.md)', () => {
  describe('no pin, no number', () => {
    it('cannot be handed a figure without its source: a type error', () => {
      // test/cases.tsx holds the two `@ts-expect-error` lines. `pnpm typecheck` fails if either stops
      // being an error. What they render, should the types be bypassed, is the missing state:
      expect(text(render(pin.unsourced))).not.toContain(FIGURE.rate);
      expect(text(render(pin.halfSourced))).not.toContain(FIGURE.rate);
    });

    it('shows a dash and "no source yet" in place of a figure with no source, time or method', () => {
      for (const node of [pin.missing, pin.noMethod, pin.noTime, pin.unsourced, pin.halfSourced]) {
        const root = render(node);
        expect(text(root)).toBe('— no source yet');
        expect(text(root)).not.toContain(FIGURE.rate);
        expect(all(root, ui('pin'))).toHaveLength(0);
        expect(all(root, tag('svg'))).toHaveLength(0);
      }
    });

    it('counts a figure as sourced only with a source, a parsable time and a method', () => {
      const full: PinSource = LIVE_SPECIMEN;
      expect(pinState(full)).toBe('live');
      expect(pinState(null)).toBe('missing');
      expect(pinState(undefined)).toBe('missing');
      for (const key of ['source', 'fetchedAt', 'method'] as const)
        expect(pinState({ ...full, [key]: '' })).toBe('missing');
      expect(pinState({ ...full, fetchedAt: 'not a date' })).toBe('missing');
    });
  });

  describe('states come from the API', () => {
    it('is live only for the exact word "live"', () => {
      expect(pinState(LIVE_SPECIMEN)).toBe('live');
      for (const provenance of ['mock', 'sandbox', 'fixture', 'prior_dataset'] as const)
        expect(pinState({ ...LIVE_SPECIMEN, provenance })).toBe('mock');
      // a provenance this build does not know is never shown as live
      expect(pinState({ ...LIVE_SPECIMEN, provenance: 'replayed' as never })).toBe('mock');
      expect(pinState({ ...LIVE_SPECIMEN, provenance: '' as never })).toBe('mock');
    });

    it('is stale only when the API states an age, and never works one out from the time', () => {
      expect(pinState({ ...LIVE_SPECIMEN, fetchedAt: '2001-01-01T00:00:00Z' })).toBe('live');
      expect(pinState({ ...LIVE_SPECIMEN, staleAgeSec: null })).toBe('live');
      expect(pinState({ ...LIVE_SPECIMEN, staleAgeSec: 0 })).toBe('stale');
      expect(pinState(STALE_SPECIMEN)).toBe('stale');
      // mock data that is also old is MOCK
      expect(pinState({ ...MOCK_OBS, staleAgeSec: 9000 })).toBe('mock');
    });
  });

  describe('the glyph', () => {
    const glyph = (node: Parameters<typeof render>[0]) => one(render(node), ui('pin-glyph'));

    it('is the 18 by 12 tenon end, 0.75em tall, hidden from screen readers', () => {
      for (const node of [pin.live, pin.stale, pin.mock]) {
        const svg = glyph(node);
        expect(svg.attrs.viewBox).toBe('0 0 18 12');
        expect(svg.attrs['aria-hidden']).toBe('true');
        expect(classes(svg)).toEqual(expect.arrayContaining(['h-[0.75em]', 'w-[1.125em]']));
        const outline = one(svg, tag('rect'));
        expect(outline.attrs).toMatchObject({
          x: '0.75',
          y: '0.75',
          width: '16.5',
          height: '10.5',
        });
        expect(outline.attrs.stroke).toBe('var(--tf-pin-outline)');
        expect(outline.attrs['stroke-width']).toBe('1.5');
        expect(outline.attrs.fill).toBe('none');
      }
    });

    it('live: a solid pin in the brand wood', () => {
      const dot = one(glyph(pin.live), tag('circle'));
      expect(dot.attrs).toMatchObject({ cx: '9', cy: '6', r: '2.5', fill: 'var(--tf-pin)' });
    });

    it('stale: a hollow ring in the outline colour, the same size as the pin', () => {
      const ring = one(glyph(pin.stale), tag('circle'));
      expect(ring.attrs.fill).toBe('none');
      expect(ring.attrs.stroke).toBe('var(--tf-pin-outline)');
      expect(Number(ring.attrs.r) + Number(ring.attrs['stroke-width']) / 2).toBe(2.5);
    });

    it('MOCK: no pin at all, and a 45° hatch at a 3px pitch inside the outline', () => {
      const svg = glyph(pin.mock);
      expect(all(svg, tag('circle'))).toHaveLength(0);
      const hatch = one(svg, tag('path'));
      expect(hatch.attrs.stroke).toBe('var(--tf-hatch)');
      expect(hatch.attrs['stroke-width']).toBe('1');
      const lines = [
        ...(hatch.attrs.d ?? '').matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/g),
      ].map((m) => m.slice(1).map(Number) as [number, number, number, number]);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const [x1, y1, x2, y2] of lines) {
        expect(Math.abs(x2 - x1) - Math.abs(y2 - y1)).toBeCloseTo(0, 1); // 45°
        for (const x of [x1, x2]) expect(x >= 1.5 && x <= 16.5).toBe(true); // inside the outline
        for (const y of [y1, y2]) expect(y >= 1.5 && y <= 10.5).toBe(true);
      }
      const offsets = lines.map(([x1, y1]) => (x1 + y1) / Math.SQRT2).sort((a, b) => a - b);
      for (let i = 1; i < offsets.length; i++)
        expect((offsets[i] as number) - (offsets[i - 1] as number)).toBeCloseTo(3, 1);
    });
  });

  describe('what goes with the figure', () => {
    it('keeps the figure and the glyph together, a narrow no-break space between them', () => {
      const markup = html(pin.live);
      expect(markup).toContain(`${FIGURE.rate}</span>${NBSP}<button`);
      expect(classes(one(render(pin.live), ui('figure')))).toContain('whitespace-nowrap');
      expect(
        classes(one(render(pin.live), (e) => text(e) === FIGURE.rate && e.tag === 'span')),
      ).toContain('tf-figure');
    });

    it('is a button with a 24px hit area and the 2px focus ring', () => {
      const button = one(render(pin.live), ui('pin'));
      expect(button.tag).toBe('button');
      expect(button.attrs.type).toBe('button');
      expect(classes(button)).toEqual(
        expect.arrayContaining([
          'before:absolute',
          'before:size-6',
          'focus-visible:outline-2',
          'focus-visible:outline-offset-2',
          'focus-visible:outline-ring',
        ]),
      );
    });

    it('says the state in its name, not only in the drawing', () => {
      const label = (node: Parameters<typeof render>[0]) => {
        const root = render(node);
        return name(one(root, ui('pin')), root);
      };
      expect(label(pin.live)).toBe('Source for 6.40%');
      expect(label(pin.stale)).toBe('Source for 6.40%, stale, 3 hours old');
      expect(label(pin.mock)).toBe('Source for 6.40%, mock data');
      expect(label(pin.sandbox)).toBe('Source for 6.40%, mock data');
      expect(label(pin.labelled)).toBe('Source for $12,480');
      expect(pinLabel('1', { ...STALE_SPECIMEN, staleAgeSec: 3600 })).toBe(
        'Source for 1, stale, 1 hour old',
      );
    });

    it('never shows a hollow pin without the word "stale" and the age', () => {
      const root = render(pin.stale);
      expect(text(one(root, ui('stale-tag')))).toBe('stale · 3 h');
      expect(all(render(pin.live), ui('stale-tag'))).toHaveLength(0);
    });

    it('never shows mock data without the MOCK plate, and never with a solid pin', () => {
      for (const node of [pin.mock, pin.sandbox, pin.unknownKind]) {
        const root = render(node);
        expect(text(one(root, ui('mock-plate')))).toBe('MOCK');
        expect(all(root, tag('circle'))).toHaveLength(0);
      }
      expect(all(render(pin.live), ui('mock-plate'))).toHaveLength(0);
    });
  });

  describe('the popover', () => {
    it('is closed until asked for', () => {
      const root = render(pin.live);
      expect(all(root, ui('pin-popover'))).toHaveLength(0);
      expect(one(root, ui('pin')).attrs['aria-expanded']).toBe('false');
    });

    it('reads source · fetched_at · method, the time in ISO 8601 UTC, in the mono face', () => {
      expect(sourceLine(LIVE_SPECIMEN)).toBe('sample feed · 2026-10-01T14:02:11Z · haircut v2');
      expect(sourceLine({ ...LIVE_SPECIMEN, fetchedAt: '2026-10-01T11:02:11-03:00' })).toBe(
        'sample feed · 2026-10-01T14:02:11Z · haircut v2',
      );
      const root = render(pin.open);
      const popover = one(root, ui('pin-popover'));
      expect(text(popover)).toContain(sourceLine(LIVE_SPECIMEN));
      expect(text(popover)).toContain(FIGURE.rateDetail);
      expect(classes(popover)).toEqual(
        expect.arrayContaining([
          'font-mono',
          'text-source',
          'bg-popover',
          'border',
          'border-border',
          'rounded-md',
        ]),
      );
    });

    it('is a tooltip that describes the pin, or a named dialog when it holds a link', () => {
      const plain = render(pin.open);
      const tip = one(plain, ui('pin-popover'));
      expect(role(tip)).toBe('tooltip');
      expect(one(plain, ui('pin')).attrs['aria-describedby']).toBe(tip.attrs.id);
      const withLink = render(pin.openWithDocs);
      const dialog = one(withLink, ui('pin-popover'));
      expect(role(dialog)).toBe('dialog');
      expect(dialog.attrs['aria-label']).toBe('Provenance');
      expect(one(withLink, ui('pin')).attrs['aria-controls']).toBe(dialog.attrs.id);
      expect(one(dialog, tag('a')).attrs).toMatchObject({
        href: '/risk/methodology',
        rel: 'noopener',
      });
    });

    it('adds the state: how stale, or which kind of mock', () => {
      expect(text(one(render(pin.openWithDocs), ui('pin-popover')))).toContain('stale · 3 h');
      expect(text(one(render(pin.sandbox), ui('pin-popover')))).toContain('MOCK · test network');
      expect(text(one(render(pin.unknownKind), ui('pin-popover')))).toContain('MOCK · not live');
      expect(PIN_LABELS.kinds).toEqual({
        mock: 'mock data',
        sandbox: 'test network',
        fixture: 'fixture',
        prior_dataset: 'prior dataset',
      });
      expect(SANDBOX_OBS.provenance).toBe('sandbox');
    });

    it('offers the source line as something to copy', () => {
      const source = one(render(pin.open), ui('pin-source'));
      expect(source.tag).toBe('button');
      expect(text(source)).toContain(sourceLine(LIVE_SPECIMEN));
    });
  });
});
