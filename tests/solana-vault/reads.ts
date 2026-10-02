import { displayAmount } from '@colosseum/chain-mock';
import type { SolanaVaultReader } from '@colosseum/chain-solana/src/vault';
import {
  BasketAsset,
  Capabilities,
  ChainError,
  type ChainErrorCode,
  Funding,
  Holding,
  Price,
  type Provenance,
  TxStatus,
  VaultState,
} from '@colosseum/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { assetId, type MintName, type VaultName, type World } from './world';

// The read cases of the adapter contract (packages/chain-mock/src/contract.ts, group "reads"), as far as
// the program supports them today, against the world programs/tests builds. The same cases run on the
// committed account bytes behind a node in memory, and on a local validator.
//
// What the contract's own function needs and this world cannot give yet is in the last case: a shared
// portfolio to follow. `adapterContract()` reads one before its first case, so it cannot start until
// SOL-2 puts the registry on chain and ADS-2 builds the transactions that set its fixture up.

export type ReadSetup = {
  reader: SolanaVaultReader;
  world: World;
  provenance: Provenance;
  /** ISO time. Nothing is stamped earlier. */
  notBefore: string;
  /** True when the price entries are exactly as old as the world says; false on a running clock. */
  exactAges: boolean;
  /** False where the config has no explorer. */
  explorer: boolean;
  /** A signature that was never sent. */
  unknownTxId: string;
  /** A transaction that landed. */
  landedTxId: string;
  /** One that landed and failed, with the vault error it failed with. */
  revertedTx: { txId: string; code: string };
};

/** Parses, and fails on a field the schema does not name. */
function exact<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.parse(value);
  expect(value).toEqual(parsed);
  return parsed;
}

async function refuses(work: Promise<unknown>, code: ChainErrorCode): Promise<ChainError> {
  const outcome = await work.then(
    () => 'answered' as const,
    (e: unknown) => e,
  );
  expect(outcome, `expected a refusal with ${code}`).toBeInstanceOf(ChainError);
  expect((outcome as ChainError).code).toBe(code);
  return outcome as ChainError;
}

