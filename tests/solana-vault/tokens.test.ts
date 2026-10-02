import { displayAmount as contractDisplay } from '@colosseum/chain-mock';
import {
  associatedTokenAddress,
  decodeMint,
  decodeTokenAccount,
  displayAmount,
  multiplierAt,
  multiplierString,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from '@colosseum/chain-solana/src/vault';
import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { accountOf, loadFixture, type MintName } from './world';

// Mints and token accounts of both token programs, from bytes the two programs wrote in LiteSVM.

const fixture = loadFixture();
const { names, expected } = fixture;
const now = BigInt(fixture.clock.unixTimestamp);
const programOf = { token: TOKEN_PROGRAM, 'token-2022': TOKEN_2022_PROGRAM } as const;

describe('mints of both token programs', () => {
  it.each(Object.keys(expected.mints) as MintName[])(
    'decodes "%s": its program, its decimals and its multiplier',
    (name) => {
      const want = expected.mints[name];
      const account = accountOf(fixture, `mint:${name}`);
      expect(account.owner).toBe(programOf[want.tokenProgram]);
      const mint = decodeMint(account.owner, account.data);
      expect(mint.tokenProgram).toBe(programOf[want.tokenProgram]);
      expect(mint.decimals).toBe(want.decimals);
      expect(multiplierAt(mint, now)).toBe(want.multiplier ?? 1);
      if (want.multiplier === null) expect(mint.scaledUiAmount).toBeNull();
      if (want.scheduled) {
        const at = BigInt(want.scheduled.effectiveAt);
        expect(mint.scaledUiAmount?.newMultiplierEffectiveAt).toBe(at);
        // The scheduled multiplier applies from its time on, and not a second before.
        expect(multiplierAt(mint, at - 1n)).toBe(want.multiplier);
        expect(multiplierAt(mint, at)).toBe(want.scheduled.multiplier);
      }
    },
  );

  it('covers a classic mint, a stock token with a multiplier, and one with a multiplier scheduled', () => {
    const kinds = Object.values(expected.mints).map(
      (m) =>
        `${m.tokenProgram}:${m.multiplier === null ? 'plain' : m.scheduled ? 'scheduled' : 'scaled'}`,
    );
    expect(new Set(kinds)).toEqual(
      new Set(['token:plain', 'token-2022:scaled', 'token-2022:scheduled']),
    );
  });

  it('refuses bytes that are not a mint', () => {
    const mint = accountOf(fixture, 'mint:usdc');
    const token = accountOf(fixture, 'token:owner/usdc');
    const stock = accountOf(fixture, 'token:owner/spyx');
    expect(() => decodeMint(TOKEN_PROGRAM, token.data)).toThrow(/not a mint/);
    // A Token-2022 token account is longer than 165 bytes too, but it is typed as an account.
    expect(() => decodeMint(TOKEN_2022_PROGRAM, stock.data)).toThrow(/not a mint/);
    expect(() => decodeMint(names.program as Address, mint.data)).toThrow(/token program/);
    expect(() => decodeMint(TOKEN_PROGRAM, new Uint8Array(82))).toThrow(/not initialised/);
  });
});

describe('token accounts of both token programs', () => {
  const tokens = fixture.accounts.filter((a) => a.role.startsWith('token:'));

  it('has token accounts under both programs to read', () => {
    expect(new Set(tokens.map((a) => a.owner))).toEqual(
      new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]),
    );
  });

  it.each(tokens.map((a) => a.role))(
    'decodes %s and finds it at its associated address',
    async (role) => {
      const [holder, mintName] = role.slice('token:'.length).split('/') as [string, MintName];
      const who =
        holder === 'owner' || holder === 'other'
          ? names[holder]
          : names.vaults[holder as keyof typeof names.vaults];
      const want =
        holder === 'owner' || holder === 'other'
          ? expected.wallets[holder][mintName]
          : expected.vaults[holder as keyof typeof expected.vaults].held[mintName];
      const account = accountOf(fixture, role);
      const token = decodeTokenAccount(account.data);
      expect(token).toEqual({
        mint: names.mints[mintName],
        owner: who,
        amount: BigInt(want ?? '-1'),
      });
      expect(await associatedTokenAddress(who as Address, token.mint, account.owner)).toBe(
        account.address,
      );
    },
  );

  it('gives a different address under the other token program', async () => {
    const [holder, mint] = [names.vaults.following as Address, names.mints.spyx as Address];
    expect(await associatedTokenAddress(holder, mint, TOKEN_PROGRAM)).not.toBe(
      await associatedTokenAddress(holder, mint, TOKEN_2022_PROGRAM),
    );
  });

  it('refuses bytes that are not a token account', () => {
    expect(() => decodeTokenAccount(accountOf(fixture, 'mint:usdc').data)).toThrow(/not a token/);
    expect(() => decodeTokenAccount(new Uint8Array(165))).toThrow(/not initialised/);
  });
});

describe('amounts', () => {
  it('shows raw × multiplier / 10^decimals, exactly: the contract vector of DESIGN-VAULT 3.1', () => {
    expect(displayAmount(250_000_000n, '1.02', 8)).toBe('2.55');
    expect(displayAmount(0n, '1.003909', 8)).toBe('0');
    expect(displayAmount(1n, '1', 6)).toBe('0.000001');
    expect(displayAmount(230_000_000n, '1.003909', 8)).toBe('2.3089907');
  });

  it('agrees with the function the adapter contract checks against', () => {
    for (const [raw, multiplier, decimals] of [
      ['230000000', '1.003909', 8],
      ['18446744073709551615', '1.005714560286254', 8],
      ['1000000000', '1', 6],
      ['7', '2.5', 0],
    ] as const)
      expect(displayAmount(BigInt(raw), multiplier, decimals)).toBe(
        contractDisplay(raw, multiplier, decimals),
      );
  });

  it('writes a stored multiplier as a plain decimal, or refuses it', () => {
    expect(multiplierString(1)).toBe('1');
    expect(multiplierString(1.003909)).toBe('1.003909');
    expect(multiplierString(1.005714560286254)).toBe('1.005714560286254');
    expect(multiplierString(1e-7)).toBe('0.0000001');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e30, 1e-30])
      expect(() => multiplierString(bad)).toThrow();
  });
});
