// @vitest-environment happy-dom
import type { OrderDetail, VaultView } from '@colosseum/schemas';
import { type ExecutionResult, type ExecutorDeps, solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  click,
  find,
  fire,
  hintOf,
  mount,
  press,
  settle,
  unmountAll,
} from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { keepOrder, recallOrders } from '../order/order-record';
import { assetsOn, orderOn } from '../order/test/fixtures';
import { PORTFOLIO_PATH } from '../portfolio/portfolio';
import { vaultTitle } from '../portfolio/vault-name';
import { EMBEDDED, fakePort, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { MORE_ROW, placeMenu } from './MoreMenu';
import type { SharedTerms } from './terms';
import {
  CREATOR,
  ORDER_ID,
  rebalanceOrder,
  retargetOrder,
  USER,
  vaultOf,
  withdrawOrder,
} from './test/fixtures';
import { shortAddress } from './use-person';
import { keepAction, recallAction } from './VaultAction';
import { offTarget, VaultScreen } from './VaultScreen';

// A person's own vault page (gate VAULT-PAGE-ACTIONS), with real events against a double of the API:
// what the head and the pane show, who is offered the actions, each state of the pane and the way out
// of it, a withdrawal signed in the pane with no other page opened, and an action taken up again after
// a reload. Only `execute` is a double. The deposit's own steps are walked in e2e/vault-page.spec.ts,
// against the stub's chain.

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
  answer: 'done' as 'done' | 'failed',
  /** Held: the executor answers only once the test lets it. */
  gate: null as Promise<void> | null,
  /** The order the executor answers with, where a test says how its steps ended. */
  result: null as OrderDetail | null,
}));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return (run.gate ?? Promise.resolve()).then(
      () =>
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
    /** More of the vault read's answer: its `blockOrSlot`. */
    answer?: object;
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
        ...o.answer,
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
/** From the page through the withdrawal's amount card to its order, in the pane. */
async function toSteps(host: HTMLElement) {
  await click(find(host, '[data-action="vault-withdraw"]'));
  await settle();
  await settle();
  // the amount card (gate AMOUNT-CARD): everything, by Max, then its one button
  await click(button(find(pane(host), '[data-ui="amount-chips"]'), en.amount.out.max));
  await click(find(pane(host), 'button[data-action="amount-withdraw"]'));
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
  run.gate = null;
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
  it('is drawn so on the page: the name, else "Vault #N" from the person’s portfolio, else "Your vault"', async () => {
    api({ listed: { number: 3 } });
    const numbered = await show();
    expect(find(numbered, 'h1').textContent).toBe('Vault #3');
    // "Rename" is still there, to replace it with a name of the person's own
    expect(numbered.querySelector('[data-action="rename"]')).not.toBeNull();
    await unmountAll();
    api({ listed: { number: 3, name: 'Rent' } });
    expect(find(await show(), 'h1').textContent).toBe('Rent');
    await unmountAll();
    // a server that gives no number yet
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
    expect(host.textContent).not.toContain(en.shared.vaults.address(shortAddress(MY_VAULT)));
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
    expect(find(host, 'h1').textContent).toBe(en.shared.vaults.address(shortAddress(MY_VAULT)));
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
      p.close.action,
    ]);
    // the way back is navigation: a link over the name, not one of the actions
    const back = find(host, '[data-ui="vault-back"]');
    expect(back.getAttribute('href')).toBe('/portfolio');
    expect(actions.contains(back)).toBe(false);
    // nothing a person reads says "mix" or "buy"
    expect(screen(host).textContent).not.toMatch(/\b(mix|buy)\b/i);
  });

  it('"More" is a menu surface: every row a full-width target the keyboard reaches, closed by Escape or by a choice', async () => {
    api();
    const host = await show();
    const more = find<HTMLButtonElement>(host, '[data-ui="vault-more"]');
    const list = find(host, '[data-ui="vault-more-list"]');
    await click(more);
    // drawn against the window, so the head it is written in cannot cut it off
    expect(list.className.split(' ')).toContain('fixed');
    expect(list.className.split(' ')).toContain('shadow-popover');
    const rows = [...list.querySelectorAll<HTMLElement>('li > a, li > button')];
    expect(rows.map((row) => row.textContent)).toEqual([
      p.editWeights,
      en.shared.publish.shareStrategy,
      en.shared.vault.explorer('Solscan'),
      p.close.action,
    ]);
    for (const row of rows) {
      // a row, not a bare underlined link: the whole width, 40px tall, in the tab order
      expect(row.className).toBe(MORE_ROW);
      expect(row.tabIndex).toBe(0);
      row.focus();
      expect(document.activeElement).toBe(row);
      // focus inside the list keeps it open
      expect(more.getAttribute('aria-expanded')).toBe('true');
    }
    // the explorer's row keeps its arrow, and opens beside the page
    expect(rows[2]?.querySelector('svg')).not.toBeNull();
    expect(rows[2]?.getAttribute('target')).toBe('_blank');
    // Escape closes it and the focus is back on "More"
    await press(document, 'Escape');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(more);
    // a press outside closes it
    await click(more);
    await fire(document.body, new Event('pointerdown', { bubbles: true }));
    expect(list.hidden).toBe(true);
    // and so does choosing the row that opens another tab: the page is as it was
    await click(more);
    rows[2]?.addEventListener('click', (event) => event.preventDefault());
    await click(rows[2] as HTMLElement);
    expect(list.hidden).toBe(true);
    expect(screen(host).dataset.pane).toBe('holdings');
  });

  it('places the list in the window: under the button, moved in from an edge, above when there is no room below', () => {
    const size = { width: 240, height: 136 };
    const desk = { width: 1440, height: 900 };
    // under the button, flush with its right edge
    expect(placeMenu({ top: 170, bottom: 190, left: 1230, right: 1290 }, size, desk)).toEqual({
      top: 198,
      left: 1050,
    });
    // a phone, the button near the left: moved in to the gutter, never off the screen
    expect(
      placeMenu({ top: 210, bottom: 230, left: 232, right: 270 }, size, {
        width: 375,
        height: 812,
      }),
    ).toEqual({ top: 238, left: 30 });
    expect(
      placeMenu({ top: 210, bottom: 230, left: 16, right: 60 }, size, { width: 375, height: 812 })
        .left,
    ).toBe(16);
    // no room below, room above: it opens above the button
    expect(
      placeMenu({ top: 560, bottom: 580, left: 1100, right: 1160 }, size, {
        width: 1280,
        height: 650,
      }),
    ).toEqual({ top: 416, left: 920 });
    // room neither way: below, where the page can still show its top rows
    expect(
      placeMenu({ top: 60, bottom: 80, left: 1100, right: 1160 }, size, {
        width: 1280,
        height: 150,
      }).top,
    ).toBe(88);
  });

  it('shows the holdings with nothing to open: planned over now, then one list with the difference', async () => {
    api();
    const host = await show();
    const plan = find(host, '[data-ui="vault-plan"]');
    const composition = find(plan, '[data-ui="composition"]');
    expect(composition.getAttribute('data-mode')).toBe('compare');
    expect(plan.querySelector('[data-ui="vault-details"]')?.contains(composition)).toBe(false);
    expect(find(composition, '[data-ui="composition-bars"]').textContent).toBe(
      `${en.shared.vault.columns.target}${en.shared.vault.columns.weight}`,
    );
    // off its plan: said in the panel's head, as a status pill
    expect(find(plan, '[data-ui="vault-on-target"] [data-ui="status"]').textContent).toContain(
      p.offTargetShort,
    );
    // each holding a row: its amount under its name, its price and its value in their columns
    const rows = [...composition.querySelectorAll<HTMLElement>('[data-row]')];
    expect(rows).toHaveLength(2);
    const detail = find(rows[0] as HTMLElement, '[data-ui="holding-detail"]');
    expect(detail.textContent).toBe('2.5 SPYx');
    // this read has no prices: no price, the dash said in words one hover away, and no value
    const price = find(rows[0] as HTMLElement, '[data-column="price"]');
    expect(price.querySelector('[data-ui="hint"]')?.textContent).toBe('—');
    expect(
      find(rows[0] as HTMLElement, '[data-column="value"]').querySelector('[data-ui="pin"]'),
    ).toBeNull();
    // the planned share, and the drift as a status pill: signed, and said in words
    expect(find(rows[0] as HTMLElement, '[data-column="before"]').textContent).toContain('40%');
    const drifts = [...composition.querySelectorAll<HTMLElement>('[data-ui="composition-delta"]')];
    expect(drifts.map((d) => d.dataset.direction)).toEqual(['up', 'down']);
    expect(find(drifts[0] as HTMLElement, '[aria-hidden]').textContent).toBe(p.drift('+5%'));
    expect(drifts[0]?.textContent).toContain(p.against('+5%'));
    expect(drifts[1]?.textContent).toContain(p.against('−5%'));
    for (const drift of drifts)
      expect(drift.closest('[data-ui="status"]')?.getAttribute('data-status')).toBe('watch');
  });

  it('says in Details the slot the vault was read at, to its explorer, and the time', async () => {
    api({ answer: { blockOrSlot: '51073956' } });
    const host = await show();
    const row = find(host, '[data-ui="vault-read-at"]');
    const height = find<HTMLAnchorElement>(row, 'a[data-ui="vault-height"]');
    expect(row.textContent).toContain(p.height.slot);
    expect(height.textContent).toBe('51,073,956');
    expect(height.getAttribute('href')).toMatch(/\/block\/51073956(\?|$)/);
    expect(height.getAttribute('target')).toBe('_blank');
    expect(row.querySelector('time')).not.toBeNull();
  });

  it('says the time alone where the read has no height, and on the mock', async () => {
    for (const [answer, provenance] of [
      [{ blockOrSlot: null }, 'sandbox'],
      [{ blockOrSlot: '1791000000' }, 'mock'],
    ] as const) {
      api({ answer, provenance });
      const host = await show();
      const row = find(host, '[data-ui="vault-read-at"]');
      expect(row.querySelector('[data-ui="vault-height"]')).toBeNull();
      expect(row.querySelector('time')).not.toBeNull();
      await unmountAll();
    }
  });

  it('says why each holding is there, in one line, from the server: its words, or its kind', async () => {
    api({
      vault: held({
        cash: {
          ...holding(CASH, '600000000', '600'),
          why: { source: 'portfolio' },
        } as VaultView['cash'],
        positions: [
          {
            ...holding(SPYX, '250000000', '2.5'),
            targetBps: 4_000,
            lastKeeperAt: null,
            valueUsd: '450',
            weightBps: 4_000,
            driftBps: 0,
            why: { source: 'portfolio', cls: 'etf' },
          },
          {
            ...holding('solana:usdy', '150000000', '150'),
            targetBps: 2_000,
            lastKeeperAt: null,
            valueUsd: '150',
            weightBps: 2_000,
            driftBps: 0,
            why: { source: 'plan', text: 'Capped by your limit on one issuer, as tsyrupUSDC is.' },
          },
        ] as unknown as VaultView['positions'],
        valueUsd: '1200',
      }),
    });
    const host = await show();
    const plan = find(host, '[data-ui="vault-plan"]');
    const why = (asset: string) =>
      find(plan, `[data-row="${asset}"] [data-ui="holding-why"]`).textContent;
    expect(why(SPYX)).toContain(en.shared.product.why.etf);
    // the engine's sentence, with a test-network token said by its plain name
    expect(why('solana:usdy')).toBe('Capped by your limit on one issuer, as syrupUSDC is.');
    // cash the vault plans a share of is kept as cash
    expect(why(CASH)).toContain(p.keptAsCash);
    await unmountAll();
    // the reason is a line under the amount, never a column the narrow pane would cut
    expect(plan.querySelector('[data-column="why"]')).toBeNull();
    await unmountAll();
    // a vault the server holds no reason for has no such line, and nothing made up
    api();
    const plain = find(await show(), '[data-ui="vault-plan"]');
    expect(plain.querySelector('[data-ui="holding-why"]')).toBeNull();
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
    // the first hint is the address's own; the copy button has one too
    expect(await hintOf(address.querySelector('[data-ui="hint"]') as Element)).toBe(MY_VAULT);
    expect(address.querySelector('[data-ui="copy-button"]')).not.toBeNull();
    expect(
      await hintOf(details.querySelector('[data-ui="vault-owner"] [data-ui="hint"]') as Element),
    ).toBe(SOLANA);
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
    expect(find(host, 'h1').textContent).toBe(en.shared.vaults.address(shortAddress(MY_VAULT)));
    for (const selector of owned) expect(host.querySelector(selector), selector).toBeNull();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    // and still what it holds, and the way to its chain's explorer
    expect(host.querySelector('[data-ui="composition"]')).not.toBeNull();
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

describe('Deposit | Withdraw on the amount card (gate AMOUNT-CARD)', () => {
  it('switches the pane between the two, where the vault holds something to withdraw', async () => {
    api();
    const host = await show();
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    const modes = () => find(pane(host), '[data-ui="amount-modes"]');
    expect(
      [...modes().querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false']);
    await click(button(modes(), en.amount.modes.withdraw));
    await settle();
    await settle();
    expect(find(host, '[data-ui="vault-screen"]').dataset.pane).toBe('withdraw');
    expect(find(pane(host), '[data-ui="amount-card"]').dataset.mode).toBe('withdraw');
    await click(button(modes(), en.amount.modes.deposit));
    await settle();
    expect(find(host, '[data-ui="vault-screen"]').dataset.pane).toBe('deposit');
  });

  it('offers no Withdraw on an empty vault: the deposit alone', async () => {
    api({ vault: nothing(4_000) });
    const host = await show();
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    expect(pane(host).querySelector('[data-ui="amount-modes"]')).toBeNull();
    expect(find(pane(host), '[data-ui="amount-card"]').dataset.mode).toBe('deposit');
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
    expect(host.querySelector('[data-ui="composition"]')).toBeNull();
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
    // the amount card heads the pane (gate AMOUNT-CARD), and its amount takes the focus
    expect(pane(host).querySelector(':scope > header')).toBeNull();
    const title = find(pane(host), '[data-ui="amount-panel"] h2');
    expect(title.textContent).toBe(p.panes.deposit.title);
    expect(document.activeElement).toBe(find(pane(host), '[data-ui="amount-well"] input'));
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

  it('withdraw, when the vault cannot be read again: the sentence, the pane’s own heading and its way back', async () => {
    let failing = false;
    api({
      more: (path) =>
        failing && path.startsWith('/v1/vaults/solana/') && !path.includes('/conversation')
          ? json({ error: 'down' }, 500)
          : undefined,
    });
    const host = await show();
    failing = true;
    await click(find(host, '[data-action="vault-withdraw"]'));
    for (let i = 0; i < 3; i += 1) await settle(30);
    // no card is drawn: the pane keeps its own heading and the way out
    expect(pane(host).querySelector('[data-ui="amount-panel"]')).toBeNull();
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.panes.withdraw.title);
    expect(pane(host).querySelectorAll('[data-action="leave-action"]')).toHaveLength(1);
    await click(find(pane(host), '[data-action="leave-action"]'));
    expect(screen(host).dataset.pane).toBe('holdings');
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
    // the one way to the portfolio is the page's own, to the board: nothing leads to the monitor
    expect(find(host, '[data-ui="vault-back"]').getAttribute('href')).toBe('/portfolio');
    expect(host.querySelector('a[href="/portfolio/monitor"]')).toBeNull();
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
    expect(find(again, '[data-ui="vault-back"]').getAttribute('href')).toBe('/portfolio');
    expect(again.querySelector('a[href="/portfolio/monitor"]')).toBeNull();
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
  /** In the withdraw pane: chosen on the amount card, and the order asked for (not yet answered). */
  async function confirmWithdraw(host: HTMLElement) {
    await click(find(host, '[data-action="vault-withdraw"]'));
    await settle();
    await settle();
    await click(button(find(pane(host), '[data-ui="amount-chips"]'), en.amount.out.max));
    await click(find(pane(host), 'button[data-action="amount-withdraw"]'));
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
    expect(find(pane(host), '[data-ui="amount-panel"] h2').textContent).toBe(p.panes.deposit.title);
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
    expect(find(pane(host), '[data-ui="amount-panel"] h2').textContent).toBe(
      p.panes.withdraw.title,
    );
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
    expect(find(plan, '[data-ui="composition"]').getAttribute('data-mode')).toBe('single');
    expect(find(plan, '[data-ui="composition-list"]').textContent).toContain('45%');
    expect(plan.querySelector('[data-ui="composition-delta"]')).toBeNull();
    expect(plan.textContent).not.toContain('against its target');
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

  it('writes a sale in a change of targets as a sale, in the units of the token sold', async () => {
    // A change that sells what the vault holds before it spends the cash: the sale is the first trade.
    const base = retargetOrder() as OrderDetail;
    const change = {
      ...base,
      legs: base.legs.map((l) =>
        l.kind === 'swap'
          ? {
              ...l,
              trades: [{ sell: SPYX, buy: CASH, amountInRaw: '250000000' }, ...l.trades],
              expected: [
                { inRaw: '250000000', outRaw: '20200000', minOutRaw: '20000000', costBps: 10 },
                ...l.expected,
              ],
            }
          : l,
      ),
    } as OrderDetail;
    api({ order: () => change });
    expect(kept(change, terms('retarget'))).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'apply', orderId: ORDER_ID });
    const host = await show();
    const steps = [...pane(host).querySelectorAll('[data-ui="order-step"]')].map(
      (step) => step.textContent ?? '',
    );
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatch(
      /Sell [\d.,]+ SPYx · receive at least 20 USDC \(at least \$[\d.,]+ each\)/,
    );
    // never the cash token's name or decimals on what is sold
    expect(steps[1]).not.toMatch(/Spend 250 USDC|on USDC/);
    // the purchase after it reads as before
    expect(steps[1]).toContain('Spend 20 USDC on');
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
    // the amount is the order's own, a fact on the amount card's line (gate AMOUNT-CARD): nothing to
    // type, no way back to the field, and nothing typed makes another order
    expect(find(pane(host), '[data-ui="deposit-fact"]').textContent).toContain(
      en.amount.pressed('$10'),
    );
    expect(pane(host).querySelector('button[data-action="amount-change"]')).toBeNull();
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

  it('a pane opened and left while the kept order is still being asked about is not reopened by the answer', async () => {
    let answer: (response: Response) => void = () => {};
    const waiting = new Promise<Response>((done) => {
      answer = done;
    });
    api({ more: (path) => (path === `/v1/orders/${ORDER_ID}` ? waiting : undefined) });
    expect(kept(everything(), terms('withdraw'))).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
    const host = await show();
    // the read has not answered: the holdings are there, and the person opens Deposit and leaves it
    expect(screen(host).dataset.pane).toBe('holdings');
    await click(find(host, '[data-action="vault-deposit"]'));
    await settle();
    await click(find(pane(host), '[data-action="leave-action"]'));
    expect(screen(host).dataset.pane).toBe('holdings');
    answer(json(everything()));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(screen(host).dataset.pane).toBe('holdings');
    expect(host.querySelector('[data-ui="vault-action-pane"]')).toBeNull();
  });

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

  it('"Continue" on an order taken up again holds the pane at once: no way back while its steps are signed', async () => {
    let release: () => void = () => {};
    run.gate = new Promise<void>((done) => {
      release = done;
    });
    api();
    expect(kept(everything(), terms('withdraw'))).toBe(true);
    keepAction(USER, 'solana', MY_VAULT, { kind: 'withdraw', orderId: ORDER_ID });
    const host = await show();
    expect(pane(host).querySelector('[data-action="leave-action"]')).not.toBeNull();
    await click(button(pane(host), en.order.shared.resume));
    await settle();
    // before any step answers: the pane is signing, the box says so, and Back is gone
    expect(pane(host).dataset.state).toBe('signing');
    expect(pane(host).querySelector('[data-action="leave-action"]')).toBeNull();
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.signing);
    release();
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(pane(host).dataset.state).toBe('done');
  });

  it('an order that finishes a deposit is the one taken up, and no "Deposit amount" is said of it: it deposits nothing', async () => {
    const FOLLOW = '9d2f8a3b-1c4e-4f5a-8b6c-7d8e9f0a1b2c';
    const add = {
      ...orderOn(),
      id: ORDER_ID,
      basketId: '42',
      legs: orderOn().legs.map((l) => (l.kind === 'create_vault' ? { ...l, kind: 'deposit' } : l)),
    } as OrderDetail;
    const vaultTerms: SharedTerms = {
      kind: 'vault',
      vault: MY_VAULT,
      basketId: '42',
      targets: [{ asset: assetsOn('solana').spy, weightBps: 6000 }],
      keeper: false,
      source: 'api',
    };
    const base = {
      userId: USER,
      proposalId: '',
      chain: 'solana' as const,
      amountUsd: 10,
      lines: [],
      terms: vaultTerms,
    };
    keepOrder({
      ...base,
      orderId: ORDER_ID,
      approved: { order: add, consents: [], at: '2026-10-09T12:00:00.000Z' },
    });
    expect(
      keepOrder({
        ...base,
        orderId: FOLLOW,
        approved: null,
        continues: { orderId: ORDER_ID, trades: add.legs.flatMap((l) => l.trades) },
      }),
    ).toBe(true);
    expect(recallOrders(USER).map((r) => r.orderId)).toContain(FOLLOW);
    const server = api({
      standing: () => ({ ...add, status: 'failed' }) as OrderDetail,
      more: (path) =>
        path === `/v1/orders/${FOLLOW}`
          ? json({
              ...add,
              id: FOLLOW,
              continues: ORDER_ID,
              depositRaw: undefined,
              legs: add.legs.slice(1),
            })
          : undefined,
    });
    keepAction(USER, 'solana', MY_VAULT, { kind: 'deposit', orderId: ORDER_ID });
    const host = await show();
    for (let i = 0; i < 4; i += 1) await settle(30);
    // the line's newest order says how it stands: the first one failed, and the pane still opens
    expect(screen(host).dataset.pane).toBe('deposit');
    expect(server.calls.map((c) => c.path)).toContain(`/v1/orders/${FOLLOW}`);
    // the amount card's line says no amount of an order that deposits nothing
    expect(pane(host).querySelector('[data-ui="deposit-fact"]')).toBeNull();
    expect(pane(host).textContent).not.toContain(p.amount);
    expect(pane(host).textContent).not.toContain(en.amount.pressed('$10'));
    // and the pane is headed for what it is: no "Sign your deposit", no "the whole amount goes in"
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.finish.title);
    expect(find(pane(host), ':scope > header').textContent).toContain(p.finish.lead);
    expect(pane(host).textContent).not.toContain(p.panes.deposit.signTitle);
    expect(pane(host).textContent).not.toContain(p.panes.deposit.lead);
    expect(pane(host).querySelector('input[inputmode="decimal"]')).toBeNull();
    expect(server.calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST')).toEqual([]);
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

// Thom's vault of Oct 13: it followed a shared portfolio of 50% jlUSDC, 30% syrupUSDC and 20% PAXG,
// and what it held stayed as it was, with $20,050 idle in cash. Auto-follow is off, so nothing trades
// it for him: the page offers the one press that does, in its own pane.
describe('a vault away from its targets is offered one press that trades it to them', () => {
  const JL = 'solana:jlusdc';
  const SYRUP = 'solana:syrupusdc';
  const PAXG = 'solana:paxg';
  const position = (
    asset: string,
    raw: string,
    display: string,
    valueUsd: string,
    weightBps: number,
    targetBps: number,
  ) => ({
    ...holding(asset, raw, display),
    targetBps,
    lastKeeperAt: null,
    valueUsd,
    weightBps,
    driftBps: weightBps - targetBps,
  });
  const followed = (over: Partial<VaultView> = {}) =>
    held({
      recipeOnchainId: CREATOR,
      acceptedVersion: 1,
      autoFollow: false,
      cash: holding(CASH, '20050000000', '20050'),
      positions: [
        position(JL, '37702634440', '37702.63444', '39964.79', 4_989, 5_000),
        position(SYRUP, '16888138676', '16888.138676', '20096.89', 2_508, 3_000),
        position(PAXG, '0', '0', '0', 0, 2_000),
      ] as VaultView['positions'],
      valueUsd: '80111.68',
      ...over,
    });
  const atTargets = () =>
    followed({
      cash: holding(CASH, '40000000', '40'),
      positions: [
        position(JL, '37788000000', '37788', '40055', 5_000, 5_000),
        position(SYRUP, '20180000000', '20180', '24014', 2_998, 3_000),
        position(PAXG, '3857000000', '3.857', '16020', 1_999, 2_000),
      ] as VaultView['positions'],
    });
  const TARGETS = [
    { asset: JL, weightBps: 5_000 },
    { asset: SYRUP, weightBps: 3_000 },
    { asset: PAXG, weightBps: 2_000 },
  ];
  const REBALANCE = `/v1/vaults/solana/${MY_VAULT}/rebalance`;
  const serving = (
    answer: () => Response,
    o: { vault?: VaultView; order?: () => OrderDetail } = {},
  ) =>
    api({
      vault: o.vault ?? followed(),
      order: o.order ?? (() => rebalanceOrder() as OrderDetail),
      more: (path, method) => (path === REBALANCE && method === 'POST' ? answer() : undefined),
    });
  const ordered = (order = rebalanceOrder() as OrderDetail) =>
    json({ status: 'ordered', targets: TARGETS, order });

  it('is offered by the rule the server orders by: outside the band, auto-follow off, every holding priced', () => {
    expect(offTarget(followed())).toBe(true);
    expect(offTarget(atTargets())).toBe(false);
    // the keeper's work where auto-follow is on
    expect(offTarget(followed({ autoFollow: true }))).toBe(false);
    // only the cash is over, by more than the band and the slippage: every position is a little under
    expect(
      offTarget(
        followed({
          positions: [
            position(JL, '1', '1', '39300', 4_930, 5_000),
            position(SYRUP, '1', '1', '23500', 2_940, 3_000),
            position(PAXG, '1', '1', '15700', 1_960, 2_000),
          ] as VaultView['positions'],
        }),
      ),
    ).toBe(true);
    // what a rebalance leaves: cash up to the slippage over, each asset up to its part of it under
    expect(
      offTarget(
        followed({
          positions: [
            position(JL, '1', '1', '39600', 4_950, 5_000),
            position(SYRUP, '1', '1', '23700', 2_970, 3_000),
            position(PAXG, '1', '1', '15700', 1_980, 2_000),
          ] as VaultView['positions'],
        }),
      ),
    ).toBe(false);
    // outside the band, but every trade it would take is under the smallest a rebalance makes: the
    // server answers on_target, so the page offers nothing
    const small = (valueUsd: string) =>
      followed({
        valueUsd,
        positions: [
          position(JL, '1', '1', '1', 4_800, 5_000),
          position(SYRUP, '1', '1', '1', 3_000, 3_000),
          position(PAXG, '1', '1', '1', 2_000, 2_000),
        ] as VaultView['positions'],
      });
    expect(offTarget(small('200'))).toBe(false);
    expect(offTarget(small('1000'))).toBe(true);
    // a holding with no price: the shares are not known
    expect(
      offTarget(
        followed({
          positions: [
            { ...position(JL, '1', '1', '0', 0, 5_000), valueUsd: null },
            position(PAXG, '0', '0', '0', 0, 5_000),
          ] as VaultView['positions'],
        }),
      ),
    ).toBe(false);
    // no target: nothing to be brought to
    expect(offTarget(followed({ positions: [] }))).toBe(false);
  });

  it('shows the press and why, beside Deposit and Withdraw, and not on a vault at its targets or one the keeper trades', async () => {
    serving(ordered);
    const host = await show();
    const actions = find(host, '[data-ui="vault-page-actions"]');
    expect(find(actions, '[data-action="vault-rebalance"]').textContent).toBe(p.rebalance);
    // Deposit stays the view's one primary
    expect(find(actions, '[data-action="vault-rebalance"]').dataset.variant).toBe('secondary');
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(find(host, '[data-ui="vault-off-target"]').textContent).toBe(p.offTarget);
    expect(screen(host).textContent).not.toMatch(/\b(mix|buy)\b/i);
    await unmountAll();

    for (const vault of [atTargets(), followed({ autoFollow: true })]) {
      serving(ordered, { vault });
      const other = await show();
      expect(other.querySelector('[data-action="vault-rebalance"]')).toBeNull();
      expect(other.querySelector('[data-ui="vault-off-target"]')).toBeNull();
      await unmountAll();
    }
    // a visitor is offered nothing
    portStore.set(fakePort({ status: 'signed-out' }));
    serving(ordered);
    expect((await show()).querySelector('[data-action="vault-rebalance"]')).toBeNull();
  });

  it('one press: the order is asked for, its swaps are shown in the pane with their minimums, signed there, and the vault is read again', async () => {
    const server = serving(ordered);
    const host = await show();
    await click(find(host, '[data-action="vault-rebalance"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    // asked once, with no body of the person's making, and no other page opened
    expect(server.calls.filter((c) => c.path === REBALANCE)).toEqual([
      { method: 'POST', path: REBALANCE },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen(host).dataset.pane).toBe('rebalance');
    expect(find(pane(host), ':scope > header h2').textContent).toBe(p.panes.rebalance.signTitle);
    expect(find(host, '[data-ui="vault-chat-waits"]').textContent).toBe(p.waits.rebalance);
    // what it is held to: the vault and the targets it has
    const review = find(pane(host), `section[aria-label="${p.rebalancing.reviewTitle}"]`);
    expect(review.textContent).toContain(MY_VAULT);
    expect(review.textContent).toContain(p.rebalancing.reviewNote);
    // each trade with the least it may give, on the test network's own line
    const steps = [...pane(host).querySelectorAll('[data-ui="order-step"]')].map(
      (step) => step.textContent ?? '',
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(/Spend 16,022 USDC on .*receive at least/);
    expect(steps[1]).toMatch(/Spend 3,936 USDC on .*receive at least/);
    expect(pane(host).querySelector('[data-ui="data-note"]')?.textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    expect(pane(host).textContent).not.toMatch(/\b(mix|buy)\b/i);
    // kept with the terms the guard is handed: the vault's number, and nothing that changes the vault
    const [record] = recallOrders(USER);
    expect(record?.terms).toEqual({
      kind: 'rebalance',
      vault: MY_VAULT,
      basketId: '42',
      targets: TARGETS,
      trades: (rebalanceOrder() as OrderDetail).legs.flatMap((l) => l.trades),
    });
    expect(recallAction(USER, 'solana', MY_VAULT)).toBeNull();

    const before = server.reads();
    await click(button(pane(host), en.order.shared.signRebalance));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.order.legs.map((l) => l.kind)).toEqual(['swap', 'swap']);
    expect(pane(host).dataset.state).toBe('done');
    server.state.vault = atTargets();
    await click(find(pane(host), '[data-action="back-to-vault"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(server.reads()).toBeGreaterThan(before);
    expect(screen(host).dataset.pane).toBe('holdings');
    // at its targets now: the press is gone
    expect(host.querySelector('[data-action="vault-rebalance"]')).toBeNull();
  });

  it.each([
    [
      'sets targets first',
      () =>
        ({
          ...rebalanceOrder(),
          legs: (retargetOrder('solana:paxg') as OrderDetail).legs,
        }) as OrderDetail,
    ],
    [
      'swaps into an asset that is no target of the vault',
      () =>
        rebalanceOrder([
          { sell: CASH, buy: 'solana:tslax', amountInRaw: '16022000000' },
        ]) as OrderDetail,
    ],
    [
      'swaps one asset straight into another',
      () => rebalanceOrder([{ sell: JL, buy: PAXG, amountInRaw: '1000000' }]) as OrderDetail,
    ],
  ])('an order that %s is not offered for signing', async (_why, wrong) => {
    // the client refuses an answer with a step that is no swap; the others reach the order's own check
    serving(() => ordered(wrong()), { order: wrong });
    const host = await show();
    await click(find(host, '[data-action="vault-rebalance"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(
      [...pane(host).querySelectorAll('button')].some((b) =>
        b.textContent?.includes(en.order.shared.signRebalance),
      ),
    ).toBe(false);
    expect(pane(host).querySelector('[role="alert"]')).not.toBeNull();
    expect(run.calls).toHaveLength(0);
  });

  it('says so where there is nothing to trade, where the keeper trades it, and where an asset has no price', async () => {
    for (const [answer, sentence, again] of [
      [() => json({ status: 'on_target', targets: TARGETS }), p.rebalancing.onTarget, false],
      [
        () =>
          json(
            {
              error: 'auto-follow is on',
              details: { retryable: false, issues: ['AUTO_FOLLOW_ON'] },
            },
            409,
          ),
        p.rebalancing.keeper,
        false,
      ],
      [
        () =>
          json(
            { error: 'no price', details: { retryable: true, issues: ['NO_PRICE:solana:paxg'] } },
            409,
          ),
        p.rebalancing.cannot(p.rebalancing.why.noPrice('PAXG')),
        true,
      ],
    ] as const) {
      serving(answer);
      const host = await show();
      await click(find(host, '[data-action="vault-rebalance"]'));
      for (let i = 0; i < 4; i += 1) await settle(30);
      expect(pane(host).textContent).toContain(sentence);
      expect(pane(host).querySelector('[data-ui="order-step"]')).toBeNull();
      expect(pane(host).querySelector('[data-action="rebalance-again"]') !== null).toBe(again);
      expect(recallOrders(USER)).toEqual([]);
      // and the way back is there
      await click(find(pane(host), '[data-action="leave-action"]'));
      expect(screen(host).dataset.pane).toBe('holdings');
      await unmountAll();
    }
  });

  it("says a trade too large for the network in the person's own language, with no Try again", async () => {
    const refusal = () =>
      json(
        {
          error: 'this rebalance needs a trade of PAXG larger than Solana takes in one go',
          details: { retryable: false, issues: ['TRADE_TOO_LARGE:solana:paxg'] },
        },
        422,
      );
    for (const lang of ['en', 'pt'] as const) {
      const t = dictionary(lang);
      serving(refusal);
      const host = await mount(
        withAccount(lang, createElement(VaultScreen, { chain: 'solana', address: MY_VAULT })),
      );
      for (let i = 0; i < 4; i += 1) await settle(30);
      await click(find(host, '[data-action="vault-rebalance"]'));
      for (let i = 0; i < 4; i += 1) await settle(30);
      const r = t.shared.vault.page.rebalancing;
      expect(pane(host).textContent).toContain(r.cannot(r.why.tooLarge('PAXG', 'Solana')));
      expect(pane(host).textContent).not.toContain('this rebalance needs');
      expect(pane(host).querySelector('[data-action="rebalance-again"]')).toBeNull();
      await unmountAll();
    }
  });

  it('says a trade that waits for its market to open as such, with Try again, and gives no advice that ends the follow', async () => {
    const refusal = () =>
      json(
        {
          error: "PAXG's market is closed, and a trade this size waits until it opens",
          details: { retryable: true, issues: ['TRADE_WAITS_FOR_OPEN:solana:paxg'] },
        },
        409,
      );
    for (const lang of ['en', 'pt'] as const) {
      const t = dictionary(lang);
      serving(refusal);
      const host = await mount(
        withAccount(lang, createElement(VaultScreen, { chain: 'solana', address: MY_VAULT })),
      );
      for (let i = 0; i < 4; i += 1) await settle(30);
      await click(find(host, '[data-action="vault-rebalance"]'));
      for (let i = 0; i < 4; i += 1) await settle(30);
      const r = t.shared.vault.page.rebalancing;
      expect(pane(host).textContent).toContain(r.cannot(r.why.waitsForOpen('PAXG')));
      expect(pane(host).querySelector('[data-action="rebalance-again"]')).not.toBeNull();
      // neither refusal points at new weights, which would end the follow
      for (const why of [r.why.waitsForOpen('PAXG'), r.why.tooLarge('PAXG', 'Solana')])
        expect(why).not.toContain(t.shared.vault.page.editWeights);
      await unmountAll();
    }
  });

  it('opens on the rebalance when the person arrives from a follow that is done', async () => {
    const server = serving(ordered);
    window.history.replaceState(null, '', '?do=rebalance');
    try {
      const host = await show();
      expect(screen(host).dataset.pane).toBe('rebalance');
      expect(server.calls.filter((c) => c.path === REBALANCE)).toHaveLength(1);
    } finally {
      window.history.replaceState(null, '', window.location.pathname);
    }
  });
});

describe('closing a vault (gate VAULT-CLOSE-REUSE)', () => {
  const c = p.close;
  const CLOSE = `/v1/vaults/solana/${MY_VAULT}/close`;
  const REOPEN = `/v1/vaults/solana/${MY_VAULT}/reopen`;
  const lifetime = (closedAt: string | null) =>
    json({ chain: 'solana', address: MY_VAULT, closedAt, reopenedAt: null });
  const askClose = async (host: HTMLElement) => {
    await click(find(host, '[data-ui="vault-more"]'));
    await click(find(host, '[data-action="vault-close"]'));
    await settle();
  };

  it('asks once more before it closes an empty vault, and nothing is closed until the press', async () => {
    const closedAt = '2026-10-14T12:00:00.000Z';
    const server = api({
      vault: nothing(0),
      more: (path, method) => {
        if (path === CLOSE && method === 'POST') {
          server.state.vault = { ...nothing(0), closedAt } as never;
          return lifetime(closedAt);
        }
        return undefined;
      },
    });
    const host = await show();
    await askClose(host);
    const confirm = find(host, '[data-ui="vault-close-confirm"]');
    expect(find(confirm, 'h2').textContent).toBe(c.title);
    expect(document.activeElement).toBe(find(confirm, 'h2'));
    expect(confirm.textContent).toContain(c.body);
    // while it asks, the page's own actions step back: its press is the one primary
    expect(host.querySelector('[data-ui="vault-page-actions"]')).toBeNull();
    expect(server.calls.some((call) => call.path === CLOSE)).toBe(false);

    // kept open: nothing was asked of the server
    await click(find(confirm, '[data-action="vault-close-keep"]'));
    await settle();
    expect(host.querySelector('[data-ui="vault-close-confirm"]')).toBeNull();
    expect(server.calls.some((call) => call.path === CLOSE)).toBe(false);
    // Escape is the same way out, from anywhere in the confirm
    await askClose(host);
    await press(find(host, '[data-action="vault-close-confirm"]'), 'Escape');
    await settle();
    expect(host.querySelector('[data-ui="vault-close-confirm"]')).toBeNull();
    expect(server.calls.some((call) => call.path === CLOSE)).toBe(false);

    await askClose(host);
    await click(find(host, '[data-action="vault-close-confirm"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(server.calls.filter((call) => call.path === CLOSE)).toEqual([
      { method: 'POST', path: CLOSE },
    ]);
    // read again: the page says it is closed, and how to open it again
    const note = find(host, '[data-ui="vault-closed"]');
    expect(note.textContent).toContain(p.closed.title);
    // the note that says so has the focus
    expect(document.activeElement).toBe(find(note, 'h2'));
    expect(note.textContent).toContain(p.closed.body('Oct 14, 2026'));
    expect(host.querySelector('[data-action="vault-close"]')).toBeNull();
  });

  it('tells a vault that holds something to withdraw first, and offers no close', async () => {
    const server = api();
    const host = await show();
    await askClose(host);
    const confirm = find(host, '[data-ui="vault-close-confirm"]');
    expect(confirm.textContent).toContain(c.notEmpty);
    expect(confirm.querySelector('[data-action="vault-close-confirm"]')).toBeNull();
    await click(find(confirm, '[data-action="vault-close-withdraw"]'));
    await settle();
    expect(find(host, '[data-ui="vault-screen"]').getAttribute('data-pane')).toBe('withdraw');
    expect(server.calls.some((call) => call.path === CLOSE)).toBe(false);
  });

  it('says an order on the vault is not finished, where the server refuses the close for one', async () => {
    api({
      vault: nothing(0),
      more: (path, method) =>
        path === CLOSE && method === 'POST'
          ? json({ error: 'an order on this vault is not finished', code: 'ORDER_UNFINISHED' }, 409)
          : undefined,
    });
    const host = await show();
    await askClose(host);
    await click(find(host, '[data-action="vault-close-confirm"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    const confirm = find(host, '[data-ui="vault-close-confirm"]');
    expect(find(confirm, '[role="alert"]').textContent).toBe(c.orderOpen);
    // the sentence that says why has the focus
    expect(document.activeElement).toBe(find(confirm, '[role="alert"]'));
    expect(host.querySelector('[data-ui="vault-closed"]')).toBeNull();
  });

  it('opens a closed vault again from its note', async () => {
    const server = api({
      vault: { ...nothing(0), closedAt: '2026-10-14T12:00:00.000Z' } as never,
      more: (path, method) => {
        if (path === REOPEN && method === 'POST') {
          server.state.vault = { ...nothing(0), closedAt: null } as never;
          return lifetime(null);
        }
        return undefined;
      },
    });
    const host = await show();
    await click(find(host, '[data-action="vault-reopen"]'));
    for (let i = 0; i < 4; i += 1) await settle(30);
    expect(server.calls.filter((call) => call.path === REOPEN)).toHaveLength(1);
    expect(host.querySelector('[data-ui="vault-closed"]')).toBeNull();
  });
});
