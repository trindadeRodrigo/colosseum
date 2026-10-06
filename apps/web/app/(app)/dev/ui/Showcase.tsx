'use client';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { Mark } from '../../../../components/shell/Mark';
import { Button } from '../../../../components/ui/Button';
import {
  Card,
  CardBody,
  CardEmpty,
  CardFooter,
  CardHeader,
  CardLoading,
  Stat,
  StatRow,
} from '../../../../components/ui/Card';
import { CompactNav } from '../../../../components/ui/CompactNav';
import { Composer } from '../../../../components/ui/Composer';
import { ConstraintSheet } from '../../../../components/ui/ConstraintSheet';
import { DataTable } from '../../../../components/ui/DataTable';
import { Disclaimer } from '../../../../components/ui/Disclaimer';
import { EmbedShell } from '../../../../components/ui/EmbedShell';
import { ExecutionList } from '../../../../components/ui/ExecutionList';
import { ExitPlanLine, ExitPlanPanel } from '../../../../components/ui/ExitPlanLine';
import { Field, Input, Select, Textarea } from '../../../../components/ui/Field';
import {
  DRIFT_ROWS,
  EXECUTIONS,
  EXIT_FIRST,
  EXIT_PANEL_TIERS,
  EXIT_TIERS,
  FIGURE,
  FIXTURE_OBS,
  HEAT_CELLS,
  LEGS,
  LIVE_SPECIMEN,
  MOCK_OBS,
  SANDBOX_OBS,
  SHEET_CAPITAL,
  SHEET_SOURCE,
  STALE_SPECIMEN,
  sheetGroups,
} from '../../../../components/ui/fixtures/mock';
import { GoalCard } from '../../../../components/ui/GoalCard';
import { type HeatmapState, HeatmapTile } from '../../../../components/ui/HeatmapTile';
import { Icon, type IconName } from '../../../../components/ui/Icon';
import { LatticeStatus } from '../../../../components/ui/Lattice';
import { MockFrame, MockPlate, StalePlate } from '../../../../components/ui/MockPlate';
import { PlanLegs } from '../../../../components/ui/PlanLegs';
import { ProvenancePin } from '../../../../components/ui/ProvenancePin';
import type { PinSource } from '../../../../components/ui/provenance';
import { Status, StatusBadge } from '../../../../components/ui/StatusMark';
import { SubscribeBlock, type SubscribeStatus } from '../../../../components/ui/SubscribeBlock';

// The showcase of the design system: every primitive in every state, light beside dark, with the name
// of its spec. Development only (see page.dev.tsx). Everything on it is made up, and every panel says
// so with the MOCK plate; the live and stale pins are specimens of a state, not of data.

const noop = () => {};
const SPECS = '.design/branding/working-brand/patterns/components';

/** One state of one primitive, with its name. */
function Specimen({
  state,
  wide,
  children,
}: {
  state: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className={wide ? 'col-span-full min-w-0' : 'min-w-0'}>
      <figcaption className="mb-2 font-mono text-source text-muted-foreground">{state}</figcaption>
      {children}
    </figure>
  );
}

