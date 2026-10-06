// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { deploymentsOf, familyTextHash, readSolanaRecipe, rpcAt } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { recallOrder } from '../order/order-record';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { FamilyBuyScreen } from './FamilyBuyScreen';
import { FamilyScreen } from './FamilyScreen';
import {
  CREATOR,
  FAMILY_ID,
  FUNDED,
  familyBuyOrder,
  familyOf,
  ORDER_ID,
  RECIPE,
  SLUG,
  USER,
} from './test/fixtures';

// The gap API-3 left, closed (WEB-4): a follow is held to the portfolio as this app reads it from its
// own node, not to our server's answer. Here the node (NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA, answered by a
// double of `fetch`) holds version 3 with other weights than the server's version 2, under the account
// the registry derives from the creator and the family id the slug gives. The page shows the chain's
// version and weights, says the server's answer differs, and a follow names the chain's account and
// version.

const NODE = vi.hoisted(() => {
  const url = 'https://node.example/solana';
  process.env.NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA = url;
  return { url, asked: [] as string[] };
});

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const unbase58 = (text: string) => {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(A.indexOf(c));
  const hex = n.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
};
/** The test network's mints (packages/sdk/deployments/testnet.json). */
const MINT = {
  spyx: 'J5d882iVcofnjkud99LzTcVryPdS8d9BUpH7eBcypeyk',
  nvdax: '6sgytf7j8TMxhsiW7sxuSSTp8xzusV1egyHFV5BABYVr',
  tslax: 'CNJDWe13sZdiF3JeN7URGf95hEndAnMNtXL55hU66uHH',
};
const PROGRAM = '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW';

/** The meta hash the account carries: set by a test, zeros otherwise. */
const META = { hash: '00'.repeat(32) };

/** The registry's account, laid out as programs/basket writes it: version 3 in effect. */
function account(): Uint8Array {
  const b = new Uint8Array(1022);
  const view = new DataView(b.buffer);
  b.set(createHash('sha256').update('account:Recipe').digest().subarray(0, 8), 0);
  b.set(unbase58(CREATOR), 8);
  b.set(Buffer.from(FAMILY_ID, 'hex'), 40);
  view.setUint32(72, 3, true);
  view.setBigInt64(76, 1_791_100_000n, true);
  b.set(Buffer.from(META.hash, 'hex'), 84);
  b[116] = 3;
  [
    [MINT.spyx, 5000],
    [MINT.nvdax, 2500],
    [MINT.tslax, 2500],
  ].forEach(([mint, weight], i) => {
    b.set(unbase58(mint as string), 117 + i * 34);
    view.setUint16(117 + i * 34 + 32, weight as number, true);
  });
  return b;
}

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

beforeEach(() => {
  window.localStorage.clear();
  NODE.asked.length = 0;
  META.hash = '00'.repeat(32);
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  portStore.setApi(async (path, init) => {
    if (path === '/v1/me') return json(person);
    if (path.startsWith('/v1/indexes/') && !path.includes('versions'))
      return json({ family: familyOf(FAMILY_ID), disclaimer: 'd' });
    if (path === '/v1/portfolio')
      return json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vaults: [],
            prices: [],
          },
        ],
        disclaimer: 'd',
      });
    void init;
    return json({ error: 'no' }, 404);
  });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    expect(input).toBe(NODE.url);
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    NODE.asked.push(body.method);
    const clock = new Uint8Array(40);
    new DataView(clock.buffer).setBigInt64(32, 1_791_200_000n, true);
    const wrap = (data: Uint8Array, owner: string) => ({
      data: [Buffer.from(data).toString('base64'), 'base64'],
      owner,
    });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          value: [
            wrap(account(), PROGRAM),
            wrap(clock, 'Sysvar1111111111111111111111111111111111111'),
          ],
        },
      }),
    );
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await unmountAll();
});

