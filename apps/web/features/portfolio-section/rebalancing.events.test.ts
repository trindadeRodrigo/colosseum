// @vitest-environment happy-dom
import { PortfolioRebalancesResponse, type Provenance } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { utc } from '../portfolio/figures';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { PLANS_PATH, REBALANCES_PATH, type RebalancesAnswer } from './api';
import { FAILED_SELL, KEEPER_SPYX, LOOSE, REBALANCES_MORE, SIG_LOOSE } from './fixtures/lists';
import { basisPoints, localTime } from './list-figures';
import { OverviewPage } from './OverviewPage';
import { RebalancingPage } from './RebalancingPage';
import { explorerHref, groupsOf } from './rebalances';
import { held, serve } from './test/api';
import { plans, RH_SILENT, rebalances, SOL_GROW, SOL_INCOME, SOL_STALE } from './test/fixtures';
import { inFrame, inSection } from './test/screen';
import { vaultTitle } from './vault-title';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The rebalancing page with real events, on the sample answers: the steps under their vaults, newest
// first; each saying when, whose, why, what was traded and how it ended, in words and shapes that do
// not lean on colour; every amount and every cost with its pin; a keeper's trade saying it was worked
// out; the transaction on the chain's explorer; and, once, what the list cannot tell. Where the API
// cannot say, a sentence says why and no figure is drawn.

const en = portfolioDictionary('en');
const t = dictionary('en');
const words = en.rebalancing;

const page = async (lang: Lang = 'en') => {
  const host = await mount(inSection(lang, createElement(RebalancingPage)));
  await settle();
  return host;
};
const signIn = (over: Parameters<typeof signedInPort>[1] = {}) =>
  portStore.set(signedInPort(EMBEDDED, over));
const text = (el: Element) => el.textContent ?? '';
const part = (root: Element, ui: string) => text(find(root, `[data-ui="${ui}"]`));
const groups = (host: HTMLElement) => [...host.querySelectorAll('[data-ui="vault-steps"]')];
const group = (host: HTMLElement, vault: string) =>
  find(host, `[data-ui="vault-steps"][data-vault="${vault}"]`);
const steps = (root: Element) => [...root.querySelectorAll('[data-ui="step"]')];
const step = (host: HTMLElement, vault: string, n: number) => {
  const found = steps(group(host, vault))[n];
  if (!found) throw new Error(`no step ${n} of ${vault}`);
  return found;
};
const trades = (root: Element) => [...root.querySelectorAll('[data-ui="trade"]')];
/** The instant a step is dated at. */
const dated = (s: Element) => find(s, '[data-ui="step-when"] time').getAttribute('datetime');
const pins = (root: ParentNode) => [...root.querySelectorAll('[data-ui="figure"]')];
/** A trade's labelled lines, as "term: value". */
const rows = (trade: Element) =>
  [...trade.querySelectorAll('dt')].map(
    (dt) => `${text(dt)}: ${text(dt.nextElementSibling as Element).trim()}`,
  );
const row = (trade: Element, id: string) => find(trade, `dd[data-row="${id}"]`);
/** The sample answer with the page's own three steps, parsed with the contract. */
const more = (): RebalancesAnswer =>
  PortfolioRebalancesResponse.parse(JSON.parse(JSON.stringify(REBALANCES_MORE)));
