// @vitest-environment happy-dom
import type { Provenance } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { EXPOSURE_PATH, type ExposureAnswer } from './api';
import { ExposurePage } from './ExposurePage';
import { flagsSaid, holds, largestFirst } from './exposure';
import { held, serve } from './test/api';
import { EXPOSURE_OF_NOTHING, exposure, SOL_INCOME, SOL_UNPRICED } from './test/fixtures';
import { inFrame, inSection } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The exposure page with real events, on the sample answers: one block a chain, its sums with their
// pin and the time of the oldest reading behind them, the shares largest first as bars a screen reader
// reads as a list, what selling each holding would cost or why no cost is shown, the roll-up's flags
// in words, and the holdings that are in no sum. Nothing is added across chains, and no number is
// written without a pin.

const en = portfolioDictionary('en');
const t = dictionary('en');
const words = en.exposure;

const page = async (lang: Lang = 'en') => {
  const host = await mount(inSection(lang, createElement(ExposurePage)));
  await settle();
  return host;
};
const signIn = () => portStore.set(signedInPort(EMBEDDED));
const text = (el: Element) => el.textContent ?? '';
const part = (root: Element, ui: string) => text(find(root, `[data-ui="${ui}"]`));
const block = (host: HTMLElement, chain: string) =>
  find(host, `[data-ui="chain-exposure"][data-chain="${chain}"]`);
const pins = (root: ParentNode) => [...root.querySelectorAll('[data-ui="figure"]')];
const shares = (root: Element, by: string) => [
  ...find(root, `[data-ui="shares"][data-by="${by}"]`).querySelectorAll('[data-ui="share"]'),
];
/** A list of shares as "name dollars percent". */
const said = (root: Element, by: string) =>
  shares(root, by).map(
    (s) =>
      `${part(s, 'share-name')} ${text(find(s, '[data-ui="figure"] .tf-figure'))} ${part(s, 'share-percent')}`,
  );
const exit = (root: Element, asset: string) =>
  find(root, `[data-ui="exit"][data-asset="${asset}"]`);
