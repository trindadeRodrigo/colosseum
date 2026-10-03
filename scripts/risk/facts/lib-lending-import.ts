import { LendingPoolFacts } from '@colosseum/schemas';

// PLAN-ANALYTICS item 11 — rows of risk_lending_facts and risk_lending_coverage from one lending report
// (`pnpm risk:lending-report`, lending-report-0.2). Pure: the import script reads the file and writes the rows.
export type LendingReportFile = {
  method: string;
  source: string;
  fetched_at: string;
  provenance: 'live' | 'fixture' | 'mock';
  windows?: { positionsHour?: string };
  lendingPoolFacts?: { sheets: unknown[] };
  coverageBoth?: {
    rows: Array<{
      gapPct: number;
      asset: string;
      seizedUsd: number;
      earlier: { capacityUsd: number | null; regime: string | null; ratio: number | null };
      margin: {
        capacityUsd: number | null;
        regime: string | null;
        derived: boolean | null;
        lowerBound: boolean | null;
        tau: number | null;
        limitingOracle: string | null;
        ratio: number | null;
        reason?: string;
        regimesMissing: string[];
      };
    }>;
  };
};

/** The sheets as table rows; a sheet that fails the schema is returned in `rejected`, never written. */
export function lendingFactsRows(r: LendingReportFile) {
  const reportAt = new Date(r.fetched_at);
  const rows = [];
  const rejected: Array<{ account: string; issue: string }> = [];
  for (const raw of r.lendingPoolFacts?.sheets ?? []) {
    const p = LendingPoolFacts.safeParse(raw);
    if (!p.success) {
      rejected.push({
        account: String((raw as { account?: string }).account),
        issue: p.error.issues[0]?.message ?? 'invalid',
      });
      continue;
    }
    const s = p.data;
    rows.push({
      account: s.account,
      reportAt,
      chain: s.chain,
      venue: s.venue,
      market: s.market,
      symbol: s.symbol,
      sheet: s,
      methodVersion: s.methodVersion,
      source: `lending report ${r.method} (${r.fetched_at})`,
      method: 'buildLendingPoolFacts',
      fetchedAt: reportAt,
      provenance: r.provenance,
    });
  }
  return { rows, rejected };
}

/** Coverage under both definitions, one row per gap and asset; a ratio not measured keeps its reason. */
export function lendingCoverageRows(r: LendingReportFile) {
  const reportAt = new Date(r.fetched_at);
  return (r.coverageBoth?.rows ?? []).map((c) => ({
    reportAt,
    gapPct: c.gapPct,
    asset: c.asset,
    seizedUsd: c.seizedUsd,
    earlierCapacityUsd: c.earlier.capacityUsd,
    earlierRegime: c.earlier.regime,
    earlierRatio: c.earlier.ratio,
    capacityUsd: c.margin.capacityUsd,
    regime: c.margin.regime,
    lowerBound: c.margin.lowerBound,
    derived: c.margin.derived,
    tau: c.margin.tau,
    ratio: c.margin.ratio,
    nullReason: c.margin.ratio === null ? (c.margin.reason ?? 'no_samples_in_regime') : null,
    limitingOracle: c.margin.limitingOracle,
    regimesMissing: c.margin.regimesMissing,
    positionsHour: r.windows?.positionsHour ?? null,
    methodVersion: r.method,
    source: r.source,
    method: 'coverage on the liquidator margin (route.ts) beside the earlier ratio (report.ts)',
    fetchedAt: reportAt,
    provenance: r.provenance,
  }));
}
