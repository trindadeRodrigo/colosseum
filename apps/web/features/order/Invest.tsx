'use client';
import type { ChainId } from '@colosseum/schemas';
import { AddMoneyScreen } from '../portfolio/AddMoneyScreen';
import { FamilyBuyScreen } from '../shared/FamilyBuyScreen';
import { BuyScreen } from './BuyScreen';
import type { InvestEmbedded } from './InvestCard';

// Investing, for a screen that has its own amount and its own layout (gate INVEST-ONE-PRESS): what is
// bought and the amount go in, and the card comes back with one press. What it is told: `onProgress`
// as the person presses and at each step, `onDone` with the vault's address once every step is
// confirmed, `onStopped` with the order's id when the sequence stops short (the order's own page,
// /orders/{id}, has the rest: finish the buy, try again). It is the same card, and the same checks,
// as the pages that buy a plan, buy a shared portfolio and add money to a vault.

export type InvestOf =
  /** A plan, by its id. */
  | { plan: string }
  /** A shared portfolio, by its slug: the buy opens a vault that follows it. */
  | { family: string }
  /** A vault of the person's own, which the amount is added to. */
  | { vault: { chain: ChainId; address: string } };

export type InvestProps = InvestEmbedded & { of: InvestOf };

export function Invest({ of, ...embedded }: InvestProps) {
  if ('plan' in of) return <BuyScreen id={of.plan} embedded={embedded} />;
  if ('family' in of) return <FamilyBuyScreen slug={of.family} embedded={embedded} />;
  return <AddMoneyScreen chain={of.vault.chain} address={of.vault.address} embedded={embedded} />;
}
