import {
  AssetId,
  BasketAsset,
  type Capabilities,
  type ChainConfig,
  ChainError,
  type ChainErrorCode,
  type ChainReader,
  chainProvenance,
  explorerLink,
  type Funding,
  FundingNeed,
  type Holding,
  type Price,
  Recipe,
  SolanaAddress,
  type TxStatus,
  type VaultState,
} from '@colosseum/schemas';
import {
  type Address,
  type Commitment,
  getAddressEncoder,
  isSignature,
  type Signature,
} from '@solana/kit';
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
  type RecipeVersion,
  VAULT_AUTO_FOLLOW_OFFSET,
  VAULT_DISCRIMINATOR,
  VAULT_RECIPE_OFFSET,
  VAULT_SIZE,
  type VaultAccount,
  versionsAt,
  ZERO_ADDRESS,
} from './accounts';
import { displayAmount, multiplierString } from './amounts';
import {
  decayedLoss,
  inMultiplierWindow,
  keeperOn,
  MAX_PRICE_EXPONENT,
  MAX_TWAP_AGE_SECONDS,
  priceAccountOf,
  type ReferenceRefusal,
  referenceOf,
  valueInCash,
} from './keeper';
import { type ClusterClock, decodeClock, marketAt, readScopeAccount, SYSVAR_CLOCK } from './prices';
import {
  ask,
  getAccounts,
  getProgramAccounts,
  type Memcmp,
  type RawAccount,
  type VaultRpc,
} from './rpc';
import {
  decodeScopeEntry,
  SCOPE_PRICES_BYTES,
  SCOPE_PRICES_DISCRIMINATOR,
  type ScopeEntry,
  scopeIndex,
  scopePrice,
} from './scope';
import { describeFailure } from './status';
import {
  associatedTokenAddress,
  decodeMint,
  decodeTokenAccount,
  isTokenProgram,
  type MintInfo,
  multiplierAt,
  scheduledMultiplier,
  TOKEN_PROGRAM,
} from './tokens';
import { unlistedAssetId } from './unlisted';

// The read side of the Solana adapter (DESIGN-VAULT 3.2, ADS-1). Everything is read from the chain at
// the moment it is asked for: there is no indexer and no cache of balances.
//
// What differs between devnet, a local validator and mainnet comes in through `ChainConfig`: the
// network, the program id (`contracts.program`) and the price account. The cash mint, the program that
// must own the price account, and the default keeper are read from the program's own Config account, so
// what this reports is what the program enforces.

/** The signature fee of a transaction with one signer. No priority fee is counted until a builder sets one (ADS-2). */
const SIGNATURE_FEE_LAMPORTS = 5_000n;
/**
 * A bound on the token accounts a vault opens. A classic one is 165 bytes; one for a mint with the
 * stock tokens' extension set measured 179 (fixtures/solana-vault). Rent is counted for this size, so
 * the need is never under what an account costs.
 */
export const TOKEN_ACCOUNT_BYTES_BOUND = 200;

export type SolanaVaultReaderOptions = {
  /** The chain's config. `contracts.program` is the vault program; `priceSource.address` the price account. */
  config: ChainConfig;
  /** Made by the caller from its own RPC URL. */
  rpc: VaultRpc;
  /**
   * The assets of this network, with what the chain does not hold of each: its id, its class, its
   * sheet. The program's own list (`getAssetList`) has the mints a vault may hold and each one's
   * ceiling. An asset with `priceKind: 'scope'` carries its entry's index in `priceRef`.
   */
  assets: BasketAsset[];
  /** `readonly` until the builders exist (ADS-2). */
  trade?: 'live' | 'readonly';
  /** False until auto-follow is switched on for the network (gate G-SEC): the program has the keeper leg. */
  autoFollow?: boolean;
  commitment?: Commitment;
  /** The clock that stamps `fetchedAt` and `observedAt`. Ages come from the cluster's clock, not this one. */
  now?: () => Date;
};

/** One position of a vault, as the keeper's leg would find it now. */
export type KeeperPosition = {
  asset: AssetId;
  mint: Address;
  targetBps: number;
  /** What the vault's token account holds. */
  raw: string;
  /** What the program has recorded. A leg values a position it does not trade by this. */
  trackedRaw: string;
  /** True when the two differ: `sync_balances` before a leg, or the weights are off. */
  needsSync: boolean;
  /** The admin's switch on the asset. */
  keeperOn: boolean;
  /** The price entry and its one-hour average, with their ages by the cluster's clock; null when unreadable. */
  price: { usdPerToken: string; ageSeconds: number } | null;
  twap: { usdPerToken: string; ageSeconds: number } | null;
  /**
   * Why the program would not value the asset now, by its own error; null when it would. While the
   * vault holds any of the asset, this stops every leg in the vault, not only one in this asset.
   */
  reference: ReferenceRefusal | null;
  /** Why the asset itself cannot be traded now, though it can be valued; null when it can. */
  trade: 'Cooldown' | 'HookNotAllowed' | 'MultiplierWindow' | 'MarketClosed' | null;
  /** Unix seconds from which the cooldown allows a trade in the asset again; null when it never traded. */
  cooldownUntil: number | null;
};

