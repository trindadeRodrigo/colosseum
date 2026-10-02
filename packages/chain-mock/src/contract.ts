import {
  type Address,
  BasketAsset,
  BuiltTx,
  Capabilities,
  type ChainAdapter,
  ChainError,
  type ChainErrorCode,
  ChainId,
  chainFamily,
  Funding,
  Holding,
  type LegKind,
  Price,
  type Provenance,
  Quote,
  type RawAmount,
  Recipe,
  type Target,
  type Trade,
  TxStatus,
  VaultState,
} from '@colosseum/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { displayAmount } from './amounts';

// The tests every ChainAdapter must pass (DESIGN-VAULT 3.2). The mock passes them here; the Solana and
// EVM adapters run the same function against a fork.
//
//   import { adapterContract } from '@colosseum/chain-mock/contract';
//   adapterContract('solana, local fork', async () => ({ adapter, send, provenance: 'sandbox', ... }));
//
// The setup function brings the chain to the state `ContractFixture` describes and returns it. The
// cases run in the order written: first everything that only reads and builds, then the refusals, then
// the cases that send a transaction and read the state it left. A fixture is used once.
// `contract.selfcheck.test.ts` runs the same cases against adapters that are wrong on purpose and
// expects them to fail: a case that cannot fail does not belong here.

export type ContractFixture = {
  adapter: ChainAdapter;
  /**
   * Signs as `tx.signer` (the owner or the keeper), broadcasts, and resolves once the transaction has
   * landed. On the mock this is `mock.send`.
   */
  send(tx: BuiltTx): Promise<{ txId: string; validUntil?: string }>;
  /** The label everything this adapter returns must carry: 'mock', or 'sandbox' on a test network or a fork. */
  provenance: Provenance;
  /** ISO time. No price, quote or preview is stamped earlier than this. */
  notBefore: string;
  /** The slippage the adapter allows for in `quote().minOutRaw`. */
  quoteSlippageBps: number;
  /** A wallet with cash for `depositRaw` twice over and gas for a dozen transactions. It owns the three vaults. */
  owner: Address;
  /** A wallet that holds nothing and owns no vault. */
  stranger: Address;
  /**
   * A vault of `owner`: auto-follow on, following `recipeOnchainId`, holding cash and at least one
   * position. At least one listed asset is not among its positions.
   */
  vault: Address;
  /** A published shared portfolio with no pending version. `owner` is its creator. */
  recipeOnchainId: string;
  /** True when a newer version has taken effect and only changes weights, so `vault` can adopt it now. */
  adoptable: boolean;
  /** A second vault of `owner`: its own targets, auto-follow off, following nothing, holding cash. */
  manualVault: Address;
  /**
   * A third vault of `owner`: auto-follow on, following `newAssetRecipeId` at a version before the
   * active one.
   */
  newAssetVault: Address;
  /**
   * A shared portfolio whose active version adds an asset to the one `newAssetVault` accepted, and which
   * has a further version published and not yet in effect.
   */
  newAssetRecipeId: string;
  /** A plan id `owner` has not used. */
  freshBasketId: string;
  /** Who a cash approval goes to. Where the chain needs approvals it holds one for twice `depositRaw`. */
  spender: Address;
  depositRaw: RawAmount;
  /** A trade the owner can make inside `vault` now. */
  ownerTrade: Trade;
  /** A trade the keeper can make inside `vault` now: toward a target, and not past it. */
  keeperTrade: Trade;
  /** A trade in one of `vault`'s assets that moves it away from its target. */
  awayTrade: Trade;
  /** A next version of `recipeOnchainId` that `owner` can publish now. */
  publishRecipe: Recipe;
  /** An id in the chain's own format that was never sent. */
  unknownTxId: string;
};

type Ctx = {
  f: ContractFixture;
  a: ChainAdapter;
  assets: BasketAsset[];
  cash: BasketAsset;
  keeper: Address;
  /** The active version of the fixture recipe, as targets. */
  targets: Target[];
  activeVersion: number;
};
type Case = { group: string; name: string; run(c: Ctx): Promise<void> };

/** Parses, and fails on a field the schema does not name: the frozen shape, nothing more. */
function exact<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.parse(value);
  expect(value).toEqual(parsed);
  return parsed;
}

function checkTx(c: Ctx, tx: BuiltTx, kind: LegKind, signer: Address) {
  // The schema holds the cross-field rules: `evm` on an EVM chain and nowhere else, a last valid block
  // height on Solana, a signer in the chain's own form, and no leg or attempt id (the order layer's).
  exact(BuiltTx, tx);
  expect(tx.legKind).toBe(kind);
  expect(tx.chainId).toBe(c.a.chain);
  expect(tx.chain).toBe(chainFamily(c.a.chain));
  expect(tx.signer).toBe(signer);
  expect(tx.provenance).toBe(c.f.provenance);
  expect(tx.preview.provenance).toBe(c.f.provenance);
  expect(tx.preview.simulated).toBe(true);
  expect(tx.preview.fetchedAt >= c.f.notBefore).toBe(true);
  expect(BigInt(tx.preview.feeNativeRaw)).toBeGreaterThan(0n);
  expect(tx.description.length).toBeGreaterThan(0);
  expect(tx.payload.length).toBeGreaterThan(8);
  expect(tx.messageHash.length).toBeGreaterThanOrEqual(32);
}
const delta = (tx: BuiltTx, holder: 'wallet' | 'vault', asset: string) =>
  tx.preview.changes
    .filter((x) => x.holder === holder && x.asset === asset)
    .reduce((n, x) => n + BigInt(x.deltaRaw), 0n);

