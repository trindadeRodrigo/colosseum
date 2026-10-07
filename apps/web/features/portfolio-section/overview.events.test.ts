// @vitest-environment happy-dom
import type { Provenance } from '@colosseum/schemas';
import { createElement } from 'react';
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
import { PLANS_PATH, type PlansAnswer } from './api';
import { OverviewPage } from './OverviewPage';
import { serve } from './test/api';
import {
  plans,
  RH_EMPTY,
  RH_SILENT,
  SOL_GROW,
  SOL_INCOME,
  SOL_NEVER,
  SOL_STALE,
  SOL_UNPRICED,
  STATUS_BY_LINE,
} from './test/fixtures';
import { inFrame, inSection } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The overview with real events, on the sample answers: one card a plan with its goal first, the
// status as the server says it with its reason, every figure with its pin, nothing that is not live
// drawn as live, a stale snapshot said as stale with its age, and a sum for each chain that is never
// added across chains. Where the API cannot say, a sentence says why and no figure is drawn.

const en = portfolioDictionary('en');
const t = dictionary('en');

const overview = async (lang: Lang = 'en') => {
  const host = await mount(inSection(lang, createElement(OverviewPage)));
  await settle();
  return host;
};
const signIn = (over: Parameters<typeof signedInPort>[1] = {}) =>
  portStore.set(signedInPort(EMBEDDED, over));
const card = (host: HTMLElement, address: string) =>
  find(host, `[data-ui="plan-card"][data-address="${address}"]`);
const cards = (host: HTMLElement) => [...host.querySelectorAll('[data-ui="plan-card"]')];
const pins = (root: ParentNode) => [...root.querySelectorAll('[data-ui="figure"]')];
const text = (el: Element) => el.textContent ?? '';
const part = (root: Element, ui: string) => text(find(root, `[data-ui="${ui}"]`));
const group = (host: HTMLElement, chain: string) =>
  find(host, `[data-ui="chain-group"][data-chain="${chain}"]`);

