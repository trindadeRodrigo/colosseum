import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  BYREAL_DYN_TICK_ARRAY_DISC,
  BYREAL_FIXED_TICK_ARRAY_DISC,
  buildPoolSim,
  byrealArraysCheck,
  byrealClState,
  byrealFee,
  byrealLiquidityCheck,
  clSim,
  decodeByrealDynTickArray,
  decodeByrealPoolFee,
  decodeByrealTickArray,
  decodeClmmPool,
  decodeClmmTickArray,
  routeTrade,
  swapExactIn,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  BYREAL_QUOTE_TOLERANCE,
  type ByrealPoolsFile,
  type ByrealValidatedPool,
  type ByrealValidationFile,
  byrealForCapture,
  byrealInvariantRow,
  byrealPoolRow,
  byrealPoolsTable,
  byrealSimulate,
  byrealVerdict,
  countByrealArrays,
} from '../../scripts/risk/byreal/lib';
import { parseRouterArgs } from '../../scripts/risk/lib-routing-gap';
import {
  buildSplit,
  loadCapture,
  oneHopRows,
  type RegPool,
  type SplitCapture,
  withoutByreal,
} from '../../scripts/risk/lib-split';

// PLAN-UNIVERSE RU.15 — the Byreal decoder on two mainnet pools frozen on 2026-10-07 by
// `pnpm risk:byreal-validate` and cut out by `pnpm risk:byreal-freeze-fixture` (fixtures/risk/byreal): SPYx/USDC
// (5 fixed tick arrays, 42 of the second kind, a rate of its own) with six of Jupiter's own quotes through it, and
// TSLAx/USDC (10 and 32, its config's rate) with five and one size Jupiter did not quote. Each quote is frozen with
// the pool account it was set against. No test calls the network, and nothing here sets a pool price against an
// oracle.
type Frozen = ByrealValidatedPool & { tolerance: number; fetchedAt: string };
const load = (f: string) =>
  JSON.parse(gunzipSync(readFileSync(`fixtures/risk/byreal/${f}`)).toString()) as Frozen;
const spyx = load('spyx-27x6aS-20261007T1408.json.gz');
const tslax = load('tslax-6FQQyf-20261007T1409.json.gz');
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const kids = (p: Frozen) => Object.values(p.children).map(b);
const hex8 = (d: Uint8Array) => Buffer.from(d.subarray(0, 8)).toString('hex');
const quoteOf = (p: Frozen, side: string, usd: number) => {
  const q = p.quotes.find((x) => x.side === side && x.usd === usd);
  if (!q) throw new Error(`no ${side} ${usd}`);
  return q;
};

describe('the two kinds of tick array', () => {
  it('are told apart by the account’s own first 8 bytes, and an account that is neither reads as null', () => {
    for (const [p, fixed, dynamic] of [
      [spyx, 5, 42],
      [tslax, 10, 32],
    ] as const) {
      const spacing = decodeClmmPool(b(quoteOf(p, 'sell', 1000).head)).tickSpacing;
      const counts = { fixed: 0, dynamic: 0, neither: 0 };
      for (const d of kids(p)) {
        const a = decodeByrealTickArray(d, spacing);
        const disc = hex8(d);
        if (disc === BYREAL_FIXED_TICK_ARRAY_DISC) expect(a?.kind).toBe('fixed');
        else if (disc === BYREAL_DYN_TICK_ARRAY_DISC) expect(a?.kind).toBe('dynamic');
        else expect(a).toBeNull();
        counts[a ? a.kind : 'neither']++;
        if (a) expect(a.pool).toBe(p.pool);
      }
      // the two that are neither: the bitmap extension and the reward config
      expect(counts).toEqual({ fixed, dynamic, neither: 2 });
      expect(p.accounts).toEqual(counts);
    }
  });

  it('the second kind is read by its header and table, where Raydium’s reader gives nothing or ticks that are not ticks', () => {
    const h = decodeClmmPool(b(quoteOf(spyx, 'sell', 1000).head));
    let ticks = 0;
    for (const d of kids(spyx)) {
      if (hex8(d) !== BYREAL_DYN_TICK_ARRAY_DISC) continue;
      const a = decodeByrealDynTickArray(d, h.tickSpacing);
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      // the account is its 216-byte header and one 168-byte tick for each one allocated
      expect(d.length).toBe(216 + (d[108] as number) * 168);
      // every tick read sits on the pool's grid inside this array's 60, in the place its slot says
      for (const t of a.ticks) {
        const k = (t.tick - a.startTickIndex) / h.tickSpacing;
        expect(Number.isInteger(k) && k >= 0 && k < 60).toBe(true);
        const slot = d[48 + k] as number;
        expect(slot).toBeGreaterThan(0);
        expect(v.getInt32(216 + (slot - 1) * 168, true)).toBe(t.tick);
        expect((t.gross as bigint) > 0n).toBe(true);
      }
      ticks += a.ticks.length;
      // Raydium's reader on the same bytes: null when the account is short, and otherwise not these ticks
      const asRaydium = decodeClmmTickArray(d);
      if (asRaydium)
        expect(asRaydium.ticks.map((t) => t.tick)).not.toEqual(a.ticks.map((t) => t.tick));
    }
    expect(ticks).toBeGreaterThan(100);
  });

  it('an account with the second kind’s first bytes and another layout throws, it is not read as empty', () => {
    const spacing = 10;
    const dyn = kids(spyx).find(
      (d) => hex8(d) === BYREAL_DYN_TICK_ARRAY_DISC && d.length > 216 + 168,
    );
    if (!dyn) throw new Error('no dynamic array with two ticks');
    // one tick short of what its own count says
    expect(() => decodeByrealDynTickArray(dyn.subarray(0, dyn.length - 168), spacing)).toThrow(
      /size/,
    );
    // a slot that points past the ticks the account holds
    const far = new Uint8Array(dyn);
    const used = far.subarray(48, 108).findIndex((s) => s !== 0);
    far[48 + used] = 61;
    expect(() => decodeByrealDynTickArray(far, spacing)).toThrow(/points at tick/);
    // two slots on one tick
    const twice = new Uint8Array(dyn);
    const free = twice.subarray(48, 108).indexOf(0);
    twice[48 + free] = twice[48 + used] as number;
    expect(() => decodeByrealDynTickArray(twice, spacing)).toThrow(/points at tick/);
    // a tick that is not the one its place says: the pool's spacing read wrong
    expect(() => decodeByrealDynTickArray(dyn, 1)).toThrow(/holds tick/);
    // and a fixed array's first bytes are not this kind's
    const fixed = kids(spyx).find((d) => hex8(d) === BYREAL_FIXED_TICK_ARRAY_DISC) as Uint8Array;
    expect(() => decodeByrealDynTickArray(fixed, spacing)).toThrow(/first 8 bytes/);
    expect(() => decodeByrealTickArray(fixed, 7)).toThrow(/not one of its 60/);
    expect(decodeByrealTickArray(new Uint8Array(4), spacing)).toBeNull();
  });
});

