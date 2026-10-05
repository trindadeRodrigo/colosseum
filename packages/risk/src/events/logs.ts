import { createHash } from 'node:crypto';

/** One program invocation in a transaction's logs: its own `Program data:` payloads (not those of
 *  programs it calls), the instruction names it logged, and its depth. Frames are in invoke order. */
export type LogFrame = {
  program: string;
  depth: number;
  ix: string[];
  data: Uint8Array[];
  ok: boolean;
};

export type ParsedLogs = { frames: LogFrame[]; truncated: boolean };

/** Rebuild invoke frames from `meta.logMessages`. `truncated` is set when the validator cut the log
 *  ("Log truncated"), in which case events after the cut are missing and the caller must flag the tx. */
export function parseLogs(logs: readonly string[]): ParsedLogs {
  const frames: LogFrame[] = [];
  const stack: LogFrame[] = [];
  let truncated = false;
  for (const l of logs) {
    const inv = /^Program (\w+) invoke \[(\d+)\]/.exec(l);
    if (inv) {
      const f: LogFrame = {
        program: inv[1] as string,
        depth: Number(inv[2]),
        ix: [],
        data: [],
        ok: false,
      };
      frames.push(f);
      stack.push(f);
      continue;
    }
    const end = /^Program (\w+) (success|failed)/.exec(l);
    if (end) {
      const f = stack.pop();
      if (f) f.ok = end[2] === 'success';
      continue;
    }
    if (l === 'Log truncated') {
      truncated = true;
      continue;
    }
    const top = stack.at(-1);
    if (!top) continue;
    if (l.startsWith('Program data: '))
      top.data.push(new Uint8Array(Buffer.from(l.slice(14), 'base64')));
    else {
      const ix = /^Program log: Instruction: (\w+)/.exec(l);
      if (ix) top.ix.push(ix[1] as string);
    }
  }
  return { frames, truncated };
}

/** Anchor event discriminator: sha256("event:<Name>")[0..8] as hex. */
export const eventDisc = (name: string) =>
  createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');

export const discOf = (d: Uint8Array) =>
  Array.from(d.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');

/** A decoded pool event. Amounts are raw token units as decimal strings; liquidity as decimal strings.
 *  `kind`:
 *   - swap: post-trade price state (`sqrtPriceX64`, `liquidity`, `tick`) as the program reports it.
 *   - liquidity: a position's liquidity change over [tickLower, tickUpper) (`liquidityDelta` signed);
 *     `action` is open | increase | decrease. For bin venues the range is bins and the delta is per-bin. */
export type PoolEvent =
  | {
      kind: 'swap';
      pool: string;
      ixIndex: number;
      amount0: string;
      amount1: string;
      zeroForOne: boolean;
      sqrtPriceX64?: string;
      /** Pre-trade price, when the venue reports it (Orca). */
      preSqrtPriceX64?: string;
      liquidity?: string;
      tick?: number;
      activeId?: number;
      reserve0After?: string;
      reserve1After?: string;
    }
  | {
      kind: 'liquidity';
      pool: string;
      ixIndex: number;
      action: 'open' | 'increase' | 'decrease';
      tickLower?: number;
      tickUpper?: number;
      liquidityDelta?: string;
      amount0: string;
      amount1: string;
      position?: string;
      owner?: string;
      tick?: number;
      poolLiquidityBefore?: string;
      poolLiquidityAfter?: string;
      bins?: Array<{ binId: number; amount0: string; amount1: string }>;
      lpDelta?: string;
      /** LP fees paid out with a decrease (raw units); they leave the vaults with the principal. */
      fee0?: string;
      fee1?: string;
    }
  | { kind: 'close'; pool: string; ixIndex: number; position?: string }
  /** LP fees paid out of the vaults by a separate claim (DLMM). */
  | {
      kind: 'fees';
      pool: string;
      ixIndex: number;
      amount0: string;
      amount1: string;
      position?: string;
    };
