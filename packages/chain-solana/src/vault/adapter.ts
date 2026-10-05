import {
  AcceptVersionArgs,
  type AssetId,
  BuiltTx,
  type ChainAdapter,
  ChainError,
  type ChainErrorCode,
  CreateVaultArgs,
  DepositArgs,
  type LegKind,
  OwnerSwapArgs,
  PublishRecipeArgs,
  type Quote,
  SetAutoFollowArgs,
  SetTargetsArgs,
  SolanaAddress,
  Targets,
  Trade,
  type TradeMinimum,
  WithdrawInKindArgs,
} from '@colosseum/schemas';
import { type Address, type Commitment, getAddressDecoder, type IInstruction } from '@solana/kit';
import { z } from 'zod';
import {
  type AssetRegistryAccount,
  assetsAddress,
  type ConfigAccount,
  configAddress,
  decodeAssetRegistry,
  decodeConfig,
  decodeRecipe,
  decodeVault,
  isAccount,
  type RecipeAccount,
  recipeAddress,
  type VaultAccount,
  vaultAddress,
  versionsAt,
  ZERO_ADDRESS,
} from './accounts';
import {
  type Composed,
  compose,
  lookupRouterAccounts,
  type PriorityFee,
  type Watch,
} from './compose';
import { priceAccountOf } from './keeper';
import { type ClusterClock, decodeClock, SYSVAR_CLOCK } from './prices';
import {
  acceptVersionInstruction,
  adoptVersionInstruction,
  type ComponentLine,
  cancelPendingInstruction,
  createTokenAccountInstruction,
  createVaultInstruction,
  depositInstruction,
  keeperLegInstruction,
  ownerSwapInstruction,
  type ProgramAccounts,
  publishRecipeInstruction,
  type SwapSides,
  setAutoFollowInstruction,
  setTargetsInstruction,
  syncBalancesInstruction,
  type TargetLine,
  type TokenRef,
  updateRecipeInstruction,
  withdrawInstruction,
} from './program';
import {
  createSolanaVaultReader,
  type SolanaVaultReader,
  type SolanaVaultReaderOptions,
} from './reader';
import {
  JUPITER_PROGRAM,
  type JupiterOptions,
  jupiter,
  type Routed,
  type RouteSource,
  testExchange,
} from './routes';
import { getAccounts, type RawAccount, type VaultWriteRpc } from './rpc';
import { createSolanaProbe } from './send';
import {
  associatedTokenAddress,
  decodeMint,
  decodeTokenAccount,
  isTokenProgram,
  type MintInfo,
} from './tokens';
import { unlistedAssetId, unlistedMint } from './unlisted';

// The Solana adapter whole (DESIGN-VAULT 3.2): the reader of ADS-1, the builders, the quotes and the
// probe. Every builder returns one unsigned transaction, simulated against the chain as it is, with
// its compute budget sized from that simulation and a preview of what it changes. It holds no key and
// signs nothing. What a builder writes is what the guard of packages/sdk takes (design section 9): the
// owner as the one signer and fee payer; the vault program's instructions for the step, in order; a
// "create if missing" for the owner's or the vault's account of a token the step moves; one compute
// unit limit and at most one price; every named account in the message itself, and only a swap's
// router accounts read through a lookup table.

/** The only extra instructions a step's transaction may hold: these and nothing else. */
const OWNER_SWAP_FIXED_ACCOUNTS = 11;
const KEEPER_LEG_FIXED_ACCOUNTS = 12;
/** An address lookup table: a 56-byte header, then the addresses. */
const LOOKUP_TABLE_HEADER = 56;
const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111' as Address;

export type SolanaVaultAdapterOptions = Omit<SolanaVaultReaderOptions, 'rpc'> & {
  rpc: VaultWriteRpc;
  /**
   * Where trades are priced and routed. Left out: Jupiter's build endpoint when the config's router is
   * Jupiter's program, and the test exchange of programs/mock-router for any other router.
   */
  routes?: RouteSource;
  /** For Jupiter's build endpoint: its address, a key and a fetch, all from the caller. */
  jupiter?: JupiterOptions;
  /** The slippage `quote()` takes off the quoted output for its `minOutRaw`. Default 100 bps. */
  quoteSlippageBps?: number;
  /** The price of a compute unit, and the most a priority fee may add. Default: the recent fees, capped. */
  priority?: PriorityFee;
};

export type CancelPendingArgs = { signer: string; recipeOnchainId: string };

/** The adapter whole, with the steps the shared interface does not name. */
export type SolanaVaultAdapter = ChainAdapter &
  SolanaVaultReader & {
    /**
     * Takes back the version of a shared portfolio that waits, signed by its creator or the guardian.
     * Built as a `publish` step: it is the registry's, like the publish it undoes.
     */
    buildCancelPending(a: CancelPendingArgs): Promise<BuiltTx>;
    /**
     * Writes what the vault's own token accounts hold into what the program has recorded, signed by
     * the vault's keeper (the default) or its owner. A keeper leg values the positions it does not
     * trade by the recorded amounts (`KeeperPosition.needsSync`). Built as a `keeper_leg` step.
     */
    buildSyncBalances(vault: string, signer?: string): Promise<BuiltTx>;
    /**
     * `buildWithdrawInKind`, with what could not be built and why: a token whose account is frozen,
     * one with a transfer hook program, one the chain refuses to move (paused by its issuer). Every
     * other token is still built.
     */
    buildWithdrawEach(a: WithdrawInKindArgs): Promise<WithdrawEach>;
  };

