import {
  AssetId,
  BasketAsset,
  type Capabilities,
  type ChainConfig,
  ChainError,
  type ChainErrorCode,
  type ChainReader,
  chainProvenance,
  EvmAddress,
  explorerLink,
  type Funding,
  FundingNeed,
  type Holding,
  type Price,
  Recipe,
  type TxStatus,
  type VaultPosition,
  type VaultState,
} from '@colosseum/schemas';
import {
  type Address,
  type Hex,
  parseAbi,
  type StateOverride,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { z } from 'zod';
import { displayAmount, fromScaled, multiplierString } from './amounts';
import { revertDataOf, revertToChainError } from './errors';
import { BASKET_VAULT_ABI, INDEX_REGISTRY_ABI, VAULT_FACTORY_ABI } from './generated/abi';
import { dayOf, marketAt } from './market';
import { ask, type EvmRpc, isRevert } from './rpc';
import { unlistedAssetId } from './unlisted';

// The read side of the EVM adapter (DESIGN-VAULT 3.2, ADE-1): one codebase for every EVM chain, with
// what differs between them in its `ChainConfig` (the network, the factory and the registry under
// `contracts`) and in the asset list it is given. Everything is read from the chain at the moment it is
// asked for: there is no indexer and no cache of balances. Every call of one read names the same block,
// so what comes back is one moment of the chain.
//
// The cash token, the keeper, the pause, the keeper's limits and each asset's feed are read from the
// factory, so what this reports is what the contracts enforce. Base comes in later on a node that cannot
// run its stock tokens as a fork can: `stateOverride` is handed to every call for that.

/** The gas a step of a plan costs, at most, as measured on a fork of Robinhood Chain (DESIGN-VAULT 5): a first buy 334,000. */
export const GAS_PER_LEG = 400_000n;
/** What creating the vault adds to the step that creates it: `createVaultAndBuy` with one swap measured 792,000. */
export const GAS_NEW_VAULT = 400_000n;
/** The gas price is asked of the node and doubled: a base fee can double in a few blocks. */
export const GAS_PRICE_HEADROOM = 2n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const MAX_BASKET_ID = 0xffff_ffff_ffff_ffffn;

/** What the issuers' tokens and the feeds answer, beyond what our contracts declare. */
const TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
]);
const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);

export type EvmVaultReaderOptions = {
  /** The chain's config. `contracts.factory` and `contracts.registry` are ours on that network. */
  config: ChainConfig;
  /** Made by the caller from its own RPC URL (`createEvmRpc`). */
  rpc: EvmRpc;
  /**
   * The assets of this network, with what the chain does not hold of each: its id, its class, its
   * sheet. The factory's own settings have the feed, the ceiling and the keeper's switch. An asset
   * with `priceKind: 'chainlink'` carries its feed's address in `priceRef`.
   */
  assets: BasketAsset[];
  /** `readonly` until the builders exist (ADE-2). */
  trade?: 'live' | 'readonly';
  /** False until auto-follow is switched on for the network. */
  autoFollow?: boolean;
  /**
   * Handed to every `eth_call`. For a chain whose tokens cannot be run on a fork (Base): the code and
   * the storage the reads need, put in place for the call only. Nothing is sent.
   */
  stateOverride?: StateOverride;
  /** The clock that stamps `fetchedAt` and `observedAt`. Ages come from the block's time, not this one. */
  now?: () => Date;
};

/** The platform's settings as the factory holds them now. */
export type PlatformState = {
  factory: Address;
  registry: Address;
  cashToken: Address;
  keeper: Address;
  guardian: Address;
  admin: Address;
  keeperPaused: boolean;
  launched: boolean;
  /** Unix seconds: no stock trades for the keeper before it. */
  closedUntil: number;
  priceDevBps: number;
  sequencerFeed: Address | null;
  params: {
    toleranceBps: number;
    lossCapBps: number;
    bandBps: number;
    assetCooldown: number;
    /** Seconds after midnight UTC. */
    sessionOpen: number;
    sessionClose: number;
  };
  /** Days since 1970 UTC, today, and whether the factory marks it closed. */
  today: { day: number; closed: boolean };
};