/** The adapter refuses, with a ChainError that carries this code. */
async function refuses(work: Promise<unknown>, code: ChainErrorCode) {
  const outcome = await work.then(
    () => 'built' as const,
    (e: unknown) => e,
  );
  expect(outcome, `expected a refusal with ${code}`).toBeInstanceOf(ChainError);
  expect((outcome as ChainError).code).toBe(code);
  expect(typeof (outcome as ChainError).retryable).toBe('boolean');
}

async function vaultAt(c: Ctx, address: Address): Promise<VaultState> {
  const v = await c.a.getVault(address);
  if (!v) throw new Error(`no vault at ${address}`);
  return v;
}
const held = (v: VaultState, asset: string) =>
  BigInt(
    asset === v.cash.asset ? v.cash.raw : (v.positions.find((p) => p.asset === asset)?.raw ?? 0),
  );
async function walletRaw(c: Ctx, owner: Address, asset: string): Promise<bigint> {
  const holdings = await c.a.getWalletHoldings(owner);
  return BigInt(holdings.find((h) => h.asset === asset)?.raw ?? 0);
}
/** Sends, and expects the adapter to see it land. */
async function land(c: Ctx, tx: BuiltTx) {
  const { txId, validUntil } = await c.f.send(tx);
  const status = exact(TxStatus, await c.a.track(txId, validUntil));
  expect(status.status).toBe('confirmed');
  expect(status.error).toBeUndefined();
}

const CASES: Case[] = [];
const group = (name: string, cases: Record<string, (c: Ctx) => Promise<void>>) => {
  for (const [title, run] of Object.entries(cases)) CASES.push({ group: name, name: title, run });
};