/** A primitive, shown twice: on paper and on warm black. */
function Section({
  spec,
  title,
  note,
  children,
}: {
  spec: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  const id = spec.replace(/\W+/g, '-');
  return (
    <section aria-labelledby={id} className="border-t border-border">
      <div className="tf-app light px-6 pt-8 pb-4">
        <h2 id={id} className="text-h3 font-semibold">
          {title}
        </h2>
        <p className="mt-1 font-mono text-source text-muted-foreground">
          {SPECS}/{spec}
        </p>
        {note && <p className="mt-2 max-w-(--tf-measure-body) text-body-sm">{note}</p>}
      </div>
      <div className="grid xl:grid-cols-2">
        {(['light', 'dark'] as const).map((mode) => (
          <div key={mode} className={`tf-app ${mode} min-w-0 px-6 pt-4 pb-10`}>
            <div className="mb-6 flex items-center justify-between gap-4 border-b border-border pb-2">
              <span className="text-caption font-medium text-muted-foreground">{mode}</span>
              <MockPlate />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-x-6 gap-y-8">
              {children}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The heatmap tile on made-up depth: dollars sellable at ≤ 2%, every figure pinned. */
function HeatSample({ obs, state }: { obs: PinSource; state: HeatmapState }) {
  const usdM = (v: number) => `$${(v / 1e6).toFixed(2)}M`;
  const pin = (v: number) => <ProvenancePin value={usdM(v)} obs={obs} />;
  const values = HEAT_CELLS.map((c) => c.value);
  return (
    <HeatmapTile
      head="xAAPL · sellable at ≤ 2% impact"
      kpi={pin(Math.min(...values))}
      emph="thinnest: Sat 03:00 UTC"
      cells={HEAT_CELLS}
      deeper="high"
      fmt={usdM}
      what="at ≤ 2%"
      zone="UTC"
      least={pin(Math.min(...values))}
      most={pin(Math.max(...values))}
      cellFigure={(c) => pin(c.value)}
      meta="USD · n=412 · method v1.3 · as of 2026-10-01 14:00 UTC"
      state={state}
      aria="Sample: dollars sellable at ≤ 2% by hour of week"
    />
  );
}

/** The look of a state that needs a pointer or the keyboard, held still for the page. */
const HOVER: CSSProperties = { backgroundColor: 'var(--tf-primary-hover)' };
const PRESSED: CSSProperties = { backgroundColor: 'var(--tf-primary-pressed)' };
const FOCUS: CSSProperties = { outline: '2px solid var(--ring)', outlineOffset: 2 };

const SWATCHES = [
  ['background', 'bg-background'],
  ['card', 'bg-card'],
  ['muted', 'bg-muted'],
  ['popover', 'bg-popover'],
  ['foreground', 'bg-foreground'],
  ['muted-foreground', 'bg-muted-foreground'],
  ['primary', 'bg-primary'],
  ['primary-hover', 'bg-primary-hover'],
  ['primary-pressed', 'bg-primary-pressed'],
  ['border (hair)', 'bg-border'],
  ['input (member)', 'bg-input'],
  ['destructive', 'bg-destructive'],
  ['status-on', 'bg-status-on'],
  ['status-on-bg', 'bg-status-on-bg'],
  ['status-watch', 'bg-status-watch'],
  ['status-watch-bg', 'bg-status-watch-bg'],
  ['status-off', 'bg-status-off'],
  ['status-off-bg', 'bg-status-off-bg'],
  ['leg-1', 'bg-leg-1'],
  ['leg-2', 'bg-leg-2'],
  ['leg-3', 'bg-leg-3'],
  ['leg-4', 'bg-leg-4'],
  ['heat-1', 'bg-heat-1'],
  ['heat-2', 'bg-heat-2'],
  ['heat-3', 'bg-heat-3'],
  ['heat-4', 'bg-heat-4'],
  ['heat-5', 'bg-heat-5'],
] as const;

const TYPE = [
  ['display', 'font-display text-display font-normal', 'Your apartment fund is on track.'],
  ['h1', 'font-display text-h1 font-normal', 'Made to measure.'],
  ['h2', 'text-h2 font-semibold', 'Every joint shown'],
  ['h3', 'text-h3 font-semibold', 'Access to cash'],
  ['h4', 'text-h4 font-medium', 'How we read your goal'],
  ['body-lg', 'text-body-lg', 'The serif gives the answer.'],
  ['body', 'text-body', 'The sans explains. 0123456789'],
  ['body-sm', 'text-body-sm', 'Up to $4,000 within a day.'],
  ['caption', 'text-caption font-medium', 'On track · June 2028'],
  ['source', 'font-mono text-source', 'sample · 2026-10-01T14:02:11Z · v1'],
  ['b-kpi', 'font-mono text-b-kpi font-medium', '$1.2M'],
  ['b-cell', 'font-condensed text-b-cell', 'Bearing table cell 1,234.50'],
] as const;

const ICONS: IconName[] = ['ArrowUp', 'ArrowUpRight', 'Check', 'ChevronDown', 'Copy', 'Menu', 'X'];

const NAV_LINKS = [
  { label: 'Products', href: '#products' },
  { label: 'Invest', href: '#invest', current: 'true' as const },
  { label: 'Analytics', href: '#analytics' },
];

/** An example partner: neutral colours, their own face, their own radius. Not ours. */
const PARTNER: CSSProperties = {
  '--embed-bg': '#FFFFFF',
  '--embed-fg': '#1E1E1E',
  '--embed-muted': '#6A6A6A',
  '--embed-border': '#D4D4D4',
  '--embed-radius': '14px',
  '--embed-font': 'Georgia, serif',
  padding: 20,
  border: '1px solid var(--embed-border)',
  borderRadius: 'var(--embed-radius)',
  background: 'var(--embed-bg)',
  fontFamily: 'var(--embed-font)',
} as CSSProperties;

type Parsed = { readonly parsed: true };
const PARSED: Parsed = { parsed: true };
const CREDIT = { name: 'tenonfi', href: '#embed-shell-md', symbol: <Mark size={16} /> };

function WhyThisPlan() {
  const [parted, setParted] = useState(false);
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="w-full">
        <PlanLegs legs={LEGS} parted={parted} />
      </div>
      <Button pressed={parted} onClick={() => setParted((was) => !was)}>
        Why this plan?
      </Button>
    </div>
  );
}

function PlanLock() {
  const [run, setRun] = useState(0);
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="w-full">
        <PlanLegs key={run} legs={LEGS} size="hero" lock />
      </div>
      <Button variant="link" onClick={() => setRun((n) => n + 1)}>
        Replay
      </Button>
    </div>
  );
}

const SUBSCRIBE_OPTIONS = [
  { id: 'updates', label: 'Product updates', defaultChecked: true },
  { id: 'newsletter', label: 'Newsletter' },
];

function Subscribe({ status }: { status: SubscribeStatus }) {
  return (
    <SubscribeBlock
      eyebrow="Follow along"
      heading="Built piece by piece. Watch it come together."
      lede="Product updates as new pieces are cut, and a short letter now and then. No hype, no price calls."
      options={SUBSCRIBE_OPTIONS}
      status={status}
      placeholder="you@example.com"
      onSubmit={noop}
    />
  );
}

export function Showcase() {
  return (
    <div
      data-ui="showcase"
      className="tf-app light mx-[calc(50%-50vw)] w-screen max-w-[100vw] overflow-x-clip text-left"
    >
      {/* the page is as wide as the window, scrollbar included: keep it from scrolling sideways */}
      <style>{'html { overflow-x: clip; }'}</style>
      <header className="flex flex-col gap-3 px-6 py-10">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-h2 font-semibold">Design system</h1>
          <MockPlate />
        </div>
        <p className="max-w-(--tf-measure-body) text-body">
          Every primitive in every state, on paper and on warm black, under the name of its spec.
          Everything here is made up: the goals, the rates, the transactions. A solid or hollow pin
          on this page shows a state, not a source.
        </p>
        <p className="font-mono text-source text-muted-foreground">
          development only · app/(app)/dev/ui/page.dev.tsx · not in a production build
        </p>
      </header>

      <Section
        spec="token-mapping.md"
        title="Tokens"
        note="Colours by their semantic names, the type scale, and the status marks. Values come from working-brand.yml."
      >
        <Specimen state="colour" wide>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {SWATCHES.map(([name, fill]) => (
              <div key={name} className="border border-border">
                <div className={`h-10 border-b border-border ${fill}`} />
                <p className="px-2 py-1 font-mono text-source">{name}</p>
              </div>
            ))}
          </div>
        </Specimen>
        <Specimen state="type" wide>
          <div className="flex flex-col gap-3">
            {TYPE.map(([name, classes, sample]) => (
              <div key={name} className="grid grid-cols-[6rem_1fr] items-baseline gap-4">
                <span className="font-mono text-source text-muted-foreground">{name}</span>
                <span className={classes}>{sample}</span>
              </div>
            ))}
          </div>
        </Specimen>
        <Specimen state="status: word, shape and colour">
          <div className="flex flex-col items-start gap-2">
            <Status status="on-track">On track · June 2028</Status>
            <Status status="watch">Watch · March 2029</Status>
            <Status status="off-track">Off track · August 2028</Status>
          </div>
        </Specimen>
        <Specimen state="status badge">
          <div className="flex flex-wrap gap-2">
            <StatusBadge status="on-track">On track</StatusBadge>
            <StatusBadge status="watch">Watch</StatusBadge>
            <StatusBadge status="off-track">Off track</StatusBadge>
          </div>
        </Specimen>
        <Specimen state="icons (16, 20, 24)">
          <div className="flex flex-wrap items-center gap-3">
            {ICONS.map((name) => (
              <Icon key={name} name={name} label={name} />
            ))}
            <Icon name="ArrowUpRight" size={16} />
            <Icon name="ArrowUpRight" size={24} />
          </div>
        </Specimen>
        <Specimen state="loading: the still lattice">
          <LatticeStatus label="Building your plan…" />
        </Specimen>
      </Section>

      <Section
        spec="button.md"
        title="Button"
        note="One primary per view. Hover, pressed and focus are held still here; the buttons beside them respond to the pointer and to Tab."
      >
        <Specimen state="primary">
          <Button variant="primary">Build my plan</Button>
        </Specimen>
        <Specimen state="primary · hover">
          <Button variant="primary" style={HOVER}>
            Build my plan
          </Button>
        </Specimen>
        <Specimen state="primary · pressed">
          <Button variant="primary" style={PRESSED}>
            Build my plan
          </Button>
        </Specimen>
        <Specimen state="primary · focus">
          <Button variant="primary" style={FOCUS}>
            Build my plan
          </Button>
        </Specimen>
        <Specimen state="primary · busy">
          <Button variant="primary" busy busyLabel="Building your plan…">
            Build my plan
          </Button>
        </Specimen>
        <Specimen state="primary · disabled, with the reason">
          <div className="flex flex-col items-start gap-1.5">
            <Button variant="primary" disabled aria-describedby="showcase-why">
              Build my plan
            </Button>
            <p id="showcase-why" className="text-caption text-muted-foreground">
              Fix the two fields above to continue.
            </p>
          </div>
        </Specimen>
        <Specimen state="primary · signs: names the action and the amount">
          <Button variant="primary">Sign: swap 5 USDC → USDY</Button>
        </Specimen>
        <Specimen state="secondary">
          <Button>Edit sheet</Button>
        </Specimen>
        <Specimen state="secondary · disabled">
          <Button disabled>Edit sheet</Button>
        </Specimen>
        <Specimen state="link">
          <Button variant="link" href="#button-md">
            See your plan
          </Button>
        </Specimen>
        <Specimen state="chip · chip, pressed">
          <div className="flex flex-wrap gap-2">
            <Button variant="chip">$40,000 by June 2028</Button>
            <Button variant="chip" pressed>
              R$ 5.000 a month from 2029
            </Button>
          </div>
        </Specimen>
        <Specimen state="icon · icon, dense · icon, pressed">
          <div className="flex flex-wrap gap-2">
            <Button variant="icon" aria-label="Close">
              <Icon name="X" />
            </Button>
            <Button variant="icon" size="dense" aria-label="Copy">
              <Icon name="Copy" size={16} />
            </Button>
            <Button variant="icon" aria-label="Menu" pressed>
              <Icon name="Menu" />
            </Button>
          </div>
        </Specimen>
        <Specimen state="destructive">
          <Button variant="destructive">Revoke delegation</Button>
        </Specimen>
        <Specimen state="dense (32px): primary, secondary">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="dense">
              Run policy now
            </Button>
            <Button size="dense">Details</Button>
          </div>
        </Specimen>
      </Section>

      <Section spec="field.md" title="Field: input, select, textarea">
        <Specimen state="rest, with a hint">
          <Field label="Amount (BRL)" hint="In reais. Your target, not a promise.">
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                align="end"
                width="12ch"
                defaultValue="40.000"
              />
            )}
          </Field>
        </Specimen>
        <Specimen state="focus">
          <Field label="By when">
            {(control) => <Input {...control} width="12ch" defaultValue="2028-06" style={FOCUS} />}
          </Field>
        </Specimen>
        <Specimen state="invalid: says what to change">
          <Field label="Profile" error="A monthly income goal needs the income profile.">
            {(control) => (
              <Select {...control} defaultValue="accumulation" width="16ch">
                <option value="income">Income</option>
                <option value="accumulation">Accumulation</option>
              </Select>
            )}
          </Field>
        </Specimen>
        <Specimen state="edited after the parser">
          <Field label="Horizon (months)" edited schemaKey="horizonMonths">
            {(control) => <Input {...control} width="9ch" align="end" defaultValue="36" />}
          </Field>
        </Specimen>
        <Specimen state="read-only">
          <Field label="From">
            {(control) => <Input {...control} readOnly width="9ch" defaultValue="2029-01" />}
          </Field>
        </Specimen>
        <Specimen state="disabled, with the reason">
          <Field label="Monthly contribution (BRL)" hint="Set once the plan is built.">
            {(control) => <Input {...control} disabled width="12ch" />}
          </Field>
        </Specimen>
        <Specimen state="select">
          <Field label="Risk budget">
            {(control) => (
              <Select {...control} defaultValue="low" width="12ch">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            )}
          </Field>
        </Specimen>
        <Specimen state="textarea">
          <Field label="Notes">{(control) => <Textarea {...control} />}</Field>
        </Specimen>
      </Section>

      <Section spec="card.md" title="Card and panel">
        <Specimen state="header, body, footer">
          <Card>
            <CardHeader title="Policy check" meta="as of 14:02 UTC" />
            <CardBody>
              <p className="text-body-sm">Every leg is inside its band.</p>
            </CardBody>
            <CardFooter>
              <p className="font-mono text-source text-muted-foreground">
                sample · illustrative v1
              </p>
            </CardFooter>
          </Card>
        </Specimen>
        <Specimen state="dense (16px)">
          <Card density="dense">
            <CardHeader density="dense" title="Drift" meta="3 legs" />
            <CardBody density="dense">
              <p className="text-body-sm">One leg is out of band.</p>
            </CardBody>
          </Card>
        </Specimen>
        <Specimen state="interactive: hover deepens the hairline">
          <Card interactive>
            <CardHeader title="Apartment fund" href="#card-md" meta="June 2028" />
          </Card>
        </Specimen>
        <Specimen state="selected">
          <Card selected>
            <CardHeader title="Trip fund" meta="March 2029" />
          </Card>
        </Specimen>
        <Specimen state="MOCK: band on the edge, plate at the top right">
          <Card mock>
            <CardHeader title="Sample plan" meta="as of 14:02 UTC" />
            <CardBody>
              <p className="text-body-sm">The feed is not connected. Shown for layout only.</p>
            </CardBody>
          </Card>
        </Specimen>
        <Specimen state="loading">
          <Card>
            <CardLoading label="Loading the plan" />
          </Card>
        </Specimen>
        <Specimen state="empty">
          <Card>
            <CardEmpty
              sentence="No plans yet."
              action={
                <Button variant="link" href="#card-md">
                  Describe a goal
                </Button>
              }
            />
          </Card>
        </Specimen>
        <Specimen state="stat cells: a count has no pin, a rate has one" wide>
          <StatRow>
            <Stat label="plans">7</Stat>
            <Stat label="confirmed transactions">11</Stat>
            <Stat label="after haircut">
              <ProvenancePin value={FIGURE.rate} obs={MOCK_OBS} />
            </Stat>
            <Stat label="exit cost">
              <ProvenancePin value={FIGURE.cost} obs={LIVE_SPECIMEN} />
            </Stat>
          </StatRow>
        </Specimen>
      </Section>

      <Section
        spec="provenance-pin.md"
        title="Provenance pin"
        note="After every yield, price and FX figure. Click or press Enter on a pin to open it; Escape closes it. The state comes from the data handed in: only the word “live” is live, and stale is stated by the API, never worked out."
      >
        <Specimen state="live: solid pin">
          <p className="text-h4 font-medium">
            <ProvenancePin value={FIGURE.rate} obs={LIVE_SPECIMEN} detail={FIGURE.rateDetail} />
          </p>
        </Specimen>
        <Specimen state="stale: hollow pin, the word and the age">
          <p className="text-h4 font-medium">
            <ProvenancePin value={FIGURE.rate} obs={STALE_SPECIMEN} />
          </p>
        </Specimen>
        <Specimen state="MOCK: hatched, no pin, the plate">
          <p className="text-h4 font-medium">
            <ProvenancePin value={FIGURE.rate} obs={MOCK_OBS} />
          </p>
        </Specimen>
        <Specimen state="a test network (sandbox): MOCK">
          <p className="text-h4 font-medium">
            <ProvenancePin value="$1.0412" obs={SANDBOX_OBS} />
          </p>
        </Specimen>
        <Specimen state="a fixture: MOCK">
          <p className="text-body">
            <ProvenancePin value="5.4012 BRL/USD" obs={FIXTURE_OBS} />
          </p>
        </Specimen>
        <Specimen state="no source: no figure">
          <p className="text-h4 font-medium">
            <ProvenancePin value={FIGURE.rate} obs={null} />
          </p>
        </Specimen>
        <Specimen state="in running text, at body size">
          <p className="text-body">
            Quoted at {FIGURE.quoted}. After the credit haircut we use{' '}
            <ProvenancePin value={FIGURE.rate} obs={LIVE_SPECIMEN} />.
          </p>
        </Specimen>
        <Specimen state="open: source · fetched_at · method" wide>
          <p className="min-h-28 text-h4 font-medium">
            <ProvenancePin
              value={FIGURE.rate}
              obs={LIVE_SPECIMEN}
              detail={FIGURE.rateDetail}
              defaultOpen
            />
          </p>
        </Specimen>
        <Specimen state="open, stale, with a link: a dialog" wide>
          <p className="min-h-32 text-h4 font-medium">
            <ProvenancePin
              value={FIGURE.rate}
              obs={STALE_SPECIMEN}
              docs={{ href: '/risk/methodology', label: 'How we measure' }}
              defaultOpen
            />
          </p>
        </Specimen>
        <Specimen state="open, a test network" wide>
          <p className="min-h-28 text-h4 font-medium">
            <ProvenancePin value="$1.0412" obs={SANDBOX_OBS} defaultOpen />
          </p>
        </Specimen>
      </Section>

      <Section
        spec="mock-plate.md"
        title="MOCK plate"
        note="The hatch and the word, together, every time. Text never sits on the hatch."
      >
        <Specimen state="inline: after a figure and its hatched pin">
          <p className="text-h4 font-medium">
            <ProvenancePin value={FIGURE.rate} obs={MOCK_OBS} />
          </p>
        </Specimen>
        <Specimen state="badge: the band and the plate, for a pane header or a source line">
          <MockPlate announce={false} />
        </Specimen>
        <Specimen state="stale plate: a stale panel or tile">
          <StalePlate ageSec={9 * 3600} />
        </Specimen>
        <Specimen state="frame: a whole mocked panel" wide>
          <MockFrame heading="Sample plan">
            <p className="text-body-sm">
              Everything in this panel sits on a solid surface inside the hatched margin.
            </p>
          </MockFrame>
        </Specimen>
      </Section>

      <Section
        spec="disclaimer-block.md"
        title="Disclaimer"
        note="The one disclaimer constant of @colosseum/schemas, verbatim, at body size."
      >
        <Specimen state="English, with a heading" wide>
          <Disclaimer lang="en" heading="Not advice" />
        </Specimen>
        <Specimen state="Portuguese" wide>
          <Disclaimer lang="pt" />
        </Specimen>
        <Specimen state="a bilingual view: both" wide>
          <Disclaimer lang={['pt', 'en']} />
        </Specimen>
      </Section>

      <Section
        spec="data-table.md"
        title="Data table and execution list"
        note="Narrow the window below 640px to see a table of more than four columns stack."
      >
        <Specimen state="figures with pins, a row on watch, a mock row" wide>
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
        </Specimen>
        <Specimen state="dense (28px rows), a projected column, a source column" wide>
          <Card table>
            <DataTable
              caption="Stress cases"
              captionHidden
              dense
              rows={[
                {
                  name: 'Base',
                  end: '$40,900',
                  source: 'sample · 2026-10-01T14:02:11Z · schedule v1',
                },
                {
                  name: 'Rates down a third',
                  end: '$38,200',
                  source: 'sample · 2026-10-01T14:02:11Z · schedule v1',
                },
              ]}
              rowKey={(row) => row.name}
              columns={[
                { key: 'name', header: 'Case', cell: (row) => row.name },
                {
                  key: 'end',
                  header: 'Terminal balance',
                  numeric: true,
                  projected: true,
                  cell: (row) => row.end,
                },
                { key: 'source', header: 'Source', source: true, cell: (row) => row.source },
              ]}
            />
          </Card>
        </Specimen>
        <Specimen
          state="execution list: confirmed on a test network; failed, not retried, no link"
          wide
        >
          <ExecutionList executions={EXECUTIONS} />
        </Specimen>
      </Section>

      <Section spec="goal-card.md" title="Goal card">
        <Specimen state="on track">
          <GoalCard
            sentence="Your apartment fund is on track."
            status={{ kind: 'on-track', word: 'On track', date: 'June 2028' }}
            amount={{ figure: FIGURE.balance, labelValue: FIGURE.balanceValue, obs: LIVE_SPECIMEN }}
            detail="access to cash within 7 days"
            action={{ label: 'See your plan', href: '#goal-card-md' }}
          />
        </Specimen>
        <Specimen state="watch, an income goal, mock inputs">
          <GoalCard
            sentence="Your trip fund needs a look."
            status={{ kind: 'watch', word: 'Watch', date: 'March 2029' }}
            reason="A stress case breaks in month 14."
            detail="pays R$ 5.000 a month from January 2029"
            action={{ label: 'See your plan', href: '#goal-card-md' }}
            mock
          />
        </Specimen>
        <Specimen state="off track">
          <GoalCard
            sentence="Your house deposit is behind."
            status={{ kind: 'off-track', word: 'Off track', date: 'August 2028' }}
            reason="At this level you would land two months late."
            amount={{ figure: '$8,100 of $60,000', labelValue: '$8,100', obs: STALE_SPECIMEN }}
            detail="access to cash within 30 days"
            action={{ label: 'See your plan', href: '#goal-card-md' }}
          />
        </Specimen>
        <Specimen state="draft">
          <GoalCard
            state="draft"
            sentence="A year abroad in 2030."
            note="Draft: finish the sheet"
            action={{ label: 'Edit sheet', href: '#goal-card-md' }}
          />
        </Specimen>
        <Specimen state="loading">
          <GoalCard state="loading" sentence="" action={{ label: '', href: '#goal-card-md' }} />
        </Specimen>
        <Specimen state="header: the top of the plan view" wide>
          <GoalCard
            variant="header"
            sentence="Your apartment fund is on track."
            status={{ kind: 'on-track', word: 'On track', date: 'June 2028' }}
            amount={{ figure: FIGURE.balance, labelValue: FIGURE.balanceValue, obs: LIVE_SPECIMEN }}
            detail="access to cash within 7 days"
            meta="income · solver sample · 2026-10-01"
            action={{ label: 'Edit sheet', href: '#goal-card-md' }}
          />
        </Specimen>
      </Section>

      <Section
        spec="plan-leg.md"
        title="Plan legs"
        note="At most four legs in the bar: a fifth is refused as an engine error. Hover a label, or Tab to its pin, to mark its segment."
      >
        <Specimen state="four legs: live, stale, no yield, MOCK" wide>
          <PlanLegs legs={LEGS} profile="income" />
        </Specimen>
        <Specimen state="hero (24px), plan-lock: legs seat, then pins drop" wide>
          <PlanLock />
        </Specimen>
        <Specimen state="“Why this plan?”: the segments part and the reasons show" wide>
          <WhyThisPlan />
        </Specimen>
      </Section>

      <Section spec="exit-plan-line.md" title="Exit-plan line and panel">
        <Specimen state="measured" wide>
          <ExitPlanLine
            tiers={EXIT_TIERS}
            caveat="Weekend exits are slower and cost more."
            inKind="You can also take the tokens themselves out of the vault at any time."
          />
        </Specimen>
        <Specimen state="partly mock" wide>
          <ExitPlanLine tiers={[EXIT_FIRST, { text: 'the rest within 7 days', mock: true }]} />
        </Specimen>
        <Specimen state="not yet sourced: no numbers" wide>
          <ExitPlanLine unsourced="Yields and exit costs are sourced live after you connect." />
        </Specimen>
        <Specimen state="breach" wide>
          <ExitPlanLine
            tiers={EXIT_TIERS}
            alert={{
              status: 'off-track',
              text: 'Off track: in the rate-shock case, cash within 7 days drops to $2,100.',
            }}
          />
        </Specimen>
        <Specimen state="watch" wide>
          <ExitPlanLine
            tiers={EXIT_TIERS}
            alert={{
              status: 'watch',
              text: 'Watch: the weekend window is thinner than last month.',
            }}
          />
        </Specimen>
        <Specimen state="panel: “Access to cash” on the plan view" wide>
          <ExitPlanPanel
            tiers={EXIT_PANEL_TIERS}
            caveat="Weekend exits are slower and cost more."
          />
        </Specimen>
      </Section>

      <Section
        spec="constraint-sheet.md"
        title="Constraint sheet"
        note="With anything left to fix, “Build my plan” sends nothing: click it and focus moves to the list."
      >
        <Specimen state="valid" wide>
          <ConstraintSheet<Parsed>
            goalText="R$ 5.000 por mês a partir de 2029, posso precisar em 7 dias"
            source={SHEET_SOURCE}
            groups={sheetGroups(false)}
            capital={SHEET_CAPITAL}
            valid={PARSED}
            onChange={noop}
            onBuild={noop}
          />
        </Specimen>
        <Specimen state="invalid: the solve is blocked" wide>
          <ConstraintSheet<Parsed>
            groups={sheetGroups(true)}
            capital={SHEET_CAPITAL}
            valid={null}
            onChange={noop}
            onBuild={noop}
          />
        </Specimen>
        <Specimen state="parsing" wide>
          <ConstraintSheet<Parsed>
            state="parsing"
            groups={[]}
            valid={null}
            onChange={noop}
            onBuild={noop}
          />
        </Specimen>
        <Specimen state="solving: can be read, not changed" wide>
          <ConstraintSheet<Parsed>
            state="solving"
            groups={sheetGroups(false)}
            capital={SHEET_CAPITAL}
            valid={PARSED}
            onChange={noop}
            onBuild={noop}
          />
        </Specimen>
        <Specimen state="no plan fits" wide>
          <ConstraintSheet<Parsed>
            state="no-plan"
            groups={sheetGroups(false)}
            capital={SHEET_CAPITAL}
            valid={PARSED}
            binding="The 7-day window binds: nothing in the low risk budget pays R$ 5.000 a month from this capital."
            onChange={noop}
            onBuild={noop}
          />
        </Specimen>
        <Specimen state="read mode: the plan view" wide>
          <ConstraintSheet
            mode="read"
            groups={sheetGroups(false)}
            source={SHEET_SOURCE}
            editHref="#constraint-sheet-md"
          />
        </Specimen>
      </Section>

      <Section
        spec="composer.md"
        title="Composer"
        note="The only shape with round corners. Enter sends; Shift+Enter is a new line."
      >
        <Specimen state="empty: the send button is muted" wide>
          <Composer
            label="Your goal"
            placeholder="$40,000 by June 2028, cash within 7 days"
            hint="Enter to fit · Shift+Enter for a new line"
            onSubmit={noop}
          />
        </Specimen>
        <Specimen state="typed" wide>
          <Composer
            label="Your goal"
            defaultValue="$40,000 by June 2028, cash within 7 days"
            onSubmit={noop}
          />
        </Specimen>
        <Specimen state="busy: the still lattice, no spinner" wide>
          <Composer
            label="Your goal"
            defaultValue="$40,000 by June 2028, cash within 7 days"
            busy
            onSubmit={noop}
          />
        </Specimen>
        <Specimen state="error: the text is kept" wide>
          <Composer
            label="Your goal"
            defaultValue="soon, a lot"
            error="We couldn’t read that. Try an amount and a date."
            onSubmit={noop}
          />
        </Specimen>
        <Specimen state="disabled" wide>
          <Composer
            label="Your goal"
            defaultValue="$40,000 by June 2028"
            disabled
            onSubmit={noop}
          />
        </Specimen>
        <Specimen state="single line: the subscribe field" wide>
          <div className="max-w-[520px]">
            <Composer
              variant="single"
              label="Email address"
              inputType="email"
              autoComplete="email"
              name="email"
              placeholder="you@example.com"
              sendText="Subscribe"
              labels={{ submit: 'Subscribe' }}
              onSubmit={noop}
            />
          </div>
        </Specimen>
        <Specimen state="suggestion chips sit outside it, square" wide>
          <div className="flex flex-wrap gap-2">
            <Button variant="chip">$40,000 by June 2028</Button>
            <Button variant="chip">R$ 5.000 a month from 2029</Button>
          </div>
        </Specimen>
      </Section>

      <Section
        spec="compact-nav.md"
        title="Compact nav (marketing)"
        note="On the landing page the bar is fixed to the top of the window; here each state is held inside a frame. The mark is the provisional one from the guidelines."
      >
        <Specimen state="full: the hero, steps 01 and 02" wide>
          {/* a transform makes this frame the containing block of the fixed bar */}
          <div className="relative h-24 translate-x-0 overflow-hidden border border-border bg-background">
            <CompactNav
              compact={false}
              symbol={<Mark size={24} />}
              wordmark="tenonfi"
              homeLabel="tenonfi home"
              links={NAV_LINKS}
              cta={{ label: 'Sign in', href: '#compact-nav-md' }}
              contentId="compact-nav-md"
            />
          </div>
        </Specimen>
        <Specimen state="compact: from step 03" wide>
          <div className="relative h-40 translate-x-0 overflow-hidden border border-border bg-background">
            <CompactNav
              symbol={<Mark size={24} />}
              wordmark="tenonfi"
              homeLabel="tenonfi home"
              links={NAV_LINKS}
              cta={{ label: 'Sign in', href: '#compact-nav-md' }}
              contentId="compact-nav-md"
            />
          </div>
        </Specimen>
      </Section>

      <Section
        spec="embed-shell.md"
        title="Embed shell"
        note="Inside a partner’s app the brand recedes. The first frame is an example partner (their colours, their serif, their 14px radius); the second sets nothing and falls back to system colours."
      >
        <Specimen state="an example partner’s skin" wide>
          <div className="max-w-[640px]">
            <div style={PARTNER}>
              <EmbedShell
                label="Plan by tenonfi"
                lang="en"
                title="Apartment fund"
                lead="$40,000 by June 2028 · cash within 7 days"
                credit={CREDIT}
              >
                <PlanLegs legs={LEGS} />
                <ExitPlanLine tiers={EXIT_TIERS} />
                <Disclaimer lang="en" />
                <ExecutionList executions={EXECUTIONS.slice(0, 1)} />
              </EmbedShell>
            </div>
          </div>
        </Specimen>
        <Specimen state="no partner variables: system colours">
          <EmbedShell
            label="Plan by tenonfi"
            title="Trip fund"
            lead="R$ 5.000 a month from January 2029"
            credit={{ name: 'tenonfi', href: '#embed-shell-md' }}
          >
            <ExitPlanLine tiers={[EXIT_FIRST, { text: 'the rest within 7 days', mock: true }]} />
          </EmbedShell>
        </Specimen>
        <Specimen state="the partner’s muted colour is too faint: no hatch, MOCK stays">
          <EmbedShell
            label="Plan by tenonfi"
            title="Trip fund"
            credit={{ name: 'tenonfi', href: '#embed-shell-md' }}
            suppressHatch
          >
            <ExitPlanLine tiers={[EXIT_FIRST, { text: 'the rest within 7 days', mock: true }]} />
          </EmbedShell>
        </Specimen>
        <Specimen state="loading">
          <EmbedShell label="Plan by tenonfi" state="loading" />
        </Specimen>
        <Specimen state="not available">
          <EmbedShell label="Plan by tenonfi" state="unavailable" />
        </Specimen>
      </Section>
      <Section
        spec="subscribe-block.md"
        title="Subscribe block (marketing)"
        note="The one centred composition. The field is the composer, on one line; the page works out the status and this block says it. The photograph is the page’s to supply and is not shown here."
      >
        <Specimen state="rest" wide>
          <Subscribe status="rest" />
        </Specimen>
        <Specimen state="invalid email">
          <Subscribe status="invalid-email" />
        </Specimen>
        <Specimen state="no option ticked">
          <Subscribe status="no-option" />
        </Specimen>
        <Specimen state="submitting">
          <Subscribe status="submitting" />
        </Specimen>
        <Specimen state="success">
          <Subscribe status="success" />
        </Specimen>
        <Specimen state="already on the list">
          <Subscribe status="already" />
        </Specimen>
        <Specimen state="server error">
          <Subscribe status="error" />
        </Specimen>
      </Section>

      <Section
        spec="bearing-heatmap-tile.md"
        title="Bearing heatmap tile"
        note="Hours with no sample are the ground with an en dash, never hatched: the hatch means MOCK or stale. The grid is one tab stop; the arrow keys move through the hours."
      >
        <Specimen state="live" wide>
          <HeatSample obs={LIVE_SPECIMEN} state={{ kind: 'live' }} />
        </Specimen>
        <Specimen state="stale: band and plate, the pin hollow" wide>
          <HeatSample obs={STALE_SPECIMEN} state={{ kind: 'stale', ageSec: 9 * 3600 }} />
        </Specimen>
        <Specimen state="MOCK: band and plate, the pin hatched" wide>
          <HeatSample obs={MOCK_OBS} state={{ kind: 'mock' }} />
        </Specimen>
      </Section>

      <div className="tf-app light border-t border-border px-6 py-10">
        <h2 className="text-h3 font-semibold">Not built</h2>
        <ul className="mt-3 flex max-w-(--tf-measure-body) list-disc flex-col gap-2 pl-5 text-body-sm">
          <li>
            goal-showcase-case.md: a marketing composite that needs photographs and a chart that has
            no spec of its own yet.
          </li>
          <li>
            joint-stage.md: the 3D hero. It needs the joint’s model and the final logo artwork.
          </li>
          <li>
            mock-plate.md, the code placement: the API serves its own docs, so nothing in this app
            shows a code example.
          </li>
        </ul>
      </div>
    </div>
  );
}