/** The sample steps with every label set to `provenance`. */
function labelled(provenance: Provenance): RebalancesAnswer {
  const answer = rebalances();
  return {
    ...answer,
    chains: answer.chains.map((chain) => ({
      ...chain,
      provenance,
      entries: chain.entries.map((entry) => ({
        ...entry,
        provenance,
        trades: entry.trades.map((trade) => ({
          ...trade,
          ...(trade.reference ? { reference: { ...trade.reference, provenance } } : {}),
        })),
      })),
    })),
  };
}
const when = (at: string) => localTime('en', at);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = '/portfolio/rebalancing';
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the rebalancing page, for a person with steps on two chains', () => {
  it('asks once for the newest steps and files them under their vaults, the newest vault first', async () => {
    const server = serve(portStore);
    signIn();
    const host = await page();
    expect(server.to(REBALANCES_PATH)).toEqual([`${REBALANCES_PATH}?limit=200`]);
    expect(server.to(PLANS_PATH)).toHaveLength(1);
    // the vault whose newest step is the newest comes first
    expect(groups(host).map((g) => g.getAttribute('data-vault'))).toEqual([
      SOL_INCOME,
      SOL_STALE,
      SOL_GROW,
      RH_SILENT,
    ]);
    // each headed as the overview names the vault: its goal, or what it follows
    expect(groups(host).map((g) => text(find(g, 'h2')))).toEqual([
      'Earn income from $80,000 for 60 months.',
      'Your vault follows Steady dollars.',
      'Grow $2,000 over 36 months.',
      'Your vault was opened to follow US stocks.',
    ]);
    expect(part(group(host, SOL_INCOME), 'vault-note')).toBe('Rent fund');
    expect(group(host, SOL_GROW).querySelector('[data-ui="vault-note"]')).toBeNull();
    expect(groups(host).map((g) => part(g, 'chain-badge'))).toEqual([
      'Solana',
      'Solana',
      'Solana',
      'Robinhood Chain',
    ]);
    expect(groups(host).map((g) => part(g, 'steps-count'))).toEqual([
      '2 steps',
      '2 steps',
      '2 steps',
      '1 step',
    ]);
    // and each leads to its vault's own page, by a link its heading describes
    for (const g of groups(host)) {
      const link = find(g, 'header a');
      expect(link.textContent).toBe(en.overview.card.open);
      expect(link.getAttribute('href')).toBe(
        `/portfolio/plan/${g.getAttribute('data-chain')}/${g.getAttribute('data-vault')}`,
      );
      expect(link.getAttribute('aria-describedby')).toBe(find(g, 'h2').id);
      expect(find(g, 'article').getAttribute('aria-labelledby')).toBe(find(g, 'h2').id);
    }
    // within a vault, the newest step first
    expect(steps(group(host, SOL_INCOME)).map((s) => dated(s))).toEqual([
      '2026-10-07T06:12:40.000Z',
      '2026-10-05T09:29:41.000Z',
    ]);
    expect(steps(group(host, SOL_GROW)).map((s) => s.getAttribute('data-outcome'))).toEqual([
      'confirmed',
      'failed',
    ]);
    expect(steps(host)).toHaveLength(7);
  });

  it('names a vault with the words of the overview’s card, in both languages', async () => {
    for (const lang of ['en', 'pt'] as const) {
      serve(portStore);
      signIn();
      const host = await mount(inSection(lang, createElement(OverviewPage)));
      await settle();
      for (const chain of plans().chains)
        for (const plan of chain.plans) {
          const card = find(host, `[data-ui="overview-vault"][data-address="${plan.address}"]`);
          const title = vaultTitle(plan, {
            t: dictionary(lang),
            words: portfolioDictionary(lang).overview.card,
            lang,
            chainName: chain.chain === 'solana' ? 'Solana' : 'Robinhood Chain',
          });
          expect(title.sentence, plan.address).toBe(text(find(card, '[data-ui="vault-sentence"]')));
          expect(title.notes, plan.address).toEqual(
            [...card.querySelectorAll('[data-ui="plan-note"]')].map(text),
          );
        }
      await unmountAll();
    }
  });

  it('says a step of the person’s own: when it was built, whose, why, each trade, its quote and the share on each side', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const s = step(host, SOL_INCOME, 1);
    const at = '2026-10-05T09:29:41.000Z';
    // the person's own time, saying which zone, and what kind of time it is
    expect(part(s, 'step-when')).toBe(`${when(at)} · ${words.when.built}`);
    expect(find(s, '[data-ui="step-when"] time').getAttribute('title')).toBe(utc('en', at));
    // whose it is and how it ended: a word and a shape each, neither by colour alone
    const by = find(s, '[data-ui="step-by"]');
    expect(text(by)).toBe('Your step');
    expect(find(by, 'svg[data-ui="by-mark"]').getAttribute('data-by')).toBe('owner');
    const outcome = find(s, '[data-ui="step-outcome"]');
    expect(text(outcome)).toBe('Confirmed');
    expect(find(outcome, '[data-ui="status"]').getAttribute('data-status')).toBe('on-track');
    expect(outcome.querySelector('svg[data-ui="status-mark"]')).not.toBeNull();
    expect(part(s, 'step-why')).toBe('You made this step yourself.');
    // the trades in plain words, the asset by its name
    expect(trades(s).map((trade) => part(trade, 'trade-sentence'))).toEqual([
      'Swapped cash (USDC) into USDY (Ondo).',
      'Swapped cash (USDC) into SGOV (iShares).',
    ]);
    const [usdy, sgov] = trades(s) as [Element, Element];
    expect(rows(usdy)).toEqual([
      'Paid: 18,000 USDC',
      'Quoted cost: 4 bps',
      `Before: 0.01% over its planned share · read ${when('2026-10-05T09:20:00.000Z')}`,
      `After: 0.1% over its planned share · read ${when('2026-10-05T09:40:00.000Z')}`,
    ]);
    expect(rows(sgov)).toEqual([
      'Paid: 9,000 USDC',
      'Quoted cost: 6 bps',
      `Before: 0.02% under its planned share · read ${when('2026-10-05T09:20:00.000Z')}`,
      `After: 0.1% over its planned share · read ${when('2026-10-05T09:40:00.000Z')}`,
    ]);
    // the time of each reading is within reach, as an instant
    expect(find(row(usdy, 'share-before'), 'time').getAttribute('datetime')).toBe(
      '2026-10-05T09:20:00.000Z',
    );
    // the cost is said as what it is: the quote the step was built with, once in the step
    expect(part(s, 'step-quote-note')).toBe(words.quoteNote);
    expect(text(s)).not.toContain(words.derived);
    // the transaction on the chain's explorer, with the explorer's name
    const link = find<HTMLAnchorElement>(s, '[data-ui="step-tx"] a[data-ui="explorer-link"]');
    const entry = rebalances().chains[0]?.entries[2];
    expect(link.getAttribute('href')).toBe(`https://solscan.io/tx/${entry?.txId}?cluster=devnet`);
    expect(part(link, 'explorer-name')).toBe('Solscan');
    expect(link.getAttribute('aria-label')).toBe('View transaction 5VER…kQUW on Solscan');
  });

  it('hands the amount and the cost the entry’s own stamp, and nothing of the server’s link', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const s = step(host, SOL_INCOME, 1);
    const entry = rebalances().chains[0]?.entries[2];
    const [usdy] = trades(s) as [Element];
    for (const id of ['put', 'quoted']) {
      const figure = find(row(usdy, id), '[data-ui="figure"]');
      await click(find(figure, 'button[data-ui="pin"]'));
      expect(text(find(figure, '[data-ui="pin-source"]'))).toContain(
        `${entry?.source} · 2026-10-05T09:29:40Z · ${entry?.method}`,
      );
    }
    // the link is made from this app's own chain table: the answer's own is never read
    const other = rebalances();
    for (const chain of other.chains)
      for (const step of chain.entries)
        if (step.explorerUrl) step.explorerUrl = 'https://example.com/elsewhere';
    await unmountAll();
    serve(portStore, { rebalances: () => json(other) });
    const again = await page();
    expect(again.innerHTML).not.toContain('example.com');
    expect(again.querySelectorAll('a[data-ui="explorer-link"]')).toHaveLength(4);
  });

  it('says a step that failed in a word and a shape, as a trade that was tried, with no quote', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const s = step(host, SOL_GROW, 1);
    const outcome = find(s, '[data-ui="step-outcome"]');
    expect(text(outcome)).toBe('Failed');
    expect(find(outcome, '[data-ui="status"]').getAttribute('data-status')).toBe('off-track');
    expect(find(outcome, 'svg[data-ui="status-mark"]').getAttribute('data-status')).toBe(
      'off-track',
    );
    const [trade] = trades(s) as [Element];
    // nothing was bought: the sentence says it was tried, and the amount is the step's, not "paid"
    expect(part(trade, 'trade-sentence')).toBe('Tried to swap cash (USDC) into SPYx.');
    expect(rows(trade)).toEqual(['Amount in the step: 1,000 USDC']);
    // its quote was not kept, so no cost is written and nothing is said about one
    expect(s.querySelector('[data-row="quoted"]')).toBeNull();
    expect(s.querySelector('[data-ui="step-quote-note"]')).toBeNull();
    expect(find(s, 'a[data-ui="explorer-link"]').getAttribute('href')).toContain(
      'https://solscan.io/tx/3Asdo',
    );
    // the attempt after it, which confirmed, is the step above it
    const confirmed = step(host, SOL_GROW, 0);
    expect(part(confirmed, 'step-outcome')).toBe('Confirmed');
    expect(rows(trades(confirmed)[0] as Element)).toEqual([
      'Paid: 1,000 USDC',
      'Quoted cost: 9 bps',
      `After: at its planned share · read ${when('2026-10-03T14:10:00.000Z')}`,
    ]);
  });

  it('says a trade of the keeper’s was worked out from two readings, with no link and no reason made up', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const s = step(host, SOL_INCOME, 0);
    expect(s.getAttribute('data-derived')).toBe('true');
    // the chain's own time of the trade, not a build time
    expect(part(s, 'step-when')).toBe(`${when('2026-10-07T06:12:40.000Z')} · ${words.when.chain}`);
    const by = find(s, '[data-ui="step-by"]');
    expect(text(by)).toBe('Our keeper’s step');
    expect(find(by, 'svg[data-ui="by-mark"]').getAttribute('data-by')).toBe('keeper');
    // the two marks are two shapes
    expect(find(by, 'svg path').getAttribute('d')).not.toBe(
      find(step(host, SOL_INCOME, 1), '[data-ui="by-mark"] path').getAttribute('d'),
    );
    expect(part(s, 'step-outcome')).toBe('Confirmed');
    expect(part(s, 'step-why')).toBe('No reason is on record for this step.');
    const [trade] = trades(s) as [Element];
    expect(part(trade, 'trade-sentence')).toBe('Sold USDY (Ondo) for cash (USDC).');
    expect(rows(trade)).toEqual([
      `Before: 4.7% over its planned share · read ${when('2026-10-07T06:10:00.000Z')}`,
      `After: 3.5% over its planned share · read ${when('2026-10-07T06:20:00.000Z')}`,
    ]);
    // the one quiet line
    expect(part(s, 'step-derived')).toBe(
      'Worked out from two readings of the vault. It is not a record of the trade.',
    );
    // no transaction, so no link, and nothing said of a missing one: the line above says why
    expect(s.querySelector('[data-ui="explorer-link"]')).toBeNull();
    expect(s.querySelector('[data-ui="step-tx"], [data-ui="step-no-tx"]')).toBeNull();
    expect(s.querySelector('a')).toBeNull();
    // no quote either
    expect(s.querySelector('[data-row="quoted"], [data-ui="step-quote-note"]')).toBeNull();
    // this app holds no units for the sample's USDY: it says so, and writes no raw count
    expect(part(trade, 'trade-no-units')).toBe(
      'This app has no units for USDY, so the amounts before and after aren’t shown.',
    );
    expect(text(host)).not.toMatch(/48400000000|47300000000/);
    expect(pins(s)).toEqual([]);
  });

  it('writes what the vault held before and after a keeper’s trade, each with the entry’s pin', async () => {
    serve(portStore, { rebalances: () => json(more()) });
    signIn();
    const host = await page();
    const s = step(host, SOL_GROW, 0);
    expect(s.getAttribute('data-by')).toBe('keeper');
    const [trade] = trades(s) as [Element];
    expect(part(trade, 'trade-sentence')).toBe('Sold SPYx for cash (USDC).');
    expect(rows(trade)).toEqual([
      'Held before: 1.62 SPYx',
      'Held after: 1.6 SPYx',
      `Before: 2.1% over its planned share · read ${when('2026-10-06T15:20:00.000Z')}`,
      // under a tenth of a percent is written to the second decimal, never as nothing
      `After: 0.04% under its planned share · read ${when('2026-10-06T15:30:00.000Z')}`,
    ]);
    expect(trade.querySelector('[data-ui="trade-no-units"]')).toBeNull();
    expect(pins(trade)).toHaveLength(2);
    const figure = find(row(trade, 'held-after'), '[data-ui="figure"]');
    await click(find(figure, 'button[data-ui="pin"]'));
    const source = text(find(figure, '[data-ui="pin-source"]'));
    expect(source).toContain(
      `${KEEPER_SPYX.source} · 2026-10-06T15:30:00Z · worked out from two snapshots`,
    );
    expect(part(s, 'step-derived')).toBe(words.derived);
  });

  it('says a version was adopted, and that the step traded nothing', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const s = step(host, SOL_STALE, 1);
    expect(part(s, 'step-why')).toBe(
      'You made this step yourself. It adopted a new version of the portfolio the vault follows.',
    );
    expect(part(s, 'step-no-trade')).toBe('This step traded nothing.');
    expect(trades(s)).toEqual([]);
    expect(pins(s)).toEqual([]);
    expect(find(s, 'a[data-ui="explorer-link"]').getAttribute('href')).toContain(
      'https://solscan.io/tx/4uQeV',
    );
  });

  it('says each other reason in its own sentence, a sale as a sale, and a step with no transaction', async () => {
    serve(portStore, { rebalances: () => json(more()) });
    signIn();
    const host = await page();
    const s = step(host, SOL_STALE, 0);
    expect(dated(s)).toBe(FAILED_SELL.at);
    expect(part(s, 'step-why')).toBe('A part had moved too far from its planned share.');
    expect(part(s, 'step-outcome')).toBe('Failed');
    const [trade] = trades(s) as [Element];
    expect(part(trade, 'trade-sentence')).toBe('Tried to sell syrupUSDC (Maple) for cash (USDC).');
    expect(rows(trade)).toEqual(['Amount in the step: 8 syrupUSDC']);
    expect(part(s, 'step-no-tx')).toBe('No transaction is on record for this step.');
    expect(s.querySelector('[data-ui="explorer-link"]')).toBeNull();
    // every reason an order can carry has its sentence, and none is the code
    for (const reason of ['manual', 'index_update', 'drift', 'liquidity_breach'] as const)
      for (const lang of ['en', 'pt'] as const)
        expect(portfolioDictionary(lang).rebalancing.why[reason]).not.toContain('_');
  });

  it('puts the steps our server filed under no vault last, and says the vault is not known', async () => {
    serve(portStore, { rebalances: () => json(more()) });
    signIn();
    const host = await page();
    expect(groups(host).map((g) => g.getAttribute('data-vault'))).toEqual([
      SOL_INCOME,
      SOL_STALE,
      SOL_GROW,
      RH_SILENT,
      '',
    ]);
    const loose = groups(host).at(-1) as Element;
    expect(loose.getAttribute('data-chain')).toBe('solana');
    expect(text(find(loose, 'h2'))).toBe('Steps on Solana with no vault named');
    expect(part(loose, 'vault-unknown')).toBe(words.group.unknownWhy);
    expect(part(loose, 'chain-badge')).toBe('Solana');
    // no vault, so no page of one to open
    expect(loose.querySelector('a[href^="/portfolio/plan/"]')).toBeNull();
    const [s] = steps(loose) as [Element];
    expect(dated(s)).toBe(LOOSE.at);
    expect(rows(trades(s)[0] as Element)).toEqual(['Paid: 250 USDC', 'Quoted cost: 12.5 bps']);
    expect(find(s, 'a[data-ui="explorer-link"]').getAttribute('href')).toBe(
      `https://solscan.io/tx/${SIG_LOOSE}?cluster=devnet`,
    );
  });

  it('says once what the list cannot tell yet, and leads to the methodology', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const note = find(host, '[data-ui="steps-note"]');
    expect(text(find(note, 'h2'))).toBe('What this list can’t tell yet');
    expect([...note.querySelectorAll('li')].map(text)).toEqual(words.note.items);
    expect(text(note)).toMatch(/The time shown is when the step was built/);
    expect(text(note)).toMatch(/The cost shown is a quote/);
    expect(text(note)).toMatch(/worked out from two readings of a vault in the last thirty days/);
    expect(text(note)).toMatch(/those orders aren’t built yet/);
    const link = find(note, 'a');
    expect(link.getAttribute('href')).toBe('/portfolio/methodology');
    expect(link.textContent).toBe(words.note.more);
    // nothing on the page signs: the only buttons are the pins and "Read again"
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(
      host.querySelectorAll(
        'button:not([aria-label^="Source for"]):not([data-action="read-again"])',
      ),
    ).toHaveLength(0);
  });
});

