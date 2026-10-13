import { readFileSync } from 'node:fs';
import { byrealClState, swapExactIn } from '@colosseum/risk';
import {
  type ByrealQuoteRow,
  type ByrealValidatedPool,
  type ByrealValidationFile,
  byrealVerdict,
} from './lib';

// PLAN-UNIVERSE RU.15 — `pnpm risk:byreal-report <validation.json> [more …]`: the tables of the validation, from the
// files `pnpm risk:byreal-validate` wrote. No network: every simulated amount is computed again here from the bytes
// the file holds (the pool account each quote was set against, the fee config, every account the pool owns), so the
// table is a recomputation and not a copy of what the run printed. The liquidity check shown is the last file's; the
// quotes are those of every file named, each run of a pool on its own rows.
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) throw new Error('usage: report.ts <validation.json> [more …]');
const runs = files.map((f) => ({
  file: f,
  v: JSON.parse(readFileSync(f, 'utf8')) as ByrealValidationFile,
}));
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const short = (a: string) => `\`${a.slice(0, 6)}…\``;
const sci = (x: number) => x.toExponential(2);

type Recomputed = {
  out: number;
  unfilledShare: number;
  ticksCrossed: number;
  /** Tick arrays between the tick before the trade and the tick after it, both included. */
  arraysSpanned: number;
  relDiff: number | null;
};
const recompute = (p: ByrealValidatedPool, q: ByrealQuoteRow): Recomputed => {
  const kids = Object.values(p.children).map(b);
  const { state, pool } = byrealClState(p.pool, b(q.head), b(p.config.data), kids);
  const zeroForOne = q.side === 'sell' ? p.stockIsToken0 : !p.stockIsToken0;
  const r = swapExactIn(state, Number(q.amountIn), zeroForOne);
  const width = 60 * pool.tickSpacing;
  const startOf = (t: number) => Math.floor(t / width);
  const tickAfter = Math.floor(Math.log(r.sqrtPriceAfter ** 2) / Math.log(1.0001));
  return {
    out: r.amountOut,
    unfilledShare: r.unfilledIn / Number(q.amountIn),
    ticksCrossed: r.ticksCrossed,
    arraysSpanned: Math.abs(startOf(tickAfter) - startOf(pool.tickCurrent)) + 1,
    relDiff: q.jupiter
      ? (r.amountOut - Number(q.jupiter.outAmount)) / Number(q.jupiter.outAmount)
      : null,
  };
};

const last = runs[runs.length - 1] as (typeof runs)[number];
const lines: string[] = [];
lines.push(
  `**The liquidity check** (read ${last.v.fetchedAt}; exact, in whole numbers). “At the price” is the sum of the ticks at or below the pool’s current tick; “all ticks” is the sum over every tick read.`,
  '',
  '| Pool | Stock | Accounts: fixed / dynamic / neither | Ticks with liquidity: fixed / dynamic | Stored liquidity | At the price | All ticks | Holds | Slots between the pool and its arrays |',
  '|---|---|---|---|---|---|---|---|---|',
);
for (const r of last.v.invariant)
  lines.push(
    `| ${short(r.pool)} | ${r.stocks.join(' / ')} | ${r.accounts.fixed} / ${r.accounts.dynamic} / ${r.accounts.neither} | ${r.ticks.fixed} / ${r.ticks.dynamic} | ${r.stored} | ${r.atPrice} | ${r.total} | ${r.holds ? 'yes' : `**no**${r.error ? `: ${r.error}` : ''}`} | ${Math.abs(r.slots.arrays - r.slots.pool)} |`,
  );