/** The sample plans with every label set to `provenance`: the chains', the vaults', the snapshots', the prices'. */
function labelled(provenance: Provenance): PlansAnswer {
  const answer = plans();
  return {
    ...answer,
    chains: answer.chains.map((chain) => ({
      ...chain,
      provenance,
      plans: chain.plans.map((plan) => ({
        ...plan,
        provenance,
        putIn: plan.putIn && { ...plan.putIn, provenance },
        newest: plan.newest && {
          ...plan.newest,
          provenance,
          prices: plan.newest.prices.map((price) => ({ ...price, provenance })),
        },
      })),
    })),
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = '/portfolio';
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the overview, for a person with plans on two chains', () => {
  it('asks once for the plans and draws one card a plan, the goal first on each', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    expect(server.to(PLANS_PATH)).toHaveLength(1);
    expect(cards(host).map((c) => c.getAttribute('data-address'))).toEqual([
      SOL_GROW,
      SOL_INCOME,
      SOL_UNPRICED,
      SOL_STALE,
      SOL_NEVER,
      RH_SILENT,
      RH_EMPTY,
    ]);
    for (const c of cards(host)) {
      const article = find(c, 'article');
      // the sentence is the first thing on the card, and it names the card
      const sentence = find(article, 'h3');
      expect(article.getAttribute('aria-labelledby')).toBe(sentence.id);
      expect(article.querySelector('h3, p, dl, a')).toBe(sentence);
    }
    expect(cards(host).map((c) => text(find(c, 'h3')))).toEqual([
      'Grow $2,000 over 36 months.',
      // the goal at what was put in: two deposits made it $80,000, and the income asked of $50,000
      // is not said of another amount
      'Earn income from $80,000 for 60 months.',
      'Protect $500 for 18 months.',
      'Your vault follows Steady dollars.',
      'Rainy day',
      'Your vault was opened to follow US stocks.',
      'Your vault on Robinhood Chain.',
    ]);
    // a vault with a goal and a name of its own says the name under the goal
    expect(part(card(host, SOL_INCOME), 'plan-note')).toBe('Rent fund');
    expect(card(host, SOL_GROW).querySelector('[data-ui="plan-note"]')).toBeNull();
  });

  it('spends the serif on the goals: the heading over the cards is the sans face', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const heading = find(host, 'h1');
    expect(heading.textContent).toBe(en.overview.title);
    expect(heading.className).not.toContain('font-display');
    const serif = [...host.querySelectorAll('.font-display')];
    expect(serif).toHaveLength(7);
    for (const line of serif) expect(line.closest('[data-ui="plan-card"]')).not.toBeNull();
    // one serif line a card, and it is the goal
    for (const c of cards(host)) expect(c.querySelectorAll('.font-display')).toHaveLength(1);
  });

  it('says each status as the server gave it: the word, its shape, the reason and the rule', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const said = (address: string) => {
      const c = card(host, address);
      const status = c.querySelector('[data-ui="status"]');
      return [
        status?.getAttribute('data-status') ?? null,
        status ? text(status) : part(c, 'plan-no-status'),
        part(c, 'plan-reason'),
      ];
    };
    expect(said(SOL_GROW)).toEqual([
      'on-track',
      'On track',
      'Every part is within 2% of its planned share, and our keeper’s losses have used 12% of their budget.',
    ]);
    expect(said(SOL_INCOME)).toEqual([
      'watch',
      'Watch',
      'USDY (Ondo) is 3.5% over its planned share, more than the 2% it may drift.',
    ]);
    expect(said(SOL_UNPRICED)).toEqual([
      'watch',
      'Watch',
      'PAXG is held and has no price, so the plan can’t be weighed.',
    ]);
    expect(said(SOL_STALE)).toEqual([
      'watch',
      'Watch',
      'The vault was last read 185 minutes ago, more than an hour.',
    ]);
    expect(said(RH_SILENT)).toEqual([
      'off-track',
      'Off track',
      'Nothing has been read from this plan’s chain for 26 hours, a day or more, so I can’t say where it stands.',
    ]);
    // a status is a word and a shape, never the colour alone
    for (const status of host.querySelectorAll('[data-ui="plan-card"] [data-ui="status"]'))
      expect(status.querySelector('svg[data-ui="status-mark"]')).not.toBeNull();
    // the rule that gave it is printed beside it, on every card
    for (const c of cards(host)) expect(part(c, 'plan-rule')).toBe('Rule ON-TRACK-V1');
    // the server's own English sentence is on no card
    const whole = text(host);
    for (const plan of plans().chains.flatMap((chain) => chain.plans))
      if (plan.status.line !== 'stale') expect(whole).not.toContain(plan.status.text);
  });

  it('says there is no status yet, and why, where the rule gives none', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    for (const [address, why] of [
      [SOL_NEVER, 'This vault hasn’t been read yet, so there is no status to give.'],
      [
        RH_EMPTY,
        'The vault holds nothing yet. A deposit counts once the chain shows the vault holding it.',
      ],
    ] as const) {
      const c = card(host, address);
      expect(c.querySelector('[data-ui="status"]')).toBeNull();
      expect(c.querySelector('[data-ui="status-mark"]')).toBeNull();
      expect(part(c, 'plan-no-status')).toBe('No status yet');
      expect(part(c, 'plan-reason')).toBe(why);
    }
  });

  it('shows the status the server answers, whatever the snapshot beside it would suggest', async () => {
    // the server calls the stale vault on track and the fresh one off track: the screen says so
    const answer = plans();
    const swapped: PlansAnswer = {
      ...answer,
      chains: answer.chains.map((chain) => ({
        ...chain,
        plans: chain.plans.map((plan) =>
          plan.address === SOL_STALE
            ? { ...plan, status: STATUS_BY_LINE.inside[0] ?? plan.status }
            : plan.address === SOL_GROW
              ? { ...plan, status: STATUS_BY_LINE.loss_half[0] ?? plan.status }
              : plan,
        ),
      })),
    };
    serve(portStore, { plans: () => json(swapped) });
    signIn();
    const host = await overview();
    expect(part(card(host, SOL_STALE), 'status')).toBe('On track');
    expect(part(card(host, SOL_GROW), 'status')).toBe('Off track');
    expect(part(card(host, SOL_GROW), 'plan-reason')).toBe(
      'Our keeper’s losses have used 62% of their budget, half or more.',
    );
  });

  it('writes what each vault is worth and what was put in, each with its pin, and when it was read', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const figures = (address: string) =>
      [...find(card(host, address), '[data-ui="plan-figures"]').querySelectorAll('dd')].map((dd) =>
        text(dd).trim(),
      );
    expect(figures(SOL_GROW)).toEqual(['$2,051.37', '$2,000.00']);
    expect(figures(SOL_INCOME)).toEqual(['$81,243.55', '$80,000.00']);
    expect(figures(SOL_UNPRICED)).toEqual(['$500.28', '$500.00']);
    expect(figures(RH_SILENT)).toEqual(['$41.50', '$40.00']);
    // nothing confirmed as put in is a sentence, never a zero
    expect(figures(RH_EMPTY)).toEqual(['$0.00', en.overview.card.noPutIn]);
    expect(
      [...find(card(host, SOL_GROW), '[data-ui="plan-figures"]').querySelectorAll('dt')].map(text),
    ).toEqual([en.overview.card.value, en.overview.card.putIn]);
    // a holding with no price is left out of the value, and the card says so
    expect(part(card(host, SOL_UNPRICED), 'plan-unpriced')).toBe(
      '1 holding has no price, so the value leaves it out.',
    );
    expect(card(host, SOL_GROW).querySelector('[data-ui="plan-unpriced"]')).toBeNull();
    // how long ago the vault was read, as the answer says, then when
    expect(text(find(card(host, SOL_GROW), '[data-ui="plan-read"] > span:first-child'))).toBe(
      'Read 4 minutes ago, on Oct 7, 2026, 11:56 UTC.',
    );
    expect(text(find(card(host, SOL_STALE), '[data-ui="plan-read"] > span:first-child'))).toBe(
      'Read 3 hours ago, on Oct 7, 2026, 08:55 UTC.',
    );
  });

  it('says a vault that was never read has not been, and shows no value for it', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const c = card(host, SOL_NEVER);
    expect(part(c, 'plan-never-read')).toBe(en.overview.card.neverRead);
    expect(part(c, 'plan-no-put-in')).toBe(en.overview.card.noPutIn);
    expect(pins(c)).toEqual([]);
    expect(text(c)).not.toMatch(/\$\s?\d/);
    expect(c.querySelector('[data-ui="plan-read"]')).toBeNull();
    // it still opens its own page
    expect(find(c, 'a').getAttribute('href')).toBe(`/portfolio/plan/solana/${SOL_NEVER}`);
  });

  it('opens a plan’s own page from its card, with one link a card and nothing to sign', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    for (const c of cards(host)) {
      const links = [...c.querySelectorAll('a')];
      expect(links).toHaveLength(1);
      const [link] = links;
      expect(link?.textContent).toBe(en.overview.card.open);
      expect(link?.getAttribute('href')).toBe(
        `/portfolio/plan/${c.getAttribute('data-chain')}/${c.getAttribute('data-address')}`,
      );
      // every card's link reads the same, so each is described by its goal
      expect(link?.getAttribute('aria-describedby')).toBe(find(c, 'h3').id);
    }
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    // the only buttons are the pins and "Read again"
    expect(
      host.querySelectorAll(
        'button:not([aria-label^="Source for"]):not([data-action="read-again"])',
      ),
    ).toHaveLength(0);
    expect(text(host)).not.toMatch(/\bsign\b|withdraw|rebalance now/i);
  });
});

