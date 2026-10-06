import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { view } from '@colosseum/basket';
import { mockAddress } from '@colosseum/chain-mock';
import {
  type Attempt,
  BasketId,
  ChainError,
  type IntentRequest,
  type Leg,
  ORDER_LIMITS,
  parseChainConfigs,
  parseFlags,
  type VaultState,
} from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import {
  AuthError,
  authenticate,
  authFromEnv,
  holds,
  registerAuth,
  rememberFailure,
  walletsFromClaim,
} from '../plugins/auth';
import { registerV1Routes } from '../routes/v1';
import { planFixture, testIssuer } from '../testing/harness';
import { createChainRegistry } from './chains';
import { Refusal, refusalFromChainError } from './errors';
import { attemptFor, orderStatus } from './legs';
import { basketIdOf, prepareIntent, targetsOf, tradesFor } from './prepare';

// The parts of API-1 that need no database. The routes themselves are in routes/v1/orders.test.ts.

const registry = (env: Record<string, string> = {}, seed = 'a') =>
  createChainRegistry(parseFlags(env), parseChainConfigs(env), { seed });

describe('the chain registry', () => {
  it('gives the mock for a chain in mock mode, labelled mock', () => {
    const chains = registry();
    expect(chains.active().map((e) => [e.chain, e.mode, e.provenance, Boolean(e.mock)])).toEqual([
      ['solana', 'mock', 'mock', true],
      ['robinhood', 'mock', 'mock', true],
    ]);
    // Even set to mainnet, a chain on the mock is never labelled live.
    const mainnet = registry({ CHAIN_NETWORK_SOLANA: 'mainnet' });
    expect(mainnet.get('solana').provenance).toBe('mock');
  });

  it('refuses a chain that is off with CHAIN_UNAVAILABLE', () => {
    const chains = registry();
    expect(chains.mode('base')).toBe('off');
    let thrown: unknown;
    try {
      chains.get('base');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Refusal);
    expect((thrown as Refusal).status).toBe(503);
    expect((thrown as Refusal).body()).toMatchObject({
      error: 'Base is switched off on this server',
      code: 'CHAIN_UNAVAILABLE',
    });
  });

  it('stops at start on live or readonly where no adapter is wired, and nothing falls back to the mock', () => {
    const address = '0x00000000000000000000000000000000000000aa';
    for (const mode of ['live', 'readonly'])
      expect(() => registry({ CHAIN_ROUTER_BASE: address, CHAIN_MODE_BASE: mode })).toThrow(
        `CHAIN_MODE_BASE is ${mode}, and the API has no base adapter for that yet`,
      );
    // Robinhood Chain has its adapter, and does not start without its node and its asset list.
    for (const mode of ['live', 'readonly'])
      expect(() =>
        registry({ CHAIN_ROUTER_ROBINHOOD: address, CHAIN_MODE_ROBINHOOD: mode }),
      ).toThrow(
        `CHAIN_MODE_ROBINHOOD is ${mode}, and the API was given no Robinhood Chain RPC or no asset list`,
      );
  });

  it('runs Robinhood Chain on the EVM adapter in live or readonly, on its test network or a local copy, labelled sandbox', () => {
    const contracts = {
      robinhood: {
        factory: '0x00000000000000000000000000000000000000f1',
        registry: '0x00000000000000000000000000000000000000f2',
      },
    };
    const cash = {
      id: 'robinhood:tusdg',
      chain: 'robinhood' as const,
      address: '0x00000000000000000000000000000000000000c0',
      symbol: 'tUSDG',
      decimals: 6,
      cls: 'cash' as const,
      underlying: 'USD',
      issuer: 'test',
      tier: 'A' as const,
      priceKind: 'none' as const,
      priceRef: '',
      session: 'always' as const,
      autoFollowEligible: true,
      maxWeightBps: 0,
      blockedCountries: [],
      sheet: 'test',
      provenance: 'sandbox' as const,
    };
    // Nothing is asked of the node here: the adapter reads only when a route asks it to.
    const robinhood = { rpc: {} as never, assets: [cash] };
    for (const mode of ['live', 'readonly'] as const)
      for (const network of ['testnet', 'local']) {
        const e = {
          CHAIN_MODE_ROBINHOOD: mode,
          CHAIN_NETWORK_ROBINHOOD: network,
          CHAIN_ROUTER_ROBINHOOD: '0x00000000000000000000000000000000000000ab',
        };
        const entry = createChainRegistry(parseFlags(e), parseChainConfigs(e, contracts), {
          seed: 'a',
          robinhood,
        }).get('robinhood');
        expect([entry.mode, entry.provenance, entry.mock]).toEqual([mode, 'sandbox', undefined]);
        expect(entry.adapter.capabilities).toMatchObject({
          trade: mode,
          maxTradesPerTx: 8,
          tradesInCreate: true,
          needsApprove: true,
        });
        expect(entry.source).not.toMatch(/https?:/);
      }
    const onMainnet = { CHAIN_MODE_ROBINHOOD: 'live', CHAIN_NETWORK_ROBINHOOD: 'mainnet' };
    expect(() =>
      createChainRegistry(parseFlags(onMainnet), parseChainConfigs(onMainnet, contracts), {
        seed: 'a',
        robinhood,
      }),
    ).toThrow('CHAIN_MODE_ROBINHOOD is live on mainnet, which this API does not run yet');
  });

  it('runs Solana on its real adapter in live or readonly, on a test network or a local copy, labelled sandbox', () => {
    const program = 'BPFLoaderUpgradeab1e11111111111111111111111';
    const router = 'ComputeBudget111111111111111111111111111111';
    const prices = 'SysvarC1ock11111111111111111111111111111111';
    const cash = {
      id: 'solana:usdc',
      chain: 'solana' as const,
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'USDC',
      decimals: 6,
      cls: 'cash' as const,
      underlying: 'USD',
      issuer: 'test',
      tier: 'A' as const,
      priceKind: 'none' as const,
      priceRef: '',
      session: 'always' as const,
      autoFollowEligible: true,
      maxWeightBps: 0,
      blockedCountries: [],
      sheet: 'test',
      provenance: 'sandbox' as const,
    };
    // Nothing here is asked of the node: the adapter reads only when a route asks it to.
    const solana = { rpc: {} as never, assets: [cash] };
    const env = (mode: string, network: string) => ({
      CHAIN_MODE_SOLANA: mode,
      CHAIN_NETWORK_SOLANA: network,
      CHAIN_ROUTER_SOLANA: router,
      CHAIN_PRICE_SOURCE_SOLANA: prices,
    });
    const real = (e: Record<string, string>, inputs: typeof solana | null = solana) =>
      createChainRegistry(parseFlags(e), parseChainConfigs(e, { solana: { program } }), {
        seed: 'a',
        ...(inputs ? { solana: inputs } : {}),
      });
    for (const mode of ['live', 'readonly'] as const)
      for (const network of ['testnet', 'local']) {
        const entry = real(env(mode, network)).get('solana');
        expect([entry.mode, entry.provenance, entry.mock]).toEqual([mode, 'sandbox', undefined]);
        expect(entry.adapter.capabilities).toMatchObject({ trade: mode, maxTradesPerTx: 1 });
        expect(entry.source).not.toMatch(/https?:/);
      }
    // Mainnet waits for its own slot, and nothing runs without the node and the asset list.
    expect(() => real(env('live', 'mainnet'))).toThrow(
      'CHAIN_MODE_SOLANA is live on mainnet, which this API does not run yet',
    );
    expect(() => real(env('readonly', 'testnet'), null)).toThrow(
      'the API was given no Solana RPC or no asset list',
    );
  });

  it('never repeats a mock transaction id across restarts: the seed is in every build', async () => {
    const owner = '0x00000000000000000000000000000000000000aa';
    const built = async (seed: string) => {
      const { adapter, mock } = registry({}, seed).get('robinhood');
      const tx = await adapter.buildApprove({ owner, basketId: '1', amountRaw: '1' });
      mock?.fund(owner, { gasRaw: '1000000000000000000' });
      return { hash: tx.messageHash, txId: (await mock?.send(tx))?.txId };
    };
    const [first, again, restarted] = [await built('one'), await built('one'), await built('two')];
    // The same seed gives the same ids, so it is the seed that keeps two runs apart.
    expect(again).toEqual(first);
    expect(restarted.hash).not.toBe(first.hash);
    expect(restarted.txId).not.toBe(first.txId);
  });

  it('keeps the mock clock on the wall clock, so a built transaction goes stale', async () => {
    let now = Date.parse('2026-10-05T15:00:00.000Z');
    const env = {};
    const chains = createChainRegistry(parseFlags(env), parseChainConfigs(env), {
      seed: 'clock',
      now: () => new Date(now),
    });
    const before = chains.get('solana').mock?.now();
    now += 90_000;
    expect((chains.get('solana').mock?.now() ?? 0) - (before ?? 0)).toBe(90);
  });
});

