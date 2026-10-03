import { Button } from '../Button';
import {
  Card,
  CardBody,
  CardEmpty,
  CardFooter,
  CardHeader,
  CardLoading,
  Stat,
  StatRow,
} from '../Card';
import { CompactNav } from '../CompactNav';
import { Composer } from '../Composer';
import { ConstraintSheet } from '../ConstraintSheet';
import { DataTable } from '../DataTable';
import { Disclaimer } from '../Disclaimer';
import { EmbedShell } from '../EmbedShell';
import { ExecutionList } from '../ExecutionList';
import { ExitPlanLine, ExitPlanPanel } from '../ExitPlanLine';
import { ExplorerLink } from '../ExplorerLink';
import { Field, Input, Select, Textarea } from '../Field';
import {
  DRIFT_ROWS,
  EXECUTIONS,
  EXIT_FIRST,
  EXIT_PANEL_TIERS,
  EXIT_TIERS,
  FIGURE,
  LEGS,
  LIVE_SPECIMEN,
  MOCK_OBS,
  SANDBOX_OBS,
  SHEET_CAPITAL,
  SHEET_SOURCE,
  STALE_SPECIMEN,
  sheetGroups,
  TREASURIES,
} from '../fixtures/mock';
import { GoalCard } from '../GoalCard';
import { Icon } from '../Icon';
import { MockFrame, MockPlate, StalePlate } from '../MockPlate';
import { PlanLegs } from '../PlanLegs';
import { type PinSource, ProvenancePin } from '../ProvenancePin';
import { Status, StatusBadge, StatusMark } from '../StatusMark';

// What the tests render. The test files are plain .ts (the root vitest config picks up *.test.ts
// only), so the JSX lives here.

export const button = {
  primary: <Button variant="primary">Build my plan</Button>,
  secondary: <Button>Edit sheet</Button>,
  dense: (
    <Button variant="primary" size="dense">
      Run policy now
    </Button>
  ),
  link: (
    <Button variant="link" href="/plans/sample">
      See your plan
    </Button>
  ),
  chip: (
    <Button variant="chip" pressed>
      $40,000 by June 2028
    </Button>
  ),
  icon: (
    <Button variant="icon" aria-label="Close">
      <Icon name="X" />
    </Button>
  ),
  destructive: <Button variant="destructive">Revoke delegation</Button>,
  busy: (
    <Button variant="primary" busy busyLabel="Building your plan…">
      Build my plan
    </Button>
  ),
  disabled: (
    <Button variant="primary" disabled aria-describedby="why">
      Build my plan
    </Button>
  ),
  // @ts-expect-error an icon button has no text, so it cannot go without a name
  iconUnnamed: <Button variant="icon">{null}</Button>,
};

export const field = {
  rest: (
    <Field label="Amount (BRL)" hint="In reais. Your target, not a promise.">
      {(control) => (
        <Input {...control} inputMode="decimal" align="end" width="12ch" defaultValue="40.000" />
      )}
    </Field>
  ),
  invalid: (
    <Field
      label="Profile"
      id="profile"
      error="A monthly income goal needs the income profile."
      announce
    >
      {(control) => (
        <Select {...control} defaultValue="accumulation">
          <option value="income">Income</option>
          <option value="accumulation">Accumulation</option>
        </Select>
      )}
    </Field>
  ),
  edited: (
    <Field label="Horizon (months)" edited schemaKey="horizonMonths">
      {(control) => <Input {...control} width="9ch" defaultValue="36" />}
    </Field>
  ),
  readOnly: (
    <Field label="From">
      {(control) => <Input {...control} readOnly defaultValue="2029-01" />}
    </Field>
  ),
  disabled: (
    <Field label="Monthly contribution (BRL)" hint="Set once the plan is built.">
      {(control) => <Input {...control} disabled />}
    </Field>
  ),
  textarea: <Field label="Notes">{(control) => <Textarea {...control} />}</Field>,
};

