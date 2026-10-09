// @vitest-environment happy-dom

import type { ChainId } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { BearingProvider } from './BearingProvider';
import { BearingShell } from './BearingShell';
import { DexPage } from './DexPage';
import { LendingPage } from './LendingPage';
import { inPortuguese, NOW } from './test/cases';
import { snapshotReader } from './test/snapshot';

// Bearing per chain, as a person uses it: the toggle at the top, the address that names the chain, its
// own memory of the last choice, and what a page says where Robinhood Chain has nothing collected yet.

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/analytics/stocks',
  useRouter: () => router,
}));
vi.mock('next/link', async () => {
  const { createElement: h } = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
      h('a', { href, ...rest }, children as never),
  };
});

beforeEach(() => {
  localStorage.clear();
  router.replace.mockClear();
  window.history.replaceState(null, '', '/analytics/stocks');
});
afterEach(unmountAll);

async function until(host: HTMLElement, done: (h: HTMLElement) => boolean) {
  for (let i = 0; i < 300 && !done(host); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  if (!done(host)) throw new Error('the page never got there');
}
/** Whether the page has come, every figure of its own read for this chain. */
const reads = (host: HTMLElement, chain: ChainId) => {
  const figs = [...host.querySelectorAll('[data-ui="bearing-fig"]')].filter(
    (f) => !f.closest('[data-ui="bearing-chains"]'),
  );
  return (
    host.querySelector('[data-ui="waiting"]') == null &&
    host.querySelectorAll('[data-ui="bearing-kpi"]').length === 5 &&
    figs.length > 0 &&
    figs.every((f) => f.getAttribute('data-chain') === chain)
  );
};
/**
 * The chain tags on the page outside the chains side by side. The page is of one chain and its switch
 * says which (gate CHAIN-EVERYWHERE, as amended): no counter, card or row repeats it.
 */
const tags = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="chain-badge"]')]
    .filter((b) => !b.closest('[data-ui="bearing-chains"]'))
    .map((b) => b.textContent);
const onStocks = (reader = snapshotReader()) =>
  createElement(
    BearingProvider,
    { reader, now: NOW } as never,
    createElement(BearingShell, null, createElement(DexPage, { page: 'stocks' })),
  );