group('reads', {
  'names its chain and its capabilities': async ({ a }) => {
    ChainId.parse(a.chain);
    exact(Capabilities, a.capabilities);
  },

  'lists its assets: unique ids on its own chain, exactly one cash token': async (c) => {
    expect(c.assets.length).toBeGreaterThan(1);
    for (const x of c.assets) {
      exact(BasketAsset, x);
      expect(x.chain).toBe(c.a.chain);
      expect(x.provenance).toBe(c.f.provenance);
    }
    expect(new Set(c.assets.map((x) => x.id)).size).toBe(c.assets.length);
    expect(new Set(c.assets.map((x) => x.address)).size).toBe(c.assets.length);
    expect(c.assets.filter((x) => x.cls === 'cash')).toHaveLength(1);
  },

  'prices what it is asked for, once each, freshly, and every asset that has a price source':
    async (c) => {
      const ids = c.assets.map((x) => x.id);
      const prices = await c.a.getPrices(ids);
      for (const p of prices) {
        exact(Price, p);
        expect(ids).toContain(p.asset);
        expect(Number(p.usdPerToken)).toBeGreaterThan(0);
        expect(p.provenance).toBe(c.f.provenance);
        expect(p.fetchedAt >= c.f.notBefore).toBe(true);
        // The dollar token is worth about a dollar wherever it has a price at all.
        if (p.asset === c.cash.id) expect(Math.abs(Number(p.usdPerToken) - 1)).toBeLessThan(0.1);
      }
      const priced = prices.map((p) => p.asset);
      expect(new Set(priced).size).toBe(priced.length);
      for (const x of c.assets) if (x.priceKind !== 'none') expect(priced).toContain(x.id);
      expect(await c.a.getPrices([])).toEqual([]);
    },

  'reads the same vault through getVaults and getVault': async (c) => {
    const mine = await c.a.getVaults(c.f.owner);
    for (const v of mine) {
      exact(VaultState, v);
      expect(v.owner).toBe(c.f.owner);
      expect(v.chain).toBe(c.a.chain);
    }
    for (const address of [c.f.vault, c.f.manualVault, c.f.newAssetVault]) {
      const one = exact(VaultState.nullable(), await c.a.getVault(address));
      const listed = mine.find((v) => v.address === address);
      expect(listed, 'the owner lists the vault').toBeDefined();
      expect({ ...listed, observedAt: '' }).toEqual({ ...one, observedAt: '' });
    }
    const [following, manual] = [await vaultAt(c, c.f.vault), await vaultAt(c, c.f.manualVault)];
    expect([following.autoFollow, following.recipeOnchainId]).toEqual([true, c.f.recipeOnchainId]);
    expect([manual.autoFollow, manual.recipeOnchainId, manual.pending]).toEqual([
      false,
      null,
      null,
    ]);
    expect(new Set(mine.map((v) => v.basketId)).size).toBe(mine.length);
  },

  'finds nothing where there is nothing': async (c) => {
    expect(await c.a.getVaults(c.f.stranger)).toEqual([]);
    expect(await c.a.getVault(c.f.stranger)).toBeNull();
    expect(await c.a.getWalletHoldings(c.f.stranger)).toEqual([]);
  },

  'shows each holding as raw × multiplier / 10^decimals': async (c) => {
    const vault = await vaultAt(c, c.f.vault);
    const holdings = [vault.cash, ...vault.positions, ...(await c.a.getWalletHoldings(c.f.owner))];
    expect(holdings.length).toBeGreaterThan(1);
    for (const h of holdings) {
      const decimals = c.assets.find((x) => x.id === h.asset)?.decimals;
      expect(decimals, `${h.asset} is listed`).toBeDefined();
      expect(h.display).toBe(displayAmount(h.raw, h.multiplier, decimals ?? 0));
    }
  },

  'stores targets that add up to 10,000, on listed assets, never on cash': async (c) => {
    for (const address of [c.f.vault, c.f.manualVault, c.f.newAssetVault]) {
      const vault = await vaultAt(c, address);
      expect(vault.positions.reduce((n, p) => n + p.targetBps, 0)).toBe(10_000);
      expect(BigInt(vault.cash.raw)).toBeGreaterThan(0n);
      expect(vault.cash.asset).toBe(c.cash.id);
      for (const p of vault.positions) expect(p.asset).not.toBe(c.cash.id);
    }
    const vault = await vaultAt(c, c.f.vault);
    expect(vault.positions.some((p) => BigInt(p.raw) > 0n)).toBe(true);
  },

  'lists exactly the vaults with auto-follow on, and filters them by recipe': async (c) => {
    const all = await c.a.listAutoFollowVaults();
    expect(all).toContain(c.f.vault);
    expect(all).toContain(c.f.newAssetVault);
    expect(all).not.toContain(c.f.manualVault);
    expect(new Set(all).size).toBe(all.length);
    for (const address of all) expect((await vaultAt(c, address)).autoFollow).toBe(true);
    const followers = await c.a.listAutoFollowVaults(c.f.recipeOnchainId);
    expect(followers).toContain(c.f.vault);
    expect(followers).not.toContain(c.f.newAssetVault);
    for (const address of followers)
      expect((await vaultAt(c, address)).recipeOnchainId).toBe(c.f.recipeOnchainId);
  },

  'reads a recipe: the active version, and a pending one only as the next number': async (c) => {
    const { active, pending } = await c.a.getRecipe(c.f.recipeOnchainId);
    exact(Recipe, active);
    expect(active.onchainId).toBe(c.f.recipeOnchainId);
    expect(active.chain).toBe(c.a.chain);
    expect(pending).toBeNull();
    expect((await vaultAt(c, c.f.vault)).acceptedVersion).toBeLessThanOrEqual(active.version);

    const other = await c.a.getRecipe(c.f.newAssetRecipeId);
    exact(Recipe, other.active);
    const next = exact(Recipe.nullable(), other.pending);
    expect(next?.version).toBe(other.active.version + 1);
    expect(next?.effectiveAt).toBeGreaterThan(other.active.effectiveAt);
    expect(next?.onchainId).toBe(c.f.newAssetRecipeId);
  },

  'tells a vault what is waiting for it: the version, and the assets it would add': async (c) => {
    const { active } = await c.a.getRecipe(c.f.newAssetRecipeId);
    const waiting = await vaultAt(c, c.f.newAssetVault);
    expect(waiting.acceptedVersion).toBeLessThan(active.version);
    expect(waiting.pending?.version).toBe(active.version);
    expect(waiting.pending?.newAssets.length).toBeGreaterThan(0);
    const targets = waiting.positions.filter((p) => p.targetBps > 0).map((p) => p.asset);
    for (const added of waiting.pending?.newAssets ?? []) expect(targets).not.toContain(added);

    const vault = await vaultAt(c, c.f.vault);
    if (c.f.adoptable)
      expect(vault.pending).toMatchObject({ version: c.activeVersion, newAssets: [] });
    else expect(vault.pending).toBeNull();
  },

  'reads what a wallet holds': async (c) => {
    const holdings = await c.a.getWalletHoldings(c.f.owner);
    for (const h of holdings) exact(Holding, h);
    const cash = holdings.find((h) => h.asset === c.cash.id);
    expect(BigInt(cash?.raw ?? 0)).toBeGreaterThanOrEqual(2n * BigInt(c.f.depositRaw));
  },

  'says whether a wallet can pay: cash and gas, and ok only when both are there': async (c) => {
    const need = { cashRaw: c.f.depositRaw, legs: 2, newVault: true };
    for (const who of [c.f.owner, c.f.stranger]) {
      const r = exact(Funding, await c.a.funding(who, need));
      expect(r.chain).toBe(c.a.chain);
      expect(r.cashNeedRaw).toBe(c.f.depositRaw);
      // Two transactions and a new vault cost something on every chain.
      expect(BigInt(r.gasNeedRaw)).toBeGreaterThan(0n);
      expect(r.ok).toBe(
        BigInt(r.cashHaveRaw) >= BigInt(r.cashNeedRaw) &&
          BigInt(r.gasHaveRaw) >= BigInt(r.gasNeedRaw),
      );
    }
    const owner = await c.a.funding(c.f.owner, need);
    expect(owner.ok).toBe(true);
    expect(BigInt(owner.cashHaveRaw)).toBe(await walletRaw(c, c.f.owner, c.cash.id));
    expect((await c.a.funding(c.f.stranger, need)).ok).toBe(false);
    const more = await c.a.funding(c.f.owner, { ...need, legs: 6 });
    expect(BigInt(more.gasNeedRaw)).toBeGreaterThan(BigInt(owner.gasNeedRaw));
  },

  'quotes a trade: the same trade back, a floor under the output, a cost in range': async (c) => {
    const q = exact(Quote, await c.a.quote(c.f.ownerTrade, c.f.owner));
    expect(q.trade).toEqual(c.f.ownerTrade);
    expect(q.provenance).toBe(c.f.provenance);
    expect(q.fetchedAt >= c.f.notBefore).toBe(true);
    expect(BigInt(q.outRaw)).toBeGreaterThan(0n);
    expect(BigInt(q.minOutRaw)).toBeGreaterThan(0n);
    expect(BigInt(q.minOutRaw)).toBeLessThanOrEqual(BigInt(q.outRaw));
    if (c.f.quoteSlippageBps > 0) expect(BigInt(q.minOutRaw)).toBeLessThan(BigInt(q.outRaw));
    // A cost of more than 10% either way is not a quote on a listed asset.
    expect(Math.abs(q.costBps)).toBeLessThan(1000);
    const double = {
      ...c.f.ownerTrade,
      amountInRaw: (2n * BigInt(c.f.ownerTrade.amountInRaw)).toString(),
    };
    expect(BigInt((await c.a.quote(double, c.f.owner)).outRaw)).toBeGreaterThan(BigInt(q.outRaw));
  },

  'tracks an id it has never seen as pending or expired, never as landed': async (c) => {
    const s = exact(TxStatus, await c.a.track(c.f.unknownTxId));
    expect(['pending', 'expired']).toContain(s.status);
  },
});

