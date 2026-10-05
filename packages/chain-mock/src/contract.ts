import { view } from '@colosseum/basket';
import {
  type Address,
  type AssetId,
  AttemptFate,
  type AttemptRef,
  BasketAsset,
  BuiltTx,
  Capabilities,
  Carried,
  CHAIN_ERROR_RETRYABLE,
  type ChainAdapter,
  ChainError,
  type ChainErrorCode,
  ChainId,
  type ChainReader,
  chainFamily,
  evmCallPreimage,
  Funding,
  Holding,
  isStalePrice,
  type LegKind,
  Price,
  Provenance,
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
import { sha256Hex } from './ids';

// The tests every ChainAdapter must pass (DESIGN-VAULT 3.2). The mock passes them here; the Solana and
// EVM adapters run the same function against a fork.
//
//   import { adapterContract } from '@colosseum/chain-mock/contract';
//   adapterContract('solana, local fork', async () => ({ adapter, send, provenance: 'sandbox', ... }));
//
// The setup function brings the chain to the state `ContractFixture` describes and returns it. The
// cases are in groups, and run in the order written: first everything that only reads and builds, then
// the refusals, then the cases that send a transaction and read the state it left. A fixture is used
// once.
//
// An adapter that has only part of the interface runs the groups it can:
//
//   adapterContract('solana reader', setup, { groups: ['reads'] });
//
// The `reads` group takes a `ReadsFixture`, which asks for a `ChainReader` and no more, and its setup
// reads no shared portfolio and builds nothing.
// `contract.selfcheck.test.ts` runs the same cases against adapters that are wrong on purpose and
// expects them to fail: a case that cannot fail does not belong here.

/** The groups, in the order they run. */
export const CONTRACT_GROUPS = [
  /** What a reader shows of a chain as it stands: assets, prices, vaults, wallets, funding, a status. */
  'reads',
  /** Reads that need the registry: a shared portfolio, its versions, and the vaults that follow it. */
  'shared portfolios',
  'quotes',
  'builds',
  'refusals',
  'signed bytes',
  'state after a transaction lands',
] as const;
export type ContractGroup = (typeof CONTRACT_GROUPS)[number];
/** The groups whose setup reads no shared portfolio: an adapter with no registry behind it can run them. */
const NO_RECIPE: ReadonlySet<ContractGroup> = new Set(['reads', 'quotes']);

export type ContractOptions = {
  /** The groups to run, by name. Left out: all of them. They run in the contract's order either way. */
  groups?: readonly ContractGroup[];
};

/** What the `reads` group needs: an adapter's read side, and the vaults and wallets it is asked about. */
export type ReadsFixture = {
  adapter: ChainReader;
  /** The label everything this adapter returns must carry: 'mock', or 'sandbox' on a test network or a fork. */
  provenance: Provenance;
  /** ISO time. No price, quote or preview is stamped earlier than this. */
  notBefore: string;
  /** A wallet with cash for `depositRaw` twice over and gas for thirty transactions. It owns the three vaults. */
  owner: Address;
  /** A wallet that holds nothing and owns no vault. */
  stranger: Address;
  /**
   * A vault of `owner`: auto-follow on, holding cash and at least one position. In a `ContractFixture`
   * it follows `recipeOnchainId`, and at least one listed asset is not among its positions.
   */
  vault: Address;
  /** A second vault of `owner`: its own targets, auto-follow off, following nothing, holding cash. */
  manualVault: Address;
  /**
   * A third vault of `owner`: auto-follow on, holding cash. In a `ContractFixture` it follows
   * `newAssetRecipeId` at a version before the active one.
   */
  newAssetVault: Address;
  /**
   * What the cases deposit. Where the chain needs approvals, `owner` has approved twice this for
   * `vault`, this once for `manualVault`, and this once for the plan `freshBasketId`.
   */
  depositRaw: RawAmount;
  /** An id in the chain's own format that was never sent. */
  unknownTxId: string;
  /**
   * An asset whose price is older right now than the chain's vault accepts, where the world has one.
   * The reads then hold its price to saying so. Left out, no price may read as stale.
   */
  stalePriced?: AssetId;
  /**
   * An asset whose issuer has scheduled a multiplier that is not in force yet, where the world has
   * one. `vault` has it among its positions, or `owner` holds it. Left out, no holding is expected to
   * show one.
   */
  scheduledAsset?: AssetId;
};

export type ContractFixture = ReadsFixture & {
  adapter: ChainAdapter;
  /**
   * Signs as `tx.signer` (the owner or the keeper), broadcasts, and resolves once the transaction has
   * landed, whether it went through or reverted. It sends what it was given with no check of its own:
   * no preflight on Solana, and the gas limit the transaction states on EVM, so a transaction that
   * will revert still lands. On the mock this is `mock.send`.
   */
  send(tx: BuiltTx): Promise<{ txId: string; validUntil?: string }>;
  /**
   * Moves the price the chain's exchange trades `asset` at by `bps` (up when positive), runs `work`,
   * and puts the price back. It is how a case makes a built trade pay out less than its minimum.
   */
  withPriceMoved(asset: AssetId, bps: number, work: () => Promise<void>): Promise<void>;
  /**
   * Signs as `tx.signer` and hands the signed transaction back, as `WalletPort.sign()` does: base64 of
   * the whole serialized transaction on Solana, the 0x serialized signed transaction on EVM, signed
   * with the nonce and the gas limit the transaction states, as an embedded wallet does. Nothing is
   * sent. On the mock this is `mock.sign`.
   */
  sign(tx: BuiltTx): Promise<string>;
  /**
   * How long a transaction handed to `relay()` may take to land, in milliseconds. `relay` does not
   * wait for the chain, so the cases ask `track` until then. Left out, it is 0: the mock lands at once.
   */
  relayWaitMs?: number;
  /** The slippage the adapter allows for in `quote().minOutRaw`. */
  quoteSlippageBps: number;
  /** A published shared portfolio with no pending version. `owner` is its creator. `vault` follows it. */
  recipeOnchainId: string;
  /** True when a newer version has taken effect and only changes weights, so `vault` can adopt it now. */
  adoptable: boolean;
  /**
   * A shared portfolio whose active version adds an asset to the one `newAssetVault` accepted, and which
   * has a further version published and not yet in effect.
   */
  newAssetRecipeId: string;
  /** A plan id `owner` has not used. */
  freshBasketId: string;
  /** A trade the owner can make inside `vault` now. */
  ownerTrade: Trade;
  /**
   * A trade the keeper can make inside `vault` now: toward a target, ending short of it or inside the
   * band. The vault can afford to take the same asset 2% of its value past the target: the cases size
   * trades that end inside the band and outside it from this one.
   */
  keeperTrade: Trade;
  /** The band the chain's vault allows around a target, in bps (DESIGN-VAULT section 5, check 5). */
  bandBps: number;
  /** A trade in one of `vault`'s assets that moves it away from its target. */
  awayTrade: Trade;
  /**
   * A next version of `recipeOnchainId` that `owner` can publish now: inside the four author limits
   * (DESIGN-VAULT section 6), so three assets or more, and a publish delay after the last version.
   */
  publishRecipe: Recipe;
};

/** What a case of the `reads` group is handed: a reader and nothing a builder or a registry gives. */
type ReadCtx = { f: ReadsFixture; a: ChainReader; assets: BasketAsset[]; cash: BasketAsset };
type Ctx = ReadCtx & {
  f: ContractFixture;
  a: ChainAdapter;
  keeper: Address;
  /** The active version of the fixture recipe, as targets. */
  targets: Target[];
  activeVersion: number;
};
type Case = { group: ContractGroup; name: string; run(c: Ctx): Promise<void> };

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
  // The hash is the family's, worked out here from the bytes: not a rule of the adapter's own.
  expect(tx.messageHash, 'messageHash by the rule of basket-tx.ts').toBe(hashByRule(tx));
  // An EVM transaction states the nonce and the gas limit to sign with.
  if (chainFamily(c.a.chain) === 'evm') {
    expect(Number.isInteger(tx.evm?.nonce) && (tx.evm?.nonce ?? -1) >= 0, 'evm.nonce').toBe(true);
    expect(tx.evm?.gas ?? 0, 'evm.gas').toBeGreaterThanOrEqual(21_000);
  }
}
/**
 * A transaction's message hash as basket-tx.ts defines it for its family, from its own bytes. Solana:
 * the SHA-256 of the serialized transaction less its signatures (a count, then 64 bytes each). EVM:
 * the SHA-256 of `evmCallPreimage` over the chain id, the signer, the target, the value and the data.
 */