describe('a shared portfolio read from the chain by this app', () => {
  it('shows the chain’s version and weights, and says our server’s answer differs', async () => {
    const host = await mount(withAccount('en', createElement(FamilyScreen, { slug: SLUG })));
    for (let i = 0; i < 5; i += 1) await settle(50);
    expect(NODE.asked).toContain('getMultipleAccounts');
    const mark = find(host, '[data-ui="source-mark"]');
    expect(mark.getAttribute('data-source')).toBe('chain');
    expect(mark.textContent).toContain(en.shared.check.differs('Solana'));
    // the chain's version 3 at 50/25/25, not the server's version 2 at 40/30/30
    expect(host.textContent).toContain(en.shared.family.versionN(3));
    const legs = find(host, '[data-ui="plan-legs"]').textContent ?? '';
    for (const part of ['SPYX', '50%', 'NVDAX', '25%', 'TSLAX']) expect(legs).toContain(part);
    expect(legs).not.toContain('40%');
  });

  it('says the text does not match when no version on the chain carries its hash, and shows the creator read', async () => {
    const host = await mount(withAccount('en', createElement(FamilyScreen, { slug: SLUG })));
    for (let i = 0; i < 5; i += 1) await settle(50);
    // the server says the text is the version in effect's; the chain's hash is of other words
    expect(find(host, '[data-ui="text-unverified"]').textContent).toContain(
      en.shared.text.unverified,
    );
    expect(find(host, '[data-ui="creator"]').textContent).toBe(CREATOR);
    await unmountAll();
    // the hash of exactly the name and description shown, worked out here: no mark
    const shown = familyOf(FAMILY_ID);
    META.hash = familyTextHash({
      familyId: FAMILY_ID,
      slug: SLUG,
      name: shown.name,
      copy: shown.copy,
      kind: 'index',
    });
    const again = await mount(withAccount('en', createElement(FamilyScreen, { slug: SLUG })));
    for (let i = 0; i < 5; i += 1) await settle(50);
    expect(again.querySelector('[data-ui="text-unverified"]')).toBeNull();
  });

  it('buys and follows the account, version and weights the chain holds, never the server’s', async () => {
    let placed: Record<string, unknown> | null = null;
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me') return json(person);
      if (path.startsWith('/v1/indexes/'))
        return json({ family: familyOf(FAMILY_ID), disclaimer: 'd' });
      if (path.startsWith('/v1/funding?')) return json(FUNDED);
      if (path === '/v1/orders') {
        placed = JSON.parse(String(init?.body));
        return json(familyBuyOrder(['5000000', '2500000', '2500000']));
      }
      return json({ error: 'no' }, 404);
    });
    const host = await mount(withAccount('en', createElement(FamilyBuyScreen, { slug: SLUG })));
    for (let i = 0; i < 4; i += 1) await settle(50);
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await settle(400);
    await settle(50);
    await click(find(host, 'input[type="checkbox"]'));
    const review = [...host.querySelectorAll<HTMLElement>('button')].find((b) =>
      b.textContent?.includes(en.shared.buy.review('$10')),
    );
    await click(review as HTMLElement);
    await settle(50);
    // the version the chain holds is the one asked for
    expect(placed).toMatchObject({ type: 'buy', family: SLUG, version: 3 });
    const read = await readSolanaRecipe(rpcAt(NODE.url), deploymentsOf('testnet').solana as never, {
      creator: CREATOR,
      familyId: FAMILY_ID,
    });
    expect(read?.address).not.toBe(RECIPE);
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'family',
      slug: SLUG,
      familyId: FAMILY_ID,
      follow: { recipeOnchainId: read?.address, version: 3 },
      targets: [
        { asset: 'solana:spyx', weightBps: 5000 },
        { asset: 'solana:nvdax', weightBps: 2500 },
        { asset: 'solana:tslax', weightBps: 2500 },
      ],
      source: 'chain',
    });
  });
});
