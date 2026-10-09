// @vitest-environment happy-dom
import type { OrderDetail, VaultView } from '@colosseum/schemas';
import { type ExecutionResult, type ExecutorDeps, solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { keepOrder } from '../order/order-record';
import { assetsOn, orderOn } from '../order/test/fixtures';
import { PORTFOLIO_PATH } from '../portfolio/portfolio';
import { vaultTitle } from '../portfolio/vault-name';
import { EMBEDDED, fakePort, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import type { SharedTerms } from './terms';
import { CREATOR, ORDER_ID, retargetOrder, USER, vaultOf, withdrawOrder } from './test/fixtures';
import { keepAction, recallAction } from './VaultAction';
import { VaultScreen } from './VaultScreen';

// A person's own vault page (gate VAULT-PAGE-ACTIONS), with real events against a double of the API:
// what the head and the pane show, who is offered the actions, each state of the pane and the way out
// of it, a withdrawal signed in the pane with no other page opened, and an action taken up again after
// a reload. Only `execute` is a double. The deposit's own steps are walked in e2e/vault-page.spec.ts,
// against the stub's chain.

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
  answer: 'done' as 'done' | 'failed',
  /** The order the executor answers with, where a test says how its steps ended. */
  result: null as OrderDetail | null,
}));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return Promise.resolve(
      (run.answer === 'done'
        ? { status: 'done', order: run.result ?? { ...order, status: 'done' } }
        : {
            status: 'failed',
            order: { ...order, status: 'failed' },
            error: { code: 'Unknown', message: 'it failed on chain', retryable: false },
          }) as unknown as ExecutionResult,
    );
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const p = en.shared.vault.page;
const w = en.withdraw;
const MY_VAULT = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '42');
const CASH = 'solana:usdc';
const SPYX = 'solana:spyx';
const holding = (asset: string, raw: string, display: string) => ({
  asset,
  raw,
  multiplier: '1',
  display,
});
/** 600 USDC and 2.5 SPYx: 45% in SPYx where the plan says 40%. */
const held = (over: Partial<VaultView> = {}) =>
  vaultOf({
    address: MY_VAULT,
    cash: holding(CASH, '600000000', '600'),
    positions: [
      {
        ...holding(SPYX, '250000000', '2.5'),
        targetBps: 4_000,
        lastKeeperAt: null,
        valueUsd: '450',
        weightBps: 4_500,
        driftBps: 500,
      },
    ] as VaultView['positions'],
    valueUsd: '1050',
    ...over,
  });
const nothing = (targetBps: number) =>
  held({
    cash: holding(CASH, '0', '0'),
    positions: (targetBps
      ? [
          {
            ...holding(SPYX, '0', '0'),
            targetBps,
            lastKeeperAt: null,
            valueUsd: '0',
            weightBps: 0,
            driftBps: -targetBps,
          },
        ]
      : []) as VaultView['positions'],
    valueUsd: '0',
  });
const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};
const item = (asset: string, heldRaw: string) => ({ asset, amountRaw: null, heldRaw });
const everything = () =>
  withdrawOrder([[item(CASH, '600000000')], [item(SPYX, '250000000')]]) as OrderDetail;