/** The sample answer with one chain's entry changed. */
function withChain(
  chain: string,
  change: (entry: ExposureAnswer['chains'][number]) => ExposureAnswer['chains'][number],
): ExposureAnswer {
  const answer = exposure();
  return { ...answer, chains: answer.chains.map((c) => (c.chain === chain ? change(c) : c)) };
}
const labelled = (provenance: Provenance): ExposureAnswer => {
  const answer = exposure();
  return { ...answer, chains: answer.chains.map((c) => ({ ...c, provenance })) };
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = '/portfolio/exposure';
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the exposure page, for a person who holds on two chains', () => {
  it('asks once, and draws one block a chain with its vaults, its sum and the oldest reading', async () => {
    const server = serve(portStore);
    signIn();
    const host = await page();
    expect(server.to(EXPOSURE_PATH)).toEqual([EXPOSURE_PATH]);
    expect(
      [...host.querySelectorAll('[data-ui="chain-exposure"]')].map((b) =>
        b.getAttribute('data-chain'),
      ),
    ).toEqual(['solana', 'robinhood']);
    const solana = block(host, 'solana');
    expect(text(find(solana, 'h2'))).toBe(`Solana${t.shell.testNetwork}`);
    expect(find(solana, 'h2').querySelector('[data-ui="sample-glyph"]')).toBeTruthy();
    expect(part(solana, 'exposure-total')).toMatch(
      /^The 4 vaults that were read hold \$84,047\.10\s*$/,
    );
    expect(part(solana, 'exposure-oldest')).toBe(
      'The oldest reading behind these sums was taken on Oct 7, 2026, 08:55 UTC. The sums are no fresher than that.',
    );
    const robinhood = block(host, 'robinhood');
    expect(text(find(robinhood, 'h2'))).toBe('Robinhood Chain');
    expect(part(robinhood, 'exposure-total')).toMatch(
      /^The 2 vaults that were read hold \$41\.50\s*$/,
    );
    expect(part(robinhood, 'exposure-oldest')).toContain('Oct 6, 2026, 10:00 UTC');
    // the sum's pin is the chain's own stamp
    const total = find(solana, '[data-ui="exposure-total"] [data-ui="figure"]');
    await click(find(total, 'button[data-ui="pin"]'));
    const chain = exposure().chains[0];
    expect(text(find(total, '[data-ui="pin-source"]'))).toContain(
      `${chain?.source} · 2026-10-07T08:55:00Z · ${chain?.method}`,
    );
  });

  it('lists the shares largest first, with dollars and percentages that add up, as a list', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const solana = block(host, 'solana');
    expect(said(solana, 'underlying')).toEqual([
      'USDY $52,865.00 62.9%',
      'SGOV $22,836.20 27.2%',
      'USD $7,212.30 8.6%',
      'SPY $1,025.00 1.2%',
      'syrupUSDC $108.60 0.1%',
    ]);
    expect(said(solana, 'issuer')).toEqual([
      'ondo $52,865.00 62.9%',
      'ishares $22,836.20 27.2%',
      // a test network's placeholder issuer is said in words
      'The test network’s own tokens $7,212.30 8.6%',
      'backed $1,025.00 1.2%',
      'maple $108.60 0.1%',
    ]);
    expect(said(block(host, 'robinhood'), 'underlying')).toEqual([
      'SPY $25.00 60.2%',
      'USD $16.50 39.8%',
    ]);
    // the percentages of each list add up to the whole
    for (const list of host.querySelectorAll('[data-ui="shares"]')) {
      const sum = [...list.querySelectorAll('[data-ui="share-percent"]')]
        .map((p) => Math.round(Number.parseFloat(text(p)) * 10))
        .reduce((a, b) => a + b, 0);
      expect(sum).toBe(1000);
      // a real list, named by its heading; the bars are a picture, hidden from a screen reader
      expect(list.tagName).toBe('OL');
      const heading = document.getElementById(list.getAttribute('aria-labelledby') ?? '');
      expect(['By what each asset tracks', 'By who issues it']).toContain(heading?.textContent);
      for (const item of list.children) {
        expect(item.tagName).toBe('LI');
        expect(find(item, 'svg[data-ui="share-bar"]').getAttribute('aria-hidden')).toBe('true');
      }
    }
    // a bar is as long as its share, and a small share is still drawn
    const widths = shares(solana, 'underlying').map((s) =>
      Number(find(s, '[data-ui="share-fill"]').getAttribute('width')),
    );
    expect(widths).toEqual([62.9, 27.17, 8.58, 1.22, 0.75]);
    // an answer in another order is still listed largest first
    await unmountAll();
    serve(portStore, {
      exposure: () =>
        json(withChain('solana', (c) => ({ ...c, byUnderlying: [...c.byUnderlying].reverse() }))),
    });
    const again = await page();
    expect(said(block(again, 'solana'), 'underlying')[0]).toBe('USDY $52,865.00 62.9%');
  });

  it('says what selling each holding would cost, or why no cost is shown, and never a number without a pin', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const solana = block(host, 'solana');
    expect(
      [...solana.querySelectorAll('[data-ui="exit"]')].map((e) => [
        e.getAttribute('data-asset'),
        e.getAttribute('data-state'),
      ]),
    ).toEqual([
      ['solana:usdy', 'measured'],
      ['solana:sgov', 'beyond'],
      ['solana:spyx', 'undated'],
      ['solana:syrupusdc', 'tier'],
    ]);
    // measured, with Bearing's own stamp as its pin
    const usdy = exit(solana, 'solana:usdy');
    expect(part(usdy, 'exit-name')).toBe('USDY (Ondo)');
    expect(part(usdy, 'exit-holding')).toMatch(/^Your holding \$52,865\.00\s*$/);
    expect(part(usdy, 'exit-cost')).toMatch(/^Measured cost of selling all of it 7\.25 bps\s*$/);
    const cost = find(usdy, '[data-ui="exit-cost"] [data-ui="figure"]');
    await click(find(cost, 'button[data-ui="pin"]'));
    expect(text(find(cost, '[data-ui="pin-source"]'))).toContain(
      'Bearing, from the pools its collectors read each hour · 2026-10-07T11:00:00Z · risk-0.3',
    );
    // never more live than the chain the holding is on
    expect(cost.getAttribute('data-state')).toBe('mock');
    // a size beyond what was measured says so
    expect(part(exit(solana, 'solana:sgov'), 'exit-cost')).toBe(words.exit.beyond);
    // measured, with no time: no number, and it says it is not dated
    const spyx = exit(solana, 'solana:spyx');
    expect(part(spyx, 'exit-cost')).toBe(
      'It was measured, but the measurement came with no date, so no cost is shown.',
    );
    expect(text(spyx)).not.toContain('3.1');
    // not measured: the tier is named as a ceiling, and states no cost
    const syrup = exit(solana, 'solana:syrupusdc');
    expect(part(syrup, 'exit-cost')).toBe(
      'Not measured. Its tier, B, is only a ceiling on its share of a plan, and states no cost.',
    );
    for (const line of [exit(solana, 'solana:sgov'), spyx, syrup]) {
      expect(line.querySelector('[data-ui="exit-cost"] [data-ui="figure"]')).toBeNull();
      expect(part(line, 'exit-cost')).not.toMatch(/\d\s?bps/);
    }
    expect(part(exit(block(host, 'robinhood'), 'robinhood:tspy'), 'exit-cost')).toContain(
      'Its tier, A,',
    );
    // what the figure is, said once on the page
    const notes = find(host, '[data-ui="exposure-notes"]');
    expect([...notes.querySelectorAll('li')].map(text)).toEqual([
      words.notes.chains,
      words.notes.vaults,
      words.notes.exit,
      words.notes.bps,
    ]);
    expect(text(notes)).toContain('one asset sold alone');
    expect(text(notes)).toContain('not the cost of selling everything at once');
  });

  it('shows no number for a measured cost that came without its source, or with no tier to name', async () => {
    serve(portStore, {
      exposure: () =>
        json(
          withChain('solana', (c) => ({
            ...c,
            exit: c.exit.map((e) => {
              if (e.asset === 'solana:usdy') {
                const { source: _source, ...rest } = e;
                return rest;
              }
              if (e.asset === 'solana:syrupusdc') {
                const { fallbackTier: _tier, ...rest } = e;
                return rest;
              }
              return e;
            }),
          })),
        ),
    });
    signIn();
    const host = await page();
    const usdy = exit(block(host, 'solana'), 'solana:usdy');
    expect(usdy.getAttribute('data-state')).toBe('unsourced');
    expect(part(usdy, 'exit-cost')).toBe(words.exit.unsourced);
    expect(text(usdy)).not.toContain('7.25');
    expect(part(exit(block(host, 'solana'), 'solana:syrupusdc'), 'exit-cost')).toBe(
      words.exit.unmeasured,
    );
  });

  it('says the roll-up’s flags in words, a flag it has no words for by its own name, each once', async () => {
    serve(portStore, {
      exposure: () =>
        json(
          withChain('solana', (c) => ({
            ...c,
            rollUp: c.rollUp && {
              ...c.rollUp,
              flags: [
                'exit_quote_missing',
                'issuer_concentration',
                'measured_provenance:fixture',
                'measured_provenance:sandbox',
                'something_new',
              ],
            },
          })),
        ),
    });
    signIn();
    const host = await page();
    const flags = [...find(block(host, 'solana'), '[data-ui="flags"]').querySelectorAll('li')];
    expect(flags.map(text)).toEqual([
      'There is no recent quote for selling these holdings, so only measured costs are shown.',
      'More than half of what you hold here is with one issuer.',
      'The measured selling cost rests on figures that are not live.',
      'A note we have no words for yet: something_new',
    ]);
    expect(part(flags[3] as Element, 'flag-name')).toBe('something_new');
    expect(
      [...find(block(host, 'robinhood'), '[data-ui="flags"]').querySelectorAll('li')].map(text),
    ).toEqual([words.flags.say.exit_not_measured, words.flags.say.exit_quote_missing]);
    // every flag the roll-up can raise has a sentence, in both languages
    for (const lang of ['en', 'pt'] as const)
      expect(Object.keys(portfolioDictionary(lang).exposure.flags.say).sort()).toEqual([
        'asset_not_on_shelf',
        'exit_beyond_measured_size',
        'exit_capacity_short',
        'exit_not_measured',
        'exit_partly_measured',
        'exit_quote_far_from_size',
        'exit_quote_missing',
        'exit_quote_partial',
        'exit_quote_stale',
        'issuer_concentration',
        'measured_provenance',
        'quoted_provenance',
      ]);
  });

  it('lists a holding with no price by name and amount, and says it is in no sum', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const solana = block(host, 'solana');
    expect(part(solana, 'unvalued-note')).toBe(
      'These have no price, or aren’t on the list of assets, so they are in no sum above.',
    );
    const held = find(solana, '[data-ui="unvalued"] li');
    expect(held.getAttribute('data-asset')).toBe('solana:paxg');
    expect(part(held, 'unvalued-name')).toBe('PAXG');
    expect(text(find(held, '.tf-figure'))).toBe('0.06');
    expect(find(held, 'button[data-ui="pin"]').getAttribute('aria-label')).toBe(
      'Source for 0.06 PAXG, sample figure',
    );
    const link = find(held, 'a');
    expect(link.getAttribute('href')).toBe(`/portfolio/plan/solana/${SOL_UNPRICED}`);
    expect(link.textContent).toBe('ATok…8knL');
    expect(link.getAttribute('aria-label')).toBe('See the plan in vault ATok…8knL over time');
    expect(block(host, 'robinhood').querySelector('[data-ui="unvalued"]')).toBeNull();
  });

  it('never adds the chains together, and says so once', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    const total = exposure().total;
    expect(total?.valueUsd).toBe('84088.6');
    // the cross-chain total and its own shares are nowhere on the page
    for (const figure of ['$84,088.60', '$7,228.80', '$1,050.00', '62.87%', '62.8%'])
      expect(text(host)).not.toContain(figure);
    expect(host.querySelectorAll('[data-ui="exposure-total"]')).toHaveLength(2);
    expect(text(host).split(words.notes.chains)).toHaveLength(2);
    expect(words.notes.chains).toBe(
      'Each chain is added up on its own. Chains are never added together.',
    );
  });

  it('says the sample chain’s figures are samples, and presents no split by issuer there', async () => {
    serve(portStore, {
      exposure: () =>
        json(
          withChain('robinhood', (c) => ({
            ...c,
            rollUp: c.rollUp && { ...c.rollUp, flags: ['issuer_concentration', ...c.rollUp.flags] },
          })),
        ),
    });
    signIn();
    const host = await page();
    const robinhood = block(host, 'robinhood');
    expect(part(robinhood, 'sample-note')).toBe(t.shell.mockAnnounce);
    expect(robinhood.querySelector('[data-ui="hatch-band"]')).not.toBeNull();
    expect(robinhood.querySelector('[data-ui="shares"][data-by="issuer"]')).toBeNull();
    expect(part(robinhood, 'issuer-stand-ins')).toBe(
      'On our sample chain every issuer and tier is a stand-in, so there is no split by issuer to show.',
    );
    // one stand-in holding it all is no finding
    expect(text(robinhood)).not.toContain(words.flags.say.issuer_concentration);
    expect(text(robinhood)).not.toContain(words.shares.byIssuer);
    // a test network keeps its split, under its own line
    expect(part(block(host, 'solana'), 'sample-note')).toBe(t.shell.testNetworkLine);
    expect(block(host, 'solana').querySelector('[data-ui="issuer-stand-ins"]')).toBeNull();
  });
});