describe('order status', () => {
  const leg = (chain: Leg['chain'], status: Leg['status']) => ({ chain, status }) as Leg;
  const at = (legs: Leg[], late = false) => orderStatus(legs, 1000, late ? 1001 : 999);

  it('follows the legs and the clock', () => {
    expect(at([leg('solana', 'planned'), leg('robinhood', 'built')])).toBe('open');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'sent')])).toBe('open');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'confirmed')])).toBe('done');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'skipped')], true)).toBe('done');
    // One chain done and a failed leg on another: a publish order, the only kind with two chains.
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'failed')])).toBe('partial');
    expect(at([leg('solana', 'planned'), leg('robinhood', 'failed')])).toBe('failed');
    // An order on one chain with a failed leg is failed, whatever else on that chain settled.
    expect(at([leg('solana', 'confirmed'), leg('solana', 'failed')])).toBe('failed');
    expect(
      at([leg('robinhood', 'confirmed'), leg('robinhood', 'failed'), leg('robinhood', 'planned')]),
    ).toBe('failed');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'planned')], true)).toBe('expired');
    // A leg whose transaction never landed is built again while the order is open.
    expect(at([leg('solana', 'expired')])).toBe('open');
  });
});

describe('the trades of a buy: the invested share is traded, the rest stays as cash', () => {
  const CASH = 'solana:usdc';
  const targets = (weights: Record<string, number>) =>
    Object.entries(weights).map(([slug, weightBps]) => ({ asset: `solana:${slug}`, weightBps }));
  const amounts = (weights: Record<string, number>, cashRaw: bigint) =>
    tradesFor(targets(weights), cashRaw, CASH).map((t) => [t.sell, t.buy, t.amountInRaw]);
  const spent = (weights: Record<string, number>, cashRaw: bigint) =>
    tradesFor(targets(weights), cashRaw, CASH).reduce((n, t) => n + BigInt(t.amountInRaw), 0n);

  it('at 10,000 spends the whole deposit, to the last unit', () => {
    expect(amounts({ spy: 5000, nvda: 3000, gold: 2000 }, 1_000_000_000n)).toEqual([
      [CASH, 'solana:spy', '500000000'],
      [CASH, 'solana:nvda', '300000000'],
      [CASH, 'solana:gold', '200000000'],
    ]);
    // Thirds do not divide: what rounding leaves goes to the largest, and nothing is left over.
    for (const cashRaw of [1_000_000_000n, 999_999_999n, 7n, 100_000_001n])
      expect(spent({ spy: 3334, nvda: 3333, gold: 3333 }, cashRaw)).toBe(cashRaw);
  });

  it('at 9,500 trades 95% of the deposit and leaves 5% as cash', () => {
    expect(amounts({ spy: 5000, nvda: 2500, gold: 2000 }, 1_000_000_000n)).toEqual([
      [CASH, 'solana:spy', '500000000'],
      [CASH, 'solana:nvda', '250000000'],
      [CASH, 'solana:gold', '200000000'],
    ]);
    expect(spent({ spy: 5000, nvda: 2500, gold: 2000 }, 1_000_000_000n)).toBe(950_000_000n);
    // Never more than the invested share, whatever the rounding: the cash share is not spent.
    for (const cashRaw of [999_999_999n, 1_000_001n, 19n, 1n])
      expect(spent({ spy: 5000, nvda: 2500, gold: 2000 }, cashRaw)).toBe(
        (cashRaw * 9500n) / 10_000n,
      );
    // A single line at 1 bp of $1,000: ten cents are traded.
    expect(amounts({ spy: 1 }, 1_000_000_000n)).toEqual([[CASH, 'solana:spy', '100000']]);
  });

  it('with no target trades nothing: the plan is all cash', () => {
    expect(tradesFor([], 1_000_000_000n, CASH)).toEqual([]);
  });
});

