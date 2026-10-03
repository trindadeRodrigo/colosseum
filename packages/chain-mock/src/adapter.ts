import { CREATOR_LIMIT_ERROR, checkCreatorLimits } from '@colosseum/basket';
import {
  AcceptVersionArgs,
  Address,
  ApproveArgs,
  AssetId,
  type AttemptFate,
  AttemptRef,
  type BasketAsset,
  type BuiltTx,
  type Capabilities,
  type ChainAdapter,
  ChainError,
  type ChainErrorCode,
  type ChainId,
  CreateVaultArgs,
  chainFamily,
  DecimalString,
  DepositArgs,
  evmCallPreimage,
  type Funding,
  FundingNeed,
  type Holding,
  type LegKind,
  OwnerSwapArgs,
  type Price,
  PublishRecipeArgs,
  type Quote,
  RawAmount,
  type Recipe,
  SetAutoFollowArgs,
  SetTargetsArgs,
  type Target,
  Trade,
  type TxPreview,
  type TxStatus,
  type VaultState,
  WithdrawInKindArgs,
} from '@colosseum/schemas';
import { z } from 'zod';
import { displayAmount, swapOut, toScaled, valueScaled } from './amounts';
import { mockAddress, mockRecipeId, mockTxId, sha256Hex } from './ids';
import { mockAssets, mockPrices } from './shelf';

// A whole chain in memory, behind the ChainAdapter interface. Deterministic: the clock only moves when
// a test moves it, ids are hashes, and nothing reads the network, the environment or a random source.
// Everything it returns is stamped `provenance: 'mock'`. Every refusal is a ChainError, for bad
// arguments as much as for a transaction that would revert.

const SOURCE = 'chain-mock';
/** What a mock trade costs against the reference price. */
const TRADE_COST_BPS = 10;
/** Blocks a Solana transaction stays valid for; the mock mints one block a second. */
const VALID_BLOCKS = 60;
/** The slippage `quote()` allows for in `minOutRaw`. */
const QUOTE_SLIPPAGE_BPS = 50;
/** A Solana signature. A mock transaction has one slot for it, ahead of the message. */
const SIGNATURE_BYTES = 64;
/** Chain id 0 is no network: nothing the mock builds can be sent to a real one. */
const MOCK_EVM_CHAIN_ID = 0;
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
const lessBps = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;

type Position = { raw: bigint; targetBps: number; lastKeeperAt: number | null };
type MockVault = {
  address: Address;
  owner: Address;
  basketId: string;
  recipeOnchainId: string | null;
  acceptedVersion: number;
  autoFollow: boolean;
  cash: bigint;
  positions: Map<AssetId, Position>;
};
type MockRecipe = {
  active: Recipe;
  pending: Recipe | null;
  /** Unix seconds of the last publish: the next one waits a publish delay from it. */
  lastPublishAt: number;
};
type State = {
  /** Unix seconds of the mock clock, and the mock block height. */
  seconds: number;
  wallets: Map<Address, Map<AssetId, bigint>>;
  gas: Map<Address, bigint>;
  /** `${owner}>${spender}` to raw cash. */
  allowances: Map<string, bigint>;
  vaults: Map<Address, MockVault>;
  recipes: Map<string, MockRecipe>;
  prices: Map<AssetId, string>;
  multipliers: Map<AssetId, string>;
  /** A multiplier that takes over at a unix second of the mock clock. */
  scheduled: Map<AssetId, { multiplier: string; effectiveAt: number }>;
};

type Op =
  // `spender` is worked out when the approval is built: the caller never names one.
  | { kind: 'approve'; a: ApproveArgs & { spender: Address } }
  | { kind: 'create_vault'; a: CreateVaultArgs }
  | { kind: 'deposit'; a: DepositArgs }
  | { kind: 'swap'; a: OwnerSwapArgs }
  | { kind: 'set_targets'; a: SetTargetsArgs }
  | { kind: 'accept_version'; a: AcceptVersionArgs }
  | { kind: 'set_auto_follow'; a: SetAutoFollowArgs }
  | { kind: 'withdraw'; a: { vault: Address; assets: AssetId[] } }
  | { kind: 'publish'; a: PublishRecipeArgs }
  | { kind: 'adopt_version'; a: { vault: Address } }
  | { kind: 'keeper_leg'; a: { vault: Address; trade: Trade } };

/** What a run of an op hands back: what each trade paid out, and the least each may pay. */
type Run = { outs: bigint[]; mins?: bigint[] };
type Built = { op: Op; signer: Address; validUntil: number | null; txId: string; mins: bigint[] };
type Sent = { status: TxStatus['status']; validUntil: number | null; error?: TxStatus['error'] };

export type MockOptions = {
  chain: ChainId;
  /** Where the mock clock starts. Default: Mon 2026-10-05 15:00 UTC, inside the US session. */
  now?: string;
  /**
   * The publish delay: seconds between a later version being published and taking effect, and the
   * least between two versions. Default 300, the team test cycle.
   */
  publishDelaySeconds?: number;
  /** Replaces the built-in asset list. Exactly one asset must have `cls: 'cash'`. */
  assets?: BasketAsset[];
  /** USD per whole token by asset id. Required for every asset when `assets` is given. */
  prices?: Record<string, string>;
  /**
   * The band around a target inside which a keeper leg may end, in bps of the vault (DESIGN-VAULT
   * section 5, check 5). Default 50, the vaults' starting value.
   */
  bandBps?: number;
  /**
   * What every price carries as `maxAgeSeconds`. Default 120, the Solana program's starting value. The
   * mock's prices are never older than zero seconds, so nothing here is ever stale.
   */
  maxPriceAgeSeconds?: number;
  /**
   * Mixed into every transaction this instance builds. An app that keeps transaction ids across restarts
   * passes something new each start (a start time), so a fresh mock never repeats an id it handed out
   * before. Tests leave it out and get the same ids every run.
   */
  seed?: string;
};

