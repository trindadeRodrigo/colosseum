import { VaultView } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDecimal, parseDecimal } from './amounts';
import { asset, price, vault } from './testing';
import { measureVault, view } from './view';

const USDC = asset('solana:usdc', { decimals: 6, cls: 'cash' });
const SPY = asset('solana:spy', { decimals: 8 });
const NVDA = asset('solana:nvda', { decimals: 8 });
const GOLD = asset('solana:gold', { decimals: 9 });
const ASSETS = [USDC, SPY, NVDA, GOLD];

describe('view', () => {
  it('values a holding as raw × price / 10^decimals, with no multiplier (the design vector)', () => {
    // DESIGN-VAULT 3.1: 8 decimals, raw 250,000,000, multiplier 1.02, price 100: value 250.00.
    const v = vault('750000000', { 'solana:spy': ['250000000', 3000] });
    const spy = v.positions[0];
    if (spy) Object.assign(spy, { multiplier: '1.02', display: '2.55' });
    const seen = view(v, [price('solana:spy', '100')], ASSETS);
    expect(seen.positions[0]).toMatchObject({ valueUsd: '250', weightBps: 2500, driftBps: -500 });
    // $750 of cash at one dollar each, with no price given for it.
    expect(seen.valueUsd).toBe('1000');
    expect(VaultView.parse(seen)).toEqual(seen);
    // Nothing of the vault itself is changed.
    expect({ ...seen, valueUsd: undefined, positions: undefined }).toEqual({
      ...v,
      valueUsd: undefined,
      positions: undefined,
    });
  });

  it('gives weights and drift against the targets', () => {
    // $100 cash; SPY 6 × $100 = $600 (target 50%); NVDA 6 × $50 = $300 (target 30%); gold none (20%).
    const v = vault('100000000', {
      'solana:spy': ['600000000', 5000],
      'solana:nvda': ['600000000', 3000],
      'solana:gold': ['0', 2000],
    });
    const prices = [
      price('solana:spy', '100'),
      price('solana:nvda', '50'),
      price('solana:gold', '200'),
    ];
    const seen = view(v, prices, ASSETS);
    expect(seen.valueUsd).toBe('1000');
    expect(seen.positions.map((p) => [p.valueUsd, p.weightBps, p.driftBps])).toEqual([
      ['600', 6000, 1000],
      ['300', 3000, 0],
      ['0', 0, -2000],
    ]);
  });

  it('uses a price for cash when one is given, and one dollar when not', () => {
    const v = vault('1000000000', { 'solana:spy': ['1000000000', 5000] });
    const spy = price('solana:spy', '100');
    expect(view(v, [spy], ASSETS).valueUsd).toBe('2000');
    const off = view(v, [spy, price('solana:usdc', '0.998')], ASSETS);
    expect(off.valueUsd).toBe('1998');
    // 1000 of 1998 is 50.05%: 5005 bps.
    expect(off.positions[0]?.weightBps).toBe(5005);
  });

  it('shows a position with no price as not valued, never as zero dollars', () => {
    const v = vault('500000000', {
      'solana:spy': ['500000000', 5000],
      'solana:nvda': ['100000000', 3000],
      'solana:doge': ['7', 2000],
    });
    // NVDA has a price of zero, which is no price; doge is not on the list at all.
    const prices = [
      price('solana:spy', '100'),
      price('solana:nvda', '0'),
      price('solana:doge', '1'),
    ];
    const seen = view(v, prices, ASSETS);
    expect(seen.valueUsd).toBe('1000');
    expect(seen.positions.map((p) => [p.valueUsd, p.weightBps, p.driftBps])).toEqual([
      ['500', 5000, 0],
      [null, 0, -3000],
      [null, 0, -2000],
    ]);
    expect(VaultView.parse(seen)).toEqual(seen);
  });

  it('refuses a vault whose cash token is not on the asset list, where it used to leave the cash out', () => {
    // The review of BAS-1: $500 of cash and $500 of SPY read as a vault worth $500, all of it SPY.
    const v = vault('500000000', { 'solana:spy': ['500000000', 5000] });
    expect(() => view(v, [price('solana:spy', '100')], [SPY])).toThrow(/solana:usdc/);
    expect(view(v, [price('solana:spy', '100')], [USDC, SPY]).valueUsd).toBe('1000');
  });

  it('makes the weights add up to exactly 10,000 with the cash, whatever does not divide', () => {
    // Three positions of $1 each and no cash: 3334, 3333, 3333.
    const v = vault('0', {
      'solana:spy': ['1000000', 3334],
      'solana:nvda': ['2000000', 3333],
      'solana:gold': ['5000000', 3333],
    });
    const prices = [
      price('solana:spy', '100'),
      price('solana:nvda', '50'),
      price('solana:gold', '200'),
    ];
    expect(view(v, prices, ASSETS).positions.map((p) => p.weightBps)).toEqual([3334, 3333, 3333]);
  });

  it('views an empty vault as worth nothing, with every weight zero', () => {
    const seen = view(vault('0', { 'solana:spy': ['0', 10_000] }), [], ASSETS);
    expect(seen.valueUsd).toBe('0');
    expect(seen.positions[0]).toMatchObject({ valueUsd: null, weightBps: 0, driftBps: -10_000 });
  });

  it('keeps cents exact where a float would not', () => {
    // 0.1 + 0.2 dollars, and a price with 18 places.
    expect(formatDecimal(parseDecimal('0.1') + parseDecimal('0.2'))).toBe('0.3');
    const v = vault('0', { 'solana:gold': ['123456789012345678', 10_000] });
    const seen = view(v, [price('solana:gold', '1999.123456789012345678')], ASSETS);
    // 123456789.012345678 tokens × 1999.123456789012345678 = 246805362814.4322491585..., cut to six places.
    expect(seen.valueUsd).toBe('246805362814.432249');
  });
});