function api(
  o: {
    vault?: VaultView;
    order?: () => OrderDetail;
    listed?: object;
    provenance?: string;
    /** The answer to POST /v1/orders is held until the test lets it go. */
    placing?: Promise<void>;
    /** What `GET /v1/orders/{id}` says, where it differs from the order placed. */
    standing?: () => OrderDetail;
    /** Other paths, answered before the defaults. */
    more?: (path: string, method: string) => Response | Promise<Response> | undefined;
  } = {},
) {
  const calls: { method: string; path: string }[] = [];
  const state = { vault: o.vault ?? held() };
  const provenance = o.provenance ?? 'sandbox';
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    const other = o.more?.(path, method);
    if (other) return other;
    if (path === '/v1/me') return json(person);
    if (path === PORTFOLIO_PATH)
      return json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance,
            prices: [],
            vaults: [{ ...state.vault, provenance, ...o.listed }],
          },
        ],
        disclaimer: 'd',
      });
    if (path.startsWith('/v1/vaults/solana/') && !path.includes('/conversation'))
      return json({
        chain: 'solana',
        name: 'Solana',
        mode: 'live',
        provenance,
        vault: { ...state.vault, provenance },
        prices: [],
        disclaimer: 'the disclaimer',
      });
    if (path === '/v1/orders' && method === 'POST') {
      await o.placing;
      return json(o.order?.() ?? everything());
    }
    if (path === `/v1/orders/${ORDER_ID}`)
      return json(o.standing?.() ?? o.order?.() ?? everything());
    return json({ error: 'not found' }, 404);
  });
  return {
    calls,
    state,
    reads: () => calls.filter((c) => c.path === `/v1/vaults/solana/${MY_VAULT}`).length,
  };
}
const show = async () => {
  const host = await mount(
    withAccount('en', createElement(VaultScreen, { chain: 'solana', address: MY_VAULT })),
  );
  for (let i = 0; i < 4; i += 1) await settle(30);
  return host;
};
const screen = (host: HTMLElement) => find(host, '[data-ui="vault-screen"]');
const pane = (host: HTMLElement) => find(host, '[data-ui="vault-action-pane"]');
const button = (host: Element, name: string) => {
  const found = [...host.querySelectorAll<HTMLElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(name),
  );
  if (!found) throw new Error(`no button "${name}"`);
  return found;
};
/** From the page through the withdrawal's choice and review to its order, in the pane. */
async function toSteps(host: HTMLElement) {
  await click(find(host, '[data-action="vault-withdraw"]'));
  await settle();
  await settle();
  await click(button(pane(host), w.steps.next));
  await click(
    find(pane(host), '[data-ui="withdraw-step"][data-step="check"] input[type="checkbox"]'),
  );
  await click(
    button(find(pane(host), '[data-ui="withdraw-step"][data-step="check"]'), w.steps.next),
  );
  await click(button(pane(host), w.confirm.button));
  for (let i = 0; i < 4; i += 1) await settle(30);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  localStorage.clear();
  sessionStorage.clear();
  router.push.mockClear();
  run.calls = [];
  run.answer = 'done';
  run.result = null;
  Object.defineProperty(window.navigator, 'locks', {
    value: {
      request: async (_n: string, _o: object, work: (lock: { name: string }) => Promise<unknown>) =>
        work({ name: 'order' }),
    },
    configurable: true,
  });
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

describe('what a vault is called', () => {
  const words = en.portfolio.actions;
  it('is the name its owner gave it, whatever its number', () => {
    expect(vaultTitle({ name: 'Rent', number: 2 }, words, 'Solana')).toBe('Rent');
  });
  it('is "Vault #N" where the server numbers it and it has no name', () => {
    expect(vaultTitle({ name: null, number: 2 }, words, 'Solana')).toBe('Vault #2');
    expect(vaultTitle({ number: 1 }, words, 'Solana')).toBe('Vault #1');
  });
  it('is by its chain until there is a number', () => {
    expect(vaultTitle({ name: null }, words, 'Solana')).toBe(words.unnamed('Solana'));
  });
  it('is drawn so on the page: the name, or the unnamed title that does not repeat the chain', async () => {
    // (the number reaches the page once the portfolio's answer carries it: the schema drops a field
    // it does not know, so that case is the helper's above until the API has it)
    api({ listed: { name: 'Rent' } });
    expect(find(await show(), 'h1').textContent).toBe('Rent');
    await unmountAll();
    api();
    expect(find(await show(), 'h1').textContent).toBe(p.yourVault);
  });
});

describe('a direct load of the page', () => {
  it('as the owner: the title waits for their portfolio, then is the name, with no other title between', async () => {
    // the portfolio's answer is held back, as it is while the sign-in is still arriving
    let answer: (response: Response) => void = () => {};
    const waiting = new Promise<Response>((done) => {
      answer = done;
    });
    const vault = { ...held(), provenance: 'sandbox' };
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(person);
      if (path === PORTFOLIO_PATH) return waiting;
      if (path === `/v1/vaults/solana/${MY_VAULT}`)
        return json({
          chain: 'solana',
          name: 'Solana',
          mode: 'live',
          provenance: 'sandbox',
          vault,
          prices: [],
          disclaimer: 'd',
        });
      return json({ error: 'not found' }, 404);
    });
    const host = await show();
    expect(find(host, 'h1').dataset.ui).toBe('vault-name-wait');
    expect(find(host, 'h1').getAttribute('aria-busy')).toBe('true');
    // neither the visitor's title nor the unnamed one stands in for it
    expect(find(host, 'h1').textContent).toBe(en.shared.vault.loading);
    expect(host.textContent).not.toContain(en.shared.vault.title);
    answer(
      json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            prices: [],
            vaults: [{ ...vault, name: 'Rent' }],
          },
        ],
        disclaimer: 'd',
      }),
    );
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(find(host, 'h1').textContent).toBe('Rent');
    expect(host.querySelector('[data-ui="vault-name-wait"]')).toBeNull();
  });
  it('as a visitor: the page’s own title at once, and nothing waits for a portfolio', async () => {
    api({ vault: held({ owner: CREATOR }) });
    const host = await show();
    expect(find(host, 'h1').textContent).toBe(en.shared.vault.title);
    expect(host.querySelector('[data-ui="vault-name-wait"]')).toBeNull();
    expect(host.querySelector('[data-ui="vault-name"]')).toBeNull();
  });
});