/** What a test does to the mock chain from outside: the things a wallet, a faucet and time do. */
export type MockControl = {
  /** Fixed addresses: who a cash approval goes to, and who the keeper is. */
  addresses: { factory: Address; keeper: Address };
  cash: AssetId;
  /** The slippage `quote()` allows for. */
  quoteSlippageBps: number;
  /** The band a keeper leg may end inside, on either side of a target. */
  bandBps: number;
  /** Unix seconds of the mock clock. */
  now(): number;
  advance(seconds: number): void;
  fund(owner: Address, amounts: { gasRaw?: string; assets?: Record<string, string> }): void;
  setPrice(asset: AssetId, usdPerToken: string): void;
  setMultiplier(asset: AssetId, multiplier: string): void;
  /**
   * Schedules a multiplier as an issuer does: holdings of the asset carry it as `scheduled` until the
   * mock clock reaches `effectiveAt` (unix seconds), and from then on it is the multiplier in force.
   */
  scheduleMultiplier(asset: AssetId, multiplier: string, effectiveAt: number): void;
  /**
   * Stands in for sign-and-broadcast. Only a transaction this adapter built is accepted, found by its
   * `messageHash`. Sending the same one twice returns the same id and changes nothing.
   */
  send(tx: Pick<BuiltTx, 'messageHash'>): Promise<{ txId: string; validUntil?: string }>;
  /**
   * Stands in for a wallet's signature, and sends nothing. On Solana the transaction's one signature
   * slot is filled, and the message after it is untouched. An EVM payload comes back as it is: the
   * mock has no EVM signature, and its bytes say who signs them.
   */
  sign(tx: Pick<BuiltTx, 'payload' | 'signer'>): string;
  /** The next send lands and reverts with this error. */
  revertNext(error: { code: ChainErrorCode; message: string }): void;
  /** The next send never lands: it stays pending, then expires when its validity runs out. */
  dropNext(): void;
};

export type MockAdapter = ChainAdapter & { mock: MockControl };

