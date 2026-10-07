// @vitest-environment happy-dom
import type { BasketCard } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { find, fire, mount, press, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { PlanChart } from './PlanChart';
import { planOn } from './test/fixtures';

// The chart of what a dollar yield projects, on its own. A goal's plan draws it only where the plan
// pays its yield out (gate INVEST-TWO-PANE, Oct 7: a plan to grow or protect gets no curve), so the
// balance it can draw for a caller that has one is tested here, as it was on the plan's page.

const en = dictionary('en');
const OBS = {
  source: 'a test',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  method: 'fixture',
  provenance: 'sandbox' as const,
};
const drawn = async (card: BasketCard, amountUsd: number) => {
  const host = await mount(
    inLanguage('en', createElement(PlanChart, { amountUsd, card, yieldObs: OBS })),
  );
  await settle();
  return host;
};
afterEach(unmountAll);

describe('the chart of a dollar yield', () => {
  it('reads a month of the chart out under a crosshair: the keyboard, a mouse, a finger, and its legend', async () => {
    const chart = find(await drawn(planOn().proposal.card, 40_000), '[data-ui="plan-chart"]');
    const plot = find(chart, '[data-ui="case-plot"]');
    const readout = () => find(chart, '[data-ui="chart-readout"]');
    expect(plot.getAttribute('tabindex')).toBe('0');
    expect(readout().getAttribute('aria-live')).toBe('polite');
    expect(readout().textContent).toBe(en.plan.chart.hint);
    // $40,000 for 36 months at 1% to 2% a year
    await press(plot, 'End');
    expect(readout().textContent).toContain(en.plan.chart.month(36));
    expect(readout().textContent).toContain(`${en.plan.chart.high}$42,400`);
    expect(readout().textContent).toContain(`${en.plan.chart.low}$41,200`);
    // each figure on the plan's own yield pin, as the figure under the chart
    const pins = [...readout().querySelectorAll('[data-ui="figure"]')];
    const under = find(chart, 'figcaption [data-ui="figure"]');
    expect(pins.map((p) => p.getAttribute('data-state'))).toEqual([
      under.getAttribute('data-state'),
      under.getAttribute('data-state'),
    ]);
    await press(plot, 'Home');
    expect(readout().textContent).toContain(en.plan.chart.month(0));
    await press(plot, 'ArrowRight');
    expect(readout().textContent).toContain(`${en.plan.chart.month(1)}`);
    await press(plot, 'Escape');
    expect(readout().textContent).toBe(en.plan.chart.hint);
    // a mouse half way along, 640 wide: month 18 of 36
    plot.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 640,
        height: 200,
        right: 640,
        bottom: 200,
        x: 0,
        y: 0,
      }) as DOMRect;
    const middle = 56 + (640 - 56 - 70) / 2;
    await fire(
      plot,
      new PointerEvent('pointermove', {
        clientX: middle,
        clientY: 50,
        pointerType: 'mouse',
        bubbles: true,
      }),
    );
    expect(readout().textContent).toContain(en.plan.chart.month(18));
    expect(readout().textContent).toContain(`${en.plan.chart.high}$41,200`);
    expect(readout().textContent).toContain(`${en.plan.chart.low}$40,600`);
    // a finger taps
    await fire(
      plot,
      new PointerEvent('pointerdown', {
        clientX: 56,
        clientY: 50,
        pointerType: 'touch',
        bubbles: true,
      }),
    );
    expect(readout().textContent).toContain(en.plan.chart.month(0));
    // the legend lights the line it names
    const low = find(chart, '[data-ui="case-legend"] li[data-series="low"]');
    await fire(
      low,
      new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }),
    );
    expect(find(chart, 'g[data-series="high"]').getAttribute('opacity')).toBe('0.25');
    expect(find(chart, 'g[data-series="low"]').getAttribute('opacity')).toBe('1');
  });

  it('draws the balance from the range it is given, pinned to its yield', async () => {
    const chart = find(await drawn(planOn().proposal.card, 40_000), '[data-ui="plan-chart"]');
    // $40,000 for 36 months at 1% to 2% a year: $41,200 to $42,400, and nothing else worked out
    expect(chart.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      en.plan.chart.label(36, '1%', '2%'),
    );
    const pin = find(chart, '[data-ui="figure"]');
    expect(pin.textContent).toContain('$41,200 – $42,400');
    expect(pin.getAttribute('data-state')).toBe('mock');
    expect(chart.textContent).toContain(en.plan.chart.note);
  });

  it('says a short or flat plan in a sentence on its pin, instead of a flat chart', async () => {
    const card = planOn().proposal.card;
    const host = await drawn(
      {
        ...card,
        termMonths: 2,
        expectedReturn: { ...card.expectedReturn, lowPct: 4.5, highPct: 4.8 },
      },
      200,
    );
    const chart = find(host, '[data-ui="plan-chart"]');
    expect(chart.getAttribute('data-kind')).toBe('short');
    expect(chart.querySelector('[data-ui="case-plot"]')).toBeNull();
    expect(find(chart, 'figcaption').textContent).toContain(
      // $200 at 4.5% to 4.8% a year for 2 months: both ends round to $202, so they are told to the cent
      `${en.plan.short('2 months')}${en.plan.shortRange('$201.50', '$201.60')}`,
    );
    expect(chart.querySelector('[data-ui="figure"]')).not.toBeNull();
  });

  it('draws one tick per dollar label when two values round the same', async () => {
    const card = planOn().proposal.card;
    // $100 for 6 months at up to 2% a year: the middle ($100.50) and the end ($101) both read $101
    const host = await drawn(
      { ...card, termMonths: 6, expectedReturn: { ...card.expectedReturn, lowPct: 1, highPct: 2 } },
      100,
    );
    const ticks = [...host.querySelectorAll('[data-ui="plan-chart"] svg text')]
      .map((t) => t.textContent)
      .filter((s) => s?.startsWith('$'));
    expect(ticks).toEqual(['$100', '$101']);
  });
});