group('builds', {
  'approves cash where the chain needs it, and refuses where it does not': async (c) => {
    const args = { owner: c.f.owner, spender: c.f.spender, amountRaw: c.f.depositRaw };
    if (c.a.capabilities.needsApprove)
      checkTx(c, await c.a.buildApprove(args), 'approve', c.f.owner);
    else await refuses(c.a.buildApprove(args), 'NotSupported');
  },

  'opens a vault with its own targets and a first deposit of cash': async (c) => {
    const tx = await c.a.buildCreateVault({
      owner: c.f.owner,
      basketId: c.f.freshBasketId,
      targets: c.targets,
      autoFollow: false,
      depositRaw: c.f.depositRaw,
      slippageBps: 100,
    });
    checkTx(c, tx, 'create_vault', c.f.owner);
    expect(delta(tx, 'wallet', c.cash.id)).toBe(-BigInt(c.f.depositRaw));
    expect(delta(tx, 'vault', c.cash.id)).toBe(BigInt(c.f.depositRaw));
  },

  'opens a vault that follows a recipe at the version the person saw, and no other': async (c) => {
    const args = {
      owner: c.f.owner,
      basketId: c.f.freshBasketId,
      targets: [],
      recipeOnchainId: c.f.recipeOnchainId,
      autoFollow: true,
      slippageBps: 100,
    };
    const tx = await c.a.buildCreateVault({ ...args, expectedVersion: c.activeVersion });
    checkTx(c, tx, 'create_vault', c.f.owner);
    await refuses(
      c.a.buildCreateVault({ ...args, expectedVersion: c.activeVersion + 7 }),
      'VersionMismatch',
    );
  },

  'trades inside the create only where the chain can': async (c) => {
    const first = c.targets[0];
    if (!first) throw new Error('the fixture recipe has no asset');
    const args = {
      owner: c.f.owner,
      basketId: c.f.freshBasketId,
      targets: c.targets,
      autoFollow: false,
      depositRaw: c.f.depositRaw,
      trades: [{ sell: c.cash.id, buy: first.asset, amountInRaw: c.f.depositRaw }],
      slippageBps: 100,
    };
    if (!c.a.capabilities.tradesInCreate) {
      await refuses(c.a.buildCreateVault(args), 'NotSupported');
      return;
    }
    const tx = await c.a.buildCreateVault(args);
    checkTx(c, tx, 'create_vault', c.f.owner);
    expect(delta(tx, 'vault', first.asset)).toBeGreaterThan(0n);
    expect(delta(tx, 'vault', c.cash.id)).toBe(0n);
  },

  'previews a deposit as cash leaving the wallet for the vault, and nothing else': async (c) => {
    const tx = await c.a.buildDeposit({
      vault: c.f.vault,
      amountRaw: c.f.depositRaw,
      slippageBps: 100,
    });
    checkTx(c, tx, 'deposit', c.f.owner);
    expect(tx.preview.changes).toHaveLength(2);
    expect(delta(tx, 'wallet', c.cash.id)).toBe(-BigInt(c.f.depositRaw));
    expect(delta(tx, 'vault', c.cash.id)).toBe(BigInt(c.f.depositRaw));
  },

  'previews a trade inside the vault, with the wallet untouched': async (c) => {
    const tx = await c.a.buildOwnerSwap({
      vault: c.f.vault,
      trades: [c.f.ownerTrade],
      slippageBps: 100,
    });
    checkTx(c, tx, 'swap', c.f.owner);
    expect(delta(tx, 'vault', c.f.ownerTrade.sell)).toBe(-BigInt(c.f.ownerTrade.amountInRaw));
    expect(delta(tx, 'vault', c.f.ownerTrade.buy)).toBeGreaterThan(0n);
    expect(tx.preview.changes.filter((x) => x.holder === 'wallet')).toEqual([]);
  },

  'previews a withdrawal as the tokens themselves going to the owner': async (c) => {
    const vault = await vaultAt(c, c.f.vault);
    const txs = await c.a.buildWithdrawInKind({ vault: c.f.vault });
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) checkTx(c, tx, 'withdraw', c.f.owner);
    for (const h of [vault.cash, ...vault.positions].filter((x) => BigInt(x.raw) > 0n)) {
      expect(txs.reduce((n, tx) => n + delta(tx, 'vault', h.asset), 0n)).toBe(-BigInt(h.raw));
      expect(txs.reduce((n, tx) => n + delta(tx, 'wallet', h.asset), 0n)).toBe(BigInt(h.raw));
    }
    const some = await c.a.buildWithdrawInKind({ vault: c.f.vault, assets: [c.cash.id] });
    expect(some).toHaveLength(1);
    expect(some[0]?.preview.changes.map((x) => x.asset)).toEqual([c.cash.id, c.cash.id]);
  },

  'publishes a recipe, signed by its creator': async (c) => {
    const tx = await c.a.buildPublishRecipe({ creator: c.f.owner, recipe: c.f.publishRecipe });
    checkTx(c, tx, 'publish', c.f.owner);
  },

  'builds a different transaction, with a different hash, for every different step': async (c) => {
    const less = (BigInt(c.f.depositRaw) - 1n).toString();
    const txs = [
      await c.a.buildDeposit({ vault: c.f.vault, amountRaw: c.f.depositRaw, slippageBps: 100 }),
      await c.a.buildDeposit({ vault: c.f.vault, amountRaw: less, slippageBps: 100 }),
      await c.a.buildDeposit({ vault: c.f.manualVault, amountRaw: less, slippageBps: 100 }),
      await c.a.buildSetAutoFollow({ vault: c.f.manualVault, on: true }),
      await c.a.buildSetAutoFollow({ vault: c.f.vault, on: false }),
      await c.a.buildOwnerSwap({ vault: c.f.vault, trades: [c.f.ownerTrade], slippageBps: 100 }),
      await c.a.buildKeeperLeg(c.f.vault, c.f.keeperTrade),
    ];
    expect(new Set(txs.map((tx) => tx.messageHash)).size).toBe(txs.length);
    expect(new Set(txs.map((tx) => tx.payload)).size).toBe(txs.length);
  },

  'has no builder that sets a keeper or an operator': async ({ a }) => {
    const names = new Set<string>();
    for (let o: object | null = a; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
      for (const k of Object.getOwnPropertyNames(o)) names.add(k);
    expect([...names].filter((k) => /^build.*(keeper|operator)/i.test(k))).toEqual([
      'buildKeeperLeg',
    ]);
  },
});

