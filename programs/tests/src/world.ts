import { createHash } from 'node:crypto';
import {
  type Address,
  generateKeyPairSigner,
  getAddressEncoder,
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
  ASSET_KEEPER,
  assetsAddress,
  configAddress,
  createVaultInstruction,
  DEFAULT_PARAMS,
  depositInstruction,
  familyId,
  initAssetsInstruction,
  initConfigInstruction,
  PRICES_SIZE,
  publishRecipeInstruction,
  recipeAddress,
  setPriceAccountInstruction,
  updateRecipeInstruction,
  upsertAssetInstruction,
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
  /**
   * Moves the chain's clock forward by this many seconds, where the chain can: LiteSVM can and a
   * validator cannot. A second version of a shared portfolio needs one publish delay to pass, so it
   * is published only where this exists.
   */
  advanceClock?: (seconds: bigint) => bigint;
};

export type MintName = 'usdc' | 'spyx' | 'nvdax' | 'gold' | 'tslax';
export type VaultName = 'following' | 'manual' | 'partial' | 'others';
export type RecipeName = 'core';

type Weights = { mint: MintName; weightBps: number }[];

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
      /** The shared portfolio the vault follows, and the version whose weights it took. */
      recipe: RecipeName | null;
      acceptedVersion: number;
      targets: { mint: MintName; targetBps: number }[];
      /** What the vault's associated token accounts hold. */
      held: Amounts;
      /** What the program recorded in `Position.tracked`: a hint, and here it disagrees with `held`. */
      tracked: Amounts;
    }
  >;
  /** What each wallet's own associated token accounts hold. */
  wallets: Record<'owner' | 'other', Amounts>;
  recipes: Record<
    RecipeName,
    {
      /** 64 hex characters. */
      familyId: string;
      /** The version in effect. */
      active: { version: number; components: Weights };
      /** A version that is published and waits; its time is in unix seconds. Null on a chain whose
       * clock the script cannot move. */
      pending: { version: number; effectiveAt: string; components: Weights } | null;
    }
  >;
};

export type WorldNames = {
  program: Address;
  config: Address;
  admin: Address;
  guardian: Address;
  keeper: Address;
  router: Address;
  priceOwner: Address;
  /** The platform's asset list. */
  assets: Address;
  /** The wallet that published the shared portfolios. */
  creator: Address;
  owner: Address;
  other: Address;
  /** A wallet that holds nothing and owns no vault. It has no account at all. */
  stranger: Address;
  mints: Record<MintName, Address>;
  vaults: Record<VaultName, Address>;
  recipes: Record<RecipeName, Address>;
};

export type World = {
  names: WorldNames;
  expected: WorldExpected;
  /** Kept in memory only, for a caller that sends more transactions. */
  signers: { owner: KeyPairSigner; other: KeyPairSigner };
  mints: Record<MintName, TestMint>;
};

/**
 * The world's price account: round numbers at chosen indexes, so nobody reads one as a market price.
 * `age` is how old the entry is, in seconds, at the moment the account is written. An asset's
 * one-hour average sits at `twapIndex`, with the same value and the same age; the stock tokens are
 * at the entries of the real ones (fixtures/solana-vault/scope-indexes.json). Cash has an entry in
 * the account and none in the program's list, which never prices cash.
 */
export const WORLD_PRICES: Record<
  MintName,
  { index: number; twapIndex: number | null; value: bigint; exponent: bigint; age: number }
> = {
  usdc: { index: 13, twapIndex: null, value: 100_000_000n, exponent: 8n, age: 20 },
  spyx: { index: 344, twapIndex: 279, value: 10_000_000_000n, exponent: 8n, age: 30 },
  nvdax: { index: 332, twapIndex: 269, value: 500_000n, exponent: 4n, age: 45 },
  // Older than the 120 s the keeper accepts: the reader still reports it, with its age.
  gold: { index: 100, twapIndex: 101, value: 2_005n, exponent: 1n, age: 400 },
  tslax: { index: 338, twapIndex: 273, value: 20n, exponent: 0n, age: 0 },
};
/** An entry nobody wrote. */
export const WORLD_EMPTY_INDEX = 7;
/** The assets the admin has switched on for the keeper. TSLAx is listed and priced, and off. */
export const WORLD_KEEPER_ON: readonly MintName[] = ['spyx', 'nvdax', 'gold'];

