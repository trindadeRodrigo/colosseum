import type { SheetGroup, SheetSource } from '../ConstraintSheet';
import type { DataTableProps } from '../DataTable';
import type { Execution } from '../ExecutionList';
import type { ExitPanelTier, ExitTier } from '../ExitPlanLine';
import type { PlanLeg } from '../PlanLegs';
import type { PinSource } from '../provenance';

// Made-up content for the showcase page and for the tests of the primitives. Nothing here is a real
// rate, price or transaction, and nothing the product ships may import this file
// (components/ui/shipped.test.ts). Sample figures live here, and only here, because no rate may be
// typed into a component (tests/no-yield-literals.test.ts skips folders named `fixtures`).

const AT = '2026-10-01T14:02:11Z';

/** Sample data, labelled as what it is. The pin draws it hatched, with the word MOCK. */
export const MOCK_OBS: PinSource = {
  source: 'sample',
  fetchedAt: AT,
  method: 'illustrative weights v1',
  provenance: 'mock',
};
export const FIXTURE_OBS: PinSource = {
  ...MOCK_OBS,
  source: 'fixture file',
  provenance: 'fixture',
};
/** A figure read from a test network. */
export const SANDBOX_OBS: PinSource = {
  source: 'test exchange',
  fetchedAt: AT,
  method: 'one-unit sell quote',
  provenance: 'sandbox',
};

/**
 * Specimens of the live and the stale state. The data is as made up as the rest: these exist so the
 * showcase can draw the solid and the hollow pin. Every panel that shows one carries the MOCK plate.
 */
export const LIVE_SPECIMEN: PinSource = {
  source: 'sample feed',
  fetchedAt: AT,
  method: 'haircut v2',
  provenance: 'live',
};
export const STALE_SPECIMEN: PinSource = { ...LIVE_SPECIMEN, staleAgeSec: 3 * 3600 };

export const FIGURE = {
  rate: '6.40%',
  rateDetail: 'quoted 7.10% · after haircut 6.40% · credit haircut v2',
  quoted: '7.10%',
  cost: '≤ 0.50%',
  balance: '$12,480 of $40,000',
  balanceValue: '$12,480',
} as const;

export const TREASURIES: PlanLeg = {
  id: 'treasuries',
  name: 'Tokenized treasuries',
  weight: 0.45,
  weightLabel: '45%',
  kind: 'usd_yield',
  rate: { afterHaircut: '4.10%', quoted: '4.35%', obs: LIVE_SPECIMEN },
  why: 'The steadiest income for a date three years out.',
};

export const LEGS: PlanLeg[] = [
  TREASURIES,
  {
    id: 'lending',
    name: 'Dollar lending',
    weight: 0.25,
    weightLabel: '25%',
    kind: 'usd_yield',
    rate: { afterHaircut: '5.02%', quoted: '6.80%', obs: STALE_SPECIMEN },
    why: 'A little more income, sized to what can be withdrawn in a day.',
  },
  {
    id: 'cash',
    name: 'Cash buffer',
    weight: 0.2,
    weightLabel: '20%',
    kind: 'cash',
    rate: null,
    note: 'reachable today',
  },
  {
    id: 'brl',
    name: 'BRL leg',
    weight: 0.1,
    weightLabel: '10%',
    kind: 'brl_stable',
    rate: null,
    note: 'integration in progress',
    mock: true,
  },
];

export const EXIT_FIRST: ExitTier = { text: 'up to $4,000 within a day' };
export const EXIT_TIERS: ExitTier[] = [
  EXIT_FIRST,
  { text: 'the rest within 7 days', cost: { figure: FIGURE.cost, obs: LIVE_SPECIMEN } },
];

export const EXIT_PANEL_TIERS: ExitPanelTier[] = [
  { id: '1', label: '1', amount: '$4,000', time: '1 day', cost: null, route: 'cash buffer' },
  {
    id: '2',
    label: '2',
    amount: '$8,480',
    time: '7 days',
    cost: { figure: FIGURE.cost, obs: MOCK_OBS },
    route: 'redeem the treasuries',
  },
];