group('refusals', {
  'a vault that does not exist: VaultNotFound': async (c) => {
    const nowhere = c.f.stranger;
    await refuses(
      c.a.buildDeposit({ vault: nowhere, amountRaw: c.f.depositRaw, slippageBps: 100 }),
      'VaultNotFound',
    );
    await refuses(c.a.buildSetAutoFollow({ vault: nowhere, on: true }), 'VaultNotFound');
    await refuses(c.a.buildWithdrawInKind({ vault: nowhere }), 'VaultNotFound');
    await refuses(c.a.buildKeeperLeg(nowhere, c.f.keeperTrade), 'VaultNotFound');
    await refuses(c.a.buildAdoptVersion(nowhere), 'VaultNotFound');
  },

  'a plan id the owner already used: VaultExists': async (c) => {
    const used = (await vaultAt(c, c.f.vault)).basketId;
    const args = { owner: c.f.owner, basketId: used, targets: c.targets, autoFollow: false };
    await refuses(c.a.buildCreateVault({ ...args, slippageBps: 100 }), 'VaultExists');
  },

  'more trades than one transaction takes: TooManyTrades': async (c) => {
    const one = {
      ...c.f.ownerTrade,
      amountInRaw: (BigInt(c.f.ownerTrade.amountInRaw) / 20n).toString(),
    };
    const trades = Array.from({ length: c.a.capabilities.maxTradesPerTx + 1 }, () => one);
    await refuses(
      c.a.buildOwnerSwap({ vault: c.f.vault, trades, slippageBps: 100 }),
      'TooManyTrades',
    );
    // The largest batch the chain takes still builds.
    const tx = await c.a.buildOwnerSwap({
      vault: c.f.vault,
      trades: trades.slice(1),
      slippageBps: 100,
    });
    checkTx(c, tx, 'swap', c.f.owner);
  },

  'arguments that are not what the schema says: BadInput, never another kind of error': async (
    c,
  ) => {
    const vault = c.f.vault;
    const [first, second] = c.targets;
    if (!first || !second) throw new Error('the fixture recipe has fewer than two assets');
    await refuses(c.a.buildDeposit({ vault, amountRaw: '1.5', slippageBps: 100 }), 'BadInput');
    await refuses(c.a.buildDeposit({ vault, amountRaw: '-5', slippageBps: 100 }), 'BadInput');
    await refuses(
      c.a.buildDeposit({ vault, amountRaw: c.f.depositRaw, slippageBps: 20_000 }),
      'BadInput',
    );
    await refuses(
      c.a.buildDeposit({ vault: 'not-an-address', amountRaw: '1', slippageBps: 100 }),
      'BadInput',
    );
    const short = [first, { ...second, weightBps: 10_000 - first.weightBps - 1 }];
    await refuses(c.a.buildSetTargets({ vault, targets: short }), 'BadInput');
    const twice = [
      { asset: first.asset, weightBps: 5000 },
      { asset: first.asset, weightBps: 5000 },
    ];
    await refuses(c.a.buildSetTargets({ vault, targets: twice }), 'BadInput');
    const sameSide = { sell: c.cash.id, buy: c.cash.id, amountInRaw: '1' };
    await refuses(c.a.buildOwnerSwap({ vault, trades: [sameSide], slippageBps: 100 }), 'BadInput');
    if (c.a.capabilities.needsApprove)
      await refuses(
        c.a.buildApprove({ owner: c.f.owner, spender: c.f.spender, amountRaw: '1.5' }),
        'BadInput',
      );
  },

  'a deposit of more cash than the wallet holds: NotFunded': async (c) => {
    const tooMuch = ((await walletRaw(c, c.f.owner, c.cash.id)) + 1n).toString();
    await refuses(
      c.a.buildDeposit({ vault: c.f.vault, amountRaw: tooMuch, slippageBps: 100 }),
      'NotFunded',
    );
  },

  'a trade of more than the vault holds: SpentTooMuch': async (c) => {
    const all = held(await vaultAt(c, c.f.vault), c.f.ownerTrade.sell);
    const trade = { ...c.f.ownerTrade, amountInRaw: (all + 1n).toString() };
    await refuses(
      c.a.buildOwnerSwap({ vault: c.f.vault, trades: [trade], slippageBps: 100 }),
      'SpentTooMuch',
    );
  },

  'the keeper, with auto-follow off: AutoFollowOff': async (c) => {
    await refuses(c.a.buildKeeperLeg(c.f.manualVault, c.f.keeperTrade), 'AutoFollowOff');
    await refuses(c.a.buildAdoptVersion(c.f.manualVault), 'AutoFollowOff');
  },

  'the keeper, in an asset the vault did not accept: MintNotAccepted': async (c) => {
    const vault = await vaultAt(c, c.f.vault);
    const outside = c.assets.find(
      (x) => x.cls !== 'cash' && !vault.positions.some((p) => p.asset === x.id),
    );
    if (!outside) throw new Error('the fixture vault holds every listed asset');
    const trade = { sell: c.cash.id, buy: outside.id, amountInRaw: c.f.keeperTrade.amountInRaw };
    await refuses(c.a.buildKeeperLeg(c.f.vault, trade), 'MintNotAccepted');
  },

  'the keeper, away from a target: NotTowardTarget': async (c) => {
    await refuses(c.a.buildKeeperLeg(c.f.vault, c.f.awayTrade), 'NotTowardTarget');
  },

  'adopting a version that adds an asset: NewAssetNeedsOwner': async (c) => {
    await refuses(c.a.buildAdoptVersion(c.f.newAssetVault), 'NewAssetNeedsOwner');
  },

  'adopting when no newer version has taken effect: VersionNotEffective': async (c) => {
    if (c.f.adoptable) return;
    await refuses(c.a.buildAdoptVersion(c.f.vault), 'VersionNotEffective');
  },

  'accepting a version before it takes effect: VersionNotEffective; a wrong number: VersionMismatch':
    async (c) => {
      const { active, pending } = await c.a.getRecipe(c.f.newAssetRecipeId);
      if (!pending) throw new Error('the fixture recipe has no pending version');
      const args = { vault: c.f.newAssetVault, recipeOnchainId: c.f.newAssetRecipeId };
      await refuses(
        c.a.buildAcceptVersion({ ...args, expectedVersion: pending.version }),
        'VersionNotEffective',
      );
      await refuses(
        c.a.buildAcceptVersion({ ...args, expectedVersion: active.version + 7 }),
        'VersionMismatch',
      );
      const stale = (await vaultAt(c, c.f.newAssetVault)).acceptedVersion;
      await refuses(c.a.buildAcceptVersion({ ...args, expectedVersion: stale }), 'VersionMismatch');
    },
});