/** The bytes of the world's price account in Scope's layout, each entry as old as `WORLD_PRICES`
 * says at `now`. `mappings` fills the header's second field, which nothing here reads. */
export function worldPriceAccount(slot: bigint, now: bigint, mappings: Address): Uint8Array {
  const data = new Uint8Array(PRICES_SIZE);
  // Scope's own header: Anchor's discriminator for `OraclePrices`, then the mappings account.
  data.set(createHash('sha256').update('account:OraclePrices').digest().subarray(0, 8), 0);
  data.set(getAddressEncoder().encode(mappings), 8);
  const view = new DataView(data.buffer);
  for (const { index, twapIndex, value, exponent, age } of Object.values(WORLD_PRICES))
    for (const entry of twapIndex === null ? [index] : [index, twapIndex]) {
      const at = 40 + 56 * entry;
      view.setBigUint64(at, value, true);
      view.setBigUint64(at + 8, exponent, true);
      view.setBigUint64(at + 16, slot, true);
      view.setBigUint64(at + 24, now - BigInt(age), true);
    }
  return data;
}

/** The world's prices as the fixture states them, by name. */
export function worldPricesExpected() {
  const decimal = (value: bigint, exponent: bigint) => {
    const digits = value.toString().padStart(Number(exponent) + 1, '0');
    const whole = digits.slice(0, digits.length - Number(exponent));
    const frac = digits.slice(digits.length - Number(exponent)).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  };
  return Object.fromEntries(
    Object.entries(WORLD_PRICES).map(([name, p]) => [
      name,
      {
        index: p.index,
        usdPerToken: decimal(p.value, p.exponent),
        ageSeconds: p.age,
        twapIndex: p.twapIndex,
        keeperOn: WORLD_KEEPER_ON.includes(name as MintName),
      },
    ]),
  ) as Record<
    MintName,
    {
      index: number;
      usdPerToken: string;
      ageSeconds: number;
      twapIndex: number | null;
      keeperOn: boolean;
    }
  >;
}

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
 * everything. `priceAccount` is an account in Scope's layout that already exists and that
 * `priceOwner` owns: the asset list names it, and `priceOwner` goes into Config as the program that
 * must own a price account.
 */