describe('the liquidity check', () => {
  it('holds exactly on both pools, at every pool account frozen: at the price and over all the ticks', () => {
    for (const p of [spyx, tslax])
      for (const q of p.quotes) {
        const h = decodeClmmPool(b(q.head));
        const arrays = kids(p)
          .map((d) => decodeByrealTickArray(d, h.tickSpacing))
          .filter((a): a is NonNullable<typeof a> => a !== null);
        const check = byrealLiquidityCheck(h, arrays);
        expect(check.atPrice).toBe(h.liquidity);
        expect(check.total).toBe(0n);
        expect(check.holds).toBe(true);
        // both kinds carry ticks at or below the price: neither alone adds up
        for (const kind of ['fixed', 'dynamic'] as const)
          expect(
            byrealLiquidityCheck(
              h,
              arrays.filter((a) => a.kind === kind),
            ).holds,
          ).toBe(false);
      }
  });

  it('fails when one array is missing, below the price or above it, and the pool is then not built', () => {
    const head = b(quoteOf(spyx, 'sell', 1000).head);
    const h = decodeClmmPool(head);
    const all = kids(spyx);
    const withTicks = all
      .map((d) => ({ d, a: decodeByrealTickArray(d, h.tickSpacing) }))
      .filter((x) => x.a && x.a.ticks.length > 0);
    const below = withTicks.find((x) => (x.a?.startTickIndex ?? 0) + 600 <= h.tickCurrent);
    const above = withTicks.find((x) => (x.a?.startTickIndex ?? 0) > h.tickCurrent);
    if (!below || !above) throw new Error('no array on both sides of the price');
    for (const gone of [below, above]) {
      const rest = all.filter((d) => d !== gone.d);
      const arrays = rest
        .map((d) => decodeByrealTickArray(d, h.tickSpacing))
        .filter((a): a is NonNullable<typeof a> => a !== null);
      const check = byrealLiquidityCheck(h, arrays);
      expect(check.holds).toBe(false);
      expect(check.total).not.toBe(0n);
      expect(() => byrealClState(spyx.pool, head, b(spyx.config.data), rest)).toThrow(
        /arrays check/,
      );
    }
    // the array above the price leaves the sum at the price right: only the sum over all the ticks catches it
    const noAbove = all
      .filter((d) => d !== above.d)
      .map((d) => decodeByrealTickArray(d, h.tickSpacing))
      .filter((a): a is NonNullable<typeof a> => a !== null);
    expect(byrealLiquidityCheck(h, noAbove).atPrice).toBe(h.liquidity);
  });

  it('an array whose ticks add up to nothing is still missed out loud: the pool’s own bitmap names it', () => {
    // An array above the price that holds one position with both ends inside it: its two ticks cancel, so the sums
    // do not see it go. Made from an allocated array with no liquidity: +L and -L written in its two ticks, its
    // count set, and its bit set in the pool's bitmap, as the program would have left them.
    const q = quoteOf(spyx, 'sell', 1000);
    const head = new Uint8Array(b(q.head));
    const h = decodeClmmPool(head);
    const all = kids(spyx).map((d) => new Uint8Array(d));
    const empty = all.find((d) => {
      if (hex8(d) !== BYREAL_DYN_TICK_ARRAY_DISC || (d[108] as number) < 2) return false;
      const a = decodeByrealDynTickArray(d, h.tickSpacing);
      return a.ticks.length === 0 && a.startTickIndex > h.tickCurrent;
    });
    if (!empty) throw new Error('no allocated array without liquidity above the price');
    const v = new DataView(empty.buffer, empty.byteOffset, empty.byteLength);
    const start = v.getInt32(40, true);
    const slots = [...empty.subarray(48, 108)]
      .map((slot, k) => ({ slot, k }))
      .filter((x) => x.slot > 0)
      .slice(0, 2);
    const L = 5_000_000_000_000n;
    slots.forEach(({ slot, k }, i) => {
      const o = 216 + (slot - 1) * 168;
      v.setInt32(o, start + k * h.tickSpacing, true);
      v.setBigInt64(o + 4, i === 0 ? L : -L, true);
      v.setBigInt64(o + 12, i === 0 ? 0n : -1n, true);
      v.setBigUint64(o + 20, L, true);
    });
    empty[109] = 2;
    const bit = start / (60 * h.tickSpacing) + 512;
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const limb = 904 + 8 * Math.floor(bit / 64);
    hv.setBigUint64(limb, hv.getBigUint64(limb, true) | (1n << BigInt(bit % 64)), true);

    const cfg = b(spyx.config.data);
    const whole = byrealClState(spyx.pool, head, cfg, all);
    const arrays = (ds: Uint8Array[]) =>
      ds
        .map((d) => decodeByrealTickArray(d, h.tickSpacing))
        .filter((a): a is NonNullable<typeof a> => a !== null);
    const rest = all.filter((d) => d !== empty);
    // the sums hold without it, and the trade through it would be priced with a hole
    expect(byrealLiquidityCheck(h, arrays(rest)).holds).toBe(true);
    expect(byrealArraysCheck(head, arrays(all))).toEqual({ missing: [], unnamed: [], holds: true });
    expect(byrealArraysCheck(head, arrays(rest))).toEqual({
      missing: [start],
      unnamed: [],
      holds: false,
    });
    expect(() => byrealClState(spyx.pool, head, cfg, rest)).toThrow(/arrays check: 1 array/);
    // and an array read that the pool does not name fails the same way
    expect(byrealArraysCheck(b(q.head), arrays(all))).toEqual({
      missing: [],
      unnamed: [start],
      holds: false,
    });
    expect(whole.arrays.length).toBe(47);
  });

  it('the pool’s bitmap names exactly the arrays that hold a tick, on both pools', () => {
    for (const p of [spyx, tslax])
      for (const q of p.quotes) {
        const head = b(q.head);
        const spacing = decodeClmmPool(head).tickSpacing;
        const arrays = kids(p)
          .map((d) => decodeByrealTickArray(d, spacing))
          .filter((a): a is NonNullable<typeof a> => a !== null);
        expect(byrealArraysCheck(head, arrays).holds).toBe(true);
      }
  });

  it('the validation’s row says the same, and names what a reader threw', () => {
    const head = b(quoteOf(tslax, 'buy', 1000).head);
    const ok = byrealInvariantRow(tslax.pool, ['TSLAx'], head, kids(tslax), { pool: 1, arrays: 2 });
    expect(ok.holds).toBe(true);
    expect(ok.accounts).toEqual({ fixed: 10, dynamic: 32, neither: 2 });
    expect(ok.ticks.fixed).toBeGreaterThan(0);
    expect(ok.ticks.dynamic).toBeGreaterThan(0);
    expect(ok.atPrice).toBe(ok.stored);
    expect(ok.total).toBe('0');
    const broken = kids(tslax).map((d) =>
      hex8(d) === BYREAL_DYN_TICK_ARRAY_DISC ? d.subarray(0, d.length - 1) : d,
    );
    const bad = byrealInvariantRow(tslax.pool, ['TSLAx'], head, broken, { pool: 1, arrays: 2 });
    expect(bad.holds).toBe(false);
    expect(bad.error).toMatch(/byreal dynamic tick array: size/);
  });
});