group('state after a transaction lands', {
  'a deposit moves cash, and only cash, from the owner to the vault': async (c) => {
    const amount = BigInt(c.f.depositRaw);
    const [vault, wallet] = [await vaultAt(c, c.f.vault), await walletRaw(c, c.f.owner, c.cash.id)];
    const tx = await c.a.buildDeposit({
      vault: c.f.vault,
      amountRaw: c.f.depositRaw,
      slippageBps: 100,
    });
    await land(c, tx);
    const after = await vaultAt(c, c.f.vault);
    expect(BigInt(after.cash.raw) - BigInt(vault.cash.raw)).toBe(amount);
    expect(wallet - (await walletRaw(c, c.f.owner, c.cash.id))).toBe(amount);
    expect(after.positions).toEqual(vault.positions);
  },

  'a trade moves the two assets inside the vault and leaves the wallet alone': async (c) => {
    const { sell, buy, amountInRaw } = c.f.ownerTrade;
    const before = await vaultAt(c, c.f.vault);
    const wallet = await c.a.getWalletHoldings(c.f.owner);
    const quote = await c.a.quote(c.f.ownerTrade, c.f.owner);
    const slippageBps = 100;
    const tx = await c.a.buildOwnerSwap({
      vault: c.f.vault,
      trades: [c.f.ownerTrade],
      slippageBps,
    });
    await land(c, tx);
    const after = await vaultAt(c, c.f.vault);
    expect(held(before, sell) - held(after, sell)).toBe(BigInt(amountInRaw));
    const got = held(after, buy) - held(before, buy);
    expect(got).toBe(delta(tx, 'vault', buy));
    expect(got).toBeGreaterThanOrEqual(
      (BigInt(quote.outRaw) * BigInt(10_000 - slippageBps)) / 10_000n,
    );
    expect(await c.a.getWalletHoldings(c.f.owner)).toEqual(wallet);
  },

  'a keeper trade moves the vault toward its target and stamps the asset': async (c) => {
    const { sell, buy, amountInRaw } = c.f.keeperTrade;
    const other = sell === c.cash.id ? buy : sell;
    const before = await vaultAt(c, c.f.vault);
    const tx = await c.a.buildKeeperLeg(c.f.vault, c.f.keeperTrade);
    checkTx(c, tx, 'keeper_leg', c.keeper);
    await land(c, tx);
    const after = await vaultAt(c, c.f.vault);
    expect(held(before, sell) - held(after, sell)).toBe(BigInt(amountInRaw));
    expect(held(after, buy)).toBeGreaterThan(held(before, buy));
    const stamped = after.positions.find((p) => p.asset === other)?.lastKeeperAt ?? null;
    expect(stamped).not.toBeNull();
    expect(stamped).not.toBe(before.positions.find((p) => p.asset === other)?.lastKeeperAt ?? null);
    expect(after.autoFollow).toBe(true);
  },

  'adopting a weights-only version changes the targets and nothing the vault holds': async (c) => {
    if (!c.f.adoptable) return;
    const before = await vaultAt(c, c.f.vault);
    const tx = await c.a.buildAdoptVersion(c.f.vault);
    checkTx(c, tx, 'adopt_version', c.keeper);
    expect(tx.preview.changes).toEqual([]);
    await land(c, tx);
    const after = await vaultAt(c, c.f.vault);
    expect(after.acceptedVersion).toBe(c.activeVersion);
    expect(after.pending).toBeNull();
    for (const t of c.targets)
      expect(after.positions.find((p) => p.asset === t.asset)?.targetBps).toBe(t.weightBps);
    expect(after.positions.map((p) => [p.asset, p.raw])).toEqual(
      before.positions.map((p) => [p.asset, p.raw]),
    );
    await refuses(c.a.buildAdoptVersion(c.f.vault), 'VersionNotEffective');
  },

  'accepting the active version by its number takes its assets, the new one included': async (
    c,
  ) => {
    const { active, pending } = await c.a.getRecipe(c.f.newAssetRecipeId);
    const added = (await vaultAt(c, c.f.newAssetVault)).pending?.newAssets ?? [];
    const tx = await c.a.buildAcceptVersion({
      vault: c.f.newAssetVault,
      recipeOnchainId: c.f.newAssetRecipeId,
      expectedVersion: active.version,
    });
    checkTx(c, tx, 'accept_version', c.f.owner);
    await land(c, tx);
    const after = await vaultAt(c, c.f.newAssetVault);
    expect(after.acceptedVersion).toBe(active.version);
    for (const x of active.components)
      if (x.kind === 'asset')
        expect(after.positions.find((p) => p.asset === x.asset)?.targetBps).toBe(x.weightBps);
    for (const asset of added) expect(after.positions.map((p) => p.asset)).toContain(asset);
    // What waits now is the version that is published and not yet in effect.
    expect(after.pending?.version).toBe(pending?.version);
    expect(after.pending?.effectiveAt).toBe(pending?.effectiveAt);
  },

  'switching auto-follow changes what the vault and the auto-follow list say': async (c) => {
    const on = await c.a.buildSetAutoFollow({ vault: c.f.manualVault, on: true });
    checkTx(c, on, 'set_auto_follow', c.f.owner);
    await land(c, on);
    expect((await vaultAt(c, c.f.manualVault)).autoFollow).toBe(true);
    expect(await c.a.listAutoFollowVaults()).toContain(c.f.manualVault);
    const mine = await c.a.getVaults(c.f.owner);
    expect(mine.find((v) => v.address === c.f.manualVault)?.autoFollow).toBe(true);

    await land(c, await c.a.buildSetAutoFollow({ vault: c.f.manualVault, on: false }));
    expect((await vaultAt(c, c.f.manualVault)).autoFollow).toBe(false);
    expect(await c.a.listAutoFollowVaults()).not.toContain(c.f.manualVault);
  },

  'setting targets stores exactly those, stops following, and switches auto-follow off': async (
    c,
  ) => {
    const [first, second] = c.targets;
    if (!first || !second) throw new Error('the fixture recipe has fewer than two assets');
    const targets = [
      { asset: first.asset, weightBps: 7350 },
      { asset: second.asset, weightBps: 2650 },
    ];
    const tx = await c.a.buildSetTargets({ vault: c.f.newAssetVault, targets });
    checkTx(c, tx, 'set_targets', c.f.owner);
    await land(c, tx);
    const mine = await c.a.getVaults(c.f.owner);
    const after = mine.find((v) => v.address === c.f.newAssetVault);
    const stored = (after?.positions ?? []).filter((p) => p.targetBps > 0);
    expect(new Map(stored.map((p) => [p.asset, p.targetBps]))).toEqual(
      new Map(targets.map((t) => [t.asset, t.weightBps])),
    );
    expect([after?.recipeOnchainId, after?.autoFollow, after?.pending]).toEqual([
      null,
      false,
      null,
    ]);
    expect(await c.a.listAutoFollowVaults()).not.toContain(c.f.newAssetVault);
    await refuses(c.a.buildKeeperLeg(c.f.newAssetVault, c.f.keeperTrade), 'AutoFollowOff');
  },

  'a withdrawal hands every token to the owner, and to nobody else': async (c) => {
    const before = await vaultAt(c, c.f.vault);
    const holdings = [before.cash, ...before.positions].filter((h) => BigInt(h.raw) > 0n);
    expect(holdings.length).toBeGreaterThan(1);
    const wallet = new Map<string, bigint>();
    for (const h of holdings) wallet.set(h.asset, await walletRaw(c, c.f.owner, h.asset));

    for (const tx of await c.a.buildWithdrawInKind({ vault: c.f.vault })) await land(c, tx);

    const after = await vaultAt(c, c.f.vault);
    expect(BigInt(after.cash.raw)).toBe(0n);
    for (const p of after.positions) expect(BigInt(p.raw)).toBe(0n);
    for (const h of holdings)
      expect((await walletRaw(c, c.f.owner, h.asset)) - (wallet.get(h.asset) ?? 0n)).toBe(
        BigInt(h.raw),
      );
    expect(await c.a.getWalletHoldings(c.f.stranger)).toEqual([]);
    expect(await c.a.buildWithdrawInKind({ vault: c.f.vault })).toEqual([]);
  },
});