/** One token's settings as the factory holds them (`AssetConfig`). */
export type AssetSettings = {
  /** The app's id for it, or the id made from its address where the app does not list it. */
  asset: AssetId;
  address: Address;
  /** On the list now: it can be bought and be a target. A removed asset can still be sold. */
  listed: boolean;
  feed: Address | null;
  averageFeed: Address | null;
  tokenDecimals: number;
  feedDecimals: number;
  maxAge: number;
  session: 'always' | 'us_equity';
  /** 1 is Chainlink, 0 is no price. */
  source: number;
  maxWeightBps: number;
  pauseProbe: Address | null;
  pauseSelector: Hex;
  scheduleSelector: Hex;
  /** Unix seconds: the guardian halted the keeper in it until then. */
  haltUntil: number;
  /** Bit 0 of `flags`: the admin switched the keeper on for it. */
  keeperOn: boolean;
  /** In the feed's units, as decimal strings; null for none. */
  range: { minPrice: string; maxPrice: string } | null;
};

/** `provenance` is 'live' on mainnet and 'sandbox' on a test network or a local copy. */
export type EvmVaultReader = ChainReader & {
  readonly factory: Address;
  readonly registry: Address;
  /** The cash token, the roles, the pause and the keeper's limits, as the factory has them now. */
  getPlatform(): Promise<PlatformState>;
  /** Every token the factory lists now, then every one it took off the list, with its settings. */
  getAssetSettings(): Promise<AssetSettings[]>;
};

/** One moment of the chain: every call of a read names this block. */
type Moment = { block: bigint; time: bigint };

/** A token as a balance is read and shown: a listed asset, or one the app does not list. */
type Held = { id: AssetId; address: string; decimals: number };

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

