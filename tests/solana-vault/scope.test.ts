import { createHash } from 'node:crypto';
import {
  type ClusterClock,
  DEFAULT_MAX_AHEAD_SECONDS,
  decodeClock,
  decodeScopeEntry,
  isScopeEntrySet,
  marketAt,
  readScopeAccount,
  SCOPE_ENTRIES,
  SCOPE_ENTRY_BYTES,
  SCOPE_HEADER_BYTES,
  SCOPE_PRICES_BYTES,
  SCOPE_PRICES_DISCRIMINATOR,
  scopeIndex,
  scopePrice,
} from '@colosseum/chain-solana/vault';
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
      const [reading] = readScopeAccount(price, owner, [{ index: want.index }], clock);
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
    const e = refusal(() => readScopeAccount(stolen, owner, [{ index }], clock));
    expect(e.code).toBe('AssetNotPriced');
    expect(e.message).toMatch(/not by the price program/);
  });

  it("refuses a missing account, and one that is not the size of Scope's", () => {
    expect(refusal(() => readScopeAccount(null, owner, [{ index }], clock)).code).toBe(
      'AssetNotPriced',
    );
    const short = { ...price, data: price.data.subarray(0, 1_000) };
    expect(refusal(() => readScopeAccount(short, owner, [{ index }], clock)).message).toMatch(
      /layout/,
    );
  });

  it('refuses an entry nobody wrote, and names the asset it was read for', () => {
    const empty = decodeScopeEntry(price.data, fixture.prices.emptyIndex);
    expect(isScopeEntrySet(empty)).toBe(false);
    expect(() => scopePrice(empty)).toThrow(/no price/);
    const e = refusal(() =>
      readScopeAccount(
        price,
        owner,
        [{ index }, { index: fixture.prices.emptyIndex, asset: 'solana:tslax' }],
        clock,
      ),
    );
    expect(e.code).toBe('AssetNotPriced');
    expect(e.message).toContain(`entry ${fixture.prices.emptyIndex}`);
    expect(e.message).toContain('solana:tslax');
  });

  it('refuses an entry with a value and no time, or no value, or an exponent no price has', () => {
    const at = SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * index;
    const edited = (offset: number, value: bigint) => {
      const data = new Uint8Array(price.data);
      new DataView(data.buffer).setBigUint64(at + offset, value, true);
      return { ...price, data };
    };
    // Without the check on the time, this entry would read as a price fifty-six years old.
    const noTime = edited(24, 0n);
    expect(decodeScopeEntry(noTime.data, index).value).toBeGreaterThan(0n);
    expect(isScopeEntrySet(decodeScopeEntry(noTime.data, index))).toBe(false);
    expect(refusal(() => readScopeAccount(noTime, owner, [{ index }], clock)).message).toMatch(
      /holds no price/,
    );
    expect(isScopeEntrySet(decodeScopeEntry(edited(0, 0n).data, index))).toBe(false);
    expect(isScopeEntrySet(decodeScopeEntry(edited(8, 31n).data, index))).toBe(false);
    expect(isScopeEntrySet(decodeScopeEntry(edited(8, 30n).data, index))).toBe(true);
  });

  it('takes an entry a little ahead of the clock as fresh, and refuses one far ahead', () => {
    const behind = (seconds: bigint): ClusterClock => ({
      slot: clock.slot,
      unixTimestamp: clock.unixTimestamp - seconds,
    });
    const age = BigInt(fixture.prices.entries.spyx.ageSeconds);
    // Clocks differ by seconds: up to the bound, the age is zero and never negative.
    const bound = BigInt(DEFAULT_MAX_AHEAD_SECONDS);
    expect(readScopeAccount(price, owner, [{ index }], behind(age + bound))[0]?.ageSeconds).toBe(0);
    const e = refusal(() => readScopeAccount(price, owner, [{ index }], behind(age + bound + 1n)));
    expect(e.code).toBe('AssetNotPriced');
    expect(e.message).toMatch(/121 s ahead/);
    // The caller's own bound, as the reader passes Config's.
    const tight = { maxAheadSeconds: 5 };
    expect(readScopeAccount(price, owner, [{ index }], behind(age + 5n), tight)).toHaveLength(1);
    refusal(() => readScopeAccount(price, owner, [{ index }], behind(age + 6n), tight));
  });

  it('refuses an entry stamped in milliseconds: it is not fresh for ever', () => {
    const data = new Uint8Array(price.data);
    const threeDaysAgo = (clock.unixTimestamp - 259_200n) * 1000n;
    new DataView(data.buffer).setBigUint64(
      SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * index + 24,
      threeDaysAgo,
      true,
    );
    const e = refusal(() => readScopeAccount({ ...price, data }, owner, [{ index }], clock));
    expect(e.message).toMatch(/ahead of the cluster's clock/);
  });

  it("checks the account's first eight bytes when it is told what they are", () => {
    expect(SCOPE_PRICES_DISCRIMINATOR).toEqual(
      new Uint8Array(createHash('sha256').update('account:OraclePrices').digest().subarray(0, 8)),
    );
    const checks = { maxAheadSeconds: 120, discriminator: SCOPE_PRICES_DISCRIMINATOR };
    expect(readScopeAccount(price, owner, [{ index }], clock, checks)).toHaveLength(1);
    const data = new Uint8Array(price.data);
    data[7] = (data[7] ?? 0) ^ 1;
    const other = { ...price, data };
    expect(
      refusal(() => readScopeAccount(other, owner, [{ index }], clock, checks)).message,
    ).toMatch(/discriminator/);
    // Not told, not checked.
    expect(readScopeAccount(other, owner, [{ index }], clock)).toHaveLength(1);
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

  it('is never open in a session that wraps past midnight or has no length', () => {
    const wraps = { ...config, sessionOpenUtcS: 79_200, sessionCloseUtcS: 7_200 };
    expect(marketAt('us_equity', wraps, at('2026-10-05T23:00:00Z'))).toBe('closed');
    expect(marketAt('us_equity', wraps, at('2026-10-06T01:00:00Z'))).toBe('closed');
    const empty = { ...config, sessionCloseUtcS: config.sessionOpenUtcS };
    expect(marketAt('us_equity', empty, at('2026-10-05T14:30:00Z'))).toBe('closed');
  });

  it('never closes an asset that trades at all hours', () => {
    expect(marketAt('always', config, at('2026-10-03T03:00:00Z'))).toBe('open');
  });
});
