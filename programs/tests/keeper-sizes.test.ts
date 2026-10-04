import type { Address, Instruction } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  acceptVersionInstruction,
  adoptVersionInstruction,
  assetsAddress,
  configAddress,
  familyId,
  forwarded,
  keeperLegInstruction,
  patchVault,
  publishRecipeInstruction,
  recipeAddress,
  setAutoFollowInstruction,
  setTargetsInstruction,
  syncBalancesInstruction,
  updateRecipeInstruction,
  upsertAssetInstruction,
} from './src/basket';
import {
  BASKET_PROGRAM,
  expectOk,
  MAX_TRANSACTION_BYTES,
  MOCK_ROUTER_PROGRAM,
  now,
  programSigner,
  putLookupTable,
  send,
  sendMeasured,
  setClock,
} from './src/env';
import {
  createKeeperWorld,
  type KeeperWorld,
  keeperAsset,
  PRICE,
  refreshPrices,
} from './src/keeper';
import { routeInstruction } from './src/mock-router';
import { writePrice } from './src/prices';
import {
  ata,
  createAtaInstruction,
  createMint,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';

const SPEND = 5_000000n;

// What a keeper's transactions cost (DESIGN-VAULT.md section 5): a leg values every position the
// vault holds something of, so its compute units grow with the positions. The trade here goes
// through the test exchange, whose route takes 11 accounts; Jupiter's own cost is in the replay of
// the owner's swap (programs/README.md). The numbers are printed, and the limits are asserted.
describe('sizes of the keeper transactions', () => {
  const rows: Record<string, { bytes: number; units: number; accounts: number }> = {};

  /** A vault that holds `positions` assets, each priced and switched on, with cash to spend. */
  async function world(positions: number): Promise<{ w: KeeperWorld; extra: TestMint[] }> {
    const w = await createKeeperWorld();
    const { svm, admin, owner, vault } = w;
    const extra: TestMint[] = [];
    for (let i = 2; i < positions; i++) {
      const mint = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
      extra.push(mint);
      const entry = { priceIndex: 100 + i, twapIndex: 200 + i };
      for (const index of [entry.priceIndex, entry.twapIndex])
        writePrice(svm, w.prices, index, { value: PRICE, unixTimestamp: now(svm) });
      expectOk(
        await send(svm, admin, [
          await upsertAssetInstruction(admin, mint.address, keeperAsset(entry, 0)),
        ]),
      );
    }
    // The stock is under its target and every other position is at 2%, holding a little.
    const others = [w.other, ...extra];
    expectOk(
      await send(svm, owner, [
        await setTargetsInstruction({
          owner,
          vault,
          targets: [
            { mint: w.stock.address, targetBps: 5_000 },
            ...others.map((m) => ({ mint: m.address, targetBps: 200 })),
          ],
        }),
        await setAutoFollowInstruction({ owner, vault, on: true }),
      ]),
    );
    for (const mint of others)
      patchVault(svm, vault, { tracked: { mint: mint.address, amount: 400_000n } });
    return { w, extra };
  }

  async function leg(w: KeeperWorld): Promise<Instruction> {
    const route = forwarded(
      await routeInstruction({
        trader: programSigner(w.vault),
        mintIn: w.cash,
        mintOut: w.stock,
        traderIn: w.vaultCash,
        destination: w.vaultStock,
        amountIn: SPEND,
        minOut: 0n,
      }),
    );
    return keeperLegInstruction({
      keeper: w.keeper,
      vault: w.vault,
      inputMint: w.cash,
      outputMint: w.stock,
      amountIn: SPEND,
      priceAccount: w.prices,
      ...route,
    });
  }

  const record = (name: string, instructions: Instruction[], bytes: number, units: bigint) => {
    const accounts = new Set(
      instructions.flatMap((i) => [i.programAddress, ...(i.accounts ?? []).map((a) => a.address)]),
    ).size;
    rows[name] = { bytes, units: Number(units), accounts };
  };

  it.each([2, 7, 12, 16])('a keeper leg in a vault that holds %i positions', async (positions) => {
    const { w } = await world(positions);
    const instructions = [await leg(w)];
    // The platform's table: what every vault transaction names.
    const addresses: Address[] = [
      BASKET_PROGRAM,
      MOCK_ROUTER_PROGRAM,
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM,
      await configAddress(),
      await assetsAddress(),
      w.prices,
      w.cash.address,
      w.stock.address,
    ];
    const table = await putLookupTable(w.svm, addresses);
    const plain = await sendMeasured(w.svm, w.keeper, instructions);
    const meta = expectOk(plain.result);
    record(`leg, ${positions} positions`, instructions, plain.bytes, meta.computeUnitsConsumed());
    expect(plain.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // The default budget of one instruction is 200,000 units.
    expect(Number(meta.computeUnitsConsumed())).toBeLessThan(200_000);

    // The same leg an hour later, with the table: what it weighs on the wire.
    setClock(w.svm, now(w.svm) + 3_600n);
    refreshPrices(w);
    for (let i = 2; i < positions; i++)
      for (const index of [100 + i, 200 + i])
        writePrice(w.svm, w.prices, index, { value: PRICE, unixTimestamp: now(w.svm) });
    const small = await sendMeasured(w.svm, w.keeper, [await leg(w)], { [table]: addresses });
    rows[`leg, ${positions} positions, with the table`] = {
      bytes: small.bytes,
      units: Number(expectOk(small.result).computeUnitsConsumed()),
      accounts: rows[`leg, ${positions} positions`]?.accounts ?? 0,
    };
  });

  it('an accept, an adopt and a sync of 12 balances', async () => {
    const { w, extra } = await world(12);
    const { svm, owner, vault, admin } = w;
    const mints = [w.stock, w.other, ...extra];
    const weights = (shift: number) =>
      mints.map((m, i) => ({
        mint: m.address,
        weightBps: i === 0 ? 5_000 - shift : i === 1 ? 3_000 + shift : 200,
      }));
    const recipe = await recipeAddress(admin.address, familyId('twelve'));
    expectOk(
      await send(svm, admin, [
        await publishRecipeInstruction({
          creator: admin,
          familyId: familyId('twelve'),
          components: weights(0),
        }),
      ]),
    );
    const accept = [await acceptVersionInstruction({ owner, vault, recipe, expectedVersion: 1 })];
    const accepted = await sendMeasured(svm, owner, accept);
    record(
      'accept, 12 assets',
      accept,
      accepted.bytes,
      expectOk(accepted.result).computeUnitsConsumed(),
    );

    setClock(svm, now(svm) + 60n);
    expectOk(
      await send(svm, admin, [
        await updateRecipeInstruction({ creator: admin, recipe, components: weights(500) }),
      ]),
    );
    setClock(svm, now(svm) + 60n);
    const adopt = [await adoptVersionInstruction({ vault, recipe })];
    const adopted = await sendMeasured(svm, w.stranger, adopt);
    record(
      'adopt, 12 assets',
      adopt,
      adopted.bytes,
      expectOk(adopted.result).computeUnitsConsumed(),
    );

    const tokenAccounts: Address[] = [];
    for (const mint of mints) {
      expectOk(await send(svm, owner, [await createAtaInstruction(owner, vault, mint)]));
      tokenAccounts.push(await ata(vault, mint));
    }
    const sync = [syncBalancesInstruction({ vault, tokenAccounts })];
    const synced = await sendMeasured(svm, w.stranger, sync);
    record('sync, 12 balances', sync, synced.bytes, expectOk(synced.result).computeUnitsConsumed());
    for (const row of [accepted, adopted, synced])
      expect(row.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
  });

  it('prints what was measured', () => {
    console.table(rows);
    expect(Object.keys(rows).length).toBeGreaterThanOrEqual(11);
  });
});