describe('the fee', () => {
  const head = b(quoteOf(spyx, 'sell', 1000).head);
  const cfg = b(spyx.config.data);
  const patched = (edit: (d: Uint8Array) => void) => {
    const d = new Uint8Array(head);
    edit(d);
    return d;
  };

  it('is the pool’s own rate when it has one, and its config’s otherwise', () => {
    expect(byrealFee(head, cfg)).toEqual({ priced: true, tradeFeeRate: 80, from: 'pool' });
    expect(spyx.tradeFeeRate).toBe(80);
    expect(byrealFee(b(quoteOf(tslax, 'sell', 1000).head), b(tslax.config.data))).toEqual({
      priced: true,
      tradeFeeRate: 2000,
      from: 'config',
    });
    // the same pool with its own rate cleared pays its config's
    const cleared = patched((d) => d.fill(0, 393, 397));
    expect(byrealFee(cleared, cfg)).toEqual({ priced: true, tradeFeeRate: 2000, from: 'config' });
  });

  it('the SPYx pool has its feeds set and its dynamic fee switched off: it is priced', () => {
    const own = decodeByrealPoolFee(head);
    expect(own.dynamic).toEqual({ on: false, token1IsQuote: true, feedsSet: true });
    expect(own.decay.on).toBe(false);
    expect(own.swapDisabled).toBe(false);
  });

  it('is not computed for a pool with the dynamic fee on, the decaying fee on, or swaps off: the pool is not built', () => {
    // byte, bit and the reason given: the flag byte's switches, and bit 4 of the status
    for (const [at, bit, reason] of [
      [1096, 16, 'dynamic_fee_on'],
      [1096, 1, 'decaying_fee_on'],
      [389, 16, 'swaps_switched_off'],
    ] as const) {
      const d = patched((x) => {
        x[at] = (x[at] as number) | bit;
      });
      expect(byrealFee(d, cfg)).toEqual({ priced: false, reason });
      expect(() => byrealClState(spyx.pool, d, cfg, kids(spyx))).toThrow(
        new RegExp(`not priced from its own accounts: ${reason}`),
      );
    }
  });
});

