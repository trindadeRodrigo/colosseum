import type { BasketCard, BasketLine, Reason, Shelf } from '@colosseum/schemas';
import { cardOf } from './card';
import { split, toUsd } from './money';
import { eligibleForGoal } from './registry';
import { reason } from './templates';
import type { ComposeContext, PersonalObservation, PersonalSheet } from './types';
import { buildWorld } from './world';

// A mix whose weights were chosen outside the engine: proposed by the model in the conversation and
// confirmed by the person, or chosen by the person (gate ANY-COMPOSITION, Thom, Oct 8). The engine
// chooses and changes no weight here. It splits the amount by the weights to the cent and states, from
// the same world `compose` reads, what the plan's card says, how much each asset's exit allows, and
// whether the asset list puts each asset in a plan for the goal. Whoever calls it decides what a
// figure over a ceiling means: for this mix, a warning the person confirms, never a refusal.

export type FixedPick = { assetId: string; weightBps: number };

export type FixedLine = {
  line: BasketLine;
  /** Null for the chain's cash token, which has no ceiling. */
  ceiling: { usd: number; measured: boolean; why: Reason } | null;
  /** The asset list puts the asset in a plan for the sheet's goal (gate PROTECT-NO-STOCKS). */
  forGoal: boolean;
};

export type FixedMix = {
  lines: FixedLine[];
  card: BasketCard;
  flags: string[];
  /** The figures the card and the ceilings stand on, as `compose` records them. */
  observations: PersonalObservation[];
};

/**
 * The plan of a fixed mix on the sheet's one chain. Each pick is an asset of that chain's shelf, once,
 * and the weights add up to 10,000; the caller checks that against the chain itself before this is
 * called, and anything else throws. Cash is the chain's dollar token, a line like any other here.
 */
export function fixedMix(
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
  picks: readonly FixedPick[],
  origin: 'model' | 'person',
): FixedMix {
  const w = buildWorld(sheet, shelf, context);
  const total = picks.reduce((n, p) => n + p.weightBps, 0);
  if (total !== 10_000 || new Set(picks.map((p) => p.assetId)).size !== picks.length)
    throw new Error('a fixed mix names each asset once, and its weights add up to 10,000');
  const cents = split(
    w.amount,
    picks.map((p) => p.weightBps),
  );
  const lines = picks.map((pick, i): FixedLine => {
    const asset = w.byId.get(pick.assetId);
    if (!asset || asset.chain !== w.chain) throw new Error(`${pick.assetId} is not on the shelf`);
    const amountUsd = toUsd(cents[i] ?? 0);
    const said = reason(
      origin === 'model' ? 'MIX_FROM_MODEL' : 'MIX_FROM_PERSON',
      { asset: asset.symbol, weightBps: pick.weightBps },
      w.lang,
    );
    const cash = asset.id === w.cash.id;
    return {
      line: {
        chain: w.chain,
        assetId: asset.id,
        weightBps: pick.weightBps,
        amountUsd,
        reasons: cash ? [said] : [said, ...w.ceilingNotes(asset)],
      },
      ceiling: cash
        ? null
        : {
            usd: toUsd(w.ceilingOf(asset)),
            measured: w.measuredUsdOf(asset) !== null,
            why: w.ceilingWhy(asset),
          },
      forGoal: cash || eligibleForGoal(asset, w.sheet.goal),
    };
  });
  const { card } = cardOf(
    w,
    lines.map((l) => l.line),
  );
  // The yields the card counted, recorded as `compose` records the ones it ranks by.
  for (const { line } of lines) {
    const read = w.yields.get(line.assetId);
    if (!read || w.sleeveOf(w.byId.get(line.assetId) ?? w.cash) !== 'dollarYield') continue;
    const { source, method, fetchedAt, provenance } = read;
    w.observations.set(`yield ${line.assetId}`, {
      id: line.assetId,
      kind: 'yield',
      source,
      method,
      fetchedAt,
      provenance,
    });
  }
  return {
    lines,
    card,
    flags: [...w.flags].sort(),
    observations: [...w.observations.values()],
  };
}