describe('the owner’s page at rest', () => {
  it('says what the person has: the value on its pin and the chain once, with no badge', async () => {
    api();
    const host = await show();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    const value = find(host, '[data-ui="vault-value"]');
    expect(value.textContent).toContain('$1,050.00');
    expect(value.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(find(host, '[data-ui="vault-chain"]').textContent).toBe('Solana');
    expect(host.querySelector('[data-ui="chain-badge"]')).toBeNull();
    // the test network is said once in the pane, on the holdings' card
    expect(host.textContent?.split(en.shell.testNetworkLine)).toHaveLength(2);
  });

  it('leads with the pair, Deposit the one primary, and keeps the rest behind "More"', async () => {
    api();
    const host = await show();
    const actions = find(host, '[data-ui="vault-page-actions"]');
    expect(find(actions, '[data-action="vault-deposit"]').dataset.variant).toBe('primary');
    expect(find(actions, '[data-action="vault-withdraw"]').dataset.variant).toBe('secondary');
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    const more = find(actions, '[data-ui="vault-more"]');
    const list = find(actions, '[data-ui="vault-more-list"]');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    await click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      p.editWeights,
      en.shared.publish.shareStrategy,
      en.shared.vault.explorer('Solscan'),
    ]);
    // the way back is navigation: a link over the name, not one of the actions
    const back = find(host, '[data-ui="vault-back"]');
    expect(back.getAttribute('href')).toBe('/monitor');
    expect(actions.contains(back)).toBe(false);
    // nothing a person reads says "mix" or "buy"
    expect(screen(host).textContent).not.toMatch(/\b(mix|buy)\b/i);
  });

  it('shows the holdings with nothing to open: the bar, then one table with planned beside now', async () => {
    api();
    const host = await show();
    const plan = find(host, '[data-ui="vault-plan"]');
    expect(plan.querySelector('[data-ui="holding-legs"]')).not.toBeNull();
    expect(plan.querySelector('[data-ui="vault-details"]')?.contains(find(plan, 'table'))).toBe(
      false,
    );
    expect([...plan.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      en.shared.vault.columns.asset,
      en.shared.vault.columns.held,
      en.shared.vault.columns.price,
      en.shared.vault.columns.target,
      en.shared.vault.columns.weight,
    ]);
    // the difference under each share: signed, by direction, and said in words
    const drifts = [...plan.querySelectorAll<HTMLElement>('table [data-ui="holding-drift"]')];
    expect(drifts.map((d) => d.dataset.direction)).toEqual(['over', 'under']);
    expect(drifts[0]?.textContent).toContain(p.against('+5%'));
    expect(drifts[1]?.textContent).toContain(p.against('−5%'));
  });

  it('keeps the technical rows behind one closed "Details", addresses shortened with a copy', async () => {
    api({ vault: held({ autoFollow: false }) });
    const host = await show();
    const details = find<HTMLDetailsElement>(host, '[data-ui="vault-details"]');
    expect(host.querySelectorAll('details[data-ui="vault-details"]')).toHaveLength(1);
    expect(details.open).toBe(false);
    expect(find(details, 'summary').textContent).toBe(p.details);
    const address = find(details, '[data-ui="vault-address"]');
    expect(address.textContent).not.toContain(MY_VAULT);
    expect(find(address, 'span[title]').getAttribute('title')).toBe(MY_VAULT);
    expect(address.querySelector('[data-ui="copy-button"]')).not.toBeNull();
    expect(find(details, '[data-ui="vault-owner"] span[title]').getAttribute('title')).toBe(SOLANA);
    // the auto-follow note is beside the setting, not among the actions
    const note = find(host, '[data-ui="vault-auto-follow-off"]');
    expect(details.contains(note)).toBe(true);
  });
});