export function createMockAdapter(options: MockOptions): MockAdapter {
  const chain = options.chain;
  const family = chainFamily(chain);
  const assets = options.assets ?? mockAssets(chain);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const cashAssets = assets.filter((a) => a.cls === 'cash');
  if (cashAssets.length !== 1 || !cashAssets[0])
    throw new Error('chain-mock needs exactly one cash asset');
  const cash = cashAssets[0].id;
  const factory = mockAddress(chain, 'factory');
  const keeper = mockAddress(chain, 'keeper');
  const publishDelay = options.publishDelaySeconds ?? 300;
  const seed = options.seed ?? '';
  /** One fee for every transaction, and the extra a new vault costs, in native units. */
  const fee = family === 'solana' ? 5_000n : 20_000_000_000_000n;
  const newVaultGas = family === 'solana' ? 6_000_000n : 0n;

  const capabilities: Capabilities =
    family === 'solana'
      ? {
          trade: 'mock',
          autoFollow: true,
          maxTradesPerTx: 1,
          tradesInCreate: false,
          needsApprove: false,
        }
      : {
          trade: 'mock',
          autoFollow: true,
          maxTradesPerTx: 8,
          tradesInCreate: true,
          needsApprove: true,
        };

  let state: State = {
    seconds: Math.floor(Date.parse(options.now ?? '2026-10-05T15:00:00.000Z') / 1000),
    wallets: new Map(),
    gas: new Map(),
    allowances: new Map(),
    vaults: new Map(),
    recipes: new Map(),
    prices: new Map(Object.entries(options.prices ?? mockPrices(chain))),
    multipliers: new Map(),
    scheduled: new Map(),
  };
  const maxPriceAge = options.maxPriceAgeSeconds ?? 120;
  const bandBps = options.bandBps ?? 50;
  if (!Number.isInteger(bandBps) || bandBps < 0 || bandBps > 10_000)
    throw new Error('chain-mock: the band is a whole number of bps, 0 to 10,000');
  const built = new Map<string, Built>();
  const sent = new Map<string, Sent>();
  let buildSeq = 0;
  let nextRevert: { code: ChainErrorCode; message: string } | null = null;
  let nextDrop = false;

  const iso = (s: State) => new Date(s.seconds * 1000).toISOString();
  const stamp = (s: State, method: string) =>
    ({ source: SOURCE, method, fetchedAt: iso(s), provenance: 'mock' }) as const;

  function asset(id: AssetId): BasketAsset {
    return byId.get(id) ?? refuse('MintNotAccepted', `${id} is not listed on ${chain}`);
  }
  function price(s: State, id: AssetId): string {
    const p = s.prices.get(asset(id).id);
    return p && toScaled(p) > 0n ? p : refuse('AssetNotPriced', `${id} has no price`);
  }
  function holding(s: State, id: AssetId, raw: bigint): Holding {
    const multiplier = s.multipliers.get(id) ?? '1';
    const scheduled = s.scheduled.get(id);
    return {
      asset: id,
      raw: raw.toString(),
      multiplier,
      display: displayAmount(raw.toString(), multiplier, asset(id).decimals),
      ...(scheduled ? { scheduled } : {}),
    };
  }
  function vaultOf(s: State, address: Address): MockVault {
    return s.vaults.get(address) ?? refuse('VaultNotFound', `no vault at ${address}`);
  }
  function recipeOf(s: State, id: string): MockRecipe {
    return s.recipes.get(id) ?? refuse('RecipeNotFound', `no shared portfolio at ${id}`);
  }
  /** A pending version becomes the active one at its time, with no transaction. So does a multiplier. */
  function settle(s: State): State {
    for (const r of s.recipes.values()) {
      if (r.pending && r.pending.effectiveAt <= s.seconds) {
        r.active = r.pending;
        r.pending = null;
      }
    }
    for (const [id, next] of s.scheduled) {
      if (next.effectiveAt > s.seconds) continue;
      s.multipliers.set(id, next.multiplier);
      s.scheduled.delete(id);
    }
    return s;
  }
  const live = () => settle(state);

  function marketOpen(s: State, session: BasketAsset['session']): Price['market'] {
    if (session === 'always') return 'open';
    const d = new Date(s.seconds * 1000);
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
    // Mon to Fri, 14:30 to 20:00 UTC (DESIGN-VAULT section 5, check 9). The mock keeps no holiday list.
    return weekday && minutes >= 870 && minutes < 1200 ? 'open' : 'closed';
  }

  /** A recipe's components as targets. Only listed assets, and never cash. */
  function targetsOf(recipe: Recipe): Target[] {
    return recipe.components.map((c) => {
      if (c.kind !== 'asset')
        throw new ChainError('BadInput', 'a vault takes assets only; flatten the recipe first');
      if (asset(c.asset).id === cash) refuse('MintNotAccepted', 'cash is not a target');
      return { asset: c.asset, weightBps: c.weightBps };
    });
  }
  function setTargets(v: MockVault, targets: Target[]) {
    for (const [id, p] of v.positions) {
      p.targetBps = 0;
      if (p.raw === 0n) v.positions.delete(id);
    }
    for (const t of targets) {
      if (asset(t.asset).id === cash) refuse('MintNotAccepted', 'cash is not a target');
      const p = v.positions.get(t.asset);
      if (p) p.targetBps = t.weightBps;
      else v.positions.set(t.asset, { raw: 0n, targetBps: t.weightBps, lastKeeperAt: null });
    }
  }
  /** An asset the owner has accepted: one of the vault's targets. Holding it is not accepting it. */
  const accepted = (v: MockVault, id: AssetId) => (v.positions.get(id)?.targetBps ?? 0) > 0;
  const balance = (v: MockVault, id: AssetId) =>
    id === cash ? v.cash : (v.positions.get(id)?.raw ?? 0n);
  function move(v: MockVault, id: AssetId, delta: bigint) {
    if (id === cash) {
      v.cash += delta;
      return;
    }
    const p = v.positions.get(id);
    if (p) p.raw += delta;
    else v.positions.set(id, { raw: delta, targetBps: 0, lastKeeperAt: null });
  }
  function quoteOut(s: State, trade: Trade): bigint {
    const sell = asset(trade.sell);
    const buy = asset(trade.buy);
    if ((sell.id === cash) === (buy.id === cash))
      refuse('BadTrade', 'one side of a trade is the cash token');
    if (BigInt(trade.amountInRaw) === 0n) refuse('BadTrade', 'a trade sells more than nothing');
    const out = swapOut(
      BigInt(trade.amountInRaw),
      { usdPerToken: price(s, sell.id), decimals: sell.decimals },
      { usdPerToken: price(s, buy.id), decimals: buy.decimals },
      TRADE_COST_BPS,
    );
    return out > 0n ? out : refuse('BadTrade', 'the trade is too small to buy anything');
  }
  /** One trade inside a vault. With `run.mins` set, it reverts when it pays out less than agreed. */
  function swap(s: State, v: MockVault, trade: Trade, run: Run) {
    const amountIn = BigInt(trade.amountInRaw);
    if (amountIn > 0n && balance(v, asset(trade.sell).id) < amountIn)
      refuse('SpentTooMuch', `the vault holds less ${trade.sell} than the trade sells`);
    const out = quoteOut(s, trade);
    const min = run.mins?.[run.outs.length];
    if (min !== undefined && out < min)
      refuse('ReceivedTooLittle', `${trade.buy}: the price moved past the slippage allowed`);
    run.outs.push(out);
    move(v, trade.sell, -amountIn);
    move(v, trade.buy, out);
  }
  function walletOf(s: State, owner: Address): Map<AssetId, bigint> {
    let w = s.wallets.get(owner);
    if (!w) {
      w = new Map();
      s.wallets.set(owner, w);
    }
    return w;
  }
  /** A deposit is always the chain's cash token, from the vault's owner. */
  function pullCash(s: State, v: MockVault, amount: bigint) {
    const w = walletOf(s, v.owner);
    if ((w.get(cash) ?? 0n) < amount) refuse('NotFunded', 'the wallet holds less cash than this');
    if (capabilities.needsApprove) {
      const key = [factory, v.address]
        .map((spender) => `${v.owner}>${spender}`)
        .find((k) => (s.allowances.get(k) ?? 0n) >= amount);
      if (!key) throw new ChainError('AllowanceTooLow', 'approve the cash first');
      s.allowances.set(key, (s.allowances.get(key) ?? 0n) - amount);
    }
    w.set(cash, (w.get(cash) ?? 0n) - amount);
    v.cash += amount;
  }
  function checkTrades(trades: Trade[] | undefined, inCreate: boolean) {
    if (!trades?.length) return;
    if (inCreate && !capabilities.tradesInCreate)
      refuse('NotSupported', `${chain} opens a vault and trades in separate transactions`);
    if (trades.length > capabilities.maxTradesPerTx)
      refuse('TooManyTrades', `${chain} takes ${capabilities.maxTradesPerTx} per transaction`);
  }
  /**
   * What an asset is worth and what the whole vault is, at the mock prices: a weight is the first over
   * the second, cash included.
   */
  function weigh(s: State, v: MockVault, id: AssetId): { value: bigint; total: bigint } {
    const value = (a: AssetId) => valueScaled(balance(v, a), price(s, a), asset(a).decimals);
    let total = value(cash);
    for (const a of v.positions.keys()) total += value(a);
    return { value: value(id), total };
  }
  const bpsOf = (w: { value: bigint; total: bigint }) =>
    w.total === 0n ? 0 : Number((w.value * 10_000n) / w.total);

  /** The one place state changes. Throws a ChainError and leaves `s` half-changed, so callers pass a copy. */
  function apply(s: State, op: Op, run: Run): void {
    switch (op.kind) {
      case 'approve':
        s.allowances.set(`${op.a.owner}>${op.a.spender}`, BigInt(op.a.amountRaw));
        return;
      case 'create_vault': {
        const a = op.a;
        const address = mockAddress(chain, `vault:${a.owner}:${a.basketId}`);
        if (s.vaults.has(address)) refuse('VaultExists', 'this wallet already used that plan id');
        const v: MockVault = {
          address,
          owner: a.owner,
          basketId: a.basketId,
          recipeOnchainId: null,
          acceptedVersion: 0,
          autoFollow: a.autoFollow,
          cash: 0n,
          positions: new Map(),
        };
        if (a.recipeOnchainId) {
          if (a.targets.length) refuse('BadInput', 'a vault that follows takes no targets');
          const { active } = recipeOf(s, a.recipeOnchainId);
          if (a.expectedVersion !== active.version)
            refuse('VersionMismatch', `the active version is ${active.version}`);
          v.recipeOnchainId = a.recipeOnchainId;
          v.acceptedVersion = active.version;
          setTargets(v, targetsOf(active));
        } else {
          setTargets(v, input(SetTargetsArgs.shape.targets, a.targets, 'targets'));
        }
        s.vaults.set(address, v);
        if (a.depositRaw) pullCash(s, v, BigInt(a.depositRaw));
        checkTrades(a.trades, true);
        for (const t of a.trades ?? []) swap(s, v, t, run);
        return;
      }
      case 'deposit': {
        const v = vaultOf(s, op.a.vault);
        pullCash(s, v, BigInt(op.a.amountRaw));
        checkTrades(op.a.trades, false);
        for (const t of op.a.trades ?? []) swap(s, v, t, run);
        return;
      }
      case 'swap': {
        const v = vaultOf(s, op.a.vault);
        checkTrades(op.a.trades, false);
        for (const t of op.a.trades) swap(s, v, t, run);
        return;
      }
      case 'set_targets': {
        // Setting targets by hand stops following: the recipe is cleared and auto-follow goes off.
        const v = vaultOf(s, op.a.vault);
        setTargets(v, op.a.targets);
        v.recipeOnchainId = null;
        v.acceptedVersion = 0;
        v.autoFollow = false;
        return;
      }
      case 'accept_version': {
        const v = vaultOf(s, op.a.vault);
        const r = recipeOf(s, op.a.recipeOnchainId);
        if (r.pending?.version === op.a.expectedVersion)
          refuse('VersionNotEffective', 'that version has not taken effect yet');
        if (r.active.version !== op.a.expectedVersion)
          refuse('VersionMismatch', `the active version is ${r.active.version}`);
        v.recipeOnchainId = op.a.recipeOnchainId;
        v.acceptedVersion = r.active.version;
        setTargets(v, targetsOf(r.active));
        return;
      }
      case 'set_auto_follow':
        vaultOf(s, op.a.vault).autoFollow = op.a.on;
        return;
      case 'withdraw': {
        // In kind, and only ever to the owner.
        const v = vaultOf(s, op.a.vault);
        const w = walletOf(s, v.owner);
        for (const id of op.a.assets) {
          const raw = balance(v, asset(id).id);
          move(v, id, -raw);
          w.set(id, (w.get(id) ?? 0n) + raw);
        }
        return;
      }
      case 'publish': {
        const { creator, recipe } = op.a;
        if (recipe.chain !== chain) refuse('BadInput', `this recipe is for ${recipe.chain}`);
        if (recipe.creator !== creator) refuse('BadInput', 'the creator signs their own recipe');
        if (recipe.kind !== 'community') refuse('BadInput', 'only a shared portfolio is published');
        const next = recipe.components.map((c) => {
          if (c.kind !== 'asset')
            throw new ChainError('BadInput', 'a vault takes assets only; flatten the recipe first');
          return { asset: c.asset, weightBps: c.weightBps };
        });
        const id = mockRecipeId(chain, creator, recipe.familyId);
        const existing = s.recipes.get(id);
        // The four author limits (DESIGN-VAULT section 6), as a real registry checks them: the same
        // function the Solana program and the EVM registry are held to by the shared vectors. The
        // cash token as a component is one of them, refused like the rest.
        const verdict = checkCreatorLimits(
          existing ? targetsOf(existing.active) : null,
          next,
          {
            assets,
            now: s.seconds,
            lastPublishAt: existing?.lastPublishAt ?? null,
            hasPending: Boolean(existing?.pending),
            publishDelay,
          },
          { flags: recipe.flags, maxFeeBps: recipe.maxFeeBps },
        );
        if (!verdict.ok) refuse(CREATOR_LIMIT_ERROR, `${verdict.code}: ${verdict.detail}`);
        if (!existing) {
          s.recipes.set(id, {
            active: { ...recipe, onchainId: id, version: 1, effectiveAt: s.seconds },
            pending: null,
            lastPublishAt: s.seconds,
          });
          return;
        }
        existing.pending = {
          ...recipe,
          onchainId: id,
          version: existing.active.version + 1,
          effectiveAt: s.seconds + publishDelay,
        };
        existing.lastPublishAt = s.seconds;
        return;
      }
      case 'adopt_version': {
        const v = vaultOf(s, op.a.vault);
        if (!v.autoFollow) refuse('AutoFollowOff', 'auto-follow is off for this vault');
        if (!v.recipeOnchainId) throw new ChainError('NotFollowing', 'this vault follows nothing');
        const { active } = recipeOf(s, v.recipeOnchainId);
        if (active.version <= v.acceptedVersion)
          refuse('VersionNotEffective', 'no newer version has taken effect');
        const targets = targetsOf(active);
        if (targets.some((t) => !accepted(v, t.asset)))
          refuse('NewAssetNeedsOwner', 'the new version adds an asset; the owner accepts it');
        v.acceptedVersion = active.version;
        setTargets(v, targets);
        return;
      }
      case 'keeper_leg': {
        const v = vaultOf(s, op.a.vault);
        if (!v.autoFollow) refuse('AutoFollowOff', 'auto-follow is off for this vault');
        const { sell, buy } = op.a.trade;
        if ((sell === cash) === (buy === cash))
          refuse('BadTrade', 'one side of a trade is the cash token');
        if (BigInt(op.a.trade.amountInRaw) === 0n)
          refuse('BadTrade', 'a trade sells more than nothing');
        const other = sell === cash ? buy : sell;
        const p = v.positions.get(other);
        if (!p)
          throw new ChainError('MintNotAccepted', `${other} is not one of this vault's assets`);
        if (marketOpen(s, asset(other).session) !== 'open')
          refuse('MarketClosed', `${other} trades in the US session only`);
        // Check 5 of DESIGN-VAULT section 5. A sale needs the asset over its target before the trade
        // and a purchase needs it under: anything else moves away. After the trade the asset may sit
        // anywhere inside the band, on either side of its target; outside the band on the far side
        // is past it. Compared without dividing, so a fraction of a basis point is not lost. The
        // cooldown, the price-age check and the weekly loss cap are the real vault's and are not
        // modelled here.
        const buying = sell === cash;
        const target = BigInt(p.targetBps);
        const before = weigh(s, v, other);
        const over = (w: typeof before, bps: bigint) => w.value * 10_000n > bps * w.total;
        const under = (w: typeof before, bps: bigint) => w.value * 10_000n < bps * w.total;
        if (buying ? !under(before, target) : !over(before, target))
          refuse(
            'NotTowardTarget',
            `${other} is at ${bpsOf(before)} bps against a target of ${p.targetBps}`,
          );
        swap(s, v, op.a.trade, run);
        const after = weigh(s, v, other);
        const band = BigInt(bandBps);
        if (buying ? over(after, target + band) : under(after, target - band))
          refuse(
            'PastTarget',
            `${other} would be at ${bpsOf(after)} bps against a target of ${p.targetBps}, outside the band of ${bandBps}`,
          );
        p.lastKeeperAt = s.seconds;
        return;
      }
    }
  }

  function vaultState(s: State, v: MockVault): VaultState {
    const recipe = v.recipeOnchainId ? s.recipes.get(v.recipeOnchainId) : undefined;
    const next =
      recipe && recipe.active.version > v.acceptedVersion
        ? recipe.active
        : (recipe?.pending ?? null);
    return {
      chain,
      address: v.address,
      owner: v.owner,
      basketId: v.basketId,
      recipeOnchainId: v.recipeOnchainId,
      acceptedVersion: v.acceptedVersion,
      autoFollow: v.autoFollow,
      keeper,
      cash: holding(s, cash, v.cash),
      positions: [...v.positions].map(([id, p]) => ({
        ...holding(s, id, p.raw),
        targetBps: p.targetBps,
        lastKeeperAt: p.lastKeeperAt,
      })),
      lossUsedBps: 0,
      observedAt: iso(s),
      pending: next
        ? {
            version: next.version,
            effectiveAt: next.effectiveAt,
            newAssets: targetsOf(next)
              .map((t) => t.asset)
              .filter((id) => !accepted(v, id)),
          }
        : null,
    };
  }

  const DESCRIPTION: Record<LegKind, string> = {
    approve: 'Allow your vault to take this cash',
    create_vault: 'Open the vault for this plan',
    deposit: 'Add cash to the vault',
    swap: 'Trade inside the vault',
    set_targets: "Set the plan's targets",
    accept_version: 'Accept the new version of the shared portfolio',
    set_auto_follow: 'Switch auto-follow',
    withdraw: 'Withdraw the tokens to your wallet',
    publish: 'Publish the shared portfolio',
    adopt_version: 'Apply the new version of the shared portfolio',
    keeper_leg: 'Rebalance toward the targets',
  };

  const evmTarget = (op: Op, vault: Address | undefined) =>
    op.kind === 'approve' ? asset(cash).address : (vault ?? factory);
  /**
   * The slippage a transaction's trades were built with. A keeper trade has none of its own: the vault
   * holds it to the reference price, which the mock always trades at.
   */
  const slippageOf = (op: Op) => ('slippageBps' in op.a ? op.a.slippageBps : 10_000);
  /** The trades a transaction makes, in the order it makes them. */
  const tradesOf = (op: Op): Trade[] =>
    op.kind === 'keeper_leg' ? [op.a.trade] : 'trades' in op.a ? (op.a.trades ?? []) : [];

  /** Runs the op on a copy, so a transaction that would fail is refused here and never built. */
  function build(op: Op, signer: Address, watch: { wallet: Address; vault?: Address }): BuiltTx {
    const before = live();
    const after = structuredClone(before);
    const run: Run = { outs: [] };
    apply(after, op, run);
    const changes: TxPreview['changes'] = [];
    const diff = (
      holder: 'wallet' | 'vault',
      read: (s: State, id: AssetId) => bigint | undefined,
    ) => {
      for (const a of assets) {
        const delta = (read(after, a.id) ?? 0n) - (read(before, a.id) ?? 0n);
        if (delta !== 0n) changes.push({ holder, asset: a.id, deltaRaw: delta.toString() });
      }
    };
    diff('wallet', (s, id) => s.wallets.get(watch.wallet)?.get(id));
    const vaultAddress =
      watch.vault ??
      (op.kind === 'create_vault'
        ? mockAddress(chain, `vault:${op.a.owner}:${op.a.basketId}`)
        : undefined);
    if (vaultAddress)
      diff('vault', (s, id) => {
        const v = s.vaults.get(vaultAddress);
        return v ? balance(v, id) : undefined;
      });

    // A counter stands in for the blockhash or nonce, so two builds of one step are two transactions.
    buildSeq += 1;
    const to = evmTarget(op, vaultAddress);
    const message = Buffer.from(
      JSON.stringify({
        mock: true,
        chain,
        seed,
        seq: buildSeq,
        signer,
        ...(family === 'evm' ? { to } : {}),
        op,
      }),
    );
    // The message hash as basket-tx.ts defines it for each family.
    // Solana: the bytes are laid out as a transaction, one empty signature slot and then the message,
    // and the hash is of the message alone. EVM: the payload is the call data, and the hash is of the
    // call: chain id, signer, target, value and data.
    const payload =
      family === 'solana'
        ? Buffer.concat([Buffer.from([1]), Buffer.alloc(SIGNATURE_BYTES), message]).toString(
            'base64',
          )
        : `0x${message.toString('hex')}`;
    const messageHash =
      family === 'solana'
        ? sha256Hex(message)
        : sha256Hex(
            evmCallPreimage({ chainId: MOCK_EVM_CHAIN_ID, signer, to, value: '0', data: payload }),
          );
    const validUntil = family === 'solana' ? before.seconds + VALID_BLOCKS : null;
    const slippage = slippageOf(op);
    const mins = run.outs.map((out) => lessBps(out, slippage));
    built.set(messageHash, { op, signer, validUntil, txId: mockTxId(chain, messageHash), mins });
    // The trades as the transaction makes them, each with the floor the send holds it to.
    const minimums = tradesOf(op).map((t, i) => ({
      sell: t.sell,
      buy: t.buy,
      inRaw: t.amountInRaw,
      minOutRaw: (mins[i] ?? 0n).toString(),
    }));
    return {
      chain: family,
      payload,
      ...(family === 'evm'
        ? { evm: { to, value: '0', chainId: MOCK_EVM_CHAIN_ID } }
        : { lastValidBlockHeight: before.seconds + VALID_BLOCKS, feePayer: signer }),
      description: DESCRIPTION[op.kind],
      provenance: 'mock',
      legKind: op.kind,
      chainId: chain,
      signer,
      messageHash,
      preview: {
        ...stamp(before, 'mock state transition'),
        summary: DESCRIPTION[op.kind],
        simulated: true,
        feeNativeRaw: (fee + (op.kind === 'create_vault' ? newVaultGas : 0n)).toString(),
        changes,
        minimums,
      },
    };
  }
  const ownerTx = (op: Op & { a: { vault: Address } }) => {
    const owner = vaultOf(live(), op.a.vault).owner;
    return build(op, owner, { wallet: owner, vault: op.a.vault });
  };

  /**
   * The message hash of signed bytes, as `build` works it out. The mock reads anything: bytes that are
   * not laid out as one of its own transactions hash to a value it never built, so they are refused
   * as `NotBuiltHere` when relayed and never taken for a transaction of this server.
   */
  function hashOfSigned(signedTx: string): string {
    if (family === 'solana') {
      const bytes = Buffer.from(signedTx, 'base64');
      const start = 1 + SIGNATURE_BYTES;
      // One signature slot, whatever is in it, then the message.
      return bytes[0] === 1 && bytes.length > start
        ? sha256Hex(bytes.subarray(start))
        : sha256Hex(bytes);
    }
    const data = signedTx.toLowerCase();
    try {
      const said = JSON.parse(Buffer.from(data.slice(2), 'hex').toString());
      return sha256Hex(
        evmCallPreimage({
          chainId: MOCK_EVM_CHAIN_ID,
          signer: said.signer,
          to: said.to,
          value: '0',
          data,
        }),
      );
    } catch {
      return sha256Hex(data);
    }
  }

  /** Nothing but a ChainError leaves the adapter: an error of any other kind is a bug, reported as Unknown. */
  async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ChainError) throw e;
      throw new ChainError('Unknown', e instanceof Error ? e.message : 'the mock failed');
    }
  }

  const adapter: MockAdapter = {
    chain,
    capabilities,
    provenance: 'mock',

    listAssets: () => guarded(() => structuredClone(assets)),
    getPrices: (ids) =>
      guarded(() => {
        const s = live();
        return [...new Set(input(z.array(AssetId), ids, 'assets'))].map((id) => ({
          ...stamp(s, id === cash ? 'cash counted as one dollar' : 'fixed mock price'),
          asset: id,
          usdPerToken: price(s, id),
          ageSeconds: 0,
          maxAgeSeconds: maxPriceAge,
          market: marketOpen(s, asset(id).session),
        }));
      }),
    getVaults: (owner) =>
      guarded(() => {
        const s = live();
        const who = input(Address, owner, 'owner');
        return [...s.vaults.values()].filter((v) => v.owner === who).map((v) => vaultState(s, v));
      }),
    getVault: (vault) =>
      guarded(() => {
        const s = live();
        const v = s.vaults.get(input(Address, vault, 'vault'));
        return v ? vaultState(s, v) : null;
      }),
    listAutoFollowVaults: (recipeOnchainId) =>
      guarded(() =>
        [...live().vaults.values()]
          .filter(
            (v) => v.autoFollow && (!recipeOnchainId || v.recipeOnchainId === recipeOnchainId),
          )
          .map((v) => v.address),
      ),
    getRecipe: (recipeOnchainId) =>
      guarded(() => {
        const { active, pending } = recipeOf(live(), recipeOnchainId);
        return structuredClone({ active, pending });
      }),
    getWalletHoldings: (owner) =>
      guarded(() => {
        const s = live();
        return [...(s.wallets.get(input(Address, owner, 'owner')) ?? [])]
          .filter(([, raw]) => raw > 0n)
          .map(([id, raw]) => holding(s, id, raw));
      }),
    funding: (owner, need) =>
      guarded((): Funding => {
        const s = live();
        const who = input(Address, owner, 'owner');
        const wanted = input(FundingNeed, need, 'need');
        const cashHave = s.wallets.get(who)?.get(cash) ?? 0n;
        const gasHave = s.gas.get(who) ?? 0n;
        const gasNeed = fee * BigInt(wanted.legs) + (wanted.newVault ? newVaultGas : 0n);
        return {
          chain,
          cashHaveRaw: cashHave.toString(),
          cashNeedRaw: wanted.cashRaw,
          gasHaveRaw: gasHave.toString(),
          gasNeedRaw: gasNeed.toString(),
          ok: cashHave >= BigInt(wanted.cashRaw) && gasHave >= gasNeed,
        };
      }),
    quote: (trade, taker) =>
      guarded((): Quote => {
        const s = live();
        input(Address, taker, 'taker');
        const wanted = input(Trade, trade, 'trade');
        const out = quoteOut(s, wanted);
        return {
          ...stamp(s, 'mock price less a fixed cost'),
          trade: wanted,
          outRaw: out.toString(),
          minOutRaw: lessBps(out, QUOTE_SLIPPAGE_BPS).toString(),
          costBps: TRADE_COST_BPS,
          against: 'reference',
          venue: 'mock-router',
        };
      }),
    track: (txId, validUntil) =>
      guarded((): TxStatus => {
        const s = live();
        const tx = sent.get(txId);
        const until = tx?.validUntil ?? (validUntil ? Number(validUntil) : null);
        const pending = !tx || tx.status === 'pending';
        const status =
          pending && until !== null && s.seconds > until ? 'expired' : (tx?.status ?? 'pending');
        return {
          status,
          explorerUrl: `mock://${chain}/tx/${txId}`,
          ...(tx?.error ? { error: tx.error } : {}),
        };
      }),

    buildApprove: (a) =>
      guarded(() => {
        if (!capabilities.needsApprove) refuse('NotSupported', `${chain} needs no approval`);
        const args = input(ApproveArgs, a, 'approve');
        // The factory takes the cash that opens a vault; once the plan's vault exists, it takes its own.
        const vault = mockAddress(chain, `vault:${args.owner}:${args.basketId}`);
        const spender = live().vaults.has(vault) ? vault : factory;
        return build({ kind: 'approve', a: { ...args, spender } }, args.owner, {
          wallet: args.owner,
        });
      }),
    buildCreateVault: (a) =>
      guarded(() => {
        const args = input(CreateVaultArgs, a, 'create');
        return build({ kind: 'create_vault', a: args }, args.owner, { wallet: args.owner });
      }),
    buildDeposit: (a) =>
      guarded(() => ownerTx({ kind: 'deposit', a: input(DepositArgs, a, 'deposit') })),
    buildOwnerSwap: (a) =>
      guarded(() => ownerTx({ kind: 'swap', a: input(OwnerSwapArgs, a, 'swap') })),
    buildSetTargets: (a) =>
      guarded(() => ownerTx({ kind: 'set_targets', a: input(SetTargetsArgs, a, 'targets') })),
    buildAcceptVersion: (a) =>
      guarded(() => ownerTx({ kind: 'accept_version', a: input(AcceptVersionArgs, a, 'accept') })),
    buildSetAutoFollow: (a) =>
      guarded(() =>
        ownerTx({ kind: 'set_auto_follow', a: input(SetAutoFollowArgs, a, 'auto-follow') }),
      ),
    buildWithdrawInKind: (a) =>
      guarded(() => {
        const args = input(WithdrawInKindArgs, a, 'withdraw');
        const v = vaultOf(live(), args.vault);
        for (const id of args.assets ?? []) asset(id);
        const held = [cash, ...v.positions.keys()].filter((id) => balance(v, id) > 0n);
        const wanted = args.assets ? held.filter((id) => args.assets?.includes(id)) : held;
        // Solana withdraws one mint per call; EVM takes everything in one.
        const groups =
          family === 'solana' ? wanted.map((id) => [id]) : wanted.length ? [wanted] : [];
        return groups.map((ids) =>
          ownerTx({ kind: 'withdraw', a: { vault: args.vault, assets: ids } }),
        );
      }),
    buildPublishRecipe: (a) =>
      guarded(() => {
        const args = input(PublishRecipeArgs, a, 'publish');
        return build({ kind: 'publish', a: args }, args.creator, { wallet: args.creator });
      }),
    buildAdoptVersion: (vault) =>
      guarded(() => {
        const address = input(Address, vault, 'vault');
        return build({ kind: 'adopt_version', a: { vault: address } }, keeper, {
          wallet: keeper,
          vault: address,
        });
      }),
    buildKeeperLeg: (vault, trade) =>
      guarded(() => {
        const address = input(Address, vault, 'vault');
        const op: Op = {
          kind: 'keeper_leg',
          a: { vault: address, trade: input(Trade, trade, 'trade') },
        };
        return build(op, keeper, { wallet: keeper, vault: address });
      }),

    messageHashOf: (signedTx) =>
      guarded(() => hashOfSigned(input(z.string(), signedTx, 'signedTx'))),
    relay: (signedTx) =>
      guarded(() =>
        adapter.mock.send({ messageHash: hashOfSigned(input(z.string(), signedTx, 'signedTx')) }),
      ),
    // The mock derives a transaction's id from its message, so it can say this of a transaction that
    // was never sent. A real adapter fetches the transaction, and answers false for one it cannot find.
    carries: (txId, messageHash) => guarded(() => txId === mockTxId(chain, messageHash)),
    fate: (attempt) =>
      guarded(async (): Promise<AttemptFate> => {
        const { messageHash, validUntil } = input(AttemptRef, attempt, 'attempt');
        // For the same reason it can be asked about an attempt nobody reported, by its message alone.
        const txId = mockTxId(chain, messageHash);
        const { status } = await adapter.track(txId, validUntil ?? undefined);
        if (status === 'confirmed' || status === 'reverted') return { state: 'landed', txId };
        return { state: status === 'expired' ? 'gone' : 'open' };
      }),

    mock: {
      addresses: { factory, keeper },
      cash,
      quoteSlippageBps: QUOTE_SLIPPAGE_BPS,
      bandBps,
      now: () => state.seconds,
      advance(seconds) {
        state.seconds += seconds;
      },
      fund(owner, amounts) {
        const who = input(Address, owner, 'owner');
        const gas = BigInt(input(RawAmount, amounts.gasRaw ?? '0', 'gasRaw'));
        state.gas.set(who, (state.gas.get(who) ?? 0n) + gas);
        const w = walletOf(state, who);
        for (const [id, raw] of Object.entries(amounts.assets ?? {}))
          w.set(asset(id).id, (w.get(id) ?? 0n) + BigInt(input(RawAmount, raw, id)));
      },
      setPrice(id, usdPerToken) {
        const value = input(DecimalString, usdPerToken, 'price');
        if (toScaled(value) === 0n) refuse('BadInput', 'a price is more than zero');
        state.prices.set(asset(id).id, value);
      },
      setMultiplier(id, multiplier) {
        state.multipliers.set(asset(id).id, input(DecimalString, multiplier, 'multiplier'));
      },
      scheduleMultiplier(id, multiplier, effectiveAt) {
        const value = input(DecimalString, multiplier, 'multiplier');
        if (toScaled(value) === 0n) refuse('BadInput', 'a multiplier is more than zero');
        const at = input(z.number().int().nonnegative(), effectiveAt, 'effectiveAt');
        state.scheduled.set(asset(id).id, { multiplier: value, effectiveAt: at });
      },
      send: (tx) =>
        guarded(() => {
          const b = built.get(tx.messageHash);
          if (!b) throw new ChainError('NotBuiltHere', 'the mock only sends what it built');
          const validUntil = b.validUntil === null ? undefined : String(b.validUntil);
          if (sent.has(b.txId)) return { txId: b.txId, validUntil };
          const s = live();
          if (nextDrop) {
            nextDrop = false;
            sent.set(b.txId, { status: 'pending', validUntil: b.validUntil });
            return { txId: b.txId, validUntil };
          }
          if (b.validUntil !== null && s.seconds > b.validUntil)
            throw new ChainError('Expired', 'built too long ago; build it again');
          const cost = fee + (b.op.kind === 'create_vault' ? newVaultGas : 0n);
          if (b.signer !== keeper) {
            const have = s.gas.get(b.signer) ?? 0n;
            if (have < cost) throw new ChainError('NoGas', 'the wallet cannot pay the network fee');
            s.gas.set(b.signer, have - cost);
          }
          let error = nextRevert;
          nextRevert = null;
          if (!error) {
            const next = structuredClone(s);
            try {
              apply(next, b.op, { outs: [], mins: b.mins });
              state = next;
            } catch (e) {
              if (!(e instanceof ChainError)) throw e;
              error = { code: e.code, message: e.message };
            }
          }
          sent.set(
            b.txId,
            error
              ? { status: 'reverted', validUntil: b.validUntil, error }
              : { status: 'confirmed', validUntil: b.validUntil },
          );
          return { txId: b.txId, validUntil };
        }),
      sign(tx) {
        if (family !== 'solana') return tx.payload;
        const bytes = Buffer.from(tx.payload, 'base64');
        // 64 bytes that depend on the signer and the message, as a signature does.
        const message = bytes.subarray(1 + SIGNATURE_BYTES);
        const half = (salt: string) =>
          Buffer.from(
            sha256Hex(Buffer.concat([Buffer.from(`${salt}:${tx.signer}:`), message])),
            'hex',
          );
        Buffer.concat([half('r'), half('s')]).copy(bytes, 1);
        return bytes.toString('base64');
      },
      revertNext(error) {
        nextRevert = error;
      },
      dropNext() {
        nextDrop = true;
      },
    },
  };
  return adapter;
}
