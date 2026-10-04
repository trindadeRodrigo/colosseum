import {
  AccountRole,
  type Address,
  address,
  createAddressWithSeed,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountWithSeedInstruction } from '@solana-program/system';
import {
  type ExtensionArgs,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
} from '@solana-program/token-2022';
import {
  ASSET_KEEPER,
  type AssetArgs,
  assetsAddress,
  configAddress,
  decodeAssets,
  decodeConfig,
  initAssetsInstruction,
  initConfigInstruction,
  type Params,
  setDefaultKeeperInstruction,
  setGuardianInstruction,
  setParamsInstruction,
  setPriceAccountInstruction,
  upsertAssetInstruction,
} from '../basket';
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  BASKET_PROGRAM,
  MOCK_ROUTER_PROGRAM,
  programDataAddress,
  SYSTEM_PROGRAM,
} from '../env';
import {
  decodePair,
  decodeRouter,
  initPricedPairInstruction,
  initPricesInstruction,
  initRouterInstruction,
  PRICES_BYTES,
  type PricedPair,
  pairAddress,
  routerAddress,
  setPricedPairInstruction,
  setPriceWriterInstruction,
  writePriceInstruction,
} from '../mock-router';
import { stockExtensions, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, tokenMetadata } from '../tokens';
import type { Chain } from './chain';
import { type SetupPlan, scaled, slugOf, type TokenPlan } from './config';

// Sets up everything a Solana test network needs after the two programs are deployed: the test
// tokens, the test exchange with its price account, pairs and reserves, the vault program's Config
// and asset list, and the platform's lookup table. It never calls `launch()`.
//
// Every step looks at the chain first and sends only what is missing, so a second run sends
// nothing. Every address but the lookup table's follows from the key that runs it: the mints and
// the price account are made with `create_account_with_seed`, so no other key exists anywhere.

const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ZERO = address('11111111111111111111111111111111');
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export type Named = { name: string; instruction: Instruction };

export type SetupOptions = {
  /** Print what would be sent, and send nothing. */
  dryRun: boolean;
  log: (line: string) => void;
  /** The lookup table an earlier run made, from the deployment file. */
  lookupTable?: Address | null;
  /** LiteSVM keeps no slot hashes, which a lookup table needs to be made: the suite leaves it out. */
  withLookupTable?: boolean;
  /** Extensions of the stock set to leave out, by name, should a cluster's token program refuse one. */
  omitExtensions?: string[];
};

export type DeployedToken = {
  id: string;
  symbol: string;
  name: string;
  modelOf: string;
  kind: TokenPlan['kind'];
  mint: Address;
  tokenProgram: 'token' | 'token-2022';
  decimals: number;
  /** The exchange's reserve of it. */
  reserve: Address;
};

export type DeployedAsset = DeployedToken & {
  session: 0 | 1;
  priceIndex: number;
  twapIndex: number;
  indexSource: TokenPlan['indexSource'];
  maxWeightBps: number;
  keeperOn: boolean;
  /** In millionths of a dollar for one whole token. */
  range: { minPrice: string; maxPrice: string } | null;
  spreadBps: number;
  /** The exchange's two pairs against the dollar token. */
  pairs: { buy: Address; sell: Address };
};

export type Deployment = {
  network: string;
  chain: 'solana';
  /** Everything here is a test network's: no figure from it is shown as live. */
  provenance: 'sandbox';
  genesisHash: string | null;
  programs: { basket: Address; mockRouter: Address };
  accounts: {
    config: Address;
    assets: Address;
    priceAccount: Address;
    router: Address;
    lookupTable: Address | null;
  };
  roles: {
    admin: Address;
    guardian: Address;
    defaultKeeper: Address;
    /** The program that owns the price account: the test exchange. */
    priceOwner: Address;
    /** The exchange's admin, who sets pairs and writes prices. */
    exchangeAdmin: Address;
    priceWriter: Address | null;
    /** Mint, freeze and every extension authority of each test token. */
    tokenAuthority: Address;
  };
  params: Params;
  cash: DeployedToken;
  assets: DeployedAsset[];
};