/** What a keeper needs to plan a leg in one vault, all of it read at one moment. */
export type KeeperContext = {
  vault: VaultState;
  /** The program's rules as Config has them now. */
  rules: {
    paused: boolean;
    toleranceBps: number;
    lossCapBps: number;
    bandBps: number;
    twapDevBps: number;
    maxPriceAgeSeconds: number;
    maxTwapAgeSeconds: number;
    cooldownSeconds: number;
  };
  /**
   * The one price account a leg passes: the account the asset list names for every position. Null
   * when the positions are not all priced in one account, which a leg cannot value.
   */
  priceAccount: Address | null;
  /** The vault's positions, in the program's order. */
  positions: KeeperPosition[];
  /**
   * Why no leg at all would pass in this vault now: auto-follow off, the pause, or a position the
   * vault holds that cannot be valued. Null when a leg in a tradable position could.
   */
  blocked: ChainErrorCode | null;
  /** The cluster's clock at the read, in unix seconds: what the program compares an effective time with. */
  clock: number;
};

/** `provenance` is 'live' on mainnet and 'sandbox' on a test network or a local validator. */
export type SolanaVaultReader = ChainReader & {
  readonly program: Address;
  /** The program's Config account as it is now. */
  getConfig(): Promise<ConfigAccount>;
  /** The program's own asset list as it is now: the mints a vault may hold, and each one's entry. */
  getAssetList(): Promise<AssetRegistryAccount>;
  /** A vault as `keeper_leg` would find it now, or null when there is no vault at the address. */
  getKeeperContext(vault: string): Promise<KeeperContext | null>;
};

