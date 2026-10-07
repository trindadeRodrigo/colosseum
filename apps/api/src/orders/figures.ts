import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { PERSONAL_PARAMS } from '@colosseum/engine/personal';
import type {
  BasketAsset,
  HoldingFigures,
  Provenance,
  RecipeFigures,
  Target,
} from '@colosseum/schemas';
import type { PlanInputs } from './personalize';

// What the server has measured about the holdings of a shared portfolio, for its card and its page:
// the readings a plan is made from (`PlanInputs`: the stored yields and Bearing's sell depth), said a
// holding at a time. Nothing is estimated here: a token with no reading has none, and the one figure
// worked out is the whole's yield, the readings times their shares, added.

type Inputs = Awaited<ReturnType<PlanInputs>>;

/** Not live wins: two labels that are both live are live; two that differ and are not live are mock. */
function worst(a: Provenance, b: Provenance): Provenance {
  if (a === 'live') return b;
  if (b === 'live' || a === b) return a;
  return 'mock';
}

export const YIELD_METHOD =
  'each holding’s yield reading times its share, added; a holding with no reading counts as nothing; low after the haircut, high as quoted';

/** The figures of these components from the plan inputs of their chain, read at `now`. */
export function figuresOf(
  components: readonly Target[],
  assets: readonly BasketAsset[],
  inputs: Inputs,
  now: string,
): RecipeFigures {
  const listed = new Set(assets.map((a) => a.id));
  const tau = PERSONAL_PARAMS.tau;
  const holdings = components.map((c): HoldingFigures => {
    const y = inputs.yields?.find((o) => o.assetId === c.asset);
    const provider = listed.has(c.asset) ? inputs.liquidity?.provider : undefined;
    const capacity = provider?.covers(c.asset)
      ? provider.exitCapacity(c.asset, tau, EXIT_WINDOW_DAYS)
      : null;
    return {
      asset: c.asset,
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

  const read = holdings.flatMap((h, i) =>
    h.yield ? [{ y: h.yield, share: (components[i]?.weightBps ?? 0) / 10_000 }] : [],
  );
  const [first] = read;
  return {
    holdings,
    yield: first
      ? {
          low: read.reduce((sum, r) => sum + r.y.afterHaircut * r.share, 0),
          high: read.reduce((sum, r) => sum + r.y.quoted * r.share, 0),
          source: [...new Set(read.map((r) => r.y.source))].join(' + '),
          method: YIELD_METHOD,
          fetchedAt: read
            .map((r) => r.y.fetchedAt)
            .reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)),
          provenance: read.reduce<Provenance>((label, r) => worst(label, r.y.provenance), 'live'),
        }
      : null,
  };
}
