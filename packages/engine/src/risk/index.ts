import type {
  Asset,
  DepthObservation,
  LiquidityProvider,
  RiskSheetEntry,
  YieldObservation,
} from '@colosseum/schemas';

export type RiskInputs = {
  assets: Asset[];
  /** Latest yield observation per asset, primary method (realised/protocol) preferred over aggregator. */
  yields: Map<string, YieldObservation>;
  /** Latest depth observations per asset (buy side), any notionals. */
  depth: Map<string, DepthObservation[]>;
  /** Optional measured exit liquidity: adds a structured `liquidity` block per covered leg. */
  liquidity?: {
    provider: LiquidityProvider;
    tau: number;
    windowDays: number;
    /** USD amount of each leg in the plan. */
    legAmounts: Map<string, number>;
  };
};

const pctText = (n: number) => `${(n * 100).toFixed(3)}%`;

/** One risk-sheet entry per asset: yield with provenance and haircut rule, oracle, redemption, depth, gates, issuer. */
export function buildRiskSheet(input: RiskInputs): RiskSheetEntry[] {
  return input.assets.map((a) => {
    const y = input.yields.get(a.id);
    const d = (input.depth.get(a.id) ?? []).sort((x, z) => x.notionalUsd - z.notionalUsd);
    const depthNote = d.length
      ? d
          .map(
            (o) => `$${o.notionalUsd.toLocaleString('en-US')}: ${pctText(o.priceImpactPct)} impact`,
          )
          .join(' · ') + ` (${d[0]?.method}, ${d[d.length - 1]?.fetchedAt})`
      : a.mintPath === 'dex_swap'
        ? 'no depth observation yet'
        : null;
    return {
      assetId: a.id,
      quotedYield: y ? y.quotedYield : null,
      haircutYield: y ? y.haircutYield : null,
      haircutRule: y ? y.haircutRule : null,
      yieldSource: y ? y.source : null,
      yieldFetchedAt: y ? y.fetchedAt : null,
      oracle: a.metadata.oracle ?? null,
      redemptionPath: a.metadata.redemptionPath ?? null,
      redemptionTime: a.metadata.redemptionTime ?? null,
      depthNote,
      gates: a.metadata.gates,
      issuer: a.metadata.issuer ?? null,
      creditExposure: a.metadata.creditExposure ?? null,
      provenance: a.mintPath === 'unavailable' ? 'live' : (y?.provenance ?? 'live'),
      label: a.metadata.label ?? null,
      ...liquidityBlock(input, a.id),
    };
  });
}

function liquidityBlock(input: RiskInputs, assetId: string) {
  const l = input.liquidity;
  if (!l?.provider.covers(assetId)) return {};
  const entry = l.provider.entry(assetId, {
    tau: l.tau,
    windowDays: l.windowDays,
    legAmountUsd: l.legAmounts.get(assetId) ?? 0,
  });
  return entry ? { liquidity: entry } : {};
}

/** Prefer realised/protocol observations over aggregator stand-ins when both exist. */
export function pickPrimaryYield(observations: YieldObservation[]): Map<string, YieldObservation> {
  const rank = (m: string) =>
    m.startsWith('realised_') || m === 'protocol_api' || m === 'by_construction' ? 0 : 1;
  const out = new Map<string, YieldObservation>();
  for (const o of [...observations].sort(
    (x, y) => rank(x.method) - rank(y.method) || y.fetchedAt.localeCompare(x.fetchedAt),
  )) {
    if (!out.has(o.assetId)) out.set(o.assetId, o);
  }
  return out;
}