describe('the figures of the exposure page', () => {
  it('puts a pin on every figure, and writes no amount or cost without one (rule 1)', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    // Solana: its sum, five and five shares, four holdings, one cost, one holding with no price.
    // Robinhood Chain: its sum, two shares, one holding.
    expect(pins(host)).toHaveLength(1 + 5 + 5 + 4 + 1 + 1 + (1 + 2 + 1));
    for (const figure of pins(host)) {
      expect(figure.getAttribute('data-state')).not.toBe('missing');
      expect(figure.querySelector('button[data-ui="pin"]')?.getAttribute('aria-label')).toMatch(
        /^Source for /,
      );
    }
    const copy = find(host, '[data-ui="portfolio-exposure"]').cloneNode(true) as HTMLElement;
    for (const el of copy.querySelectorAll('[data-ui="figure"], [data-ui="exposure-notes"]'))
      el.remove();
    expect(text(copy)).not.toMatch(/\$\s?\d/);
    expect(text(copy)).not.toMatch(/\d\s?bps/);
  });

  it('draws a test network and the sample chain as the hatch and one quiet line, never as live (rule 2)', async () => {
    serve(portStore);
    signIn();
    const host = await page();
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['mock']),
    );
    expect(host.querySelectorAll('[data-ui="sample-note"]')).toHaveLength(2);
    expect(text(host)).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    // the only status on the page is a word with its shape
    const out = find(host, '[data-ui="chains-out"] [data-ui="status"]');
    expect(text(out)).toBe(t.portfolio.chainOff('Base'));
    expect(out.querySelector('svg[data-ui="status-mark"]')).not.toBeNull();
  });

  it('draws live sums with live pins and no mark', async () => {
    serve(portStore, { exposure: () => json(labelled('live')) });
    signIn();
    const host = await page();
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['live']),
    );
    expect(host.querySelector('[data-ui="hatch-band"], [data-ui="sample-note"]')).toBeNull();
    expect(block(host, 'solana').querySelector('[data-ui="chain-mark"]')).toBeNull();
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('writes no figure for sums that came with no time', async () => {
    serve(portStore, {
      exposure: () => json(withChain('robinhood', (c) => ({ ...c, observedAt: null }))),
    });
    signIn();
    const host = await page();
    const robinhood = block(host, 'robinhood');
    expect(part(robinhood, 'exposure-undated')).toBe(words.chain.undated);
    expect(pins(robinhood)).toEqual([]);
    expect(text(robinhood)).not.toMatch(/\$\s?\d/);
    expect(robinhood.querySelector('[data-ui="shares"]')).toBeNull();
  });
});

