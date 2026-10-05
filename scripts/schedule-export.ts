import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import {
  buildScheduleWithStresses,
  fetchAllYields,
  fetchFx,
  pickPrimaryYield,
  REGISTRY,
  REGISTRY_BY_ID,
  scheduleToCsv,
  solve,
} from '@colosseum/engine';
import type { ConstraintSheet } from '@colosseum/schemas';

// Exports the income-goal schedule (base + stresses) to docs/structurer/schedule-check.csv for the spreadsheet cross-check.
// Capital is a parameter (--capital), not a claim.
const capitalUsd = Number(
  process.argv.includes('--capital')
    ? process.argv[process.argv.indexOf('--capital') + 1]
    : 100_000,
);
const sheet: ConstraintSheet = {
  language: 'pt',
  currency: 'BRL',
  profile: 'income',
  target: { kind: 'monthly_cashflow', amountBrl: 3000, startMonth: '2028-01' },
  horizonMonths: 60,
  liquidityWindowDays: 7,
  riskBudget: 'low',
  creditTolerance: 'limited',
  fxStance: 'hedge_near_term',
};
const { observations } = await fetchAllYields(REGISTRY);
const yields = pickPrimaryYield(observations);
const fxRows = await fetchFx();
const fx = fxRows.find((f) => f.pair === 'USD/BRL');
if (!fx) throw new Error('no FX');
const r = solve({ sheet, capitalUsd, assets: REGISTRY, yields, fxUsdBrl: fx.value });
const s = buildScheduleWithStresses({
  sheet,
  legs: r.legs,
  assets: REGISTRY_BY_ID,
  yields,
  capitalUsd,
  fxUsdBrl: fx.value,
});
const header = [
  `# income goal: R$3.000/month from 2028-01, capital US$${capitalUsd}, fx ${fx.value} (${fx.source}, ${fx.fetchedAt})`,
  `# legs: ${r.legs.map((l) => `${l.assetId}=${l.weight}`).join(' ')}`,
  `# haircut yields: ${r.legs.map((l) => `${l.assetId}=${(yields.get(l.assetId)?.haircutYield ?? 0).toFixed(6)} (${yields.get(l.assetId)?.method ?? 'n/a'})`).join(' ')}`,
  '# month formula: leg_usd[m] = leg_usd[m-1] * (1 + haircut_yield/12); withdrawal from BRL leg, then USDC, then liquid legs pro rata; balance_brl = sum(leg_usd)*fx + brl_leg',
];
writeFileSync(
  'docs/structurer/schedule-check.csv',
  `${header.join('\n')}\n${scheduleToCsv(s.base.rows)}\n`,
);
console.log(
  JSON.stringify(
    {
      capitalUsd,
      fx: fx.value,
      legs: r.legs.map((l) => ({ id: l.assetId, w: l.weight })),
      base: s.base.summary,
      stresses: s.stressSummaries,
    },
    null,
    1,
  ),
);