export const card = {
  plain: (
    <Card>
      <CardHeader title="Policy check" meta="as of 14:02 UTC" />
      <CardBody>Within the band.</CardBody>
      <CardFooter>source line</CardFooter>
    </Card>
  ),
  dense: (
    <Card density="dense">
      <CardHeader density="dense" title="Drift" />
      <CardBody density="dense">body</CardBody>
    </Card>
  ),
  interactive: (
    <Card interactive>
      <CardHeader title="Apartment fund" href="/plans/sample" />
    </Card>
  ),
  selected: (
    <Card selected current="page">
      <CardBody>Selected</CardBody>
    </Card>
  ),
  mock: (
    <Card mock>
      <CardHeader title="Sample plan" mock />
      <CardBody>body</CardBody>
    </Card>
  ),
  table: (
    <Card table>
      <CardBody>table</CardBody>
    </Card>
  ),
  loading: (
    <Card>
      <CardLoading label="Loading the plan" />
    </Card>
  ),
  empty: (
    <Card>
      <CardEmpty
        sentence="No plans yet."
        action={<Button variant="link">Describe a goal</Button>}
      />
    </Card>
  ),
  stats: (
    <StatRow>
      <Stat label="plans">7</Stat>
      <Stat label="after haircut">
        <ProvenancePin value={FIGURE.rate} obs={MOCK_OBS} />
      </Stat>
    </StatRow>
  ),
};

export const pin = {
  live: <ProvenancePin value={FIGURE.rate} obs={LIVE_SPECIMEN} />,
  stale: <ProvenancePin value={FIGURE.rate} obs={STALE_SPECIMEN} />,
  mock: <ProvenancePin value={FIGURE.rate} obs={MOCK_OBS} />,
  sandbox: <ProvenancePin value={FIGURE.rate} obs={SANDBOX_OBS} defaultOpen />,
  missing: <ProvenancePin value={FIGURE.rate} obs={null} />,
  noMethod: <ProvenancePin value={FIGURE.rate} obs={{ ...LIVE_SPECIMEN, method: '' }} />,
  noTime: <ProvenancePin value={FIGURE.rate} obs={{ ...LIVE_SPECIMEN, fetchedAt: 'yesterday' }} />,
  unknownKind: (
    <ProvenancePin
      value={FIGURE.rate}
      obs={{ ...LIVE_SPECIMEN, provenance: 'replayed' as PinSource['provenance'] }}
      defaultOpen
    />
  ),
  open: (
    <ProvenancePin value={FIGURE.rate} obs={LIVE_SPECIMEN} detail={FIGURE.rateDetail} defaultOpen />
  ),
  openWithDocs: (
    <ProvenancePin
      value={FIGURE.rate}
      obs={STALE_SPECIMEN}
      docs={{ href: '/risk/methodology', label: 'How we measure' }}
      defaultOpen
    />
  ),
  labelled: (
    <ProvenancePin value={FIGURE.balance} labelValue={FIGURE.balanceValue} obs={LIVE_SPECIMEN} />
  ),
  // @ts-expect-error a figure cannot be shown without being handed its source
  unsourced: <ProvenancePin value={FIGURE.rate} />,
  halfSourced: (
    <ProvenancePin
      value={FIGURE.rate}
      // @ts-expect-error a source without a method is not a source
      obs={{ source: 'sample', fetchedAt: 'x', provenance: 'live' }}
    />
  ),
};

export const mockPlate = {
  inline: <MockPlate />,
  badge: <MockPlate placement="badge" />,
  badgeQuiet: <MockPlate placement="badge" announce={false} />,
  frame: <MockFrame heading="Sample plan">the body</MockFrame>,
  stale: <StalePlate ageSec={3 * 3600} />,
  // @ts-expect-error the plate takes no text: it says MOCK and nothing else
  reworded: <MockPlate word="LIVE">LIVE</MockPlate>,
};

export const disclaimer = {
  en: <Disclaimer lang="en" heading="Not advice" />,
  pt: <Disclaimer lang="pt" />,
  both: <Disclaimer lang={['pt', 'en']} />,
  // @ts-expect-error the text comes from the constant: there is no prop for other words
  reworded: <Disclaimer lang="en">Simulation. Not investment advice.</Disclaimer>,
};

export const status = {
  on: <Status status="on-track">On track · June 2028</Status>,
  watch: <StatusBadge status="watch">Watch</StatusBadge>,
  off: <StatusMark status="off-track" />,
  // @ts-expect-error a status is never shown without its word
  wordless: <Status status="watch" />,
};

