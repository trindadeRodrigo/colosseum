// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SERIES_FADE } from '../../components/ui/chart';
import { find, fire, mount, press, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { GrowthChart, TripChart } from './ShowcaseChart';
import { TICKERS } from './sample';

// The showcase's two charts with real events: a mouse, a finger and the keyboard each move the
// crosshair to a month and the readout under the chart says that month's figures, every one pinned
// on its sample pin. With nothing pointed at, the same line is the legend: the series' names, and
// pointing at one lights it and dims the rest. Before it is measured a chart is laid
// out 640 wide (happy-dom measures nothing), so a position in the plot is a position in the drawing.

const en = dictionary('en');

afterEach(unmountAll);

const labels = (lang: Lang, chart: string) => {
  const t = dictionary(lang).landing.show;
  return { chart, table: t.chartTable, month: t.month, balance: t.balance };
};

async function trip(lang: Lang = 'en') {
  const t = dictionary(lang).landing.show.trip;
  const host = await mount(
    createElement(TripChart, {
      lang,
      labels: labels(lang, t.chart),
      payout: t.payout,
      parts: t.legs.map((leg) => leg.name(TICKERS.cash)),
    }),
  );
  return host;
}

async function growth(lang: Lang = 'en') {
  const t = dictionary(lang).landing.show.growth;
  return mount(
    createElement(GrowthChart, {
      lang,
      labels: labels(lang, t.chart),
      goal: t.goalLine,
    }),
  );
}

/** The plot, measured as a browser would measure it: 640 by 220 at the top left of the window. */
function plotOf(host: HTMLElement) {
  const plot = find(host, '[data-ui="case-plot"]');
  plot.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 640, height: 220, right: 640, bottom: 220, x: 0, y: 0 }) as DOMRect;
  return plot;
}

const pointer = (type: string, clientX: number, pointerType: 'mouse' | 'touch' = 'mouse') =>
  new PointerEvent(type, { clientX, clientY: 100, pointerType, pointerId: 1, bubbles: true });

/** A pointer that comes in from outside, or goes out to it: React reads enter and leave from these. */
const over = (el: Element) =>
  fire(el, new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }));
const out = (el: Element, pointerType: 'mouse' | 'touch' = 'mouse') =>
  fire(
    el,
    new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerType }),
  );

const readout = (host: HTMLElement) => find(host, '[data-ui="chart-readout"]');
/** What the line says with nothing pointed at: the legend's names, then how to point (for a screen reader). */
const idle = (host: HTMLElement) => {
  const line = readout(host);
  const names = [...line.querySelectorAll('[data-ui="case-legend"] li')].map(
    (li) => li.textContent,
  );
  return { names, hint: line.querySelector('.sr-only')?.textContent ?? null };
};
/** The centre of a month's bar on the trip chart, 640 wide: 44px of axis, then 30 bars. */
const tripBar = (i: number) => 44 + ((640 - 54) / 30) * (i + 0.5);

