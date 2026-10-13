import { describe, expect, it } from 'vitest';
import { ERR, readVault } from './src/basket';
import { expectError, expectOk } from './src/env';
import { createKeeperWorld, type KeeperWorld, keeperLeg } from './src/keeper';
import { swapThroughExchange } from './src/swap';
import { balance, mintExtensionEntries, paxgExtensions } from './src/tokens';

// PAXG, Solana's gold (gate GOLD-PAXG), is a Token-2022 mint with a set of extensions none of the
// stock tokens carry: a transfer fee its issuer may raise, a close authority, and the fee's
// confidential twin. The vault program keeps no list of extensions it allows: it refuses a hook
// program and trades around a multiplier change, and counts every trade by what its token
// accounts hold before and after. So a fee, if Paxos ever charges one, arrives as a worse fill:
// inside the tolerance it is a loss the counter keeps, past it the leg is refused. The owner's
// own trade takes what arrives. The stock token here carries PAXG's set at the stock's 8
// decimals, so the exchange's rate of 500 dollars a token is the other tests'.

/** One dollar of the 6-decimal cash token. */
const USD = 1_000000n;
/** PAXG's extension types on mainnet, in its order: close authority, permanent delegate,
 * transfer fee, confidential transfers and their fee, a hook with no program, a metadata pointer. */
const PAXG_TYPES = [3, 12, 1, 4, 16, 14, 18];

const world = (feeBps: number) =>
  createKeeperWorld(undefined, (issuer, mint) => paxgExtensions(issuer, mint, feeBps));

const recorded = (w: KeeperWorld) => {
  const state = readVault(w.svm, w.vault);
  return state.positions.slice(0, state.count).find((p) => p.mint === w.stock.address)?.tracked;
};

describe("a token with PAXG's extensions", () => {
  it('is listed and traded by the keeper while its transfer fee is zero', async () => {
    const w = await world(0);
    const mint = w.svm.getAccount(w.stock.address);
    if (!mint.exists) throw new Error('no mint');
    expect(mintExtensionEntries(new Uint8Array(mint.data)).map((e) => e.type)).toEqual(PAXG_TYPES);
    expectOk(await keeperLeg(w, { amountIn: 40n * USD }));
    // 40 dollars at 500 a token, to the raw unit, and nothing lost.
    expect(balance(w.svm, w.vaultStock)).toBe(8_000_000n);
    expect(recorded(w)).toBe(8_000_000n);
    expect(readVault(w.svm, w.vault).lossAccum).toBe(0n);
  });

  it('counts a fee inside the tolerance as a loss, and records what arrived', async () => {
    // 50 bps, under the 75 bps tolerance: 40 dollars buy 0.08 of a token, less 0.0004 withheld.
    const w = await world(50);
    expectOk(await keeperLeg(w, { amountIn: 40n * USD }));
    expect(balance(w.svm, w.vaultStock)).toBe(7_960_000n);
    expect(recorded(w)).toBe(7_960_000n);
    // 20 cents of the 40 dollars.
    expect(readVault(w.svm, w.vault).lossAccum).toBe(200_000n);
  });

  it('refuses a keeper leg whose fee is past the tolerance', async () => {
    const w = await world(100);
    expectError(await keeperLeg(w, { amountIn: 40n * USD }), ERR.ReceivedTooLittle);
    expect(balance(w.svm, w.vaultStock)).toBe(0n);
  });

  it("takes what arrives on the owner's own trade, whatever the fee", async () => {
    const w = await world(100);
    expectOk(await swapThroughExchange(w, { amountIn: 40n * USD }));
    expect(balance(w.svm, w.vaultStock)).toBe(7_920_000n);
    expect(recorded(w)).toBe(7_920_000n);
  });
});