/** A chain's entry in the SDK guard's deployment file (`SolanaEntry` in packages/sdk): the vault
 * program, the one router, the cash asset, and every asset's mint with its token program. The
 * guard's file holds one such entry per chain of a network, and nothing else of what is above. */
export type GuardSolanaEntry = {
  family: 'solana';
  program: Address;
  router: Address;
  cash: string;
  assets: Record<string, { mint: Address; tokenProgram: 'token' | 'token-2022' }>;
};

export function guardSolanaEntry(deployment: Deployment): GuardSolanaEntry {
  return {
    family: 'solana',
    program: deployment.programs.basket,
    router: deployment.programs.mockRouter,
    cash: deployment.cash.id,
    assets: Object.fromEntries(
      [deployment.cash, ...deployment.assets].map((token) => [
        token.id,
        { mint: token.mint, tokenProgram: token.tokenProgram },
      ]),
    ),
  };
}

export type SetupResult = {
  /** Transactions sent, or in a dry run the transactions that would be. */
  transactions: number;
  deployment: Deployment;
};

const programOf = (token: TokenPlan) =>
  token.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;

/** Where a test token's mint is: an address of the admin's, by a seed that names the token. */
export const mintAddress = (admin: Address, token: TokenPlan) =>
  createAddressWithSeed({
    baseAddress: admin,
    seed: `test-mint:${slugOf(token.id)}`,
    programAddress: programOf(token),
  });

/** Where the exchange's price account is. */
export const pricesAddress = (admin: Address) =>
  createAddressWithSeed({
    baseAddress: admin,
    seed: 'test-prices',
    programAddress: MOCK_ROUTER_PROGRAM,
  });

async function ataOf(holder: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({ owner: holder, mint, tokenProgram });
  return pda;
}

const u64At = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

const PROGRAM_NAMES: Record<string, string> = {
  [SYSTEM_PROGRAM]: 'system',
  [TOKEN_PROGRAM]: 'token',
  [TOKEN_2022_PROGRAM]: 'token-2022',
  [ASSOCIATED_TOKEN_PROGRAM]: 'associated-token',
  [ADDRESS_LOOKUP_TABLE_PROGRAM]: 'lookup-table',
  [BASKET_PROGRAM]: 'basket',
  [MOCK_ROUTER_PROGRAM]: 'mock_router',
};

/** One instruction as text: the program, what it does, every account with what it may do, the data. */
function describe({ name, instruction }: Named): string[] {
  const program = PROGRAM_NAMES[instruction.programAddress] ?? instruction.programAddress;
  const data = Buffer.from(instruction.data ?? []).toString('hex');
  const accounts = (instruction.accounts ?? []).map((meta) => {
    const marks = `${isSignerRole(meta.role) ? 's' : '-'}${isWritableRole(meta.role) ? 'w' : '-'}`;
    return `${marks} ${meta.address}`;
  });
  return [
    `    ${program}: ${name}`,
    ...accounts.map((line) => `      ${line}`),
    `      data ${data.length / 2} bytes: ${data.length > 160 ? `${data.slice(0, 160)}…` : data}`,
  ];
}

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size),
  );

// ---- the lookup table program, by hand: two instructions, in its own encoding ----