function hashByRule(tx: BuiltTx): string {
  if (tx.chain === 'evm')
    return sha256Hex(
      evmCallPreimage({
        chainId: tx.evm?.chainId ?? -1,
        signer: tx.signer,
        to: tx.evm?.to ?? '',
        value: tx.evm?.value ?? '',
        data: tx.payload,
      }),
    );
  const bytes = Buffer.from(tx.payload, 'base64');
  // The count of signatures is a compact-u16: seven bits a byte, the high bit says another follows.
  let [count, at, shift] = [0, 0, 0];
  for (;;) {
    const byte = bytes[at] ?? 0;
    at += 1;
    count |= (byte & 0x7f) << shift;
    if (!(byte & 0x80) || at >= 3) break;
    shift += 7;
  }
  return sha256Hex(bytes.subarray(at + 64 * count));
}
/** An attempt as the order layer would store it for a transaction it had built. */
const attemptOf = (tx: BuiltTx): AttemptRef => ({
  messageHash: tx.messageHash,
  signer: tx.signer,
  validUntil: tx.lastValidBlockHeight === undefined ? null : String(tx.lastValidBlockHeight),
  nonce: tx.evm?.nonce ?? null,
});
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
  // Whether to try again is the code's own answer, the same from every adapter.
  expect((outcome as ChainError).retryable, `${code} retryable`).toBe(CHAIN_ERROR_RETRYABLE[code]);
}

async function vaultAt(c: ReadCtx, address: Address): Promise<VaultState> {
  const v = await c.a.getVault(address);
  if (!v) throw new Error(`no vault at ${address}`);
  return v;
}
const held = (v: VaultState, asset: string) =>
  BigInt(
    asset === v.cash.asset ? v.cash.raw : (v.positions.find((p) => p.asset === asset)?.raw ?? 0),
  );