const inv = last.v.invariant;
lines.push(
  '',
  `${inv.filter((r) => r.holds).length} of ${inv.length} pools hold. ${inv.reduce((s, r) => s + r.accounts.fixed, 0)} fixed arrays and ${inv.reduce((s, r) => s + r.accounts.dynamic, 0)} of the second kind; ${inv.reduce((s, r) => s + r.accounts.neither, 0)} accounts are neither. Read again after a first read that did not hold: ${last.v.invariantFirstReads.length}.`,
  ...runs
    .slice(0, -1)
    .map(
      (r) =>
        `The same check in the run of ${r.v.fetchedAt}: ${r.v.invariant.filter((x) => x.holds).length} of ${r.v.invariant.length}.`,
    ),
  '',
  `**Jupiter’s own quote through the same pool** (onlyDirectRoutes, dexes=Byreal; tolerance ${sci(last.v.tolerance)}). Difference = (ours − Jupiter’s) ÷ Jupiter’s, on the raw amount received. A row counts when the pool’s price, tick and liquidity were the same in the read before the quote and the read after it and Jupiter’s slot lies between the two.`,
  '',
  '| Run | Pool | Stock | Fee | Side | Size | Sent (raw) | Ours (raw) | Jupiter’s (raw) | Difference | Ticks crossed | Arrays spanned | Slots: read, Jupiter, read | Counted |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
);
let maxCounted = 0;
for (const { v } of runs)
  for (const p of v.quoted)
    for (const [q, again] of [
      // a file written before a trade could be asked again has no such list
      ...(p.retaken ?? []).map((x) => [x, true] as const),
      ...p.quotes.map((x) => [x, false] as const),
    ]) {
      const r = recompute(p, q);
      const oneState = q.sameState && q.bracketed === true;
      const counted = !again && oneState && r.relDiff !== null;
      if (counted) maxCounted = Math.max(maxCounted, Math.abs(r.relDiff as number));
      const why = again
        ? 'no: asked again (the pool moved)'
        : r.relDiff === null
          ? `no: ${q.jupiterError}; ours ${r.unfilledShare > 0 ? `leaves ${(r.unfilledShare * 100).toFixed(1)}% unfilled` : 'fills it'}`
          : !q.sameState
            ? 'no: the pool changed between the two reads'
            : q.bracketed !== true
              ? 'no: Jupiter’s slot is outside the two reads'
              : Math.abs(r.relDiff) <= v.tolerance
                ? 'yes, inside'
                : '**yes, OUTSIDE**';
      lines.push(
        `| ${v.fetchedAt.slice(11, 16)}Z | ${short(p.pool)} | ${p.stock} | ${(p.tradeFeeRate / 10_000).toFixed(4).replace(/\.?0+$/, '')}% (${p.feeFrom === 'pool' ? 'the pool’s own' : 'its config’s'}) | ${q.side === 'sell' ? 'sale' : 'purchase'} | $${q.usd.toLocaleString('en-US')} | ${q.amountIn} | ${Math.floor(r.out)} | ${q.jupiter?.outAmount ?? 'none'} | ${r.relDiff === null ? 'none' : sci(r.relDiff)} | ${r.ticksCrossed} | ${r.arraysSpanned} | ${q.slotBefore}, ${q.jupiter?.contextSlot ?? 'none'}, ${q.slotAfter} | ${why} |`,
      );
    }
lines.push('');
for (const { v } of runs) {
  if (!v.quoted.length) continue;
  const verdict = byrealVerdict(v);
  const stockOf = (pool: string) => v.quoted.find((p) => p.pool === pool)?.stock ?? pool;
  lines.push(
    `Run of ${v.fetchedAt}: ${v.jupiterQuotes} quotes asked, ${verdict.quotes.compared} compared, ${verdict.quotes.within} inside the tolerance${verdict.quotes.maxAbsRelDiff === null ? '' : ` (largest ${sci(verdict.quotes.maxAbsRelDiff)})`}; all six trades compared and inside for ${verdict.quotes.poolsWithAllSixWithin.map(stockOf).join(', ') || 'no pool'}; not compared: ${verdict.quotes.notCompared.map((n) => `${stockOf(n.pool)} ${n.side} $${n.usd.toLocaleString('en-US')} (${n.why})`).join('; ') || 'none'}.`,
  );
}
lines.push(
  '',
  `Largest difference over the rows counted, computed again here: ${sci(maxCounted)}.`,
  `Sources: ${[...new Set(runs.map((r) => r.v.source))].join(' | ')}.`,
);
console.log(lines.join('\n'));