const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};
const u64 = (value: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const joined = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

async function lookupTableAddress(authority: Address, recentSlot: bigint) {
  return getProgramDerivedAddress({
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM,
    seeds: [addressEncoder.encode(authority), u64(recentSlot)],
  });
}

function createLookupTableInstruction(
  admin: TransactionSigner,
  table: Address,
  recentSlot: bigint,
  bump: number,
): Instruction {
  return {
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin } as never,
      { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: joined(u32(0), u64(recentSlot), new Uint8Array([bump])),
  };
}

function extendLookupTableInstruction(
  admin: TransactionSigner,
  table: Address,
  addresses: Address[],
): Instruction {
  return {
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin } as never,
      { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: joined(
      u32(2),
      u64(BigInt(addresses.length)),
      ...addresses.map((entry) => new Uint8Array(addressEncoder.encode(entry))),
    ),
  };
}

/** The addresses a lookup table holds: 32 bytes each after a 56-byte header. */
function lookupTableAddresses(data: Uint8Array): Address[] {
  const out: Address[] = [];
  for (let at = 56; at + 32 <= data.length; at += 32)
    out.push(addressDecoder.decode(data.slice(at, at + 32)));
  return out;
}

// ---- the set-up ----

export async function setUp(
  chain: Chain,
  admin: TransactionSigner,
  plan: SetupPlan,
  options: SetupOptions,
): Promise<SetupResult> {
  const { log, dryRun } = options;
  let transactions = 0;
  /** One transaction: printed, then sent unless this is a dry run. */
  const run = async (title: string, named: Named[]): Promise<void> => {
    transactions += 1;
    log(`#${transactions} ${title}`);
    for (const one of named) for (const line of describe(one)) log(line);
    if (dryRun) {
      log('    not sent: dry run');
      return;
    }
    const { signature, bytes } = await chain.send(
      admin,
      named.map((one) => one.instruction),
    );
    log(`    sent: ${signature} (${bytes} bytes)`);
  };
  const have = (title: string) => log(`ok  ${title}`);

  const guardian = plan.roles.guardian === 'admin' ? admin.address : plan.roles.guardian;
  const defaultKeeper =
    plan.roles.defaultKeeper === 'admin' ? admin.address : plan.roles.defaultKeeper;

  // 0. The two programs are there, and this key may initialise them.
  for (const [name, program] of [
    ['basket', BASKET_PROGRAM],
    ['mock_router', MOCK_ROUTER_PROGRAM],
  ] as const) {
    const programData = await chain.account(await programDataAddress(program));
    if (!programData) {
      if (!dryRun) throw new Error(`the ${name} program is not deployed at ${program}`);
      log(
        `!!  the ${name} program is not deployed at ${program}: everything below is planned only`,
      );
      continue;
    }
    // Variant (u32), slot (u64), then Option<Pubkey>: the upgrade authority.
    const authority =
      programData.data[12] === 1 ? addressDecoder.decode(programData.data.slice(13, 45)) : null;
    have(`${name} is deployed at ${program}; upgrade authority ${authority ?? 'none'}`);
  }

  // 1. The test tokens.
  const all = [plan.cash, ...plan.tokens];
  const mints = new Map<string, Address>();
  for (const token of all) mints.set(token.id, await mintAddress(admin.address, token));
  const mintOf = (token: TokenPlan) => mints.get(token.id) as Address;
  for (const token of all) {
    const mint = mintOf(token);
    const program = programOf(token);
    const found = await chain.account(mint);
    if (found) {
      if (found.owner !== program)
        throw new Error(
          `${token.symbol}: ${mint} exists and is not a mint of ${token.tokenProgram}`,
        );
      if (found.data[44] !== token.decimals)
        throw new Error(`${token.symbol}: the mint at ${mint} has ${found.data[44]} decimals`);
      have(`${token.symbol} (${token.modelOf}) is mint ${mint}`);
      continue;
    }
    const omitted = new Set(options.omitExtensions ?? []);
    const base: ExtensionArgs[] = token.stockExtensions
      ? stockExtensions(admin.address, mint, token.multiplier).filter((e) => !omitted.has(e.__kind))
      : [];
    // The name sits in the mint itself, after the other extensions, and is written after the mint
    // is initialised: the account is made at the size without it and paid for at the size with it.
    const named: ExtensionArgs[] = token.stockExtensions
      ? [...base, tokenMetadata(admin.address, mint, token.name, token.symbol)]
      : [];
    const space = BigInt(base.length ? getMintSize(base) : 82);
    const paidFor = BigInt(named.length ? getMintSize(named) : 82);
    await run(`the test token ${token.symbol}, standing in for ${token.modelOf}: mint ${mint}`, [
      {
        name: `create_account_with_seed ("test-mint:${slugOf(token.id)}", ${space} bytes)`,
        instruction: getCreateAccountWithSeedInstruction({
          payer: admin,
          newAccount: mint,
          baseAccount: admin,
          base: admin.address,
          seed: `test-mint:${slugOf(token.id)}`,
          amount: await chain.rent(paidFor),
          space,
          programAddress: program,
        }),
      },
      ...getPreInitializeInstructionsForMintExtensions(mint, named).map((instruction, i) => ({
        name: `extension ${i + 1} of the stock token's set`,
        instruction,
      })),
      {
        name: `initialize_mint (${token.decimals} decimals; mint and freeze authority: the admin)`,
        instruction: getInitializeMint2Instruction(
          {
            mint,
            decimals: token.decimals,
            mintAuthority: admin.address,
            freezeAuthority: admin.address,
          },
          { programAddress: program },
        ),
      },
      ...getPostInitializeInstructionsForMintExtensions(mint, admin, named).map((instruction) => ({
        name: `token metadata: "${token.name}", "${token.symbol}"`,
        instruction,
      })),
    ]);
  }

  // 2. The exchange, and 3. its price account.
  const router = await routerAddress();
  const prices = await pricesAddress(admin.address);
  const routerAccount = await chain.account(router);
  const routerState = routerAccount ? decodeRouter(routerAccount.data) : null;
  if (routerState) {
    if (routerState.admin !== admin.address)
      throw new Error(`the exchange's admin is ${routerState.admin}, not the key running this`);
    have(`the exchange is initialised: ${router}`);
  } else {
    await run(`the test exchange: ${router}`, [
      { name: 'init_router', instruction: await initRouterInstruction(admin) },
    ]);
  }
  if (routerState && routerState.prices === prices) {
    have(`the exchange's price account is ${prices}`);
  } else {
    if (routerState && routerState.prices !== ZERO)
      throw new Error(`the exchange already has another price account: ${routerState.prices}`);
    const exists = await chain.account(prices);
    await run(`the exchange's price account, in Scope's layout: ${prices}`, [
      ...(exists
        ? []
        : [
            {
              name: `create_account_with_seed ("test-prices", ${PRICES_BYTES} bytes, for the exchange)`,
              instruction: getCreateAccountWithSeedInstruction({
                payer: admin,
                newAccount: prices,
                baseAccount: admin,
                base: admin.address,
                seed: 'test-prices',
                amount: await chain.rent(PRICES_BYTES),
                space: PRICES_BYTES,
                programAddress: MOCK_ROUTER_PROGRAM,
              }),
            },
          ]),
      { name: 'init_prices', instruction: await initPricesInstruction(admin, prices) },
    ]);
  }

  // 4. The key that copies prices onto the network, if the config names one.
  const priceWriter = plan.roles.priceWriter;
  if (priceWriter && routerState?.priceWriter !== priceWriter) {
    await run(`the price writer: ${priceWriter}`, [
      {
        name: 'set_price_writer',
        instruction: await setPriceWriterInstruction(admin, priceWriter),
      },
    ]);
  } else if (priceWriter) {
    have(`the price writer is ${priceWriter}`);
  }

  // 5. A first price for every token that has none. A price that is there is never overwritten:
  // from the first copy on, the prices belong to the job that copies them.
  const pricesAccount = await chain.account(prices);
  const unpriced = plan.tokens.filter(
    (token) => !pricesAccount || u64At(pricesAccount.data, 40 + 56 * token.priceIndex) === 0n,
  );
  const now = await chain.now();
  for (const batch of chunks(unpriced, 6)) {
    await run(
      `first prices: ${batch.map((t) => `${t.symbol} ${t.initialPrice.usd}`).join(', ')}`,
      await Promise.all(
        batch.map(async (token) => {
          const entry = {
            value: scaled(token.initialPrice.usd, 8),
            exponent: 8n,
            unixTimestamp: now,
          };
          return {
            name: `write_price ${token.symbol}: entries ${token.priceIndex} and ${token.twapIndex} (${token.initialPrice.method}; ${token.initialPrice.source})`,
            instruction: await writePriceInstruction(admin, prices, {
              priceIndex: token.priceIndex,
              twapIndex: token.twapIndex,
              price: entry,
              twap: entry,
            }),
          };
        }),
      ),
    );
  }
  if (!unpriced.length) have('every token has a price entry');

  // 6. A pair each way per token against the dollar, at the price account's price less a spread.
  const cashMint = mintOf(plan.cash);
  const pairSteps: Named[] = [];
  const pairs = new Map<string, { buy: Address; sell: Address }>();
  for (const token of plan.tokens) {
    const mint = mintOf(token);
    const sides = [
      { way: 'buy', mintIn: cashMint, mintOut: mint, assetIsInput: false },
      { way: 'sell', mintIn: mint, mintOut: cashMint, assetIsInput: true },
    ] as const;
    pairs.set(token.id, {
      buy: await pairAddress(cashMint, mint),
      sell: await pairAddress(mint, cashMint),
    });
    for (const side of sides) {
      const wanted: PricedPair = {
        assetIsInput: side.assetIsInput,
        priceIndex: token.priceIndex,
        spreadBps: token.spreadBps,
      };
      const account = await chain.account(await pairAddress(side.mintIn, side.mintOut));
      const what = `${token.symbol} ${side.way}: entry ${wanted.priceIndex}, spread ${wanted.spreadBps} bps`;
      if (!account) {
        pairSteps.push({
          name: `init_priced_pair ${what}`,
          instruction: await initPricedPairInstruction(admin, side.mintIn, side.mintOut, wanted),
        });
        continue;
      }
      const pair = decodePair(account.data);
      const same =
        pair.kind === 1 &&
        pair.assetIsInput === wanted.assetIsInput &&
        pair.priceIndex === wanted.priceIndex &&
        pair.spreadBps === wanted.spreadBps;
      if (!same)
        pairSteps.push({
          name: `set_priced_pair ${what}`,
          instruction: await setPricedPairInstruction(admin, side.mintIn, side.mintOut, wanted),
        });
    }
  }
  for (const batch of chunks(pairSteps, 4)) await run("the exchange's pairs", batch);
  if (!pairSteps.length) have(`${plan.tokens.length * 2} pairs are listed as the config says`);

  // 7. The exchange's reserves, filled by the admin, who holds every test token's mint authority.
  const reserves = new Map<string, Address>();
  const fills: { token: TokenPlan; named: Named[] }[] = [];
  for (const token of all) {
    const mint = mintOf(token);
    const program = programOf(token);
    const reserve = await ataOf(router, mint, program);
    reserves.set(token.id, reserve);
    const account = await chain.account(reserve);
    const held = account ? u64At(account.data, 64) : 0n;
    // Topped up when it has fallen under half of what the config asks for.
    if (account && held * 2n >= token.reserveRaw) continue;
    fills.push({
      token,
      named: [
        {
          name: `the exchange's reserve of ${token.symbol}: ${reserve}`,
          instruction: getCreateAssociatedTokenIdempotentInstruction({
            payer: admin,
            ata: reserve,
            owner: router,
            mint,
            tokenProgram: program,
          }),
        },
        {
          name: `mint_to the reserve: ${token.reserveRaw - held} raw units of ${token.symbol}`,
          instruction: getMintToInstruction(
            { mint, token: reserve, mintAuthority: admin, amount: token.reserveRaw - held },
            { programAddress: program },
          ),
        },
      ],
    });
  }
  for (const batch of chunks(fills, 3))
    await run(
      `reserves: ${batch.map((f) => f.token.symbol).join(', ')}`,
      batch.flatMap((f) => f.named),
    );
  if (!fills.length) have('every reserve holds at least half of what the config asks for');

  // 8. The vault program's Config.
  const config = await configAddress();
  const configAccount = await chain.account(config);
  if (!configAccount) {
    await run(`the vault program's Config: ${config}`, [
      {
        name: `init_config (loss cap ${plan.params.lossCapBps} bps; guardian ${guardian}; default keeper ${defaultKeeper}; router and price owner: the test exchange)`,
        instruction: await initConfigInstruction(admin, {
          guardian,
          defaultKeeper,
          routerProgram: MOCK_ROUTER_PROGRAM,
          priceOwner: MOCK_ROUTER_PROGRAM,
          cashMint,
          params: plan.params,
        }),
      },
    ]);
  } else {
    const state = decodeConfig(configAccount.data);
    const fixed = [
      ['admin', state.admin, admin.address],
      ['cash mint', state.cashMint, cashMint],
      ['router', state.routerProgram, MOCK_ROUTER_PROGRAM],
      ['price owner', state.priceOwner, MOCK_ROUTER_PROGRAM],
    ] as const;
    for (const [what, is, wanted] of fixed)
      if (is !== wanted)
        throw new Error(
          `Config's ${what} is ${is}, and this set-up wants ${wanted}: change it by hand`,
        );
    const changes: Named[] = [];
    if (state.guardian !== guardian)
      changes.push({
        name: `set_guardian ${guardian}`,
        instruction: await setGuardianInstruction(admin, guardian),
      });
    if (state.defaultKeeper !== defaultKeeper)
      changes.push({
        name: `set_default_keeper ${defaultKeeper}`,
        instruction: await setDefaultKeeperInstruction(admin, defaultKeeper),
      });
    const moved = (Object.keys(plan.params) as (keyof Params)[]).filter(
      (key) => state[key] !== plan.params[key],
    );
    if (moved.length)
      changes.push({
        name: `set_params (${moved.map((key) => `${key} ${state[key]} to ${plan.params[key]}`).join(', ')})`,
        instruction: await setParamsInstruction(admin, plan.params),
      });
    if (changes.length) await run('Config follows the config file', changes);
    else have(`Config is as the config file says: ${config}`);
  }

  // 9. The asset list, 10. its price account, 11. the tokens, and the keeper's switch on each.
  const assets = await assetsAddress();
  const assetsAccount = await chain.account(assets);
  const registry = assetsAccount ? decodeAssets(assetsAccount.data) : null;
  const first: Named[] = [];
  if (!registry)
    first.push({ name: 'init_assets', instruction: await initAssetsInstruction(admin) });
  if (registry?.priceAccounts[0] !== prices)
    first.push({
      name: `set_price_account(0): ${prices}`,
      instruction: await setPriceAccountInstruction(admin, 0, prices),
    });
  if (first.length) await run(`the asset list: ${assets}`, first);
  else have(`the asset list names the price account: ${assets}`);

  const entryOf = (token: TokenPlan) =>
    registry?.assets.find((entry) => entry.mint === mintOf(token)) ?? null;
  const listing = (token: TokenPlan): Partial<AssetArgs> => ({
    priceSlot: 0,
    priceIndex: token.priceIndex,
    twapIndex: token.twapIndex,
    priceKind: 1,
    session: token.session,
    maxWeightBps: token.maxWeightBps,
  });
  const matches = (token: TokenPlan, flags: number, min: bigint, max: bigint) => {
    const entry = entryOf(token);
    return (
      !!entry &&
      entry.priceSlot === 0 &&
      entry.priceIndex === token.priceIndex &&
      entry.twapIndex === token.twapIndex &&
      entry.priceKind === 1 &&
      entry.session === token.session &&
      entry.maxWeightBps === token.maxWeightBps &&
      entry.flags === flags &&
      entry.minPrice === min &&
      entry.maxPrice === max
    );
  };
  // Listed first with the keeper off and no range; a second transaction switches on what the
  // config gives a range to.
  const unlisted = plan.tokens.filter((token) => !entryOf(token));
  for (const batch of chunks(unlisted, 6))
    await run(
      `listed, keeper off: ${batch.map((t) => t.symbol).join(', ')}`,
      await Promise.all(
        batch.map(async (token) => ({
          name: `upsert_asset ${token.symbol}: entries ${token.priceIndex} and ${token.twapIndex}, session ${token.session}, ceiling ${token.maxWeightBps} bps, flags 0`,
          instruction: await upsertAssetInstruction(admin, mintOf(token), listing(token)),
        })),
      ),
    );
  const switches = plan.tokens.filter((token) => {
    const [flags, min, max] = token.range
      ? [ASSET_KEEPER, token.range.minPrice, token.range.maxPrice]
      : [0, 0n, 0n];
    // A token listed a moment ago has the keeper off and no range.
    return entryOf(token) ? !matches(token, flags, min, max) : token.range !== null;
  });
  for (const batch of chunks(switches, 6))
    await run(
      `the keeper's switch: ${batch.map((t) => `${t.symbol} ${t.range ? 'on' : 'off'}`).join(', ')}`,
      await Promise.all(
        batch.map(async (token) => ({
          name: token.range
            ? `upsert_asset ${token.symbol}: flags 1, range ${token.range.minPrice} to ${token.range.maxPrice} millionths of a dollar`
            : `upsert_asset ${token.symbol}: flags 0, no range`,
          instruction: await upsertAssetInstruction(admin, mintOf(token), {
            ...listing(token),
            flags: token.range ? ASSET_KEEPER : 0,
            minPrice: token.range?.minPrice ?? 0n,
            maxPrice: token.range?.maxPrice ?? 0n,
          }),
        })),
      ),
    );
  if (!unlisted.length && !switches.length)
    have(`${plan.tokens.length} tokens are listed as the config says`);

  // 12. The platform's lookup table: what every vault transaction on this network names.
  const wanted: Address[] = [
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    BASKET_PROGRAM,
    MOCK_ROUTER_PROGRAM,
    config,
    assets,
    prices,
    router,
    cashMint,
    reserves.get(plan.cash.id) as Address,
    ...plan.tokens.flatMap((token) => {
      const pair = pairs.get(token.id) as { buy: Address; sell: Address };
      return [mintOf(token), pair.buy, pair.sell, reserves.get(token.id) as Address];
    }),
  ];
  let lookupTable = options.lookupTable ?? null;
  if (options.withLookupTable ?? true) {
    const existing = lookupTable ? await chain.account(lookupTable) : null;
    if (lookupTable && !existing) {
      log(
        `!!  the lookup table ${lookupTable} of the deployment file is not on this cluster: a new one is made`,
      );
      lookupTable = null;
    }
    const held = new Set(existing ? lookupTableAddresses(existing.data) : []);
    const missing = wanted.filter((entry) => !held.has(entry));
    if (!lookupTable) {
      const recentSlot = await chain.slot();
      const [table, bump] = await lookupTableAddress(admin.address, recentSlot);
      lookupTable = table;
      await run(`the platform's lookup table: ${table}`, [
        {
          name: `create_lookup_table (recent slot ${recentSlot})`,
          instruction: createLookupTableInstruction(admin, table, recentSlot, bump),
        },
      ]);
    }
    for (const batch of chunks(missing, 20))
      await run(`${batch.length} addresses into the lookup table`, [
        {
          name: 'extend_lookup_table',
          instruction: extendLookupTableInstruction(admin, lookupTable, batch),
        },
      ]);
    if (!missing.length)
      have(`the lookup table holds all ${wanted.length} addresses: ${lookupTable}`);
  }

  const deployed = (token: TokenPlan): DeployedToken => ({
    id: token.id,
    symbol: token.symbol,
    name: token.name,
    modelOf: token.modelOf,
    kind: token.kind,
    mint: mintOf(token),
    tokenProgram: token.tokenProgram,
    decimals: token.decimals,
    reserve: reserves.get(token.id) as Address,
  });
  const deployment: Deployment = {
    network: plan.network,
    chain: 'solana',
    provenance: 'sandbox',
    genesisHash: null,
    programs: { basket: BASKET_PROGRAM, mockRouter: MOCK_ROUTER_PROGRAM },
    accounts: { config, assets, priceAccount: prices, router, lookupTable },
    roles: {
      admin: admin.address,
      guardian,
      defaultKeeper,
      priceOwner: MOCK_ROUTER_PROGRAM,
      exchangeAdmin: admin.address,
      priceWriter,
      tokenAuthority: admin.address,
    },
    params: plan.params,
    cash: deployed(plan.cash),
    assets: plan.tokens.map((token) => ({
      ...deployed(token),
      session: token.session,
      priceIndex: token.priceIndex,
      twapIndex: token.twapIndex,
      indexSource: token.indexSource,
      maxWeightBps: token.maxWeightBps,
      keeperOn: token.range !== null,
      range: token.range && {
        minPrice: token.range.minPrice.toString(),
        maxPrice: token.range.maxPrice.toString(),
      },
      spreadBps: token.spreadBps,
      pairs: pairs.get(token.id) as { buy: Address; sell: Address },
    })),
  };
  log(
    transactions === 0
      ? 'nothing to send: the network is as the config says'
      : `${transactions} transaction${transactions === 1 ? '' : 's'} ${dryRun ? 'would be sent' : 'sent'}`,
  );
  return { transactions, deployment };
}