async function context(setup: () => ContractFixture | Promise<ContractFixture>): Promise<Ctx> {
  const f = await setup();
  const a = f.adapter;
  const assets = await a.listAssets();
  const cash = assets.find((x) => x.cls === 'cash');
  if (!cash) throw new Error('the adapter lists no cash token');
  const vault = await a.getVault(f.vault);
  if (!vault) throw new Error('the fixture vault does not exist');
  const { active } = await a.getRecipe(f.recipeOnchainId);
  const targets = active.components.flatMap((x) =>
    x.kind === 'asset' ? [{ asset: x.asset, weightBps: x.weightBps }] : [],
  );
  return { f, a, assets, cash, keeper: vault.keeper, targets, activeVersion: active.version };
}

/** Registers the contract as vitest cases. */
export function adapterContract(
  name: string,
  setup: () => ContractFixture | Promise<ContractFixture>,
): void {
  describe(`adapter contract: ${name}`, () => {
    let c: Ctx;
    beforeAll(async () => {
      c = await context(setup);
    });
    for (const groupName of new Set(CASES.map((k) => k.group)))
      describe(groupName, () => {
        for (const k of CASES.filter((x) => x.group === groupName)) it(k.name, () => k.run(c));
      });
  });
}

/**
 * Runs the same cases outside vitest's own bookkeeping and reports each one. The self-check uses it to
 * show that a wrong adapter fails.
 */
export async function runContract(
  setup: () => ContractFixture | Promise<ContractFixture>,
): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const c = await context(setup);
  const results: { name: string; passed: boolean; error?: string }[] = [];
  for (const k of CASES) {
    try {
      await k.run(c);
      results.push({ name: k.name, passed: true });
    } catch (e) {
      results.push({
        name: k.name,
        passed: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
