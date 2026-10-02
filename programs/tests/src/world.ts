import {
  type Address,
  generateKeyPairSigner,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  type ExtensionArgs,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
  getUpdateMultiplierScaledUiMintInstruction,
} from '@solana-program/token-2022';
import {
  configAddress,
  createVaultInstruction,
  DEFAULT_PARAMS,
  depositInstruction,
  initConfigInstruction,
  vaultAddress,
  withdrawInstruction,
} from './basket';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM } from './env';
import {
  ata,
  createAtaInstruction,
  stockExtensions,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './tokens';

// One small world of vaults, built by the real program through whatever runs the transactions:
// LiteSVM, for the account bytes committed under fixtures/solana-vault, or a local validator, for the
// adapter's integration test. The reader in packages/chain-solana is tested against what this leaves
// behind, so everything it did is written down in `expected`, by name and never by address.

/** What runs a transaction. Each call resolves once it has landed and throws if it failed. */
export type Ledger = {
  send(payer: TransactionSigner, instructions: Instruction[]): Promise<void>;
  rent(bytes: bigint): Promise<bigint>;
};

export type MintName = 'usdc' | 'spyx' | 'nvdax' | 'gold' | 'tslax';
export type VaultName = 'following' | 'manual' | 'partial' | 'others';

/** Raw units by mint name. A mint that is left out has no token account at all. */
type Amounts = Partial<Record<MintName, string>>;

export type WorldExpected = {
  mints: Record<
    MintName,
    {
      tokenProgram: 'token' | 'token-2022';
      decimals: number;
      /** What one raw unit shows as now; null on a mint without the extension. */
      multiplier: number | null;
      /** A multiplier that is set and not yet in force. */
      scheduled: { multiplier: number; effectiveAt: string } | null;
    }
  >;
  vaults: Record<
    VaultName,
    {
      owner: 'owner' | 'other';
      basketId: string;
      autoFollow: boolean;
      targets: { mint: MintName; targetBps: number }[];
      /** What the vault's associated token accounts hold. */
      held: Amounts;
      /** What the program recorded in `Position.tracked`: a hint, and here it disagrees with `held`. */
      tracked: Amounts;
    }
  >;
  /** What each wallet's own associated token accounts hold. */
  wallets: Record<'owner' | 'other', Amounts>;
};

export type WorldNames = {
  program: Address;
  config: Address;
  admin: Address;
  guardian: Address;
  keeper: Address;
  router: Address;
  priceOwner: Address;
  owner: Address;
  other: Address;
  /** A wallet that holds nothing and owns no vault. It has no account at all. */
  stranger: Address;
  mints: Record<MintName, Address>;
  vaults: Record<VaultName, Address>;
};

export type World = {
  names: WorldNames;
  expected: WorldExpected;
  /** Kept in memory only, for a caller that sends more transactions. */
  signers: { owner: KeyPairSigner; other: KeyPairSigner };
  mints: Record<MintName, TestMint>;
};

/** 2100-01-01: a multiplier scheduled for then is not in force in any test. */
const FAR_FUTURE = 4_102_444_800n;
const SOL = 1_000_000_000n;
const usdc = (dollars: bigint) => dollars * 1_000_000n;

async function createMint(
  ledger: Ledger,
  payer: TransactionSigner,
  options: {
    program: Address;
    decimals: number;
    extensions?: (i: Address, m: Address) => ExtensionArgs[];
  },
): Promise<TestMint> {
  const mint = await generateKeyPairSigner();
  const issuer = await generateKeyPairSigner();
  const extensions = options.extensions?.(issuer.address, mint.address) ?? [];
  const space = extensions.length ? BigInt(getMintSize(extensions)) : 82n;
  await ledger.send(payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: await ledger.rent(space),
      space,
      programAddress: options.program,
    }),
    ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
    getInitializeMint2Instruction(
      {
        mint: mint.address,
        decimals: options.decimals,
        mintAuthority: issuer.address,
        freezeAuthority: issuer.address,
      },
      { programAddress: options.program },
    ),
    ...getPostInitializeInstructionsForMintExtensions(mint.address, issuer, extensions),
  ]);
  return { address: mint.address, program: options.program, decimals: options.decimals, issuer };
}