describe('the trip chart', () => {
  it('reads out the month under a mouse: the balance by part and what was put in, each on its sample pin', async () => {
    const host = await trip();
    const plot = plotOf(host);
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
    expect(readout(host).getAttribute('aria-live')).toBe('polite');
    await fire(plot, pointer('pointermove', tripBar(0)));
    const text = readout(host).textContent;
    // $107 at the end of the first month: 15% cash, 55% treasuries, 30% lending
    expect(text).toContain('Oct 2026');
    expect(text).toContain('Cash buffer (USDC)$16');
    expect(text).toContain('Tokenized treasuries$59');
    expect(text).toContain('Dollar lending$32');
    expect(text).toContain(`${en.landing.show.readout.putIn} $106`);
    const pins = [...readout(host).querySelectorAll('[data-ui="figure"]')];
    expect(pins).toHaveLength(4);
    expect(pins.map((p) => p.getAttribute('data-state'))).toEqual(pins.map(() => 'mock'));
    expect(hatchProblems(parse(readout(host).outerHTML))).toEqual([]);
    expect(host.querySelectorAll('[data-ui="chart-cross"]')).toHaveLength(1);
    // a trip month pays out
    await fire(plot, pointer('pointermove', tripBar(27)));
    expect(readout(host).textContent).toContain('Jan 2029');
    expect(readout(host).textContent).toContain(`${en.landing.show.readout.paidOut} $1,000`);
    // the mouse leaves: nothing is pointed at
    await out(plot);
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
    expect(host.querySelectorAll('[data-ui="chart-cross"]')).toHaveLength(0);
  });

  it('follows a finger that taps and drags, and keeps the month where it lifts', async () => {
    const host = await trip();
    const plot = plotOf(host);
    expect(plot.style.touchAction).toBe('pan-y pinch-zoom');
    // a finger that only passes over the plot (a scroll) moves nothing
    await fire(plot, pointer('pointermove', tripBar(3), 'touch'));
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
    await fire(plot, pointer('pointerdown', tripBar(5), 'touch'));
    expect(readout(host).textContent).toContain('Mar 2027');
    await fire(plot, pointer('pointermove', tripBar(6), 'touch'));
    expect(readout(host).textContent).toContain('Apr 2027');
    await fire(plot, pointer('pointerup', tripBar(6), 'touch'));
    await out(plot, 'touch');
    expect(readout(host).textContent).toContain('Apr 2027');
    // lifted: a later pass does not drag it
    await fire(plot, pointer('pointermove', tripBar(9), 'touch'));
    expect(readout(host).textContent).toContain('Apr 2027');
  });

  it('lets go when the browser takes a touch over to scroll the page', async () => {
    const host = await trip();
    const plot = plotOf(host);
    await fire(plot, pointer('pointerdown', tripBar(5), 'touch'));
    expect(readout(host).textContent).toContain('Mar 2027');
    await fire(plot, pointer('pointercancel', tripBar(5), 'touch'));
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
    expect(host.querySelectorAll('[data-ui="chart-cross"]')).toHaveLength(0);
    // and a later pass does not drag it back
    await fire(plot, pointer('pointermove', tripBar(9), 'touch'));
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
  });

  it('takes the crosshair away when focus leaves the plot', async () => {
    const host = await trip();
    const plot = plotOf(host);
    await press(plot, 'End');
    expect(readout(host).textContent).toContain('Mar 2029');
    await fire(plot, new FocusEvent('focusout', { bubbles: true }));
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
  });

  it('is one tab stop the arrow keys step month by month, Home and End to the ends, Escape away', async () => {
    const host = await trip();
    const plot = plotOf(host);
    expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(plot.getAttribute('tabindex')).toBe('0');
    expect(plot.getAttribute('aria-label')).toBe(en.landing.show.trip.chart);
    await press(plot, 'End');
    expect(readout(host).textContent).toContain('Mar 2029');
    await press(plot, 'ArrowLeft');
    expect(readout(host).textContent).toContain('Feb 2029');
    await press(plot, 'ArrowRight');
    await press(plot, 'ArrowRight');
    expect(readout(host).textContent).toContain('Mar 2029');
    await press(plot, 'Home');
    expect(readout(host).textContent).toContain('Oct 2026');
    await press(plot, 'Escape');
    expect(idle(host).hint).toBe(en.landing.show.readout.hint);
  });

  it('lights the part the legend points at and dims the others', async () => {
    const host = await trip();
    const items = [...host.querySelectorAll('[data-ui="case-legend"] li')];
    expect(items).toHaveLength(3);
    const opacity = (id: string) =>
      [...host.querySelectorAll(`rect[data-series="${id}"]`)].map((r) => r.getAttribute('opacity'));
    expect(new Set(opacity('part-1'))).toEqual(new Set(['1']));
    await over(items[1] as Element);
    expect(new Set(opacity('part-2'))).toEqual(new Set(['1']));
    expect(new Set(opacity('part-1'))).toEqual(new Set(['0.25']));
    expect(new Set(opacity('part-3'))).toEqual(new Set(['0.25']));
    await out(items[1] as Element);
    expect(new Set(opacity('part-1'))).toEqual(new Set(['1']));
  });

  it('says its figures in the reader’s language', async () => {
    const host = await trip('pt');
    const plot = plotOf(host);
    expect(idle(host).hint).toBe(dictionary('pt').landing.show.readout.hint);
    await press(plot, 'Home');
    const text = readout(host).textContent ?? '';
    expect(text).toMatch(/out\.? de 2026/);
    expect(text).toContain('US$');
    expect(text).toContain(dictionary('pt').landing.show.readout.putIn);
  });
});

describe('the mountain chart', () => {
  it('reads out the base, weak and strong cases against the goal, on sample pins, and lights the range', async () => {
    const host = await growth();
    const plot = plotOf(host);
    await press(plot, 'End');
    const text = readout(host).textContent;
    expect(text).toContain('Dec 2031');
    expect(text).toContain('base case$37,484');
    expect(text).toContain('weak case$29,417');
    expect(text).toContain('strong case$47,763');
    expect(text).toContain('goal$35,000');
    const pins = [...readout(host).querySelectorAll('[data-ui="figure"]')];
    expect(pins.map((p) => p.getAttribute('data-state'))).toEqual(['mock', 'mock', 'mock', 'mock']);
    // a point every third month: the crosshair snaps to the nearest
    await fire(plot, pointer('pointermove', 50));
    expect(readout(host).textContent).toContain('Oct 2026');
    // the mouse leaves the plot: the line is the legend again, in the same place
    await out(plot);
    expect(idle(host).names).toEqual([
      en.landing.show.readout.base,
      en.landing.show.readout.range,
      en.landing.show.readout.goal,
    ]);
    const range = find(host, '[data-ui="case-legend"] li[data-series="range"]');
    await over(range);
    expect(find(host, 'path[data-series="base"]').getAttribute('opacity')).toBe('0.25');
    expect(find(host, 'g[data-series="range"]').getAttribute('opacity')).toBe('1');
    expect(find(host, 'g[data-series="goal"]').getAttribute('opacity')).toBe('0.25');
  });
});