const refuse = (code: ConstructorParameters<typeof ChainError>[0], message: string): never => {
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

/** Nothing but a ChainError leaves the reader: anything else is a bug or a broken account, reported as Unknown. */
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

/**
 * A token as a balance is read and shown: a listed asset, or one the app does not list, which a vault
 * can still hold a line of (a shared portfolio's author put it there) and is shown under its mint.
 */
type Held = { id: AssetId; address: string; decimals: number };

/** What every read of vaults and wallets starts from, taken in one call so it is one moment. */
type Snapshot = {
  onchain: ConfigAccount;
  clock: ClusterClock;
  /** The program's asset list, or null where it is not initialised. */
  registry: AssetRegistryAccount | null;
  /** By mint address, for every listed asset, and for each unlisted one a read has needed. */
  mints: Map<string, MintInfo>;
  /** The other accounts asked for in the same call, in order. */
  extra: (RawAccount | null)[];
};

export function createSolanaVaultReader(options: SolanaVaultReaderOptions): SolanaVaultReader {
  const { config, rpc } = options;
  const commitment = options.commitment ?? 'confirmed';
  const now = options.now ?? (() => new Date());

  if (config.id !== 'solana')
    throw new Error(`the Solana reader was given the config of ${config.id}`);
  const programId = config.contracts.program;
  if (!programId)
    throw new Error('contracts.solana.program is not set: the vault program has no address');
  const program = programId as Address;
  const provenance = chainProvenance(config.network, 'readonly') ?? 'sandbox';

  // Every asset this reader lists carries the label of the network it is read from.
  const assets = options.assets.map((a) => BasketAsset.parse({ ...a, provenance }));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const byMint = new Map(assets.map((a) => [a.address, a]));
  if (byId.size !== assets.length || byMint.size !== assets.length)
    throw new Error('the asset list names an id or a mint twice');
  const cashAssets = assets.filter((a) => a.cls === 'cash');
  const cash = cashAssets[0];
  if (cashAssets.length !== 1 || !cash)
    throw new Error('the asset list needs exactly one cash token');
  for (const a of assets) {
    if (a.chain !== 'solana') throw new Error(`${a.id} is not a Solana asset`);
    if (a.priceKind === 'chainlink')
      throw new Error(`${a.id}: Solana has no Chainlink price source`);
    if (a.priceKind === 'scope' && scopeIndex(a.priceRef) === null)
      throw new Error(`${a.id}: priceRef must be a Scope entry index, 0 to 511`);
  }

  const capabilities: Capabilities = {
    trade: options.trade ?? 'readonly',
    autoFollow: options.autoFollow ?? false,
    maxTradesPerTx: 1,
    tradesInCreate: false,
    needsApprove: false,
  };

  let configPda: Promise<Address> | undefined;
  const configAt = () => {
    configPda ??= configAddress(program);
    return configPda;
  };

  function readConfig(account: RawAccount | null): ConfigAccount {
    if (!account || account.owner !== program || !isAccount('config', account.data))
      // Asking again changes nothing until someone deploys: not retryable.
      throw new ChainError(
        'Unavailable',
        `the vault program ${program} has no Config on ${config.networkName}: not deployed, or not initialised`,
        false,
      );
    return decodeConfig(account.data);
  }

  let assetsPda: Promise<Address> | undefined;
  const assetsAt = () => {
    assetsPda ??= assetsAddress(program);
    return assetsPda;
  };

  /** Config, the clock, the program's asset list and every listed mint, plus `extra`, in one call. */
  async function snapshot(extra: Address[] = []): Promise<Snapshot> {
    const mintAddresses = assets.map((a) => a.address as Address);
    const accounts = await getAccounts(
      rpc,
      [await configAt(), SYSVAR_CLOCK, await assetsAt(), ...mintAddresses, ...extra],
      commitment,
    );
    const onchain = readConfig(accounts[0] ?? null);
    const clock = decodeClock(accounts[1] ?? null);
    const list = accounts[2];
    const registry =
      list && list.owner === program && isAccount('assets', list.data)
        ? decodeAssetRegistry(list.data)
        : null;
    if (onchain.cashMint !== cash?.address)
      refuse(
        'Unknown',
        `the listed cash token ${cash?.id} is not the cash mint in the program's Config`,
      );
    const mints = new Map<string, MintInfo>();
    for (const [i, asset] of assets.entries()) {
      const account = accounts[3 + i];
      if (!account || !isTokenProgram(account.owner))
        return refuse('Unknown', `${asset.id} is listed, but there is no mint at its address`);
      const mint = decodeMint(account.owner, account.data);
      if (mint.decimals !== asset.decimals)
        refuse(
          'Unknown',
          `${asset.id} is listed with ${asset.decimals} decimals; its mint has ${mint.decimals}`,
        );
      mints.set(asset.address, mint);
    }
    return { onchain, clock, registry, mints, extra: accounts.slice(3 + assets.length) };
  }

  /**
   * What each holder has of each asset: the balance of the associated token account for (holder, mint,
   * the mint's own token program). No such account, or one that is not the holder's, counts as nothing.
   * A frozen account's balance is still the holder's and is reported; `frozen` says it cannot move.
   */
  async function balances(
    pairs: { holder: Address; asset: Held }[],
    snap: Snapshot,
  ): Promise<{ amount: bigint; frozen: boolean }[]> {
    return (await balancesAnd(pairs, [], snap)).amounts;
  }

  /** As `balances`, with `others` read in the same call and handed back as they are. */
  async function balancesAnd(
    pairs: { holder: Address; asset: Held }[],
    others: Address[],
    snap: Snapshot,
  ): Promise<{ amounts: { amount: bigint; frozen: boolean }[]; others: (RawAccount | null)[] }> {
    const programs = pairs.map(({ asset }) => {
      const mint = snap.mints.get(asset.address);
      return mint ? mint.tokenProgram : refuse('Unknown', `${asset.id} has no mint`);
    });
    const addresses = await Promise.all(
      pairs.map(({ holder, asset }, i) =>
        associatedTokenAddress(holder, asset.address as Address, programs[i] as Address),
      ),
    );
    const accounts = await getAccounts(rpc, [...addresses, ...others], commitment);
    const nothing = { amount: 0n, frozen: false };
    const amounts = pairs.map(({ holder, asset }, i) => {
      const account = accounts[i];
      // Lamports sent to the address before the token account exists leave a system account there.
      if (!account || account.owner !== programs[i]) return nothing;
      const token = decodeTokenAccount(account.data);
      return token.mint === asset.address && token.owner === holder ? token : nothing;
    });
    return { amounts, others: accounts.slice(addresses.length) };
  }

  const hex = (bytes: ArrayLike<number>) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  /** A shared portfolio's bytes as a shared portfolio, or a refusal when they are not one. */
  function readRecipe(address: Address, account: RawAccount | null): RecipeAccount {
    if (!account || account.owner !== program || !isAccount('recipe', account.data))
      throw new ChainError('RecipeNotFound', `no shared portfolio at ${address}`, false);
    return decodeRecipe(account.data);
  }

  /**
   * The id of the asset a line names: the caller's id for a listed mint, and for any other the id made
   * from the mint. An author can put a token in a shared portfolio that this app does not list; it is
   * shown as a token the app does not know, never refused, or one portfolio would stop every read of
   * every vault that follows it.
   */
  const idOfMint = (mint: string): AssetId =>
    byMint.get(mint)?.id ?? unlistedAssetId(mint as Address);

  /** One version of a shared portfolio in the shape every chain answers with. */
  function recipeOf(address: Address, account: RecipeAccount, version: RecipeVersion): Recipe {
    if (account.maxFeeBps !== 0 || account.flags !== 0)
      refuse(
        'Unknown',
        `the shared portfolio ${address} carries a fee or flags the program refuses`,
      );
    return Recipe.parse({
      schemaVersion: 1,
      familyId: hex(account.familyId),
      chain: 'solana',
      onchainId: address,
      creator: account.creator,
      kind: 'community',
      version: version.version,
      effectiveAt: Number(version.effectiveAt),
      components: version.components.map((c) => ({
        kind: 'asset',
        asset: idOfMint(c.mint),
        weightBps: c.weightBps,
      })),
      metaHash: hex(version.metaHash),
      maxFeeBps: 0,
      flags: 0,
    });
  }

  /**
   * What a vault that follows has not applied yet: the version in effect when the vault took an
   * earlier one, or else the version that waits. `newAssets` are the ones the vault has no target on,
   * which the owner has to accept by hand.
   */
  function pendingFor(vault: VaultAccount, recipe: RecipeAccount, clock: ClusterClock) {
    const { active, pending } = versionsAt(recipe, clock.unixTimestamp);
    const next = active.version > vault.acceptedVersion ? active : pending;
    if (!next) return null;
    const accepted = new Set(vault.positions.filter((p) => p.targetBps > 0).map((p) => p.mint));
    return {
      version: next.version,
      effectiveAt: Number(next.effectiveAt),
      newAssets: next.components.filter((c) => !accepted.has(c.mint)).map((c) => idOfMint(c.mint)),
    };
  }

  function holding(asset: Held, raw: bigint, snap: Snapshot): Holding {
    const mint = snap.mints.get(asset.address);
    if (!mint) return refuse('Unknown', `${asset.id} has no mint`);
    const multiplier = multiplierString(multiplierAt(mint, snap.clock.unixTimestamp));
    // What the issuer has scheduled and the cluster's clock has not reached yet.
    const next = scheduledMultiplier(mint, snap.clock.unixTimestamp);
    return {
      asset: asset.id,
      raw: raw.toString(),
      multiplier,
      display: displayAmount(raw, multiplier, asset.decimals),
      ...(next
        ? {
            scheduled: {
              multiplier: multiplierString(next.multiplier),
              effectiveAt: Number(next.effectiveAt),
            },
          }
        : {}),
    };
  }

  /**
   * The assets whose token accounts a vault is read for: cash, then its targets in the program's
   * order, then every other listed asset. A token the vault holds without a target on it (sent in from
   * outside, or left over when the targets changed) is still the owner's to see and to withdraw. A
   * target on a mint the app does not list is read under the id made from its mint, with the decimals
   * of its mint: `snap.mints` has it (`addUnlistedMints`).
   */
  function vaultAssets(address: Address, vault: VaultAccount, snap: Snapshot): Held[] {
    if (!cash) return refuse('Unknown', 'no cash token');
    const targets = vault.positions.map((p): Held => {
      const asset = byMint.get(p.mint);
      // The program refuses the cash mint as a target: a vault that has one is not one it wrote.
      if (asset?.id === cash.id)
        return refuse('Unknown', `vault ${address} has a target on the cash token`);
      if (asset) return asset;
      const mint = snap.mints.get(p.mint);
      return { id: unlistedAssetId(p.mint), address: p.mint, decimals: mint?.decimals ?? 0 };
    });
    const others = assets.filter((a) => a.id !== cash.id && !targets.includes(a));
    return [cash, ...targets, ...others];
  }

  /**
   * Reads the mints of the vaults' targets that the app does not list into the snapshot. A mint that
   * cannot be decoded keeps the token program that owns it; one that is gone (a Token-2022 mint can be
   * closed once nothing of it is left) is read as the program's list has it, holding nothing.
   */
  async function addUnlistedMints(vaults: VaultAccount[], snap: Snapshot): Promise<void> {
    const unlisted = [...new Set(vaults.flatMap((v) => v.positions.map((p) => p.mint)))].filter(
      (mint) => !snap.mints.has(mint),
    );
    if (unlisted.length === 0) return;
    const accounts = await getAccounts(rpc, unlisted, commitment);
    unlisted.forEach((mint, i) => {
      const account = accounts[i];
      const entry = snap.registry?.assets.find((e) => e.mint === mint);
      const owner = account && isTokenProgram(account.owner) ? account.owner : null;
      let info: MintInfo | null = null;
      if (account && owner) {
        try {
          info = decodeMint(owner, account.data);
        } catch {
          info = null;
        }
      }
      // A mint it cannot decode still says, by its owner, which program its token accounts are under.
      snap.mints.set(
        mint,
        info ?? {
          tokenProgram: owner ?? TOKEN_PROGRAM,
          decimals: entry?.decimals ?? 0,
          scaledUiAmount: null,
          hookProgram: null,
        },
      );
    });
  }

  /** The price accounts the asset list names, each once. */
  const namedPriceAccounts = (snap: Snapshot): Address[] => [
    ...new Set((snap.registry?.priceAccounts ?? []).filter((a) => a !== ZERO_ADDRESS)),
  ];

  /** The entry of a mint in the program's asset list and the price account it points at. */
  function listed(mint: string, snap: Snapshot, prices: Map<string, RawAccount | null>) {
    const entry = snap.registry?.assets.find((e) => e.mint === mint) ?? null;
    const named = entry && snap.registry ? priceAccountOf(entry, snap.registry) : null;
    return { entry, named, account: named ? (prices.get(named) ?? null) : null };
  }

  /**
   * What is left of the vault's loss counter, as a share of what the vault holds now: cash at one
   * dollar, and each position at its price entry as it is, fresh or not. A position whose price
   * cannot be read counts for nothing, which makes the share larger, never smaller. The program
   * measures the cap against the vault's value at the moment of a leg; this is the reader's best view
   * of the same number between legs.
   */
  function lossUsedBps(
    vault: VaultAccount,
    cashRaw: bigint,
    positionsRaw: bigint[],
    snap: Snapshot,
    prices: Map<string, RawAccount | null>,
  ): number {
    const left = decayedLoss(vault.lossAccum, vault.lossTs, snap.clock.unixTimestamp);
    if (left === 0n) return 0;
    let value = cashRaw;
    for (const [i, position] of vault.positions.entries()) {
      const raw = positionsRaw[i] ?? 0n;
      const { entry, account } = listed(position.mint, snap, prices);
      if (raw === 0n || !entry || entry.priceKind !== 1) continue;
      if (
        !account ||
        account.owner !== snap.onchain.priceOwner ||
        account.data.length !== SCOPE_PRICES_BYTES
      )
        continue;
      const price = decodeScopeEntry(account.data, entry.priceIndex);
      if (price.value === 0n || price.exponent > MAX_PRICE_EXPONENT) continue;
      value += valueInCash(raw, price, entry.decimals, cash?.decimals ?? 0);
    }
    if (value === 0n) return 10_000;
    const bps = (left * 10_000n) / value;
    return bps > 10_000n ? 10_000 : Number(bps);
  }

  function vaultState(
    address: Address,
    vault: VaultAccount,
    held: Holding[],
    recipe: RecipeAccount | null,
    snap: Snapshot,
    prices: Map<string, RawAccount | null>,
    observedAt: string,
  ): VaultState {
    const [cashHolding, ...rest] = held;
    if (!cashHolding) return refuse('Unknown', 'no cash holding');
    const targets = rest.slice(0, vault.positions.length);
    const others = rest.slice(vault.positions.length).filter((h) => h.raw !== '0');
    return {
      chain: 'solana',
      address,
      owner: vault.owner,
      basketId: vault.basketId.toString(),
      recipeOnchainId: vault.recipe === ZERO_ADDRESS ? null : vault.recipe,
      acceptedVersion: vault.acceptedVersion,
      autoFollow: vault.autoFollow,
      keeper: vault.keeper === ZERO_ADDRESS ? snap.onchain.defaultKeeper : vault.keeper,
      cash: cashHolding,
      positions: [
        ...vault.positions.map((p, i) => {
          const h = targets[i];
          if (!h) return refuse('Unknown', 'a position has no holding');
          return {
            ...h,
            targetBps: p.targetBps,
            lastKeeperAt: p.lastKeeperTs > 0n ? Number(p.lastKeeperTs) : null,
          };
        }),
        // Held with no target: the weight it should have is zero.
        ...others.map((h) => ({ ...h, targetBps: 0, lastKeeperAt: null })),
      ],
      lossUsedBps: lossUsedBps(
        vault,
        BigInt(cashHolding.raw),
        targets.map((h) => BigInt(h.raw)),
        snap,
        prices,
      ),
      observedAt,
      pending: recipe ? pendingFor(vault, recipe, snap.clock) : null,
    };
  }

  /**
   * Reads the token accounts of every vault in one batch. `Position.tracked` is never used for a
   * balance: it is a hint. The price accounts the asset list names are read in the same call when a
   * vault has a loss counter to show, or when `withPrices` asks for them.
   */
  async function readVaults(
    found: { address: Address; vault: VaultAccount }[],
    snap: Snapshot,
    withPrices = false,
  ): Promise<{ states: VaultState[]; prices: Map<string, RawAccount | null> }> {
    const observedAt = now().toISOString();
    await addUnlistedMints(
      found.map(({ vault }) => vault),
      snap,
    );
    const lists = found.map(({ address, vault }) => vaultAssets(address, vault, snap));
    // The shared portfolios these vaults follow, each once, read in the same call as the balances.
    const followed = [
      ...new Set(found.map(({ vault }) => vault.recipe).filter((r) => r !== ZERO_ADDRESS)),
    ];
    const counting = found.some(
      ({ vault }) => decayedLoss(vault.lossAccum, vault.lossTs, snap.clock.unixTimestamp) > 0n,
    );
    const priced = withPrices || counting ? namedPriceAccounts(snap) : [];
    const { amounts, others } = await balancesAnd(
      found.flatMap(({ address }, i) =>
        (lists[i] ?? []).map((asset) => ({ holder: address, asset })),
      ),
      [...followed, ...priced],
      snap,
    );
    const prices = new Map(
      priced.map((address, i) => [address as string, others[followed.length + i] ?? null]),
    );
    const recipes = new Map(
      followed.map((address, i) => {
        const account = others[i] ?? null;
        // The program writes a vault's `recipe` only from a shared portfolio it was handed, and
        // never closes one: a vault that points at nothing is not something it wrote.
        if (!account || account.owner !== program || !isAccount('recipe', account.data))
          return refuse('Unknown', `a vault follows ${address}, which is not a shared portfolio`);
        return [address, decodeRecipe(account.data)] as const;
      }),
    );
    let at = 0;
    const states = found.map(({ address, vault }, i) => {
      const held = (lists[i] ?? []).map((asset) =>
        holding(asset, amounts[at++]?.amount ?? 0n, snap),
      );
      const recipe = recipes.get(vault.recipe) ?? null;
      return vaultState(address, vault, held, recipe, snap, prices, observedAt);
    });
    return { states, prices };
  }

  const vaultStates = async (found: { address: Address; vault: VaultAccount }[], snap: Snapshot) =>
    (await readVaults(found, snap)).states;

  /** A price entry as the keeper sees it: dollars for a whole token, and its age by the cluster's clock. */
  const seen = (entry: ScopeEntry | null, clock: ClusterClock) => {
    if (!entry) return null;
    const age = clock.unixTimestamp - entry.unixTimestamp;
    return { usdPerToken: scopePrice(entry), ageSeconds: age > 0n ? Number(age) : 0 };
  };

  /** One position of a vault as `keeper_leg` would find it. `raw` is what its token account holds. */
  function keeperPosition(
    position: VaultAccount['positions'][number],
    raw: string,
    snap: Snapshot,
    prices: Map<string, RawAccount | null>,
  ): KeeperPosition {
    const asset = byMint.get(position.mint) ?? {
      id: unlistedAssetId(position.mint),
      address: position.mint,
    };
    const { entry, account } = listed(position.mint, snap, prices);
    const now = snap.clock.unixTimestamp;
    const reference = entry
      ? referenceOf(entry, account, snap.onchain, now)
      : { price: null, twap: null, refusal: 'AssetNotPriced' as const };
    const cooldownUntil =
      position.lastKeeperTs > 0n
        ? Number(position.lastKeeperTs + BigInt(snap.onchain.assetCooldownS))
        : null;
    const mint = snap.mints.get(asset.address);
    // In the program's order: the cooldown, the mint, then the market.
    const trade =
      cooldownUntil !== null && now < BigInt(cooldownUntil)
        ? 'Cooldown'
        : mint?.hookProgram
          ? 'HookNotAllowed'
          : mint && inMultiplierWindow(mint, now)
            ? 'MultiplierWindow'
            : marketAt(entry?.session === 1 ? 'us_equity' : 'always', snap.onchain, snap.clock) ===
                'closed'
              ? 'MarketClosed'
              : null;
    return {
      asset: asset.id,
      mint: position.mint,
      targetBps: position.targetBps,
      raw,
      trackedRaw: position.tracked.toString(),
      needsSync: position.tracked.toString() !== raw,
      keeperOn: entry ? keeperOn(entry) : false,
      price: seen(reference.price, snap.clock),
      twap: seen(reference.twap, snap.clock),
      reference: reference.refusal,
      trade,
      cooldownUntil,
    };
  }

  const solanaAddress = (value: unknown, what: string) =>
    input(SolanaAddress, value, what) as Address;

  let rents: Promise<{ wallet: bigint; vault: bigint; tokenAccount: bigint }> | undefined;
  /** Rent-exempt minimums, asked once: an empty wallet, a vault account, a token account. */
  const rent = () => {
    const one = (bytes: number) =>
      ask('getMinimumBalanceForRentExemption', () =>
        rpc.getMinimumBalanceForRentExemption(BigInt(bytes), { commitment }).send(),
      ).then(BigInt);
    rents ??= Promise.all([one(0), one(VAULT_SIZE), one(TOKEN_ACCOUNT_BYTES_BOUND)])
      .then(([wallet, vault, tokenAccount]) => ({ wallet, vault, tokenAccount }))
      .catch((e) => {
        rents = undefined;
        throw e;
      });
    return rents;
  };

  const reader: SolanaVaultReader = {
    chain: 'solana',
    capabilities,
    program,
    provenance,

    getConfig: () => guarded(async () => (await snapshot()).onchain),

    getAssetList: () =>
      guarded(async () => {
        const [account] = await getAccounts(rpc, [await assetsAddress(program)], commitment);
        if (!account || account.owner !== program || !isAccount('assets', account.data))
          throw new ChainError(
            'Unavailable',
            `the vault program ${program} has no asset list on ${config.networkName}: not initialised`,
            false,
          );
        return decodeAssetRegistry(account.data);
      }),

    listAssets: () => guarded(async () => structuredClone(assets)),

    getPrices: (ids) =>
      guarded(async (): Promise<Price[]> => {
        const wanted = [...new Set(input(z.array(AssetId), ids, 'assets'))].map(
          (id) => byId.get(id) ?? refuse('MintNotAccepted', `${id} is not listed on Solana`),
        );
        // An asset with no price source has no price here. Nothing is made up for it.
        const priced = wanted.filter((a) => a.priceKind === 'scope');
        if (priced.length === 0) return [];
        const account = config.priceSource.address;
        if (config.priceSource.kind !== 'scope' || !account)
          return refuse('AssetNotPriced', `no price account is set for ${config.networkName}`);
        const [configAccount, clockAccount, priceAccount] = await getAccounts(
          rpc,
          [await configAt(), SYSVAR_CLOCK, account as Address],
          commitment,
        );
        const onchain = readConfig(configAccount ?? null);
        const clock = decodeClock(clockAccount ?? null);
        const readings = readScopeAccount(
          priceAccount ?? null,
          onchain.priceOwner,
          priced.map((a) => ({ index: scopeIndex(a.priceRef) ?? -1, asset: a.id })),
          clock,
          {
            maxAheadSeconds: onchain.maxPriceAgeS,
            // Scope's discriminator on every network: mainnet's account is Kamino's, and the test
            // exchange's (TNET-4) starts with the same eight bytes.
            discriminator: SCOPE_PRICES_DISCRIMINATOR,
          },
        );
        const fetchedAt = now().toISOString();
        return priced.map((asset, i): Price => {
          const reading = readings[i];
          if (!reading) return refuse('AssetNotPriced', `${asset.id} has no price`);
          return {
            source: `price account ${account} (Scope layout, owner ${onchain.priceOwner}), entry ${reading.index}`,
            method:
              "value / 10^exponent of the entry; age is the cluster's clock less the entry's time",
            fetchedAt,
            provenance,
            asset: asset.id,
            usdPerToken: reading.usdPerToken,
            ageSeconds: reading.ageSeconds,
            // The program's own limit, from the same read of Config: the keeper leg refuses past it.
            maxAgeSeconds: onchain.maxPriceAgeS,
            market: marketAt(asset.session, onchain, clock),
          };
        });
      }),

    getVaults: (owner) =>
      guarded(async () => {
        const who = solanaAddress(owner, 'owner');
        // The discriminator and the owner sit side by side at bytes 0 to 40: one filter finds both.
        const filter: Memcmp = {
          offset: 0,
          bytes: new Uint8Array([...VAULT_DISCRIMINATOR, ...getAddressEncoder().encode(who)]),
        };
        const [accounts, snap] = await Promise.all([
          getProgramAccounts(rpc, program, { dataSize: VAULT_SIZE, memcmp: [filter] }, commitment),
          snapshot(),
        ]);
        const found = accounts
          .map((account) => ({ address: account.address, vault: decodeVault(account.data) }))
          .filter(({ vault }) => vault.owner === who)
          .sort((a, b) => (a.vault.basketId < b.vault.basketId ? -1 : 1));
        return vaultStates(found, snap);
      }),

    getVault: (vault) =>
      guarded(async () => {
        const address = solanaAddress(vault, 'vault');
        const snap = await snapshot([address]);
        const account = snap.extra[0];
        if (!account || account.owner !== program || !isAccount('vault', account.data)) return null;
        const [state] = await vaultStates([{ address, vault: decodeVault(account.data) }], snap);
        return state ?? null;
      }),

    getKeeperContext: (vault) =>
      guarded(async (): Promise<KeeperContext | null> => {
        const address = solanaAddress(vault, 'vault');
        const snap = await snapshot([address]);
        const account = snap.extra[0];
        if (!account || account.owner !== program || !isAccount('vault', account.data)) return null;
        const decoded = decodeVault(account.data);
        const { states, prices } = await readVaults([{ address, vault: decoded }], snap, true);
        const [state] = states;
        if (!state) return null;
        const positions = decoded.positions.map((position, i) =>
          keeperPosition(position, state.positions[i]?.raw ?? '0', snap, prices),
        );
        // A leg passes one price account: every position it values has to be priced in it.
        const named = new Set(
          decoded.positions.map((p) => listed(p.mint, snap, prices).named ?? ZERO_ADDRESS),
        );
        const [only] = named;
        const held = positions.find((p) => p.trackedRaw !== '0' && p.reference);
        return {
          vault: state,
          rules: {
            paused: snap.onchain.keeperPaused,
            toleranceBps: snap.onchain.toleranceBps,
            lossCapBps: snap.onchain.lossCapBps,
            bandBps: snap.onchain.bandBps,
            twapDevBps: snap.onchain.twapDevBps,
            maxPriceAgeSeconds: snap.onchain.maxPriceAgeS,
            maxTwapAgeSeconds: Number(MAX_TWAP_AGE_SECONDS),
            cooldownSeconds: snap.onchain.assetCooldownS,
          },
          priceAccount: named.size === 1 && only && only !== ZERO_ADDRESS ? only : null,
          positions,
          blocked: !decoded.autoFollow
            ? 'AutoFollowOff'
            : snap.onchain.keeperPaused
              ? 'KeeperPaused'
              : (held?.reference ?? null),
          clock: Number(snap.clock.unixTimestamp),
        };
      }),

    listAutoFollowVaults: (recipeOnchainId) =>
      guarded(async () => {
        const memcmp: Memcmp[] = [
          { offset: 0, bytes: VAULT_DISCRIMINATOR },
          { offset: VAULT_AUTO_FOLLOW_OFFSET, bytes: new Uint8Array([1]) },
        ];
        if (recipeOnchainId !== undefined)
          memcmp.push({
            offset: VAULT_RECIPE_OFFSET,
            bytes: new Uint8Array(
              getAddressEncoder().encode(solanaAddress(recipeOnchainId, 'recipeOnchainId')),
            ),
          });
        const found = await getProgramAccounts(
          rpc,
          program,
          { dataSize: VAULT_SIZE, memcmp, addressesOnly: true },
          commitment,
        );
        return found.map((account) => account.address).sort();
      }),

    getRecipe: (recipeOnchainId) =>
      guarded(async () => {
        const address = solanaAddress(recipeOnchainId, 'recipeOnchainId');
        const [account, clockAccount] = await getAccounts(rpc, [address, SYSVAR_CLOCK], commitment);
        const recipe = readRecipe(address, account ?? null);
        // Which version is in effect is a matter of the cluster's clock, as it is for the program.
        const { active, pending } = versionsAt(
          recipe,
          decodeClock(clockAccount ?? null).unixTimestamp,
        );
        return {
          active: recipeOf(address, recipe, active),
          pending: pending ? recipeOf(address, recipe, pending) : null,
        };
      }),

    getWalletHoldings: (owner) =>
      guarded(async () => {
        const who = solanaAddress(owner, 'owner');
        const snap = await snapshot();
        const amounts = await balances(
          assets.map((asset) => ({ holder: who, asset })),
          snap,
        );
        return assets.flatMap((asset, i) => {
          const raw = amounts[i]?.amount ?? 0n;
          return raw > 0n ? [holding(asset, raw, snap)] : [];
        });
      }),

    funding: (owner, need) =>
      guarded(async (): Promise<Funding> => {
        const who = solanaAddress(owner, 'owner');
        const wanted = input(FundingNeed, need, 'need');
        if (!cash) return refuse('Unknown', 'no cash token');
        const [snap, lamports, rents] = await Promise.all([
          snapshot(),
          ask('getBalance', () => rpc.getBalance(who, { commitment }).send()),
          rent(),
        ]);
        const [held] = await balances([{ holder: who, asset: cash }], snap);
        // Cash in a frozen account is the wallet's, and getWalletHoldings shows it, but it cannot be
        // deposited: it does not count toward what the wallet can pay.
        const cashHave = held && !held.frozen ? held.amount : 0n;
        const gasHave = BigInt(lamports.value);
        // A new vault is at least the transaction that creates it.
        const legs = BigInt(wanted.newVault ? Math.max(wanted.legs, 1) : wanted.legs);
        // Each transaction may open one token account: the cash account when a vault is created, a
        // position's account in the trade that first buys it. Where the caller says how many are
        // opened (`newAccounts`), that many are charged; where it does not, every leg is charged one.
        // A new vault adds the rent of its own account. A wallet that pays for anything must stay
        // above its own rent-exempt minimum. The builder's simulation has the last word.
        const accounts = wanted.newAccounts === undefined ? legs : BigInt(wanted.newAccounts);
        const gasNeed =
          legs === 0n
            ? 0n
            : rents.wallet +
              legs * SIGNATURE_FEE_LAMPORTS +
              accounts * rents.tokenAccount +
              (wanted.newVault ? rents.vault : 0n);
        return {
          chain: 'solana',
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
          'the reader does not quote: quotes arrive with the swap builder (ADS-2)',
        ),
      ),

    track: (txId, validUntil) =>
      guarded(async (): Promise<TxStatus> => {
        if (!isSignature(txId)) return refuse('BadInput', 'txId: expected a transaction signature');
        const signature: Signature = txId;
        const explorerUrl = explorerLink(config, txId) ?? '';
        const statusNow = async () => {
          const statuses = await ask('getSignatureStatuses', () =>
            rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(),
          );
          return statuses.value[0] ?? null;
        };
        let status = await statusNow();
        if (!status && validUntil !== undefined) {
          const lastValid = input(z.string().regex(/^\d+$/), validUntil, 'validUntil');
          // Always the finalized height, whatever this reader's commitment: a height read from a fork
          // that is later dropped can be past the last valid block while the transaction still lands.
          const height = await ask('getBlockHeight', () =>
            rpc.getBlockHeight({ commitment: 'finalized' }).send(),
          );
          if (BigInt(height) > BigInt(lastValid)) {
            // The chain is past the last block the transaction could land in. It may have landed
            // between the two questions, so it is asked for once more before it is called expired:
            // an expiry that is wrong would have the same step sent twice.
            status = await statusNow();
            if (!status) return { status: 'expired', explorerUrl };
          }
        }
        // `processed` can still be dropped with its fork: only a confirmed block counts as landed.
        if (
          status?.confirmationStatus !== 'confirmed' &&
          status?.confirmationStatus !== 'finalized'
        )
          return { status: 'pending', explorerUrl };
        if (!status.err) return { status: 'confirmed', explorerUrl };
        const tx = await ask('getTransaction', () =>
          rpc
            .getTransaction(signature, {
              commitment: commitment === 'processed' ? 'confirmed' : commitment,
              encoding: 'json',
              maxSupportedTransactionVersion: 0,
            })
            .send(),
        );
        const logs = tx?.meta?.logMessages ?? null;
        return {
          status: 'reverted',
          explorerUrl,
          error: describeFailure(status.err, logs, program),
        };
      }),
  };
  return reader;
}
