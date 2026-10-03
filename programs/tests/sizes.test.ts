import type { Address, Instruction, KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assetsAddress,
  configAddress,
  createVaultInstruction,
  depositInstruction,
  familyId,
  forwarded,
  initPlatform,
  ownerSwapInstruction,
  publishRecipeInstruction,
  readVault,
  recipeAddress,
  vaultAddress,
} from './src/basket';
import {
  BASKET_PROGRAM,
  createWorld,
  expectOk,
  fundedSigner,
  MAX_TRANSACTION_BYTES,
  MOCK_ROUTER_PROGRAM,
  programSigner,
  putLookupTable,
  SYSTEM_PROGRAM,
  send,
  sendMeasured,
} from './src/env';
import {
  initPairInstruction,
  initRouterInstruction,
  routeInstruction,
  routerAddress,
} from './src/mock-router';
import {
  ata,
  balance,
  createAtaInstruction,
  createMint,
  mintTo,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
const DEPOSIT = 100_000000n;
const SPEND = 10_000000n;

// How big the owner's first transactions are, and what they cost to run (DESIGN-VAULT.md section
// 3.2: a 12-asset create has to fit the 1,232-byte limit). The buy here goes through the test
// exchange, whose route takes 11 accounts; a Jupiter route is measured in the replay
// (programs/tests/jupiter-replay.ts). The numbers are printed, and the limits are asserted.
describe('sizes of the create transactions', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let creator: KeyPairSigner;
  let cash: TestMint;
  let stocks: TestMint[]; // twelve listed Token-2022 mints with the stock token's extensions
  let table: Address; // the platform's lookup table: what every vault transaction names
  let tableAddresses: Address[];
  const rows: Record<string, { bytes: number; units: number; accounts: number }> = {};
  let plan = 0n;

  beforeAll(async () => {
    ({ svm, deployer: admin } = await createWorld());
    creator = await fundedSigner(svm);
    cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
    stocks = [];
    for (let i = 0; i < 12; i++)
      stocks.push(
        await createMint(svm, admin, { program: TOKEN_2022_PROGRAM, decimals: 8, stock: true }),
      );
    await initPlatform(
      svm,
      admin,
      { cashMint: cash.address, routerProgram: MOCK_ROUTER_PROGRAM },
      stocks.map((m) => m.address),
    );
    const first = stocks[0] as TestMint;
    expectOk(
      await send(svm, admin, [
        await initRouterInstruction(admin),
        await initPairInstruction(admin, cash.address, first.address, 1n, 5n),
      ]),
    );
    const exchange = await routerAddress();
    await mintTo(svm, admin, cash, exchange, 0n);
    await mintTo(svm, admin, first, exchange, 1_000_00000000n);

    // What a platform table would hold: the programs, Config, the asset list, the cash mint and
    // the listed mints. Nothing in it is particular to one owner.
    tableAddresses = [
      BASKET_PROGRAM,
      SYSTEM_PROGRAM,
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM,
      ASSOCIATED_TOKEN_PROGRAM,
      MOCK_ROUTER_PROGRAM,
      await configAddress(),
      await assetsAddress(),
      cash.address,
      ...stocks.map((m) => m.address),
    ];
    table = await putLookupTable(svm, tableAddresses);
  });

  const weights = (count: number) =>
    // 7 and 12 equal parts, to the 50 bps step, with the remainder on the first.
    Array.from({ length: count }, (_, i) => {
      const each = Math.floor(10_000 / count / 50) * 50;
      return i === 0 ? 10_000 - each * (count - 1) : each;
    });

  /** A new owner with cash, and the instructions of one create transaction. */
  async function scenario(options: {
    targets: number;
    follow?: boolean;
    buy?: boolean;
  }): Promise<{ owner: KeyPairSigner; vault: Address; instructions: Instruction[] }> {
    const owner = await fundedSigner(svm);
    await mintTo(svm, admin, cash, owner.address, DEPOSIT);
    plan += 1n;
    const vault = await vaultAddress(owner.address, plan);
    const lines = weights(options.targets).map((bps, i) => ({
      mint: (stocks[i] as TestMint).address,
      bps,
    }));

    let recipe: Address | undefined;
    if (options.follow) {
      const family = familyId(`size-${plan}`);
      recipe = await recipeAddress(creator.address, family);
      expectOk(
        await send(svm, creator, [
          await publishRecipeInstruction({
            creator,
            familyId: family,
            components: lines.map((l) => ({ mint: l.mint, weightBps: l.bps })),
          }),
        ]),
      );
    }

    const instructions: Instruction[] = [
      await createVaultInstruction({
        owner,
        basketId: plan,
        targets: recipe ? [] : lines.map((l) => ({ mint: l.mint, targetBps: l.bps })),
        recipe,
        expectedVersion: recipe ? 1 : 0,
        autoFollow: Boolean(recipe),
      }),
      await createAtaInstruction(owner, vault, cash),
      await depositInstruction({ owner, vault, mint: cash, amount: DEPOSIT }),
    ];
    if (options.buy) {
      const first = stocks[0] as TestMint;
      instructions.push(
        // The token account of an asset is opened by the trade that first buys it.
        await createAtaInstruction(owner, vault, first),
        await ownerSwapInstruction({
          owner,
          vault,
          inputMint: cash,
          outputMint: first,
          maxIn: SPEND,
          minOut: SPEND / 5n,
          ...forwarded(
            await routeInstruction({
              trader: programSigner(vault),
              mintIn: cash,
              mintOut: first,
              traderIn: await ata(vault, cash),
              destination: await ata(vault, first),
              amountIn: SPEND,
              minOut: 0n,
            }),
          ),
        }),
      );
    }
    return { owner, vault, instructions };
  }

  async function measure(
    name: string,
    options: { targets: number; follow?: boolean; buy?: boolean; withTable?: boolean },
  ): Promise<{ bytes: number; units: number }> {
    const { owner, vault, instructions } = await scenario(options);
    const { result, bytes } = await sendMeasured(
      svm,
      owner,
      instructions,
      options.withTable ? { [table]: tableAddresses } : {},
    );
    const meta = expectOk(result);
    const state = readVault(svm, vault);
    expect(state.count).toBe(options.targets);
    expect(balance(svm, await ata(vault, cash))).toBe(options.buy ? DEPOSIT - SPEND : DEPOSIT);
    const accounts = new Set(
      instructions.flatMap((i) => [i.programAddress, ...(i.accounts ?? []).map((a) => a.address)]),
    ).size;
    const row = { bytes, units: Number(meta.computeUnitsConsumed()), accounts };
    rows[name] = row;
    return row;
  }

  describe.each([7, 12])('%i targets', (targets) => {
    it('create, open the cash account and deposit: one transaction, no lookup table', async () => {
      const { bytes, units } = await measure(`${targets} targets: create + deposit`, { targets });
      expect(bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
      expect(units).toBeLessThan(200_000);
    });

    it('create to follow a shared portfolio of that many assets: the targets are not in the transaction', async () => {
      const { bytes, units } = await measure(`${targets} targets: follow + deposit`, {
        targets,
        follow: true,
      });
      expect(bytes).toBeLessThan(700);
      expect(units).toBeLessThan(200_000);
    });

    it('create, deposit and the first buy, with the platform lookup table', async () => {
      const { bytes, units } = await measure(
        `${targets} targets: create + deposit + buy, with the table`,
        {
          targets,
          buy: true,
          withTable: true,
        },
      );
      expect(bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
      expect(units).toBeLessThan(400_000);
    });
  });

  it('create, deposit and the first buy with no lookup table: 7 targets fit, 12 do not', async () => {
    const seven = await measure('7 targets: create + deposit + buy', { targets: 7, buy: true });
    expect(seven.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // LiteSVM runs a transaction of any size; a node would not take this one.
    const twelve = await measure('12 targets: create + deposit + buy', { targets: 12, buy: true });
    expect(twelve.bytes).toBeGreaterThan(MAX_TRANSACTION_BYTES);
  });

  it('the first buy as a transaction of its own, after a create that only deposits', async () => {
    const { owner, vault, instructions } = await scenario({ targets: 12, buy: true });
    expectOk(await send(svm, owner, instructions.slice(0, 3)));
    const { result, bytes } = await sendMeasured(svm, owner, instructions.slice(3));
    const units = Number(expectOk(result).computeUnitsConsumed());
    rows['the first buy alone: open the token account + swap'] = { bytes, units, accounts: 17 };
    expect(bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(units).toBeLessThan(200_000);
    expect(balance(svm, await ata(vault, cash))).toBe(DEPOSIT - SPEND);
  });

  it('prints what it measured', () => {
    console.table(rows);
    expect(Object.keys(rows)).toHaveLength(9);
  });
});