describe('who is offered the actions', () => {
  const owned = [
    '[data-ui="vault-page-actions"]',
    '[data-action="vault-deposit"]',
    '[data-action="vault-withdraw"]',
    '[data-action="vault-edit-weights"]',
    '[data-ui="vault-share-strategy"]',
    '[data-ui="vault-conversation"]',
    '[data-action="rename"]',
  ];
  it('a visitor sees the vault and none of them', async () => {
    api({ vault: held({ owner: CREATOR }) });
    const host = await show();
    expect(find(host, 'h1').textContent).toBe(en.shared.vault.title);
    for (const selector of owned) expect(host.querySelector(selector), selector).toBeNull();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    // and still what it holds, and the way to its chain's explorer
    expect(host.querySelector('[data-ui="holding-legs"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="vault-explorer"]')).not.toBeNull();
  });
  it('a signed-out reader sees none either', async () => {
    api();
    portStore.set(fakePort());
    const host = await show();
    for (const selector of owned) expect(host.querySelector(selector), selector).toBeNull();
  });
  it('an action kept for the owner is not opened for anybody else', async () => {
    api({ vault: held({ owner: CREATOR }) });
    keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
    const host = await show();
    expect(host.querySelector('[data-ui="vault-action-pane"]')).toBeNull();
    expect(host.querySelector('[data-ui="order-screen"]')).toBeNull();
  });
});

