// @vitest-environment happy-dom

import type { ChainId } from '@colosseum/schemas';
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { BearingProvider } from './BearingProvider';
import { BearingShell } from './BearingShell';
import { DexPage } from './DexPage';
import { LendingPage } from './LendingPage';
import { NOW } from './test/cases';
import { snapshotReader } from './test/snapshot';

// Bearing per chain, as a person uses it: the toggle at the top, the address that names the chain, the
// bar it follows, and what a page says where Robinhood Chain has nothing collected yet.

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
const badges = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="bearing-kpi"] [data-ui="chain-badge"]')].map(
    (b) => b.textContent,
  );
const onStocks = (reader = snapshotReader(), barChain?: ChainId | null) =>
  createElement(
    BearingProvider,
    { reader, now: NOW, barChain } as never,
    createElement(BearingShell, null, createElement(DexPage, { page: 'stocks' })),
  );

describe('the chain toggle', () => {
  it('starts on Solana, names it in the address, and reads Solana’s routes as before', async () => {
    const reader = snapshotReader();
    const host = await mount(onStocks(reader));
    await until(host, (h) => badges(h).length === 5);
    const pressed = find(host, '[data-ui="bearing-chain"] button[aria-pressed="true"]');
    expect(pressed.textContent).toBe('Solana');
    expect(router.replace).toHaveBeenCalledWith('/analytics/stocks?chain=solana');
    expect(badges(host)).toEqual(Array(5).fill('Solana'));
    expect(reader.read).toContain('/risk/assets?tau=0.01');
    expect(reader.read.some((p) => p.includes('chain=robinhood'))).toBe(false);
  });

  it('moves every figure to Robinhood Chain, names it in the address and remembers it', async () => {
    const reader = snapshotReader();
    const host = await mount(onStocks(reader));
    await until(host, (h) => badges(h).length === 5);
    const rh = [...host.querySelectorAll('[data-ui="bearing-chain"] button')].find(
      (b) => b.textContent === 'Robinhood Chain',
    ) as HTMLButtonElement;
    await click(rh);
    expect(router.replace).toHaveBeenLastCalledWith('/analytics/stocks?chain=robinhood');
    expect(localStorage.getItem('tf-chain')).toBe('robinhood');
    await until(host, (h) => badges(h).length === 5 && badges(h)[0] === 'Robinhood Chain');
    expect(reader.read).toContain('/risk/assets?tau=0.01&chain=robinhood');
    expect(badges(host)).toEqual(Array(5).fill('Robinhood Chain'));
    // its pools are not in the registry: the pool TVL says so, by the chain's name, with no figure
    const tvl = host.querySelector('[data-ui="bearing-kpi"]');
    expect(tvl?.textContent).toContain('not collected yet on Robinhood Chain');
    expect(tvl?.querySelector('[data-ui="bearing-fig"]')).toBeNull();
    // its stocks, each row naming its chain; read by address, never by a Solana symbol
    const rows = [...host.querySelectorAll('section[aria-labelledby="bearing-table"] tbody tr')];
    expect(rows.map((r) => r.querySelector('th a')?.textContent)).toEqual(['NVDA']);
    for (const r of rows)
      expect(r.querySelector('[data-ui="chain-badge"]')?.textContent).toBe('Robinhood Chain');
    expect(reader.read).toContain(
      '/risk/assets/0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC/history?days=30&tau=0.01',
    );
    // every figure's pin names the chain, but the side-by-side view's, which name their own
    for (const f of host.querySelectorAll('[data-ui="bearing-fig"]'))
      if (!f.closest('[data-ui="bearing-chains"]'))
        expect(f.getAttribute('data-chain')).toBe('robinhood');
  });

  it('opens on the chain the address names', async () => {
    window.history.replaceState(null, '', '/analytics/stocks?chain=robinhood');
    const host = await mount(onStocks());
    await until(host, (h) => badges(h)[0] === 'Robinhood Chain');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('with none named, opens on the chain this browser was last on, and names it', async () => {
    localStorage.setItem('tf-chain', 'robinhood');
    const host = await mount(onStocks());
    await until(host, (h) => badges(h)[0] === 'Robinhood Chain');
    expect(router.replace).toHaveBeenCalledWith('/analytics/stocks?chain=robinhood');
  });

  it('follows the app’s bar when its chain changes', async () => {
    let switchTo: (c: ChainId) => void = () => {};
    function Bar() {
      const [bar, setBar] = useState<ChainId>('solana');
      switchTo = setBar;
      return onStocks(snapshotReader(), bar);
    }
    const host = await mount(createElement(Bar));
    await until(host, (h) => badges(h)[0] === 'Solana');
    await act(async () => switchTo('robinhood'));
    await until(host, (h) => badges(h)[0] === 'Robinhood Chain');
    expect(router.replace).toHaveBeenLastCalledWith('/analytics/stocks?chain=robinhood');
    expect(localStorage.getItem('tf-chain')).toBe('robinhood');
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
    expect(rh.textContent).toContain('not collected yet on Robinhood Chain');
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
