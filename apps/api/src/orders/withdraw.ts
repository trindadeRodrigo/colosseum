import {
  type Address,
  type AssetId,
  type BuiltTx,
  type Chain,
  ChainError,
  type ChainErrorCode,
  type ChainId,
  type IntentRequest,
  isAddressOf,
  type Leg,
  type LegWithdrawal,
  type Principal,
  type VaultState,
} from '@colosseum/schemas';
import { assertBuilds, type ChainEntry, type ChainRegistry } from './chains';
import { Refusal } from './errors';
import { HOME_CHAIN } from './person';

// A withdrawal: tokens leave a vault as they are, for the wallet of the vault's owner and nobody
// else (DESIGN-VAULT section 5: the owner can always withdraw every token in kind). The program and
// the contract pay only the owner; here the order is refused before anything is built unless the
// vault is the signed-in person's, and no step is built for more of a token than the vault holds at
// that moment. Selling to cash first is not offered: no builder chains the sales to the withdrawal.

export type WithdrawRequest = Extract<IntentRequest, { type: 'withdraw' }>;

/** Said to a person, as it is: the screen shows this sentence. */
export const SELL_TO_CASH_NOT_OFFERED =
  'Selling to cash before withdrawing isn’t offered yet; you can withdraw the tokens themselves';

/** Said to a person, as it is, for an amount of a token whose units the app does not list. */
export const WHOLE_TOKEN_ONLY = 'All of it or none: this app doesn’t know this token’s units';

/**
 * A step that cannot be built because its one token cannot move now: its account is frozen by its
 * issuer, it carries a transfer hook this builder does not resolve, or the chain refuses it for that
 * token alone. The step is marked skipped with this reason, and the order's other steps go on
 * (DESIGN-VAULT section 5: one token that cannot move does not stop the others).
 */
export class SkippedStep extends Refusal {
  constructor(
    readonly code: ChainErrorCode,
    readonly reason: string,
  ) {
    super(409, `this step is skipped: ${reason}`, {
      fix: 'The rest of the withdrawal goes on. This token stays in the vault.',
      details: { chainCode: code, retryable: false },
    });
  }
}

/** What a builder says when the request itself is wrong, or the chain cannot be asked: never a skip. */
const NOT_A_SKIP: ReadonlySet<string> = new Set([
  'BadInput',
  'Unavailable',
  'VaultNotFound',
  'NotOwner',
]);

type Context = {
  principal: Principal;
  chains: ChainRegistry;
  /** When the order is made, as an ISO instant: the time on the value of what is cash. */
  now?: string;
};

/** A decimal string as a fraction of whole numbers. */
function fraction(decimal: string): { num: bigint; den: bigint } {
  const [whole = '0', places = ''] = decimal.split('.');
  return { num: BigInt(`${whole}${places}`), den: 10n ** BigInt(places.length) };
}

/**
 * What each withdrawal is worth in dollars as the order is made, to the cent, rounded down, with where
 * the price came from: the amount it names, or all that is held, at the chain's reference price now
 * (which already carries a stock token's multiplier); cash at one dollar, as the vault counts it. A
 * token with no price is given no value, and a chain that cannot be asked gives none to any: a figure
 * is never made up. The portfolio counts what was taken out from these.
 */