export async function buildWorld(
  ledger: Ledger,
  deployer: TransactionSigner,
  priceAccount: Address,
  priceOwner: Address = MOCK_ROUTER_PROGRAM,
): Promise<World> {
  const [owner, other, stranger, guardian, keeper, creator] = await Promise.all(
    Array.from({ length: 6 }, () => generateKeyPairSigner()),
  );
  if (!owner || !other || !stranger || !guardian || !keeper || !creator) throw new Error('no keys');
  await ledger.send(deployer, [
    getTransferSolInstruction({ source: deployer, destination: owner.address, amount: 5n * SOL }),
    getTransferSolInstruction({ source: deployer, destination: other.address, amount: SOL }),
    getTransferSolInstruction({ source: deployer, destination: creator.address, amount: SOL }),
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

  // The platform's list: the four assets, each with its price entry and its average in the one
  // price account, the stock tokens on US hours. Cash is never a position, so it is not listed.
  await ledger.send(deployer, [
    await initAssetsInstruction(deployer),
    await setPriceAccountInstruction(deployer, 0, priceAccount),
    ...(await Promise.all(
      (['spyx', 'nvdax', 'gold', 'tslax'] as const).map((name) =>
        upsertAssetInstruction(deployer, mints[name].address, {
          priceKind: 1,
          priceIndex: WORLD_PRICES[name].index,
          twapIndex: WORLD_PRICES[name].twapIndex ?? 0,
          session: name === 'gold' ? 0 : 1,
          flags: WORLD_KEEPER_ON.includes(name) ? ASSET_KEEPER : 0,
        }),
      ),
    )),
  ]);

  await mintTo(ledger, deployer, mints.usdc, owner.address, usdc(5_000n));
  await mintTo(ledger, deployer, mints.spyx, owner.address, 75_000_000n);
  await mintTo(ledger, deployer, mints.usdc, other.address, usdc(50n));

  // One shared portfolio, published by its creator. Its first version is in effect at once.
  const core = {
    family: familyId('core'),
    first: [
      { mint: 'spyx', weightBps: 5000 },
      { mint: 'nvdax', weightBps: 3000 },
      { mint: 'gold', weightBps: 2000 },
    ],
    // Moves 10% of the portfolio into an asset the first version did not hold.
    second: [
      { mint: 'spyx', weightBps: 4000 },
      { mint: 'nvdax', weightBps: 3000 },
      { mint: 'gold', weightBps: 2000 },
      { mint: 'tslax', weightBps: 1000 },
    ],
  } satisfies { family: Uint8Array; first: Weights; second: Weights };
  const components = (weights: Weights) =>
    weights.map((w) => ({ mint: mints[w.mint].address, weightBps: w.weightBps }));
  const coreAddress = await recipeAddress(creator.address, core.family);
  await ledger.send(creator, [
    await publishRecipeInstruction({
      creator,
      familyId: core.family,
      components: components(core.first),
    }),
  ]);

  const open = async (
    who: KeyPairSigner,
    basketId: bigint,
    targets: { mint: MintName; targetBps: number }[],
    autoFollow: boolean,
    deposit: bigint,
    follows?: { recipe: Address; version: number },
  ): Promise<Address> => {
    const vault = await vaultAddress(who.address, basketId);
    await ledger.send(who, [
      await createVaultInstruction({
        owner: who,
        basketId,
        // A vault that follows takes the weights of the version in effect, not targets of its own.
        targets: follows
          ? []
          : targets.map((t) => ({ mint: mints[t.mint].address, targetBps: t.targetBps })),
        recipe: follows?.recipe,
        expectedVersion: follows?.version ?? 0,
        autoFollow,
      }),
      await createAtaInstruction(who, vault, mints.usdc),
      await depositInstruction({ owner: who, vault, mint: mints.usdc, amount: deposit }),
    ]);
    return vault;
  };

  const targets = {
    // What the vault copies from the shared portfolio it follows.
    following: core.first.map((w) => ({ mint: w.mint, targetBps: w.weightBps })),
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
    following: await open(owner, 1n, targets.following, true, usdc(1_000n), {
      recipe: coreAddress,
      version: 1,
    }),
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

  // The creator publishes a second version once one publish delay has passed. It waits another
  // delay before it is in effect, so the first vault sees it as pending, with an asset it has not
  // accepted. Only where the script can move the clock.
  let pending: WorldExpected['recipes'][RecipeName]['pending'] = null;
  if (ledger.advanceClock) {
    const publishedAt = ledger.advanceClock(BigInt(DEFAULT_PARAMS.publishDelayS));
    await ledger.send(creator, [
      await updateRecipeInstruction({
        creator,
        recipe: coreAddress,
        components: components(core.second),
      }),
    ]);
    pending = {
      version: 2,
      effectiveAt: (publishedAt + BigInt(DEFAULT_PARAMS.publishDelayS)).toString(),
      components: core.second,
    };
  }

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
      assets: await assetsAddress(),
      creator: creator.address,
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
      recipes: { core: coreAddress },
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
          recipe: 'core',
          acceptedVersion: 1,
          targets: targets.following,
          held: { usdc: usdc(1_000n).toString(), spyx: '230000000', gold: '125000000' },
          tracked: { spyx: '200000000', nvdax: '0', gold: '0' },
        },
        manual: {
          owner: 'owner',
          basketId: '2',
          autoFollow: false,
          recipe: null,
          acceptedVersion: 0,
          targets: targets.manual,
          held: { usdc: usdc(500n).toString(), tslax: '40000000' },
          tracked: { spyx: '0', gold: '0' },
        },
        partial: {
          owner: 'owner',
          basketId: '3',
          autoFollow: true,
          recipe: null,
          acceptedVersion: 0,
          targets: targets.partial,
          held: { usdc: usdc(100n).toString() },
          tracked: { spyx: '0', tslax: '0' },
        },
        others: {
          owner: 'other',
          basketId: '1',
          autoFollow: false,
          recipe: null,
          acceptedVersion: 0,
          targets: targets.others,
          held: { usdc: usdc(50n).toString() },
          tracked: { gold: '0' },
        },
      },
      wallets: {
        owner: { usdc: usdc(3_400n).toString(), spyx: '125000000' },
        other: { usdc: '0' },
      },
      recipes: {
        core: {
          familyId: Buffer.from(core.family).toString('hex'),
          active: { version: 1, components: core.first },
          pending,
        },
      },
    },
    signers: { owner, other },
    mints,
  };
}