describe('the figures of the rebalancing page', () => {
  it('puts a pin on every amount and every cost, and writes none without one (rule 1)', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    // four of the income plan's buy, two and one of the two attempts to grow, two on the sample chain
    expect(pins(host)).toHaveLength(4 + 2 + 1 + 2);
    for (const figure of pins(host)) {
      expect(figure.getAttribute('data-state')).not.toBe('missing');
      expect(figure.querySelector('button[data-ui="pin"]')?.getAttribute('aria-label')).toMatch(
        /^Source for [\d.,]+ (USDC|tUSDG|bps)/,
      );
    }
    // outside the figures, the vaults' own headings and the note's one example, no amount is written
    const copy = find(host, '[data-ui="portfolio-rebalancing"]').cloneNode(true) as HTMLElement;
    for (const el of copy.querySelectorAll('[data-ui="figure"], h2, [data-ui="steps-note"]'))
      el.remove();
    expect(text(copy)).not.toMatch(/\d\s?bps/);
    expect(text(copy)).not.toMatch(/\$\s?\d/);
    expect(text(copy)).not.toMatch(/\d\s(USDC|USDY|SPYx|SGOV|tUSDG|SPY)\b/);
    // a share is not a figure with a source of its own: it carries the time of its reading in words
    for (const dd of host.querySelectorAll('dd[data-row^="share-"]')) {
      expect(dd.querySelector('[data-ui="figure"]')).toBeNull();
      expect(dd.querySelector('time')?.getAttribute('datetime')).toMatch(/^2026-10-0\dT/);
    }
  });

  it('draws a test network and the sample chain as the hatch and one quiet line, never as live (rule 2)', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['mock']),
    );
    for (const pin of pins(host))
      expect(pin.querySelector('button')?.getAttribute('aria-label')).toMatch(/, sample figure$/);
    for (const [vault, line] of [
      [SOL_INCOME, t.shell.testNetworkLine],
      [SOL_GROW, t.shell.testNetworkLine],
      [RH_SILENT, t.shell.mockAnnounce],
    ] as const) {
      const g = group(host, vault);
      expect(g.querySelector('[data-ui="hatch-band"]')).not.toBeNull();
      expect(part(g, 'sample-note')).toBe(line);
    }
    expect(text(host)).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('never links a step on the sample chain: its transaction is on no explorer', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const s = step(host, RH_SILENT, 0);
    const [trade] = trades(s) as [Element];
    expect(part(trade, 'trade-sentence')).toBe('Swapped cash (tUSDG) into SPY.');
    // a quote that reads zero says why it can
    expect(rows(trade)).toEqual([
      'Paid: 24 tUSDG',
      `Quoted cost: 0 bps ${words.trade.quoteZero}`.replace('bps ', 'bps '),
      `After: at its planned share · read ${when('2026-10-02T13:10:00.000Z')}`,
    ]);
    const tx = find(s, '[data-ui="step-tx"] [data-ui="explorer-link"]');
    expect(tx.tagName).toBe('SPAN');
    expect(text(tx)).toBe(`0x9c…9f1a ${words.noExplorer}`);
    expect(s.querySelector('a')).toBeNull();
    // the mock's own address is nowhere a link, here or anywhere on the page
    expect(host.innerHTML).not.toContain('mock://');
  });

  it('draws live steps with live pins and no mark, and links only the network this app signs for', async () => {
    serve(portStore, { rebalances: () => json(labelled('live')), plans: () => json(null, 500) });
    signIn();
    const host = await page();
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['live']),
    );
    expect(host.querySelector('[data-ui="hatch-band"], [data-ui="sample-note"]')).toBeNull();
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    // this app is set to the test networks: a live step's transaction is not on their explorers, so
    // it is shown with no link rather than one that opens the wrong network
    expect(host.querySelector('a[data-ui="explorer-link"]')).toBeNull();
    const tx = find(step(host, SOL_INCOME, 1), '[data-ui="step-tx"] [data-ui="explorer-link"]');
    expect(text(tx)).toBe(`5VER…kQUW ${t.order.link.unavailable}`);
  });

  it('heads a vault by its chain and its address when the plans could not be read', async () => {
    serve(portStore, { plans: () => Promise.reject(new TypeError('fetch failed')) });
    signIn();
    const host = await page();
    expect(steps(host)).toHaveLength(7);
    const g = group(host, SOL_GROW);
    expect(text(find(g, 'h2'))).toBe('Your vault on Solana');
    expect(part(g, 'vault-address')).toBe('EPjF…kGDw');
    expect(find(g, '[data-ui="vault-address"]').getAttribute('title')).toBe(SOL_GROW);
    expect(text(find(group(host, RH_SILENT), 'h2'))).toBe('Your vault on Robinhood Chain');
    expect(find(g, 'header a').getAttribute('href')).toBe(`/portfolio/plan/solana/${SOL_GROW}`);
    // still not live: the steps' own labels say so
    expect(part(g, 'sample-note')).toBe(t.shell.testNetworkLine);
  });
});