export const EXECUTIONS: Execution[] = [
  {
    id: 'e1',
    verb: 'Swap',
    detail: '5.00 USDC → USDY',
    status: 'confirmed',
    at: '2026-09-30T14:02:00Z',
    signature: '4kZ9sampleSignatureThatIsNotRealAtAllmX2p',
    explorerUrl: 'https://explorer.example/tx/4kZ9sampleSignatureThatIsNotRealAtAllmX2p',
    explorer: 'the sample explorer',
    provenance: 'sandbox',
  },
  {
    id: 'e2',
    verb: 'Deposit',
    detail: '3.00 USDC → lending',
    status: 'failed',
    error: 'slippage exceeded',
    at: '2026-09-30T14:05:00Z',
    signature: '9aQ1sampleSignatureThatIsNotRealAtAllLk7c',
    explorerUrl: null,
    explorer: 'the sample explorer',
    provenance: 'mock',
  },
];

export type DriftRow = {
  asset: string;
  weight: string;
  target: string;
  drift: string;
  price: string;
  outOfBand: boolean;
  mock: boolean;
};
export const DRIFT_ROWS: DriftRow[] = [
  {
    asset: 'Tokenized treasuries',
    weight: '48.0%',
    target: '45.0%',
    drift: '+3.0%',
    price: '$1.0412',
    outOfBand: false,
    mock: false,
  },
  {
    asset: 'Dollar lending',
    weight: '19.0%',
    target: '25.0%',
    drift: '−6.0%',
    price: '$1.0000',
    outOfBand: true,
    mock: false,
  },
  {
    asset: 'BRL leg',
    weight: '10.0%',
    target: '10.0%',
    drift: '0.0%',
    price: '$0.1852',
    outOfBand: false,
    mock: true,
  },
];
export type DriftTable = DataTableProps<DriftRow>;

export const SHEET_SOURCE: SheetSource = {
  method: 'sample-parser',
  model: 'no model',
  fetchedAt: AT,
  provenance: 'fixture',
};

const PROFILES = [
  { value: 'income', label: 'Income' },
  { value: 'accumulation', label: 'Accumulation' },
  { value: 'high_risk', label: 'High risk' },
];
const BUDGETS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** A sheet as the caller hands it over: human labels, draft values as text, and what does not fit. */
export function sheetGroups(wrong: boolean): SheetGroup[] {
  return [
    {
      legend: 'Goal',
      fields: [
        {
          id: 'sheet-kind',
          label: 'Kind',
          schemaKey: 'target.kind',
          kind: 'select',
          value: 'monthly_cashflow',
          options: [
            { value: 'monthly_cashflow', label: 'Monthly income' },
            { value: 'balance', label: 'A balance by a date' },
          ],
        },
        {
          id: 'sheet-amount',
          label: 'Amount (BRL)',
          schemaKey: 'target.amountBrl',
          kind: 'amount',
          value: '5.000',
          hint: 'In reais. Your target, not a promise.',
        },
        {
          id: 'sheet-from',
          label: 'From',
          schemaKey: 'target.startMonth',
          kind: 'month',
          value: '2029-01',
        },
      ],
    },
    {
      legend: 'Profile and risk',
      fields: [
        {
          id: 'sheet-profile',
          label: 'Profile',
          schemaKey: 'profile',
          kind: 'select',
          value: wrong ? 'accumulation' : 'income',
          options: PROFILES,
          edited: true,
          caption: wrong ? undefined : 'Income plans don’t include tokenized stocks.',
          error: wrong ? 'A monthly income goal needs the income profile.' : undefined,
        },
        {
          id: 'sheet-risk',
          label: 'Risk budget',
          schemaKey: 'riskBudget',
          kind: 'select',
          value: 'low',
          options: BUDGETS,
        },
      ],
    },
    {
      legend: 'Time and cash',
      fields: [
        {
          id: 'sheet-horizon',
          label: 'Horizon (months)',
          schemaKey: 'horizonMonths',
          kind: 'number',
          value: wrong ? '' : '36',
          error: wrong ? 'Enter how many months the plan runs.' : undefined,
        },
        {
          id: 'sheet-window',
          label: 'Cash within (days)',
          schemaKey: 'liquidityWindowDays',
          kind: 'number',
          value: '7',
        },
      ],
    },
  ];
}
export const SHEET_CAPITAL = {
  id: 'sheet-capital',
  label: 'Capital (USD)',
  schemaKey: 'initialCapitalUsd',
  kind: 'amount' as const,
  value: '1.000',
};
