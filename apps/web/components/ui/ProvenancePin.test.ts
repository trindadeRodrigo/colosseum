import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { FIGURE, LIVE_SPECIMEN, MOCK_OBS, SANDBOX_OBS, STALE_SPECIMEN } from './fixtures/mock';
import {
  kindWords,
  PIN_LABELS,
  type PinSource,
  pinLabel,
  pinState,
  sourceLine,
  staleWords,
} from './provenance';
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

    it('does not count spaces as a source or a method', () => {
      for (const key of ['source', 'method', 'fetchedAt'] as const)
        for (const spaces of [' ', '\t', '\n  '])
          expect(pinState({ ...LIVE_SPECIMEN, [key]: spaces }), key).toBe('missing');
      for (const node of [pin.blankSource, pin.blankMethod])
        expect(text(render(node))).toBe('— no source yet');
    });

    it('does not count a number, a bare date or a time with no zone as the time it was fetched', () => {
      // `Date.parse('1')` is a day in 2001, and a time with no zone is read in the reader's clock
      for (const fetchedAt of ['1', '2026', '2026-10-01', '2026-10-01T14:02:11', '14:02'])
        expect(pinState({ ...LIVE_SPECIMEN, fetchedAt }), fetchedAt).toBe('missing');
      for (const node of [pin.numberTime, pin.zonelessTime]) {
        expect(text(render(node))).toBe('— no source yet');
        expect(text(render(node))).not.toContain('2001');
      }
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
        const outline = all(svg, tag('rect'))[0] as ReturnType<typeof one>;
        expect(outline.attrs).toMatchObject({
          x: '0.75',
          y: '0.75',
          width: '16.5',
          height: '10.5',
          rx: '2.5',
        });
        // the logo's tenon end in line mode: no circle anywhere (LOGO-2: the pin is square)
        expect(all(svg, tag('circle'))).toHaveLength(0);
        expect(outline.attrs.stroke).toBe('var(--tf-pin-outline)');
        expect(outline.attrs['stroke-width']).toBe('1.5');
        expect(outline.attrs.fill).toBe('none');
      }
    });

    it('live: a solid square pin, 4 by 4 with a corner of 1, set toward the end, in honey (honey-l on day)', () => {
      const square = all(glyph(pin.live), tag('rect'))[1];
      expect(square?.attrs).toMatchObject({
        x: '11',
        y: '4',
        width: '4',
        height: '4',
        rx: '1',
        fill: 'var(--tf-pin)',
      });
    });

    it('stale: the same square, hollow, in the pin colour', () => {
      const square = all(glyph(pin.stale), tag('rect'))[1];
      expect(square?.attrs.fill).toBe('none');
      expect(square?.attrs.stroke).toBe('var(--tf-pin)');
      // its outer edge is the live pin's: 11 to 15 and 4 to 8
      const half = Number(square?.attrs['stroke-width']) / 2;
      expect(Number(square?.attrs.x) - half).toBe(11);
      expect(Number(square?.attrs.width) + 2 * half).toBe(4);
    });

    it('MOCK: no pin at all, and a 45° hatch at a 3px pitch inside the outline', () => {
      const svg = glyph(pin.mock);
      // the outline alone: no square pin
      expect(all(svg, tag('rect'))).toHaveLength(1);
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
      expect(label(pin.mock)).toBe('Source for 6.40%, sample figure');
      expect(label(pin.sandbox)).toBe('Source for 6.40%, sample figure');
      expect(label(pin.labelled)).toBe('Source for $12,480');
      expect(pinLabel('1', { ...STALE_SPECIMEN, staleAgeSec: 3600 })).toBe(
        'Source for 1, stale, 1 hour old',
      );
    });

    it('says the age in the view’s language in its name: no English inside a Portuguese one', () => {
      const pt = dictionary('pt').pin;
      const at = (staleAgeSec: number) => pinLabel('6,40%', { ...STALE_SPECIMEN, staleAgeSec }, pt);
      expect(at(13 * 3600)).toBe('Fonte de 6,40%, desatualizado, há 13 horas');
      expect(at(3600)).toBe('Fonte de 6,40%, desatualizado, há 1 hora');
      expect(at(120)).toBe('Fonte de 6,40%, desatualizado, há 2 minutos');
      expect(at(3 * 86_400)).toBe('Fonte de 6,40%, desatualizado, há 3 dias');
      expect(at(13 * 3600)).not.toMatch(/hour|old/);
      // the words are plain data: a server component hands them to the pin, and no function crosses
      for (const lang of ['en', 'pt'] as const)
        expect(JSON.parse(JSON.stringify(dictionary(lang).pin))).toEqual(dictionary(lang).pin);
      // and English says it as it did
      expect(pinLabel('1', { ...STALE_SPECIMEN, staleAgeSec: 7200 }, dictionary('en').pin)).toBe(
        'Source for 1, stale, 2 hours old',
      );
    });

    it('never shows a hollow pin without the word "stale" and the age', () => {
      const root = render(pin.stale);
      expect(text(one(root, ui('stale-tag')))).toBe('stale · 3 h');
      expect(all(render(pin.live), ui('stale-tag'))).toHaveLength(0);
    });

    it('says "age unknown" when the age it is handed is not one, and never prints it', () => {
      for (const staleAgeSec of [Number.NaN, -90, Number.POSITIVE_INFINITY, '3600' as never]) {
        const obs = { ...LIVE_SPECIMEN, staleAgeSec };
        expect(pinState(obs)).toBe('stale'); // the API said stale: it is not shown as live
        expect(staleWords(obs)).toBe('stale · age unknown');
        expect(pinLabel('6.40%', obs)).toBe('Source for 6.40%, stale, age unknown');
      }
      const root = render(pin.staleNoAge);
      expect(text(one(root, ui('stale-tag')))).toBe('stale · age unknown');
      // the popover says it as a sentence, first
      expect(text(one(root, ui('pin-stale')))).toBe('Stale, and its age is not known');
      expect(text(root)).not.toMatch(/NaN|Infinity/);
      expect(all(one(root, ui('pin-glyph')), tag('rect'))[1]?.attrs.fill).toBe('none');
      expect(text(one(render(pin.staleNegative), ui('stale-tag')))).toBe('stale · age unknown');
      // an age of nothing is still an age
      expect(staleWords({ ...LIVE_SPECIMEN, staleAgeSec: 0 })).toBe('stale · 1 min');
    });

    it('shows sample data by its hatched pin and its name, never the word MOCK, never a solid pin', () => {
      for (const node of [pin.mock, pin.sandbox, pin.unknownKind]) {
        const root = render(node);
        expect(one(root, ui('pin-glyph'))).toBeTruthy();
        expect(all(root, (el) => 'data-hatch' in el.attrs)).toHaveLength(1);
        expect(text(root)).not.toContain('MOCK');
        expect(one(root, ui('pin')).attrs['aria-label']).toMatch(/, sample figure$/);
        expect(all(one(root, ui('pin-glyph')), tag('rect'))).toHaveLength(1); // no pin
      }
      expect(all(render(pin.live), (el) => 'data-hatch' in el.attrs)).toHaveLength(0);
    });
  });

  describe('the popover', () => {
    it('is closed until asked for', () => {
      const root = render(pin.live);
      expect(all(root, ui('pin-popover'))).toHaveLength(0);
      expect(one(root, ui('pin')).attrs['aria-expanded']).toBe('false');
    });

    it('says in plain words what the number is, where from, how fresh and whether live', () => {
      const root = render(pin.open);
      const popover = one(root, ui('pin-popover'));
      // no clock on the server: the exact time stands until the browser's is read
      expect(
        all(
          one(popover, ui('pin-summary')),
          (el) => el.tag === 'span' && 'data-ui' in el.attrs,
        ).map((el) => text(el)),
      ).toEqual([
        'From a sample feed',
        'Updated 1 Oct 2026, 14:02:11 UTC',
        'Live',
        FIGURE.rateDetail,
      ]);
      // the API's own words are one step away, never dumped by default (gate TOOLTIP-WORDS)
      expect(all(popover, ui('pin-source'))).toHaveLength(0);
      expect(text(popover)).not.toContain(sourceLine(LIVE_SPECIMEN));
      expect(text(popover)).not.toContain('2026-10-01T14:02:11Z');
      expect(one(popover, ui('pin-details')).attrs['aria-expanded']).toBe('false');
      // words in the UI face on the popover surface; only an address is set in the mono face
      expect(classes(popover)).toEqual(
        expect.arrayContaining([
          'font-sans',
          'text-body-sm',
          'bg-popover',
          'border',
          'border-border',
          'rounded-md',
          'shadow-popover',
        ]),
      );
      expect(classes(popover)).not.toContain('font-mono');
    });

    it('keeps the line the API wrote, the time in ISO 8601 UTC, for the copy', () => {
      expect(sourceLine(LIVE_SPECIMEN)).toBe('sample feed · 2026-10-01T14:02:11Z · haircut v2');
      expect(sourceLine({ ...LIVE_SPECIMEN, fetchedAt: '2026-10-01T11:02:11-03:00' })).toBe(
        'sample feed · 2026-10-01T14:02:11Z · haircut v2',
      );
    });

    it('is a named dialog its pin controls, described by the plain sentences', () => {
      const plain = render(pin.open);
      const popover = one(plain, ui('pin-popover'));
      // it holds controls (Details, copy), so it is a dialog, never a tooltip with buttons in it
      expect(role(popover)).toBe('dialog');
      expect(popover.attrs['aria-label']).toBe('Source details');
      expect(one(plain, ui('pin')).attrs['aria-controls']).toBe(popover.attrs.id);
      expect(one(plain, ui('pin')).attrs['aria-describedby']).toBe(
        one(popover, ui('pin-summary')).attrs.id,
      );
      // closed, the pin points at nothing
      expect(one(render(pin.live), ui('pin')).attrs['aria-describedby']).toBeUndefined();
      const withLink = one(render(pin.openWithDocs), ui('pin-popover'));
      expect(one(withLink, tag('a')).attrs).toMatchObject({
        href: '/risk/methodology',
        rel: 'noopener',
      });
    });

    it('says a stale reading first, and never shows a sample or a test network as live', () => {
      const stale = one(render(pin.openWithDocs), ui('pin-summary'));
      expect(text(all(stale, tag('span'))[0] as never)).toBe(
        'Last updated 3 hours ago, which is stale',
      );
      const sandbox = one(render(pin.sandbox), ui('pin-popover'));
      expect(text(one(sandbox, ui('pin-state')))).toBe('Test network, not live');
      expect(text(one(render(pin.unknownKind), ui('pin-state')))).toBe('Not live');
      expect(text(sandbox)).not.toContain('MOCK');
      expect(text(sandbox)).not.toMatch(/\bLive\b/);
      expect(PIN_LABELS.kinds).toEqual({
        mock: 'Sample figure, not live',
        sandbox: 'Test network, not live',
        fixture: 'Sample figure, not live',
        prior_dataset: 'From an earlier dataset, not live',
      });
      expect(SANDBOX_OBS.provenance).toBe('sandbox');
    });

    it('opens on a provenance named like something every object has, and calls it "not live"', () => {
      for (const node of [pin.inheritedKind, pin.constructorKind]) {
        const root = render(node); // `kinds['__proto__']` is an object: React cannot draw one
        expect(text(one(root, ui('pin-state')))).toBe('Not live');
        expect(all(root, (el) => 'data-hatch' in el.attrs)).toHaveLength(1);
        expect(all(one(root, ui('pin-glyph')), tag('rect'))).toHaveLength(1); // no pin
      }
      for (const odd of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'replayed'])
        expect(kindWords(odd), odd).toBe('Not live');
      for (const odd of [null, undefined, 3, {}]) expect(kindWords(odd)).toBe('Not live');
      expect(kindWords('sandbox')).toBe('Test network, not live');
      expect(
        kindWords('fixture', { ...PIN_LABELS, kinds: { ...PIN_LABELS.kinds, fixture: ' ' } }),
      ).toBe('Not live');
    });
  });
});