describe('the rebalancing page, when there is nothing to list or the API cannot say', () => {
  it('asks someone signed out to sign in, and reads nothing', async () => {
    const server = serve(portStore);
    const host = await page();
    expect(server.calls).toEqual([]);
    expect(text(host)).toContain(en.shell.signedOut);
    expect(find(host, 'a').getAttribute('href')).toBe('/sign-in?next=/portfolio/rebalancing');
    expect(find(host, 'h1').textContent).toBe(words.title);
    expect(pins(host)).toEqual([]);
    expect(host.querySelector('[data-ui="steps-note"]')).toBeNull();
  });

  it('waits in words while the steps are read, and until the vaults can be named', async () => {
    const pending = held();
    const names = held();
    serve(portStore, { rebalances: pending.answer, plans: names.answer });
    signIn();
    const host = await page();
    const wait = find(host, '[data-ui="waiting"]');
    expect(wait.getAttribute('aria-busy')).toBe('true');
    await settle(450);
    expect(find(wait, '[role="status"]').textContent).toContain(en.shell.reading);
    // the steps alone are not drawn under headings that would change: the plans name the vaults
    await act(async () => pending.release(json(rebalances())));
    await settle();
    expect(host.querySelector('[data-ui="waiting"]')).not.toBeNull();
    expect(steps(host)).toEqual([]);
    await act(async () => names.release(json(plans())));
    await settle();
    expect(host.querySelector('[data-ui="waiting"]')).toBeNull();
    expect(text(find(group(host, SOL_GROW), 'h2'))).toBe('Grow $2,000 over 36 months.');
  });

  it('says in one sentence that there is nothing to list yet', async () => {
    const answer = rebalances();
    serve(portStore, {
      rebalances: () =>
        json({
          ...answer,
          chains: answer.chains.map((chain) => ({ ...chain, entries: [] })),
          unavailable: [],
        }),
    });
    signIn();
    const host = await page();
    expect(part(host, 'card-empty')).toBe(
      'There are no steps to list yet. They appear here once one of your plans has traded.',
    );
    expect(groups(host)).toEqual([]);
    expect(pins(host)).toEqual([]);
    // what the list cannot tell is still said
    expect(host.querySelectorAll('[data-ui="steps-note"]')).toHaveLength(1);
  });

  it('says a chain is switched off in a sentence, and never calls the list empty while one could not be read', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const out = find(host, '[data-ui="chains-out"] [data-ui="status"]');
    expect(text(out)).toBe(t.portfolio.chainOff('Base'));
    expect(out.getAttribute('data-status')).toBe('watch');
    expect(host.querySelector('[data-ui="vault-steps"][data-chain="base"]')).toBeNull();
    await unmountAll();

    const answer = rebalances();
    serve(portStore, {
      rebalances: () =>
        json({ ...answer, chains: answer.chains.map((chain) => ({ ...chain, entries: [] })) }),
    });
    const none = await page();
    expect(text(find(none, '[data-ui="chains-out"]'))).toBe(t.portfolio.chainOff('Base'));
    expect(text(none)).not.toContain(words.empty);
    expect(part(none, 'steps-none')).toBe(words.noneRead);
  });

  it.each([
    [() => json({ error: 'Route not found' }, 404), en.shell.failure.unavailable],
    [() => Promise.reject(new TypeError('fetch failed')), en.shell.failure.unreachable],
    [() => json({ chains: 'nope' }), en.shell.failure.unreadable],
    [() => json({ error: 'sign in first' }, 401), en.shell.failure.signedOut],
  ])('says a failed read in its own sentence, and lists nothing: %#', async (answer, sentence) => {
    serve(portStore, { rebalances: answer });
    signIn();
    const host = await page();
    expect(text(host)).toContain(sentence);
    expect(steps(host)).toEqual([]);
    expect(pins(host)).toEqual([]);
    expect(host.querySelector('[data-ui="steps-note"]')).toBeNull();
  });

  it('says a list as long as an answer can be may have older steps behind it', async () => {
    const answer = rebalances();
    const [solana, robinhood] = answer.chains;
    const one = solana?.entries[4];
    if (!solana || !robinhood || !one) throw new Error('no sample steps');
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...one,
      at: new Date(Date.parse('2026-10-03T14:00:00.000Z') - i * 60_000).toISOString(),
      txId: `${one.txId}${i}`,
    }));
    serve(portStore, {
      rebalances: () => json({ ...answer, chains: [{ ...solana, entries: many }, robinhood] }),
    });
    signIn();
    const host = await page();
    expect(steps(group(host, SOL_GROW))).toHaveLength(200);
    const capped = find(host, '[data-ui="steps-capped"]');
    expect(capped.getAttribute('data-chain')).toBe('solana');
    expect(text(capped)).toBe(
      'Only the newest 200 steps on Solana are listed. Older ones are not shown.',
    );
  });

  it('reads again on request, with a button that is never the page’s primary action', async () => {
    const server = serve(portStore);
    signIn();
    const host = await page();
    expect(part(host, 'steps-refresh')).toContain(words.refresh);
    const again = find(host, '[data-action="read-again"]');
    expect(again.getAttribute('data-variant')).toBe('secondary');
    await click(again);
    await settle();
    expect(server.to(REBALANCES_PATH)).toHaveLength(2);
    expect(steps(host)).toHaveLength(7);
  });
});