describe('a plan’s components as the targets a vault takes', () => {
  const assets = registry().get('solana').adapter.listAssets();
  const asset = (slug: string, weightBps: number) => ({
    kind: 'asset' as const,
    asset: `solana:${slug}`,
    weightBps,
  });
  const index = (family: string, weightBps: number) => ({
    kind: 'index' as const,
    family,
    weightBps,
  });
  /** A shared portfolio on the shelf, as the store hands it over. */
  const family = (slug: string, components: ReturnType<typeof asset>[]) => ({
    meta: {
      familyId: 'a'.repeat(64),
      slug,
      name: slug,
      copy: '',
      kind: 'index' as const,
      chains: ['solana' as const],
    },
    recipes: [
      {
        schemaVersion: 1 as const,
        familyId: 'a'.repeat(64),
        chain: 'solana' as const,
        onchainId: 'x',
        creator: mockAddress('solana', 'creator'),
        kind: 'community' as const,
        version: 1,
        effectiveAt: 0,
        components,
        metaHash: 'b'.repeat(64),
        maxFeeBps: 0 as const,
        flags: 0 as const,
      },
    ],
  });
  const none = async () => [];
  const refused = async (work: Promise<unknown>) => {
    const thrown = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Refusal);
    return [(thrown as Refusal).status, (thrown as Refusal).message];
  };

  it('takes weights that add up to the whole, to less, and to nothing', async () => {
    const whole = [asset('spy', 5000), asset('nvda', 3000), asset('gold', 2000)];
    expect(await targetsOf('solana', whole, await assets, none)).toEqual([
      { asset: 'solana:spy', weightBps: 5000 },
      { asset: 'solana:nvda', weightBps: 3000 },
      { asset: 'solana:gold', weightBps: 2000 },
    ]);
    // 9,500: the rest is the plan's cash share, and cash is no target.
    const short = [asset('spy', 5000), asset('nvda', 2500), asset('gold', 2000)];
    const targets = await targetsOf('solana', short, await assets, none);
    expect(targets.reduce((n, t) => n + t.weightBps, 0)).toBe(9500);
    // All cash: no component, no target, and the shelf is not read.
    const never = () => Promise.reject(new Error('the shelf was read'));
    expect(await targetsOf('solana', [], await assets, never)).toEqual([]);
    expect(await targetsOf('solana', whole, await assets, never)).toHaveLength(3);
  });

  it('opens a shared portfolio held as one line into its assets, weighted through', async () => {
    const shelf = async () => [family('core', [asset('spy', 6000), asset('nvda', 4000)])];
    // 50% in the shared portfolio, 30% gold of its own, 20% cash. An asset reached twice is one target.
    const components = [index('core', 5000), asset('gold', 2000), asset('nvda', 1000)];
    expect(await targetsOf('solana', components, await assets, shelf)).toEqual([
      { asset: 'solana:nvda', weightBps: 3000 },
      { asset: 'solana:spy', weightBps: 3000 },
      { asset: 'solana:gold', weightBps: 2000 },
    ]);
  });

  it('refuses what cannot be a vault’s targets, and says why', async () => {
    expect(
      await refused(targetsOf('solana', [index('nowhere', 10_000)], await assets, none)),
    ).toEqual([
      422,
      'this plan cannot be opened into its assets: no shared portfolio "nowhere" on the shelf',
    ]);
    const over = [asset('spy', 6000), asset('nvda', 3000), asset('gold', 2000)];
    expect((await refused(targetsOf('solana', over, await assets, none)))[1]).toMatch(
      /weights must add up to at most 10,000/,
    );
    // More lines than a vault holds are refused, never trimmed: the person buys what they were shown.
    const many = Array.from({ length: 17 }, (_, i) => asset(`line-${i}`, 500));
    expect(await refused(targetsOf('solana', many, await assets, none))).toEqual([
      422,
      'this plan has 17 lines, and a vault holds at most 16 of at least one basis point each',
    ]);
  });
});