describe('Jupiter’s own quote through the same pool', () => {
  it('every frozen quote is inside the tolerance Raydium met, sales and purchases, at each size', () => {
    expect(BYREAL_QUOTE_TOLERANCE).toBe(2e-8);
    let compared = 0;
    for (const p of [spyx, tslax])
      for (const q of p.quotes) {
        if (!q.jupiter) continue;
        expect(q.jupiter.ammKey).toBe(p.pool);
        expect(q.sameState && q.bracketed).toBe(true);
        const sim = byrealSimulate(
          p.pool,
          b(q.head),
          b(p.config.data),
          kids(p),
          p.stockIsToken0,
          q.side,
          Number(q.amountIn),
        );
        const rel = Math.abs(sim.out - Number(q.jupiter.outAmount)) / Number(q.jupiter.outAmount);
        expect(rel).toBeLessThanOrEqual(BYREAL_QUOTE_TOLERANCE);
        expect(sim.unfilledShare).toBe(0);
        compared++;
      }
    // SPYx: all six; TSLAx: five
    expect(compared).toBe(11);
    expect(spyx.quotes.map((q) => `${q.side} ${q.usd}`)).toEqual([
      'sell 1000',
      'sell 10000',
      'sell 100000',
      'buy 1000',
      'buy 10000',
      'buy 100000',
    ]);
  });

  it('the size Jupiter did not quote is one the pool cannot fill: our simulation leaves part of it', () => {
    const q = quoteOf(tslax, 'sell', 100_000);
    expect(q.jupiter).toBeNull();
    expect(q.jupiterError).toMatch(/NO_ROUTES_FOUND/);
    const sim = byrealSimulate(
      tslax.pool,
      b(q.head),
      b(tslax.config.data),
      kids(tslax),
      true,
      'sell',
      Number(q.amountIn),
    );
    expect(sim.unfilledShare).toBeGreaterThan(0.01);
  });

  it('a sale recomputed by hand from the bytes: the fee, one tick crossed, two ranges', () => {
    const q = quoteOf(spyx, 'sell', 10_000);
    const head = b(q.head);
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const u128 = (v: DataView, o: number) =>
      v.getBigUint64(o, true) + (v.getBigUint64(o + 8, true) << 64n);
    const i128 = (v: DataView, o: number) => {
      const u = u128(v, o);
      return u >= 1n << 127n ? u - (1n << 128n) : u;
    };
    // the pool account: liquidity at 237, the square root of the price at 253, the tick at 269, its own rate at 393
    let liquidity = Number(u128(hv, 237));
    let sqrtPrice = Number(u128(hv, 253)) / 2 ** 64;
    const tickCurrent = hv.getInt32(269, true);
    const feeRate = hv.getUint32(393, true) / 1e6;
    expect(feeRate).toBe(0.00008);
    // every tick with liquidity, read from the two layouts with nothing of the decoder
    const ticks: Array<{ tick: number; net: number }> = [];
    for (const d of kids(spyx)) {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const at = (o: number) => {
        if (u128(v, o + 20) !== 0n)
          ticks.push({ tick: v.getInt32(o, true), net: Number(i128(v, o + 4)) });
      };
      if (hex8(d) === BYREAL_FIXED_TICK_ARRAY_DISC) for (let k = 0; k < 60; k++) at(44 + k * 168);
      if (hex8(d) === BYREAL_DYN_TICK_ARRAY_DISC)
        for (let k = 0; k < 60; k++) {
          const slot = d[48 + k] as number;
          if (slot) at(216 + (slot - 1) * 168);
        }
    }
    const below = ticks.filter((t) => t.tick <= tickCurrent).sort((x, y) => y.tick - x.tick);
    // SPYx is token 0: a sale sends token 0 in and the price falls through the ticks below it
    let remaining = Number(q.amountIn) * (1 - feeRate);
    let out = 0;
    let crossed = 0;
    for (const t of below) {
      const target = Math.sqrt(1.0001 ** t.tick);
      const toTarget = liquidity * (1 / target - 1 / sqrtPrice);
      if (remaining < toTarget) break;
      out += liquidity * (sqrtPrice - target);
      remaining -= toTarget;
      sqrtPrice = target;
      liquidity -= t.net;
      crossed++;
    }
    const after = (liquidity * sqrtPrice) / (liquidity + remaining * sqrtPrice);
    out += liquidity * (sqrtPrice - after);

    expect(crossed).toBe(1);
    expect(q.ticksCrossed).toBe(1);
    const jupiter = Number(q.jupiter?.outAmount);
    expect(Math.abs(out - jupiter) / jupiter).toBeLessThanOrEqual(BYREAL_QUOTE_TOLERANCE);
    // and the decoder's own answer is this one
    const { state } = byrealClState(spyx.pool, head, b(spyx.config.data), kids(spyx));
    const ours = swapExactIn(state, Number(q.amountIn), true);
    expect(ours.ticksCrossed).toBe(1);
    expect(Math.abs(ours.amountOut - out) / out).toBeLessThan(1e-12);
    // about $9,985 for the $10,000 sent: the 0.008% fee and the price moved
    expect(out / 1e6).toBeGreaterThan(9_980);
    expect(out / 1e6).toBeLessThan(9_990);
  });
});

