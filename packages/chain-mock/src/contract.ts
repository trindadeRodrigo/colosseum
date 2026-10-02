import {
  type Address,
  BasketAsset,
  BasketTx,
  Capabilities,
  type ChainAdapter,
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
// EVM adapters run the same function against a fork. They only read and build: nothing is signed or
// sent, so a fixture is set up once and is the same for every case.
//
//   import { adapterContract } from '@colosseum/chain-mock/contract';
//   adapterContract('solana, local fork', async () => ({ adapter, provenance: 'sandbox', owner, ... }));
//
// The setup function brings the chain to the state `ContractFixture` describes and returns it.

export type ContractFixture = {
  adapter: ChainAdapter;
  /** The label everything this adapter returns must carry: 'mock', or 'sandbox' on a test network or a fork. */
  provenance: Provenance;
  /** A wallet with cash for `depositRaw` and gas for four transactions. It owns `vault`. */
  owner: Address;
  /** A wallet that holds nothing and owns no vault. */
  stranger: Address;
  /** A vault of `owner`: auto-follow on, following `recipeOnchainId`, holding cash and at least one position. */
  vault: Address;
  /** A published shared portfolio. `owner` is its creator. */
  recipeOnchainId: string;
  /** True when a newer version has taken effect and only changes weights, so `vault` can adopt it now. */
  adoptable: boolean;
  /** A plan id `owner` has not used. */
  freshBasketId: string;
  /** Who a cash approval goes to. Where the chain needs approvals it already holds one for `depositRaw`. */
  spender: Address;
  depositRaw: RawAmount;
  /** A trade the owner can make inside `vault` now. */
  ownerTrade: Trade;
  /** A trade the keeper can make inside `vault` now: toward a target. */
  keeperTrade: Trade;
  /** A next version of the shared portfolio that `owner` can publish now. */
  publishRecipe: Recipe;
  /** An id in the chain's own format that was never sent. */
  unknownTxId: string;
};

/** Parses, and fails on a field the schema does not name: the frozen shape, nothing more. */
function exact<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.parse(value);
  expect(value).toEqual(parsed);
  return parsed;
}