describe('which attempt at a step a transaction is', () => {
  const attempt = (n: number, status: Attempt['status'], nonce: number | null): Attempt => ({
    id: `a${n}`,
    legId: 'leg',
    n,
    messageHash: 'h',
    nonce,
    status,
    txId: null,
    explorerUrl: null,
    validUntil: null,
    builtAt: '2026-10-05T15:00:00.000Z',
  });
  const pick = (attempts: Attempt[], nonce: number | null, legSettled = false) =>
    attemptFor(attempts, nonce, legSettled)?.n;

  it('on Solana a message names one attempt, whatever its state', () => {
    for (const status of ['built', 'sent', 'expired', 'confirmed', 'failed'] as const)
      expect(pick([attempt(1, status, null)], null)).toBe(1);
  });

  it('after a cancel and a rebuild, the pair is the rebuilt attempt: the newest that can still land', () => {
    const twins = [attempt(1, 'expired', 5), attempt(2, 'built', 5)];
    expect(pick(twins, 5)).toBe(2);
    expect(
      pick([attempt(1, 'expired', 5), attempt(2, 'expired', 5), attempt(3, 'sent', 5)], 5),
    ).toBe(3);
    // Once one of the pair has landed, it is that one: a nonce is used once.
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'confirmed', 5)], 5, true)).toBe(2);
    // Both closed and neither landed: the newer.
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'expired', 5)], 5)).toBe(2);
  });

  it('after a revert and a rebuild, the new attempt has its own nonce and is never the reverted one', () => {
    const rebuilt = [attempt(1, 'failed', 5), attempt(2, 'built', 6)];
    expect(pick(rebuilt, 6)).toBe(2);
    expect(pick(rebuilt, 5)).toBe(1);
  });

  it('a nonce no attempt states is the wallet’s own: the newest attempt that can still land', () => {
    expect(pick([attempt(1, 'failed', 5), attempt(2, 'built', 6)], 9)).toBe(2);
    // Closed, and the wallet sent it all the same: the step did happen.
    expect(pick([attempt(1, 'expired', 5)], 9)).toBe(1);
    // A step that is settled takes no such transaction: the same call on another nonce is another one.
    expect(pick([attempt(1, 'confirmed', 5)], 9, true)).toBeUndefined();
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'confirmed', 5)], 9, true)).toBeUndefined();
    // Nothing left that could have landed.
    expect(pick([attempt(1, 'failed', 5)], 9)).toBeUndefined();
  });

  it('a nonce below every nonce the step stated is an older transaction, and not the step’s', () => {
    // The same call, landed on nonce 3 before the step was first built on nonce 5.
    expect(pick([attempt(1, 'built', 5)], 3)).toBeUndefined();
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'built', 6)], 4)).toBeUndefined();
    expect(pick([attempt(1, 'failed', 5), attempt(2, 'built', 6)], 0)).toBeUndefined();
    // From the lowest stated nonce up it may be the wallet's own choice.
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'built', 7)], 6)).toBe(2);
    expect(pick([attempt(1, 'built', 5)], 6)).toBe(1);
  });

  it('bytes that state no nonce: what can still land, then what landed, then what was closed', () => {
    expect(pick([attempt(1, 'failed', 5), attempt(2, 'built', 6)], null)).toBe(2);
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'confirmed', 5)], null, true)).toBe(2);
    expect(pick([attempt(1, 'expired', 5), attempt(2, 'expired', 5)], null)).toBe(2);
  });
});