describe('buildPoolSim', () => {
  const head = b(quoteOf(spyx, 'buy', 1000).head);
  const cfg = b(spyx.config.data);
  const ref = {
    address: spyx.pool,
    venue: 'byreal_clmm' as const,
    assetMint: spyx.stockMint,
    assetIsToken0: true,
    transferFeeBps0: 0,
    transferFeeBps1: 0,
  };

  it('a Byreal pool is the concentrated-liquidity simulator on its state, with its own fee', () => {
    const built = buildPoolSim(ref, head, kids(spyx), cfg);
    const hand = clSim(byrealClState(spyx.pool, head, cfg, kids(spyx)).state, true);
    expect(built.feeRate).toBe(0.00008);
    expect(built.invariantRelErr).toBe(0);
    expect(built.sim.midRaw).toBe(hand.midRaw);
    for (const n of [1e6, 1e8, 1e10]) {
      expect(built.sim.sellAsset(n)).toEqual(hand.sellAsset(n));
      expect(built.sim.buyAsset(n)).toEqual(hand.buyAsset(n));
    }
  });

  it('is not built without its fee config or without its arrays, where a Raydium pool would be', () => {
    expect(() => buildPoolSim(ref, head, kids(spyx))).toThrow(/no fee config/);
    expect(() => buildPoolSim(ref, head, [], cfg)).toThrow(/arrays check/);
    // read as a Raydium pool the same bytes build, with the config's rate and a liquidity check that fails
    const asRaydium = buildPoolSim({ ...ref, venue: 'raydium_clmm' }, head, kids(spyx), cfg);
    expect(asRaydium.feeRate).toBe(0.002);
    expect(asRaydium.invariantRelErr).toBeGreaterThan(1e-9);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The table, the capture and the router
// ---------------------------------------------------------------------------------------------------------------------

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const stocks = new Map([
  [SPYX, 'SPYx'],
  [TSLAX, 'TSLAx'],
]);
// an SPL token account that holds `amount`: only the amount at byte 64 is read
const vault = (amount: bigint) => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};
const childrenOf = (p: Frozen) =>
  Object.entries(p.children).map(([address, data]) => {
    const d = b(data);
    return { address, space: d.length, head: d.subarray(0, 112) };
  });
const rowOf = (p: Frozen, v0: bigint, v1: bigint) =>
  byrealPoolRow(
    p.pool,
    b(quoteOf(p, 'sell', 1000).head),
    {
      config: b(p.config.data),
      vault0: vault(v0),
      vault1: vault(v1),
      children: childrenOf(p),
      slots: { pool: 10, arrays: 11 },
    },
    stocks,
  );
const table = (rows: ByrealPoolsFile['rows']): ByrealPoolsFile & { file: string } => ({
  file: 'table.json',
  method: 'byreal-pools-0.1',
  source: 'test',
  fetchedAt: '2026-10-07T13:52:58.647Z',
  provenance: 'live',
  program: 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',
  tracked: [...stocks].map(([mint, symbol]) => ({ symbol, mint })),
  trackedSource: 'test',
  rows,
  rpc: { calls: 57, searchCalls: 36, retries429: 0, errors: 0, seconds: 21.5 },
});

describe('the table of step 1', () => {
  // 161.72 SPYx and 192,775 USDC; 443.27 TSLAx and 99,535 USDC: what the vaults held at the table's read
  const s = rowOf(spyx, 16_172_000_000n, 192_775_000_000n);
  const t = rowOf(tslax, 44_327_000_000n, 99_535_000_000n);

  it('a row: the two tokens, the money at the pool’s own price, the arrays by kind and the fee settings', () => {
    expect(s.stocks).toEqual(['SPYx']);
    expect([s.symbol0, s.symbol1, s.tickSpacing]).toEqual(['SPYx', 'USDC', 10]);
    expect(s.vault0).toBeCloseTo(161.72, 6);
    expect(s.usd?.dollars).toBe(192_775);
    // the stock side at the pool's own price, about $779 a token
    expect((s.usd?.stock ?? 0) / 161.72).toBeGreaterThan(770);
    expect((s.usd?.stock ?? 0) / 161.72).toBeLessThan(790);
    expect(s.arrays).toMatchObject({ fixed: 5, dynamic: 42, bitmapExtension: 1, other: 1 });
    expect(s.arrays.sizeMismatch).toBe(0);
    expect(s.arrays.otherKinds).toEqual(['763473966345a44c']);
    expect(countByrealArrays(childrenOf(spyx)).dynamicTicks).toBe(s.arrays.dynamicTicks);
    expect(s.fee).toMatchObject({ configRate: 2000, poolRate: 80 });
    expect(s.fee.dynamic).toEqual({ on: false, token1IsQuote: true, feedsSet: true });
    expect(t.fee).toMatchObject({ configRate: 2000, poolRate: 0 });
    expect(t.fee.dynamic.on || t.fee.decay.on).toBe(false);
  });

  it('a pool with no dollar side is not priced, and an array of a size its kind does not have is counted', () => {
    const other = byrealPoolRow(
      spyx.pool,
      b(quoteOf(spyx, 'sell', 1000).head),
      {
        config: null,
        vault0: vault(1n),
        vault1: vault(1n),
        children: [],
        slots: { pool: 1, arrays: 1 },
      },
      new Map([[USDC, 'not a stock']]),
    );
    expect(other.usd).toBeNull();
    expect(other.fee.configRate).toBeNull();
    const kidsOff = childrenOf(spyx).map((c, i) => (i === 0 ? { ...c, space: c.space + 1 } : c));
    expect(countByrealArrays(kidsOff).sizeMismatch).toBe(1);
  });

  it('the table prints one row a pool, which unquoted stocks have one, and how many pools have a switch on', () => {
    const md = byrealPoolsTable(table([s, t]), ['AAPLx', 'TSLAx']);
    expect(md).toContain('| `27x6aS…` | SPYx / USDC | 10 |');
    expect(md).toContain('config 0.2% · pool’s own 0.008% · decaying fee off · dynamic fee off');
    expect(md).toContain('config 0.2% · no rate of its own · decaying fee off · dynamic fee off');
    expect(md).toContain('with a pool, TSLAx; with none, AAPLx');
    expect(md).toContain('Dynamic fee switched on: 0 (none). Decaying fee switched on: 0 (none)');
    expect(md).toContain('57 RPC calls (36 of them the search by mint)');
  });
});

describe('the pools a capture takes', () => {
  const s = rowOf(spyx, 16_172_000_000n, 192_775_000_000n);
  const t = rowOf(tslax, 44_327_000_000n, 99_535_000_000n);
  const headOf = (p: Frozen) => b(quoteOf(p, 'sell', 1000).head);
  const accountsOf = (p: Frozen, v0: bigint, v1: bigint, head = headOf(p)) => {
    const h = decodeClmmPool(head);
    return new Map<string, { data: Uint8Array } | null>([
      [p.pool, { data: head }],
      [h.ammConfig, { data: b(p.config.data) }],
      [h.vault0, { data: vault(v0) }],
      [h.vault1, { data: vault(v1) }],
    ]);
  };
  const deps = (accounts: Map<string, { data: Uint8Array } | null>, listed: string[] = []) => {
    let calls = 0;
    return {
      read: async (keys: string[]) => {
        calls++;
        return { slot: 77, accounts: new Map(keys.map((k) => [k, accounts.get(k) ?? null])) };
      },
      transferFeeBps: async (mints: string[]) => {
        calls++;
        return new Map(mints.map((m) => [m, 0]));
      },
      listChildren: async (pool: string) => {
        calls++;
        listed.push(pool);
        return pool === spyx.pool ? Object.keys(spyx.children) : Object.keys(tslax.children);
      },
      rpcCalls: () => calls,
    };
  };

  it('takes a stock-and-dollar pool of $1,000 or more with a fee its accounts give, and lists what it owns', async () => {
    const accounts = new Map([
      ...accountsOf(spyx, 16_172_000_000n, 192_775_000_000n),
      ...accountsOf(tslax, 44_327_000_000n, 99_535_000_000n),
    ]);
    const listed: string[] = [];
    const got = await byrealForCapture(table([t, s]), { only: null }, deps(accounts, listed));
    expect(got.pools.map((p) => p.address)).toEqual([spyx.pool, tslax.pool]);
    expect(got.pools[0]).toMatchObject({
      venue: 'byreal_clmm',
      assetMint: SPYX,
      assetSymbol: 'SPYx',
      assetIsToken0: true,
      quoteMint: USDC,
      quoteSymbol: 'USDC',
      exitPath: 'direct_usd',
      tier: 'not_in_registry',
      decimals0: 8,
      decimals1: 6,
      transferFeeBps0: 0,
      transferFeeBps1: 0,
    });
    // measured at this read: the vaults at the pool's own price
    expect(got.pools[0]?.tvlUsd).toBeGreaterThan(300_000);
    expect(got.children[spyx.pool]).toEqual(Object.keys(spyx.children).sort());
    expect(listed).toEqual([spyx.pool, tslax.pool]);
    expect(got.meta).toMatchObject({
      table: { file: 'table.json', fetchedAt: '2026-10-07T13:52:58.647Z' },
      minUsd: 1000,
      pools: [spyx.pool, tslax.pool],
      leftOut: [],
      slot: 77,
      // the pools, their configs and vaults, their mints, and one listing a pool
      rpcCalls: 5,
    });
  });

  it('leaves a pool out with its reason: dust, a fee switch on, a stock not named, an account not returned', async () => {
    const dynamicOn = new Uint8Array(headOf(tslax));
    dynamicOn[1096] = (dynamicOn[1096] as number) | 16;
    const dust = new Map([
      ...accountsOf(spyx, 100_000n, 500_000_000n),
      ...accountsOf(tslax, 44_327_000_000n, 99_535_000_000n, dynamicOn),
    ]);
    const listed: string[] = [];
    const got = await byrealForCapture(table([s, t]), { only: null }, deps(dust, listed));
    expect(got.pools).toEqual([]);
    expect(got.meta.leftOut).toEqual([
      { pool: spyx.pool, stocks: ['SPYx'], reason: 'under_1000_usd' },
      { pool: tslax.pool, stocks: ['TSLAx'], reason: 'dynamic_fee_on' },
    ]);
    // a pool that is left out is not listed: no call is spent on it
    expect(listed).toEqual([]);

    const whole = new Map([
      ...accountsOf(spyx, 16_172_000_000n, 192_775_000_000n),
      ...accountsOf(tslax, 44_327_000_000n, 99_535_000_000n),
    ]);
    const only = await byrealForCapture(table([s, t]), { only: new Set(['TSLAx']) }, deps(whole));
    expect(only.pools.map((p) => p.assetSymbol)).toEqual(['TSLAx']);
    expect(only.meta.leftOut).toEqual([
      { pool: spyx.pool, stocks: ['SPYx'], reason: 'stock_not_named_by_only' },
    ]);

    whole.set(spyx.pool, null);
    whole.delete(decodeClmmPool(headOf(tslax)).vault0);
    const gone = await byrealForCapture(table([s, t]), { only: null }, deps(whole));
    expect(gone.meta.leftOut.map((l) => l.reason)).toEqual([
      'not_returned_as_a_pool',
      'vaults_not_returned',
    ]);
  });
});

describe('the router', () => {
  // the capture of 2026-10-06T21:21Z (fixtures/risk/route) with the frozen SPYx pool of Byreal added to it, as
  // `pnpm risk:split-capture --byreal` adds one: a row in `direct`, its accounts, and the `byreal` key
  const base = loadCapture('fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz');
  const head = quoteOf(spyx, 'sell', 1000).head;
  const row: RegPool = {
    address: spyx.pool,
    venue: 'byreal_clmm',
    assetMint: SPYX,
    assetIsToken0: true,
    transferFeeBps0: 0,
    transferFeeBps1: 0,
    assetSymbol: 'SPYx',
    quoteMint: USDC,
    quoteSymbol: 'USDC',
    exitPath: 'direct_usd',
    tier: 'not_in_registry',
    tvlUsd: 318_793,
    decimals0: 8,
    decimals1: 6,
    vault0: decodeClmmPool(b(head)).vault0,
    vault1: decodeClmmPool(b(head)).vault1,
  };
  const withByreal: SplitCapture = {
    ...base,
    direct: [...base.direct, row],
    children: { ...base.children, [spyx.pool]: Object.keys(spyx.children).sort() },
    accounts: {
      ...base.accounts,
      [spyx.pool]: head,
      [spyx.config.address]: spyx.config.data,
      ...spyx.children,
    },
    byreal: {
      table: {
        file: 'table.json',
        fetchedAt: '2026-10-07T13:52:58.647Z',
        method: 'byreal-pools-0.1',
      },
      minUsd: 1000,
      pools: [spyx.pool],
      leftOut: [],
      slot: 1,
      rpcCalls: 4,
      source: 'test',
    },
  };
  const poolsOf = (c: SplitCapture, opts?: { byreal?: boolean }) =>
    (buildSplit(c, opts).byAsset.get(SPYX)?.pools ?? []).map((p) => p.pool);

  it('a capture that holds Byreal’s pools routes what it routed without them, unless asked', () => {
    const plain = buildSplit(base);
    const off = buildSplit(withByreal);
    expect(poolsOf(withByreal)).toEqual(poolsOf(base));
    expect(off.failures).toEqual(plain.failures);
    expect(JSON.stringify(oneHopRows(off, withByreal).rows)).toBe(
      JSON.stringify(oneHopRows(plain, base).rows),
    );
    // seen without Byreal it is the capture it was, key for key
    expect(withoutByreal(withByreal)).toEqual(base);
    expect(withoutByreal(base)).toBe(base);
  });

  it('asked for, the pool is routed as a dollar pool of its stock: it takes part of a $100,000 trade', () => {
    const on = buildSplit(withByreal, { byreal: true });
    expect(on.failures).toEqual(buildSplit(base).failures);
    expect(poolsOf(withByreal, { byreal: true })).toEqual([...poolsOf(base), spyx.pool]);
    const pools = on.byAsset.get(SPYX)?.pools ?? [];
    const without = buildSplit(base).byAsset.get(SPYX)?.pools ?? [];
    const mine = pools.find((p) => p.pool === spyx.pool);
    expect(mine?.feeRate).toBe(0.00008);
    expect(mine?.quoteUsd).toBe(1);
    // The pool was frozen a day after the capture, at another price: it is the dearer place to sell or the cheaper
    // one to buy, or the reverse. On the side where it is the better one it takes chunks and the route returns more;
    // on neither side does the route return less, and the reference pool stays the registry's largest.
    let used = 0;
    for (const side of ['sell', 'buy'] as const) {
      const before = routeTrade(without, 100_000, side);
      const after = routeTrade(pools, 100_000, side);
      expect(after.refPool).toBe(before.refPool);
      expect(after.outUsd).toBeGreaterThanOrEqual(before.outUsd);
      if (after.legs.some((l) => l.pool === spyx.pool)) {
        used++;
        expect(after.outUsd).toBeGreaterThan(before.outUsd);
      } else expect(after.outUsd).toBe(before.outUsd);
    }
    expect(used).toBeGreaterThan(0);
    // the other assets are untouched
    for (const [mint, a] of buildSplit(base).byAsset)
      if (mint !== SPYX)
        expect(on.byAsset.get(mint)?.pools.map((p) => p.pool)).toEqual(a.pools.map((p) => p.pool));
  });

  it('a Byreal pool that does not add up, or whose fee is not its own to give, is named and routed nowhere', () => {
    const [firstKid] = Object.keys(spyx.children).filter(
      (k) => hex8(b(spyx.children[k] as string)) === BYREAL_DYN_TICK_ARRAY_DISC,
    ) as [string];
    // one array listed and not read
    const holed = { ...withByreal, accounts: { ...withByreal.accounts, [firstKid]: null } };
    const h = buildSplit(holed, { byreal: true });
    expect(poolsOf(holed, { byreal: true })).toEqual(poolsOf(base));
    expect(h.failures.filter((f) => f.startsWith(spyx.pool))).toHaveLength(1);
    expect(h.failures.find((f) => f.startsWith(spyx.pool))).toMatch(
      /1 of 49 tick or bin arrays not read/,
    );
    // one array neither listed nor read: the pool's own bitmap names it
    const unlisted = {
      ...withByreal,
      children: {
        ...withByreal.children,
        [spyx.pool]: (withByreal.children[spyx.pool] ?? []).filter((k) => k !== firstKid),
      },
    };
    const u = buildSplit(unlisted, { byreal: true });
    expect(poolsOf(unlisted, { byreal: true })).toEqual(poolsOf(base));
    expect(u.failures.find((f) => f.startsWith(spyx.pool))).toMatch(/byreal arrays check/);
    // the dynamic fee switched on
    const d = b(head);
    d[1096] = (d[1096] as number) | 16;
    const dyn = {
      ...withByreal,
      accounts: { ...withByreal.accounts, [spyx.pool]: Buffer.from(d).toString('base64') },
    };
    const f = buildSplit(dyn, { byreal: true });
    expect(poolsOf(dyn, { byreal: true })).toEqual(poolsOf(base));
    expect(f.failures.find((x) => x.startsWith(spyx.pool))).toMatch(/dynamic_fee_on/);
    // no fee config read
    const noCfg = {
      ...withByreal,
      accounts: { ...withByreal.accounts, [spyx.config.address]: null },
    };
    expect(
      buildSplit(noCfg, { byreal: true }).failures.find((x) => x.startsWith(spyx.pool)),
    ).toMatch(/no fee config/);
  });

  it('`--byreal` is a flag of the router’s report, off unless given', () => {
    expect(parseRouterArgs(['--router', 'caps'])).toEqual({
      paths: ['caps'],
      quotesFile: null,
      chunks: 32,
    });
    expect(parseRouterArgs(['--router', 'caps', '--byreal', '--chunks', '16'])).toEqual({
      paths: ['caps'],
      quotesFile: null,
      chunks: 16,
      byreal: true,
    });
  });
});

describe('the verdict', () => {
  const file = (quoted: ByrealValidatedPool[], holds = true): ByrealValidationFile => ({
    method: 'byreal-validate-0.1',
    source: 'test',
    fetchedAt: spyx.fetchedAt,
    provenance: 'live',
    program: 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',
    table: { file: 'table.json', fetchedAt: 'x' },
    tolerance: BYREAL_QUOTE_TOLERANCE,
    invariant: [
      {
        ...byrealInvariantRow(
          spyx.pool,
          ['SPYx'],
          b(quoteOf(spyx, 'sell', 1000).head),
          kids(spyx),
          {
            pool: 1,
            arrays: 2,
          },
        ),
        holds,
      },
    ],
    invariantFirstReads: [],
    quoted,
    jupiterQuotes: 0,
    rpc: { calls: 0, retries429: 0, errors: 0, seconds: 0 },
  });
  const whole = (p: Frozen): ByrealValidatedPool => ({ ...p, retaken: [] });

  it('counts a quote only when it is of one state, and names what was not compared and why', () => {
    const v = byrealVerdict(file([whole(spyx), whole(tslax)]));
    expect(v.invariant).toEqual({ pools: 1, hold: 1, failed: [] });
    expect(v.quotes.compared).toBe(11);
    expect(v.quotes.within).toBe(11);
    expect(v.quotes.outside).toEqual([]);
    expect(v.quotes.maxAbsRelDiff).toBeLessThanOrEqual(BYREAL_QUOTE_TOLERANCE);
    expect(v.quotes.poolsWithAllSixWithin).toEqual([spyx.pool]);
    expect(v.quotes.notCompared).toEqual([
      { pool: tslax.pool, side: 'sell', usd: 100_000, why: 'HTTP 400: NO_ROUTES_FOUND' },
    ]);
    expect(v.everyComparisonWithin).toBe(true);
    // one pool with all six, where three were asked for
    expect(v.threePoolsWithAllSix).toBe(false);
  });

  it('a quote outside the tolerance, a pool that moved and a check that fails are each named with their number', () => {
    const moved = whole(spyx);
    moved.quotes = moved.quotes.map((q, i) =>
      i === 0 ? { ...q, sameState: false } : i === 1 ? { ...q, relDiff: 3e-8 } : q,
    );
    const v = byrealVerdict(file([moved], false));
    expect(v.invariant.failed).toHaveLength(1);
    expect(v.invariant.failed[0]?.why).toMatch(/stored/);
    expect(v.quotes.outside).toEqual([
      { pool: spyx.pool, side: 'sell', usd: 10_000, relDiff: 3e-8 },
    ]);
    expect(v.quotes.notCompared[0]?.why).toMatch(/the pool changed between the read before/);
    expect(v.quotes.poolsWithAllSixWithin).toEqual([]);
    expect(v.everyComparisonWithin).toBe(false);
  });
});
