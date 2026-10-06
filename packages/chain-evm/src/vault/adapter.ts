import {
  AcceptVersionArgs,
  ApproveArgs,
  type AssetId,
  BuiltTx,
  type ChainAdapter,
  ChainError,
  type ChainErrorCode,
  CreateVaultArgs,
  DepositArgs,
  EvmAddress,
  type LegKind,
  OwnerSwapArgs,
  PublishRecipeArgs,
  type Quote,
  SetAutoFollowArgs,
  SetTargetsArgs,
  Trade,
  type TradeMinimum,
  WithdrawInKindArgs,
} from '@colosseum/schemas';
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { z } from 'zod';
import { type Composed, compose } from './compose';
import { BASKET_VAULT_ABI, INDEX_REGISTRY_ABI, VAULT_FACTORY_ABI } from './generated/abi';
import { createEvmVaultReader, type EvmVaultReader, type EvmVaultReaderOptions } from './reader';
import { quoteExactIn, swapCalldata, type V4Pools } from './routes';
import { ask } from './rpc';
import { createEvmProbe } from './send';
import { unlistedAssetId, unlistedToken } from './unlisted';

// The EVM adapter whole (DESIGN-VAULT 3.2): the reader of ADE-1, every builder, the quotes and the
// probe. Every builder returns one unsigned transaction, simulated against the chain as it is
// (`eth_simulateV1`), with its nonce, its gas limit (the estimate plus a fifth) and its fee stated, and
// the token balances it moves read from that simulation. It holds no key and signs nothing. What a
// builder writes is what the guard of packages/sdk takes (design section 9): one call, no value, to
// the cash token for an approval, the factory for a create, the person's own vault for everything
// else; a trade carries a deadline at most `DEADLINE_S` ahead.

/**
 * How long a signed trade stays good, from the chain's clock: the guard passes a deadline at most
 * 1,800 s ahead of its own, and the rest is room for a chain clock a little ahead of the wallet's.
 */
export const DEADLINE_S = 900;
/** The most trades one transaction makes (`Capabilities.maxTradesPerTx`). */
export const MAX_TRADES = 8;

const ZERO_WORD = `0x${'0'.repeat(64)}` as Hex;
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export type EvmVaultAdapterOptions = EvmVaultReaderOptions & {
  /** The pools trades are routed through and priced in. */
  pools: V4Pools;
  /** The slippage `quote()` takes off the quoted output for its `minOutRaw`. Default 100 bps. */
  quoteSlippageBps?: number;
  /** The slippage a keeper leg allows under the quote. Default 100 bps. */
  keeperSlippageBps?: number;
};

export type CancelPendingArgs = { signer: string; recipeOnchainId: string };

/** The adapter whole, with the one step the shared interface does not name. */
export type EvmVaultAdapter = ChainAdapter &
  EvmVaultReader & {
    /** Takes back the version of a shared portfolio that waits, by its creator or the guardian. Built as a `publish` step. */
    buildCancelPending(a: CancelPendingArgs): Promise<BuiltTx>;
  };

const refuse = (code: ChainErrorCode, message: string): never => {
  throw new ChainError(code, message);
};

function input<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues.map((i) =>
    i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
  );
  throw new ChainError('BadInput', `${what}: ${[...new Set(where)].slice(0, 3).join('; ')}`);
}

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

const planIdOf = (basketId: string): Hex => `0x${BigInt(basketId).toString(16).padStart(64, '0')}`;
const lower = (a: string) => a.toLowerCase() as Address;
const IndexId = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected 32 bytes as lower-case 0x hex');

