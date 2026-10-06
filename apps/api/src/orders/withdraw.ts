import {
  type Address,
  type AssetId,
  type BuiltTx,
  type Chain,
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

type Context = { principal: Principal; chains: ChainRegistry };

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
  kind: 'withdraw';
  description: string;
  withdrawals: LegWithdrawal[];
};

/**
 * The steps of a withdrawal, planned and not built. Solana's program takes one token per call, so a
 * step per token; an EVM vault takes them all in one transaction.
 */
export async function planWithdraw(
  req: WithdrawRequest,
  ctx: Context,
): Promise<{ entry: ChainEntry; owner: Address; vault: Address; steps: WithdrawStep[] }> {
  const { entry, family, vault } = await ownVault(req, ctx);
  const name = namer(await entry.adapter.listAssets());
  const all = held(req, holdingsOf(vault), name);
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
  return {
    entry,
    owner: vault.owner,
    vault: vault.address,
    steps: family === 'solana' ? all.map((w) => [w]).map(step) : [step(all)],
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
  if (leg.kind !== 'withdraw' || !leg.withdrawals || !address)
    throw new Refusal(501, `a ${leg.kind} step of a withdrawal cannot be built`);
  const vault = await entry.adapter.getVault(address);
  if (!vault || vault.owner !== owner) throw new Refusal(404, 'no vault of yours at that address');
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
  const txs = await entry.adapter.buildWithdrawInKind({
    vault: vault.address,
    ...(everything ? {} : { assets: leg.withdrawals.map((w) => w.asset) }),
    ...(nonce === undefined ? {} : { nonce }),
  });
  const [tx, ...rest] = txs;
  if (!tx || rest.length)
    throw new Refusal(409, 'this step cannot be built as one transaction now', again);
  return tx;
}