/** Nothing but a ChainError leaves the reader: anything else is a bug or a broken contract, reported as Unknown. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ChainError) throw e;
    const error = new ChainError('Unknown', e instanceof Error ? e.message : 'the read failed');
    error.cause = e;
    throw error;
  }
}

const lower = (a: string) => a.toLowerCase() as Address;
const orNull = (a: string): Address | null => (lower(a) === ZERO_ADDRESS ? null : lower(a));
const hex32 = (word: string) => word.slice(2).toLowerCase();

const IndexId = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected 32 bytes as lower-case 0x hex');

export function createEvmVaultReader(options: EvmVaultReaderOptions): EvmVaultReader {
  const { config, rpc } = options;
  const now = options.now ?? (() => new Date());
  const chain = config.id;
  if (config.family !== 'evm') throw new Error(`the EVM reader was given the config of ${chain}`);
  const deployed = (name: 'factory' | 'registry'): Address => {
    const address = config.contracts[name];
    if (!address)
      throw new Error(`contracts.${chain}.${name} is not set: the ${name} has no address`);
    return address as Address;
  };
  const factory = deployed('factory');
  const registry = deployed('registry');
  const provenance = chainProvenance(config.network, 'readonly') ?? 'sandbox';
  const overrides = options.stateOverride ? { stateOverride: options.stateOverride } : {};

  // Every asset this reader lists carries the label of the network it is read from.
  const assets = options.assets.map((a) => BasketAsset.parse({ ...a, provenance }));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const byToken = new Map(assets.map((a) => [a.address, a]));
  if (byId.size !== assets.length || byToken.size !== assets.length)
    throw new Error('the asset list names an id or a token twice');
  const cashAssets = assets.filter((a) => a.cls === 'cash');
  const cash = cashAssets[0];
  if (cashAssets.length !== 1 || !cash)
    throw new Error('the asset list needs exactly one cash token');
  for (const a of assets) {
    if (a.chain !== chain) throw new Error(`${a.id} is not an asset of ${chain}`);
    if (a.priceKind === 'scope') throw new Error(`${a.id}: an EVM chain has no Scope price source`);
    if (a.priceKind === 'chainlink' && !EvmAddress.safeParse(a.priceRef).success)
      throw new Error(`${a.id}: priceRef must be the feed's lower-case 0x address`);
  }

  const capabilities: Capabilities = {
    trade: options.trade ?? 'readonly',
    autoFollow: options.autoFollow ?? false,
    maxTradesPerTx: 8,
    tradesInCreate: true,
    needsApprove: true,
  };

  // ---- calls, all at one block

  let checkedNode: Promise<void> | undefined;
  /**
   * The node answers the chain id the config gives, and a mainnet's only where the config is mainnet.
   * Asked once; asked again after a node that did not answer.
   */
  const nodeIsTheConfigs = () => {
    checkedNode ??= ask('eth_chainId', () => rpc.getChainId())
      .then((answered) => {
        if (answered !== config.evmChainId)
          throw new ChainError(
            'Unavailable',
            `the EVM RPC answers chain id ${answered}, and ${config.name} on ${config.networkName} is ${config.evmChainId}`,
            false,
          );
      })
      .catch((e) => {
        checkedNode = undefined;
        throw e;
      });
    return checkedNode;
  };

  async function moment(): Promise<Moment> {
    const [block] = await Promise.all([
      ask('eth_getBlockByNumber', () =>
        rpc.getBlock({ blockTag: 'latest', includeTransactions: false }),
      ),
      nodeIsTheConfigs(),
    ]);
    if (block.number === null) return refuse('Unavailable', 'the latest block has no number');
    return { block: block.number, time: block.timestamp };
  }

  /** A view of the factory. A revert here is not something the factory does: Unknown, named. */
  const onFactory = <F extends string>(m: Moment, functionName: F, args: readonly unknown[] = []) =>
    ask(`${functionName} of the factory`, () =>
      rpc.readContract({
        address: factory,
        abi: VAULT_FACTORY_ABI,
        functionName: functionName as never,
        args: args as never,
        blockNumber: m.block,
        ...overrides,
      }),
    ) as Promise<unknown>;

  const onVault = (m: Moment, vault: Address, functionName: 'snapshot' | 'following') =>
    ask(`${functionName} of a vault`, () =>
      rpc.readContract({
        address: vault,
        abi: BASKET_VAULT_ABI,
        functionName,
        blockNumber: m.block,
        ...overrides,
      }),
    ) as Promise<unknown>;

  const onRegistry = (m: Moment, functionName: 'indexInfo', args: readonly unknown[]) =>
    ask(`${functionName} of the registry`, () =>
      rpc.readContract({
        address: registry,
        abi: INDEX_REGISTRY_ABI,
        functionName,
        args: args as never,
        blockNumber: m.block,
        ...overrides,
      }),
    ) as Promise<unknown>;

  /** A view of a token or a feed we do not control: null where it reverts or has no such function. */
  async function tryRead<T>(
    m: Moment,
    address: Address,
    abi: typeof TOKEN_ABI | typeof FEED_ABI,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<T | null> {
    try {
      return (await ask(`${functionName} of ${address}`, () =>
        rpc.readContract({
          address,
          abi,
          functionName: functionName as never,
          args: args as never,
          blockNumber: m.block,
          ...overrides,
        }),
      )) as T;
    } catch (e) {
      if (isRevert(e)) return null;
      throw e;
    }
  }

  // ---- the factory's settings

  type Settings = {
    cashToken: Address;
    keeper: Address;
  };

  /** The cash token and the keeper, and that the app's cash is the factory's. */
  async function settings(m: Moment): Promise<Settings> {
    const [cashToken, keeper] = (await Promise.all([
      onFactory(m, 'cashToken'),
      onFactory(m, 'keeper'),
    ])) as [string, string];
    if (lower(cashToken) === ZERO_ADDRESS)
      return refuse('CashTokenNotSet', `the factory on ${config.networkName} names no cash token`);
    if (lower(cashToken) !== cash?.address)
      throw new ChainError(
        'Unavailable',
        `the factory's cash token is ${lower(cashToken)} and the app lists ${cash?.address}: the asset list is not this network's`,
        false,
      );
    await assertDecimals(m, assets);
    return { cashToken: lower(cashToken), keeper: lower(keeper) };
  }

  type OnchainAsset = {
    feed: string;
    tokenDecimals: number;
    feedDecimals: number;
    maxAge: number;
    session: number;
    source: number;
    maxWeightBps: number;
    pauseProbe: string;
    pauseSelector: Hex;
    scheduleSelector: Hex;
    haltUntil: bigint;
    flags: number;
    averageFeed: string;
    minPrice: bigint;
    maxPrice: bigint;
  };
  const assetOf = (m: Moment, token: string) =>
    onFactory(m, 'asset', [token]) as Promise<OnchainAsset>;

  /**
   * Each listed asset, cash included, has the decimals the factory states for it: the vault values a
   * balance by those, and a balance shown by others is off by a power of ten. A token the factory never
   * listed states zero and is refused the same way: the list is not this network's.
   */
  async function assertDecimals(
    m: Moment,
    listed: readonly BasketAsset[],
    known: (OnchainAsset | undefined)[] = [],
  ): Promise<void> {
    const onchain = await Promise.all(listed.map((a, i) => known[i] ?? assetOf(m, a.address)));
    const wrong = listed.flatMap((a, i) => {
      const stated = onchain[i]?.tokenDecimals;
      return stated === a.decimals ? [] : [`${a.id} at ${stated}, not ${a.decimals}`];
    });
    if (wrong.length)
      throw new ChainError(
        'Unavailable',
        `the factory states other decimals than the app lists: ${wrong.slice(0, 3).join('; ')}. The asset list is not this network's`,
        false,
      );
  }

  /** The registry the factory names must be the one the config gives. */
  async function assertRegistry(m: Moment): Promise<void> {
    const named = lower((await onFactory(m, 'registry')) as string);
    if (named === ZERO_ADDRESS)
      return refuse('NotSupported', `the factory on ${config.networkName} names no registry yet`);
    if (named !== registry)
      throw new ChainError(
        'Unavailable',
        `the factory's registry is ${named} and the config gives ${registry}`,
        false,
      );
  }

  // ---- tokens

  const idOf = (token: string): AssetId =>
    byToken.get(lower(token))?.id ?? unlistedAssetId(chain, token);

  /**
   * A token's multiplier in force at the block (`uiMultiplier()`), and one the issuer has scheduled
   * (`newUIMultiplier()` from `effectiveAt()`) that the block has not reached. A token with no
   * `uiMultiplier()` has none, '1', unless the app lists it as a stock or an ETF.
   */
  async function multiplierAt(
    m: Moment,
    token: Address,
  ): Promise<{ now: string; scheduled?: { multiplier: string; effectiveAt: number } }> {
    const [ui, next, at] = await Promise.all([
      tryRead<bigint>(m, token, TOKEN_ABI, 'uiMultiplier'),
      tryRead<bigint>(m, token, TOKEN_ABI, 'newUIMultiplier'),
      tryRead<bigint>(m, token, TOKEN_ABI, 'effectiveAt'),
    ]);
    if (ui === null) {
      // The dollar token and a token the app does not list may have none. A stock token always has
      // one: one that does not answer is not read as '1'.
      const listed = byToken.get(token);
      if (listed && (listed.cls === 'stock' || listed.cls === 'etf'))
        return refuse('Unknown', `${listed.id} (${token}) answers no uiMultiplier()`);
      return { now: '1' };
    }
    if (ui === 0n) return refuse('Unknown', `${idOf(token)} answers a multiplier of zero`);
    // The token's own answer is the one in force: it turns to the next at `effectiveAt` by itself.
    const scheduled = next !== null && at !== null && next > 0n && at > m.time && next !== ui;
    return scheduled
      ? {
          now: multiplierString(ui),
          scheduled: { multiplier: multiplierString(next), effectiveAt: Number(at) },
        }
      : { now: multiplierString(ui) };
  }

  async function holding(m: Moment, asset: Held, raw: bigint): Promise<Holding> {
    const multiplier = await multiplierAt(m, asset.address as Address);
    return {
      asset: asset.id,
      raw: raw.toString(),
      multiplier: multiplier.now,
      display: displayAmount(raw, multiplier.now, asset.decimals),
      ...(multiplier.scheduled ? { scheduled: multiplier.scheduled } : {}),
    };
  }

  /** A balance, read or refused by name: a token that reverts or has no code is not a zero balance. */
  async function balanceOf(m: Moment, token: string, holder: Address): Promise<bigint> {
    const read = await tryRead<bigint>(m, lower(token), TOKEN_ABI, 'balanceOf', [holder]);
    if (read === null)
      return refuse('BalanceUnreadable', `${idOf(token)}: balanceOf(${holder}) does not answer`);
    return read;
  }

  /** A token as it is held: the app's asset, or one it does not list with the factory's decimals. */
  async function heldOf(m: Moment, token: string): Promise<Held> {
    const listed = byToken.get(lower(token));
    if (listed) return listed;
    const onchain = await assetOf(m, token);
    return {
      id: unlistedAssetId(chain, token),
      address: lower(token),
      decimals: onchain.tokenDecimals,
    };
  }

  // ---- vaults

  type Snapshot = {
    owner: string;
    indexId: string;
    acceptedVersion: number;
    autoFollow: boolean;
    tokens: readonly string[];
    targetBps: readonly number[];
    balances: readonly bigint[];
    lastKeeperAt: readonly bigint[];
    lossUsedBps: number;
    planId: string;
  };

  type IndexVersion = {
    version: number;
    effectiveAt: bigint;
    metaHash: string;
    components: readonly { token: string; bps: number }[];
  };
  type IndexInfo = {
    creator: string;
    familyId: string;
    active: IndexVersion;
    pending: IndexVersion;
  };

  /**
   * What a vault that follows has not applied yet: the version in effect when the vault took an
   * earlier one, or else the version that waits. `newAssets` are the ones the vault has no target on,
   * which the owner has to accept by hand.
   */
  function pendingFor(snap: Snapshot, info: IndexInfo): VaultState['pending'] {
    const next =
      info.active.version > snap.acceptedVersion
        ? info.active
        : info.pending.version > 0
          ? info.pending
          : null;
    if (!next) return null;
    const targets = snap.tokens.slice(0, -1);
    const accepted = new Set(
      targets.filter((_, i) => (snap.targetBps[i] ?? 0) > 0).map((t) => lower(t)),
    );
    return {
      version: next.version,
      effectiveAt: Number(next.effectiveAt),
      newAssets: next.components
        .filter((c) => !accepted.has(lower(c.token)))
        .map((c) => idOf(c.token)),
    };
  }

  async function readVault(m: Moment, address: Address, onchain: Settings): Promise<VaultState> {
    const snap = (await onVault(m, address, 'snapshot')) as Snapshot;
    const n = snap.tokens.length - 1;
    if (n < 0 || lower(snap.tokens[n] ?? '') !== onchain.cashToken)
      return refuse('Unknown', `the snapshot of ${address} does not end with the cash token`);
    const planId = BigInt(snap.planId);
    if (planId > MAX_BASKET_ID)
      return refuse('Unknown', `vault ${address} holds a plan id of more than 64 bits`);
    const targets = snap.tokens.slice(0, n).map(lower);
    if (targets.includes(onchain.cashToken))
      return refuse('Unknown', `vault ${address} has a target on the cash token`);

    // Every listed asset the vault holds with no target on it is the owner's to see and withdraw.
    const others = assets.filter(
      (a) => a.id !== cash?.id && !targets.includes(a.address as Address),
    );
    const following = snap.indexId !== ZERO_WORD;
    const [held, otherRaw, info] = await Promise.all([
      Promise.all(targets.map((t) => heldOf(m, t))),
      Promise.all(others.map((a) => balanceOf(m, a.address, address))),
      following
        ? assertRegistry(m).then(
            () => onRegistry(m, 'indexInfo', [snap.indexId]) as Promise<IndexInfo>,
          )
        : Promise.resolve(null),
    ]);
    const cashHolding = await holding(m, cash as Held, snap.balances[n] ?? 0n);
    const positions: VaultPosition[] = await Promise.all([
      ...held.map(async (asset, i) => ({
        ...(await holding(m, asset, snap.balances[i] ?? 0n)),
        targetBps: snap.targetBps[i] ?? 0,
        lastKeeperAt: (snap.lastKeeperAt[i] ?? 0n) > 0n ? Number(snap.lastKeeperAt[i]) : null,
      })),
      ...others.flatMap((asset, i) => {
        const raw = otherRaw[i] ?? 0n;
        // Held with no target: the weight it should have is zero.
        return raw > 0n
          ? [holding(m, asset, raw).then((h) => ({ ...h, targetBps: 0, lastKeeperAt: null }))]
          : [];
      }),
    ]);
    return {
      chain,
      address,
      owner: lower(snap.owner),
      basketId: planId.toString(),
      recipeOnchainId: following ? snap.indexId.toLowerCase() : null,
      acceptedVersion: snap.acceptedVersion,
      autoFollow: snap.autoFollow,
      keeper: onchain.keeper,
      cash: cashHolding,
      positions,
      lossUsedBps: Math.min(snap.lossUsedBps, 10_000),
      observedAt: now().toISOString(),
      pending: info ? pendingFor(snap, info) : null,
    };
  }

  const evmAddress = (value: unknown, what: string) => input(EvmAddress, value, what) as Address;

  // ---- shared portfolios

  function recipeOf(id: string, info: IndexInfo, v: IndexVersion): Recipe {
    return Recipe.parse({
      schemaVersion: 1,
      familyId: hex32(info.familyId),
      chain,
      onchainId: id,
      creator: lower(info.creator),
      kind: 'community',
      version: v.version,
      effectiveAt: Number(v.effectiveAt),
      components: v.components.map((c) => ({
        kind: 'asset',
        asset: idOf(c.token),
        weightBps: c.bps,
      })),
      metaHash: hex32(v.metaHash),
      // `create` refuses any other: the registry stores neither.
      maxFeeBps: 0,
      flags: 0,
    });
  }

  // ---- prices

  async function platformAt(m: Moment): Promise<PlatformState> {
    const day = dayOf(m.time);
    const [
      registryNamed,
      cashToken,
      keeper,
      guardian,
      admin,
      keeperPaused,
      launched,
      closedUntil,
      priceDevBps,
      sequencerFeed,
      params,
      closedToday,
    ] = (await Promise.all([
      onFactory(m, 'registry'),
      onFactory(m, 'cashToken'),
      onFactory(m, 'keeper'),
      onFactory(m, 'guardian'),
      onFactory(m, 'admin'),
      onFactory(m, 'keeperPaused'),
      onFactory(m, 'launched'),
      onFactory(m, 'closedUntil'),
      onFactory(m, 'priceDevBps'),
      onFactory(m, 'sequencerFeed'),
      onFactory(m, 'params'),
      onFactory(m, 'closedDay', [day]),
    ])) as [
      string,
      string,
      string,
      string,
      string,
      boolean,
      boolean,
      bigint,
      number,
      string,
      readonly [number, number, number, number, number, number],
      boolean,
    ];
    const [toleranceBps, lossCapBps, bandBps, assetCooldown, sessionOpen, sessionClose] = params;
    return {
      factory,
      registry: lower(registryNamed),
      cashToken: lower(cashToken),
      keeper: lower(keeper),
      guardian: lower(guardian),
      admin: lower(admin),
      keeperPaused,
      launched,
      closedUntil: Number(closedUntil),
      priceDevBps,
      sequencerFeed: orNull(sequencerFeed),
      params: { toleranceBps, lossCapBps, bandBps, assetCooldown, sessionOpen, sessionClose },
      today: { day, closed: closedToday },
    };
  }

  function settingsOf(token: string, listed: boolean, a: OnchainAsset): AssetSettings {
    return {
      asset: idOf(token),
      address: lower(token),
      listed,
      feed: orNull(a.feed),
      averageFeed: orNull(a.averageFeed),
      tokenDecimals: a.tokenDecimals,
      feedDecimals: a.feedDecimals,
      maxAge: a.maxAge,
      session: a.session === 1 ? 'us_equity' : 'always',
      source: a.source,
      maxWeightBps: a.maxWeightBps,
      pauseProbe: orNull(a.pauseProbe),
      pauseSelector: a.pauseSelector,
      scheduleSelector: a.scheduleSelector,
      haltUntil: Number(a.haltUntil),
      keeperOn: (a.flags & 1) === 1,
      range:
        a.minPrice === 0n && a.maxPrice === 0n
          ? null
          : { minPrice: a.minPrice.toString(), maxPrice: a.maxPrice.toString() },
    };
  }

  const reader: EvmVaultReader = {
    chain,
    capabilities,
    provenance,
    factory,
    registry,

    getPlatform: () => guarded(async () => platformAt(await moment())),

    getAssetSettings: () =>
      guarded(async () => {
        const m = await moment();
        const [listed, removed] = (await Promise.all([
          onFactory(m, 'assets'),
          onFactory(m, 'removedAssets'),
        ])) as [readonly string[], readonly string[]];
        const tokens = [
          ...listed.map((t) => ({ t, on: true })),
          ...removed.map((t) => ({ t, on: false })),
        ];
        const configs = await Promise.all(tokens.map(({ t }) => assetOf(m, t)));
        return tokens.map(({ t, on }, i) => settingsOf(t, on, configs[i] as OnchainAsset));
      }),

    listAssets: () => guarded(async () => structuredClone(assets)),

    getPrices: (ids) =>
      guarded(async (): Promise<Price[]> => {
        const wanted = [...new Set(input(z.array(AssetId), ids, 'assets'))].map(
          (id) =>
            byId.get(id) ?? refuse('MintNotAccepted', `${id} is not listed on ${config.name}`),
        );
        // An asset with no price source has no price here. Nothing is made up for it: cash included,
        // which the vault counts at a dollar and never prices.
        const priced = wanted.filter((a) => a.priceKind === 'chainlink');
        if (priced.length === 0) return [];
        const m = await moment();
        const [onchain, platform] = await Promise.all([
          Promise.all(priced.map((a) => assetOf(m, a.address))),
          priced.some((a) => a.session === 'us_equity') ? platformAt(m) : Promise.resolve(null),
        ]);
        await assertDecimals(m, priced, onchain);
        const rounds = await Promise.all(
          onchain.map((a) => {
            const feed = lower(a.feed);
            return feed === ZERO_ADDRESS
              ? Promise.resolve(null)
              : tryRead<readonly [bigint, bigint, bigint, bigint, bigint]>(
                  m,
                  feed,
                  FEED_ABI,
                  'latestRoundData',
                );
          }),
        );
        const fetchedAt = now().toISOString();
        return priced.map((asset, i): Price => {
          const a = onchain[i] as OnchainAsset;
          const feed = lower(a.feed);
          if (a.source !== 1 || feed === ZERO_ADDRESS)
            return refuse('AssetNotPriced', `the factory lists no feed for ${asset.id}`);
          // The vault goes by the factory's feed. The app's list naming another is a stale list.
          if (feed !== asset.priceRef)
            throw new ChainError(
              'Unavailable',
              `the factory prices ${asset.id} by ${feed} and the app lists ${asset.priceRef}: the asset list is not this network's`,
              false,
            );
          const round = rounds[i];
          const answer = round?.[1] ?? 0n;
          const updatedAt = round?.[3] ?? 0n;
          // As the vault reads a feed: no answer, or one of zero or below, is no price.
          if (!round || answer <= 0n)
            return refuse('AssetNotPriced', `the feed of ${asset.id} (${feed}) gives no price`);
          const age = m.time - updatedAt;
          if (age < -BigInt(a.maxAge))
            return refuse(
              'AssetNotPriced',
              `the feed of ${asset.id} is stamped ${-age} s ahead of the block, more than its ${a.maxAge} s`,
            );
          return {
            source: `Chainlink feed ${feed} on ${config.networkName}, as the factory ${factory} lists it for ${asset.id}`,
            method: `latestRoundData: answer / 10^${a.feedDecimals}; age is the block's time less updatedAt`,
            fetchedAt,
            provenance,
            asset: asset.id,
            usdPerToken: fromScaled(answer, a.feedDecimals),
            ageSeconds: age > 0n ? Number(age) : 0,
            // The asset's own limit, from the same read: the keeper's swap refuses past it.
            maxAgeSeconds: a.maxAge,
            market:
              asset.session === 'always' || !platform
                ? 'open'
                : marketAt(
                    'us_equity',
                    {
                      sessionOpen: platform.params.sessionOpen,
                      sessionClose: platform.params.sessionClose,
                      closedUntil: BigInt(platform.closedUntil),
                      closedToday: platform.today.closed,
                    },
                    m.time,
                  ),
          };
        });
      }),

    getVaults: (owner) =>
      guarded(async () => {
        const who = evmAddress(owner, 'owner');
        const m = await moment();
        const [onchain, found] = await Promise.all([
          settings(m),
          onFactory(m, 'vaultsOf', [who]) as Promise<readonly string[]>,
        ]);
        const states = await Promise.all(found.map((v) => readVault(m, lower(v), onchain)));
        return states.sort((a, b) => (BigInt(a.basketId) < BigInt(b.basketId) ? -1 : 1));
      }),

    getVault: (vault) =>
      guarded(async () => {
        const address = evmAddress(vault, 'vault');
        const m = await moment();
        // Only a vault the factory made is a vault: never an address that merely runs the same code.
        const [onchain, isVault] = await Promise.all([
          settings(m),
          onFactory(m, 'isVault', [address]) as Promise<boolean>,
        ]);
        return isVault ? readVault(m, address, onchain) : null;
      }),

    listAutoFollowVaults: (recipeOnchainId) =>
      guarded(async () => {
        const recipe =
          recipeOnchainId === undefined
            ? undefined
            : input(IndexId, recipeOnchainId, 'recipeOnchainId');
        const m = await moment();
        const count = (await onFactory(m, 'vaultCount')) as bigint;
        const vaults = (await Promise.all(
          Array.from({ length: Number(count) }, (_, i) => onFactory(m, 'vaultAt', [BigInt(i)])),
        )) as string[];
        const following = (await Promise.all(
          vaults.map((v) => onVault(m, lower(v), 'following')),
        )) as (readonly [string, number, boolean])[];
        return vaults
          .filter((_, i) => {
            const [indexId, , autoFollow] = following[i] ?? [ZERO_WORD, 0, false];
            return autoFollow && (recipe === undefined || indexId.toLowerCase() === recipe);
          })
          .map(lower)
          .sort();
      }),

    getRecipe: (recipeOnchainId) =>
      guarded(async () => {
        const id = input(IndexId, recipeOnchainId, 'recipeOnchainId');
        const m = await moment();
        await assertRegistry(m);
        let info: IndexInfo;
        try {
          info = (await onRegistry(m, 'indexInfo', [id])) as IndexInfo;
        } catch (e) {
          if (isRevert(e))
            throw new ChainError('RecipeNotFound', `no shared portfolio ${id}`, false);
          throw e;
        }
        if (lower(info.creator) === ZERO_ADDRESS || info.active.version === 0)
          throw new ChainError('RecipeNotFound', `no shared portfolio ${id}`, false);
        // The registry answers the version in effect by the block's clock, as the vault reads it.
        return {
          active: recipeOf(id, info, info.active),
          pending: info.pending.version > 0 ? recipeOf(id, info, info.pending) : null,
        };
      }),

    getWalletHoldings: (owner) =>
      guarded(async () => {
        const who = evmAddress(owner, 'owner');
        const m = await moment();
        const [amounts] = await Promise.all([
          Promise.all(assets.map((a) => balanceOf(m, a.address, who))),
          assertDecimals(m, assets),
        ]);
        const held = assets.flatMap((asset, i) => {
          const raw = amounts[i] ?? 0n;
          return raw > 0n ? [holding(m, asset, raw)] : [];
        });
        return Promise.all(held);
      }),

    funding: (owner, need) =>
      guarded(async (): Promise<Funding> => {
        const who = evmAddress(owner, 'owner');
        const wanted = input(FundingNeed, need, 'need');
        const m = await moment();
        const [cashHave, gasHave, gasPrice] = await Promise.all([
          balanceOf(m, cash.address, who),
          ask('eth_getBalance', () => rpc.getBalance({ address: who, blockNumber: m.block })),
          ask('eth_gasPrice', () => rpc.getGasPrice()),
        ]);
        // A new vault is at least the transaction that creates it, and that transaction costs more.
        // There is no rent on EVM: how many accounts the steps open (`newAccounts`) changes nothing.
        // The builder's estimate has the last word.
        const legs = BigInt(wanted.newVault ? Math.max(wanted.legs, 1) : wanted.legs);
        const gas = legs === 0n ? 0n : legs * GAS_PER_LEG + (wanted.newVault ? GAS_NEW_VAULT : 0n);
        const gasNeed = gas * gasPrice * GAS_PRICE_HEADROOM;
        return {
          chain,
          cashHaveRaw: cashHave.toString(),
          cashNeedRaw: wanted.cashRaw,
          gasHaveRaw: gasHave.toString(),
          gasNeedRaw: gasNeed.toString(),
          ok: cashHave >= BigInt(wanted.cashRaw) && gasHave >= gasNeed,
        };
      }),

    quote: () =>
      guarded(async () =>
        refuse(
          'NotSupported',
          'the reader alone does not quote: createEvmVaultAdapter does',
        ),
      ),

    track: (txId, validUntil) =>
      guarded(async (): Promise<TxStatus> => {
        const hash = input(
          z.string().regex(/^0x[0-9a-f]{64}$/, 'expected a transaction hash'),
          txId,
          'txId',
        ) as Hex;
        const explorerUrl = explorerLink(config, hash) ?? '';
        const receiptNow = () =>
          ask('eth_getTransactionReceipt', () =>
            rpc.getTransactionReceipt({ hash }).catch((e) => {
              if (e instanceof TransactionReceiptNotFoundError) return null;
              throw e;
            }),
          );
        const sentNow = () =>
          ask('eth_getTransactionByHash', () =>
            rpc.getTransaction({ hash }).catch((e) => {
              if (e instanceof TransactionNotFoundError) return null;
              throw e;
            }),
          );
        const deadline =
          validUntil === undefined
            ? undefined
            : BigInt(input(z.string().regex(/^\d+$/), validUntil, 'validUntil'));
        let receipt = await receiptNow();
        if (!receipt) {
          if (deadline === undefined || (await sentNow()))
            return { status: 'pending', explorerUrl };
          // An owner's trade carries a deadline (`validUntil`, unix seconds) after which the contract
          // refuses it. Past it, with no transaction on the node, it can no longer land. It may have
          // landed between the questions, so it is asked for once more before it is called expired.
          if ((await moment()).time <= deadline) return { status: 'pending', explorerUrl };
          receipt = await receiptNow();
          if (!receipt) return { status: 'expired', explorerUrl };
        }
        if (receipt.status === 'success') return { status: 'confirmed', explorerUrl };
        return {
          status: 'reverted',
          explorerUrl,
          error: await whyReverted(hash, receipt.blockNumber),
        };
      }),
  };

  /**
   * Why a landed transaction reverted: the same call replayed at the block before. Transactions earlier
   * in the same block are not replayed, so the answer is the nearest one and not always the chain's.
   */
  async function whyReverted(hash: Hex, block: bigint): Promise<{ code: string; message: string }> {
    const tx = await ask('eth_getTransactionByHash', () => rpc.getTransaction({ hash }));
    try {
      await ask('eth_call', () =>
        rpc.call({
          account: tx.from,
          to: tx.to ?? undefined,
          data: tx.input,
          value: tx.value,
          gas: tx.gas,
          blockNumber: block - 1n,
          ...overrides,
        }),
      );
    } catch (e) {
      if (isRevert(e)) {
        const refusal = revertToChainError(revertDataOf(e));
        return { code: refusal.code, message: refusal.message };
      }
      throw e;
    }
    return {
      code: 'Unknown',
      message:
        'reverted on the chain; the same call passes at the block before, so the reason is not known',
    };
  }

  return reader;
}