describe('the figures of the overview', () => {
  it('puts a pin on every figure, and writes no amount of money without one (rule 1)', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    // two chain totals, six values (one vault was never read) and five amounts put in
    expect(pins(host)).toHaveLength(2 + 6 + 5);
    for (const figure of pins(host)) {
      expect(figure.getAttribute('data-state')).not.toBe('missing');
      expect(figure.querySelector('button[data-ui="pin"]')?.getAttribute('aria-label')).toMatch(
        /^Source for \$/,
      );
    }
    // outside the figures and the goals, which are the person's own words, no amount is written
    const copy = find(host, '[data-ui="portfolio-overview"]').cloneNode(true) as HTMLElement;
    for (const el of copy.querySelectorAll('[data-ui="figure"], h3')) el.remove();
    expect(text(copy)).not.toMatch(/\$\s?\d/);
    // and none on a count, an age or a share
    expect(find(host, '[data-ui="plans-count"]').querySelector('[data-ui="figure"]')).toBeNull();
    for (const c of cards(host))
      for (const ui of ['plan-reason', 'plan-read', 'plan-rule'])
        expect(c.querySelector(`[data-ui="${ui}"] [data-ui="figure"]`)).toBeNull();
  });

  it('hands each pin the stamp its answer carries: the snapshot’s, and what was put in’s', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const [value, putIn] = pins(card(host, SOL_GROW));
    const { newest, putIn: put } = plans().chains[0]?.plans[0] ?? {};
    await click(find(value as Element, 'button[data-ui="pin"]'));
    expect(text(find(value as Element, '[data-ui="pin-source"]'))).toContain(
      `${newest?.source} · ${newest?.observedAt.replace('.000Z', 'Z')} · ${newest?.method}`,
    );
    await click(find(putIn as Element, 'button[data-ui="pin"]'));
    expect(text(find(putIn as Element, '[data-ui="pin-source"]'))).toContain(
      `${put?.source} · ${put?.fetchedAt.replace('.000Z', 'Z')} · ${put?.method}`,
    );
  });

  it('draws a test network and the mock as the hatch and one quiet line, never as live (rule 2)', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    // no figure on the page is drawn live: every chain here is a test network or the mock
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['mock']),
    );
    for (const pin of pins(host))
      expect(pin.querySelector('button')?.getAttribute('aria-label')).toMatch(/, sample figure$/);
    // a test network's card says "Test network", the mock's "Sample figures": once, with the hatch
    for (const [address, line] of [
      [SOL_GROW, t.shell.testNetworkLine],
      [SOL_NEVER, t.shell.testNetworkLine],
      [RH_SILENT, t.shell.mockAnnounce],
      [RH_EMPTY, t.shell.mockAnnounce],
    ] as const) {
      const c = card(host, address);
      expect(c.querySelector('[data-ui="hatch-band"]')).not.toBeNull();
      expect(part(c, 'sample-note')).toBe(line);
    }
    // the chain's heading carries the mark too, with the words on a test network
    expect(text(find(group(host, 'solana'), 'h2'))).toBe(`Solana${t.shell.testNetwork}`);
    expect(
      find(group(host, 'solana'), 'h2').querySelector('[data-ui="sample-glyph"]'),
    ).toBeTruthy();
    expect(text(find(group(host, 'robinhood'), 'h2'))).toBe('Robinhood Chain');
    expect(
      find(group(host, 'robinhood'), 'h2').querySelector('[data-ui="sample-glyph"]'),
    ).toBeTruthy();
    // no boxed word, and every hatch has its words
    expect(text(host)).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('draws a live plan with live pins and no mark', async () => {
    serve(portStore, { plans: () => json(labelled('live')) });
    signIn();
    const host = await overview();
    const fresh = card(host, SOL_GROW);
    expect(fresh.querySelector('[data-ui="hatch-band"]')).toBeNull();
    expect(fresh.querySelector('[data-ui="sample-note"]')).toBeNull();
    expect(pins(fresh).map((pin) => pin.getAttribute('data-state'))).toEqual(['live', 'live']);
    expect(group(host, 'solana').querySelector('[data-ui="chain-mark"]')).toBeNull();
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('says a snapshot older than an hour is stale, with its age, as the answer says', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    // on a test network the figure keeps its hatched pin, and the card says stale with the age
    const stale = card(host, SOL_STALE);
    expect(part(stale, 'stale-plate')).toBe('stale · 3 h');
    expect(part(card(host, RH_SILENT), 'stale-plate')).toBe('stale · 26 h');
    // a fresh one says nothing of it
    expect(card(host, SOL_GROW).querySelector('[data-ui="stale-plate"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="plan-card"] [data-ui="stale-plate"]')).toHaveLength(3);
    // a chain's sum is as stale as its stalest part, and says so beside its hatched pin
    expect(part(find(group(host, 'solana'), '[data-ui="chain-total"]'), 'stale-plate')).toBe(
      'stale · 3 h',
    );
    expect(part(find(group(host, 'robinhood'), '[data-ui="chain-total"]'), 'stale-plate')).toBe(
      'stale · 26 h',
    );
    await unmountAll();

    // live, the figure's own pin says it too: hollow, with the word and the age
    serve(portStore, { plans: () => json(labelled('live')) });
    const live = await overview();
    const [value, putIn] = pins(card(live, SOL_STALE));
    expect(value?.getAttribute('data-state')).toBe('stale');
    expect(part(value as Element, 'stale-tag')).toBe('stale · 3 h');
    expect(value?.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Source for $251.90, stale, 3 hours old',
    );
    // what was put in is not a read of the vault: it is not stale with it
    expect(putIn?.getAttribute('data-state')).toBe('live');
    // a chain's sum is as stale as its stalest part
    const total = find(group(live, 'solana'), '[data-ui="chain-total"] [data-ui="figure"]');
    expect(total.getAttribute('data-state')).toBe('stale');
    expect(part(total, 'stale-tag')).toBe('stale · 3 h');
    // said once there: the pin says it, so the sum carries no plate beside it
    expect(
      find(group(live, 'solana'), '[data-ui="chain-total"]').querySelector(
        '[data-ui="stale-plate"]',
      ),
    ).toBeNull();
    expect(part(card(live, SOL_STALE), 'stale-plate')).toBe('stale · 3 h');
    expect(hatchProblems(parse(live.innerHTML))).toEqual([]);
  });

  it('says nothing of staleness for a chain whose every snapshot is fresh', async () => {
    const answer = plans();
    serve(portStore, {
      plans: () =>
        json({
          ...answer,
          chains: answer.chains.map((chain) => ({
            ...chain,
            plans: chain.plans.filter((plan) => plan.address === SOL_GROW),
          })),
        }),
    });
    signIn();
    const host = await overview();
    expect(cards(host)).toHaveLength(1);
    expect(host.querySelector('[data-ui="stale-plate"]')).toBeNull();
    // the sentence, the figure and its pin, and nothing after them
    expect(part(group(host, 'solana'), 'chain-total')).toMatch(
      /^Your plan on Solana is worth \$2,051\.37\s*$/,
    );
  });

  it('never works staleness out by itself: an old time the answer does not call stale is not stale', async () => {
    const answer = labelled('live');
    const old: PlansAnswer = {
      ...answer,
      chains: answer.chains.map((chain) => ({
        ...chain,
        plans: chain.plans.map((plan) =>
          plan.address === SOL_GROW && plan.newest
            ? { ...plan, newest: { ...plan.newest, observedAt: '2026-01-01T00:00:00.000Z' } }
            : plan,
        ),
      })),
    };
    serve(portStore, { plans: () => json(old) });
    signIn();
    const host = await overview();
    const c = card(host, SOL_GROW);
    expect(pins(c)[0]?.getAttribute('data-state')).toBe('live');
    expect(c.querySelector('[data-ui="stale-plate"]')).toBeNull();
    // the age is the answer's own figure, not the distance from the time
    expect(part(c, 'plan-read')).toContain('Read 4 minutes ago');
  });
});