describe('the rebalancing page in Portuguese', () => {
  it('says every word of a step in Portuguese, and the time as Brazil writes it', async () => {
    const pt = portfolioDictionary('pt').rebalancing;
    // Brazil's formats put no-break spaces in figures: read as plain ones here
    const plain = (value: string) => value.replace(/[  ]/g, ' ');
    const said = (el: Element) => plain(el.textContent ?? '');
    const at = (root: Element, ui: string) => said(find(root, `[data-ui="${ui}"]`));
    serve(portStore, { rebalances: () => json(more()) });
    signIn();
    const host = await page('pt');
    expect(find(host, 'h1').textContent).toBe(pt.title);
    expect(said(find(group(host, SOL_INCOME), 'h2'))).toBe(
      'Gerar renda com US$ 80.000 por 60 meses.',
    );
    const own = step(host, SOL_INCOME, 1);
    expect(at(own, 'step-when')).toBe(
      plain(`${localTime('pt', '2026-10-05T09:29:41.000Z')} · quando o passo foi montado`),
    );
    expect(at(own, 'step-by')).toBe('Passo seu');
    expect(at(own, 'step-outcome')).toBe('Confirmado');
    expect(at(own, 'step-why')).toBe('Este passo foi feito por você.');
    const [usdy] = trades(own) as [Element];
    expect(at(usdy, 'trade-sentence')).toBe('Comprou USDY (Ondo) com caixa (USDC).');
    expect(
      [...usdy.querySelectorAll('dt')].map(
        (dt) => `${said(dt)}: ${said(dt.nextElementSibling as Element).trim()}`,
      ),
    ).toEqual([
      'Pago: 18.000 USDC',
      'Custo cotado: 4 bps',
      plain(
        `Antes: 0,01% acima da fatia planejada · lido em ${localTime('pt', '2026-10-05T09:20:00.000Z')}`,
      ),
      plain(
        `Depois: 0,1% acima da fatia planejada · lido em ${localTime('pt', '2026-10-05T09:40:00.000Z')}`,
      ),
    ]);
    expect(at(own, 'step-quote-note')).toBe(pt.quoteNote);
    const keeper = step(host, SOL_INCOME, 0);
    expect(at(keeper, 'step-by')).toBe('Passo do nosso operador');
    expect(at(keeper, 'step-when')).toContain('hora da operação segundo a rede');
    expect(at(keeper, 'step-derived')).toBe(
      'Deduzido de duas leituras do cofre. Não é um registro da operação.',
    );
    expect(at(step(host, SOL_GROW, 2), 'step-outcome')).toBe('Falhou');
    expect(at(step(host, SOL_GROW, 2), 'trade-sentence')).toBe(
      'Tentou comprar SPYx com caixa (USDC).',
    );
    expect(at(step(host, SOL_GROW, 0), 'trade-sentence')).toBe('Vendeu SPYx por caixa (USDC).');
    expect(said(row(trades(step(host, SOL_GROW, 0))[0] as Element, 'held-before')).trim()).toBe(
      '1,62 SPYx',
    );
    expect(at(group(host, SOL_INCOME), 'sample-note')).toBe(dictionary('pt').shell.testNetworkLine);
    expect(said(find(groups(host).at(-1) as Element, 'h2'))).toBe(
      'Passos na Solana sem cofre identificado',
    );
    expect(said(find(host, '[data-ui="steps-note"] h2'))).toBe(pt.note.heading);
    expect(said(find(host, '[data-ui="chains-out"]'))).toBe(
      dictionary('pt').portfolio.chainOff('Base'),
    );
    for (const pin of pins(host))
      expect(plain(pin.querySelector('button')?.getAttribute('aria-label') ?? '')).toMatch(
        /^Fonte de [\d.,]+ \S+, número de exemplo$/,
      );
    // no English sentence of the page is left on it
    for (const english of [words.title, words.by.owner, words.outcome.confirmed, words.derived])
      expect(said(host)).not.toContain(english);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('the rebalancing page inside the section’s frame', () => {
  it('sits under the menu with its own item current, the serif on its title and the disclaimer once', async () => {
    serve(portStore);
    signIn();
    const host = await mount(inFrame('en', createElement(RebalancingPage)));
    await settle();
    expect(find(host, '#portfolio-nav [aria-current="page"]').getAttribute('href')).toBe(
      '/portfolio/rebalancing',
    );
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
    expect(steps(host)).toHaveLength(7);
    // the vaults' headings are the sans face: the serif is the title's alone
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, '.font-display').tagName).toBe('H1');
    expect(host.querySelector('table')).toBeNull();
  });
});

describe('what the rebalancing page works with', () => {
  it('has sample steps of its own that parse with the contract', () => {
    expect(PortfolioRebalancesResponse.parse(REBALANCES_MORE)).toEqual(REBALANCES_MORE);
    const solana = more().chains[0]?.entries ?? [];
    expect(solana).toHaveLength(9);
    // newest first, as the route answers
    expect(solana.map((entry) => entry.at)).toEqual(
      [...solana.map((entry) => entry.at)].sort().reverse(),
    );
    expect(solana.filter((entry) => entry.vault === null)).toEqual([LOOSE]);
  });

  it('files the steps by vault, newest first, the newest vault first and the unfiled last', () => {
    const filed = groupsOf(more());
    expect(filed.map((g) => [g.chain.chain, g.vault, g.entries.length])).toEqual([
      ['solana', SOL_INCOME, 2],
      ['solana', SOL_STALE, 3],
      ['solana', SOL_GROW, 3],
      ['robinhood', RH_SILENT, 1],
      ['solana', null, 1],
    ]);
    for (const g of filed)
      expect(g.entries.map((entry) => entry.at)).toEqual(
        [...g.entries.map((entry) => entry.at)].sort().reverse(),
      );
    // an answer in any order is listed the same way, and steps of one moment keep the answer's order
    const answer = more();
    const [solana] = answer.chains;
    if (!solana) throw new Error('no chain');
    const shuffled = { ...answer, chains: [{ ...solana, entries: [...solana.entries].reverse() }] };
    expect(groupsOf(shuffled).map((g) => g.vault)).toEqual([SOL_INCOME, SOL_STALE, SOL_GROW, null]);
    const [a, b] = solana.entries as [
      (typeof solana.entries)[number],
      (typeof solana.entries)[number],
    ];
    const tied = {
      ...answer,
      chains: [{ ...solana, entries: [a, { ...b, vault: a.vault, at: a.at }] }],
    };
    expect(groupsOf(tied)[0]?.entries.map((entry) => entry.by)).toEqual([a.by, b.by]);
    expect(groupsOf({ ...answer, chains: [] })).toEqual([]);
  });

  it('links a transaction only where an explorer of this app’s network shows it', () => {
    const sol = { chain: 'solana', txId: 'abc' } as const;
    expect(explorerHref(sol, 'sandbox')).toBe('https://solscan.io/tx/abc?cluster=devnet');
    expect(explorerHref({ chain: 'robinhood', txId: '0xab' }, 'sandbox')).toBe(
      'https://explorer.testnet.chain.robinhood.com/tx/0xab',
    );
    // the sample chain is on no network, and a step with no transaction has nothing to open
    expect(explorerHref(sol, 'mock')).toBeNull();
    expect(explorerHref({ chain: 'robinhood', txId: '0xab' }, 'mock')).toBeNull();
    expect(explorerHref({ chain: 'solana', txId: null }, 'sandbox')).toBeNull();
    // a label this build does not know is not live, and not a test network's either
    expect(explorerHref(sol, 'fixture')).toBeNull();
    // another network of the chain than this app's: no link rather than the wrong explorer
    expect(explorerHref(sol, 'live')).toBeNull();
    const before = process.env.NEXT_PUBLIC_CHAIN_NETWORK_SOLANA;
    process.env.NEXT_PUBLIC_CHAIN_NETWORK_SOLANA = 'mainnet';
    try {
      expect(explorerHref(sol, 'live')).toBe('https://solscan.io/tx/abc');
      expect(explorerHref(sol, 'sandbox')).toBeNull();
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_CHAIN_NETWORK_SOLANA;
      else process.env.NEXT_PUBLIC_CHAIN_NETWORK_SOLANA = before;
    }
  });

  it('writes an instant in the reader’s own zone, saying which, and a cost with a true minus', () => {
    const at = '2026-10-05T09:29:41.000Z';
    expect(localTime('en', at, 'America/Sao_Paulo')).toBe('Oct 5, 2026, 06:29 GMT-3');
    expect(localTime('en', at, 'Asia/Kolkata')).toBe('Oct 5, 2026, 14:59 GMT+5:30');
    expect(localTime('pt', at, 'America/Sao_Paulo')).toBe('5 de out. de 2026, 06:29 BRT');
    expect(localTime('en', at, 'UTC')).toBe('Oct 5, 2026, 09:29 UTC');
    // with no zone named it is the zone of the machine it runs on: the reader's browser
    expect(localTime('en', at)).toBe(
      localTime('en', at, Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
    expect(basisPoints('en', 7.25)).toBe('7.25');
    expect(basisPoints('pt', 7.25)).toBe('7,25');
    expect(basisPoints('en', 4)).toBe('4');
    expect(basisPoints('en', 0)).toBe('0');
    expect(basisPoints('en', -3.126)).toBe('−3.13');
  });
});