describe('an empty vault', () => {
  it('with targets: says so once, shows what a deposit goes into, and has Deposit as its one action', async () => {
    api({ vault: nothing(4_000) });
    const host = await show();
    const plan = find(host, '[data-ui="vault-plan"]');
    expect(find(plan, '[data-ui="vault-empty"]').textContent).toBe(p.empty.withTargets);
    expect(find(plan, '[data-ui="vault-empty-targets"]').textContent).toContain('40%');
    expect(host.querySelectorAll('[data-action="vault-deposit"]')).toHaveLength(1);
    expect(plan.querySelector('[data-action="vault-deposit"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(host.querySelector('[data-action="vault-withdraw"]')).toBeNull();
    // the conversation starts from what fits an empty vault
    const chat = find(host, '[data-ui="vault-chat"]');
    expect(chat.textContent).toContain(p.empty.choose);
    expect(chat.textContent).toContain(p.empty.explain);
    expect(chat.textContent).not.toContain(en.shared.vault.conversation.explain);
    // a strategy is its targets: this one can still be shared
    expect(host.querySelector('[data-ui="vault-share-strategy"]')).not.toBeNull();
  });
  it('with no targets: one sentence, Deposit, and nothing to share', async () => {
    api({ vault: nothing(0) });
    const host = await show();
    expect(find(host, '[data-ui="vault-empty"]').textContent).toBe(p.empty.noTargets);
    expect(host.querySelector('[data-ui="vault-empty-targets"]')).toBeNull();
    expect(host.querySelector('[data-ui="holding-legs"]')).toBeNull();
    expect(host.querySelectorAll('[data-action="vault-deposit"]')).toHaveLength(1);
    expect(host.querySelector('[data-ui="vault-share-strategy"]')).toBeNull();
    expect(find(host, '[data-ui="vault-chat"]').textContent).not.toContain(p.empty.explain);
  });
});

describe('the pane’s states, and the way out of each', () => {
  it('deposit: the amount and the card take the pane, the box waits and says why, and "Back" restores the holdings and the focus', async () => {
    api();
    const host = await show();
    expect(screen(host).dataset.pane).toBe('holdings');
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    expect(screen(host).dataset.pane).toBe('deposit');
    expect(pane(host).dataset.state).toBe('open');
    const title = find(pane(host), ':scope > header h2');
    expect(title.textContent).toBe(p.panes.deposit.title);
    expect(document.activeElement).toBe(title);
    // the add-money card, with its amount field, in the pane
    expect(pane(host).querySelector('[data-ui="vault-invest"]')).not.toBeNull();
    expect(pane(host).querySelector('input[inputmode="decimal"]')).not.toBeNull();
    // the holdings are set aside, the pair steps back, the conversation is inert
    expect(find(host, '[data-ui="vault-plan"]').hidden).toBe(true);
    expect(host.querySelector('[data-ui="vault-page-actions"]')).toBeNull();
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.deposit);
    expect(find(host, '[data-ui="vault-chat"] textarea').closest('[inert]')).not.toBeNull();
    // nothing was asked of the server for an order, and no page was opened
    expect(router.push).not.toHaveBeenCalled();
    await click(find(pane(host), '[data-action="leave-action"]'));
    expect(screen(host).dataset.pane).toBe('holdings');
    expect(host.querySelector('[data-ui="vault-action-pane"]')).toBeNull();
    expect(find(host, '[data-ui="vault-plan"]').hidden).toBe(false);
    expect(host.querySelector('[data-ui="vault-chat-waits"]')).toBeNull();
    expect(document.activeElement).toBe(find(host, '[data-action="vault-deposit"]'));
  });

  it('deposit, for a vault the portfolio does not list: one sentence in the pane, no second title and no link away', async () => {
    api({
      more: (path) => (path === PORTFOLIO_PATH ? json({ chains: [], disclaimer: 'd' }) : undefined),
    });
    const host = await show();
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    expect(find(pane(host), '[data-ui="add-money-missing"]').textContent).toBe(
      en.portfolio.add.missing,
    );
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(pane(host).querySelector('h1')).toBeNull();
    expect(pane(host).querySelector('a[href="/monitor"]')).toBeNull();
    expect(pane(host).querySelector('[data-action="leave-action"]')).not.toBeNull();
  });

  it('weights by hand: behind "More", the editor in the pane, and back to "More"', async () => {
    api();
    const host = await show();
    await click(find(host, '[data-ui="vault-more"]'));
    await click(find(host, '[data-action="vault-edit-weights"]'));
    await settle();
    expect(screen(host).dataset.pane).toBe('weights');
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.panes.change.title);
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.change);
    expect(router.push).not.toHaveBeenCalled();
    await click(find(pane(host), '[data-action="leave-action"]'));
    expect(screen(host).dataset.pane).toBe('holdings');
    expect(document.activeElement).toBe(find(host, '[data-ui="vault-more"]'));
  });

  it('withdraw: chosen, reviewed and signed in the pane, with no other page, then the vault is read again', async () => {
    const server = api();
    const again = await show();
    await toSteps(again);
    // the withdrawal's own screen, under the page's heading: no second title
    expect(again.querySelectorAll('h1')).toHaveLength(1);
    // the order is drawn in the pane, held to what was reviewed; nothing was opened
    expect(router.push).not.toHaveBeenCalled();
    expect(pane(again).dataset.state).toBe('open');
    expect(find(pane(again), ':scope > header h2').textContent).toBe(p.panes.withdraw.signTitle);
    expect(pane(again).querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    expect(pane(again).textContent).toContain(SOLANA);
    expect(pane(again).querySelector('[data-ui="data-note"]')?.textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    // not kept for a reload before the press: nobody approved it
    expect(recallAction(USER, 'solana', MY_VAULT)).toBeNull();
    const before = server.reads();
    await click(button(pane(again), en.order.shared.signWithdraw));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(run.calls).toHaveLength(1);
    expect(pane(again).dataset.state).toBe('done');
    expect(find(pane(again), ':scope > header h2').textContent).toBe(p.ended);
    // how it ended is the order's own sentence, said once: here, plainly done
    expect(find(pane(again), '[data-ui="order-status"]').textContent).toContain(
      en.order.outcome.done('Solana'),
    );
    // done: the page's own way on, and no link of the order's
    expect(pane(again).querySelector('[data-ui="order-next"]')).toBeNull();
    expect(pane(again).querySelector('a[href="/monitor"]')).toBeNull();
    expect(pane(again).querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(find(again, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.done);
    expect(recallAction(USER, 'solana', MY_VAULT)).toBeNull();
    server.state.vault = nothing(4_000);
    await click(find(pane(again), '[data-action="back-to-vault"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen(again).dataset.pane).toBe('holdings');
    expect(server.reads()).toBeGreaterThan(before);
    expect(find(again, '[data-ui="vault-empty"]').textContent).toBe(p.empty.withTargets);
  });

  it('failed: says the order is kept, offers the way back, and stops holding the box for signing', async () => {
    run.answer = 'failed';
    api();
    const host = await show();
    await toSteps(host);
    await click(button(pane(host), en.order.shared.signWithdraw));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(run.calls).toHaveLength(1);
    expect(pane(host).dataset.state).toBe('stopped');
    expect(pane(host).textContent).toContain(p.panes.withdraw.stopped);
    expect(pane(host).textContent).not.toContain(p.ended);
    expect(pane(host).textContent).not.toContain(en.order.outcome.done('Solana'));
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.withdraw);
    // approved, so a reload finds it again
    expect(recallAction(USER, 'solana', MY_VAULT)).toEqual({
      kind: 'withdraw',
      orderId: ORDER_ID,
      resumed: true,
    });
    await click(find(pane(host), '[data-action="leave-action"]'));
    expect(screen(host).dataset.pane).toBe('holdings');
    // left: it is not opened again by itself
    expect(recallAction(USER, 'solana', MY_VAULT)).toBeNull();
  });
});

describe('an order that answers late', () => {
  const gated = () => {
    let release: () => void = () => {};
    const placing = new Promise<void>((done) => {
      release = done;
    });
    return { placing, release };
  };
  /** In the withdraw pane: chosen, reviewed, and the order asked for (not yet answered). */
  async function confirmWithdraw(host: HTMLElement) {
    await click(find(host, '[data-action="vault-withdraw"]'));
    await settle();
    await settle();
    await click(button(pane(host), w.steps.next));
    const check = find(pane(host), '[data-ui="withdraw-step"][data-step="check"]');
    await click(find(check, 'input[type="checkbox"]'));
    await click(button(check, w.steps.next));
    await click(button(pane(host), w.confirm.button));
    await settle();
  }

  it('does not reopen a pane the person left: confirm a withdrawal, then Back before it answers', async () => {
    const gate = gated();
    const server = api({ placing: gate.placing });
    const host = await show();
    await confirmWithdraw(host);
    expect(server.calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST')).toHaveLength(
      1,
    );
    await click(find(pane(host), '[data-action="leave-action"]'));
    expect(screen(host).dataset.pane).toBe('holdings');
    gate.release();
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(screen(host).dataset.pane).toBe('holdings');
    expect(host.querySelector('[data-ui="vault-action-pane"]')).toBeNull();
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
  });

  it('does not take another pane’s place: Back, then Deposit, then the withdrawal’s order answers', async () => {
    const gate = gated();
    api({ placing: gate.placing });
    const host = await show();
    await confirmWithdraw(host);
    await click(find(pane(host), '[data-action="leave-action"]'));
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    gate.release();
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(screen(host).dataset.pane).toBe('deposit');
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.panes.deposit.title);
    expect(pane(host).querySelector('input[inputmode="decimal"]')).not.toBeNull();
  });

  it('a second opening of the same pane is not handed the first one’s order', async () => {
    const gate = gated();
    api({ placing: gate.placing });
    const host = await show();
    await confirmWithdraw(host);
    await click(find(pane(host), '[data-action="leave-action"]'));
    await click(find(host, '[data-action="vault-withdraw"]'));
    await settle();
    await settle();
    gate.release();
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(screen(host).dataset.pane).toBe('withdraw');
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.panes.withdraw.title);
    expect(pane(host).querySelector('[data-ui="order-step"]')).toBeNull();
  });
});

describe('an order that is done, but not plainly', () => {
  it('a step that was skipped: the pane does not say done over it, and the order’s own sentence says what stayed', async () => {
    // the executor answers done with one token's step skipped: it could not move
    const order = everything();
    const skipped = {
      ...order,
      status: 'done',
      legs: order.legs.map((leg, i) =>
        i === 0 ? { ...leg, status: 'confirmed', txId: 'sig' } : { ...leg, status: 'skipped' },
      ),
    } as OrderDetail;
    run.result = skipped;
    api();
    const host = await show();
    await toSteps(host);
    await click(button(pane(host), en.order.shared.signWithdraw));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(pane(host).dataset.state).toBe('done');
    const text = pane(host).textContent ?? '';
    expect(text).toContain(en.order.shared.doneExcept('Solana', 1));
    // nothing over the steps claims more than the order does
    const top = find(pane(host), '[data-ui="vault-action-done"]').textContent ?? '';
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.ended);
    for (const claim of [
      /is done/i,
      /in your wallet/i,
      /follows its new targets/i,
      /in your vault\./i,
    ])
      expect(`${top} ${find(pane(host), ':scope > header').textContent}`).not.toMatch(claim);
    expect(text).not.toContain(en.order.outcome.done('Solana'));
    // and the way on is still the page's one button
    expect(find(pane(host), '[data-action="back-to-vault"]')).toBeTruthy();
  });
});

describe('a funded vault with no targets', () => {
  it('draws no difference under a share: with no plan there is nothing to be over', async () => {
    api({
      vault: held({
        positions: [
          {
            ...holding(SPYX, '250000000', '2.5'),
            targetBps: 0,
            lastKeeperAt: null,
            valueUsd: '450',
            weightBps: 4_500,
            driftBps: 4_500,
          },
        ] as VaultView['positions'],
      }),
    });
    const host = await show();
    const plan = find(host, '[data-ui="vault-plan"]');
    expect(plan.querySelector('table')?.textContent).toContain('45%');
    expect(plan.querySelector('[data-ui="holding-drift"]')).toBeNull();
    expect(plan.textContent).not.toContain('against the plan');
  });
});

describe('a reload in the middle of signing', () => {
  const terms = (kind: 'withdraw' | 'retarget', vault = MY_VAULT): SharedTerms =>
    kind === 'withdraw'
      ? {
          kind,
          vault,
          basketId: '42',
          owner: SOLANA,
          everything: true,
          items: [
            { asset: CASH, amountRaw: null, heldRaw: '600000000', multiplier: '1' },
            { asset: SPYX, amountRaw: null, heldRaw: '250000000', multiplier: '1' },
          ],
          autoFollowOff: false,
        }
      : {
          kind,
          vault,
          basketId: '42',
          targets: [{ asset: 'solana:gldx', weightBps: 5_000 }],
          origin: 'model',
        };
  const kept = (order: OrderDetail, t: SharedTerms, approved = true) =>
    keepOrder({
      orderId: ORDER_ID,
      userId: USER,
      proposalId: '',
      chain: 'solana',
      amountUsd: 0,
      lines: [],
      terms: t,
      approved: approved ? { order, consents: [], at: '2026-10-09T12:00:00.000Z' } : null,
    });

  it('takes an approved withdrawal up again in the pane, from its own order, and says so', async () => {
    api();
    expect(kept(everything(), terms('withdraw'))).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
    const host = await show();
    expect(screen(host).dataset.pane).toBe('withdraw');
    expect(pane(host).textContent).toContain(p.panes.withdraw.resumed);
    expect(pane(host).querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    // the same order goes on: no new one is made
    expect(button(pane(host), en.order.shared.resume)).toBeTruthy();
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.withdraw);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('takes a change proposed in the conversation up again as the same pane state', async () => {
    api({ order: () => retargetOrder() as OrderDetail });
    expect(kept(retargetOrder() as OrderDetail, terms('retarget'))).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'apply', orderId: ORDER_ID });
    const host = await show();
    expect(screen(host).dataset.pane).toBe('apply');
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.panes.change.signTitle);
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.change);
  });

  it('takes an approved deposit up again on the same card: its own order and amount, and no new order', async () => {
    const add = {
      ...orderOn(),
      id: ORDER_ID,
      basketId: '42',
      legs: orderOn().legs.map((l) => (l.kind === 'create_vault' ? { ...l, kind: 'deposit' } : l)),
    } as OrderDetail;
    const server = api({ order: () => add });
    expect(
      keepOrder({
        orderId: ORDER_ID,
        userId: USER,
        proposalId: '',
        chain: 'solana',
        amountUsd: 10,
        lines: [],
        terms: {
          kind: 'vault',
          vault: MY_VAULT,
          basketId: '42',
          targets: [{ asset: assetsOn('solana').spy, weightBps: 6000 }],
          keeper: false,
          source: 'api',
        },
        approved: { order: add, consents: [], at: '2026-10-09T12:00:00.000Z' },
      }),
    ).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'deposit', orderId: ORDER_ID });
    const host = await show();
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(screen(host).dataset.pane).toBe('deposit');
    expect(pane(host).textContent).toContain(p.panes.deposit.resumed);
    // the amount is the order's own, a fact: nothing to type, and nothing typed makes another order
    expect(find(pane(host), '[data-ui="vault-action-amount"]').textContent).toContain('$10');
    expect(pane(host).querySelector('input[inputmode="decimal"]')).toBeNull();
    expect(pane(host).querySelectorAll('[data-ui="order-step"]').length).toBeGreaterThan(0);
    expect(server.calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST')).toEqual([]);
    expect(server.calls.filter((c) => c.path.startsWith('/v1/funding'))).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', { status: 'failed' }],
    ['ran out', { status: 'expired' }],
    ['is done', { status: 'done' }],
  ] as const)(
    'opens nothing for an order that %s on our server, and forgets it',
    async (_why, over) => {
      api({ standing: () => ({ ...everything(), ...over }) as OrderDetail });
      expect(kept(everything(), terms('withdraw'))).toBe(true);
      keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
      const host = await show();
      expect(screen(host).dataset.pane).toBe('holdings');
      expect(host.querySelector('[data-ui="vault-action-pane"]')).toBeNull();
      // gone for the next load too, not only this one
      expect(recallAction(USER, 'solana', MY_VAULT)).toBeNull();
    },
  );

  it('starting again forgets the order that stopped: a reload does not return to it', async () => {
    api();
    expect(kept(everything(), terms('withdraw'))).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
    const host = await show();
    expect(screen(host).dataset.pane).toBe('withdraw');
    await click(find(pane(host), '[data-action="leave-action"]'));
    await click(find(host, '[data-action="vault-deposit"]'));
    expect(recallAction(USER, 'solana', MY_VAULT)).toBeNull();
  });

  it.each([
    ['nobody approved', () => kept(everything(), terms('withdraw'), false)],
    ['is another vault’s', () => kept(everything(), terms('withdraw', SOLANA))],
    ['is of another kind', () => kept(everything(), terms('retarget'))],
    ['this browser does not have', () => true],
  ])('opens nothing for an order that %s, and forgets it', async (_why, seed) => {
    api();
    seed();
    keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
    const host = await show();
    expect(screen(host).dataset.pane).toBe('holdings');
    expect(host.querySelector('[data-ui="order-screen"]')).toBeNull();
    expect(
      localStorage.getItem(`tf-vault-action:1:${encodeURIComponent(USER)}:solana:${MY_VAULT}`),
    ).toBeNull();
  });
});
