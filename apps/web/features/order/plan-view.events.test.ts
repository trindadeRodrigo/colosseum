// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { find, mount, unmountAll } from '../../components/ui/test/dom';
import { inLanguage } from '../account/test/screen';
import { PlanView, type PlanViewExitTier, type PlanViewHolding } from './PlanView';

// PlanView with more holdings than the wood ramp has colours, and a yield on some of them.

const OBS = {
  source: 'a test',
  fetchedAt: '2026-10-04T12:00:00.000Z',
  method: 'fixture',
  provenance: 'sandbox' as const,
};
const row = (asset: string, over: Partial<PlanViewHolding> = {}): PlanViewHolding => ({
  asset: `solana:${asset}`,
  shareBps: 2000,
  amountUsd: null,
  yield: null,
  why: '',
  ...over,
});
const view = (holdings: PlanViewHolding[]) =>
  mount(
    inLanguage(
      'en',
      createElement(PlanView, {
        title: 'On Solana',
        answer: 'Stocks and dollar yield',
        chain: 'solana',
        provenance: 'sandbox',
        holdings,
        exit: { tiers: [{ text: 'within a day' }] },
      }),
    ),
  );
afterEach(unmountAll);

describe('a plan with more than four holdings', () => {
  it('shows the yield on the row of a holding that has one, pinned, and nothing where there is none', async () => {
    const host = await view([
      row('usdy', { yield: { lowPct: 4.2, highPct: 4.2, obs: OBS } }),
      row('syrupusdc', { yield: { lowPct: 5, highPct: 6.5, obs: OBS } }),
      row('spyx'),
      row('nvdax'),
      row('gldx'),
    ]);
    const rows = [...host.querySelectorAll('[data-ui="plan-rows"] [data-row]')];
    expect(rows).toHaveLength(5);
    const yields = rows.map((r) => r.querySelector('[data-ui="row-yield"]'));
    // one figure for equal ends, a range otherwise, each with its pin
    expect(yields[0]?.textContent).toContain('4.20%');
    expect(yields[1]?.textContent).toContain('5.00% to 6.50%');
    expect(yields[0]?.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(yields[1]?.querySelector('[data-ui="pin"]')).not.toBeNull();
    // a holding with no yield: no line for one, never a zero or a dash
    for (const none of yields.slice(2)) expect(none).toBeNull();
    for (const r of rows.slice(2)) expect(r.textContent).not.toMatch(/0\.00%|—/);
    // a fifth holding takes the first colour of the ramp again
    const parts = [...host.querySelectorAll('[data-ui="plan-bar"] [data-part]')];
    expect(parts.map((p) => p.className.match(/bg-leg-\d/)?.[0])).toEqual([
      'bg-leg-1',
      'bg-leg-2',
      'bg-leg-3',
      'bg-leg-4',
      'bg-leg-1',
    ]);
  });

  it('has no yield on any row when no holding has one, as a goal’s plan has none', async () => {
    const host = await view(['a', 'b', 'c', 'd', 'e'].map((a) => row(a)));
    expect(host.querySelector('[data-ui="row-yield"]')).toBeNull();
    expect(host.querySelector('table')).toBeNull();
  });

  it('draws a meter only for a tier that passes one: none left out, empty for null, filled for a figure', async () => {
    const tiers = (exit: PlanViewExitTier[]) =>
      mount(
        inLanguage(
          'en',
          createElement(PlanView, {
            title: 'On Solana',
            answer: 'Stocks',
            chain: 'solana',
            provenance: 'sandbox',
            holdings: [row('spyx')],
            exit: { tiers: exit },
          }),
        ),
      );
    const cost = { figure: '≤ 1%', obs: OBS };
    // a tier that is its figures: no meter and no scale line
    let host = await tiers([{ text: 'within a day', cost, scale: 'A full bar is 1%.' }]);
    expect(host.querySelector('[data-ui="exit-tier"] [data-ui="meter"]')).toBeNull();
    expect(host.textContent).not.toContain('A full bar is 1%.');
    expect(find(host, '[data-ui="exit-tier"] [data-ui="pin"]')).not.toBeNull();
    await unmountAll();
    host = await tiers([{ text: 'within a day', meter: null }]);
    expect(find(host, '[data-ui="exit-tier"] [data-ui="meter"]').getAttribute('data-empty')).toBe(
      'true',
    );
    await unmountAll();
    host = await tiers([{ text: 'within a day', cost, meter: 0.3, scale: 'A full bar is 1%.' }]);
    const meter = find(host, '[data-ui="exit-tier"] [data-ui="meter"]');
    expect(meter.getAttribute('data-empty')).toBeNull();
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('30%');
    expect(host.textContent).toContain('A full bar is 1%.');
  });
});