describe('a chain refusal as the API answers it', () => {
  it('maps the codes that have an order code, and keeps the chain’s own code and retryable', () => {
    const answer = (e: ChainError) => {
      const r = refusalFromChainError(e);
      return [r.status, r.extra.code, r.extra.details];
    };
    const d = (chainCode: string, retryable: boolean) => ({ chainCode, retryable });
    expect(answer(new ChainError('NotFunded', 'x'))).toEqual([
      409,
      'NOT_FUNDED',
      d('NotFunded', false),
    ]);
    expect(answer(new ChainError('NoGas', 'x'))).toEqual([409, 'NOT_FUNDED', d('NoGas', false)]);
    expect(answer(new ChainError('Unavailable', 'x'))).toEqual([
      503,
      'CHAIN_UNAVAILABLE',
      d('Unavailable', true),
    ]);
    expect(answer(new ChainError('MintNotAccepted', 'x'))[1]).toBe('ASSET_NOT_ELIGIBLE');
    expect(answer(new ChainError('NewAssetNeedsOwner', 'x'))[1]).toBe('NEW_ASSET_NEEDS_APPROVAL');
    expect(answer(new ChainError('VersionMismatch', 'x'))[1]).toBe('VERSION_CHANGED');
    expect(answer(new ChainError('CreatorLimit', 'x'))[1]).toBe('CREATOR_LIMIT');
    // No order code fits: the chain's code still reaches the caller.
    expect(answer(new ChainError('ReceivedTooLittle', 'x'))).toEqual([
      409,
      undefined,
      d('ReceivedTooLittle', true),
    ]);
    // An adapter that says retryable for itself is believed.
    expect(answer(new ChainError('VaultExists', 'x', true))[2]).toEqual(d('VaultExists', true));
    expect(answer(new ChainError('Unknown', 'x'))[0]).toBe(500);
  });
});

describe('view: value, weight and drift, as the portfolio route gets them from packages/basket', () => {
  // The shared view takes the chain's asset list for each token's decimals.
  const ASSETS = [
    { id: 'solana:usdc', decimals: 6 },
    { id: 'solana:spy', decimals: 8 },
    { id: 'solana:gold', decimals: 8 },
  ];
  const holding = (asset: string, raw: string, multiplier: string, display: string) => ({
    asset,
    raw,
    multiplier,
    display,
  });
  const price = (asset: string, usdPerToken: string) => ({
    asset,
    usdPerToken,
    ageSeconds: 0,
    maxAgeSeconds: 120,
    market: 'open' as const,
    source: 'test',
    method: 'test',
    fetchedAt: '2026-10-05T15:00:00.000Z',
    provenance: 'mock' as const,
  });
  const vault = (positions: VaultState['positions'], cashRaw = '0'): VaultState => ({
    chain: 'solana',
    address: '11111111111111111111111111111111',
    owner: '11111111111111111111111111111111',
    basketId: '1',
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    keeper: '11111111111111111111111111111111',
    cash: holding('solana:usdc', cashRaw, '1', (Number(cashRaw) / 1e6).toString()),
    positions,
    lossUsedBps: 0,
    observedAt: '2026-10-05T15:00:00.000Z',
    pending: null,
  });

  it('values a holding with no multiplier: the design’s vector', () => {
    // 8 decimals, raw 250,000,000, multiplier 1.02, price 100: display 2.55 and value 250.00.
    const spy = { ...holding('solana:spy', '250000000', '1.02', '2.55'), targetBps: 10_000 };
    const seen = view(
      vault([{ ...spy, lastKeeperAt: null }]),
      [price('solana:spy', '100')],
      ASSETS,
    );
    // Dollars are cut to six places with no trailing zeros: 250, not 250.00.
    expect(seen.valueUsd).toBe('250');
    expect(seen.positions[0]).toMatchObject({ valueUsd: '250', weightBps: 10_000, driftBps: 0 });
  });

  it('counts cash in the total, and drift as weight minus target', () => {
    const positions = [
      { ...holding('solana:spy', '300000000', '1', '3'), targetBps: 5000, lastKeeperAt: null },
      { ...holding('solana:gold', '50000000', '1', '0.5'), targetBps: 5000, lastKeeperAt: null },
    ];
    const prices = [
      price('solana:spy', '100'),
      price('solana:gold', '200'),
      price('solana:usdc', '1'),
    ];
    const seen = view(vault(positions, '100000000'), prices, ASSETS);
    expect(seen.valueUsd).toBe('500');
    expect(seen.positions.map((p) => [p.valueUsd, p.weightBps, p.driftBps])).toEqual([
      ['300', 6000, 1000],
      ['100', 2000, -3000],
    ]);
  });

  it('gives an asset with no price a null value, never zero dollars', () => {
    const positions = [
      { ...holding('solana:spy', '300000000', '1', '3'), targetBps: 5000, lastKeeperAt: null },
      { ...holding('solana:odd', '5', '1', '0.00000005'), targetBps: 5000, lastKeeperAt: null },
    ];
    const seen = view(vault(positions), [price('solana:spy', '100')], ASSETS);
    expect(seen.positions.map((p) => [p.valueUsd, p.weightBps])).toEqual([
      ['300', 10_000],
      [null, 0],
    ]);
  });
});