export const table = {
  drift: (
    <DataTable
      caption="Drift against the plan"
      rows={DRIFT_ROWS}
      rowKey={(row) => row.asset}
      rowStatus={(row) => (row.outOfBand ? { status: 'watch', word: 'Out of band' } : null)}
      rowMock={(row) => row.mock}
      columns={[
        { key: 'asset', header: 'Leg', rowHeader: true, cell: (row) => row.asset },
        { key: 'weight', header: 'Weight', numeric: true, cell: (row) => row.weight },
        { key: 'target', header: 'Target', numeric: true, cell: (row) => row.target },
        { key: 'drift', header: 'Drift', numeric: true, cell: (row) => row.drift },
        {
          key: 'price',
          header: 'Price',
          numeric: true,
          cell: (row) => (
            <ProvenancePin value={row.price} obs={row.mock ? MOCK_OBS : LIVE_SPECIMEN} />
          ),
        },
      ]}
    />
  ),
  narrow: (
    <DataTable
      caption="Stress cases"
      captionHidden
      dense
      rows={[{ name: 'Rates down a third', end: '$38,200' }]}
      rowKey={(row) => row.name}
      columns={[
        { key: 'name', header: 'Stress', cell: (row) => row.name },
        {
          key: 'end',
          header: 'Terminal balance',
          numeric: true,
          projected: true,
          cell: (row) => row.end,
        },
      ]}
    />
  ),
};

export const executions = {
  list: <ExecutionList executions={EXECUTIONS} />,
  link: (
    <ExplorerLink
      signature="4kZ9sampleSignaturemX2p"
      href="https://explorer.example/tx/x"
      explorer="Solana Explorer"
    />
  ),
};

export const goalCard = {
  onTrack: (
    <GoalCard
      sentence="Your apartment fund is on track."
      status={{ kind: 'on-track', word: 'On track', date: 'June 2028' }}
      amount={{ figure: FIGURE.balance, labelValue: FIGURE.balanceValue, obs: LIVE_SPECIMEN }}
      detail="access to cash within 7 days"
      action={{ label: 'See your plan', href: '/plans/sample' }}
    />
  ),
  watch: (
    <GoalCard
      sentence="Your trip fund needs a look."
      status={{ kind: 'watch', word: 'Watch', date: 'March 2029' }}
      reason="A stress case breaks in month 14."
      detail="pays R$ 5.000 a month from January 2029"
      action={{ label: 'See your plan', href: '/plans/sample' }}
      mock
    />
  ),
  draft: (
    <GoalCard
      state="draft"
      sentence="A house deposit by 2030."
      note="Draft: finish the sheet"
      action={{ label: 'Edit sheet', href: '/' }}
    />
  ),
  loading: <GoalCard state="loading" sentence="" action={{ label: '', href: '/' }} />,
  header: (
    <GoalCard
      variant="header"
      sentence="Your apartment fund is on track."
      status={{ kind: 'on-track', word: 'On track', date: 'June 2028' }}
      meta="income · solver sample · 2026-10-01"
      action={{ label: 'Edit sheet', href: '/' }}
    />
  ),
};

export const planLegs = {
  four: <PlanLegs legs={LEGS} profile="income" />,
  hero: <PlanLegs legs={LEGS.slice(0, 2)} size="hero" lock />,
  parted: <PlanLegs legs={LEGS} parted />,
  closed: <PlanLegs legs={LEGS} parted={false} />,
  five: () => <PlanLegs legs={[...LEGS, { ...TREASURIES, id: 'fifth' }]} />,
  incomeWithStocks: () => (
    <PlanLegs profile="income" legs={[{ ...TREASURIES, id: 'stocks', kind: 'equity' }]} />
  ),
  unsourced: (
    <PlanLegs
      legs={[{ ...TREASURIES, rate: { afterHaircut: '4.10%', quoted: '4.35%', obs: null } }]}
    />
  ),
};

export const exitPlan = {
  line: (
    <ExitPlanLine
      tiers={EXIT_TIERS}
      caveat="Weekend exits are slower and cost more."
      inKind="You can also take the tokens themselves out of the vault at any time."
    />
  ),
  partlyMock: (
    <ExitPlanLine
      tiers={[EXIT_FIRST, { text: 'the rest within 7 days', mock: true }]}
      alert={{
        status: 'off-track',
        text: 'Off track: in the rate-shock case, cash within 7 days drops to $2,100.',
      }}
    />
  ),
  unsourced: <ExitPlanLine unsourced="Yields and exit costs are sourced live after you connect." />,
  panel: <ExitPlanPanel tiers={EXIT_PANEL_TIERS} />,
};

const noop = () => {};