export function readCases(name: string, setup: () => Promise<ReadSetup>): void {
  describe(`Solana reader: ${name}`, () => {
    let s: ReadSetup;
    let assets: BasketAsset[];
    const vaultOf = async (vault: VaultName) => {
      const state = await s.reader.getVault(s.world.names.vaults[vault]);
      if (!state) throw new Error(`no vault ${vault}`);
      return state;
    };
    const multiplierOf = (mint: MintName) => String(s.world.expected.mints[mint].multiplier ?? 1);

    beforeAll(async () => {
      s = await setup();
      assets = await s.reader.listAssets();
    });

    it('names its chain and its capabilities', () => {
      expect(s.reader.chain).toBe('solana');
      expect(exact(Capabilities, s.reader.capabilities)).toMatchObject({
        maxTradesPerTx: 1,
        tradesInCreate: false,
        needsApprove: false,
      });
      expect(s.reader.provenance).toBe(s.provenance);
      expect(s.reader.program).toBe(s.world.names.program);
    });

    it('lists its assets: unique ids on its own chain, exactly one cash token', () => {
      expect(assets.length).toBeGreaterThan(1);
      for (const x of assets) {
        exact(BasketAsset, x);
        expect(x.chain).toBe('solana');
        expect(x.provenance).toBe(s.provenance);
      }
      expect(new Set(assets.map((x) => x.id)).size).toBe(assets.length);
      expect(new Set(assets.map((x) => x.address)).size).toBe(assets.length);
      expect(assets.filter((x) => x.cls === 'cash')).toHaveLength(1);
    });

    it('prices what it is asked for, once each, and every asset that has a price source', async () => {
      const ids = assets.map((x) => x.id);
      const prices = await s.reader.getPrices([...ids, ...ids]);
      for (const p of prices) {
        exact(Price, p);
        expect(ids).toContain(p.asset);
        expect(Number(p.usdPerToken)).toBeGreaterThan(0);
        expect(p.provenance).toBe(s.provenance);
        expect(p.fetchedAt >= s.notBefore).toBe(true);
        expect(p.source).toContain(s.world.prices.account);
        expect(p.method.length).toBeGreaterThan(10);
      }
      const priced = prices.map((p) => p.asset);
      expect(new Set(priced).size).toBe(priced.length);
      // Every asset with a price source, and none without: nothing is made up for the others.
      expect([...priced].sort()).toEqual(
        assets
          .filter((x) => x.priceKind !== 'none')
          .map((x) => x.id)
          .sort(),
      );
      for (const [mint, want] of Object.entries(s.world.prices.entries)) {
        const got = prices.find((p) => p.asset === assetId(mint as MintName));
        if (!got) continue;
        expect(got.usdPerToken).toBe(want.usdPerToken);
        expect(got.source).toContain(`entry ${want.index}`);
        if (s.exactAges) expect(got.ageSeconds).toBe(want.ageSeconds);
        else {
          // On a running clock the entry has aged since it was written, and the node's clock is not
          // the writer's to the second.
          expect(got.ageSeconds).toBeGreaterThanOrEqual(Math.max(0, want.ageSeconds - 60));
          expect(got.ageSeconds).toBeLessThan(want.ageSeconds + 900);
        }
      }
      expect(await s.reader.getPrices([])).toEqual([]);
    });

    it('reads the same vault through getVaults and getVault', async () => {
      const { names, expected } = s.world;
      const mine = await s.reader.getVaults(names.owner);
      for (const v of mine) {
        exact(VaultState, v);
        expect(v.owner).toBe(names.owner);
        expect(v.chain).toBe('solana');
        expect(v.observedAt >= s.notBefore).toBe(true);
      }
      expect(mine.map((v) => v.basketId)).toEqual(['1', '2', '3']);
      for (const vault of ['following', 'manual', 'partial'] as const) {
        const one = exact(VaultState.nullable(), await s.reader.getVault(names.vaults[vault]));
        const listed = mine.find((v) => v.address === names.vaults[vault]);
        expect(listed, 'the owner lists the vault').toBeDefined();
        expect({ ...listed, observedAt: '' }).toEqual({ ...one, observedAt: '' });
        expect(one?.basketId).toBe(expected.vaults[vault].basketId);
        expect(one?.autoFollow).toBe(expected.vaults[vault].autoFollow);
        // No instruction sets a keeper of its own, so every vault has Config's default.
        expect(one?.keeper).toBe(names.keeper);
        expect([
          one?.recipeOnchainId,
          one?.acceptedVersion,
          one?.pending,
          one?.lossUsedBps,
        ]).toEqual([null, 0, null, 0]);
      }
      // Another owner's vault, with the same plan id, is theirs alone.
      const theirs = await s.reader.getVaults(names.other);
      expect(theirs.map((v) => v.address)).toEqual([names.vaults.others]);
      expect(mine.map((v) => v.address)).not.toContain(names.vaults.others);
    });

    it('finds nothing where there is nothing', async () => {
      const { stranger, config, mints } = s.world.names;
      expect(await s.reader.getVaults(stranger)).toEqual([]);
      expect(await s.reader.getVault(stranger)).toBeNull();
      expect(await s.reader.getWalletHoldings(stranger)).toEqual([]);
      // The program's own Config, and a mint, are not vaults.
      expect(await s.reader.getVault(config)).toBeNull();
      expect(await s.reader.getVault(mints.spyx)).toBeNull();
    });

    it('stores the targets the owner set, on listed assets, never on cash', async () => {
      const { expected } = s.world;
      for (const vault of ['following', 'manual', 'partial', 'others'] as const) {
        const { targets } = expected.vaults[vault];
        const state = await vaultOf(vault);
        // The targets come first, in the program's order.
        expect(state.positions.slice(0, targets.length).map((p) => [p.asset, p.targetBps])).toEqual(
          targets.map((t) => [assetId(t.mint), t.targetBps]),
        );
        expect(state.cash.asset).toBe(assetId('usdc'));
        expect(new Set(state.positions.map((p) => p.asset)).size).toBe(state.positions.length);
        for (const p of state.positions) {
          expect(p.asset).not.toBe(assetId('usdc'));
          expect(p.lastKeeperAt).toBeNull();
        }
      }
      // The program lets targets add up to less than the whole: the rest is cash.
      expect((await vaultOf('following')).positions.reduce((n, p) => n + p.targetBps, 0)).toBe(
        10_000,
      );
      expect((await vaultOf('partial')).positions.reduce((n, p) => n + p.targetBps, 0)).toBe(2_500);
    });

    it('reads what a vault really holds from its token accounts, under both token programs', async () => {
      const { expected } = s.world;
      for (const vault of ['following', 'manual', 'partial', 'others'] as const) {
        const want = expected.vaults[vault];
        const state = await vaultOf(vault);
        expect(state.cash.raw).toBe(want.held.usdc);
        // Every target, at zero when the vault holds none of it, and whatever else it holds.
        const { usdc: _, ...assetsHeld } = want.held;
        expect(Object.fromEntries(state.positions.map((p) => [p.asset, p.raw]))).toEqual({
          ...Object.fromEntries(want.targets.map((t) => [assetId(t.mint), '0'])),
          ...Object.fromEntries(
            Object.entries(assetsHeld).map(([mint, raw]) => [assetId(mint as MintName), raw]),
          ),
        });
      }
      // The program's own record of SPYx is out of date in this world, and is not what is reported.
      const { held, tracked } = expected.vaults.following;
      expect(tracked.spyx).not.toBe(held.spyx);
      const following = await vaultOf('following');
      expect(following.positions.find((p) => p.asset === assetId('spyx'))?.raw).toBe(held.spyx);
      // One position under each token program, and one with no token account at all.
      const programs = following.positions.map(
        (p) => expected.mints[p.asset.split(':')[1] as MintName].tokenProgram,
      );
      expect(new Set(programs)).toEqual(new Set(['token', 'token-2022']));
      expect(following.positions.find((p) => p.asset === assetId('nvdax'))?.raw).toBe('0');
    });

    it('lists a token the vault holds with no target on it, at a target of zero', async () => {
      const { expected } = s.world;
      const want = expected.vaults.manual;
      expect(want.targets.map((t) => t.mint)).not.toContain('tslax');
      const manual = await vaultOf('manual');
      expect(manual.positions.at(-1)).toMatchObject({
        asset: assetId('tslax'),
        raw: want.held.tslax,
        targetBps: 0,
        lastKeeperAt: null,
      });
      expect(manual.positions).toHaveLength(want.targets.length + 1);
      // A listed asset the vault neither targets nor holds is not a position.
      expect(manual.positions.map((p) => p.asset)).not.toContain(assetId('nvdax'));
      expect((await vaultOf('others')).positions).toHaveLength(1);
    });

    it("shows each holding as raw × multiplier / 10^decimals, with the mint's own multiplier", async () => {
      const vault = await vaultOf('following');
      const holdings = [
        vault.cash,
        ...vault.positions,
        ...(await s.reader.getWalletHoldings(s.world.names.owner)),
      ];
      expect(holdings.length).toBeGreaterThan(4);
      for (const h of holdings) {
        const decimals = assets.find((x) => x.id === h.asset)?.decimals;
        expect(decimals, `${h.asset} is listed`).toBeDefined();
        expect(h.display).toBe(displayAmount(h.raw, h.multiplier, decimals ?? 0));
        // The one in force now: a multiplier scheduled for later is not applied.
        expect(h.multiplier).toBe(multiplierOf(h.asset.split(':')[1] as MintName));
      }
      expect(new Set(holdings.map((h) => h.multiplier)).size).toBeGreaterThan(1);
    });

    it('lists exactly the vaults with auto-follow on, and filters them by recipe', async () => {
      const { vaults, stranger } = s.world.names;
      const all = await s.reader.listAutoFollowVaults();
      expect([...all].sort()).toEqual([vaults.following, vaults.partial].sort());
      expect(new Set(all).size).toBe(all.length);
      for (const address of all) expect((await s.reader.getVault(address))?.autoFollow).toBe(true);
      // No vault follows a shared portfolio yet, so no address has followers.
      expect(await s.reader.listAutoFollowVaults(stranger)).toEqual([]);
      await refuses(s.reader.listAutoFollowVaults('not-an-address'), 'BadInput');
    });

    it('reads what a wallet holds: its own associated token accounts, nothing at zero', async () => {
      const { names, expected } = s.world;
      const holdings = await s.reader.getWalletHoldings(names.owner);
      for (const h of holdings) exact(Holding, h);
      expect(Object.fromEntries(holdings.map((h) => [h.asset, h.raw]))).toEqual(
        Object.fromEntries(
          Object.entries(expected.wallets.owner).map(([mint, raw]) => [
            assetId(mint as MintName),
            raw,
          ]),
        ),
      );
      // The other wallet's cash account exists and is empty.
      expect(expected.wallets.other.usdc).toBe('0');
      expect(await s.reader.getWalletHoldings(names.other)).toEqual([]);
    });

    it('says whether a wallet can pay: cash and gas, and ok only when both are there', async () => {
      const { names, expected } = s.world;
      const need = { cashRaw: '1000000000', legs: 2, newVault: true };
      for (const who of [names.owner, names.stranger]) {
        const r = exact(Funding, await s.reader.funding(who, need));
        expect(r.chain).toBe('solana');
        expect(r.cashNeedRaw).toBe(need.cashRaw);
        expect(BigInt(r.gasNeedRaw)).toBeGreaterThan(0n);
        expect(r.ok).toBe(
          BigInt(r.cashHaveRaw) >= BigInt(r.cashNeedRaw) &&
            BigInt(r.gasHaveRaw) >= BigInt(r.gasNeedRaw),
        );
      }
      const owner = await s.reader.funding(names.owner, need);
      expect(owner.ok).toBe(true);
      expect(owner.cashHaveRaw).toBe(expected.wallets.owner.usdc);
      expect(BigInt(owner.gasHaveRaw)).toBeGreaterThan(1_000_000_000n);
      expect(await s.reader.funding(names.stranger, need)).toMatchObject({
        ok: false,
        cashHaveRaw: '0',
        gasHaveRaw: '0',
      });
      // More than the wallet holds: not ok, with the gas still there.
      const tooMuch = await s.reader.funding(names.owner, { ...need, cashRaw: '3400000001' });
      expect(tooMuch.ok).toBe(false);
      const more = await s.reader.funding(names.owner, { ...need, legs: 6 });
      expect(BigInt(more.gasNeedRaw)).toBeGreaterThan(BigInt(owner.gasNeedRaw));
      // An existing vault locks no new rent for itself.
      const existing = await s.reader.funding(names.owner, { ...need, newVault: false });
      expect(BigInt(existing.gasNeedRaw)).toBeLessThan(BigInt(owner.gasNeedRaw));
      await refuses(s.reader.funding(names.owner, { ...need, cashRaw: '1.5' }), 'BadInput');
      await refuses(s.reader.funding('not-an-address', need), 'BadInput');
    });

    it('tracks an id it has never seen as pending or expired, never as landed', async () => {
      const status = exact(TxStatus, await s.reader.track(s.unknownTxId));
      expect(status.status).toBe('pending');
      expect(status.error).toBeUndefined();
      if (s.explorer) expect(status.explorerUrl).toContain(s.unknownTxId);
      else expect(status.explorerUrl).toBe('');
      // Past the last block it could land in, it is expired.
      expect((await s.reader.track(s.unknownTxId, '0')).status).toBe('expired');
      expect((await s.reader.track(s.unknownTxId, '99999999999')).status).toBe('pending');
      await refuses(s.reader.track('not-a-signature'), 'BadInput');
      await refuses(s.reader.track(s.unknownTxId, 'soon'), 'BadInput');
    });

    it("tracks a transaction that landed as confirmed, and one that failed with the vault's own error", async () => {
      // A block height long past does not turn a landed transaction into an expired one.
      const landed = exact(TxStatus, await s.reader.track(s.landedTxId, '0'));
      expect(landed.status).toBe('confirmed');
      expect(landed.error).toBeUndefined();
      const failed = exact(TxStatus, await s.reader.track(s.revertedTx.txId));
      expect(failed.status).toBe('reverted');
      expect(failed.error?.code).toBe(s.revertedTx.code);
      expect(failed.error?.message.length).toBeGreaterThan(0);
    });

    it('refuses what is not on chain yet: a shared portfolio and a quote', async () => {
      const { names } = s.world;
      const recipe = await refuses(s.reader.getRecipe(names.stranger), 'NotSupported');
      expect(recipe.message).toContain('SOL-2');
      expect(recipe.retryable).toBe(false);
      const trade = { sell: assetId('usdc'), buy: assetId('spyx'), amountInRaw: '50000000' };
      await refuses(s.reader.quote(trade, names.owner), 'NotSupported');
    });
  });
}
