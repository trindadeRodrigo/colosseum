import { createHash } from 'node:crypto';
import { discOf } from '../events/logs';
import type { RpcTx } from '../events/tx';
import { JL_VAULTS_IX } from '../lending/ix-names';
import { JL_ORACLE_PROGRAM, JL_VAULTS_PROGRAM } from '../lending/jupiter-lend';
import { KLEND_PROGRAM } from '../lending/kamino';
import { flattenIxs } from '../lending/tx';

/**
 * Step 11 item 1 — oracle prices the lending programs used, read from transactions already fetched.
 *
 *  - Kamino: klend logs `Token: <name> Price: <usd>` whenever it refreshes a reserve (the Scope price it then acts
 *    on, four decimals). The line is attributed to a reserve through the accounts of the instruction that logged
 *    it: the one registered reserve among them whose token name equals the logged name. A refresh of a reserve
 *    outside the registry is counted, not returned.
 *  - Jupiter Lend: a vault instruction calls the oracle program, whose return value is the exchange rate it used:
 *    collateral in debt tokens × 1e15 (one u128, or two for `get_both_exchange_rate`: both are kept). The vault,
 *    the collateral mint and the debt mint come from the calling instruction's accounts.
 *
 * A transaction whose log is cut or does not line up with its instructions gives no price (`aligned: false`): a
 * line could then be attributed to the wrong instruction. Failed transactions give none either.
 */
export type LoggedOraclePrice = {
  priceSource: 'kamino_scope' | 'jupiter_lend_oracle';
  mint: string;
  price: number;
  /** `'usd'` for Kamino; the debt token's mint for Jupiter Lend. */
  quote: string;
  /** Kamino reserve, or Jupiter Lend vault config. */
  ref: string;
  /** Kamino lending market, or the Jupiter Lend vault config again. */
  market: string;
  /** Instruction path of the invocation that logged or returned the price. */
  path: string;
  /** Jupiter Lend `get_both_exchange_rate`: the second rate, when it differs from the first. */
  secondPrice?: number;
};

export type LoggedPriceContext = {
  /** Registered Kamino reserves: token name as klend logs it, liquidity mint, lending market. */
  kaminoReserves: ReadonlyMap<string, { symbol: string; mint: string; market: string }>;
};

export type LoggedPrices = {
  prices: LoggedOraclePrice[];
  /** Log and instruction list line up (same programs in the same order, log not cut). */
  aligned: boolean;
  /** klend price lines for reserves outside the registry. */
  outside: number;
  /** klend price lines that fit more than one registered reserve of the instruction (none expected). */
  ambiguous: number;
};

const ixDisc = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest('hex').slice(0, 16);
const JL_ORACLE_RATE_IX = new Map(
  [
    'get_both_exchange_rate',
    'get_exchange_rate_operate',
    'get_exchange_rate_liquidate',
    'get_exchange_rate',
  ].map((n) => [ixDisc(n), n]),
);
/** Jupiter Lend oracle rate → collateral price in debt tokens per whole token (both sides in 9-decimal units). */
export const JL_ORACLE_RATE_SCALE = 1e15;

type Frame = { program: string; lines: string[] };

/** Invocation frames in invoke order, each with its own log lines (not those of programs it calls). */
function frameLines(logs: readonly string[]): { frames: Frame[]; truncated: boolean } {
  const frames: Frame[] = [];
  const stack: Frame[] = [];
  let truncated = false;
  for (const l of logs) {
    const inv = /^Program (\w+) invoke \[\d+\]/.exec(l);
    if (inv) {
      const f = { program: inv[1] as string, lines: [] };
      frames.push(f);
      stack.push(f);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(l)) {
      stack.pop();
      continue;
    }
    if (l === 'Log truncated') {
      truncated = true;
      continue;
    }
    stack.at(-1)?.lines.push(l);
  }
  return { frames, truncated };
}

const u128le = (b: Uint8Array, o: number) => {
  let v = 0n;
  for (let k = 15; k >= 0; k--) v = (v << 8n) + BigInt(b[o + k] as number);
  return v;
};

export function loggedOraclePrices(tx: RpcTx, ctx: LoggedPriceContext): LoggedPrices {
  const out: LoggedPrices = { prices: [], aligned: false, outside: 0, ambiguous: 0 };
  if (!tx.meta || tx.meta.err) return out;
  const flat = flattenIxs(tx);
  const { frames, truncated } = frameLines(tx.meta.logMessages ?? []);
  out.aligned =
    !truncated &&
    frames.length === flat.length &&
    frames.every((f, i) => f.program === flat[i]?.program);
  if (!out.aligned) return out;

  const seen = new Set<string>();
  flat.forEach((ix, i) => {
    const lines = (frames[i] as Frame).lines;
    if (ix.program === KLEND_PROGRAM) {
      for (const l of lines) {
        const m = /^Program log: Token: (.+) Price: ([\d.]+)$/.exec(l);
        if (!m) continue;
        const reserves = [
          ...new Set(ix.accounts.filter((a) => ctx.kaminoReserves.get(a)?.symbol === m[1])),
        ];
        if (reserves.length === 0) {
          out.outside++;
          continue;
        }
        if (reserves.length > 1) {
          out.ambiguous++;
          continue;
        }
        const ref = reserves[0] as string;
        const r = ctx.kaminoReserves.get(ref) as { mint: string; market: string };
        const price = Number(m[2]);
        // one row per reserve and price in a transaction: a reserve is often refreshed several times
        const k = `${ref}|${price}`;
        if (seen.has(k) || !(price > 0)) continue;
        seen.add(k);
        out.prices.push({
          priceSource: 'kamino_scope',
          mint: r.mint,
          price,
          quote: 'usd',
          ref,
          market: r.market,
          path: ix.path,
        });
      }
      return;
    }
    if (ix.program !== JL_ORACLE_PROGRAM || !JL_ORACLE_RATE_IX.has(discOf(ix.data))) return;
    const caller = flat[ix.parent];
    if (!caller || caller.program !== JL_VAULTS_PROGRAM) return;
    const entry = JL_VAULTS_IX[discOf(caller.data)];
    if (!entry) return;
    const acc = Object.fromEntries(entry[1].map((n, k) => [n, caller.accounts[k]]));
    const vault = acc.vault_config;
    const mint = acc.supply_token;
    const quote = acc.borrow_token;
    const ret = lines.find((l) => l.startsWith(`Program return: ${JL_ORACLE_PROGRAM} `));
    if (!vault || !mint || !quote || !ret) return;
    const bytes = new Uint8Array(Buffer.from(ret.slice(ret.lastIndexOf(' ') + 1), 'base64'));
    if (bytes.length < 16) return;
    const price = Number(u128le(bytes, 0)) / JL_ORACLE_RATE_SCALE;
    const second = bytes.length >= 32 ? Number(u128le(bytes, 16)) / JL_ORACLE_RATE_SCALE : price;
    const k = `${vault}|${price}|${second}`;
    if (seen.has(k) || !(price > 0)) return;
    seen.add(k);
    out.prices.push({
      priceSource: 'jupiter_lend_oracle',
      mint,
      price,
      quote,
      ref: vault,
      market: vault,
      path: ix.path,
      ...(second !== price ? { secondPrice: second } : {}),
    });
  });
  return out;
}