export function createEvmVaultAdapter(options: EvmVaultAdapterOptions): EvmVaultAdapter {
  const { config, rpc, pools } = options;
  const reader = createEvmVaultReader(options);
  const probe = createEvmProbe({ config, rpc });
  const now = options.now ?? (() => new Date());
  const trade = options.trade ?? 'readonly';
  const quoteSlippageBps = options.quoteSlippageBps ?? 100;
  const keeperSlippageBps = options.keeperSlippageBps ?? 100;
  const chainId = config.evmChainId as number;
  const factory = reader.factory;
  const registry = reader.registry;
  const router = config.router as Address | null;
  const provenance = reader.provenance;

  const assets = options.assets;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const byToken = new Map(assets.map((a) => [a.address, a]));
  const cash = assets.find((a) => a.cls === 'cash');
  if (!cash) throw new Error('the asset list needs a cash token');
  const idOf = (token: Address): AssetId =>
    byToken.get(lower(token))?.id ?? unlistedAssetId(config.id, token);
  /** A token by id: a listed asset, or one the app does not list, named by its address. */
  const tokenOf = (id: AssetId): Address => {
    const listed = byId.get(id);
    if (listed) return listed.address as Address;
    const token = unlistedToken(id);
    if (token && id.startsWith(`${config.id}:`)) return token as Address;
    return refuse('MintNotAccepted', `${id} is not listed on ${config.name}`);
  };
  /** What a trade may buy: a listed asset, never one the app does not list. */
  const buyable = (id: AssetId) => {
    if (!byId.has(id))
      refuse(
        'MintNotAccepted',
        `${id} is not listed on ${config.name}: it can be sold, not bought`,
      );
  };

  const evm = (value: unknown, what: string) => input(EvmAddress, value, what) as Address;
  const builds = () => {
    if (trade !== 'live')
      refuse('NotSupported', `${config.name} is read-only here: nothing is built`);
  };

  // ---- reads at the latest block

  const view = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
    ask(`${functionName} of ${address}`, () =>
      rpc.readContract({
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
      }),
    ) as Promise<T>;
  const vaultOf = (owner: Address, basketId: string) =>
    view<string>(factory, VAULT_FACTORY_ABI, 'vaultOf', [owner, planIdOf(basketId)]).then(lower);
  const isVault = (vault: Address) => view<boolean>(factory, VAULT_FACTORY_ABI, 'isVault', [vault]);
  const ownerOf = (vault: Address) => view<string>(vault, BASKET_VAULT_ABI, 'owner').then(lower);
  const balanceOf = (token: Address, holder: Address) =>
    view<bigint>(token, ERC20, 'balanceOf', [holder]);
  const blockTime = async () =>
    (await ask('eth_getBlockByNumber', () => rpc.getBlock({ blockTag: 'latest' }))).timestamp;

  /** A vault the factory made, and its owner: who signs every owner step of it. */
  async function ownedVault(value: unknown): Promise<{ vault: Address; owner: Address }> {
    const vault = evm(value, 'vault');
    if (!(await isVault(vault)))
      return refuse('VaultNotFound', `no vault of this factory at ${vault}`);
    return { vault, owner: await ownerOf(vault) };
  }

  /** Targets as the vault takes them: listed assets, never cash, sorted by token address. */
  function weightsOf(targets: { asset: AssetId; weightBps: number }[]) {
    const weights = targets.map((t) => {
      if (t.asset === cash?.id)
        refuse('InvalidTargets', 'cash is never a target: what is left of 10,000 is cash');
      buyable(t.asset);
      return { token: tokenOf(t.asset), bps: t.weightBps };
    });
    return weights.sort((a, b) => (BigInt(a.token) < BigInt(b.token) ? -1 : 1));
  }

  /** The owner's trades as the vault's `Swap`s, each quoted now and held to the slippage asked. */
  async function swapsOf(
    trades: Trade[],
    slippageBps: number,
    deadline: bigint,
  ): Promise<{ swaps: readonly unknown[]; minimums: TradeMinimum[] }> {
    if (trades.length > MAX_TRADES)
      refuse(
        'TooManyTrades',
        `at most ${MAX_TRADES} trades in one transaction, and this has ${trades.length}`,
      );
    if (!router) return refuse('RouterNotAllowed', `no router is set for ${config.name}`);
    // Trades in one pool follow each other: the second is quoted after the first has moved the price,
    // as the cumulative amount less what came before. A pool traded both ways in one transaction is
    // refused: its quote would depend on the order.
    const legs = trades.map((t) => {
      buyable(t.buy);
      const [tokenIn, tokenOut] = [tokenOf(t.sell), tokenOf(t.buy)];
      const amountIn = BigInt(t.amountInRaw);
      if (amountIn === 0n) refuse('BadTrade', 'a trade of nothing');
      const pool = [tokenIn, tokenOut].sort().join(':');
      return { t, tokenIn, tokenOut, amountIn, pool };
    });
    for (const leg of legs)
      if (legs.some((o) => o.pool === leg.pool && o.tokenIn !== leg.tokenIn))
        refuse(
          'BadTrade',
          `one transaction trades the pool of ${leg.t.sell} and ${leg.t.buy} both ways`,
        );
    const before = new Map<string, bigint>();
    const cumulative = legs.map((leg) => {
      const prior = before.get(leg.pool) ?? 0n;
      before.set(leg.pool, prior + leg.amountIn);
      return prior;
    });
    const quote = (leg: (typeof legs)[number], amountIn: bigint) =>
      amountIn === 0n
        ? Promise.resolve(0n)
        : quoteExactIn(rpc, pools, { tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, amountIn });
    const routed = await Promise.all(
      legs.map(async (leg, i) => {
        const prior = cumulative[i] ?? 0n;
        const [upTo, through] = await Promise.all([
          quote(leg, prior),
          quote(leg, prior + leg.amountIn),
        ]);
        const out = through - upTo;
        if (out <= 0n)
          refuse('BadTrade', `the pool pays nothing for ${leg.t.amountInRaw} raw ${leg.t.sell}`);
        // A trade after another in the same pool can fill one unit under the difference of the two
        // quotes, by the pool's rounding: its floor is set that much lower.
        const floor = (out * BigInt(10_000 - slippageBps)) / 10_000n - (prior > 0n ? 1n : 0n);
        const minOut = floor > 0n ? floor : 1n;
        const { tokenIn, tokenOut, amountIn, t } = leg;
        return {
          swap: {
            router,
            tokenIn,
            tokenOut,
            amountIn,
            minOut,
            data: swapCalldata(pools, { tokenIn, tokenOut, amountIn, deadline }),
          },
          minimum: { sell: t.sell, buy: t.buy, inRaw: t.amountInRaw, minOutRaw: minOut.toString() },
        };
      }),
    );
    return { swaps: routed.map((r) => r.swap), minimums: routed.map((r) => r.minimum) };
  }

  /** The cash a step pulls from the owner: there, and approved to the vault. */
  async function canPull(owner: Address, vault: Address, amount: bigint) {
    if (amount === 0n || !cash) return;
    const [held, allowed] = await Promise.all([
      balanceOf(cash.address as Address, owner),
      view<bigint>(cash.address as Address, ERC20, 'allowance', [owner, vault]),
    ]);
    if (held < amount)
      refuse(
        'NotFunded',
        `the wallet holds ${held} raw ${cash.id}, and the step deposits ${amount}`,
      );
    if (allowed < amount)
      refuse(
        'AllowanceTooLow',
        `the wallet has approved ${allowed} raw ${cash.id} to its vault, and the step deposits ${amount}: approve it first`,
      );
  }

  // ---- one transaction

  async function built(a: {
    kind: LegKind;
    signer: Address;
    to: Address;
    data: Hex;
    nonce?: number;
    vault?: Address;
    summary: string;
    minimums: TradeMinimum[];
    /** For a trade: its deadline, which is when the attempt stops being able to land. */
    deadline?: bigint;
  }): Promise<BuiltTx & { composed: Composed }> {
    const composed = await compose({
      rpc,
      chainId,
      signer: a.signer,
      to: a.to,
      data: a.data,
      ...(a.nonce !== undefined ? { nonce: a.nonce } : {}),
      ...(a.vault ? { vault: a.vault } : {}),
      idOf,
    });
    const tx = BuiltTx.parse({
      chain: 'evm',
      chainId: config.id,
      legKind: a.kind,
      signer: a.signer,
      payload: composed.data,
      evm: {
        to: composed.to,
        value: '0',
        chainId,
        nonce: composed.nonce,
        gas: Number(composed.gas),
      },
      description: a.summary,
      provenance,
      // On EVM `validUntil` is a trade's deadline, in unix seconds; a call that does not trade has none.
      ...(a.deadline !== undefined ? { lastValidBlockHeight: Number(a.deadline) } : {}),
      messageHash: composed.messageHash,
      preview: {
        source: `simulation of the call on ${config.networkName}, factory ${factory}`,
        method: `eth_simulateV1 at the latest block with its token transfers traced; gas limit the node's estimate plus a fifth (${composed.gas}); fee at ${composed.maxFeePerGas} wei per gas`,
        fetchedAt: now().toISOString(),
        provenance,
        summary: a.summary,
        simulated: true,
        feeNativeRaw: composed.feeWei.toString(),
        changes: composed.changes,
        minimums: a.minimums,
      },
    });
    Object.defineProperty(tx, 'composed', { value: composed, enumerable: false });
    return tx as BuiltTx & { composed: Composed };
  }

  async function activeVersion(indexId: Hex): Promise<number> {
    const [version] = await view<readonly [number, unknown]>(
      registry,
      INDEX_REGISTRY_ABI,
      'active',
      [indexId],
    );
    if (version === 0) refuse('RecipeNotFound', `no shared portfolio ${indexId}`);
    return version;
  }

  const adapter: EvmVaultAdapter = {
    ...reader,
    ...probe,

    quote: (tradeArg, takerArg) =>
      guarded(async (): Promise<Quote> => {
        const t = input(Trade, tradeArg, 'trade');
        evm(takerArg, 'taker');
        buyable(t.buy);
        const [tokenIn, tokenOut] = [tokenOf(t.sell), tokenOf(t.buy)];
        const amountIn = BigInt(t.amountInRaw);
        const out = await quoteExactIn(rpc, pools, { tokenIn, tokenOut, amountIn });
        const fetchedAt = now().toISOString();
        const minOut = (out * BigInt(10_000 - quoteSlippageBps)) / 10_000n;
        // The cost against the reference prices where both sides have one; cash is a dollar.
        const priced = [t.sell, t.buy].filter((id) => byId.get(id)?.priceKind === 'chainlink');
        const prices = priced.length ? await reader.getPrices(priced) : [];
        const usd = (id: AssetId, raw: bigint): number | null => {
          const asset = byId.get(id);
          if (!asset) return null;
          if (asset.cls === 'cash') return Number(raw) / 10 ** asset.decimals;
          const price = prices.find((p) => p.asset === id);
          return price ? (Number(raw) / 10 ** asset.decimals) * Number(price.usdPerToken) : null;
        };
        const [inUsd, outUsd] = [usd(t.sell, amountIn), usd(t.buy, out)];
        const reference = inUsd !== null && outUsd !== null && inUsd > 0;
        return {
          source: `Uniswap v4 Quoter ${pools.quoter} on ${config.networkName}`,
          method: `quoteExactInputSingle in the pool of fee ${pools.fee} and tick spacing ${pools.tickSpacing}, no hooks; minimum ${quoteSlippageBps} bps under the quote${
            reference
              ? "; cost against the factory's Chainlink-interface feeds, cash at a dollar"
              : ''
          }`,
          fetchedAt,
          provenance,
          trade: t,
          outRaw: out.toString(),
          minOutRaw: minOut.toString(),
          costBps: reference ? Math.round(((inUsd - outUsd) / inUsd) * 10_000) : 0,
          against: reference ? 'reference' : 'pool_mid',
          venue: `Uniswap v4 (fee ${pools.fee}) through Universal Router ${router ?? 'unset'}`,
        };
      }),

    buildApprove: (args) =>
      guarded(async () => {
        builds();
        const a = input(ApproveArgs, args, 'approve');
        const owner = evm(a.owner, 'owner');
        // Who may take the cash is the plan's vault, by its address, known before it exists.
        const vault = await vaultOf(owner, a.basketId);
        return built({
          kind: 'approve',
          signer: owner,
          to: cash.address as Address,
          data: encodeFunctionData({
            abi: ERC20,
            functionName: 'approve',
            args: [vault, BigInt(a.amountRaw)],
          }),
          nonce: a.nonce,
          summary: `Allow the vault of plan ${a.basketId} (${vault}) to take ${a.amountRaw} raw ${cash.id}`,
          minimums: [],
        });
      }),

    buildCreateVault: (args) =>
      guarded(async () => {
        builds();
        const a = input(CreateVaultArgs, args, 'create');
        const owner = evm(a.owner, 'owner');
        const vault = await vaultOf(owner, a.basketId);
        if (await isVault(vault))
          refuse('VaultExists', `plan ${a.basketId} already has its vault ${vault}`);
        let indexId = ZERO_WORD;
        let version = 0;
        if (a.recipeOnchainId !== undefined) {
          if (a.targets.length)
            refuse('BadInput', 'targets are empty when the vault follows a shared portfolio');
          indexId = input(IndexId, a.recipeOnchainId, 'recipeOnchainId') as Hex;
          version = a.expectedVersion ?? (await activeVersion(indexId));
        }
        const targets = weightsOf(a.targets);
        const deposit = BigInt(a.depositRaw ?? '0');
        const trades = a.trades ?? [];
        for (const t of trades)
          if (t.sell !== cash.id)
            refuse('BadTrade', 'a trade inside a create spends the cash it deposits');
        const spent = trades.reduce((n, t) => n + BigInt(t.amountInRaw), 0n);
        if (spent > deposit)
          refuse('SpentTooMuch', `the trades spend ${spent}, and the create deposits ${deposit}`);
        await canPull(owner, vault, deposit);
        const salt = planIdOf(a.basketId);
        const buys = deposit > 0n || trades.length > 0;
        const deadline = (await blockTime()) + BigInt(DEADLINE_S);
        const { swaps, minimums } = await swapsOf(trades, a.slippageBps, deadline);
        const data = buys
          ? encodeFunctionData({
              abi: VAULT_FACTORY_ABI,
              functionName: 'createVaultAndBuy',
              args: [
                salt,
                targets,
                indexId,
                version,
                a.autoFollow,
                deposit,
                swaps as never,
                deadline,
              ],
            })
          : encodeFunctionData({
              abi: VAULT_FACTORY_ABI,
              functionName: 'createVault',
              args: [salt, targets, indexId, version, a.autoFollow],
            });
        return built({
          kind: 'create_vault',
          signer: owner,
          to: factory,
          data,
          nonce: a.nonce,
          vault,
          summary: `Open the vault of plan ${a.basketId}${
            indexId === ZERO_WORD ? '' : `, following ${indexId} at version ${version}`
          }${deposit > 0n ? `, with ${deposit} raw ${cash.id}` : ''}${trades.length ? ` and ${trades.length} trades` : ''}`,
          minimums,
          ...(buys ? { deadline } : {}),
        });
      }),

    buildDeposit: (args) =>
      guarded(async () => {
        builds();
        const a = input(DepositArgs, args, 'deposit');
        const { vault, owner } = await ownedVault(a.vault);
        const amount = BigInt(a.amountRaw);
        if (amount === 0n) refuse('BadInput', 'amountRaw: a deposit of nothing');
        await canPull(owner, vault, amount);
        const trades = a.trades ?? [];
        const deposit = encodeFunctionData({
          abi: BASKET_VAULT_ABI,
          functionName: 'deposit',
          args: [amount],
        });
        if (!trades.length)
          return built({
            kind: 'deposit',
            signer: owner,
            to: vault,
            data: deposit,
            nonce: a.nonce,
            vault,
            summary: `Deposit ${amount} raw ${cash.id} into vault ${vault}`,
            minimums: [],
          });
        const deadline = (await blockTime()) + BigInt(DEADLINE_S);
        const { swaps, minimums } = await swapsOf(trades, a.slippageBps, deadline);
        const swap = encodeFunctionData({
          abi: BASKET_VAULT_ABI,
          functionName: 'ownerSwap',
          args: [swaps as never, deadline],
        });
        return built({
          kind: 'deposit',
          signer: owner,
          to: vault,
          data: encodeFunctionData({
            abi: BASKET_VAULT_ABI,
            functionName: 'multicall',
            args: [[deposit, swap]],
          }),
          nonce: a.nonce,
          vault,
          summary: `Deposit ${amount} raw ${cash.id} into vault ${vault} and make ${trades.length} trades`,
          minimums,
          deadline,
        });
      }),

    buildOwnerSwap: (args) =>
      guarded(async () => {
        builds();
        const a = input(OwnerSwapArgs, args, 'swap');
        const { vault, owner } = await ownedVault(a.vault);
        for (const t of a.trades) {
          const held = await balanceOf(tokenOf(t.sell), vault);
          if (held < BigInt(t.amountInRaw))
            refuse(
              'SpentTooMuch',
              `vault ${vault} holds ${held} raw ${t.sell}, and the trade sells ${t.amountInRaw}`,
            );
        }
        const deadline = (await blockTime()) + BigInt(DEADLINE_S);
        const { swaps, minimums } = await swapsOf(a.trades, a.slippageBps, deadline);
        return built({
          kind: 'swap',
          signer: owner,
          to: vault,
          data: encodeFunctionData({
            abi: BASKET_VAULT_ABI,
            functionName: 'ownerSwap',
            args: [swaps as never, deadline],
          }),
          nonce: a.nonce,
          vault,
          summary: a.trades
            .map(
              (t, i) =>
                `Sell ${t.amountInRaw} raw ${t.sell} for at least ${minimums[i]?.minOutRaw} raw ${t.buy}`,
            )
            .join('; ')
            .concat(` in vault ${vault}`),
          minimums,
          deadline,
        });
      }),

    buildSetTargets: (args) =>
      guarded(async () => {
        builds();
        const a = input(SetTargetsArgs, args, 'targets');
        const { vault, owner } = await ownedVault(a.vault);
        return built({
          kind: 'set_targets',
          signer: owner,
          to: vault,
          data: encodeFunctionData({
            abi: BASKET_VAULT_ABI,
            functionName: 'setTargets',
            args: [weightsOf(a.targets)],
          }),
          nonce: a.nonce,
          vault,
          summary: `Set the targets of vault ${vault}: ${a.targets.map((t) => `${t.asset} ${t.weightBps} bps`).join(', ')}`,
          minimums: [],
        });
      }),

    buildAcceptVersion: (args) =>
      guarded(async () => {
        builds();
        const a = input(AcceptVersionArgs, args, 'accept');
        const { vault, owner } = await ownedVault(a.vault);
        const indexId = input(IndexId, a.recipeOnchainId, 'recipeOnchainId') as Hex;
        return built({
          kind: 'accept_version',
          signer: owner,
          to: vault,
          data: encodeFunctionData({
            abi: BASKET_VAULT_ABI,
            functionName: 'acceptVersion',
            args: [indexId, a.expectedVersion],
          }),
          nonce: a.nonce,
          vault,
          summary: `Accept version ${a.expectedVersion} of shared portfolio ${indexId} in vault ${vault}`,
          minimums: [],
        });
      }),

    buildSetAutoFollow: (args) =>
      guarded(async () => {
        builds();
        const a = input(SetAutoFollowArgs, args, 'auto-follow');
        const { vault, owner } = await ownedVault(a.vault);
        return built({
          kind: 'set_auto_follow',
          signer: owner,
          to: vault,
          data: encodeFunctionData({
            abi: BASKET_VAULT_ABI,
            functionName: 'setAutoFollow',
            args: [a.on],
          }),
          nonce: a.nonce,
          vault,
          summary: `Switch auto-follow ${a.on ? 'on' : 'off'} for vault ${vault}`,
          minimums: [],
        });
      }),

    buildWithdrawInKind: (args) =>
      guarded(async () => {
        builds();
        const a = input(WithdrawInKindArgs, args, 'withdraw');
        const { vault, owner } = await ownedVault(a.vault);
        // Everything: one `withdrawAll`, which walks every token that came in and skips none for gas. A
        // vault that holds nothing has nothing to build.
        if (a.assets === undefined) {
          const tokens = await view<readonly string[]>(vault, BASKET_VAULT_ABI, 'tokens');
          const held = await Promise.all(tokens.map((t) => balanceOf(lower(t), vault)));
          if (!held.some((h) => h > 0n)) return [];
          return [
            await built({
              kind: 'withdraw',
              signer: owner,
              to: vault,
              data: encodeFunctionData({ abi: BASKET_VAULT_ABI, functionName: 'withdrawAll' }),
              nonce: a.nonce,
              vault,
              summary: `Withdraw everything vault ${vault} holds to its owner`,
              minimums: [],
            }),
          ];
        }
        // The tokens named, each in full, in one transaction.
        const named = [...new Set(a.assets)].map(tokenOf);
        const held = await Promise.all(named.map((t) => balanceOf(t, vault)));
        const calls = named.flatMap((t, i) =>
          (held[i] ?? 0n) > 0n
            ? [
                encodeFunctionData({
                  abi: BASKET_VAULT_ABI,
                  functionName: 'withdraw',
                  args: [t, held[i] ?? 0n],
                }),
              ]
            : [],
        );
        if (!calls.length) return [];
        return [
          await built({
            kind: 'withdraw',
            signer: owner,
            to: vault,
            data:
              calls.length === 1
                ? (calls[0] as Hex)
                : encodeFunctionData({
                    abi: BASKET_VAULT_ABI,
                    functionName: 'multicall',
                    args: [calls],
                  }),
            nonce: a.nonce,
            vault,
            summary: `Withdraw ${named.length} tokens from vault ${vault} to its owner`,
            minimums: [],
          }),
        ];
      }),

    buildPublishRecipe: (args) =>
      guarded(async () => {
        builds();
        const a = input(PublishRecipeArgs, args, 'publish');
        const creator = evm(a.creator, 'creator');
        const r = a.recipe;
        if (r.chain !== config.id)
          refuse('BadInput', `the recipe is on ${r.chain}, not ${config.id}`);
        if (r.kind !== 'community') refuse('BadInput', 'only a shared portfolio is published');
        const components = weightsOf(
          r.components.map((c) => {
            if (c.kind !== 'asset')
              return refuse('BadInput', 'a shared portfolio lists assets only');
            return { asset: c.asset, weightBps: c.weightBps };
          }),
        );
        const familyId = `0x${r.familyId}` as Hex;
        const metaHash = `0x${r.metaHash}` as Hex;
        // The registry's id: keccak256(abi.encode(creator, familyId)).
        const id = keccak256(
          encodeAbiParameters(parseAbiParameters('address, bytes32'), [creator, familyId]),
        );
        const exists =
          lower(await view<string>(registry, INDEX_REGISTRY_ABI, 'creatorOf', [id])) !==
          '0x0000000000000000000000000000000000000000';
        return built({
          kind: 'publish',
          signer: creator,
          to: registry,
          data: exists
            ? encodeFunctionData({
                abi: INDEX_REGISTRY_ABI,
                functionName: 'publish',
                args: [id, components, metaHash],
              })
            : encodeFunctionData({
                abi: INDEX_REGISTRY_ABI,
                functionName: 'create',
                args: [familyId, components, metaHash, 0, 0],
              }),
          nonce: a.nonce,
          summary: exists
            ? `Publish the next version of shared portfolio ${id}`
            : `Publish shared portfolio ${id}, version 1`,
          minimums: [],
        });
      }),

    buildCancelPending: (a) =>
      guarded(async () => {
        builds();
        const signer = evm(a.signer, 'signer');
        const id = input(IndexId, a.recipeOnchainId, 'recipeOnchainId') as Hex;
        return built({
          kind: 'publish',
          signer,
          to: registry,
          data: encodeFunctionData({ abi: INDEX_REGISTRY_ABI, functionName: 'cancel', args: [id] }),
          summary: `Take back the version of shared portfolio ${id} that waits`,
          minimums: [],
        });
      }),

    buildAdoptVersion: (vaultArg) =>
      guarded(async () => {
        builds();
        const vault = evm(vaultArg, 'vault');
        if (!(await isVault(vault)))
          return refuse('VaultNotFound', `no vault of this factory at ${vault}`);
        const keeper = lower(await view<string>(factory, VAULT_FACTORY_ABI, 'keeper'));
        return built({
          kind: 'adopt_version',
          signer: keeper,
          to: vault,
          data: encodeFunctionData({ abi: BASKET_VAULT_ABI, functionName: 'adoptVersion' }),
          vault,
          summary: `Adopt the version in effect of the shared portfolio vault ${vault} follows`,
          minimums: [],
        });
      }),

    buildKeeperLeg: (vaultArg, tradeArg, options: { nonce?: number } = {}) =>
      guarded(async () => {
        builds();
        const vault = evm(vaultArg, 'vault');
        const t = input(Trade, tradeArg, 'trade');
        if (!(await isVault(vault)))
          return refuse('VaultNotFound', `no vault of this factory at ${vault}`);
        if ((t.sell === cash.id) === (t.buy === cash.id))
          refuse('NotCashLeg', 'a keeper leg trades cash for one asset or one asset for cash');
        if (!router) return refuse('RouterNotAllowed', `no router is set for ${config.name}`);
        // The asset is one of the vault's targets: the keeper trades nothing else.
        const other = t.sell === cash.id ? t.buy : t.sell;
        const targets = await view<readonly { token: string }[]>(
          vault,
          BASKET_VAULT_ABI,
          'targets',
        );
        if (!targets.some((w) => lower(w.token) === tokenOf(other)))
          refuse('MintNotAccepted', `${other} is not a target of vault ${vault}`);
        const keeper = lower(await view<string>(factory, VAULT_FACTORY_ABI, 'keeper'));
        const [tokenIn, tokenOut] = [tokenOf(t.sell), tokenOf(t.buy)];
        const amountIn = BigInt(t.amountInRaw);
        const out = await quoteExactIn(rpc, pools, { tokenIn, tokenOut, amountIn });
        const minOut = (out * BigInt(10_000 - keeperSlippageBps)) / 10_000n;
        // The keeper's swap takes no deadline: the vault checks it against the chain when it lands.
        // The router's own deadline is a day off, so the vault's checks are the ones that bind.
        const routerDeadline = (await blockTime()) + 86_400n;
        const swap = {
          router,
          tokenIn,
          tokenOut,
          amountIn,
          minOut,
          data: swapCalldata(pools, {
            tokenIn,
            tokenOut,
            amountIn,
            deadline: routerDeadline,
          }),
        };
        return built({
          kind: 'keeper_leg',
          signer: keeper,
          to: vault,
          data: encodeFunctionData({
            abi: BASKET_VAULT_ABI,
            functionName: 'keeperSwap',
            args: [swap],
          }),
          vault,
          // Pinned where an earlier leg of this vault holds a nonce the node does not have: of the
          // two, at most one can land.
          ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
          summary: `Keeper: sell ${amountIn} raw ${t.sell} for at least ${minOut} raw ${t.buy} in vault ${vault}, toward its target`,
          minimums: [
            { sell: t.sell, buy: t.buy, inRaw: t.amountInRaw, minOutRaw: minOut.toString() },
          ],
        });
      }),
  };
  return adapter;
}
