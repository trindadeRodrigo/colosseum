import {
  AssetId,
  BasketAsset,
  type Capabilities,
  type ChainConfig,
  ChainError,
  type ChainReader,
  chainProvenance,
  explorerLink,
  type Funding,
  FundingNeed,
  type Holding,
  type Price,
  type Provenance,
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
  type ConfigAccount,
  configAddress,
  decodeConfig,
  decodeVault,
  isAccount,
  VAULT_AUTO_FOLLOW_OFFSET,
  VAULT_DISCRIMINATOR,
  VAULT_RECIPE_OFFSET,
  VAULT_SIZE,
  type VaultAccount,
  ZERO_ADDRESS,
} from './accounts';
import { displayAmount, multiplierString } from './amounts';
import { type ClusterClock, decodeClock, marketAt, readScopeAccount, SYSVAR_CLOCK } from './prices';
import {
  ask,
  getAccounts,
  getProgramAccounts,
  type Memcmp,
  type RawAccount,
  type VaultRpc,
} from './rpc';
import { scopeIndex } from './scope';
import { describeFailure } from './status';
import {
  associatedTokenAddress,
  decodeMint,
  decodeTokenAccount,
  isTokenProgram,
  type MintInfo,
  multiplierAt,
} from './tokens';

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
   * The assets of this network. Until the program holds its own list (SOL-2) the caller supplies it.
   * An asset with `priceKind: 'scope'` carries its entry's index in `priceRef`.
   */
  assets: BasketAsset[];
  /** `readonly` until the builders exist (ADS-2). */
  trade?: 'live' | 'readonly';
  /** False until the keeper leg is on chain (SOL-3). */
  autoFollow?: boolean;
  commitment?: Commitment;
  /** The clock that stamps `fetchedAt` and `observedAt`. Ages come from the cluster's clock, not this one. */
  now?: () => Date;
};