describe('prepareIntent holds a buy to the caps itself, for a caller that does not come through the route', () => {
  // The route's schema refuses these with a 400 before prepareIntent runs. A caller that hands it a
  // request directly (the MCP server, a script) is held to the same two numbers here.
  const solana = mockAddress('solana', 'a buyer');
  const planId = '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d';
  const prepare = (over: { amountUsd?: number; maxSlippageBps?: number }) =>
    prepareIntent(
      // Past the schema on purpose: these are values it would not let through.
      {
        type: 'buy',
        owner: { solana },
        amountUsd: 600,
        proposalId: planId,
        ...over,
      } as IntentRequest,
      {
        principal: {
          kind: 'user',
          wallets: [{ family: 'solana', address: solana, kind: 'external' }],
          ip: '',
        },
        chains: registry(),
        loadProposal: async (id) => (id === planId ? planFixture('solana') : null),
        homeChain: async () => 'solana',
        loadFamilies: async () => [],
        now: '2026-10-05T15:00:00.000Z',
      },
    );
  const refusal = async (work: Promise<unknown>) => {
    const thrown = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Refusal);
    return thrown as Refusal;
  };

  it('plans a buy at the ceiling and at the cap, with the legs the plan gives', async () => {
    expect(ORDER_LIMITS).toEqual({ maxAmountUsd: 1_000_000, maxSlippageBps: 300 });
    const order = await prepare({ amountUsd: 1_000_000, maxSlippageBps: 300 });
    expect(order.legs.map((l) => l.kind)).toEqual(['create_vault', 'swap', 'swap', 'swap']);
    // The cap is the slippage the figures are worked out with.
    const [figure] = order.legs[1]?.expected ?? [];
    expect(figure?.minOutRaw).toBe(((BigInt(figure?.outRaw ?? 0) * 9_700n) / 10_000n).toString());
  });

  it('refuses an amount over the ceiling with 422 and the sentence that names it', async () => {
    for (const amountUsd of [1_000_000.01, 1e300, Number.POSITIVE_INFINITY, Number.NaN]) {
      const refused = await refusal(prepare({ amountUsd }));
      expect([amountUsd, refused.status]).toEqual([amountUsd, 422]);
      expect(refused.message).toBe('one order buys at most $1,000,000');
    }
  });

  it('refuses a slippage over the cap, or under nothing, with 422', async () => {
    for (const maxSlippageBps of [301, 10_000, -1, Number.NaN]) {
      const refused = await refusal(prepare({ maxSlippageBps }));
      expect([maxSlippageBps, refused.status]).toEqual([maxSlippageBps, 422]);
      expect(refused.message).toBe('a trade takes at most 300 bps of slippage');
    }
  });
});

describe('a plan’s number onchain', () => {
  it('is a 64-bit number, the same for the same plan and in any letter case', () => {
    const id = '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d';
    expect(BasketId.parse(basketIdOf(id))).toBe(basketIdOf(id.toUpperCase()));
    expect(basketIdOf(id)).not.toBe(basketIdOf('5b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d'));
  });
});