describe('both charts', () => {
  it('fade a series only where the reader allows motion', async () => {
    expect(SERIES_FADE.split(' ').every((c) => c.startsWith('motion-safe:'))).toBe(true);
    const host = await trip();
    const bars = [...host.querySelectorAll('rect[data-series]')];
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.getAttribute('class')).toBe(SERIES_FADE);
  });

  for (const lang of ['en', 'pt'] as const)
    it(`leave room on the left for every value on the axis, in ${lang === 'en' ? 'English' : 'Portuguese'}`, async () => {
      for (const host of [await trip(lang), await growth(lang)]) {
        const ticks = [...host.querySelectorAll('svg text[text-anchor="end"]')];
        expect(ticks.length).toBeGreaterThan(2);
        for (const tick of ticks) {
          const end = Number(tick.getAttribute('x'));
          // set in mono at 10px, 0.6 em a character, ending at x
          const start = end - (tick.textContent ?? '').length * 6;
          expect(start, tick.textContent ?? '').toBeGreaterThanOrEqual(0);
        }
      }
    });
});

describe('the words of a chart', () => {
  /** A text's box, as the 10px mono face sets it: about 6.2px a character, 10px tall. */
  const textBox = (t: SVGTextElement) => {
    const x = Number(t.getAttribute('x'));
    const y = Number(t.getAttribute('y'));
    const w = (t.textContent ?? '').length * 6.2;
    const anchor = t.getAttribute('text-anchor') ?? 'start';
    const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    return { left, right: left + w, top: y - 10, bottom: y + 2 };
  };
  const rectBox = (r: Element) => {
    const x = Number(r.getAttribute('x'));
    const y = Number(r.getAttribute('y'));
    return {
      left: x,
      right: x + Number(r.getAttribute('width')),
      top: y,
      bottom: y + Number(r.getAttribute('height')),
    };
  };
  type Box = ReturnType<typeof rectBox>;
  const meet = (a: Box, b: Box) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  async function at(width: number, draw: () => Promise<HTMLElement>) {
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => width,
    });
    try {
      const host = await draw();
      return host;
    } finally {
      if (was) Object.defineProperty(HTMLElement.prototype, 'clientWidth', was);
    }
  }

  for (const lang of ['en', 'pt'] as const)
    for (const width of [300, 700])
      it(`never sets a word on a bar of the trip chart (${lang}, ${width} wide)`, async () => {
        const host = await at(width, () => trip(lang));
        const svg = find(host, '[data-chart="trip"] svg');
        expect(svg.getAttribute('viewBox')).toBe(`0 0 ${width} 232`);
        const bars = [...svg.querySelectorAll('rect[data-series]')].map(rectBox);
        expect(bars.length).toBeGreaterThan(0);
        const words = [...svg.querySelectorAll<SVGTextElement>('text')];
        const note = svg.querySelector<SVGTextElement>('[data-ui="chart-note"]');
        expect(note?.textContent).toBe(dictionary(lang).landing.show.trip.payout);
        for (const word of words) {
          const box = textBox(word);
          expect(
            bars.some((bar) => meet(box, bar)),
            `"${word.textContent}" on a bar`,
          ).toBe(false);
          // and on the drawing, not off its edge
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(width);
        }
        // the payout's words sit in the band above the tallest bar
        const top = Math.min(...bars.map((b) => b.top));
        expect(textBox(note as SVGTextElement).bottom).toBeLessThanOrEqual(top);
        await unmountAll();
      });

  for (const lang of ['en', 'pt'] as const)
    it(`keeps the goal's words above the plot of the growth chart (${lang})`, async () => {
      const host = await at(300, () => growth(lang));
      const svg = find(host, '[data-chart="growth"] svg');
      const notes = [...svg.querySelectorAll<SVGTextElement>('[data-ui="chart-note"]')];
      expect(notes.map((n) => n.textContent)).toEqual([
        dictionary(lang).landing.show.growth.goalLine,
      ]);
      // the band: above the highest grid line, where nothing else is drawn
      const lines = [...svg.querySelectorAll('line[stroke="var(--border)"]')].map((l) =>
        Number(l.getAttribute('y1')),
      );
      for (const n of notes) expect(textBox(n).bottom).toBeLessThanOrEqual(Math.min(...lines));
      // no word marks the weak case inside the plot: the line under the chart names it
      expect(svg.textContent).not.toContain(dictionary(lang).landing.show.readout.weak);
      await unmountAll();
    });
});