async function walletRaw(c: ReadCtx, owner: Address, asset: string): Promise<bigint> {
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
/** A relay does not wait for the chain: asks until the transaction is no longer pending, or time is up. */
async function settled(c: Ctx, txId: string, validUntil?: string): Promise<TxStatus> {
  const until = Date.now() + (c.f.relayWaitMs ?? 0);
  for (;;) {
    const status = exact(TxStatus, await c.a.track(txId, validUntil));
    if (status.status !== 'pending' || Date.now() >= until) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
/** The same signed bytes with the last one changed: base64 on Solana, 0x hex on EVM. */
function altered(c: Ctx, signed: string): string {
  if (chainFamily(c.a.chain) === 'evm')
    return `${signed.slice(0, -1)}${signed.endsWith('0') ? '1' : '0'}`;
  const bytes = Buffer.from(signed, 'base64');
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return bytes.toString('base64');
}
/** What a refusal was, or 'answered' when there was none. */
const outcomeOf = (work: Promise<unknown>) =>
  work.then(
    () => 'answered' as const,
    (e: unknown) => e,
  );

/**
 * The fixture's keeper trade, sized so the asset ends `pastBps` beyond its target on the far side: over
 * it for a purchase, under it for a sale. Weights are as the vault counts them: a share of everything
 * it holds, cash at one dollar. Sized at the reference prices, so a trade's cost leaves it a little
 * short of the figure; the cases keep clear of the band's edge by more than that.
 */
async function keeperTradePast(c: Ctx, pastBps: number): Promise<Trade> {
  const { sell, buy } = c.f.keeperTrade;
  const buying = sell === c.cash.id;
  const other = buying ? buy : sell;
  const state = await vaultAt(c, c.f.vault);
  const seen = view(state, await c.a.getPrices(c.assets.map((x) => x.id)), c.assets);
  const position = seen.positions.find((p) => p.asset === other);
  const asset = c.assets.find((x) => x.id === other);
  const price = (await c.a.getPrices([other]))[0];
  if (!position || !asset || !price)
    throw new Error(`${other} is not a priced position of the vault`);
  const total = Number(seen.valueUsd);
  const held = Number(position.valueUsd ?? 0);
  const far = position.targetBps + (buying ? pastBps : -pastBps);
  const usd = buying ? (total * far) / 10_000 - held : held - (total * far) / 10_000;
  if (!(usd > 0)) throw new Error('the fixture vault is not on the near side of that target');
  const raw = buying
    ? usd * 10 ** c.cash.decimals
    : (usd / Number(price.usdPerToken)) * 10 ** asset.decimals;
  return { sell, buy, amountInRaw: BigInt(Math.floor(raw)).toString() };
}

const CASES: Case[] = [];
const group = (name: ContractGroup, cases: Record<string, (c: Ctx) => Promise<void>>) => {
  for (const [title, run] of Object.entries(cases)) CASES.push({ group: name, name: title, run });
};
/** A group whose cases see a reader only: the type keeps a builder and the registry out of them. */
const readerGroup = (name: 'reads', cases: Record<string, (c: ReadCtx) => Promise<void>>) =>
  group(name, cases);

readerGroup('reads', {
  'names its chain, its capabilities and the label on its figures': async ({ a, f }) => {
    ChainId.parse(a.chain);
    exact(Capabilities, a.capabilities);
    // The adapter says itself what everything it returns is labelled.
    expect(Provenance.parse(a.provenance)).toBe(f.provenance);
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
        // Its age, and the age past which the chain's vault no longer trades on it.
        expect(Number.isInteger(p.maxAgeSeconds) && p.maxAgeSeconds > 0).toBe(true);
        // The dollar token is worth about a dollar wherever it has a price at all.
        if (p.asset === c.cash.id) expect(Math.abs(Number(p.usdPerToken) - 1)).toBeLessThan(0.1);
      }
      // A price older than the chain's limit is still handed over, and says of itself that it is
      // stale. Where the fixture names none, none is. (On a running clock the others age too, so
      // nothing is said of them where one is named.)
      const stale = prices.filter((p) => isStalePrice(p)).map((p) => p.asset);
      if (c.f.stalePriced) expect(stale).toContain(c.f.stalePriced);
      else expect(stale).toEqual([]);
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
    expect(following.autoFollow).toBe(true);
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
    // A multiplier the issuer has scheduled shows beside the one in force, on that asset alone.
    const scheduled = holdings.filter((h) => h.scheduled !== undefined);
    expect([...new Set(scheduled.map((h) => h.asset))]).toEqual(
      c.f.scheduledAsset ? [c.f.scheduledAsset] : [],
    );
    for (const h of scheduled) {
      expect(Number(h.scheduled?.multiplier)).toBeGreaterThan(0);
      expect(h.scheduled?.effectiveAt).toBeGreaterThan(Date.parse(c.f.notBefore) / 1000);
    }
  },

  'stores targets that add up to at most 10,000, and to exactly that when it follows, on listed assets, never on cash':
    async (c) => {
      for (const address of [c.f.vault, c.f.manualVault, c.f.newAssetVault]) {
        const vault = await vaultAt(c, address);
        // A person's own targets may leave a share in cash; a shared portfolio is always the whole.
        const sum = vault.positions.reduce((n, p) => n + p.targetBps, 0);
        expect(sum).toBeGreaterThan(0);
        expect(sum).toBeLessThanOrEqual(10_000);
        if (vault.recipeOnchainId !== null) expect(sum).toBe(10_000);
        for (const p of vault.positions) expect(p.targetBps).toBeGreaterThanOrEqual(0);
        expect(BigInt(vault.cash.raw)).toBeGreaterThan(0n);
        expect(vault.cash.asset).toBe(c.cash.id);
        for (const p of vault.positions) expect(p.asset).not.toBe(c.cash.id);
      }
      const vault = await vaultAt(c, c.f.vault);
      expect(vault.positions.some((p) => BigInt(p.raw) > 0n)).toBe(true);
    },

  'lists exactly the vaults with auto-follow on': async (c) => {
    const all = await c.a.listAutoFollowVaults();
    expect(all).toContain(c.f.vault);
    expect(all).toContain(c.f.newAssetVault);
    expect(all).not.toContain(c.f.manualVault);
    expect(new Set(all).size).toBe(all.length);
    for (const address of all) expect((await vaultAt(c, address)).autoFollow).toBe(true);
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
    // Told how many accounts the steps open, it never asks for more than when it has to assume.
    const none = exact(Funding, await c.a.funding(c.f.owner, { ...need, newAccounts: 0 }));
    const some = await c.a.funding(c.f.owner, { ...need, newAccounts: 2 });
    expect(BigInt(none.gasNeedRaw)).toBeLessThanOrEqual(BigInt(owner.gasNeedRaw));
    expect(BigInt(some.gasNeedRaw)).toBeGreaterThanOrEqual(BigInt(none.gasNeedRaw));
    expect(BigInt(none.gasNeedRaw)).toBeGreaterThan(0n);
  },

  'tracks an id it has never seen as pending or expired, never as landed': async (c) => {
    const s = exact(TxStatus, await c.a.track(c.f.unknownTxId));
    expect(['pending', 'expired']).toContain(s.status);
  },
});

group('shared portfolios', {
  'a vault that follows names the shared portfolio it follows': async (c) => {
    const following = await vaultAt(c, c.f.vault);
    expect([following.autoFollow, following.recipeOnchainId]).toEqual([true, c.f.recipeOnchainId]);
  },

  'filters the auto-follow list by the shared portfolio a vault follows': async (c) => {
    const followers = await c.a.listAutoFollowVaults(c.f.recipeOnchainId);
    expect(followers).toContain(c.f.vault);
    expect(followers).not.toContain(c.f.newAssetVault);
    for (const address of followers)
      expect((await vaultAt(c, address)).recipeOnchainId).toBe(c.f.recipeOnchainId);
  },

  'reads a recipe: the active version, and a pending one with a number above it': async (c) => {
    const { active, pending } = await c.a.getRecipe(c.f.recipeOnchainId);
    exact(Recipe, active);
    expect(active.onchainId).toBe(c.f.recipeOnchainId);
    expect(active.chain).toBe(c.a.chain);
    expect(pending).toBeNull();
    expect((await vaultAt(c, c.f.vault)).acceptedVersion).toBeLessThanOrEqual(active.version);

    const other = await c.a.getRecipe(c.f.newAssetRecipeId);
    exact(Recipe, other.active);
    const next = exact(Recipe.nullable(), other.pending);
    // Above the active one, and not always by one: a cancelled version keeps its number for good.
    expect(next?.version).toBeGreaterThan(other.active.version);
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
});

group('quotes', {
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
});

group('builds', {
  'approves cash for a plan where the chain needs it, and refuses where it does not': async (c) => {
    // The caller names the plan. Who may take the cash is the adapter's to work out.
    const args = { owner: c.f.owner, basketId: c.f.freshBasketId, amountRaw: c.f.depositRaw };
    if (!c.a.capabilities.needsApprove) {
      await refuses(c.a.buildApprove(args), 'NotSupported');
      return;
    }
    const tx = await c.a.buildApprove(args);
    checkTx(c, tx, 'approve', c.f.owner);
    // An approval is a call to the cash token, and moves nothing.
    expect(tx.evm?.to).toBe(c.cash.address);
    expect(tx.preview.changes).toEqual([]);
    const used = (await vaultAt(c, c.f.vault)).basketId;
    checkTx(c, await c.a.buildApprove({ ...args, basketId: used }), 'approve', c.f.owner);
    const named = { ...args, spender: c.f.stranger };
    await refuses(c.a.buildApprove(named), 'BadInput');
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
    expect(tx.preview.minimums.map((m) => [m.sell, m.buy, m.inRaw])).toEqual([
      [c.cash.id, first.asset, c.f.depositRaw],
    ]);
  },

  'previews a deposit as cash leaving the wallet for the vault, and nothing else': async (c) => {
    const tx = await c.a.buildDeposit({
      vault: c.f.vault,
      amountRaw: c.f.depositRaw,
      slippageBps: 100,
    });
    checkTx(c, tx, 'deposit', c.f.owner);
    expect(tx.preview.minimums).toEqual([]);
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

  'states the least each trade accepts, one entry per trade and in their order': async (c) => {
    const { sell, buy, amountInRaw } = c.f.ownerTrade;
    const half = { sell, buy, amountInRaw: (BigInt(amountInRaw) / 2n).toString() };
    // As many trades as one transaction takes here: two where the chain allows, one where it does not.
    const trades = c.a.capabilities.maxTradesPerTx > 1 ? [half, half] : [c.f.ownerTrade];
    const slippageBps = 100;
    const tx = await c.a.buildOwnerSwap({ vault: c.f.vault, trades, slippageBps });
    const { minimums } = tx.preview;
    expect(minimums.map((m) => [m.sell, m.buy, m.inRaw])).toEqual(
      trades.map((t) => [t.sell, t.buy, t.amountInRaw]),
    );
    const out = delta(tx, 'vault', buy);
    const least = minimums.reduce((n, m) => n + BigInt(m.minOutRaw), 0n);
    for (const m of minimums) expect(BigInt(m.minOutRaw)).toBeGreaterThan(0n);
    // A floor under what the simulation paid out, and no further under it than twice the slippage.
    expect(least).toBeLessThanOrEqual(out);
    expect(least).toBeGreaterThanOrEqual((out * BigInt(10_000 - 2 * slippageBps)) / 10_000n);
    // A tighter slippage is a higher floor.
    const tight = await c.a.buildOwnerSwap({ vault: c.f.vault, trades, slippageBps: 0 });
    const tightLeast = tight.preview.minimums.reduce((n, m) => n + BigInt(m.minOutRaw), 0n);
    expect(tightLeast).toBeGreaterThan(least);
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

  'lets the keeper end inside the band, short of the target or a little past it': async (c) => {
    expect(c.f.bandBps).toBeGreaterThan(0);
    // Half a band short, on the target, and half a band past it: all three are where a leg may end.
    for (const past of [-c.f.bandBps / 2, 0, c.f.bandBps / 2]) {
      const tx = await c.a.buildKeeperLeg(c.f.vault, await keeperTradePast(c, past));
      checkTx(c, tx, 'keeper_leg', c.keeper);
    }
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
    // Over the whole, by one basis point. Under it is allowed: the rest is the plan's cash share.
    const over = [first, { ...second, weightBps: 10_000 - first.weightBps + 1 }];
    await refuses(c.a.buildSetTargets({ vault, targets: over }), 'BadInput');
    const nothing = [first, { ...second, weightBps: 0 }];
    await refuses(c.a.buildSetTargets({ vault, targets: nothing }), 'BadInput');
    const twice = [
      { asset: first.asset, weightBps: 5000 },
      { asset: first.asset, weightBps: 5000 },
    ];
    await refuses(c.a.buildSetTargets({ vault, targets: twice }), 'BadInput');
    const sameSide = { sell: c.cash.id, buy: c.cash.id, amountInRaw: '1' };
    await refuses(c.a.buildOwnerSwap({ vault, trades: [sameSide], slippageBps: 100 }), 'BadInput');
    if (c.a.capabilities.needsApprove)
      await refuses(
        c.a.buildApprove({ owner: c.f.owner, basketId: c.f.freshBasketId, amountRaw: '1.5' }),
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

  'the keeper, past a target by more than the band: PastTarget': async (c) => {
    // Three bands past the target, and 2% of the vault past it: both end outside the band.
    for (const past of [3 * c.f.bandBps, Math.max(200, 3 * c.f.bandBps)])
      await refuses(c.a.buildKeeperLeg(c.f.vault, await keeperTradePast(c, past)), 'PastTarget');
  },

  'a shared portfolio outside the author limits: CreatorLimit': async (c) => {
    const [first, second, ...rest] = c.f.publishRecipe.components;
    if (!first || !second || rest.length === 0)
      throw new Error('the fixture recipe has fewer than three assets');
    const publish = (recipe: Recipe) => c.a.buildPublishRecipe({ creator: recipe.creator, recipe });
    // Two assets, where three is the fewest.
    const two = [first, second].map((x) => ({ ...x, weightBps: 5000 }));
    await refuses(publish({ ...c.f.publishRecipe, components: two }), 'CreatorLimit');
    // Half a step moved from one asset to another: weights go in steps of 50 bps.
    const offStep = [
      { ...first, weightBps: first.weightBps - 25 },
      { ...second, weightBps: second.weightBps + 25 },
      ...rest,
    ];
    await refuses(publish({ ...c.f.publishRecipe, components: offStep }), 'CreatorLimit');
    // A version on top of one that is published and not yet in effect, with nothing changed.
    const { active } = await c.a.getRecipe(c.f.newAssetRecipeId);
    const again = {
      ...c.f.publishRecipe,
      familyId: active.familyId,
      creator: active.creator,
      components: active.components,
    };
    await refuses(publish(again), 'CreatorLimit');
  },

  'a nonce on a chain that has none: NotSupported': async (c) => {
    if (chainFamily(c.a.chain) === 'evm') return;
    await refuses(
      c.a.buildSetAutoFollow({ vault: c.f.manualVault, on: true, nonce: 0 }),
      'NotSupported',
    );
    await refuses(
      c.a.buildDeposit({ vault: c.f.vault, amountRaw: '1', slippageBps: 100, nonce: 3 }),
      'NotSupported',
    );
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

group('signed bytes', {
  'reads the hash it built back from the signed bytes, relays them, and finds them on the chain':
    async (c) => {
      const amount = BigInt(c.f.depositRaw) / 4n;
      const before = await vaultAt(c, c.f.vault);
      const tx = await c.a.buildDeposit({
        vault: c.f.vault,
        amountRaw: amount.toString(),
        slippageBps: 100,
      });
      const attempt = attemptOf(tx);
      // Built and not sent: it can still land.
      expect(exact(AttemptFate, await c.a.fate(attempt))).toEqual({ state: 'open' });

      const signed = await c.f.sign(tx);
      // Signing changes the signature and not the message.
      expect(await c.a.messageHashOf(signed)).toBe(tx.messageHash);
      const { txId, validUntil } = await c.a.relay(signed);
      expect((await settled(c, txId, validUntil)).status).toBe('confirmed');
      expect(BigInt((await vaultAt(c, c.f.vault)).cash.raw) - BigInt(before.cash.raw)).toBe(amount);

      expect(await c.a.carries(txId, tx.messageHash)).toBe('this');
      expect(exact(AttemptFate, await c.a.fate(attempt))).toEqual({ state: 'landed', txId });
      // The nonce of record is in the signed bytes and on the transaction the chain has: the one the
      // build stated, since the fixture signs with it. Solana has none.
      const nonce = chainFamily(c.a.chain) === 'evm' ? (tx.evm?.nonce ?? null) : null;
      expect(await c.a.nonceOf({ signedTx: signed })).toBe(nonce);
      expect(await c.a.nonceOf({ txId })).toBe(nonce);
      expect(await c.a.nonceOf({ txId: c.f.unknownTxId })).toBeNull();

      // The same bytes a second time land nothing more, whether the adapter answers or refuses.
      const again = await outcomeOf(c.a.relay(signed));
      if (again !== 'answered') expect(again).toBeInstanceOf(ChainError);
      expect(BigInt((await vaultAt(c, c.f.vault)).cash.raw) - BigInt(before.cash.raw)).toBe(amount);
    },

  'does not take altered bytes for the ones it built, and lands nothing when asked to relay them':
    async (c) => {
      const before = await vaultAt(c, c.f.vault);
      const wallet = await walletRaw(c, c.f.owner, c.cash.id);
      const tx = await c.a.buildDeposit({
        vault: c.f.vault,
        amountRaw: (BigInt(c.f.depositRaw) / 4n).toString(),
        slippageBps: 100,
      });
      const wrong = altered(c, await c.f.sign(tx));
      // Either it cannot be read at all, or it is another message.
      const hash = await outcomeOf(
        c.a.messageHashOf(wrong).then((h) => expect(h).not.toBe(tx.messageHash)),
      );
      if (hash !== 'answered') {
        expect(hash).toBeInstanceOf(ChainError);
        expect((hash as ChainError).code).toBe('BadInput');
      }
      const relayed = await outcomeOf(c.a.relay(wrong));
      expect(relayed, 'altered bytes are refused').toBeInstanceOf(ChainError);
      expect(await vaultAt(c, c.f.vault)).toEqual({ ...before, observedAt: expect.any(String) });
      expect(await walletRaw(c, c.f.owner, c.cash.id)).toBe(wallet);
    },

  'says of a transaction whether it is this call, another call, or one the chain has not seen':
    async (c) => {
      const [one, other] = [
        await c.a.buildSetAutoFollow({ vault: c.f.manualVault, on: false }),
        await c.a.buildSetAutoFollow({ vault: c.f.vault, on: true }),
      ];
      expect(one.messageHash).not.toBe(other.messageHash);
      const { txId } = await c.f.send(one);
      expect(Carried.parse(await c.a.carries(txId, one.messageHash))).toBe('this');
      // The wallet sent it itself and nobody reported it: the adapter finds it on the chain, not in a
      // memory of what it relayed.
      expect(await c.a.fate(attemptOf(one))).toEqual({ state: 'landed', txId });
      // An unrelated transaction of the same wallet does not stand for another step.
      expect(await c.a.carries(txId, other.messageHash)).toBe('another');
      // An id the chain never saw is neither: it may yet arrive, and the caller asks again.
      expect(await c.a.carries(c.f.unknownTxId, one.messageHash)).toBe('unseen');
      expect(await c.a.carries(c.f.unknownTxId, other.messageHash)).toBe('unseen');
    },

  "does not take one wallet's transaction for the same call by another wallet": async (c) => {
    if (!c.a.capabilities.needsApprove) return;
    // The same approval, for the same plan id and amount, by two wallets: the call data is the same
    // and the signer is not. The keeper is the second wallet: it can pay for a simulation.
    const approval = { basketId: c.f.freshBasketId, amountRaw: c.f.depositRaw };
    const [mine, theirs] = [
      await c.a.buildApprove({ owner: c.f.owner, ...approval }),
      await c.a.buildApprove({ owner: c.keeper, ...approval }),
    ];
    expect(theirs.signer).toBe(c.keeper);
    expect(theirs.messageHash).not.toBe(mine.messageHash);
    const { txId } = await c.f.send(mine);
    expect(await c.a.carries(txId, mine.messageHash)).toBe('this');
    expect(await c.a.carries(txId, theirs.messageHash)).toBe('another');
  },

  'two calls built on one nonce: one lands, and the other is gone': async (c) => {
    if (chainFamily(c.a.chain) !== 'evm') return;
    // Neither changes anything: the first vault is already off, the second already on.
    const [one, other] = [
      await c.a.buildSetAutoFollow({ vault: c.f.manualVault, on: false }),
      await c.a.buildSetAutoFollow({ vault: c.f.vault, on: true }),
    ];
    // Both are built on the signer's next nonce: the chain has not moved between them.
    expect(other.evm?.nonce).toBe(one.evm?.nonce);
    expect(await c.a.fate(attemptOf(other))).toEqual({ state: 'open' });
    const { txId } = await c.f.send(one);
    expect(await c.a.fate(attemptOf(one))).toEqual({ state: 'landed', txId });
    // Another call used the nonce, so this one can never land: nothing is left to wait for.
    expect(exact(AttemptFate, await c.a.fate(attemptOf(other)))).toEqual({ state: 'gone' });

    // A rebuild is given the nonce of the attempt that is still open, and states it. The hash is of
    // the call alone, so the same call on any nonce has the same hash.
    const open = await c.a.buildSetAutoFollow({ vault: c.f.vault, on: true });
    expect(open.evm?.nonce).toBe((one.evm?.nonce ?? 0) + 1);
    const nonce = (open.evm?.nonce ?? 0) + 3;
    const rebuilt = await c.a.buildSetAutoFollow({ vault: c.f.vault, on: true, nonce });
    expect(rebuilt.evm?.nonce).toBe(nonce);
    expect(rebuilt.messageHash).toBe(open.messageHash);
  },

  'the same call built again is its own attempt: open, not landed because the first one did':
    async (c) => {
      if (chainFamily(c.a.chain) !== 'evm') return;
      const deposit = {
        vault: c.f.vault,
        amountRaw: (BigInt(c.f.depositRaw) / 8n).toString(),
        slippageBps: 100,
      };
      const first = await c.a.buildDeposit(deposit);
      const { txId } = await c.f.send(first);
      // An identical deposit, as a second order of the same person would build it.
      const second = await c.a.buildDeposit(deposit);
      expect(second.messageHash).toBe(first.messageHash);
      expect(second.evm?.nonce).toBe((first.evm?.nonce ?? 0) + 1);
      expect(await c.a.fate(attemptOf(first))).toEqual({ state: 'landed', txId });
      // Told apart by the nonce: the second has not been sent, and can still land.
      expect(await c.a.fate(attemptOf(second))).toEqual({ state: 'open' });
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

  "a price that moves past a trade's minimum reverts it, and the transaction is tracked as reverted":
    async (c) => {
      const trade = c.f.ownerTrade;
      const buying = trade.sell === c.cash.id;
      const before = await vaultAt(c, c.f.vault);
      const tx = await c.a.buildOwnerSwap({ vault: c.f.vault, trades: [trade], slippageBps: 50 });
      expect(BigInt(tx.preview.minimums[0]?.minOutRaw ?? 0)).toBeGreaterThan(0n);
      // After the build the price moves 3% against the trade: six times the slippage it was built
      // with. The minimum is in the bytes, so the transaction lands and reverts.
      let status: TxStatus | undefined;
      await c.f.withPriceMoved(buying ? trade.buy : trade.sell, buying ? 300 : -300, async () => {
        const { txId, validUntil } = await c.f.send(tx);
        status = exact(TxStatus, await c.a.track(txId, validUntil));
      });
      expect(status?.status).toBe('reverted');
      expect(status?.error?.code).toBe('ReceivedTooLittle');
      expect(status?.error?.message.length).toBeGreaterThan(0);
      // Nothing moved.
      const after = await vaultAt(c, c.f.vault);
      expect([after.cash.raw, after.positions.map((p) => [p.asset, p.raw])]).toEqual([
        before.cash.raw,
        before.positions.map((p) => [p.asset, p.raw]),
      ]);
    },

  'a keeper trade moves the vault toward its target and stamps the asset': async (c) => {
    const { sell, buy, amountInRaw } = c.f.keeperTrade;
    const other = sell === c.cash.id ? buy : sell;
    const before = await vaultAt(c, c.f.vault);
    const tx = await c.a.buildKeeperLeg(c.f.vault, c.f.keeperTrade);
    checkTx(c, tx, 'keeper_leg', c.keeper);
    // A keeper leg states a minimum only where its bytes carry one: EVM's keeperSwap takes minOut,
    // Solana's keeper_leg takes none and the program works it out.
    if (chainFamily(c.a.chain) === 'evm') {
      expect(tx.preview.minimums.map((m) => [m.sell, m.buy, m.inRaw])).toEqual([
        [sell, buy, amountInRaw],
      ]);
      expect(BigInt(tx.preview.minimums[0]?.minOutRaw ?? 0)).toBeGreaterThan(0n);
    } else expect(tx.preview.minimums).toEqual([]);
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

  'targets that leave a share in cash are stored as they are: at most 10,000, not exactly': async (
    c,
  ) => {
    const [first, second] = c.targets;
    if (!first || !second) throw new Error('the fixture recipe has fewer than two assets');
    // 85% in two assets: the other 15% is the plan's cash share, and no asset is given it.
    const targets = [
      { asset: first.asset, weightBps: 6000 },
      { asset: second.asset, weightBps: 2500 },
    ];
    const tx = await c.a.buildSetTargets({ vault: c.f.manualVault, targets });
    checkTx(c, tx, 'set_targets', c.f.owner);
    await land(c, tx);
    const after = await vaultAt(c, c.f.manualVault);
    const stored = after.positions.filter((p) => p.targetBps > 0);
    expect(new Map(stored.map((p) => [p.asset, p.targetBps]))).toEqual(
      new Map(targets.map((t) => [t.asset, t.weightBps])),
    );
    expect(after.positions.reduce((n, p) => n + p.targetBps, 0)).toBe(8500);
    expect(after.positions.map((p) => p.asset)).not.toContain(c.cash.id);
  },

  'an approval is for the plan it names: its vault takes that much, and no more': async (c) => {
    if (!c.a.capabilities.needsApprove) return;
    const manual = await vaultAt(c, c.f.manualVault);
    const amount = BigInt(c.f.depositRaw) / 8n;
    const deposit = (raw: bigint) =>
      c.a.buildDeposit({ vault: c.f.manualVault, amountRaw: raw.toString(), slippageBps: 100 });
    // An approval replaces the one before it: after this the plan's vault may take exactly `amount`.
    const approve = await c.a.buildApprove({
      owner: c.f.owner,
      basketId: manual.basketId,
      amountRaw: amount.toString(),
    });
    await land(c, approve);
    await refuses(deposit(amount + 1n), 'AllowanceTooLow');
    await land(c, await deposit(amount));
    const after = await vaultAt(c, c.f.manualVault);
    expect(BigInt(after.cash.raw) - BigInt(manual.cash.raw)).toBe(amount);
    // Spent by what was deposited.
    await refuses(deposit(1n), 'AllowanceTooLow');
  },

  'opening a vault stores the targets and the switch it was asked for, and takes its first deposit':
    async (c) => {
      const [first, second] = c.targets;
      if (!first || !second) throw new Error('the fixture recipe has fewer than two assets');
      // Two weights that are not each other's, and a share left in cash.
      const targets = [
        { asset: first.asset, weightBps: 6100 },
        { asset: second.asset, weightBps: 2400 },
      ];
      const amount = BigInt(c.f.depositRaw) / 8n;
      const args = {
        owner: c.f.owner,
        basketId: c.f.freshBasketId,
        targets,
        autoFollow: false,
        depositRaw: amount.toString(),
        slippageBps: 100,
      };
      if (c.a.capabilities.needsApprove) {
        // No vault yet. The approval for this plan is to the address its vault will have, and the vault
        // spends it as it is opened. It is for twice `amount`: the create takes half, and the other half
        // is shown further down to be the same vault's.
        const approve = { owner: c.f.owner, basketId: c.f.freshBasketId };
        await land(c, await c.a.buildApprove({ ...approve, amountRaw: (amount * 2n).toString() }));
        await refuses(
          c.a.buildCreateVault({ ...args, depositRaw: (amount * 2n + 1n).toString() }),
          'AllowanceTooLow',
        );
      }
      const wallet = await walletRaw(c, c.f.owner, c.cash.id);
      const tx = await c.a.buildCreateVault(args);
      checkTx(c, tx, 'create_vault', c.f.owner);
      await land(c, tx);

      const opened = (await c.a.getVaults(c.f.owner)).find((v) => v.basketId === c.f.freshBasketId);
      if (!opened) throw new Error('the owner does not list the vault that was opened');
      expect([opened.owner, opened.autoFollow, opened.recipeOnchainId, opened.pending]).toEqual([
        c.f.owner,
        false,
        null,
        null,
      ]);
      const stored = opened.positions.filter((p) => p.targetBps > 0);
      expect(new Map(stored.map((p) => [p.asset, p.targetBps]))).toEqual(
        new Map(targets.map((t) => [t.asset, t.weightBps])),
      );
      expect(BigInt(opened.cash.raw)).toBe(amount);
      for (const p of opened.positions) expect(BigInt(p.raw)).toBe(0n);
      expect(wallet - (await walletRaw(c, c.f.owner, c.cash.id))).toBe(amount);
      expect(await c.a.listAutoFollowVaults()).not.toContain(opened.address);
      expect(exact(VaultState.nullable(), await c.a.getVault(opened.address))?.basketId).toBe(
        c.f.freshBasketId,
      );
      // The plan id is used now.
      await refuses(c.a.buildCreateVault(args), 'VaultExists');
      if (c.a.capabilities.needsApprove) {
        // What the create left of the approval made before the vault existed is the vault's: a deposit
        // takes it with no second approval, and not one unit more. Had the first approval gone to
        // anyone else, the factory included, this deposit would find nothing to take.
        const deposit = (raw: bigint) =>
          c.a.buildDeposit({ vault: opened.address, amountRaw: raw.toString(), slippageBps: 100 });
        await refuses(deposit(amount + 1n), 'AllowanceTooLow');
        await land(c, await deposit(amount));
        expect(BigInt((await vaultAt(c, opened.address)).cash.raw)).toBe(amount * 2n);
        await refuses(deposit(1n), 'AllowanceTooLow');
      }
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

  'publishing a version makes it the one that waits, with the weights that were sent': async (
    c,
  ) => {
    const before = await c.a.getRecipe(c.f.recipeOnchainId);
    expect(before.pending).toBeNull();
    const tx = await c.a.buildPublishRecipe({ creator: c.f.owner, recipe: c.f.publishRecipe });
    checkTx(c, tx, 'publish', c.f.owner);
    expect(tx.preview.changes).toEqual([]);
    await land(c, tx);
    const { active, pending } = await c.a.getRecipe(c.f.recipeOnchainId);
    // The version in effect is untouched; the new one waits its delay.
    expect(active).toEqual(before.active);
    const waiting = exact(Recipe.nullable(), pending);
    // A number is never used twice, so it is above the active one and need not be the next after it.
    expect(waiting?.version).toBeGreaterThan(active.version);
    expect(waiting?.effectiveAt).toBeGreaterThan(active.effectiveAt);
    expect(waiting?.components).toEqual(c.f.publishRecipe.components);
    expect([waiting?.creator, waiting?.onchainId]).toEqual([c.f.owner, c.f.recipeOnchainId]);
    // One version at a time: a second cannot be published while this one waits.
    await refuses(
      c.a.buildPublishRecipe({ creator: c.f.owner, recipe: c.f.publishRecipe }),
      'CreatorLimit',
    );
  },
});

type Setup<F> = () => F | Promise<F>;

/** The groups asked for, in the contract's order. A name that is no group is a mistake, not an empty run. */
function selected(options: ContractOptions): ContractGroup[] {
  for (const name of options.groups ?? [])
    if (!CONTRACT_GROUPS.includes(name))
      throw new Error(`the contract has no group called ${name}`);
  return CONTRACT_GROUPS.filter((g) => !options.groups || options.groups.includes(g));
}

/**
 * What the cases are handed. The fixture's shared portfolio is read only when a selected group needs
 * it, so an adapter with only its read side, or with no registry yet, can run the groups that do not.
 */
async function context(setup: Setup<ReadsFixture>, groups: ContractGroup[]): Promise<Ctx> {
  const f = await setup();
  const a = f.adapter;
  const assets = await a.listAssets();
  const cash = assets.find((x) => x.cls === 'cash');
  if (!cash) throw new Error('the adapter lists no cash token');
  const read: ReadCtx = { f, a, assets, cash };
  // No selected group looks at a recipe, a keeper or a builder: the reader's context is all they see.
  if (groups.every((g) => NO_RECIPE.has(g))) return read as Ctx;
  const full = f as ContractFixture;
  const vault = await a.getVault(full.vault);
  if (!vault) throw new Error('the fixture vault does not exist');
  const { active } = await a.getRecipe(full.recipeOnchainId);
  const targets = active.components.flatMap((x) =>
    x.kind === 'asset' ? [{ asset: x.asset, weightBps: x.weightBps }] : [],
  );
  return {
    ...read,
    f: full,
    a: full.adapter,
    keeper: vault.keeper,
    targets,
    activeVersion: active.version,
  };
}

/**
 * Registers the contract as vitest cases. With `groups`, only those; the `reads` group alone takes a
 * `ReadsFixture`, which an adapter with only its read side can give.
 */
export function adapterContract(
  name: string,
  setup: Setup<ReadsFixture>,
  options: { groups: readonly ['reads'] },
): void;
export function adapterContract(
  name: string,
  setup: Setup<ContractFixture>,
  options?: ContractOptions,
): void;
export function adapterContract(
  name: string,
  setup: Setup<ReadsFixture>,
  options: ContractOptions = {},
): void {
  const groups = selected(options);
  describe(`adapter contract: ${name}`, () => {
    let c: Ctx;
    beforeAll(async () => {
      c = await context(setup, groups);
    });
    for (const groupName of groups)
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
  setup: Setup<ReadsFixture>,
  options: { groups: readonly ['reads'] },
): Promise<{ name: string; passed: boolean; error?: string }[]>;
export async function runContract(
  setup: Setup<ContractFixture>,
  options?: ContractOptions,
): Promise<{ name: string; passed: boolean; error?: string }[]>;
export async function runContract(
  setup: Setup<ReadsFixture>,
  options: ContractOptions = {},
): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const groups = selected(options);
  const c = await context(setup, groups);
  const results: { name: string; passed: boolean; error?: string }[] = [];
  for (const k of CASES.filter((x) => groups.includes(x.group))) {
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
