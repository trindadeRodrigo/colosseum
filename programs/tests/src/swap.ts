import type { AccountMeta, Address, KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import {
  createVaultInstruction,
  depositInstruction,
  forwarded,
  initPlatform,
  ownerSwapInstruction,
  vaultAddress,
} from './basket';
import {
  createWorld,
  expectOk,
  fundedSigner,
  MOCK_ROUTER_PROGRAM,
  programSigner,
  type SendResult,
  send,
} from './env';
import {
  initPairInstruction,
  initRouterInstruction,
  routeInstruction,
  routerAddress,
} from './mock-router';
import {
  ata,
  createAta,
  createAtaInstruction,
  createMint,
  mintTo,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './tokens';

// What the swap tests start from: a platform whose router is the test exchange, and one funded vault.

export const PLAN = 11n;
/** What the vault holds in cash at the start: 100 units of a 6-decimal dollar token. */
export const CASH = 100_000000n;
/** 1 unit of cash (10^6 raw) buys 0.002 of the stock (200,000 raw): a price of 500. */
export const STOCK_PER_CASH = { num: 1n, den: 5n };
/** Raw stock for raw cash, at the test exchange's price. */
export const stockFor = (cash: bigint) => (cash * STOCK_PER_CASH.num) / STOCK_PER_CASH.den;

export type SwapWorld = {
  svm: LiteSVM;
  admin: KeyPairSigner;
  guardian: KeyPairSigner;
  owner: KeyPairSigner;
  stranger: KeyPairSigner;
  /** Token program, 6 decimals: Config's cash mint. Not on the asset list. */
  cash: TestMint;
  /** Token-2022 with the stock token's extensions, 8 decimals. Listed, and the vault's one target. */
  stock: TestMint;
  /** Token program, 8 decimals. Listed; the vault has no target on it. */
  other: TestMint;
  /** Token program, 8 decimals. Not listed. */
  unlisted: TestMint;
  vault: Address;
  vaultCash: Address;
  vaultStock: Address;
  /** The test exchange's own account, which owns its reserves. */
  exchange: Address;
};

export async function createSwapWorld(
  options: { priceOwner?: Address; defaultKeeper?: Address } = {},
): Promise<SwapWorld> {
  const { svm, deployer: admin } = await createWorld();
  const guardian = await fundedSigner(svm);
  const owner = await fundedSigner(svm);
  const stranger = await fundedSigner(svm);
  const cash = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 6 });
  const stock = await createMint(svm, admin, {
    program: TOKEN_2022_PROGRAM,
    decimals: 8,
    stock: true,
  });
  const other = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
  const unlisted = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
  await initPlatform(
    svm,
    admin,
    {
      cashMint: cash.address,
      routerProgram: MOCK_ROUTER_PROGRAM,
      guardian: guardian.address,
      ...(options.priceOwner ? { priceOwner: options.priceOwner } : {}),
      ...(options.defaultKeeper ? { defaultKeeper: options.defaultKeeper } : {}),
    },
    [stock.address, other.address],
  );

  // The test exchange lists each pair one way, and pays from reserves the test fills.
  const exchange = await routerAddress();
  const { num, den } = STOCK_PER_CASH;
  expectOk(
    await send(svm, admin, [
      await initRouterInstruction(admin),
      await initPairInstruction(admin, cash.address, stock.address, num, den),
      await initPairInstruction(admin, stock.address, cash.address, den, num),
      await initPairInstruction(admin, cash.address, other.address, num, den),
      await initPairInstruction(admin, cash.address, unlisted.address, num, den),
    ]),
  );
  await mintTo(svm, admin, cash, exchange, 1_000_000_000000n);
  for (const mint of [stock, other, unlisted])
    await mintTo(svm, admin, mint, exchange, 1_000_00000000n);

  const vault = await vaultAddress(owner.address, PLAN);
  await mintTo(svm, admin, cash, owner.address, CASH);
  expectOk(
    await send(svm, owner, [
      await createVaultInstruction({
        owner,
        basketId: PLAN,
        targets: [{ mint: stock.address, targetBps: 10_000 }],
      }),
      await createAtaInstruction(owner, vault, cash),
      await createAtaInstruction(owner, vault, stock),
      await depositInstruction({ owner, vault, mint: cash, amount: CASH }),
    ]),
  );
  return {
    svm,
    admin,
    guardian,
    owner,
    stranger,
    cash,
    stock,
    other,
    unlisted,
    vault,
    vaultCash: await ata(vault, cash),
    vaultStock: await ata(vault, stock),
    exchange,
  };
}

export type SwapOptions = {
  /** What the exchange is told to take. */
  amountIn: bigint;
  maxIn?: bigint;
  minOut?: bigint;
  inputMint?: TestMint;
  outputMint?: TestMint;
  /** Where the exchange is told to pay. The vault's own account unless a test says otherwise. */
  destination?: Address;
  signer?: KeyPairSigner;
  vaultInput?: Address;
  vaultOutput?: Address;
  config?: Address;
  assets?: Address;
  /** More accounts after the exchange's own, which it ignores. */
  extra?: AccountMeta[];
};

/** An owner swap through the test exchange: cash for the stock unless the mints say otherwise. */
export async function swapThroughExchange(w: SwapWorld, o: SwapOptions): Promise<SendResult> {
  const inputMint = o.inputMint ?? w.cash;
  const outputMint = o.outputMint ?? w.stock;
  const route = forwarded(
    await routeInstruction({
      trader: programSigner(w.vault),
      mintIn: inputMint,
      mintOut: outputMint,
      traderIn: await ata(w.vault, inputMint),
      destination: o.destination ?? (await ata(w.vault, outputMint)),
      amountIn: o.amountIn,
      minOut: 0n,
    }),
  );
  const who = o.signer ?? w.owner;
  return send(w.svm, who, [
    await ownerSwapInstruction({
      owner: who,
      vault: w.vault,
      inputMint,
      outputMint,
      maxIn: o.maxIn ?? o.amountIn,
      minOut: o.minOut ?? 0n,
      vaultInput: o.vaultInput,
      vaultOutput: o.vaultOutput,
      config: o.config,
      assets: o.assets,
      ...route,
      routerAccounts: [...route.routerAccounts, ...(o.extra ?? [])],
    }),
  ]);
}

/** A token account of the mint for the holder, created if it is not there. */
export const tokenAccountFor = (w: SwapWorld, holder: Address, mint: TestMint) =>
  createAta(w.svm, w.admin, holder, mint);
