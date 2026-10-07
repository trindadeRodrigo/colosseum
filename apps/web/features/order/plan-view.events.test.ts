// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { find, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { PlanView, type PlanViewHolding } from './PlanView';

// PlanView with more holdings than a bar shows: the table, and its yield column.

const en = dictionary('en');
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

describe('the table of a plan with more than four holdings', () => {
  it('has a yield column when some holding has a yield: pinned where there is one, empty where there is none', async () => {
    const host = await view([
      row('usdy', { yield: { lowPct: 4.2, highPct: 4.2, obs: OBS } }),
      row('syrupusdc', { yield: { lowPct: 5, highPct: 6.5, obs: OBS } }),
      row('spyx'),
      row('nvdax'),
      row('gldx'),
    ]);
    const table = find(host, 'table');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).toEqual([
      en.plan.columns.asset,
      en.plan.columns.share,
      en.plan.columns.yield,
      en.plan.columns.why,
    ]);
    const cells = [...table.querySelectorAll('tbody tr')].map((tr) => tr.children[2] as Element);
    // one figure for equal ends, a range otherwise, each with its pin
    expect(cells[0]?.textContent).toContain('4.20%');
    expect(cells[1]?.textContent).toContain('5.00% to 6.50%');
    expect(cells[0]?.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(cells[1]?.querySelector('[data-ui="pin"]')).not.toBeNull();
    // a holding with no yield: an empty cell, never a zero or a dash
    for (const cell of cells.slice(2)) expect(cell.textContent).toBe('');
  });

  it('has no yield column when no holding has one, as a goal’s plan has none', async () => {
    const host = await view(['a', 'b', 'c', 'd', 'e'].map((a) => row(a)));
    const heads = [...find(host, 'table').querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).not.toContain(en.plan.columns.yield);
  });
});