/** Mints to the holder's associated token account, creating it if needed. */
async function mintTo(
  ledger: Ledger,
  payer: TransactionSigner,
  mint: TestMint,
  holder: Address,
  amount: bigint,
): Promise<void> {
  await ledger.send(payer, [
    await createAtaInstruction(payer, holder, mint),
    getMintToInstruction(
      { mint: mint.address, token: await ata(holder, mint), mintAuthority: mint.issuer, amount },
      { programAddress: mint.program },
    ),
  ]);
}

/**
 * Builds the world. `deployer` is the vault program's upgrade authority, holds SOL, and pays for
 * everything. `priceOwner` goes into Config as the program that must own a price account.
 */
export async function buildWorld(
  ledger: Ledger,
  deployer: TransactionSigner,
  priceOwner: Address = MOCK_ROUTER_PROGRAM,
): Promise<World> {
  const [owner, other, stranger, guardian, keeper] = await Promise.all(
    Array.from({ length: 5 }, () => generateKeyPairSigner()),
  );
  if (!owner || !other || !stranger || !guardian || !keeper) throw new Error('no keys');
  await ledger.send(deployer, [
    getTransferSolInstruction({ source: deployer, destination: owner.address, amount: 5n * SOL }),
    getTransferSolInstruction({ source: deployer, destination: other.address, amount: SOL }),
  ]);

  // The dollar token and gold on the classic token program; the stock tokens on Token-2022 with the
  // extension set SPYx carries on mainnet.
  const stock = { program: TOKEN_2022_PROGRAM, decimals: 8, extensions: stockExtensions };
  const mints: Record<MintName, TestMint> = {
    usdc: await createMint(ledger, deployer, { program: TOKEN_PROGRAM, decimals: 6 }),
    spyx: await createMint(ledger, deployer, stock),
    nvdax: await createMint(ledger, deployer, stock),
    gold: await createMint(ledger, deployer, { program: TOKEN_PROGRAM, decimals: 8 }),
    tslax: await createMint(ledger, deployer, stock),
  };
  // NVDAx has a new multiplier set for a far date: the one in force is still the first.
  const scheduled = 2.5;
  await ledger.send(deployer, [
    getUpdateMultiplierScaledUiMintInstruction({
      mint: mints.nvdax.address,
      authority: mints.nvdax.issuer,
      multiplier: scheduled,
      effectiveTimestamp: FAR_FUTURE,
    }),
  ]);

  await ledger.send(deployer, [
    await initConfigInstruction(deployer, {
      guardian: guardian.address,
      defaultKeeper: keeper.address,
      routerProgram: MOCK_ROUTER_PROGRAM,
      priceOwner,
      cashMint: mints.usdc.address,
      params: DEFAULT_PARAMS,
    }),
  ]);

  await mintTo(ledger, deployer, mints.usdc, owner.address, usdc(5_000n));
  await mintTo(ledger, deployer, mints.spyx, owner.address, 75_000_000n);
  await mintTo(ledger, deployer, mints.usdc, other.address, usdc(50n));

  const open = async (
    who: KeyPairSigner,
    basketId: bigint,
    targets: { mint: MintName; targetBps: number }[],
    autoFollow: boolean,
    deposit: bigint,
  ): Promise<Address> => {
    const vault = await vaultAddress(who.address, basketId);
    await ledger.send(who, [
      await createVaultInstruction({
        owner: who,
        basketId,
        targets: targets.map((t) => ({ mint: mints[t.mint].address, targetBps: t.targetBps })),
        autoFollow,
      }),
      await createAtaInstruction(who, vault, mints.usdc),
      await depositInstruction({ owner: who, vault, mint: mints.usdc, amount: deposit }),
    ]);
    return vault;
  };

  const targets = {
    following: [
      { mint: 'spyx', targetBps: 5000 },
      { mint: 'nvdax', targetBps: 3000 },
      { mint: 'gold', targetBps: 2000 },
    ],
    manual: [
      { mint: 'spyx', targetBps: 6000 },
      { mint: 'gold', targetBps: 4000 },
    ],
    // Less than the whole: the rest is cash. A zero weight is allowed.
    partial: [
      { mint: 'spyx', targetBps: 2500 },
      { mint: 'tslax', targetBps: 0 },
    ],
    others: [{ mint: 'gold', targetBps: 10_000 }],
  } satisfies Record<VaultName, { mint: MintName; targetBps: number }[]>;

  const vaults: Record<VaultName, Address> = {
    following: await open(owner, 1n, targets.following, true, usdc(1_000n)),
    manual: await open(owner, 2n, targets.manual, false, usdc(500n)),
    partial: await open(owner, 3n, targets.partial, true, usdc(100n)),
    others: await open(other, 1n, targets.others, false, usdc(50n)),
  };

  // The program cannot swap yet, so the first vault's assets are sent in from outside. Then the owner
  // takes some SPYx out, which makes the program record what is left, and more arrives after that: the
  // recorded number and the real balance now differ. NVDAx never gets a token account.
  await mintTo(ledger, deployer, mints.spyx, vaults.following, 250_000_000n);
  await mintTo(ledger, deployer, mints.gold, vaults.following, 125_000_000n);
  await ledger.send(owner, [
    await withdrawInstruction({
      owner,
      vault: vaults.following,
      mint: mints.spyx,
      amount: 50_000_000n,
    }),
  ]);
  await mintTo(ledger, deployer, mints.spyx, vaults.following, 30_000_000n);
  // A listed token sent to a vault that has no target on it: still the owner's to see and withdraw.
  await mintTo(ledger, deployer, mints.tslax, vaults.manual, 40_000_000n);

  const stockMint = { tokenProgram: 'token-2022', decimals: 8, scheduled: null } as const;
  const classic = { multiplier: null, scheduled: null } as const;
  return {
    names: {
      program: BASKET_PROGRAM,
      config: await configAddress(),
      admin: deployer.address,
      guardian: guardian.address,
      keeper: keeper.address,
      router: MOCK_ROUTER_PROGRAM,
      priceOwner,
      owner: owner.address,
      other: other.address,
      stranger: stranger.address,
      mints: {
        usdc: mints.usdc.address,
        spyx: mints.spyx.address,
        nvdax: mints.nvdax.address,
        gold: mints.gold.address,
        tslax: mints.tslax.address,
      },
      vaults,
    },
    expected: {
      mints: {
        usdc: { tokenProgram: 'token', decimals: 6, ...classic },
        spyx: { ...stockMint, multiplier: 1.003909 },
        nvdax: {
          ...stockMint,
          multiplier: 1.003909,
          scheduled: { multiplier: scheduled, effectiveAt: FAR_FUTURE.toString() },
        },
        gold: { tokenProgram: 'token', decimals: 8, ...classic },
        tslax: { ...stockMint, multiplier: 1.003909 },
      },
      vaults: {
        following: {
          owner: 'owner',
          basketId: '1',
          autoFollow: true,
          targets: targets.following,
          held: { usdc: usdc(1_000n).toString(), spyx: '230000000', gold: '125000000' },
          tracked: { spyx: '200000000', nvdax: '0', gold: '0' },
        },
        manual: {
          owner: 'owner',
          basketId: '2',
          autoFollow: false,
          targets: targets.manual,
          held: { usdc: usdc(500n).toString(), tslax: '40000000' },
          tracked: { spyx: '0', gold: '0' },
        },
        partial: {
          owner: 'owner',
          basketId: '3',
          autoFollow: true,
          targets: targets.partial,
          held: { usdc: usdc(100n).toString() },
          tracked: { spyx: '0', tslax: '0' },
        },
        others: {
          owner: 'other',
          basketId: '1',
          autoFollow: false,
          targets: targets.others,
          held: { usdc: usdc(50n).toString() },
          tracked: { gold: '0' },
        },
      },
      wallets: {
        owner: { usdc: usdc(3_400n).toString(), spyx: '125000000' },
        other: { usdc: '0' },
      },
    },
    signers: { owner, other },
    mints,
  };
}