describe('the chain toggle', () => {
  it('starts on Solana, names it in the address, and reads Solana’s routes as before', async () => {
    const reader = snapshotReader();
    const host = await mount(onStocks(reader));
    await until(host, (h) => reads(h, 'solana'));
    const pressed = find(host, '[data-ui="bearing-chain"] button[aria-pressed="true"]');
    expect(pressed.textContent).toBe('Solana');
    expect(router.replace).toHaveBeenCalledWith('/analytics/stocks?chain=solana');
    expect(host.querySelectorAll('[data-ui="bearing-kpi"]').length).toBe(5);
    expect(tags(host)).toEqual([]);
    expect(reader.read).toContain('/risk/assets?tau=0.01');
    expect(reader.read.some((p) => p.includes('chain=robinhood'))).toBe(false);
  });

  it('moves every figure to Robinhood Chain, names it in the address and remembers it', async () => {
    const reader = snapshotReader();
    const host = await mount(onStocks(reader));
    await until(host, (h) => reads(h, 'solana'));
    const rh = [...host.querySelectorAll('[data-ui="bearing-chain"] button')].find(
      (b) => b.textContent === 'Robinhood Chain',
    ) as HTMLButtonElement;
    await click(rh);
    expect(router.replace).toHaveBeenLastCalledWith('/analytics/stocks?chain=robinhood');
    // kept for these pages, and not as the chain the rest of the app is on
    expect(localStorage.getItem('tf-bearing-chain')).toBe('robinhood');
    expect(localStorage.getItem('tf-chain')).toBeNull();
    await until(host, (h) => reads(h, 'robinhood'));
    expect(reader.read).toContain('/risk/assets?tau=0.01&chain=robinhood');
    expect(host.querySelectorAll('[data-ui="bearing-kpi"]').length).toBe(5);
    expect(tags(host)).toEqual([]);
    // its pools are not in the registry: the pool TVL says so quietly, with no figure and no chain's
    // name (the switch says it), and "TVL by pool" says it once
    const tvl = host.querySelector('[data-ui="bearing-kpi"]');
    expect(tvl?.querySelector('[data-ui="bearing-reason"]')?.textContent).toBe('not collected yet');
    expect(find(host, '[data-ui="bearing-pie"]').textContent).toBe('TVL by poolnot collected yet');
    for (const r of host.querySelectorAll('[data-ui="bearing-reason"]'))
      expect(r.textContent).not.toContain('Robinhood Chain');
    expect(tvl?.querySelector('[data-ui="bearing-fig"]')).toBeNull();
    // its stocks; read by address, never by a Solana symbol
    const rows = [...host.querySelectorAll('section[aria-labelledby="bearing-table"] tbody tr')];
    expect(rows.map((r) => r.querySelector('th a')?.textContent)).toEqual(['NVDA']);
    expect(reader.read).toContain(
      '/risk/assets/0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC/history?days=30&tau=0.01',
    );
    // every figure's pin names the chain, but the side-by-side view's, which name their own
    for (const f of host.querySelectorAll('[data-ui="bearing-fig"]'))
      if (!f.closest('[data-ui="bearing-chains"]'))
        expect(f.getAttribute('data-chain')).toBe('robinhood');
  });

  it('says the same in Portuguese: no tag, and what is missing names no chain', async () => {
    window.history.replaceState(null, '', '/analytics/stocks?chain=robinhood');
    const host = await mount(inPortuguese(onStocks()));
    await until(host, (h) => reads(h, 'robinhood'));
    expect(find(host, '[data-ui="bearing-chain"] button[aria-pressed="true"]').textContent).toBe(
      'Robinhood Chain',
    );
    expect(tags(host)).toEqual([]);
    const tvl = host.querySelector('[data-ui="bearing-kpi"]');
    expect(tvl?.querySelector('[data-ui="bearing-reason"]')?.textContent).toBe(
      'ainda não coletado',
    );
    for (const r of host.querySelectorAll('[data-ui="bearing-reason"]'))
      expect(r.textContent).not.toContain('Robinhood Chain');
  });

  it('opens on the chain the address names', async () => {
    window.history.replaceState(null, '', '/analytics/stocks?chain=robinhood');
    const host = await mount(onStocks());
    await until(host, (h) => reads(h, 'robinhood'));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('with none named, opens on the chain chosen here last, and names it', async () => {
    localStorage.setItem('tf-bearing-chain', 'robinhood');
    const host = await mount(onStocks());
    await until(host, (h) => reads(h, 'robinhood'));
    expect(router.replace).toHaveBeenCalledWith('/analytics/stocks?chain=robinhood');
  });

  it('does not open on the chain the rest of the app was last on', async () => {
    localStorage.setItem('tf-chain', 'robinhood');
    const reader = snapshotReader();
    const host = await mount(onStocks(reader));
    await until(host, (h) => reads(h, 'solana'));
    expect(router.replace).toHaveBeenCalledWith('/analytics/stocks?chain=solana');
    expect(reader.read.some((p) => p.includes('chain=robinhood'))).toBe(false);
  });

  it('reads at once: it waits for no account', async () => {
    const reader = snapshotReader();
    const host = await mount(onStocks(reader));
    await until(host, (h) => reads(h, 'solana'));
    expect(reader.read.filter((p) => p.startsWith('/risk/assets?'))).toEqual([
      '/risk/assets?tau=0.01',
    ]);
  });
});

describe('a page Robinhood Chain has nothing collected for', () => {
  it('says so, and reads no lending route', async () => {
    window.history.replaceState(null, '', '/analytics/lending?chain=robinhood');
    const reader = snapshotReader();
    const host = await mount(
      createElement(BearingProvider, { reader, now: NOW } as never, createElement(LendingPage)),
    );
    await until(host, (h) => h.querySelector('[data-ui="bearing-not-on-chain"]') != null);
    expect(find(host, '[data-ui="bearing-not-on-chain"]').textContent).toBe(
      'Not collected yet on Robinhood Chain: Bearing measures this page on Solana only for now.',
    );
    expect(reader.read.some((p) => p.startsWith('/risk/facts/lending'))).toBe(false);
  });
});

describe('the chains side by side', () => {
  it('gives each chain its row, each figure its pin or the reason it is missing', async () => {
    const host = await mount(onStocks());
    await until(
      host,
      (h) => h.querySelectorAll('[data-ui="bearing-chains"] tbody tr').length === 2,
    );
    const rows = [...host.querySelectorAll('[data-ui="bearing-chains"] tbody tr')];
    expect(rows.map((r) => r.querySelector('[data-ui="chain-badge"]')?.textContent)).toEqual([
      'Solana',
      'Robinhood Chain',
    ]);
    const rh = rows[1] as Element;
    // the row is headed by its chain, so a figure it lacks does not name it again
    expect(rh.textContent).toContain('not collected yet');
    expect(rh.textContent?.split('Robinhood Chain').length).toBe(2);
    // figures of the Robinhood row carry Robinhood Chain in their pins, on a page read for Solana
    const figs = [...rh.querySelectorAll('[data-ui="bearing-fig"]')];
    expect(figs.length).toBe(2);
    for (const f of figs) expect(f.getAttribute('data-chain')).toBe('robinhood');
    // no figure without a pin, no missing figure without a reason: four cells a row
    for (const r of rows)
      expect(r.querySelectorAll('[data-ui="bearing-fig"], [data-ui="bearing-reason"]').length).toBe(
        4,
      );
  });
});