export function adapterContract(
  name: string,
  setup: () => ContractFixture | Promise<ContractFixture>,
): void {
  describe(`adapter contract: ${name}`, () => {
    let f: ContractFixture;
    let a: ChainAdapter;
    let assets: BasketAsset[];
    let cash: BasketAsset;
    let keeper: Address;
    let targets: Target[];
    let activeVersion: number;

    beforeAll(async () => {
      f = await setup();
      a = f.adapter;
      assets = await a.listAssets();
      const found = assets.find((x) => x.cls === 'cash');
      if (!found) throw new Error('the adapter lists no cash token');
      cash = found;
      const vault = await a.getVault(f.vault);
      if (!vault) throw new Error('the fixture vault does not exist');
      keeper = vault.keeper;
      const { active } = await a.getRecipe(f.recipeOnchainId);
      activeVersion = active.version;
      targets = active.components.flatMap((c) =>
        c.kind === 'asset' ? [{ asset: c.asset, weightBps: c.weightBps }] : [],
      );
    });

    function checkTx(tx: BasketTx, kind: LegKind, signer: Address) {
      exact(BasketTx, tx);
      expect(tx.legKind).toBe(kind);
      expect(tx.chainId).toBe(a.chain);
      expect(tx.chain).toBe(chainFamily(a.chain));
      expect(tx.signer).toBe(signer);
      // A builder takes no leg, so it cannot know these: the order layer stamps them.
      expect(tx.legId).toBeNull();
      expect(tx.attemptId).toBeNull();
      expect(tx.provenance).toBe(f.provenance);
      expect(tx.preview.provenance).toBe(f.provenance);
      expect(tx.payload.length).toBeGreaterThan(0);
    }
    const delta = (tx: BasketTx, holder: 'wallet' | 'vault', asset: string) =>
      tx.preview.changes
        .filter((c) => c.holder === holder && c.asset === asset)
        .reduce((n, c) => n + BigInt(c.deltaRaw), 0n);

    describe('reads', () => {
      it('names its chain and its capabilities', () => {
        ChainId.parse(a.chain);
        exact(Capabilities, a.capabilities);
      });

      it('lists its assets: unique ids on its own chain, exactly one cash token', () => {
        expect(assets.length).toBeGreaterThan(1);
        for (const x of assets) {
          exact(BasketAsset, x);
          expect(x.chain).toBe(a.chain);
          expect(x.id.startsWith(`${a.chain}:`)).toBe(true);
          expect(x.provenance).toBe(f.provenance);
        }
        expect(new Set(assets.map((x) => x.id)).size).toBe(assets.length);
        expect(new Set(assets.map((x) => x.address)).size).toBe(assets.length);
        expect(assets.filter((x) => x.cls === 'cash')).toHaveLength(1);
      });

      it('prices what it is asked for, once each, and every asset that has a price source', async () => {
        const ids = assets.map((x) => x.id);
        const prices = await a.getPrices(ids);
        for (const p of prices) {
          exact(Price, p);
          expect(ids).toContain(p.asset);
          expect(Number(p.usdPerToken)).toBeGreaterThan(0);
          expect(p.provenance).toBe(f.provenance);
        }
        const priced = prices.map((p) => p.asset);
        expect(new Set(priced).size).toBe(priced.length);
        for (const x of assets) if (x.priceKind !== 'none') expect(priced).toContain(x.id);
        expect(await a.getPrices([])).toEqual([]);
      });

      it('reads the same vault through getVaults and getVault', async () => {
        const one = exact(VaultState.nullable(), await a.getVault(f.vault));
        const mine = await a.getVaults(f.owner);
        for (const v of mine) {
          exact(VaultState, v);
          expect(v.owner).toBe(f.owner);
          expect(v.chain).toBe(a.chain);
        }
        const listed = mine.find((v) => v.address === f.vault);
        expect(listed).toBeDefined();
        expect({ ...listed, observedAt: '' }).toEqual({ ...one, observedAt: '' });
        expect(one?.autoFollow).toBe(true);
        expect(one?.recipeOnchainId).toBe(f.recipeOnchainId);
      });

      it('finds nothing where there is nothing', async () => {
        expect(await a.getVaults(f.stranger)).toEqual([]);
        expect(await a.getVault(f.stranger)).toBeNull();
        expect(await a.getWalletHoldings(f.stranger)).toEqual([]);
      });

      it('shows each holding as raw × multiplier / 10^decimals', async () => {
        const vault = await a.getVault(f.vault);
        const holdings = [
          ...(vault ? [vault.cash, ...vault.positions] : []),
          ...(await a.getWalletHoldings(f.owner)),
        ];
        expect(holdings.length).toBeGreaterThan(1);
        for (const h of holdings) {
          const decimals = assets.find((x) => x.id === h.asset)?.decimals;
          expect(decimals, `${h.asset} is listed`).toBeDefined();
          expect(h.display).toBe(displayAmount(h.raw, h.multiplier, decimals ?? 0));
        }
      });

      it('stores targets that add up to 10,000, on listed assets, never on cash', async () => {
        const vault = await a.getVault(f.vault);
        const positions = vault?.positions ?? [];
        expect(positions.reduce((n, p) => n + p.targetBps, 0)).toBe(10_000);
        expect(positions.some((p) => BigInt(p.raw) > 0n)).toBe(true);
        expect(BigInt(vault?.cash.raw ?? 0)).toBeGreaterThan(0n);
        expect(vault?.cash.asset).toBe(cash.id);
        for (const p of positions) expect(p.asset).not.toBe(cash.id);
      });

      it('lists the vault among the auto-follow vaults, with and without the recipe filter', async () => {
        expect(await a.listAutoFollowVaults()).toContain(f.vault);
        expect(await a.listAutoFollowVaults(f.recipeOnchainId)).toContain(f.vault);
      });

      it('reads a recipe: the active version, and a pending one only as the next number', async () => {
        const { active, pending } = await a.getRecipe(f.recipeOnchainId);
        exact(Recipe, active);
        expect(active.onchainId).toBe(f.recipeOnchainId);
        expect(active.chain).toBe(a.chain);
        if (pending) {
          exact(Recipe, pending);
          expect(pending.version).toBe(active.version + 1);
          expect(pending.effectiveAt).toBeGreaterThan(active.effectiveAt);
        }
        const vault = await a.getVault(f.vault);
        expect(vault?.acceptedVersion).toBeLessThanOrEqual(active.version);
      });

      it('reads what a wallet holds', async () => {
        const holdings = await a.getWalletHoldings(f.owner);
        for (const h of holdings) exact(Holding, h);
        const held = holdings.find((h) => h.asset === cash.id);
        expect(BigInt(held?.raw ?? 0)).toBeGreaterThanOrEqual(BigInt(f.depositRaw));
      });

      it('says whether a wallet can pay: cash and gas, and ok only when both are there', async () => {
        const need = { cashRaw: f.depositRaw, legs: 2, newVault: true };
        for (const who of [f.owner, f.stranger]) {
          const r = exact(Funding, await a.funding(who, need));
          expect(r.chain).toBe(a.chain);
          expect(r.cashNeedRaw).toBe(f.depositRaw);
          expect(r.ok).toBe(
            BigInt(r.cashHaveRaw) >= BigInt(r.cashNeedRaw) &&
              BigInt(r.gasHaveRaw) >= BigInt(r.gasNeedRaw),
          );
        }
        expect((await a.funding(f.owner, need)).ok).toBe(true);
        expect((await a.funding(f.stranger, need)).ok).toBe(false);
      });

      it('quotes a trade: the same trade back, and a minimum no higher than the output', async () => {
        const q = exact(Quote, await a.quote(f.ownerTrade, f.owner));
        expect(q.trade).toEqual(f.ownerTrade);
        expect(BigInt(q.outRaw)).toBeGreaterThan(0n);
        expect(BigInt(q.minOutRaw)).toBeLessThanOrEqual(BigInt(q.outRaw));
        expect(q.provenance).toBe(f.provenance);
      });

      it('tracks an id it has never seen as pending or expired, never as landed', async () => {
        const s = exact(TxStatus, await a.track(f.unknownTxId));
        expect(['pending', 'expired']).toContain(s.status);
      });
    });

    describe('owner transactions', () => {
      it('approves cash where the chain needs it, and refuses where it does not', async () => {
        const args = { owner: f.owner, spender: f.spender, amountRaw: f.depositRaw };
        if (a.capabilities.needsApprove) checkTx(await a.buildApprove(args), 'approve', f.owner);
        else await expect(a.buildApprove(args)).rejects.toThrow();
      });

      it('opens a vault with its own targets and a first deposit', async () => {
        const tx = await a.buildCreateVault({
          owner: f.owner,
          basketId: f.freshBasketId,
          targets,
          autoFollow: false,
          depositRaw: f.depositRaw,
          slippageBps: 100,
        });
        checkTx(tx, 'create_vault', f.owner);
        expect(delta(tx, 'wallet', cash.id)).toBe(-BigInt(f.depositRaw));
      });

      it('opens a vault that follows a recipe at the version the person saw, and no other', async () => {
        const args = {
          owner: f.owner,
          basketId: f.freshBasketId,
          targets: [],
          recipeOnchainId: f.recipeOnchainId,
          autoFollow: true,
          slippageBps: 100,
        };
        const tx = await a.buildCreateVault({ ...args, expectedVersion: activeVersion });
        checkTx(tx, 'create_vault', f.owner);
        await expect(
          a.buildCreateVault({ ...args, expectedVersion: activeVersion + 7 }),
        ).rejects.toThrow();
      });

      it('trades inside the create only where the chain can', async () => {
        const first = targets[0];
        if (!first) throw new Error('the fixture recipe has no asset');
        const args = {
          owner: f.owner,
          basketId: f.freshBasketId,
          targets,
          autoFollow: false,
          depositRaw: f.depositRaw,
          trades: [{ sell: cash.id, buy: first.asset, amountInRaw: f.depositRaw }],
          slippageBps: 100,
        };
        if (!a.capabilities.tradesInCreate) {
          await expect(a.buildCreateVault(args)).rejects.toThrow();
          return;
        }
        const tx = await a.buildCreateVault(args);
        checkTx(tx, 'create_vault', f.owner);
        expect(delta(tx, 'vault', first.asset)).toBeGreaterThan(0n);
      });

      it('refuses a plan id the owner already used', async () => {
        const used = (await a.getVault(f.vault))?.basketId ?? '';
        await expect(
          a.buildCreateVault({
            owner: f.owner,
            basketId: used,
            targets,
            autoFollow: false,
            slippageBps: 100,
          }),
        ).rejects.toThrow();
      });

      it('deposits cash from the wallet into the vault', async () => {
        const tx = await a.buildDeposit({
          vault: f.vault,
          amountRaw: f.depositRaw,
          slippageBps: 100,
        });
        checkTx(tx, 'deposit', f.owner);
        expect(delta(tx, 'wallet', cash.id)).toBe(-BigInt(f.depositRaw));
        expect(delta(tx, 'vault', cash.id)).toBe(BigInt(f.depositRaw));
      });

      it('trades inside the vault, up to the number of trades one transaction takes', async () => {
        const tx = await a.buildOwnerSwap({
          vault: f.vault,
          trades: [f.ownerTrade],
          slippageBps: 100,
        });
        checkTx(tx, 'swap', f.owner);
        expect(delta(tx, 'vault', f.ownerTrade.sell)).toBe(-BigInt(f.ownerTrade.amountInRaw));
        expect(delta(tx, 'vault', f.ownerTrade.buy)).toBeGreaterThan(0n);
        // The wallet is not part of a trade inside the vault.
        expect(tx.preview.changes.filter((c) => c.holder === 'wallet')).toEqual([]);

        const one = { ...f.ownerTrade, amountInRaw: '1' };
        const tooMany = Array.from({ length: a.capabilities.maxTradesPerTx + 1 }, () => one);
        await expect(
          a.buildOwnerSwap({ vault: f.vault, trades: tooMany, slippageBps: 100 }),
        ).rejects.toThrow();
      });

      it('sets targets', async () => {
        checkTx(await a.buildSetTargets({ vault: f.vault, targets }), 'set_targets', f.owner);
      });

      it('accepts the active version by its number, and no other', async () => {
        const args = { vault: f.vault, recipeOnchainId: f.recipeOnchainId };
        const tx = await a.buildAcceptVersion({ ...args, expectedVersion: activeVersion });
        checkTx(tx, 'accept_version', f.owner);
        await expect(
          a.buildAcceptVersion({ ...args, expectedVersion: activeVersion + 7 }),
        ).rejects.toThrow();
      });

      it('switches auto-follow', async () => {
        const tx = await a.buildSetAutoFollow({ vault: f.vault, on: false });
        checkTx(tx, 'set_auto_follow', f.owner);
      });

      it('withdraws the tokens themselves, and only to the owner', async () => {
        const vault = await a.getVault(f.vault);
        const txs = await a.buildWithdrawInKind({ vault: f.vault });
        expect(txs.length).toBeGreaterThan(0);
        for (const tx of txs) checkTx(tx, 'withdraw', f.owner);
        const held = [vault?.cash, ...(vault?.positions ?? [])].filter(
          (h) => h && BigInt(h.raw) > 0n,
        );
        for (const h of held) {
          if (!h) continue;
          const out = txs.reduce((n, tx) => n + delta(tx, 'vault', h.asset), 0n);
          const back = txs.reduce((n, tx) => n + delta(tx, 'wallet', h.asset), 0n);
          expect(out).toBe(-BigInt(h.raw));
          expect(back).toBe(BigInt(h.raw));
        }

        const some = await a.buildWithdrawInKind({ vault: f.vault, assets: [cash.id] });
        expect(some).toHaveLength(1);
        expect(some[0]?.preview.changes.map((c) => c.asset)).toEqual([cash.id, cash.id]);
      });

      it('publishes a recipe, signed by its creator', async () => {
        const tx = await a.buildPublishRecipe({ creator: f.owner, recipe: f.publishRecipe });
        checkTx(tx, 'publish', f.owner);
      });

      it('refuses to build for a vault that does not exist', async () => {
        await expect(
          a.buildDeposit({ vault: f.stranger, amountRaw: f.depositRaw, slippageBps: 100 }),
        ).rejects.toThrow();
        await expect(a.buildSetAutoFollow({ vault: f.stranger, on: true })).rejects.toThrow();
        await expect(a.buildWithdrawInKind({ vault: f.stranger })).rejects.toThrow();
      });
    });

    describe('keeper transactions', () => {
      it('builds one trade toward a target, signed by the keeper', async () => {
        const tx = await a.buildKeeperLeg(f.vault, f.keeperTrade);
        checkTx(tx, 'keeper_leg', keeper);
        expect(delta(tx, 'vault', f.keeperTrade.sell)).toBe(-BigInt(f.keeperTrade.amountInRaw));
        expect(delta(tx, 'vault', f.keeperTrade.buy)).toBeGreaterThan(0n);
      });

      it('adopts a new version only when one has taken effect', async () => {
        if (f.adoptable) checkTx(await a.buildAdoptVersion(f.vault), 'adopt_version', keeper);
        else await expect(a.buildAdoptVersion(f.vault)).rejects.toThrow();
      });

      it('has no builder that sets a keeper or an operator', () => {
        const names = new Set<string>();
        for (let o: object | null = a; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
          for (const k of Object.getOwnPropertyNames(o)) names.add(k);
        const builders = [...names].filter((k) => /^build.*(keeper|operator)/i.test(k));
        expect(builders).toEqual(['buildKeeperLeg']);
      });
    });
  });
}
