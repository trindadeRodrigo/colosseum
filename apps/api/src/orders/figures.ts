import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { PERSONAL_PARAMS } from '@colosseum/engine/personal';
import type { BasketAsset, HoldingFigures, RecipeFigures, Target } from '@colosseum/schemas';
import type { PlanInputs } from './personalize';

// What the server has measured about the holdings of a shared portfolio, for its card and its page:
// the readings a plan is made from (`PlanInputs`: the stored yields and Bearing's sell depth), said a
// holding at a time. Nothing is estimated and nothing is added up here: a token with no reading has
// none, and each figure is the reading itself. A yield for the whole portfolio is the engine's to work
// out, as it does for a plan's card (packages/engine/src/personal/card.ts, `cardOf`), and that function
// takes the engine's own world of a goal, not a recipe: until the engine exposes one that takes lines
// and readings, no range of the whole is served.

type Inputs = Awaited<ReturnType<PlanInputs>>;

/** The figures of these components from the plan inputs of their chain, read at `now`. */
export function figuresOf(
  components: readonly Target[],
  assets: readonly BasketAsset[],
  inputs: Inputs,
  now: string,
): RecipeFigures {
  const listed = new Map(assets.map((a) => [a.id, a]));
  const tau = PERSONAL_PARAMS.tau;
  const holdings = components.map((c): HoldingFigures => {
    const y = inputs.yields?.find((o) => o.assetId === c.asset);
    const provider = listed.has(c.asset) ? inputs.liquidity?.provider : undefined;
    const capacity = provider?.covers(c.asset)
      ? provider.exitCapacity(c.asset, tau, EXIT_WINDOW_DAYS)
      : null;
    return {
      asset: c.asset,
      cls: listed.get(c.asset)?.cls ?? null,
      yield: y
        ? {
            quoted: y.quotedYield,
            afterHaircut: y.haircutYield,
            haircutRule: y.haircutRule,
            source: y.source,
            method: y.method,
            fetchedAt: y.fetchedAt,
            provenance: y.provenance,
          }
        : null,
      exit:
        capacity && provider && inputs.liquidity
          ? {
              capacityUsd: capacity.capacityUsd,
              lowerBound: capacity.lowerBound,
              windowDays: EXIT_WINDOW_DAYS,
              maxCostBps: Math.round(tau * 10_000),
              source: inputs.liquidity.source,
              method: `the most sold within ${EXIT_WINDOW_DAYS} days at a cost of at most ${tau * 100}%, in the worst conditions measured (${capacity.regime}, ${capacity.samples} samples)`,
              fetchedAt: capacity.dataTo ?? now,
              // A fixture's figures are not a reading of any chain.
              provenance: provider.provenance === 'fixture' ? 'mock' : provider.provenance,
            }
          : null,
    };
  });

  return { holdings };
}
