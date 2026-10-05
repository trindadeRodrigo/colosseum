// @vitest-environment happy-dom
import { DISCLAIMER, DISCLAIMER_SHORT, TRUST_STATUS } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonClass } from '../../components/ui/button-class';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { BuyScreen } from './BuyScreen';
import { recallOrder, trustAccepted } from './order-record';
import { PlanScreen } from './PlanScreen';
import { rememberPlan } from './plan-store';
import { ORDER_ID, orderOn, PLAN_ID, planOn, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
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
    funded?: boolean;
    order?: () => Response;
    /** Changes the funding answer before it is sent. */
    say?: (answer: ReturnType<typeof funding>) => unknown;
  } = {},
) {
  const calls: Call[] = [];
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: o.chain ?? 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  let funded = o.funded ?? true;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/me') return json(person);
    if (path.startsWith('/v1/funding?'))
      return json(o.say ? o.say(funding(funded)) : funding(funded));
    if (path === '/v1/orders' && method === 'POST') return o.order ? o.order() : json(orderOn());
    return json({ error: 'not found' }, 404);
  });
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
    // the plan pane of the showcase: the limits as chips, the figures as stat cells, the legs
    const chips = find(host, `ul[aria-label="${en.plan.chips.label}"]`).textContent;
    expect(chips).toContain('amount: $40,000');
    expect(chips).toContain('chain: Solana');
    expect(host.querySelectorAll('[data-ui="stat"]')).toHaveLength(4);
    const legs = find(host, '[data-ui="plan-legs"]').textContent;
    expect(legs).toContain('spyx');
    expect(legs).not.toContain('solana:');
    expect(legs).toContain('Gold steadies the plan.');
    // the projected range carries its pin, and the exit cost its own
    expect(host.querySelectorAll('[data-ui="pin"]').length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-ui="exit-plan-line"]')?.textContent).toContain(
      'up to $40,000 within a day',
    );
    // the disclaimer is the shell's foot, once per page: the screen does not repeat it
    expect(host.textContent).not.toContain(DISCLAIMER.en);
    expect(host.textContent).toContain(DISCLAIMER_SHORT);
    expect(host.textContent).toContain(en.plan.foot.sandbox);
    // the API sent no risk roll-up, so there is no panel for one
    expect(host.textContent).not.toContain(en.plan.risk.title);
    // a plan built on a test network: the plate, the hatch and the words
    expect(host.textContent).toContain('MOCK');
    expect(host.textContent).toContain(en.shell.testNetwork);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    const next = primaryLink(host);
    expect(next?.textContent).toBe(en.plan.buy);
    expect(next?.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
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

  it('offers no buy of a plan made for another chain than the person’s', async () => {
    api({ chain: 'robinhood' });
    rememberPlan(planOn('solana'));
    const host = await plan();
    expect(host.textContent).toContain(en.plan.otherChain('Solana', 'Robinhood Chain'));
    expect(primaryLink(host)).toBeUndefined();
  });

  it('says plainly that Robinhood Chain is not ready, and offers no buy there', async () => {
    api({ chain: 'robinhood' });
    rememberPlan(planOn('robinhood'));
    const host = await plan();
    expect(primaryLink(host)).toBeUndefined();
    const button = find(host, '[data-variant="primary"]');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.plan.chainNotReady('Robinhood Chain'));
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
    expect(host.textContent).toContain('40,000 tUSDC');
    const button = find(host, '[data-variant="primary"]');
    expect(label(button)).toBe(en.buy.review('$40,000'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.buy.blocked.funding);
    await click(button);
    expect(server.to('/v1/orders')).toEqual([]);
  });

  it('reads the funding figures with committed decimals, whatever decimals the answer states', async () => {
    // an answer that says 9 decimals for the dollar and 18 for SOL: 40,000 tUSDC would read as 40, and
    // the network fee as nothing
    api({
      funded: false,
      say: (a) => ({ ...a, cash: { ...a.cash, decimals: 9 }, gas: { ...a.gas, decimals: 18 } }),
    });
    rememberPlan(planOn());
    const host = await buy();
    expect(host.textContent).toContain(en.buy.funding.short('Solana'));
    expect(host.textContent).toContain('40,000 tUSDC');
    expect(host.textContent).toContain('1 SOL');
    expect(host.textContent).toContain('0.02 SOL');
    expect(host.textContent).not.toContain('40 tUSDC ');
  });

  it('asks for the trust notice once, before the first deposit, from the one constant', async () => {
    api();
    rememberPlan(planOn());
    const host = await buy();
    const notice = find(host, '[data-ui="trust-notice"]');
    expect(notice.textContent).toContain(en.trust.unaudited);
    expect(notice.textContent).toContain(en.trust.admin(TRUST_STATUS.admin.solana as string));
    expect(notice.textContent).toContain(en.trust.keeper('0.75%', '1%'));
    const button = find(host, '[data-variant="primary"]');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.buy.blocked.trust);
    await click(find(notice, 'input[type="checkbox"]'));
    expect(find(host, '[data-variant="primary"]').getAttribute('aria-disabled')).toBeNull();
  });

  it('makes the order, keeps the plan beside it and the acceptance, then goes to its review', async () => {
    const server = api();
    rememberPlan(planOn());
    const host = await buy();
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await settle(350);
    await click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));
    await click(find(host, '[data-variant="primary"]'));
    await settle();
    expect(server.to('/v1/orders').map((c) => c.body)).toEqual([
      { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: PLAN_ID },
    ]);
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
    const kept = recallOrder(ORDER_ID, USER);
    expect(kept).toMatchObject({
      proposalId: PLAN_ID,
      chain: 'solana',
      amountUsd: 10,
      approved: null,
    });
    expect(kept?.lines).toEqual(planOn().proposal.lines);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion)).toBe(true);
  });

  it('says what the person can do when the order is refused, and goes nowhere', async () => {
    api({ order: () => json({ error: 'x', code: 'VERSION_CHANGED' }, 409) });
    rememberPlan(planOn());
    window.localStorage.setItem(
      `tf-trust:${USER}`,
      JSON.stringify({ textVersion: TRUST_STATUS.textVersion }),
    );
    const host = await buy();
    expect(host.textContent).toContain(en.trust.accepted);
    await click(find(host, '[data-variant="primary"]'));
    await settle();
    expect(find(host, '[role="alert"]').textContent).toBe(en.buy.failure.VERSION_CHANGED);
    expect(router.push).not.toHaveBeenCalled();
  });
});