async function valuer(
  entry: ChainEntry,
  assets: Awaited<ReturnType<ChainEntry['adapter']['listAssets']>>,
  taken: LegWithdrawal[],
  now: string,
): Promise<(w: LegWithdrawal) => LegWithdrawal['valued']> {
  const listed = new Map(assets.map((a) => [a.id, a]));
  const priced = taken
    .map((w) => listed.get(w.asset))
    .filter((a) => a !== undefined && a.cls !== 'cash' && a.priceKind !== 'none')
    .map((a) => (a as (typeof assets)[number]).id);
  const prices = priced.length
    ? await entry.adapter.getPrices(priced).catch((e: unknown) => {
        if (e instanceof ChainError) return [];
        throw e;
      })
    : [];
  const cents = (raw: bigint, decimals: number, usd: string) => {
    const { num, den } = fraction(usd);
    const c = (raw * num * 100n) / (den * 10n ** BigInt(decimals));
    return `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
  };
  return (w) => {
    const asset = listed.get(w.asset);
    if (!asset) return undefined;
    const raw = BigInt(w.amountRaw ?? w.heldRaw);
    if (asset.cls === 'cash')
      return {
        usd: cents(raw, asset.decimals, '1'),
        source: entry.source,
        method: 'the amount of the dollar token, counted at one dollar as the vault counts it',
        fetchedAt: now,
        provenance: entry.provenance,
      };
    const price = prices.find((p) => p.asset === w.asset);
    if (!price) return undefined;
    return {
      usd: cents(raw, asset.decimals, price.usdPerToken),
      source: price.source,
      method: `the amount at the reference price when the withdrawal was ordered (${price.method})`,
      fetchedAt: price.fetchedAt,
      provenance: price.provenance,
    };
  };
}

/** The one vault of the order, on its own chain, held to being the signed-in person's. */
async function ownVault(
  req: WithdrawRequest,
  ctx: Context,
): Promise<{ entry: ChainEntry; family: Chain; vault: VaultState }> {
  if (req.sellToCash) throw new Refusal(422, SELL_TO_CASH_NOT_OFFERED);
  const [address, ...more] = req.vaults;
  if (!address || more.length)
    throw new Refusal(422, 'one vault per withdrawal: make an order for each');
  // The vault's own chain, named by its address, whatever the person's current chain is.
  const family = (['solana', 'evm'] as const).find((f) => isAddressOf(f, address));
  if (!family) throw new Refusal(422, 'that is not a vault address');
  const entry = ctx.chains.get(HOME_CHAIN[family]);
  assertBuilds(entry);
  const vault = await entry.adapter.getVault(address);
  // A stranger's vault answers as one that is not there: its address says nothing to anybody else.
  const mine = ctx.principal.wallets.some((w) => w.family === family && w.address === vault?.owner);
  if (!vault || !mine) throw new Refusal(404, 'no vault of yours at that address');
  return { entry, family, vault };
}

/** What the vault holds of each token, cash first, as the chain says now. Nothing held is left out. */
const holdingsOf = (vault: VaultState): Map<AssetId, bigint> =>
  new Map(
    [vault.cash, ...vault.positions]
      .map((h) => [h.asset, BigInt(h.raw)] as const)
      .filter(([, raw]) => raw > 0n),
  );

/** The withdrawals asked for against what the vault holds: each token once, held, and no more than held. */
function held(
  req: WithdrawRequest,
  holdings: Map<AssetId, bigint>,
  name: (asset: AssetId, raw: bigint) => string,
  listed: ReadonlySet<AssetId>,
): LegWithdrawal[] {
  if (!req.withdrawals) {
    if (!holdings.size)
      throw new Refusal(409, 'the vault holds nothing to withdraw', {
        details: { retryable: false },
      });
    return [...holdings].map(([asset, raw]) => ({
      asset,
      amountRaw: null,
      heldRaw: raw.toString(),
    }));
  }
  const seen = new Set<AssetId>();
  return req.withdrawals.map((w) => {
    if (seen.has(w.asset)) throw new Refusal(422, `${w.asset} is named twice`);
    seen.add(w.asset);
    const has = holdings.get(w.asset) ?? 0n;
    if (has === 0n)
      throw new Refusal(409, `the vault holds no ${w.asset} to withdraw`, {
        fix: 'Read the vault again, then make the withdrawal again.',
        details: { retryable: false },
      });
    const amount = w.amountRaw == null ? null : BigInt(w.amountRaw);
    // Part of a token is counted in its units, and the app knows the units of the tokens it lists.
    if (amount !== null && !listed.has(w.asset)) throw new Refusal(422, WHOLE_TOKEN_ONLY);
    if (amount === 0n) throw new Refusal(422, `a withdrawal of no ${w.asset} is nothing to sign`);
    if (amount !== null && amount > has)
      throw new Refusal(
        409,
        `the vault holds ${name(w.asset, has)}, less than the ${name(w.asset, amount)} asked for`,
        {
          fix: 'Read the vault again, then withdraw no more than it holds.',
          details: { retryable: false },
        },
      );
    return {
      asset: w.asset,
      amountRaw: amount === null ? null : amount.toString(),
      heldRaw: has.toString(),
    };
  });
}

/** A raw amount in whole units with its symbol: `12.5 tUSDC`. Never through a float. */
function namer(assets: { id: AssetId; symbol: string; decimals: number }[]) {
  const by = new Map(assets.map((a) => [a.id, a]));
  return (asset: AssetId, raw: bigint): string => {
    const a = by.get(asset);
    if (!a) return `${raw} raw ${asset}`;
    const digits = raw.toString().padStart(a.decimals + 1, '0');
    const whole = digits.slice(0, digits.length - a.decimals);
    const fraction = digits.slice(digits.length - a.decimals).replace(/0+$/, '');
    return `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''} ${a.symbol}`;
  };
}

export type WithdrawStep = {
  chain: ChainId;
  kind: 'withdraw' | 'set_auto_follow';
  description: string;
  /** What a `withdraw` step takes out. Absent on the step that switches auto-follow off. */
  withdrawals?: LegWithdrawal[];
};

/**
 * The steps of a withdrawal, planned and not built. Solana's program takes one token per call, so a
 * step per token; an EVM vault takes them all in one transaction.
 *
 * A vault with auto-follow on has it switched off first, whatever is withdrawn: the keeper trades a
 * vault toward its weights, so between the steps of a withdrawal, or after one that leaves something,
 * it would sell what stayed to buy again what had just gone out (tests/keeper/withdrawal.test.ts). The
 * owner switches it on again when they want it.
 */
export async function planWithdraw(
  req: WithdrawRequest,
  ctx: Context,
): Promise<{ entry: ChainEntry; owner: Address; vault: Address; steps: WithdrawStep[] }> {
  const { entry, family, vault } = await ownVault(req, ctx);
  const assets = await entry.adapter.listAssets();
  const name = namer(assets);
  const taken = held(req, holdingsOf(vault), name, new Set(assets.map((a) => a.id)));
  const value = await valuer(entry, assets, taken, ctx.now ?? new Date().toISOString());
  const all = taken.map((w) => {
    const valued = value(w);
    return valued ? { ...w, valued } : w;
  });
  const what = (w: LegWithdrawal) =>
    w.amountRaw === null
      ? `all the ${name(w.asset, BigInt(w.heldRaw))} it holds`
      : name(w.asset, BigInt(w.amountRaw));
  const step = (withdrawals: LegWithdrawal[]): WithdrawStep => ({
    chain: entry.chain,
    kind: 'withdraw',
    description: `Withdraw ${withdrawals.map(what).join(', ')} from your vault to your own wallet, ${vault.owner}`,
    withdrawals,
  });
  const off: WithdrawStep[] = vault.autoFollow
    ? [
        {
          chain: entry.chain,
          kind: 'set_auto_follow',
          description:
            'Switch auto-follow off: automatic following stops for this vault, so the keeper does not trade it while you withdraw or afterwards',
        },
      ]
    : [];
  return {
    entry,
    owner: vault.owner,
    vault: vault.address,
    steps: [...off, ...(family === 'solana' ? all.map((w) => [w]).map(step) : [step(all)])],
  };
}

/**
 * One step of a withdrawal, built from the vault as it is now. The vault is held to the order's owner
 * again, and every amount to what the vault holds at this moment: a step that would take more, or a
 * token another withdrawal has already emptied, is refused and nothing is built.
 */
export async function buildWithdraw(
  request: WithdrawRequest,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
  nonce: number | undefined,
): Promise<BuiltTx> {
  const [address] = request.vaults;
  if (!address) throw new Refusal(501, 'a withdrawal names its vault');
  const vault = await entry.adapter.getVault(address);
  if (!vault || vault.owner !== owner) throw new Refusal(404, 'no vault of yours at that address');
  // The first step of a withdrawal from a vault the keeper trades: auto-follow off, and never on.
  if (leg.kind === 'set_auto_follow')
    return entry.adapter.buildSetAutoFollow({
      vault: vault.address,
      on: false,
      ...(nonce === undefined ? {} : { nonce }),
    });
  if (leg.kind !== 'withdraw' || !leg.withdrawals)
    throw new Refusal(501, `a ${leg.kind} step of a withdrawal cannot be built`);
  const holdings = holdingsOf(vault);
  const name = namer(await entry.adapter.listAssets());
  const again = { fix: 'Make the withdrawal again.', details: { retryable: false } };
  for (const w of leg.withdrawals) {
    const has = holdings.get(w.asset) ?? 0n;
    if (has === 0n)
      throw new Refusal(409, `the vault holds no ${w.asset} any more: nothing was built`, again);
    if (w.amountRaw !== null && BigInt(w.amountRaw) > has)
      throw new Refusal(
        409,
        `the vault now holds ${name(w.asset, has)}, less than the ${name(w.asset, BigInt(w.amountRaw))} this step takes: nothing was built`,
        again,
      );
  }
  // Everything, on a chain that takes it in one call: the vault's own sweep, which one frozen token
  // cannot hold up. Otherwise the tokens the step names.
  const everything = !request.withdrawals && entry.config.family === 'evm';
  const amounts = leg.withdrawals.flatMap((w) =>
    w.amountRaw === null ? [] : [[w.asset, w.amountRaw] as const],
  );
  let txs: BuiltTx[];
  try {
    txs = await entry.adapter.buildWithdrawInKind({
      vault: vault.address,
      ...(everything ? {} : { assets: leg.withdrawals.map((w) => w.asset) }),
      // Some of a token where the step names an amount; the adapter refuses more than is there.
      ...(amounts.length ? { amounts: Object.fromEntries(amounts) } : {}),
      ...(nonce === undefined ? {} : { nonce }),
    });
  } catch (e) {
    // A step of one token that the chain will not move now is skipped, and says why: the vault holds
    // it (checked above), so the refusal is the token's own. A step of several is refused as a whole.
    if (e instanceof ChainError && leg.withdrawals.length === 1 && !NOT_A_SKIP.has(e.code))
      throw new SkippedStep(e.code, e.message);
    throw e;
  }
  const [tx, ...rest] = txs;
  if (!tx || rest.length)
    throw new Refusal(409, 'this step cannot be built as one transaction now', again);
  return tx;
}