describe('the exposure page, when nothing is held or the API cannot say', () => {
  it('asks someone signed out to sign in, and reads nothing', async () => {
    const server = serve(portStore);
    const host = await page();
    expect(server.calls).toEqual([]);
    expect(text(host)).toContain(en.shell.signedOut);
    expect(find(host, 'a').getAttribute('href')).toBe('/sign-in?next=/portfolio/exposure');
    expect(pins(host)).toEqual([]);
  });

  it('waits in words while the holdings are read', async () => {
    const pending = held();
    serve(portStore, { exposure: pending.answer });
    signIn();
    const host = await page();
    const wait = find(host, '[data-ui="waiting"]');
    await settle(450);
    expect(find(wait, '[role="status"]').textContent).toContain(en.shell.reading);
    expect(pins(host)).toEqual([]);
    await act(async () => pending.release(json(exposure())));
    await settle();
    expect(host.querySelector('[data-ui="waiting"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="chain-exposure"]')).toHaveLength(2);
  });

  it('says in one sentence that nothing is held yet', async () => {
    serve(portStore, { exposure: () => json({ ...EXPOSURE_OF_NOTHING, unavailable: [] }) });
    signIn();
    const host = await page();
    expect(part(host, 'card-empty')).toBe(words.empty);
    expect(host.querySelector('[data-ui="chain-exposure"], [data-ui="exposure-notes"]')).toBeNull();
    expect(pins(host)).toEqual([]);
    expect(text(host)).not.toMatch(/\$\s?\d/);
  });

  it('says a chain holds nothing beside one that does, and never a zero in its place', async () => {
    serve(portStore, { exposure: () => json(exposure({ address: SOL_INCOME })) });
    signIn();
    const host = await page();
    expect(host.querySelectorAll('[data-ui="chain-exposure"]')).toHaveLength(1);
    expect(part(block(host, 'solana'), 'exposure-total')).toContain(
      'The 1 vault that was read holds $81,243.55',
    );
    const empty = find(host, '[data-ui="chain-empty"]');
    expect(empty.getAttribute('data-chain')).toBe('robinhood');
    expect(text(empty)).toBe(
      'No vault of yours on Robinhood Chain has been read yet, so there is nothing to add up.',
    );
    expect(text(host)).not.toContain('$0.00');
    await unmountAll();
    // vaults that were read and hold nothing say that instead
    serve(portStore, {
      exposure: () =>
        json(
          withChain('robinhood', (c) => ({
            ...c,
            valueUsd: '0',
            byUnderlying: [],
            byIssuer: [],
            rollUp: null,
            exit: [],
          })),
        ),
    });
    const again = await page();
    expect(part(again, 'chain-empty')).toBe('Your 2 vaults on Robinhood Chain hold nothing yet.');
  });

  it('shows a chain whose holdings have no price with no sum, and the holdings', async () => {
    serve(portStore, {
      exposure: () =>
        json(
          withChain('solana', (c) => ({
            ...c,
            valueUsd: '0',
            byUnderlying: [],
            byIssuer: [],
            rollUp: null,
            exit: [],
          })),
        ),
    });
    signIn();
    const host = await page();
    const solana = block(host, 'solana');
    expect(part(solana, 'exposure-no-sum')).toBe(words.chain.noPriced);
    expect(solana.querySelector('[data-ui="exposure-total"], [data-ui="shares"]')).toBeNull();
    expect(find(solana, '[data-ui="unvalued"]').querySelectorAll('li')).toHaveLength(1);
  });

  it('says a chain is switched off in a sentence, and never says nothing is held while one could not be read', async () => {
    serve(portStore, { exposure: () => json(EXPOSURE_OF_NOTHING) });
    signIn();
    const host = await page();
    expect(text(find(host, '[data-ui="chains-out"]'))).toBe(t.portfolio.chainOff('Base'));
    expect(text(host)).not.toContain(words.empty);
    expect(host.querySelectorAll('[data-ui="chain-empty"]')).toHaveLength(2);
    expect(host.querySelector('[data-ui="chain-exposure"][data-chain="base"]')).toBeNull();
  });

  it.each([
    [() => json({ error: 'Route not found' }, 404), en.shell.failure.unavailable],
    [() => Promise.reject(new TypeError('fetch failed')), en.shell.failure.unreachable],
    [() => json({ chains: 'nope' }), en.shell.failure.unreadable],
    [() => json({ error: 'sign in first' }, 401), en.shell.failure.signedOut],
  ])(
    'says a failed read in its own sentence, and draws no figure: %#',
    async (answer, sentence) => {
      serve(portStore, { exposure: answer });
      signIn();
      const host = await page();
      expect(text(host)).toContain(sentence);
      expect(host.querySelector('[data-ui="chain-exposure"]')).toBeNull();
      expect(pins(host)).toEqual([]);
    },
  );

  it('leads to the methodology and reads again on request, with nothing to sign', async () => {
    const server = serve(portStore);
    signIn();
    const host = await page();
    const more = find(host, '[data-ui="exposure-more"] a');
    expect(more.getAttribute('href')).toBe('/portfolio/methodology');
    expect(more.textContent).toBe(words.more);
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    await click(find(host, '[data-action="read-again"]'));
    await settle();
    expect(server.to(EXPOSURE_PATH)).toHaveLength(2);
  });
});