export const composer = {
  empty: (
    <Composer
      label="Your goal"
      placeholder="$40,000 by June 2028, cash within 7 days"
      hint="Enter to fit · Shift+Enter for a new line"
      onSubmit={noop}
    />
  ),
  typed: (
    <Composer label="Your goal" labelHidden defaultValue="$40,000 by June 2028" onSubmit={noop} />
  ),
  busy: <Composer label="Your goal" defaultValue="$40,000 by June 2028" busy onSubmit={noop} />,
  error: (
    <Composer
      label="Your goal"
      defaultValue="soon, a lot"
      error="We couldn’t read that. Try an amount and a date."
      onSubmit={noop}
    />
  ),
  disabled: (
    <Composer label="Your goal" defaultValue="$40,000 by June 2028" disabled onSubmit={noop} />
  ),
  subscribe: (
    <Composer
      variant="single"
      label="Email address"
      inputType="email"
      autoComplete="email"
      name="email"
      defaultValue="you@example.com"
      sendText="Subscribe"
      labels={{ send: 'Subscribe' }}
      onSubmit={noop}
    />
  ),
  // @ts-expect-error the typing box always has a label; a placeholder is never the only one
  unlabelled: <Composer placeholder="Your goal" onSubmit={noop} />,
};

type ParsedSheet = { readonly parsed: true };
const PARSED: ParsedSheet = { parsed: true };

export const sheet = {
  valid: (
    <ConstraintSheet<ParsedSheet>
      goalText="R$ 5.000 por mês a partir de 2029, posso precisar em 7 dias"
      source={SHEET_SOURCE}
      groups={sheetGroups(false)}
      capital={SHEET_CAPITAL}
      valid={PARSED}
      onChange={noop}
      onBuild={noop}
    />
  ),
  invalid: (
    <ConstraintSheet<ParsedSheet>
      groups={sheetGroups(true)}
      capital={SHEET_CAPITAL}
      valid={null}
      otherIssues={['The server could not read the sheet. Try again.']}
      onChange={noop}
      onBuild={noop}
    />
  ),
  parsing: (
    <ConstraintSheet<ParsedSheet>
      state="parsing"
      groups={[]}
      valid={null}
      onChange={noop}
      onBuild={noop}
    />
  ),
  solving: (
    <ConstraintSheet<ParsedSheet>
      state="solving"
      groups={sheetGroups(false)}
      capital={SHEET_CAPITAL}
      valid={PARSED}
      onChange={noop}
      onBuild={noop}
    />
  ),
  noPlan: (
    <ConstraintSheet<ParsedSheet>
      state="no-plan"
      groups={sheetGroups(false)}
      valid={PARSED}
      binding="The 7-day window binds: nothing in the low risk budget pays R$ 5.000 a month from this capital."
      onChange={noop}
      onBuild={noop}
    />
  ),
  read: (
    <ConstraintSheet mode="read" groups={sheetGroups(false)} source={SHEET_SOURCE} editHref="/" />
  ),
  unvalidated: (
    <ConstraintSheet<ParsedSheet>
      groups={sheetGroups(false)}
      // @ts-expect-error only a parsed sheet can be handed over: a draft is not one
      valid={{ draft: 'R$ 5.000' }}
      onChange={noop}
      onBuild={noop}
    />
  ),
};

const LINKS = [
  { label: 'Products', href: '#products' },
  { label: 'Invest', href: '#invest', current: true },
  { label: 'Resources', href: '#resources' },
];
const MARK = <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" />;

export const nav = {
  full: (
    <CompactNav
      symbol={MARK}
      wordmark="tenonfi"
      homeLabel="tenonfi home"
      links={LINKS}
      cta={{ label: 'Sign in', href: '#simulate' }}
      contentId="content"
      stage={{ compactAt: 'step-03', releaseAbove: 'step-02' }}
    />
  ),
  compact: (
    <CompactNav
      symbol={MARK}
      wordmark="tenonfi"
      homeLabel="tenonfi home"
      links={LINKS}
      cta={{ label: 'Open app', href: '/' }}
      contentId="content"
    />
  ),
};

const CREDIT = { name: 'tenonfi', href: 'https://example.com/plans/sample' };

export const embed = {
  ready: (
    <EmbedShell
      label="Plan by tenonfi"
      lang="en"
      title="Apartment fund"
      lead="$40,000 by June 2028 · cash within 7 days"
      credit={CREDIT}
      schedule={<p>the schedule chart</p>}
    >
      <PlanLegs legs={LEGS} />
      <ExitPlanLine tiers={EXIT_TIERS} />
      <Disclaimer lang="en" />
      <ExecutionList executions={EXECUTIONS} />
    </EmbedShell>
  ),
  faint: (
    <EmbedShell label="Plan by tenonfi" title="Apartment fund" credit={CREDIT} suppressHatch>
      <PlanLegs legs={LEGS} />
    </EmbedShell>
  ),
  loading: <EmbedShell label="Plan by tenonfi" state="loading" />,
  unavailable: <EmbedShell label="Plan by tenonfi" state="unavailable" />,
};