describe('the sums of the overview', () => {
  it('counts the plans of each chain and adds up that chain alone, with the pin that says so', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    expect(part(host, 'plans-count')).toBe(
      'You have 7 plans on 2 chains. Each chain’s plans are added up on their own, never across chains.',
    );
    expect(
      [...host.querySelectorAll('[data-ui="chain-group"]')].map((g) =>
        g.getAttribute('data-chain'),
      ),
    ).toEqual(['solana', 'robinhood']);
    const solana = group(host, 'solana');
    expect(part(solana, 'chain-total')).toContain('Your 5 plans on Solana are worth $84,047.10');
    // the vault that was never read is in no sum, and the page says so
    expect(part(solana, 'chain-unread')).toBe(
      '1 vault hasn’t been read yet, so it is not in that sum.',
    );
    expect(part(solana, 'chain-answered')).toBe('Solana was last read on Oct 7, 2026, 11:56 UTC.');
    const robinhood = group(host, 'robinhood');
    expect(part(robinhood, 'chain-total')).toContain(
      'Your 2 plans on Robinhood Chain are worth $41.50',
    );
    expect(robinhood.querySelector('[data-ui="chain-unread"]')).toBeNull();
    expect(part(robinhood, 'chain-answered')).toBe(
      'Robinhood Chain was last read on Oct 6, 2026, 10:00 UTC.',
    );
    // the sum's pin says what was added: the newest snapshot of each vault that was read
    const total = find(solana, '[data-ui="chain-total"] [data-ui="figure"]');
    await click(find(total, 'button[data-ui="pin"]'));
    const source = text(find(total, '[data-ui="pin-source"]'));
    expect(source).toContain('your 4 vaults on Solana, each at its newest snapshot, added up');
    // the oldest of the snapshots it stands on
    expect(source).toContain('2026-10-07T08:55:00Z');
    // nothing adds the two chains up: the two totals are the only sums on the page
    expect(text(host)).not.toContain('$84,088.60');
    expect(host.querySelectorAll('[data-ui="chain-total"]')).toHaveLength(2);
  });

  it('says a chain is switched off in a sentence, and never shows a zero in its place', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const out = find(host, '[data-ui="chains-out"] [data-ui="status"]');
    expect(text(out)).toBe(t.portfolio.chainOff('Base'));
    expect(out.getAttribute('data-status')).toBe('watch');
    expect(host.querySelector('[data-ui="chain-group"][data-chain="base"]')).toBeNull();
    expect(text(host)).not.toContain(en.overview.chain.none('Base'));
  });

  it('says a chain that was read holds no plan, and a chain no vault of which was read shows no value', async () => {
    const answer = plans();
    const [solana, robinhood] = answer.chains;
    if (!solana || !robinhood) throw new Error('no chains');
    const never = solana.plans.filter((plan) => plan.address === SOL_NEVER);
    serve(portStore, {
      plans: () =>
        json({
          ...answer,
          chains: [
            { ...solana, plans: never, answeredAt: null },
            { ...robinhood, plans: [] },
          ],
        }),
    });
    signIn();
    const host = await overview();
    expect(part(host, 'plans-count')).toBe('You have 1 plan.');
    const group = find(host, '[data-ui="chain-group"]');
    expect(part(group, 'chain-none-read')).toBe(
      'Your plan on Solana hasn’t been read yet, so no value is shown.',
    );
    expect(part(group, 'chain-answered')).toBe('Solana hasn’t been read yet.');
    expect(pins(host)).toEqual([]);
    const empty = find(host, '[data-ui="chain-empty"]');
    expect(empty.getAttribute('data-chain')).toBe('robinhood');
    expect(text(empty)).toBe('You have no plan on Robinhood Chain yet.');
  });

  it('reads again on request, with a button that is never the page’s primary action', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    expect(part(host, 'plans-refresh')).toContain(en.overview.refresh);
    const again = find(host, '[data-action="read-again"]');
    expect(again.getAttribute('data-variant')).toBe('secondary');
    await click(again);
    await settle();
    expect(server.to(PLANS_PATH)).toHaveLength(2);
    expect(cards(host)).toHaveLength(7);
  });
});

