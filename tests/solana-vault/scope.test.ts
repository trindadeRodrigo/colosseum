import {
  type ClusterClock,
  decodeClock,
  decodeScopeEntry,
  isScopeEntrySet,
  marketAt,
  readScopeAccount,
  SCOPE_ENTRIES,
  SCOPE_ENTRY_BYTES,
  SCOPE_HEADER_BYTES,
  SCOPE_PRICES_BYTES,
  scopeIndex,
  scopePrice,
} from '@colosseum/chain-solana/src/vault';
import { ChainError } from '@colosseum/schemas';
import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { accountOf, loadFixture, type MintName } from './world';

// Scope's price account layout, on the hand-written account of the fixture. The same code read the
// real account on mainnet once by hand (docs/vault/STATE-VAULT.md, row ADS-1).

const fixture = loadFixture();
const price = accountOf(fixture, 'price');
const clock = decodeClock(accountOf(fixture, 'clock'));
const owner = fixture.prices.owner as Address;

function refusal(work: () => unknown): ChainError {
  try {
    work();
  } catch (e) {
    if (e instanceof ChainError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe("Scope's price account layout", () => {
  it('is 28,712 bytes: a 40-byte header and 512 entries of 56', () => {
    expect([SCOPE_HEADER_BYTES, SCOPE_ENTRY_BYTES, SCOPE_ENTRIES, SCOPE_PRICES_BYTES]).toEqual([
      40, 56, 512, 28_712,
    ]);
    expect(price.data.length).toBe(SCOPE_PRICES_BYTES);
  });

  it.each(Object.keys(fixture.prices.entries) as MintName[])(
    'reads the entry of "%s": the price as an exact decimal, and its age from the cluster clock',
    (name) => {
      const want = fixture.prices.entries[name];
      const entry = decodeScopeEntry(price.data, want.index);
      expect(isScopeEntrySet(entry)).toBe(true);
      expect(scopePrice(entry)).toBe(want.usdPerToken);
      expect(clock.unixTimestamp - entry.unixTimestamp).toBe(BigInt(want.ageSeconds));
      expect(entry.slot).toBe(clock.slot);
      const [reading] = readScopeAccount(price, owner, [want.index], clock);
      expect(reading).toEqual({
        index: want.index,
        usdPerToken: want.usdPerToken,
        ageSeconds: want.ageSeconds,
        updatedAt: Number(clock.unixTimestamp) - want.ageSeconds,
      });
    },
  );

  it('keeps every digit of a price: no float in between', () => {
    const data = new Uint8Array(SCOPE_PRICES_BYTES);
    const view = new DataView(data.buffer);
    const at = SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * 511;
    view.setBigUint64(at, 773_620_782_636_193_733n, true);
    view.setBigUint64(at + 8, 15n, true);
    view.setBigUint64(at + 24, 1n, true);
    expect(scopePrice(decodeScopeEntry(data, 511))).toBe('773.620782636193733');
  });

  it('refuses an index outside the account, and data of another size', () => {
    expect(() => decodeScopeEntry(price.data, SCOPE_ENTRIES)).toThrow(/0 to 511/);
    expect(() => decodeScopeEntry(price.data, -1)).toThrow(/0 to 511/);
    expect(() => decodeScopeEntry(price.data, 1.5)).toThrow(/0 to 511/);
    expect(() => decodeScopeEntry(price.data.subarray(0, 28_711), 0)).toThrow(/not a Scope/);
  });

  it('reads a priceRef as an index, and nothing else', () => {
    expect(['0', '13', '344', '511'].map(scopeIndex)).toEqual([0, 13, 344, 511]);
    for (const bad of ['', '512', '-1', '01', '1.0', 'mock:spy', '0x10', ' 7'])
      expect(scopeIndex(bad)).toBeNull();
  });
});

describe('reading prices out of the account: refusals, never a made-up figure', () => {
  const index = fixture.prices.entries.spyx.index;

  it('refuses an account that is not owned by the price program', () => {
    const stolen = { ...price, owner: fixture.names.program as Address };
    const e = refusal(() => readScopeAccount(stolen, owner, [index], clock));
    expect(e.code).toBe('AssetNotPriced');
    expect(e.message).toMatch(/not by the price program/);
  });

  it("refuses a missing account, and one that is not the size of Scope's", () => {
    expect(refusal(() => readScopeAccount(null, owner, [index], clock)).code).toBe(
      'AssetNotPriced',
    );
    const short = { ...price, data: price.data.subarray(0, 1_000) };
    expect(refusal(() => readScopeAccount(short, owner, [index], clock)).message).toMatch(/layout/);
  });

  it('refuses an entry nobody wrote', () => {
    const empty = decodeScopeEntry(price.data, fixture.prices.emptyIndex);
    expect(isScopeEntrySet(empty)).toBe(false);
    expect(() => scopePrice(empty)).toThrow(/no price/);
    const e = refusal(() =>
      readScopeAccount(price, owner, [index, fixture.prices.emptyIndex], clock),
    );
    expect(e.code).toBe('AssetNotPriced');
    expect(e.message).toContain(`entry ${fixture.prices.emptyIndex}`);
  });

  it('reports an entry stamped ahead of the clock as zero seconds old, not as a negative age', () => {
    const behind: ClusterClock = { slot: clock.slot, unixTimestamp: clock.unixTimestamp - 1_000n };
    expect(readScopeAccount(price, owner, [index], behind)[0]?.ageSeconds).toBe(0);
  });
});

describe("whether the market for an asset is open, from the program's Config", () => {
  // DEFAULT_PARAMS: 14:30 to 20:00 UTC.
  const config = {
    sessionOpenUtcS: 52_200,
    sessionCloseUtcS: 72_000,
    closedUntil: 0n,
    closedDays: Array.from({ length: 32 }, () => 0),
  };
  const at = (iso: string): ClusterClock => ({
    slot: 0n,
    unixTimestamp: BigInt(Date.parse(iso) / 1000),
  });

  it('is open Monday to Friday inside the session, and closed at its edges', () => {
    expect(marketAt('us_equity', config, at('2026-10-05T15:00:00Z'))).toBe('open');
    expect(marketAt('us_equity', config, at('2026-10-05T14:30:00Z'))).toBe('open');
    expect(marketAt('us_equity', config, at('2026-10-05T14:29:59Z'))).toBe('closed');
    expect(marketAt('us_equity', config, at('2026-10-05T19:59:59Z'))).toBe('open');
    expect(marketAt('us_equity', config, at('2026-10-05T20:00:00Z'))).toBe('closed');
    expect(marketAt('us_equity', config, at('2026-10-09T15:00:00Z'))).toBe('open');
  });

  it('is closed at the weekend', () => {
    expect(marketAt('us_equity', config, at('2026-10-03T15:00:00Z'))).toBe('closed');
    expect(marketAt('us_equity', config, at('2026-10-04T15:00:00Z'))).toBe('closed');
  });

  it('is closed on a listed day, and until `closed_until` has passed', () => {
    const monday = at('2026-10-05T15:00:00Z');
    const day = Number(monday.unixTimestamp / 86_400n);
    const holiday = { ...config, closedDays: [0, day, ...config.closedDays.slice(2)] };
    expect(marketAt('us_equity', holiday, monday)).toBe('closed');
    expect(marketAt('us_equity', holiday, at('2026-10-06T15:00:00Z'))).toBe('open');
    const halted = { ...config, closedUntil: monday.unixTimestamp + 1n };
    expect(marketAt('us_equity', halted, monday)).toBe('closed');
    expect(marketAt('us_equity', { ...halted, closedUntil: monday.unixTimestamp }, monday)).toBe(
      'open',
    );
  });

  it('never closes an asset that trades at all hours', () => {
    expect(marketAt('always', config, at('2026-10-03T03:00:00Z'))).toBe('open');
  });
});
