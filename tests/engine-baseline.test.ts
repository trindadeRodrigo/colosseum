import { readFileSync } from 'node:fs';
import {
  applyHaircut,
  buildRiskSheet,
  buildScheduleWithStresses,
  REGISTRY,
  REGISTRY_BY_ID,
  solve,
} from '@colosseum/engine';
import type { ConstraintSheet, DepthObservation, YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// No-provider proof (HANDOFF-RISK §6 P3.1, PLAN-RISK Step 8): the full output of the three demo plans
// (allocation, binding constraints, schedule, stresses, risk sheet) frozen on the engine as it was before
// any liquidity hook. Every later engine change must keep this snapshot byte-identical when no
// LiquidityProvider is passed. Baseline recorded at commit 0f7830c (engine unchanged since main 6970dc5).
const inp = JSON.parse(readFileSync('fixtures/risk/engine-baseline-inputs.json', 'utf8'));
const yields = new Map<string, YieldObservation>(
  (inp.yields as Array<[string, string, number]>).map(([id, method, quoted]) => {
    const a = REGISTRY_BY_ID.get(id);
    if (!a) throw new Error(id);
    const h = applyHaircut(a, method, quoted);
    return [
      id,
      {
        assetId: id,
        quotedYield: quoted,
        haircutYield: h.haircutYield,
        haircutRule: h.rule.id,
        source: 'fixture',
        method,
        fetchedAt: '2026-09-30T00:00:00.000Z',
        provenance: 'fixture',
      },
    ];
  }),
);
const assets = new Map(REGISTRY.map((a) => [a.id, a]));

function fullPlan(sheet: ConstraintSheet) {
  const solved = solve({
    sheet,
    capitalUsd: inp.capitalUsd,
    assets: REGISTRY,
    yields,
    fxUsdBrl: inp.fxUsdBrl,
    nowMonth: inp.nowMonth,
  });
  const sched = buildScheduleWithStresses({
    sheet,
    legs: solved.legs,
    assets,
    yields,
    capitalUsd: inp.capitalUsd,
    fxUsdBrl: inp.fxUsdBrl,
    nowMonth: inp.nowMonth,
  });
  const held = REGISTRY.filter((a) => solved.legs.some((l) => l.assetId === a.id));
  const risk = buildRiskSheet({
    assets: held,
    yields,
    depth: new Map<string, DepthObservation[]>(),
  });
  return { solved, base: sched.base, stresses: sched.stressSummaries, risk };
}

describe('engine baseline without a liquidity provider', () => {
  for (const [name, sheet] of Object.entries(inp.sheets as Record<string, ConstraintSheet>)) {
    it(`${name} plan is unchanged`, () => {
      expect(fullPlan(sheet)).toMatchSnapshot();
    });
  }
});