describe('the overview, when there is nothing to read or the API cannot say', () => {
  it('asks someone signed out to sign in, with the serif on the title and no figure', async () => {
    const server = serve(portStore);
    const host = await overview();
    expect(server.to(PLANS_PATH)).toEqual([]);
    expect(text(host)).toContain(en.shell.signedOut);
    expect(find(host, 'a').getAttribute('href')).toBe('/sign-in?next=/portfolio');
    // with no card on the page the title is the serif line, once
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, '.font-display').tagName).toBe('H1');
    expect(pins(host)).toEqual([]);
  });

  it('says an empty portfolio in a sentence, and leads back to the goal', async () => {
    const answer = plans();
    serve(portStore, {
      plans: () =>
        json({
          ...answer,
          chains: answer.chains.map((chain) => ({ ...chain, plans: [] })),
          unavailable: [],
        }),
    });
    signIn();
    const host = await overview();
    expect(text(host)).toContain(en.shell.empty);
    expect(find(host, 'a[href="/goal"]').textContent).toBe(en.shell.startGoal);
    expect(cards(host)).toEqual([]);
    expect(pins(host)).toEqual([]);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
  });

  it('never says there is no plan while a chain of theirs could not be read', async () => {
    const answer = plans();
    serve(portStore, {
      plans: () => json({ ...answer, chains: answer.chains.map((c) => ({ ...c, plans: [] })) }),
    });
    signIn();
    const host = await overview();
    expect(text(find(host, '[data-ui="chains-out"]'))).toBe(t.portfolio.chainOff('Base'));
    expect(text(host)).not.toContain(en.shell.empty);
  });

  it.each([
    [() => json({ error: 'Route not found' }, 404), en.shell.failure.unavailable],
    [() => Promise.reject(new TypeError('fetch failed')), en.shell.failure.unreachable],
    [() => json({ chains: 'nope' }), en.shell.failure.unreadable],
    [() => json({ error: 'sign in first' }, 401), en.shell.failure.signedOut],
  ])('says a failed read in its own sentence, and draws no card: %#', async (answer, sentence) => {
    serve(portStore, { plans: answer });
    signIn();
    const host = await overview();
    expect(text(host)).toContain(sentence);
    expect(cards(host)).toEqual([]);
    expect(pins(host)).toEqual([]);
  });

  it('stands on the plans alone: a failed read of another route leaves the page as it is', async () => {
    serve(portStore, {
      exposure: () => json({ error: 'the database did not answer' }, 503),
      rebalances: () => Promise.reject(new TypeError('fetch failed')),
    });
    signIn();
    const host = await overview();
    expect(cards(host)).toHaveLength(7);
  });
});

