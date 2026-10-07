// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { deploymentsOf, solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { recallOrder } from '../order/order-record';
import { ORDER_ID, orderOn, USER } from '../order/test/fixtures';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { AddMoneyScreen } from './AddMoneyScreen';
import { PORTFOLIO_PATH } from './portfolio';
import { chainOf, portfolioBody, vault } from './test/portfolio';

// More money into a vault, held to the vault's targets as this app reads them from its own node
// (NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA, answered by a double of `fetch`), not to our server's answer. The
// guard does not hold a swap to a vault's targets, so the add screen reads them, the order's terms
// keep them, and an add is not offered where the read fails or our server says something else.

const NODE = vi.hoisted(() => {
  const url = 'https://node.example/solana';
  process.env.NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA = url;
  return { url, asked: [] as { method: string; address: string }[] };
});

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
// the card draws the order's own screen, which holds the runner: nothing here presses it
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const PROGRAM = '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW';
const testnet = deploymentsOf('testnet').solana;
if (testnet?.family !== 'solana') throw new Error('the test network has Solana');
const MINT = (id: string) => testnet.assets[id]?.mint ?? '';
/** The vault of the tests' wallet for plan 8, as this app derives it. */
const MY_VAULT = solanaVaultAddress(PROGRAM, SOLANA, '8');

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const unbase58 = (text: string) => {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(A.indexOf(c));
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
};

/** What the node holds at the vault's address, set by a test. */
const HOLDS = {
  none: false,
  program: PROGRAM,
  owner: SOLANA,
  autoFollow: 0,
  lines: [] as [mint: string, bps: number][],
};

/** The vault's account, laid out as programs/basket writes it. */
function account(): Uint8Array {
  const b = new Uint8Array(1063);
  const view = new DataView(b.buffer);
  b.set(createHash('sha256').update('account:Vault').digest().subarray(0, 8), 0);
  b.set(unbase58(HOLDS.owner), 8);
  b[76] = HOLDS.autoFollow;
  view.setBigUint64(77, 8n, true);
  b[118] = HOLDS.lines.length;
  HOLDS.lines.forEach(([mint, bps], i) => {
    b.set(unbase58(mint), 119 + i * 50);
    view.setUint16(119 + i * 50 + 32, bps, true);
  });
  return b;
}

const position = (asset: string, targetBps: number) => ({
  asset,
  raw: '1000000',
  multiplier: '1',
  display: '1',
  targetBps,
  lastKeeperAt: null,
  valueUsd: '100',
  weightBps: targetBps,
  driftBps: 0,
});
/** The vault as our server answers it: 60% SPYx and 15% gold, unless a test says otherwise. */
const served = (over: Parameters<typeof vault>[0] = {}) =>
  vault({
    address: MY_VAULT,
    basketId: '8',
    autoFollow: false,
    positions: [position('solana:spyx', 6000), position('solana:paxg', 1500)],
    ...over,
  });

const funding = {
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  wallet: SOLANA,
  cash: {
    asset: 'solana:usdc',
    symbol: 'USDC',
    decimals: 6,
    haveRaw: '50000000000',
    needRaw: '10000000',
    missingRaw: '0',
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
  steps: 2,
  newVault: false,
  ok: true,
};

function api(vaults = [served()]) {
  const orders: unknown[] = [];
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  portStore.setApi(async (path, init) => {
    if (path === '/v1/me') return json(person);
    if (path === PORTFOLIO_PATH) return json(portfolioBody(chainOf(vaults)));
    if (path.startsWith('/v1/funding?')) return json(funding);
    if (path === '/v1/orders' && init?.method === 'POST') {
      orders.push(JSON.parse(String(init.body)));
      return json(orderOn());
    }
    if (path === `/v1/orders/${ORDER_ID}`) return json(orderOn());
    return json({ error: 'not found' }, 404);
  });
  return orders;
}

/** The card's one button: "Invest $10", held while no order may be made. */
const SIGN = '[data-ui="invest-card"] > div > [data-variant="primary"]';
/**
 * Opens the page, types $10, accepts the trust notice, and waits for the reads and for the order,
 * which the card makes by itself once nothing stands in its way.
 */
async function ready(address = MY_VAULT) {
  const host = await mount(
    withAccount('en', createElement(AddMoneyScreen, { chain: 'solana', address })),
  );
  for (let i = 0; i < 4; i += 1) await settle(50);
  await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
  await settle(350);
  await click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));
  await settle(450);
  await settle();
  return host;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  NODE.asked.length = 0;
  Object.assign(HOLDS, {
    none: false,
    program: PROGRAM,
    owner: SOLANA,
    autoFollow: 0,
    lines: [
      [MINT('solana:spyx'), 6000],
      [MINT('solana:paxg'), 1500],
    ],
  });
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    expect(input).toBe(NODE.url);
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: [string] };
    NODE.asked.push({ method: body.method, address: body.params[0] });
    const value = HOLDS.none
      ? null
      : { data: [Buffer.from(account()).toString('base64'), 'base64'], owner: HOLDS.program };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { value } }));
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await unmountAll();
});