describe('the exposure page in Portuguese', () => {
  it('says every word of a block in Portuguese, and the figures the Brazilian way', async () => {
    const pt = portfolioDictionary('pt').exposure;
    const plain = (value: string) => value.replace(/[  ]/g, ' ');
    const read = (el: Element) => plain(el.textContent ?? '');
    const at = (root: Element, ui: string) => read(find(root, `[data-ui="${ui}"]`));
    serve(portStore);
    signIn();
    const host = await page('pt');
    expect(find(host, 'h1').textContent).toBe(pt.title);
    const solana = block(host, 'solana');
    expect(at(solana, 'exposure-total')).toContain('Os 4 cofres que foram lidos têm US$ 84.047,10');
    expect(read(shares(solana, 'underlying')[0] as Element)).toContain('US$ 52.865,00');
    expect(at(shares(solana, 'underlying')[0] as Element, 'share-percent')).toBe('62,9%');
    expect(at(exit(solana, 'solana:usdy'), 'exit-cost')).toContain(
      'Custo medido de vender tudo 7,25 bps',
    );
    expect(at(exit(solana, 'solana:spyx'), 'exit-cost')).toBe(pt.exit.undated);
    expect(at(exit(solana, 'solana:syrupusdc'), 'exit-cost')).toContain('A faixa dele, B,');
    expect(at(solana, 'unvalued-note')).toBe(pt.unvalued.note);
    expect(at(solana, 'sample-note')).toBe(dictionary('pt').shell.testNetworkLine);
    expect(at(block(host, 'robinhood'), 'issuer-stand-ins')).toBe(pt.shares.standIns);
    expect(read(find(host, '[data-ui="exposure-notes"]'))).toContain(pt.notes.chains);
    for (const english of [words.title, words.exit.heading, words.shares.byUnderlying])
      expect(read(host)).not.toContain(english);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('the exposure page inside the section’s frame', () => {
  it('sits under the menu with its own item current, the serif on its title and the disclaimer once', async () => {
    serve(portStore);
    signIn();
    const host = await mount(inFrame('en', createElement(ExposurePage)));
    await settle();
    expect(find(host, '#portfolio-nav [aria-current="page"]').getAttribute('href')).toBe(
      '/portfolio/exposure',
    );
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, '.font-display').tagName).toBe('H1');
  });
});

describe('what the exposure page works with', () => {
  it('knows a chain that holds something, and lists shares largest first', () => {
    const [solana, robinhood] = exposure().chains;
    const [nothing] = EXPOSURE_OF_NOTHING.chains;
    if (!solana || !robinhood || !nothing) throw new Error('no chains');
    expect([holds(solana), holds(robinhood), holds(nothing)]).toEqual([true, true, false]);
    expect(holds({ ...nothing, unvalued: solana.unvalued })).toBe(true);
    expect(
      largestFirst([
        { key: 'a', bps: 10 },
        { key: 'b', bps: 9000 },
        { key: 'c', bps: 10 },
      ]).map((s) => s.key),
    ).toEqual(['b', 'a', 'c']);
  });

  it('says each flag once, keeps one it has no words for, and no issuer finding on the sample chain', () => {
    const say = words.flags.say;
    expect(flagsSaid(['exit_quote_missing', 'exit_quote_missing'], say, false)).toEqual([
      { flag: 'exit_quote_missing', sentence: say.exit_quote_missing },
    ]);
    expect(flagsSaid(['quoted_provenance:mock', 'new_one', 'new_one'], say, false)).toEqual([
      { flag: 'quoted_provenance:mock', sentence: say.quoted_provenance },
      { flag: 'new_one', sentence: null },
    ]);
    expect(flagsSaid(['issuer_concentration'], say, true)).toEqual([]);
    // a name every object has is no sentence
    expect(flagsSaid(['toString'], say, false)).toEqual([{ flag: 'toString', sentence: null }]);
  });
});