describe('the overview in Portuguese', () => {
  it('says every word of a card in Portuguese, and the figures the Brazilian way', async () => {
    const pt = portfolioDictionary('pt');
    // Brazil's format puts a no-break space after "US$": read as a plain one here
    const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');
    const text = (el: Element) => plain(el.textContent ?? '');
    const part = (root: Element, ui: string) => text(find(root, `[data-ui="${ui}"]`));
    serve(portStore);
    signIn();
    const host = await overview('pt');
    expect(find(host, 'h1').textContent).toBe(pt.overview.title);
    const grow = card(host, SOL_GROW);
    expect(text(find(grow, 'h3'))).toBe('Fazer US$ 2.000 crescer em 36 meses.');
    expect(part(grow, 'status')).toBe('No caminho');
    expect(part(grow, 'plan-reason')).toBe(
      'Toda parte está a até 2% da fatia planejada, e as perdas do nosso operador usaram 12% do orçamento delas.',
    );
    expect(part(grow, 'plan-rule')).toBe('Regra ON-TRACK-V1');
    expect(
      [...find(grow, '[data-ui="plan-figures"]').querySelectorAll('dt, dd')].map((el) =>
        text(el).trim(),
      ),
    ).toEqual(['Valor agora', 'US$ 2.051,37', 'Você colocou', 'US$ 2.000,00']);
    expect(part(grow, 'plan-read')).toBe(
      plain(`Lido há 4 minutos, em ${utc('pt', '2026-10-07T11:56:00.000Z')}.`),
    );
    expect(part(grow, 'sample-note')).toBe(dictionary('pt').shell.testNetworkLine);
    expect(text(find(grow, 'a'))).toBe('Ver este plano ao longo do tempo');
    expect(part(card(host, SOL_INCOME), 'status')).toBe('Atenção');
    expect(part(card(host, RH_SILENT), 'status')).toBe('Fora do caminho');
    expect(part(card(host, SOL_NEVER), 'plan-no-status')).toBe('Ainda sem situação');
    expect(part(card(host, SOL_STALE), 'stale-plate')).toBe('desatualizado · 3 h');
    expect(text(find(card(host, SOL_STALE), 'h3'))).toBe('Seu cofre segue Steady dollars.');
    expect(part(group(host, 'robinhood'), 'chain-total')).toContain(
      'Seus 2 planos na Robinhood Chain valem US$ 41,50',
    );
    expect(part(host, 'plans-count')).toBe(pt.overview.count(7, 2));
    expect(part(group(host, 'solana'), 'chain-answered')).toBe(
      plain(pt.overview.chain.answered('Solana', utc('pt', '2026-10-07T11:56:10.000Z'))),
    );
    expect(text(find(host, '[data-ui="chains-out"]'))).toBe(
      dictionary('pt').portfolio.chainOff('Base'),
    );
    for (const pin of pins(host))
      expect(plain(pin.querySelector('button')?.getAttribute('aria-label') ?? '')).toMatch(
        /^Fonte de US\$ [\d.]+,\d\d, número de exemplo$/,
      );
    // no English sentence of the section is left on the page
    for (const english of [en.overview.title, en.overview.card.open, en.status.words.watch])
      expect(text(host)).not.toContain(english);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('the overview inside the section’s frame', () => {
  it('sits under the menu with the overview current, and the disclaimer once under it', async () => {
    serve(portStore);
    signIn();
    const host = await mount(inFrame('en', createElement(OverviewPage)));
    await settle();
    expect(find(host, '#portfolio-nav [aria-current="page"]').getAttribute('href')).toBe(
      '/portfolio',
    );
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
    expect(cards(host)).toHaveLength(7);
    // the frame adds no serif line of its own
    expect(host.querySelectorAll('.font-display')).toHaveLength(7);
  });
});