describe('an add, held to the vault’s targets as this app reads them from the chain', () => {
  it('reads the vault it derives from the wallet and the plan’s number, and keeps the chain’s targets', async () => {
    const orders = api();
    const host = await ready();
    expect(NODE.asked).toContainEqual({ method: 'getAccountInfo', address: MY_VAULT });
    const mark = find(host, '[data-ui="source-mark"]');
    expect(mark.getAttribute('data-source')).toBe('chain');
    expect(mark.textContent).toContain(en.shared.check.verified);
    expect(mark.textContent).toContain(en.portfolio.add.source.read('Solana'));
    expect(orders).toHaveLength(1);
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'vault',
      vault: MY_VAULT,
      basketId: '8',
      targets: [
        { asset: 'solana:spyx', weightBps: 6000 },
        { asset: 'solana:paxg', weightBps: 1500 },
      ],
      keeper: false,
      source: 'chain',
    });
  });

  it('offers no add where our server names other targets than the chain holds', async () => {
    // the server would spend the deposit on NVDAx, which the vault has no target on
    const orders = api([
      served({ positions: [position('solana:nvdax', 6000), position('solana:paxg', 1500)] }),
    ]);
    const host = await ready();
    const mark = find(host, '[data-ui="source-mark"]');
    expect(mark.textContent).toContain(en.portfolio.add.source.differs('Solana'));
    expect(mark.className).toContain('text-destructive');
    const button = find(host, SIGN);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await click(button);
    await settle();
    expect(orders).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('nor where the weights differ, or the server leaves auto-follow out', async () => {
    const orders = api([
      served({ positions: [position('solana:spyx', 7000), position('solana:paxg', 1500)] }),
    ]);
    const host = await ready();
    expect(host.textContent).toContain(en.portfolio.add.source.differs('Solana'));
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
    await unmountAll();
    HOLDS.autoFollow = 1;
    api();
    const following = await ready();
    expect(following.textContent).toContain(en.portfolio.add.source.differs('Solana'));
    expect(find(following, SIGN).getAttribute('aria-disabled')).toBe('true');
    expect(orders).toEqual([]);
  });

  it('nor where the node does not answer as that wallet’s vault, or holds none', async () => {
    for (const break_ of [
      () => {
        HOLDS.owner = PROGRAM;
      },
      () => {
        HOLDS.program = SOLANA;
      },
    ]) {
      break_();
      const orders = api();
      const host = await ready();
      expect(host.textContent).toContain(en.portfolio.add.source.failed('Solana'));
      expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
      expect(orders).toEqual([]);
      await unmountAll();
      Object.assign(HOLDS, { owner: SOLANA, program: PROGRAM });
    }
    HOLDS.none = true;
    api();
    const host = await ready();
    expect(host.textContent).toContain(en.portfolio.add.source.missing('Solana'));
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
  });

  it('nor for an address our server names that is not the vault this app derives', async () => {
    // a real vault of the wallet is on chain, but the server files another address under its number
    const elsewhere = solanaVaultAddress(PROGRAM, SOLANA, '9');
    const orders = api([served({ address: elsewhere })]);
    const host = await ready(elsewhere);
    expect(host.textContent).toContain(en.portfolio.add.source.failed('Solana'));
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
    expect(orders).toEqual([]);
  });

  it('nor where the vault has a target on a token this app does not list', async () => {
    HOLDS.lines = [
      [MINT('solana:spyx'), 6000],
      [PROGRAM, 1500],
    ];
    api();
    const host = await ready();
    expect(host.textContent).toContain(en.portfolio.add.source.unlisted);
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
  });

  it('with auto-follow on, on the chain and in our server’s answer: the deposit alone', async () => {
    HOLDS.autoFollow = 1;
    api([served({ autoFollow: true })]);
    const host = await ready();
    expect(find(host, '[data-ui="add-keeper"]').textContent).toBe(en.portfolio.add.keeper);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      targets: [],
      keeper: true,
      source: 'chain',
    });
  });
});