export type WithdrawEach = {
  txs: BuiltTx[];
  notBuilt: { asset: AssetId; code: ChainErrorCode; message: string }[];
};

const refuse = (code: ChainErrorCode, message: string): never => {
  throw new ChainError(code, message);
};

/** Parses an argument and turns a schema failure into BadInput. The message names fields, not values. */
function input<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues.map((i) =>
    i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
  );
  throw new ChainError('BadInput', `${what}: ${[...new Set(where)].slice(0, 3).join('; ')}`);
}

/** Nothing but a ChainError leaves a builder: anything else is a bug or a broken account. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ChainError) throw e;
    const error = new ChainError('Unknown', e instanceof Error ? e.message : 'the build failed');
    error.cause = e;
    throw error;
  }
}

const bytesOfHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/** An address lookup table's addresses, from its account. */
function lookupTableAddresses(account: RawAccount): Address[] {
  const decoder = getAddressDecoder();
  const out: Address[] = [];
  for (let at = LOOKUP_TABLE_HEADER; at + 32 <= account.data.length; at += 32)
    out.push(decoder.decode(account.data.subarray(at, at + 32)));
  return out;
}

export function createSolanaVaultAdapter(options: SolanaVaultAdapterOptions): SolanaVaultAdapter {
  const { config, rpc } = options;
  const commitment: Commitment = options.commitment ?? 'confirmed';
  const now = options.now ?? (() => new Date());
  const trade = options.trade ?? 'live';
  const reader = createSolanaVaultReader({ ...options, trade });
  const program = reader.program;
  const provenance = reader.provenance;
  const probe = createSolanaProbe({ rpc, program, commitment });
  const quoteSlippageBps = options.quoteSlippageBps ?? 100;

  const assets = options.assets;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const byMint = new Map(assets.map((a) => [a.address, a]));
  const cash = assets.find((a) => a.cls === 'cash');
  if (!cash) throw new Error('the asset list needs exactly one cash token');

  const router = config.router as Address | null;
  const routes: RouteSource | null =
    options.routes ??
    (router === JUPITER_PROGRAM
      ? jupiter(options.jupiter)
      : router
        ? testExchange({ rpc, router, commitment, now })
        : null);

  let fixed: Promise<ProgramAccounts> | undefined;
  const programAccounts = () => {
    fixed ??= Promise.all([configAddress(program), assetsAddress(program)]).then(
      ([configAt, assetsAt]) => ({ program, config: configAt, assets: assetsAt }),
    );
    return fixed;
  };

  // ---- reading what a build needs ----

  type Chain = {
    onchain: ConfigAccount;
    clock: ClusterClock;
    registry: AssetRegistryAccount | null;
    extra: (RawAccount | null)[];
  };

  /** Config, the clock and the program's asset list, with `extra` read in the same call. */
  async function chainNow(extra: Address[] = []): Promise<Chain> {
    const p = await programAccounts();
    const accounts = await getAccounts(
      rpc,
      [p.config, SYSVAR_CLOCK, p.assets, ...extra],
      commitment,
    );
    const configAccount = accounts[0];
    if (
      !configAccount ||
      configAccount.owner !== program ||
      !isAccount('config', configAccount.data)
    )
      throw new ChainError(
        'Unavailable',
        `the vault program ${program} has no Config on ${config.networkName}`,
        false,
      );
    const list = accounts[2];
    return {
      onchain: decodeConfig(configAccount.data),
      clock: decodeClock(accounts[1] ?? null),
      registry:
        list && list.owner === program && isAccount('assets', list.data)
          ? decodeAssetRegistry(list.data)
          : null,
      extra: accounts.slice(3),
    };
  }

  /** A vault of this program at the address, or VaultNotFound. */
  function vaultFrom(address: Address, account: RawAccount | null | undefined): VaultAccount {
    if (!account || account.owner !== program || !isAccount('vault', account.data))
      return refuse('VaultNotFound', `there is no vault at ${address}`);
    return decodeVault(account.data);
  }

  function recipeFrom(address: Address, account: RawAccount | null | undefined): RecipeAccount {
    if (!account || account.owner !== program || !isAccount('recipe', account.data))
      return refuse('RecipeNotFound', `no shared portfolio at ${address}`);
    return decodeRecipe(account.data);
  }

  /** The token program of each mint, read once: a mint never changes program. */
  const programs = new Map<string, Address>();
  const mintInfos = new Map<string, MintInfo>();
  async function tokens(mints: Address[]): Promise<Map<string, TokenRef>> {
    const missing = [...new Set(mints)].filter((m) => !programs.has(m));
    if (missing.length) {
      const found = await getAccounts(rpc, missing, commitment);
      missing.forEach((mint, i) => {
        const account = found[i];
        if (!account || !isTokenProgram(account.owner))
          refuse('MintNotAccepted', `there is no mint at ${mint}`);
        mintInfos.set(
          mint,
          decodeMint((account as RawAccount).owner, (account as RawAccount).data),
        );
        programs.set(mint, (account as RawAccount).owner);
      });
    }
    return new Map(mints.map((m) => [m, { mint: m, tokenProgram: programs.get(m) as Address }]));
  }
  async function token(mint: Address): Promise<TokenRef> {
    return (await tokens([mint])).get(mint) as TokenRef;
  }

  /** The mint of an asset by id: a listed one, or one the app does not list, by the id made from its mint. */
  function mintOf(id: AssetId): Address {
    const listed = byId.get(id);
    if (listed) return listed.address as Address;
    return unlistedMint(id) ?? refuse('MintNotAccepted', `${id} is not an asset on Solana`);
  }
  const idOf = (mint: Address): AssetId => byMint.get(mint)?.id ?? unlistedAssetId(mint);

  /** Target lines of a vault: listed assets only, never cash. */
  function targetLines(targets: { asset: AssetId; weightBps: number }[]): TargetLine[] {
    return targets.map((t) => {
      const asset = byId.get(t.asset);
      if (!asset || asset.id === cash?.id)
        return refuse(
          'MintNotAccepted',
          `${t.asset} is ${asset ? 'the cash token, which is never a target' : 'not a listed asset'}`,
        );
      return { mint: asset.address as Address, targetBps: t.weightBps };
    });
  }

  /** What a holder's associated token account of a token holds, and whether the account is there. */
  async function holdings(pairs: { holder: Address; token: TokenRef }[]) {
    const addresses = await Promise.all(
      pairs.map(({ holder, token: t }) => associatedTokenAddress(holder, t.mint, t.tokenProgram)),
    );
    const accounts = await getAccounts(rpc, addresses, commitment);
    return pairs.map(({ holder, token: t }, i) => {
      const account = accounts[i];
      const address = addresses[i] as Address;
      if (!account || account.owner !== t.tokenProgram)
        return { address, exists: false, amount: 0n, frozen: false };
      const decoded = decodeTokenAccount(account.data);
      const own = decoded.mint === t.mint && decoded.owner === holder;
      return { address, exists: own, amount: own ? decoded.amount : 0n, frozen: decoded.frozen };
    });
  }

  // ---- one transaction ----

  async function built(a: {
    kind: LegKind;
    signer: Address;
    instructions: IInstruction[];
    watch: Watch[];
    summary: string;
    minimums: TradeMinimum[];
    routed?: Routed;
  }): Promise<BuiltTx & { composed: Composed }> {
    const composed = await compose({
      rpc,
      program,
      feePayer: a.signer,
      instructions: a.instructions,
      watch: a.watch,
      priority: options.priority,
      commitment,
    });
    const tx = BuiltTx.parse({
      chain: 'solana',
      chainId: 'solana',
      legKind: a.kind,
      signer: a.signer,
      payload: composed.payload,
      description: a.summary,
      provenance,
      lastValidBlockHeight: Number(composed.lastValidBlockHeight),
      messageHash: composed.messageHash,
      preview: {
        source: `simulation of the transaction on ${config.networkName}, vault program ${program}${
          a.routed ? `; route from ${a.routed.source}` : ''
        }`,
        method: `simulateTransaction against the chain as it is; balances of the token accounts it touches before and after; compute budget ${composed.computeUnitLimit} units, a fifth over the ${composed.unitsConsumed} the simulation used${
          a.routed ? `; ${a.routed.method}` : ''
        }`,
        fetchedAt: now().toISOString(),
        provenance,
        summary: a.summary,
        simulated: true,
        feeNativeRaw: composed.feeLamports.toString(),
        changes: composed.changes,
        minimums: a.minimums,
      },
    });
    // The figures behind the bytes stay with the adapter's own callers (tests, scripts, the keeper);
    // the order layer reads the shared shape only.
    Object.defineProperty(tx, 'composed', { value: composed, enumerable: false });
    return tx as BuiltTx & { composed: Composed };
  }

  const noNonce = (nonce: number | undefined) => {
    if (nonce !== undefined)
      refuse('NotSupported', 'Solana has no nonce: a transaction expires with its blockhash');
  };
  const builds = () => {
    if (trade !== 'live')
      refuse('NotSupported', `${config.name} is read-only here: nothing is built`);
  };

  /** The route of one trade inside a vault, and the lookup tables its accounts may be read through. */
  async function routeFor(vault: Address, sides: SwapSides, amountIn: bigint, slippageBps: number) {
    if (!routes)
      return refuse('RouterNotAllowed', `no router is set for Solana on ${config.networkName}`);
    const routed = await routes.route({
      input: sides.input,
      output: sides.output,
      amountIn,
      taker: vault,
      takerInput: sides.vaultInput,
      takerOutput: sides.vaultOutput,
      slippageBps,
    });
    const tables = routed.lookupTables.length
      ? (await getAccounts(rpc, routed.lookupTables, commitment)).flatMap((account, i) =>
          account && account.owner === LOOKUP_TABLE_PROGRAM
            ? [
                {
                  address: routed.lookupTables[i] as Address,
                  addresses: lookupTableAddresses(account),
                },
              ]
            : [],
        )
      : [];
    return { routed, tables };
  }

  /**
   * What a trade may buy: the chain's cash or a listed asset. A token the app does not list may be sold
   * out of a vault, never bought into one (the program refuses it too).
   */
  const buyable = (id: AssetId) => {
    if (!byId.has(id)) refuse('MintNotAccepted', `${id} is not a listed asset: it is not bought`);
  };

  /** Both sides of a trade inside a vault, as the vault holds them. */
  async function sidesOf(vault: Address, t: Trade): Promise<SwapSides> {
    const [sell, buy] = [mintOf(t.sell), mintOf(t.buy)];
    const refs = await tokens([sell, buy]);
    const input = refs.get(sell) as TokenRef;
    const output = refs.get(buy) as TokenRef;
    return {
      input,
      output,
      vaultInput: await associatedTokenAddress(vault, input.mint, input.tokenProgram),
      vaultOutput: await associatedTokenAddress(vault, output.mint, output.tokenProgram),
    };
  }

  /** Every address the transaction names for itself: those keep their place in the message. */
  const namedIn = (ixs: IInstruction[], signer: Address, fixedCount: number) =>
    new Set<Address>([
      signer,
      ...ixs.flatMap((ix, n) => [
        ix.programAddress,
        ...(ix.accounts ?? [])
          .filter((_, i) => n < ixs.length - 1 || i < fixedCount)
          .map((m) => m.address),
      ]),
    ]);

  const amountOf = (raw: string, what: string) => {
    const n = BigInt(raw);
    if (n === 0n) refuse('BadInput', `${what}: nothing to move`);
    if (n > 0xffff_ffff_ffff_ffffn) refuse('BadInput', `${what}: more than a token can hold`);
    return n;
  };

  const solanaAddress = (value: unknown, what: string) =>
    input(SolanaAddress, value, what) as Address;

  // ---- the builders ----

  const adapter: SolanaVaultAdapter = {
    ...reader,
    ...probe,
    capabilities: reader.capabilities,

    buildApprove: () =>
      guarded(async () =>
        refuse(
          'NotSupported',
          'Solana needs no approval: the deposit moves cash inside the program',
        ),
      ),

    buildCreateVault: (args) =>
      guarded(async () => {
        const a = input(CreateVaultArgs, args, 'create');
        noNonce(a.nonce);
        builds();
        if (a.trades?.length)
          refuse('NotSupported', 'on Solana a create carries no trade: each buy is its own step');
        const owner = solanaAddress(a.owner, 'owner');
        const basketId = BigInt(a.basketId);
        const vault = await vaultAddress(program, owner, basketId);
        const recipe = a.recipeOnchainId
          ? solanaAddress(a.recipeOnchainId, 'recipeOnchainId')
          : null;
        if (recipe && a.targets.length)
          refuse(
            'BadInput',
            'targets: a vault that follows a shared portfolio takes none of its own',
          );
        if (!recipe && a.targets.length) input(Targets, a.targets, 'targets');
        const chain = await chainNow([vault, ...(recipe ? [recipe] : [])]);
        if (chain.extra[0])
          refuse('VaultExists', `plan ${a.basketId} of ${owner} has a vault already`);
        // A vault that follows takes the version in effect by the cluster's clock, unless the person
        // named the one they saw: the program refuses any other (`VersionMismatch`).
        const expectedVersion = recipe
          ? (a.expectedVersion ??
            versionsAt(recipeFrom(recipe, chain.extra[1]), chain.clock.unixTimestamp).active
              .version)
          : 0;
        const deposit = BigInt(a.depositRaw ?? '0');
        const cashToken = await token(chain.onchain.cashMint);
        const [wallet, held] = await holdings([
          { holder: owner, token: cashToken },
          { holder: vault, token: cashToken },
        ]);
        if (deposit > (wallet?.frozen ? 0n : (wallet?.amount ?? 0n)))
          refuse('NotFunded', `the wallet holds less cash than the ${deposit} to deposit`);
        const p = await programAccounts();
        const vaultCash = held?.address as Address;
        const instructions = [
          createVaultInstruction(p, {
            owner,
            vault,
            basketId,
            targets: recipe ? [] : targetLines(a.targets),
            autoFollow: a.autoFollow,
            expectedVersion,
            ...(recipe ? { recipe } : {}),
          }),
          createTokenAccountInstruction({
            payer: owner,
            account: vaultCash,
            holder: vault,
            token: cashToken,
          }),
          ...(deposit > 0n
            ? [
                depositInstruction(p, {
                  owner,
                  vault,
                  cash: cashToken,
                  vaultAccount: vaultCash,
                  source: wallet?.address as Address,
                  amount: deposit,
                }),
              ]
            : []),
        ];
        const cashId = idOf(chain.onchain.cashMint);
        return built({
          kind: 'create_vault',
          signer: owner,
          instructions,
          watch: [
            { holder: 'wallet', asset: cashId, account: wallet?.address as Address },
            { holder: 'vault', asset: cashId, account: vaultCash },
          ],
          summary: `Open the vault of plan ${a.basketId}${
            recipe ? `, following shared portfolio ${recipe} at version ${expectedVersion}` : ''
          }${a.autoFollow ? ', auto-follow on' : ''}${deposit > 0n ? `, and deposit ${deposit} raw ${cashId}` : ''}`,
          minimums: [],
        });
      }),

    buildDeposit: (args) =>
      guarded(async () => {
        const a = input(DepositArgs, args, 'deposit');
        noNonce(a.nonce);
        builds();
        if (a.trades?.length)
          refuse('NotSupported', 'on Solana a deposit carries no trade: each buy is its own step');
        const vault = solanaAddress(a.vault, 'vault');
        const amount = amountOf(a.amountRaw, 'amountRaw');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        const cashToken = await token(chain.onchain.cashMint);
        const [wallet, held] = await holdings([
          { holder: state.owner, token: cashToken },
          { holder: vault, token: cashToken },
        ]);
        if (amount > (wallet?.frozen ? 0n : (wallet?.amount ?? 0n)))
          refuse('NotFunded', `the wallet holds less cash than the ${amount} to deposit`);
        const p = await programAccounts();
        const vaultCash = held?.address as Address;
        const cashId = idOf(chain.onchain.cashMint);
        return built({
          kind: 'deposit',
          signer: state.owner,
          instructions: [
            ...(held?.exists
              ? []
              : [
                  createTokenAccountInstruction({
                    payer: state.owner,
                    account: vaultCash,
                    holder: vault,
                    token: cashToken,
                  }),
                ]),
            depositInstruction(p, {
              owner: state.owner,
              vault,
              cash: cashToken,
              vaultAccount: vaultCash,
              source: wallet?.address as Address,
              amount,
            }),
          ],
          watch: [
            { holder: 'wallet', asset: cashId, account: wallet?.address as Address },
            { holder: 'vault', asset: cashId, account: vaultCash },
          ],
          summary: `Deposit ${amount} raw ${cashId} into vault ${vault}`,
          minimums: [],
        });
      }),

    buildOwnerSwap: (args) =>
      guarded(async () => {
        const a = input(OwnerSwapArgs, args, 'swap');
        noNonce(a.nonce);
        builds();
        if (a.trades.length > reader.capabilities.maxTradesPerTx)
          refuse('TooManyTrades', 'a Solana transaction carries one trade');
        const t = a.trades[0] as Trade;
        buyable(t.buy);
        const vault = solanaAddress(a.vault, 'vault');
        const amount = amountOf(t.amountInRaw, 'amountInRaw');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        const sides = await sidesOf(vault, t);
        const [have, out] = await holdings([
          { holder: vault, token: sides.input },
          { holder: vault, token: sides.output },
        ]);
        if (amount > (have?.amount ?? 0n))
          refuse('SpentTooMuch', `the vault holds less ${t.sell} than the ${amount} to sell`);
        const { routed, tables } = await routeFor(vault, sides, amount, a.slippageBps);
        const minOut = (routed.outRaw * BigInt(10_000 - a.slippageBps)) / 10_000n;
        const p = await programAccounts();
        const head = out?.exists
          ? []
          : [
              createTokenAccountInstruction({
                payer: state.owner,
                account: sides.vaultOutput,
                holder: vault,
                token: sides.output,
              }),
            ];
        const swap = ownerSwapInstruction(p, {
          owner: state.owner,
          vault,
          sides,
          maxIn: amount,
          minOut,
          route: routed.route,
        });
        const instructions = [...head, swap];
        const named = namedIn(instructions, state.owner, OWNER_SWAP_FIXED_ACCOUNTS);
        return built({
          kind: 'swap',
          signer: state.owner,
          instructions: [
            ...head,
            lookupRouterAccounts(swap, OWNER_SWAP_FIXED_ACCOUNTS, tables, named),
          ],
          watch: [
            { holder: 'vault', asset: t.sell, account: sides.vaultInput },
            { holder: 'vault', asset: t.buy, account: sides.vaultOutput },
          ],
          summary: `Sell ${amount} raw ${t.sell} for at least ${minOut} raw ${t.buy} in vault ${vault}`,
          minimums: [
            { sell: t.sell, buy: t.buy, inRaw: amount.toString(), minOutRaw: minOut.toString() },
          ],
          routed,
        });
      }),

    buildSetTargets: (args) =>
      guarded(async () => {
        const a = input(SetTargetsArgs, args, 'targets');
        noNonce(a.nonce);
        builds();
        const vault = solanaAddress(a.vault, 'vault');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        const p = await programAccounts();
        return built({
          kind: 'set_targets',
          signer: state.owner,
          instructions: [
            setTargetsInstruction(p, {
              owner: state.owner,
              vault,
              targets: targetLines(a.targets),
            }),
          ],
          watch: [],
          summary: `Set the targets of vault ${vault}: ${a.targets
            .map((t) => `${t.asset} ${t.weightBps} bps`)
            .join(', ')}; it stops following and auto-follow goes off`,
          minimums: [],
        });
      }),

    buildAcceptVersion: (args) =>
      guarded(async () => {
        const a = input(AcceptVersionArgs, args, 'accept');
        noNonce(a.nonce);
        builds();
        const vault = solanaAddress(a.vault, 'vault');
        const recipe = solanaAddress(a.recipeOnchainId, 'recipeOnchainId');
        const chain = await chainNow([vault, recipe]);
        const state = vaultFrom(vault, chain.extra[0]);
        recipeFrom(recipe, chain.extra[1]);
        const p = await programAccounts();
        try {
          return await built({
            kind: 'accept_version',
            signer: state.owner,
            instructions: [
              acceptVersionInstruction(p, {
                owner: state.owner,
                vault,
                recipe,
                expectedVersion: a.expectedVersion,
              }),
            ],
            watch: [],
            summary: `Accept version ${a.expectedVersion} of shared portfolio ${recipe} in vault ${vault}`,
            minimums: [],
          });
        } catch (e) {
          // The version and what the vault still holds of the assets it drops do not fit sixteen lines.
          // Clearing a leftover in the same transaction is not something the guard lets the owner sign:
          // it takes an accept on its own. So the owner sells or withdraws a leftover first.
          if (e instanceof ChainError && e.code === 'InvalidTargets')
            throw new ChainError(
              'InvalidTargets',
              'the version and the assets the vault still holds of the ones it drops do not fit 16 lines: sell or withdraw a leftover first, then accept',
            );
          throw e;
        }
      }),

    buildSetAutoFollow: (args) =>
      guarded(async () => {
        const a = input(SetAutoFollowArgs, args, 'auto-follow');
        noNonce(a.nonce);
        builds();
        const vault = solanaAddress(a.vault, 'vault');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        const p = await programAccounts();
        return built({
          kind: 'set_auto_follow',
          signer: state.owner,
          instructions: [setAutoFollowInstruction(p, { owner: state.owner, vault, on: a.on })],
          watch: [],
          summary: `Switch auto-follow ${a.on ? 'on' : 'off'} for vault ${vault}`,
          minimums: [],
        });
      }),

    buildWithdrawInKind: (args) =>
      guarded(async () => {
        const { txs, notBuilt } = await withdrawEach(args);
        // Something the owner asked for that cannot be built, and nothing that can: say why.
        const first = notBuilt[0];
        if (txs.length === 0 && first)
          throw new ChainError(first.code, `${first.asset}: ${first.message}`);
        return txs;
      }),

    buildWithdrawEach: (args) => guarded(() => withdrawEach(args)),

    buildPublishRecipe: (args) =>
      guarded(async () => {
        const a = input(PublishRecipeArgs, args, 'publish');
        noNonce(a.nonce);
        builds();
        const creator = solanaAddress(a.creator, 'creator');
        const r = a.recipe;
        if (r.chain !== 'solana')
          refuse('BadInput', 'recipe.chain: a Solana recipe is published on Solana');
        if (r.creator !== creator)
          refuse('BadInput', 'recipe.creator: the creator signs the publish');
        const familyId = bytesOfHex(r.familyId);
        const recipe = await recipeAddress(program, creator, familyId);
        if (r.onchainId !== null && r.onchainId !== recipe)
          refuse(
            'BadInput',
            'recipe.onchainId: not the shared portfolio of this creator and family',
          );
        const components: ComponentLine[] = r.components.map((c) => {
          if (c.kind !== 'asset') return refuse('BadInput', 'a shared portfolio lists assets only');
          const asset = byId.get(c.asset);
          if (!asset) return refuse('MintNotAccepted', `${c.asset} is not a listed asset`);
          return { mint: asset.address as Address, weightBps: c.weightBps };
        });
        const chain = await chainNow([recipe]);
        const exists = Boolean(chain.extra[0]);
        if (exists) recipeFrom(recipe, chain.extra[0]);
        const p = await programAccounts();
        const metaHash = bytesOfHex(r.metaHash);
        return built({
          kind: 'publish',
          signer: creator,
          instructions: [
            exists
              ? updateRecipeInstruction(p, { creator, recipe, components, metaHash })
              : publishRecipeInstruction(p, { creator, recipe, familyId, components, metaHash }),
          ],
          watch: [],
          summary: exists
            ? `Publish the next version of shared portfolio ${recipe}: it waits the publish delay`
            : `Publish shared portfolio ${recipe}, version 1, in effect at once`,
          minimums: [],
        });
      }),

    buildCancelPending: (args) =>
      guarded(async () => {
        const a = input(
          z.object({ signer: SolanaAddress, recipeOnchainId: SolanaAddress }),
          args,
          'cancel',
        );
        builds();
        const signer = a.signer as Address;
        const recipe = a.recipeOnchainId as Address;
        const chain = await chainNow([recipe]);
        recipeFrom(recipe, chain.extra[0]);
        const p = await programAccounts();
        return built({
          kind: 'publish',
          signer,
          instructions: [cancelPendingInstruction(p, { signer, recipe })],
          watch: [],
          summary: `Take back the version of shared portfolio ${recipe} that waits`,
          minimums: [],
        });
      }),

    buildAdoptVersion: (vaultArg) =>
      guarded(async () => {
        builds();
        const vault = solanaAddress(vaultArg, 'vault');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        if (!state.autoFollow) refuse('AutoFollowOff', `vault ${vault} has auto-follow off`);
        if (state.recipe === ZERO_ADDRESS)
          refuse('NotFollowing', `vault ${vault} follows no shared portfolio`);
        const keeper = state.keeper === ZERO_ADDRESS ? chain.onchain.defaultKeeper : state.keeper;
        const p = await programAccounts();
        return built({
          kind: 'adopt_version',
          signer: keeper,
          instructions: [adoptVersionInstruction(p, { vault, recipe: state.recipe })],
          watch: [],
          summary: `Adopt the version in effect of shared portfolio ${state.recipe} in vault ${vault}`,
          minimums: [],
        });
      }),

    buildKeeperLeg: (vaultArg, tradeArg) =>
      guarded(async () => {
        builds();
        const vault = solanaAddress(vaultArg, 'vault');
        const t = input(Trade, tradeArg, 'trade');
        const amount = amountOf(t.amountInRaw, 'amountInRaw');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        const keeper = state.keeper === ZERO_ADDRESS ? chain.onchain.defaultKeeper : state.keeper;
        const sides = await sidesOf(vault, t);
        const cashMint = chain.onchain.cashMint;
        const buying = sides.input.mint === cashMint;
        if (buying === (sides.output.mint === cashMint))
          refuse('NotCashLeg', 'a keeper leg trades cash for one asset, or one asset for cash');
        const asset = buying ? sides.output.mint : sides.input.mint;
        if (!state.positions.some((x) => x.mint === asset))
          refuse('MintNotAccepted', `${idOf(asset)} is not a position of vault ${vault}`);
        // A leg values the positions it does not trade by what the program has recorded. Where a record
        // and the account differ (a clawback, a gift, a token sent in), the leg would trade on figures
        // that are not the vault's: refused until the keeper decides to sync (KEEP-1). Syncing here
        // would also record a stranger's gift, which is the keeper's call and not the builder's.
        const records = await tokens(state.positions.map((x) => x.mint));
        const actual = await holdings(
          state.positions.map((x) => ({ holder: vault, token: records.get(x.mint) as TokenRef })),
        );
        const stale = state.positions.filter((x, i) => (actual[i]?.amount ?? 0n) !== x.tracked);
        if (stale.length)
          refuse(
            'AccountTampered',
            `vault ${vault} holds other amounts than the program records for ${stale
              .map((x) => idOf(x.mint))
              .join(
                ', ',
              )}: a leg would value it wrongly. Sync its balances first (buildSyncBalances), if the keeper's policy takes what is there`,
          );
        const entry = chain.registry?.assets.find((e) => e.mint === asset);
        const priceAccount = entry && chain.registry ? priceAccountOf(entry, chain.registry) : null;
        if (!priceAccount)
          refuse('AssetNotPriced', `the asset list names no price account for ${idOf(asset)}`);
        const [, out] = await holdings([
          { holder: vault, token: sides.input },
          { holder: vault, token: sides.output },
        ]);
        const { routed, tables } = await routeFor(vault, sides, amount, 0);
        const p = await programAccounts();
        const head = out?.exists
          ? []
          : [
              createTokenAccountInstruction({
                payer: keeper,
                account: sides.vaultOutput,
                holder: vault,
                token: sides.output,
              }),
            ];
        const leg = keeperLegInstruction(p, {
          keeper,
          vault,
          sides,
          amountIn: amount,
          priceAccount: priceAccount as Address,
          route: routed.route,
        });
        const named = namedIn([...head, leg], keeper, KEEPER_LEG_FIXED_ACCOUNTS);
        return built({
          kind: 'keeper_leg',
          signer: keeper,
          instructions: [
            ...head,
            lookupRouterAccounts(leg, KEEPER_LEG_FIXED_ACCOUNTS, tables, named),
          ],
          watch: [
            { holder: 'vault', asset: t.sell, account: sides.vaultInput },
            { holder: 'vault', asset: t.buy, account: sides.vaultOutput },
          ],
          // The program works the least it accepts out from the reference price: the bytes carry none.
          summary: `Keeper: sell ${amount} raw ${t.sell} for ${t.buy} in vault ${vault}, toward its target`,
          minimums: [],
          routed,
        });
      }),

    buildSyncBalances: (vaultArg, signerArg) =>
      guarded(async () => {
        builds();
        const vault = solanaAddress(vaultArg, 'vault');
        const chain = await chainNow([vault]);
        const state = vaultFrom(vault, chain.extra[0]);
        const keeper = state.keeper === ZERO_ADDRESS ? chain.onchain.defaultKeeper : state.keeper;
        const signer = signerArg === undefined ? keeper : solanaAddress(signerArg, 'signer');
        if (signer !== keeper && signer !== state.owner)
          refuse('NotKeeper', "only the vault's keeper or its owner records its balances");
        const refs = await tokens(state.positions.map((x) => x.mint));
        const found = await holdings(
          state.positions.map((x) => ({ holder: vault, token: refs.get(x.mint) as TokenRef })),
        );
        const p = await programAccounts();
        return built({
          kind: 'keeper_leg',
          signer,
          instructions: [
            syncBalancesInstruction(p, {
              signer,
              vault,
              accounts: found.filter((h) => h.exists).map((h) => h.address),
            }),
          ],
          watch: [],
          summary: `Record what vault ${vault} holds of each of its positions`,
          minimums: [],
        });
      }),

    quote: (tradeArg, takerArg) =>
      guarded(async (): Promise<Quote> => {
        const t = input(Trade, tradeArg, 'trade');
        const taker = solanaAddress(takerArg, 'taker');
        const amount = amountOf(t.amountInRaw, 'amountInRaw');
        buyable(t.buy);
        if (!routes)
          return refuse('RouterNotAllowed', `no router is set for Solana on ${config.networkName}`);
        const [sell, buy] = [mintOf(t.sell), mintOf(t.buy)];
        const refs = await tokens([sell, buy]);
        const input_ = refs.get(sell) as TokenRef;
        const output = refs.get(buy) as TokenRef;
        const routed = await routes.route({
          input: input_,
          output,
          amountIn: amount,
          taker,
          takerInput: await associatedTokenAddress(taker, input_.mint, input_.tokenProgram),
          takerOutput: await associatedTokenAddress(taker, output.mint, output.tokenProgram),
          slippageBps: quoteSlippageBps,
        });
        const minOut = (routed.outRaw * BigInt(10_000 - quoteSlippageBps)) / 10_000n;
        // The cost is measured at the reference prices where both sides have one (cash is a dollar,
        // as the vault counts it). Otherwise it is the route's own: the test exchange pays at its
        // price with no fee, which is its mid.
        const reference = await referenceCost(t, amount, routed.outRaw);
        return {
          source: routed.source,
          method: `${routed.method}; minimum ${quoteSlippageBps} bps under the quote${
            reference ? `; cost against ${reference.source}` : ''
          }`,
          fetchedAt: routed.fetchedAt,
          provenance,
          trade: t,
          outRaw: routed.outRaw.toString(),
          minOutRaw: minOut.toString(),
          costBps: reference?.costBps ?? 0,
          against: reference ? 'reference' : 'pool_mid',
          venue: routed.venue,
        };
      }),
  };

  /**
   * A withdrawal, token by token: one that cannot move does not stop the others (DESIGN-VAULT section 5:
   * the owner can always withdraw every token in kind). Each token the vault holds is its own
   * transaction; one that cannot be built is listed with the reason.
   */
  async function withdrawEach(args: unknown): Promise<WithdrawEach> {
    const a = input(WithdrawInKindArgs, args, 'withdraw');
    noNonce(a.nonce);
    builds();
    const vault = solanaAddress(a.vault, 'vault');
    const chain = await chainNow([vault]);
    const state = vaultFrom(vault, chain.extra[0]);
    // Asked for: those assets. Otherwise every token the vault may hold: the app's list, the program's
    // own list, and every line of the vault, listed or not.
    const asked = a.assets !== undefined;
    const mints = asked
      ? [...new Set((a.assets ?? []).map(mintOf))]
      : [
          ...new Set<Address>([
            chain.onchain.cashMint,
            ...(assets.map((x) => x.address) as Address[]),
            ...(chain.registry?.assets.map((e) => e.mint) ?? []),
            ...state.positions.map((x) => x.mint),
          ]),
        ];
    const notBuilt: WithdrawEach['notBuilt'] = [];
    const refs = new Map<string, TokenRef>();
    for (const mint of mints) {
      try {
        refs.set(mint, await token(mint));
      } catch (e) {
        // A mint that is gone holds nothing. One the owner named is said.
        if (asked && e instanceof ChainError)
          notBuilt.push({ asset: idOf(mint), code: e.code, message: e.message });
      }
    }
    const readable = mints.filter((m) => refs.has(m));
    const found = await holdings(
      readable.flatMap((mint) => {
        const t = refs.get(mint) as TokenRef;
        return [
          { holder: vault, token: t },
          { holder: state.owner, token: t },
        ];
      }),
    );
    const p = await programAccounts();
    const txs: BuiltTx[] = [];
    for (const [i, mint] of readable.entries()) {
      const held = found[2 * i];
      const wallet = found[2 * i + 1];
      if (!held || !wallet || held.amount === 0n) continue;
      const id = idOf(mint);
      const skip = (code: ChainErrorCode, message: string) =>
        notBuilt.push({ asset: id, code, message });
      // A frozen account cannot send or receive until its issuer thaws it.
      if (held.frozen) {
        skip('BalanceUnreadable', "the vault's account of it is frozen by its issuer");
        continue;
      }
      if (wallet.frozen) {
        skip('BalanceUnreadable', "the owner's account of it is frozen by its issuer");
        continue;
      }
      if (mintInfos.get(mint)?.hookProgram) {
        skip(
          'NotSupported',
          'its issuer added a transfer hook program, whose extra accounts this builder does not resolve: withdraw it with a wallet that does',
        );
        continue;
      }
      const t = refs.get(mint) as TokenRef;
      try {
        txs.push(
          await built({
            kind: 'withdraw',
            signer: state.owner,
            instructions: [
              ...(wallet.exists
                ? []
                : [
                    createTokenAccountInstruction({
                      payer: state.owner,
                      account: wallet.address,
                      holder: state.owner,
                      token: t,
                    }),
                  ]),
              withdrawInstruction(p, {
                owner: state.owner,
                vault,
                token: t,
                vaultAccount: held.address,
                destination: wallet.address,
                amount: held.amount,
              }),
            ],
            watch: [
              { holder: 'vault', asset: id, account: held.address },
              { holder: 'wallet', asset: id, account: wallet.address },
            ],
            summary: `Withdraw ${held.amount} raw ${id} from vault ${vault} to the owner`,
            minimums: [],
          }),
        );
      } catch (e) {
        // Paused by its issuer, or anything else the chain refuses for this token alone.
        if (!(e instanceof ChainError) || e.code === 'Unavailable') throw e;
        skip(e.code, e.message);
      }
    }
    return { txs, notBuilt };
  }

  /** What the route pays against what the trade is worth at the reference prices; null where one side has none. */
  async function referenceCost(t: Trade, amountIn: bigint, outRaw: bigint) {
    const usd = new Map<string, { usd: number; decimals: number }>();
    const listed = [t.sell, t.buy].map((id) => byId.get(id));
    if (listed.some((x) => !x)) return null;
    const priced = listed.filter((x) => x && x.id !== cash?.id && x.priceKind !== 'none');
    if (priced.length + listed.filter((x) => x?.id === cash?.id).length < 2) return null;
    const prices = priced.length
      ? await reader.getPrices(priced.map((x) => x?.id as AssetId)).catch(() => null)
      : [];
    if (!prices) return null;
    for (const x of listed)
      if (x && x.id === cash?.id) usd.set(x.id, { usd: 1, decimals: x.decimals });
    for (const pr of prices) {
      const x = byId.get(pr.asset);
      if (x) usd.set(pr.asset, { usd: Number(pr.usdPerToken), decimals: x.decimals });
    }
    const sell = usd.get(t.sell);
    const buy = usd.get(t.buy);
    if (!sell || !buy) return null;
    const valueIn = (Number(amountIn) / 10 ** sell.decimals) * sell.usd;
    const valueOut = (Number(outRaw) / 10 ** buy.decimals) * buy.usd;
    if (!(valueIn > 0)) return null;
    return {
      costBps: Math.round(((valueIn - valueOut) / valueIn) * 10_000),
      source: `the price account ${config.priceSource.address} at the same moment`,
    };
  }

  return adapter;
}