// ---- properties ----

const DECIMALS = [6, 8, 9, 18];
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `solana:${x}`);
const priceText = fc
  .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 999_999 }))
  .map(([whole, frac]) => `${whole}.${frac.toString().padStart(6, '0')}`);

const vaultWorld = fc
  .record({
    cashRaw: fc.bigInt({ min: 0n, max: 10n ** 13n }),
    cashPrice: fc.option(fc.constantFrom('1', '0.9991', '1.0004'), { nil: null }),
    rows: fc.array(
      fc.record({
        decimals: fc.constantFrom(...DECIMALS),
        // Up to a hundred thousand whole tokens, down to a single raw unit.
        tokens: fc.bigInt({ min: 0n, max: 10n ** 11n }),
        scale: fc.integer({ min: 0, max: 6 }),
        price: fc.option(priceText, { nil: null, freq: 8 }),
        targetBps: fc.integer({ min: 0, max: 10_000 }),
      }),
      { maxLength: 8 },
    ),
  })
  .map((w) => {
    const rows = w.rows.map((r, i) => ({
      ...r,
      id: IDS[i] ?? 'solana:z',
      raw: (r.tokens * 10n ** BigInt(r.decimals)) / 10n ** BigInt(r.scale + 6),
    }));
    return {
      v: vault(
        w.cashRaw.toString(),
        Object.fromEntries(rows.map((r) => [r.id, [r.raw.toString(), r.targetBps]])),
      ),
      prices: [
        ...rows.flatMap((r) => (r.price === null ? [] : [price(r.id, r.price)])),
        ...(w.cashPrice === null ? [] : [price('solana:usdc', w.cashPrice)]),
      ],
      assets: [USDC, ...rows.map((r) => asset(r.id, { decimals: r.decimals }))],
    };
  });

// Generated cases take a second or two alone and several when the machine is busy.
describe('view, on generated vaults', { timeout: 60_000 }, () => {
  it('gives weights that add up to 10,000 with the cash, each within a bp of its true share', () => {
    let valued = 0;
    fc.assert(
      fc.property(vaultWorld, ({ v, prices, assets }) => {
        const seen = view(v, prices, assets);
        expect(VaultView.parse(seen)).toEqual(seen);
        const { cash, positions, total } = measureVault(v, prices, assets);
        const positionBps = seen.positions.reduce((n, p) => n + p.weightBps, 0);
        if (total === 0n) {
          expect(positionBps).toBe(0);
          return;
        }
        valued += 1;
        // What the positions leave of 10,000 is the cash, within a bp of its true share.
        const cashBps = BigInt(10_000 - positionBps);
        const within = (bps: bigint, value: bigint) => {
          const gap = bps * total - value * 10_000n;
          return (gap < 0n ? -gap : gap) < total;
        };
        expect(cashBps >= 0n && within(cashBps, cash.value ?? 0n)).toBe(true);
        seen.positions.forEach((p, i) => {
          const value = positions[i]?.value ?? null;
          expect(p.valueUsd === null).toBe(value === null);
          expect(within(BigInt(p.weightBps), value ?? 0n)).toBe(true);
          expect(p.driftBps).toBe(p.weightBps - p.targetBps);
          if (value !== null) expect(parseDecimal(p.valueUsd ?? '0') <= value).toBe(true);
        });
        // The dollar total is the sum of the parts, cut to six places.
        expect(seen.valueUsd).toBe(formatDecimal(total));
      }),
      { numRuns: 2000 },
    );
    expect(valued).toBeGreaterThan(1500);
  });
});