describe('sign-in, without a network', () => {
  it('reads the wallets of an identity token, and nothing that is not a wallet', () => {
    const solana = mockAddress('solana', 'a wallet');
    const linked = [
      { type: 'wallet', address: solana, chain_type: 'solana', wallet_client_type: 'privy' },
      {
        type: 'wallet',
        address: '0xABCDEF0000000000000000000000000000000001',
        chain_type: 'ethereum',
      },
      {
        type: 'wallet',
        address: '0xabcdef0000000000000000000000000000000001',
        chain_type: 'ethereum',
      },
      {
        type: 'wallet',
        address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        chain_type: 'bitcoin',
      },
      { type: 'wallet', address: 'not-an-address', chain_type: 'solana' },
      { type: 'wallet', address: solana, chain_type: 'ethereum' },
      { type: 'email', address: 'someone@example.invalid' },
      { type: 'smart_wallet', address: '0xabcdef0000000000000000000000000000000002' },
      null,
    ];
    const expected = [
      { family: 'solana', address: solana, kind: 'embedded' },
      { family: 'evm', address: '0xabcdef0000000000000000000000000000000001', kind: 'external' },
    ];
    // Privy sends the claim as a JSON string.
    expect(walletsFromClaim(JSON.stringify(linked))).toEqual(expected);
    expect(walletsFromClaim(linked)).toEqual(expected);
    for (const nothing of [undefined, null, 7, 'not json', '{"type":"wallet"}', {}])
      expect(walletsFromClaim(nothing)).toEqual([]);
  });

  it('trusts no issuer unless an app id is set, and fetches nothing to say so', () => {
    expect(authFromEnv({})).toBeNull();
    expect(authFromEnv({ PRIVY_APP_ID: '  ' })).toBeNull();
    const privy = authFromEnv({ PRIVY_APP_ID: 'app-id-1' });
    expect(privy).toMatchObject({ issuer: 'privy.io', audience: 'app-id-1' });
    // Refused without repeating the value.
    const bad = 'http://keys.example.invalid/jwks.json';
    expect(() => authFromEnv({ PRIVY_APP_ID: 'a', PRIVY_JWKS_URL: bad })).toThrow(
      'PRIVY_JWKS_URL: expected an https URL',
    );
    expect(() => authFromEnv({ PRIVY_APP_ID: 'a b/../c' })).toThrow(
      'PRIVY_APP_ID: expected an app id',
    );
  });

  it('answers 503, not 401, when the issuer’s keys cannot be read', async () => {
    const { issuer, sign } = await testIssuer('unreachable');
    const access = await sign('did:privy:someone', { sid: 'session' });
    const identity = await sign('did:privy:someone', { linked_accounts: '[]' });
    const headers = { authorization: `Bearer ${access}`, 'privy-id-token': identity };
    const keys = () => Promise.reject(new TypeError('fetch failed'));
    const outcome = await authenticate({ ...issuer, keys }, headers, '127.0.0.1').catch(
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(AuthError);
    expect((outcome as AuthError).status).toBe(503);
    // With the keys in reach, the same headers are a person with no wallet.
    expect(await authenticate(issuer, headers, '127.0.0.1')).toEqual({
      kind: 'user',
      userId: 'did:privy:someone',
      wallets: [],
      ip: '127.0.0.1',
    });
  });

  it('holds each token to its own job, so neither stands in for the other', async () => {
    const { issuer, sign } = await testIssuer('roles');
    const sub = 'did:privy:someone';
    const access = await sign(sub, { sid: 'session' });
    const identity = await sign(sub, { linked_accounts: '[]' });
    const signIn = (bearer: string, id: string) =>
      authenticate(issuer, { authorization: `Bearer ${bearer}`, 'privy-id-token': id }, '::1').then(
        () => 'in',
        (e: unknown) => (e instanceof AuthError ? e.status : e),
      );
    expect(await signIn(access, identity)).toBe('in');
    // The identity token in both places, and the access token in both places.
    expect(await signIn(identity, identity)).toBe(401);
    expect(await signIn(access, access)).toBe(401);
    // A session id that is not one, and a token that claims both jobs.
    expect(await signIn(await sign(sub, { sid: '' }), identity)).toBe(401);
    expect(await signIn(await sign(sub, { sid: 7 }), identity)).toBe(401);
    const both = await sign(sub, { sid: 'session', linked_accounts: '[]' });
    expect(await signIn(both, identity)).toBe(401);
    expect(await signIn(both, both)).toBe(401);
  });

  it('asks an issuer that is down once, not once per caller', async () => {
    let asked = 0;
    let clock = 0;
    const down: Parameters<typeof rememberFailure>[0] = () => {
      asked += 1;
      return Promise.reject(new TypeError('fetch failed'));
    };
    const keys = rememberFailure(down, 15_000, () => clock);
    const ask = () => Promise.resolve(keys({ alg: 'ES256' }, { payload: '', signature: '' }));
    for (let i = 0; i < 10; i++) await expect(ask()).rejects.toThrow('fetch failed');
    expect(asked).toBe(1);
    // After the pause it is asked again, once.
    clock += 15_001;
    for (let i = 0; i < 10; i++) await expect(ask()).rejects.toThrow('fetch failed');
    expect(asked).toBe(2);

    // Through the route: ten requests while the keys are down are ten 503s and one fetch.
    const { issuer, sign } = await testIssuer('down');
    let fetches = 0;
    const app = Fastify();
    registerAuth(app, {
      ...issuer,
      keys: () => {
        fetches += 1;
        return Promise.reject(new TypeError('fetch failed'));
      },
    });
    app.get('/me', { config: { auth: 'user' } }, async () => ({ ok: true }));
    const headers = {
      authorization: `Bearer ${await sign('did:privy:x', { sid: 's' })}`,
      'privy-id-token': await sign('did:privy:x', { linked_accounts: '[]' }),
    };
    for (let i = 0; i < 10; i++)
      expect((await app.inject({ method: 'GET', url: '/me', headers })).statusCode).toBe(503);
    expect(fetches).toBe(1);
    await app.close();
  });

  it('an owner with no address is nobody’s', () => {
    const wallets = [
      { family: 'evm' as const, address: `0x${'ab'.repeat(20)}`, kind: 'embedded' as const },
    ];
    const principal = { kind: 'user' as const, userId: 'x', wallets, ip: '' };
    expect(holds(principal, {})).toBe(false);
    expect(holds(principal, { evm: wallets[0]?.address })).toBe(true);
    expect(holds(principal, { evm: `0x${'cd'.repeat(20)}` })).toBe(false);
  });

  it('closes a route that declares no sign-in rule, whatever its method', async () => {
    const app = Fastify();
    registerAuth(app, null);
    app.get('/undeclared', async () => ({ ok: true }));
    app.post('/undeclared', async () => ({ ok: true }));
    app.get('/public', { config: { auth: 'public' } }, async () => ({ ok: true }));
    app.post('/public', { config: { auth: 'public' } }, async () => ({ ok: true }));
    expect((await app.inject({ method: 'GET', url: '/public' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/public' })).statusCode).toBe(200);
    // Default deny: a read is closed as a write is, until the route says who may call it.
    for (const method of ['GET', 'HEAD', 'POST'] as const) {
      const res = await app.inject({ method, url: '/undeclared' });
      expect([method, res.statusCode]).toEqual([method, 403]);
    }
    await app.close();
  });
});

describe('the /v1 route table', () => {
  const v1Paths = (doc: unknown) =>
    Object.keys((doc as { paths: Record<string, unknown> }).paths)
      .filter((p) => p.startsWith('/v1/'))
      .sort();

  it('is these routes and no others, with the mock ones only while a chain runs on the mock', async () => {
    const app = await buildApp();
    await app.ready();
    expect(v1Paths(app.swagger())).toEqual([
      '/v1/baskets/personalize',
      '/v1/config',
      '/v1/funding',
      '/v1/indexes/{slug}',
      '/v1/indexes/{slug}/versions',
      '/v1/me',
      '/v1/me/chain',
      '/v1/mock/fund',
      '/v1/mock/orders/{id}/legs/{legId}/land',
      '/v1/orders',
      '/v1/orders/{id}',
      '/v1/orders/{id}/legs/{legId}/build',
      '/v1/orders/{id}/legs/{legId}/cancel',
      '/v1/orders/{id}/legs/{legId}/report',
      '/v1/portfolio',
      '/v1/shelf',
      '/v1/vaults/{chain}/{address}',
    ]);
    // No route lets a caller through without a token: 503 with no Privy app set, 401 with one.
    const res = await app.inject({ method: 'GET', url: '/v1/portfolio' });
    expect([401, 503]).toContain(res.statusCode);
    await app.close();

    const bare = Fastify();
    bare.setValidatorCompiler(validatorCompiler);
    bare.setSerializerCompiler(serializerCompiler);
    await registerV1Routes(bare, { CHAIN_MODE_SOLANA: 'off', CHAIN_MODE_ROBINHOOD: 'off' });
    await bare.ready();
    const routes = bare.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/v1/orders');
    expect(routes).not.toContain('mock');
    const fund = await bare.inject({ method: 'POST', url: '/v1/mock/fund', payload: {} });
    expect(fund.statusCode).toBe(404);
    await bare.close();
  });
});

describe('no /v1 route can make the server sign', () => {
  const src = resolve(__dirname, '..');
  /** Every file the /v1 route table reaches, and every package those files import. */
  function reach(entry: string) {
    const files = new Set<string>();
    const packages = new Map<string, Set<string>>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        if (!spec.startsWith('.')) {
          const at = packages.get(spec) ?? new Set();
          packages.set(spec, at.add(relative(src, file)));
          continue;
        }
        const base = join(dirname(file), spec);
        const target = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
        if (!target) throw new Error(`cannot follow ${spec} from ${file}`);
        visit(target);
      }
    };
    visit(entry);
    return { files: [...files], packages };
  }

  it('reaches no key, no signer and no chain package that can sign', () => {
    const { files, packages } = reach(join(src, 'routes/v1/index.ts'));
    expect(files.map((f) => relative(src, f)).sort()).toEqual([
      'orders/chains.ts',
      'orders/errors.ts',
      'orders/families.ts',
      'orders/legs.ts',
      'orders/person.ts',
      'orders/personalize.ts',
      'orders/prepare.ts',
      'orders/shared.ts',
      'orders/store.ts',
      'plugins/auth.ts',
      'plugins/limits.ts',
      'plugins/paths.ts',
      'routes/v1/baskets.ts',
      'routes/v1/config.ts',
      'routes/v1/funding.ts',
      'routes/v1/index.ts',
      'routes/v1/me.ts',
      'routes/v1/mock.ts',
      'routes/v1/orders.ts',
      'routes/v1/portfolio.ts',
      'routes/v1/shared.ts',
      'routes/v1/vault.ts',
    ]);
    // The chain packages that can sign keep that behind their `./server` entry, and neither the
    // package's root nor that entry is here: the Solana and EVM adapters come in by their key-free
    // `./vault` entries, which tests/boundaries.test.ts holds to reaching no signing file. packages/basket is
    // arithmetic over what it is handed: it imports the schemas and nothing else. The engine comes in
    // by its `./personal` entry, which reads no clock, network or environment
    // (packages/engine/src/personal/purity.test.ts), not by its root, which holds the model client.
    expect([...packages.keys()].sort()).toEqual([
      '@colosseum/basket',
      '@colosseum/chain-evm/vault',
      '@colosseum/chain-mock',
      '@colosseum/chain-solana/vault',
      '@colosseum/db',
      '@colosseum/engine/personal',
      '@colosseum/schemas',
      'drizzle-orm',
      'fastify',
      'fastify-type-provider-zod',
      'jose',
      'node:crypto',
      'zod',
    ]);
    // jose is used to verify and nowhere to sign; node:crypto to hash and to make ids.
    expect([...(packages.get('jose') ?? [])]).toEqual(['plugins/auth.ts']);
    for (const file of files) {
      // The code, without its comments.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const name = relative(src, file);
      expect([
        name,
        /SignJWT|CompactSign|FlattenedSign|GeneralSign|importPKCS8/.test(text),
      ]).toEqual([name, false]);
      expect([
        name,
        /createSign|createPrivateKey|generateKeyPair|privateKey|secretKey/i.test(text),
      ]).toEqual([name, false]);
      expect([name, /process\.env|readFileSync|node:fs|KEYPAIR/.test(text)]).toEqual([name, false]);
    }
  });
});
