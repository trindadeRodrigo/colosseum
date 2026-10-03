import type { DataTableProps } from '../DataTable';
import type { Execution } from '../ExecutionList';
import type { ExitPanelTier, ExitTier } from '../ExitPlanLine';
import type { PlanLeg } from '../PlanLegs';
import type { PinSource } from '../ProvenancePin';

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
