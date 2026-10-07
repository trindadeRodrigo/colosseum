// @vitest-environment happy-dom
import { DISCLAIMER, DISCLAIMER_SHORT, TRUST_STATUS } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonClass } from '../../components/ui/button-class';
import { CHAIN_NAMES } from '../../components/ui/ChainBadge';
import {
  click,
  find,
  fire,
  mount,
  press,
  settle,
  type,
  unmountAll,
} from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, EVM, json, METAMASK, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { BuyScreen } from './BuyScreen';
import { recallOrder, trustAccepted } from './order-record';
import { PlanScreen } from './PlanScreen';
import { rememberPlan } from './plan-store';
import { ORDER_ID, orderOn, PLAN_ID, planOn, serverKeepsPlans, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
// the card draws the order's own screen, which holds the runner: nothing here presses it
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The plan screen and the buy screen with real events, against a double of the API: GET /v1/me,
// GET /v1/funding and POST /v1/orders in the shapes of API-2. The plan is the one the goal screen kept
// in the tab, since the API has no route that reads one back.

const en = dictionary('en');

type Call = { method: string; path: string; body?: unknown };

const funding = (ok: boolean) => ({
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  wallet: SOLANA,
  cash: {
    asset: 'solana:usdc',
    symbol: 'USDC',
    decimals: 6,
    haveRaw: ok ? '50000000000' : '0',
    needRaw: '40000000000',
    missingRaw: ok ? '0' : '40000000000',
    source: 'devnet RPC',
    fetchedAt: '2026-10-05T12:00:00.000Z',
    method: 'getTokenAccountBalance',
    provenance: 'sandbox',
  },
  gas: {
    symbol: 'SOL',
    decimals: 9,
    haveRaw: '1000000000',
    needRaw: '20000000',
    missingRaw: '0',
    source: 'devnet RPC',
    fetchedAt: '2026-10-05T12:00:00.000Z',
    method: 'getBalance',
    provenance: 'sandbox',
  },
  steps: 3,
  newVault: true,
  ok,
});

function api(
  o: {
    chain?: 'solana' | 'robinhood';
    /** The wallets the API read: a wallet made here of each family, unless said. */
    wallets?: Person['wallets'];
    funded?: boolean;
    order?: () => Response;
    /** Changes the funding answer before it is sent. */
    say?: (answer: ReturnType<typeof funding>) => unknown;
    /** Answers GET /v1/baskets/{id}: a plan made from a link. */
    linked?: unknown;
  } = {},
) {
  const calls: Call[] = [];
  const person: Person = {
    userId: USER,
    wallets: o.wallets ?? EMBEDDED,
    chain: o.chain ?? 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  let funded = o.funded ?? true;
  portStore.setApi(
    serverKeepsPlans(async (path, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/v1/me') return json(person);
      if (path.startsWith('/v1/funding?'))
        return json(o.say ? o.say(funding(funded)) : funding(funded));
      if (path === '/v1/orders' && method === 'POST') return o.order ? o.order() : json(orderOn());
      // the order the card shows, read back by its id
      if (path === `/v1/orders/${ORDER_ID}`) return o.order ? o.order() : json(orderOn());
      if (path === `/v1/baskets/${PLAN_ID}` && o.linked !== undefined) return json(o.linked);
      return json({ error: 'not found' }, 404);
    }),
  );
  return {
    calls,
    to: (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)),
    fund() {
      funded = true;
    },
  };
}

const plan = async () => {
  const host = await mount(withAccount('en', createElement(PlanScreen, { id: PLAN_ID })));
  await settle();
  await settle();
  return host;
};
const buy = async () => {
  const host = await mount(withAccount('en', createElement(BuyScreen, { id: PLAN_ID })));
  await settle();
  await settle(350);
  await settle();
  return host;
};
/** The card's one button: "Invest $X", held until there is an order to press. */
const SIGN = '[data-ui="invest-card"] [data-variant="primary"]';
/** Long enough for the wallet to be read and the order made for the amount. */
const made = async () => {
  await settle(350);
  await settle(450);
  await settle();
};
const label = (el: Element) =>
  el.querySelector('.grid > span:not([aria-hidden])')?.textContent ?? el.textContent;
const primaryLink = (host: HTMLElement) =>
  [...host.querySelectorAll('a')].find((a) =>
    a.className.includes(buttonClass({ variant: 'primary' })),
  );

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the plan screen', () => {
  it('shows the goal first, what the plan holds and why, the pins, the exit plan and the disclaimer', async () => {
    api();
    rememberPlan(planOn());
    const host = await plan();
    expect(find(host, 'h1').textContent).toBe('Grow $40,000 over 36 months.');
    // the limits are the heading: no chips say them again (the flow audit, finding 12)
    expect(host.textContent).not.toMatch(/amount: |chain: |horizon: /);
    // the bad fall is a sentence, not a bare figure with "estimate" beside it
    expect(host.querySelectorAll('[data-ui="stat"]')).toHaveLength(3);
    expect(find(host, '[data-ui="plan-bad-fall"]').textContent).toMatch(/^In a bad fall: /);
    // each asset by its name, never its id
    const legs = find(host, '[data-ui="plan-legs"]').textContent;
    expect(legs).toContain('SPYx');
    expect(legs).not.toMatch(/solana:|spyx/);
    expect(legs).toContain('Gold steadies the plan.');
    // the projected range carries its pin, and the exit cost its own
    expect(host.querySelectorAll('[data-ui="pin"]').length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-ui="exit-plan-line"]')?.textContent).toContain(
      'up to $40,000 within a day',
    );
    // the disclaimer is the shell's foot, once per page: the screen does not repeat it
    expect(host.textContent).not.toContain(DISCLAIMER.en);
    // nor its short line, which read as jargon on the plan ("Policy in your wallet, not a fund.")
    expect(host.textContent).not.toContain(DISCLAIMER_SHORT.en);
    // how the range was worked out is kept, behind Details
    expect(find(host, '[data-ui="plan-details"]').textContent).toContain('How it was worked out');
    // the API sent no risk roll-up, so there is no panel for one
    expect(host.textContent).not.toContain(en.plan.risk.title);
    // a plan built on a test network: the hatch and one quiet line, never the word MOCK
    expect(host.textContent).not.toContain('MOCK');
    // figures read from a test network are not samples: the card says "Test network", once
    expect(host.querySelector('[data-ui="sample-note"]')?.textContent).toBe(
      en.shell.testNetworkLine,
    );
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    const next = primaryLink(host);
    expect(next?.textContent).toBe(en.plan.buy);
    expect(next?.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
  });

  it('names every pin in the view’s language, the exit cost’s as well', async () => {
    api();
    rememberPlan(planOn());
    const host = await mount(withAccount('pt', createElement(PlanScreen, { id: PLAN_ID })));
    await settle();
    await settle();
    const pt = dictionary('pt').pin;
    const names = [...host.querySelectorAll('[data-ui="pin"]')].map(
      (pin) => pin.getAttribute('aria-label') ?? '',
    );
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const name of names) expect(name.startsWith(pt.sourceFor.split('{value}')[0])).toBe(true);
    const exit = find(host, '[data-ui="exit-plan-line"] [data-ui="pin"]');
    expect(exit.getAttribute('aria-label')).not.toContain(en.pin.sourceFor.split('{value}')[0]);
  });

  it('reads a month of the chart out under a crosshair: the keyboard, a mouse, a finger, and its legend', async () => {
    api();
    rememberPlan(planOn());
    const chart = find(await plan(), '[data-ui="plan-chart"]');
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

  it('draws his chart from the plan’s own range, pinned to its yield, and none from a range with no source', async () => {
    api();
    rememberPlan(planOn());
    const sourced = await plan();
    const chart = find(sourced, '[data-ui="plan-chart"]');
    // $40,000 for 36 months at 1% to 2% a year: $41,200 to $42,400, and nothing else worked out
    expect(chart.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      en.plan.chart.label(36, '1%', '2%'),
    );
    const pin = find(chart, '[data-ui="figure"]');
    expect(pin.textContent).toContain('$41,200 – $42,400');
    expect(pin.getAttribute('data-state')).toBe('mock');
    expect(chart.textContent).toContain(en.plan.chart.note);
    await unmountAll();
    // an income plan pays its yield out each month: no balance to draw, what it pays in all instead
    const income = planOn();
    income.proposal.card = { ...income.proposal.card, cashFlow: 'monthly' };
    rememberPlan(income);
    const paid = find(await plan(), '[data-ui="plan-chart"]');
    expect(paid.getAttribute('data-kind')).toBe('paid');
    expect(paid.querySelector('[role="img"]')).toBeNull();
    expect(find(paid, '[data-ui="figure"]').textContent).toContain('$1,200 – $2,400');
    await unmountAll();
    for (const change of [
      (p: ReturnType<typeof planOn>) => {
        p.proposal.flags = ['yield_not_read'];
      },
      (p: ReturnType<typeof planOn>) => {
        p.proposal.observations = p.proposal.observations.filter((o) => o.kind !== 'yield');
      },
    ]) {
      const stored = planOn();
      change(stored);
      rememberPlan(stored);
      const host = await plan();
      expect(host.querySelector('[data-ui="plan-chart"]')).toBeNull();
      await unmountAll();
    }
  });

  it('shows the risk roll-up as the API sent it, and a table when the plan has more than four parts', async () => {
    api();
    const base = planOn();
    const extra = ['solana:aaplx', 'solana:nvdax'].map((assetId) => ({
      chain: 'solana' as const,
      assetId,
      weightBps: 0,
      amountUsd: 0,
      reasons: [],
    }));
    rememberPlan({
      ...base,
      proposal: { ...base.proposal, lines: [...base.proposal.lines, ...extra] },
      rollUp: {
        byIssuer: [{ key: 'issuer one', bps: 6000 }],
        byChain: [{ key: 'solana', bps: 10_000 }],
        byClass: [{ key: 'stock', bps: 6000 }],
        flags: [],
        exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 42, measuredShareBps: 6000 },
      },
    });
    const host = await plan();
    expect(host.querySelector('[data-ui="plan-legs"]')).toBeNull();
    expect(host.querySelectorAll('tbody tr').length).toBeGreaterThanOrEqual(5);
    expect(host.textContent).toContain(en.plan.risk.title);
    expect(host.textContent).toContain('issuer one');
    expect(host.textContent).toContain(en.plan.risk.notMeasured);
  });

  it('shows no plan that this tab does not have, or that another person built', async () => {
    api();
    let host = await plan();
    expect(find(host, 'h1').textContent).toBe(en.plan.missing.title);
    await unmountAll();
    rememberPlan({ ...planOn(), userId: 'did:privy:someone-else' });
    host = await plan();
    expect(find(host, 'h1').textContent).toBe(en.plan.missing.title);
    expect(host.querySelector('[data-ui="plan-screen"]')).toBeNull();
  });

  it('opens a plan made from a link, read from the API by its id, and says where it came from', async () => {
    const server = api({ linked: { id: PLAN_ID, proposal: planOn().proposal } });
    const host = await plan();
    expect(server.to('/v1/baskets/').map((c) => c.path)).toEqual([`/v1/baskets/${PLAN_ID}`]);
    expect(find(host, '[data-ui="plan-screen"]')).toBeTruthy();
    expect(find(host, '[data-ui="plan-from-link"]').textContent).toBe(en.plan.fromLink);
    expect(primaryLink(host)?.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
    await unmountAll();
    // kept in the tab, so the buy screen opens on it without asking again, and buys it by its id
    const bought = await buy();
    expect(server.to('/v1/baskets/')).toHaveLength(1);
    await type(find<HTMLInputElement>(bought, 'input[inputmode="decimal"]'), '10');
    await made();
    expect(server.to('/v1/orders').flatMap((c) => (c.method === 'POST' ? [c.body] : []))).toEqual([
      { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: PLAN_ID },
    ]);
    // kept as a plan from a link, so the order screen names the buyer's own vault
    expect(recallOrder(ORDER_ID, USER)?.linked).toBe(true);
  });

  it('opens the person’s own plan in a tab that did not build it, read from the API, as their own', async () => {
    // a new tab, another device, a sign-in again: nothing is in this tab's store
    const server = api({ linked: { id: PLAN_ID, proposal: planOn().proposal, fromLink: false } });
    const host = await plan();
    expect(server.to('/v1/baskets/').map((c) => c.path)).toEqual([`/v1/baskets/${PLAN_ID}`]);
    expect(find(host, 'h1').textContent).toBe('Grow $40,000 over 36 months.');
    expect(host.textContent).not.toContain(en.plan.missing.title);
    // their own plan, not one from a link: it does not say it came from one, and its buy is not kept as one
    expect(host.querySelector('[data-ui="plan-from-link"]')).toBeNull();
    expect(primaryLink(host)?.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
    // the server keeps the plan and not its risk summary: the screen says so where the summary was
    expect(find(host, '[data-ui="plan-risk-not-kept"]').textContent).toBe(en.plan.risk.notKept);
    await unmountAll();
    // kept in the tab from then on: the buy screen opens on it without asking again
    const bought = await buy();
    expect(server.to('/v1/baskets/')).toHaveLength(1);
    await type(find<HTMLInputElement>(bought, 'input[inputmode="decimal"]'), '10');
    await made();
    expect(recallOrder(ORDER_ID, USER)).toMatchObject({ proposalId: PLAN_ID, amountUsd: 10 });
    expect(recallOrder(ORDER_ID, USER)?.linked).toBeUndefined();
  });

  it('asks for the plan once more with fresh tokens before it says there is none', async () => {
    // the route reads a sign-in and needs none: tokens gone stale are answered as nobody is, with a
    // 404 and no 401 to say why
    const asked: (boolean | undefined)[] = [];
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me') return json({ error: 'not this test' }, 503);
      if (path !== `/v1/baskets/${PLAN_ID}`) return json({ error: 'not found' }, 404);
      const fresh = (init as { freshSignIn?: boolean } | undefined)?.freshSignIn;
      asked.push(fresh);
      return fresh
        ? json({ id: PLAN_ID, proposal: planOn().proposal, fromLink: false })
        : json({ error: 'no plan with that id that you can read' }, 404);
    });
    await plan();
    expect(asked).toEqual([undefined, true]);
    await unmountAll();
    // and a plan that is not there is asked for twice, no more
    asked.length = 0;
    window.sessionStorage.clear();
    portStore.setApi(async (path, init) => {
      if (path === `/v1/baskets/${PLAN_ID}`)
        asked.push((init as { freshSignIn?: boolean } | undefined)?.freshSignIn);
      return json({ error: 'not found' }, 404);
    });
    await plan();
    expect(asked).toEqual([undefined, true]);
  });

  it('shows no plan from a link the API answers for another id, or that is not a plan', async () => {
    for (const linked of [
      { id: 'another', proposal: planOn().proposal },
      { id: PLAN_ID, proposal: { ...planOn().proposal, lines: [] } },
    ]) {
      window.sessionStorage.clear();
      api({ linked });
      const host = await plan();
      expect(find(host, 'h1').textContent).toBe(en.plan.missing.title);
      await unmountAll();
    }
    // and a plan this tab built is never said to come from a link
    api();
    rememberPlan(planOn());
    expect((await plan()).querySelector('[data-ui="plan-from-link"]')).toBeNull();
  });

  it('offers the buy of a plan on its own chain, whatever the current chain is (CHAIN-SWITCH)', async () => {
    const server = api({ chain: 'robinhood' });
    rememberPlan(planOn('solana'));
    const host = await plan();
    expect(primaryLink(host)?.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
    await unmountAll();
    // the buy reads the Solana wallet, the plan's, not the EVM wallet of the current chain
    await buy();
    expect(server.to('/v1/funding').at(-1)?.path).toBe(
      `/v1/funding?amountUsd=40000&proposalId=${PLAN_ID}&wallet=${SOLANA}`,
    );
  });

  it('offers no buy of a plan on a chain no wallet of the person’s signs on', async () => {
    portStore.set(signedInPort(METAMASK));
    api({ chain: 'robinhood', wallets: METAMASK });
    rememberPlan(planOn('solana'));
    const host = await plan();
    expect(host.textContent).toContain(en.plan.unsignable('Solana'));
    expect(primaryLink(host)).toBeUndefined();
  });

  it('offers the buy on Robinhood Chain, where its deployment is committed', async () => {
    api({ chain: 'robinhood' });
    rememberPlan(planOn('robinhood'));
    const host = await plan();
    expect(host.textContent).not.toContain(en.plan.chainNotReady('Robinhood Chain'));
    const next = primaryLink(host);
    expect(next?.textContent).toBe(en.plan.buy);
    expect(next?.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
  });
});

describe('the buy screen', () => {
  it('reads what the wallet is missing for the amount, and holds the button until it is there', async () => {
    const server = api({ funded: false });
    rememberPlan(planOn());
    const host = await buy();
    const read = server.to('/v1/funding');
    expect(read.at(-1)?.path).toBe(
      `/v1/funding?amountUsd=40000&proposalId=${PLAN_ID}&wallet=${SOLANA}`,
    );
    expect(host.textContent).toContain(en.buy.funding.short('Solana'));
    // in whole units, with the units the test network's deployment committed
    expect(host.textContent).toContain('40,000 USDC');
    const button = find(host, SIGN);
    expect(label(button)).toBe(en.invest.press('$40,000'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.buy.blocked.funding);
    await click(button);
    await made();
    // no order is made for a wallet that cannot pay for it
    expect(server.to('/v1/orders')).toEqual([]);
  });

  it('reads the funding figures with committed decimals, whatever decimals the answer states', async () => {
    // an answer that says 9 decimals for the dollar and 18 for SOL: 40,000 USDC would read as 40, and
    // the network fee as nothing
    api({
      funded: false,
      say: (a) => ({ ...a, cash: { ...a.cash, decimals: 9 }, gas: { ...a.gas, decimals: 18 } }),
    });
    rememberPlan(planOn());
    const host = await buy();
    expect(host.textContent).toContain(en.buy.funding.short('Solana'));
    expect(host.textContent).toContain('40,000 USDC');
    expect(host.textContent).toContain('1 SOL');
    expect(host.textContent).toContain('0.02 SOL');
    expect(host.textContent).not.toContain('40 USDC ');
  });

  it('asks for the trust notice once, before the first deposit, from the one constant', async () => {
    api();
    rememberPlan(planOn());
    const host = await buy();
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await made();
    const notice = find(host, '[data-ui="trust-notice"]');
    expect(notice.textContent).toContain(en.trust.unaudited);
    expect(notice.textContent).toContain(en.trust.admin(TRUST_STATUS.admin.solana as string));
    expect(notice.textContent).toContain(en.trust.keeper('0.75%', '1%'));
    // the order is on the card, and its press is held until the notice is ticked
    const button = find(host, SIGN);
    expect(label(button)).toBe(en.invest.press('$10'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.buy.blocked.trust);
    await click(find(notice, 'input[type="checkbox"]'));
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBeNull();
  });

  it('makes the order once the wallet holds the amount, keeps the plan beside it, and goes to no other page', async () => {
    const server = api();
    rememberPlan(planOn());
    const host = await buy();
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await made();
    expect(server.to('/v1/orders').flatMap((c) => (c.method === 'POST' ? [c.body] : []))).toEqual([
      { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: PLAN_ID },
    ]);
    // the review is on this card (INVEST-ONE-PRESS): the order's steps, and no second page
    expect(router.push).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[data-ui="invest-card"] [data-ui="order-step"]')).toHaveLength(2);
    const kept = recallOrder(ORDER_ID, USER);
    expect(kept).toMatchObject({
      proposalId: PLAN_ID,
      chain: 'solana',
      amountUsd: 10,
      approved: null,
    });
    // and the goal the plan was built for, which the portfolio's goal card is drawn from
    expect(kept?.goal?.sheet).toEqual(planOn().proposal.sheet);
    expect(kept?.goal?.card).toEqual(planOn().proposal.card);
    expect(Number.isNaN(Date.parse(kept?.goal?.placedAt ?? ''))).toBe(false);
    expect(kept?.lines).toEqual(planOn().proposal.lines);
    expect(kept?.linked).toBeUndefined();
    // making the order accepts nothing: the notice is kept only as the person presses
    // (invest.events.test.ts, which runs the press)
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(false);
  });

  it('says once on each card that its figures are from a test network, and never MOCK', async () => {
    api({ funded: false });
    rememberPlan(planOn());
    const host = await buy();
    expect(host.textContent).not.toMatch(/MOCK/);
    // The buy card's own line (gate BUY-STEPS): a test network's figures are real reads, not samples.
    const lines = [...host.querySelectorAll('[data-ui="data-note"], [data-ui="sample-note"]')].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual([en.buy.steps.note.testNetwork('Solana')]);
  });

  it('on Robinhood Chain: reads the funding in tUSDG and ETH, and makes the order for the EVM wallet', async () => {
    const server = api({
      chain: 'robinhood',
      funded: false,
      say: (a) => ({
        ...a,
        chain: 'robinhood',
        name: 'Robinhood Chain',
        wallet: EVM,
        cash: { ...a.cash, asset: 'robinhood:tusdg', symbol: 'tUSDG' },
        gas: {
          ...a.gas,
          symbol: 'ETH',
          decimals: 18,
          haveRaw: '0',
          needRaw: '24000000000000',
          missingRaw: '24000000000000',
        },
      }),
    });
    rememberPlan(planOn('robinhood'));
    const host = await buy();
    expect(server.to('/v1/funding').at(-1)?.path).toBe(
      `/v1/funding?amountUsd=40000&proposalId=${PLAN_ID}&wallet=${EVM}`,
    );
    expect(host.textContent).toContain(en.buy.funding.short('Robinhood Chain'));
    expect(host.textContent).toContain('40,000 tUSDG');
    expect(host.textContent).toContain('ETH');
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
    expect(server.to('/v1/orders')).toEqual([]);

    await unmountAll();
    const funded = api({
      chain: 'robinhood',
      order: () => json(orderOn('robinhood')),
      say: (a) => ({
        ...a,
        chain: 'robinhood',
        name: 'Robinhood Chain',
        wallet: EVM,
        cash: { ...a.cash, asset: 'robinhood:tusdg', symbol: 'tUSDG' },
        gas: { ...a.gas, symbol: 'ETH', decimals: 18, needRaw: '24000000000000' },
      }),
    });
    const ready = await buy();
    await type(find<HTMLInputElement>(ready, 'input[inputmode="decimal"]'), '10');
    await made();
    // the trust notice names Robinhood Chain's admin and its keeper's limits
    expect(find(ready, '[data-ui="trust-notice"]').textContent).toContain(
      en.trust.admin(TRUST_STATUS.admin.robinhood as string),
    );
    expect(funded.to('/v1/orders').flatMap((c) => (c.method === 'POST' ? [c.body] : []))).toEqual([
      { type: 'buy', owner: { evm: EVM }, amountUsd: 10, proposalId: PLAN_ID },
    ]);
    // the order's two steps on the card, the permission first, and the press that names the amount
    expect(ready.querySelectorAll('[data-ui="invest-card"] [data-ui="order-step"]')).toHaveLength(
      2,
    );
    expect(label(find(ready, SIGN))).toBe(en.invest.press('$10'));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says what the person can do when the order is refused, and goes nowhere', async () => {
    api({ order: () => json({ error: 'x', code: 'VERSION_CHANGED' }, 409) });
    rememberPlan(planOn());
    window.localStorage.setItem(
      `tf-trust:${USER}`,
      JSON.stringify({ textVersion: TRUST_STATUS.textVersion }),
    );
    const host = await buy();
    await made();
    expect(host.textContent).toContain(en.trust.accepted);
    expect(find(host, '[role="alert"]').textContent).toBe(en.buy.failure.VERSION_CHANGED);
    // nothing to press but reading the prices again
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe.each(['solana', 'robinhood'] as const)('the chain, on %s', (chain) => {
  /** Every chain badge on the screen, by the chain it names. */
  const badges = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-ui="chain-badge"]')].map((b) => [
      b.getAttribute('data-chain'),
      b.textContent,
    ]);
  const named = [chain, CHAIN_NAMES[chain]];
  const onChain = (a: ReturnType<typeof funding>) =>
    chain === 'solana'
      ? a
      : {
          ...a,
          chain,
          name: 'Robinhood Chain',
          wallet: EVM,
          cash: { ...a.cash, asset: 'robinhood:tusdg', symbol: 'tUSDG' },
          gas: { ...a.gas, symbol: 'ETH', decimals: 18, needRaw: '24000000000000' },
        };

  it('is badged on the plan screen, and a Robinhood plan never says USDC', async () => {
    api({ chain });
    rememberPlan(planOn(chain));
    const host = await plan();
    expect(badges(host)).toEqual([named]);
    expect(find(host, 'header [data-ui="chain-badge"]').textContent).toBe(CHAIN_NAMES[chain]);
    if (chain === 'robinhood') expect(host.textContent).not.toMatch(/usdc/i);
  });

  it('is badged on the buy screen, and a Robinhood buy never says USDC', async () => {
    // a wallet that is short, so the card says what it is missing, in the chain's own dollar
    api({ chain, funded: false, say: onChain });
    rememberPlan(planOn(chain));
    const host = await buy();
    expect(badges(host)).toEqual([named]);
    if (chain === 'robinhood') {
      expect(host.textContent).toContain('tUSDG');
      expect(host.textContent).not.toMatch(/usdc/i);
    }
  });
});