export type SolanaVaultReader = ChainReader & {
  readonly program: Address;
  /** 'live' on mainnet, 'sandbox' on a test network or a local validator. */
  readonly provenance: Provenance;
  /** The program's Config account as it is now. */
  getConfig(): Promise<ConfigAccount>;
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

/** What every read of vaults and wallets starts from, taken in one call so it is one moment. */
type Snapshot = {
  onchain: ConfigAccount;
  clock: ClusterClock;
  /** By mint address, for every listed asset. */
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

  /** Config, the clock and every listed mint, plus `extra`, in one call. */
  async function snapshot(extra: Address[] = []): Promise<Snapshot> {
    const mintAddresses = assets.map((a) => a.address as Address);
    const accounts = await getAccounts(
      rpc,
      [await configAt(), SYSVAR_CLOCK, ...mintAddresses, ...extra],
      commitment,
    );
    const onchain = readConfig(accounts[0] ?? null);
    const clock = decodeClock(accounts[1] ?? null);
    if (onchain.cashMint !== cash?.address)
      refuse(
        'Unknown',
        `the listed cash token ${cash?.id} is not the cash mint in the program's Config`,
      );
    const mints = new Map<string, MintInfo>();
    for (const [i, asset] of assets.entries()) {
      const account = accounts[2 + i];
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
    return { onchain, clock, mints, extra: accounts.slice(2 + assets.length) };
  }

  /**
   * What each holder has of each asset: the balance of the associated token account for (holder, mint,
   * the mint's own token program). No such account, or one that is not the holder's, counts as nothing.
   */
  async function balances(
    pairs: { holder: Address; asset: BasketAsset }[],
    snap: Snapshot,
  ): Promise<bigint[]> {
    const programs = pairs.map(({ asset }) => {
      const mint = snap.mints.get(asset.address);
      return mint ? mint.tokenProgram : refuse('Unknown', `${asset.id} has no mint`);
    });
    const addresses = await Promise.all(
      pairs.map(({ holder, asset }, i) =>
        associatedTokenAddress(holder, asset.address as Address, programs[i] as Address),
      ),
    );
    const accounts = await getAccounts(rpc, addresses, commitment);
    return pairs.map(({ holder, asset }, i) => {
      const account = accounts[i];
      // Lamports sent to the address before the token account exists leave a system account there.
      if (!account || account.owner !== programs[i]) return 0n;
      const token = decodeTokenAccount(account.data);
      return token.mint === asset.address && token.owner === holder ? token.amount : 0n;
    });
  }

  function holding(asset: BasketAsset, raw: bigint, snap: Snapshot): Holding {
    const mint = snap.mints.get(asset.address);
    if (!mint) return refuse('Unknown', `${asset.id} has no mint`);
    const multiplier = multiplierString(multiplierAt(mint, snap.clock.unixTimestamp));
    return {
      asset: asset.id,
      raw: raw.toString(),
      multiplier,
      display: displayAmount(raw, multiplier, asset.decimals),
    };
  }

  /**
   * The assets whose token accounts a vault is read for: cash, then its targets in the program's
   * order, then every other listed asset. A token the vault holds without a target on it (sent in from
   * outside, or left over when the targets changed) is still the owner's to see and to withdraw.
   */
  function vaultAssets(address: Address, vault: VaultAccount): BasketAsset[] {
    if (!cash) return refuse('Unknown', 'no cash token');
    const targets = vault.positions.map((p) => {
      const asset = byMint.get(p.mint);
      if (!asset || asset.id === cash.id)
        return refuse(
          'MintNotAccepted',
          `vault ${address} has a target on ${p.mint}, which is ${asset ? 'the cash token' : 'not a listed asset'}`,
        );
      return asset;
    });
    const others = assets.filter((a) => a.id !== cash.id && !targets.includes(a));
    return [cash, ...targets, ...others];
  }

  function vaultState(
    address: Address,
    vault: VaultAccount,
    held: Holding[],
    snap: Snapshot,
    observedAt: string,
  ): VaultState {
    const [cashHolding, ...rest] = held;
    if (!cashHolding) return refuse('Unknown', 'no cash holding');
    const targets = rest.slice(0, vault.positions.length);
    const others = rest.slice(vault.positions.length).filter((h) => h.raw !== '0');
    // The registry is not on chain until SOL-2: what is pending for a follower cannot be read yet.
    if (vault.recipe !== ZERO_ADDRESS)
      refuse(
        'NotSupported',
        `vault ${address} follows a shared portfolio; reading one arrives with SOL-2`,
      );
    // The unit of the loss counter is set by the keeper leg (SOL-3). Until then only zero can be reported.
    if (vault.lossAccum !== 0n)
      refuse('NotSupported', `vault ${address} has a loss counter; reading it arrives with SOL-3`);
    return {
      chain: 'solana',
      address,
      owner: vault.owner,
      basketId: vault.basketId.toString(),
      recipeOnchainId: null,
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
      lossUsedBps: 0,
      observedAt,
      pending: null,
    };
  }

  /** Reads the token accounts of every vault in one batch. `Position.tracked` is never used: it is a hint. */
  async function vaultStates(
    found: { address: Address; vault: VaultAccount }[],
    snap: Snapshot,
  ): Promise<VaultState[]> {
    const observedAt = now().toISOString();
    const lists = found.map(({ address, vault }) => vaultAssets(address, vault));
    const amounts = await balances(
      found.flatMap(({ address }, i) =>
        (lists[i] ?? []).map((asset) => ({ holder: address, asset })),
      ),
      snap,
    );
    let at = 0;
    return found.map(({ address, vault }, i) => {
      const held = (lists[i] ?? []).map((asset) => holding(asset, amounts[at++] ?? 0n, snap));
      return vaultState(address, vault, held, snap, observedAt);
    });
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
          priced.map((a) => scopeIndex(a.priceRef) ?? -1),
          clock,
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

    getRecipe: () =>
      guarded(async () =>
        refuse(
          'NotSupported',
          'shared portfolios are not on chain yet: the registry arrives with SOL-2',
        ),
      ),

    getWalletHoldings: (owner) =>
      guarded(async () => {
        const who = solanaAddress(owner, 'owner');
        const snap = await snapshot();
        const amounts = await balances(
          assets.map((asset) => ({ holder: who, asset })),
          snap,
        );
        return assets.flatMap((asset, i) => {
          const raw = amounts[i] ?? 0n;
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
        const [cashHave = 0n] = await balances([{ holder: who, asset: cash }], snap);
        const gasHave = BigInt(lamports.value);
        // A new vault is at least the transaction that creates it.
        const legs = BigInt(wanted.newVault ? Math.max(wanted.legs, 1) : wanted.legs);
        // A new vault locks rent for its own account and for one token account per transaction: the
        // cash account when it is created, then one position's account in each trade that follows. An
        // existing vault is charged fees only; the builder's simulation has the last word. A wallet
        // that pays for anything must stay above its own rent-exempt minimum.
        const gasNeed =
          legs === 0n
            ? 0n
            : rents.wallet +
              legs * SIGNATURE_FEE_LAMPORTS +
              (wanted.newVault ? rents.vault + legs * rents.tokenAccount : 0n);
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
          'the vault cannot swap yet: quotes arrive with the swap (SOL-2, ADS-2)',
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
          const height = await ask('getBlockHeight', () =>
            rpc.getBlockHeight({ commitment }).send(),
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
