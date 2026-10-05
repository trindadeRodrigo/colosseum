import { Fragment, type ReactNode } from 'react';
import { Card, CardBody, CardHeader } from './Card';
import { cn } from './cn';
import { DataTable } from './DataTable';
import { HatchBand, MockWord } from './internal/mock-parts';
import { ProvenancePin } from './ProvenancePin';
import { type PinSource, pinState } from './provenance';
import { Status, type StatusKind } from './StatusMark';

// exit-plan-line.md. Every portfolio says how the money comes back out before the agent invests: how
// much, how fast, at what cost. The exit is tiers in time, and a cost is always "≤" or "about", never
// a promise. The line is the compact form; the panel is "Access to cash" on the plan view.
// No door, no log-out arrow, no parachute: the exit is designed, not escaped.

/** The exit-plan glyph: a dovetail lifted out the way it went in (iconography.md, section 4.2). */
export function ExitGlyph({ size = 16, className }: { size?: 16 | 24; className?: string }) {
  return (
    <svg
      data-ui="exit-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(1.5 * 24) / size}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      {/* the base member, with the tapered socket cut from its top edge */}
      <path d="M3 15H8L9.5 19H14.5L16 15H21V21H3Z" />
      {/* the tail, lifted clear */}
      <path d="M8 6H16L14.5 10H9.5Z" />
      {/* its travel: dashed, because it is a path and not an event. Dropped in the 16px cut */}
      {size === 24 && <path d="M12 19V3" strokeDasharray="3 1.5 0.01 1.5" />}
    </svg>
  );
}

export type ExitAlert = {
  /** `off-track` when a stress case breaks the window, `watch` when it comes close. */
  status: Extract<StatusKind, 'watch' | 'off-track'>;
  /** The word and the reason: "Off track: in the rate-shock case, cash within 7 days drops to $2,100." */
  text: string;
};

export type ExitTier = {
  /** "up to $4,000 within a day". Use "up to", "within", "about": never a guarantee. */
  text: string;
  /** A cost or a price in this tier, with its source: "≤ 0.50%". */
  cost?: { figure: string; obs: PinSource | null; detail?: string };
  /** This tier is not live: it carries the hatch band and the MOCK plate. */
  mock?: boolean;
};

export type ExitPlanLabels = {
  /** The name of the line. */
  exitPlan: string;
  /** The heading of the panel. */
  accessToCash: string;
  /** Where the dimension line starts. */
  today: string;
  /** The columns of the panel's table. */
  tier: string;
  amount: string;
  time: string;
  cost: string;
  route: string;
  /** Before a tier's cost in the line. */
  costPrefix: string;
};
export const EXIT_PLAN_LABELS: ExitPlanLabels = {
  exitPlan: 'Exit plan',
  accessToCash: 'Access to cash',
  today: 'today',
  tier: 'Tier',
  amount: 'Amount',
  time: 'Within',
  cost: 'Estimated cost',
  route: 'Route',
  costPrefix: 'cost',
};

type Shared = {
  /** A stress case breaks the window, or comes close: the mark, the word and the reason. */
  alert?: ExitAlert;
  /** A second line: "Weekend exits are slower and cost more." */
  caveat?: string;
  /**
   * Taking the tokens themselves out of the vault. It is its own line and is not called access to
   * cash (DESIGN-VAULT.md, section 11).
   */
  inKind?: string;
  labels?: Partial<ExitPlanLabels>;
  className?: string;
};

export type ExitPlanLineProps = Shared &
  (
    | { tiers: readonly ExitTier[]; unsourced?: undefined }
    /** Before anything is sourced (landing, simulator): a sentence, and no numbers. */
    | { tiers?: undefined; unsourced: string }
  );

const tierIsMock = (tier: ExitTier) =>
  tier.mock === true || (tier.cost !== undefined && pinState(tier.cost.obs) === 'mock');

export function ExitPlanLine({
  tiers,
  unsourced,
  alert,
  caveat,
  inKind,
  labels,
  className,
}: ExitPlanLineProps) {
  const text = { ...EXIT_PLAN_LABELS, ...labels };
  return (
    <div
      data-ui="exit-plan-line"
      className={cn('border-l-2 border-primary pl-3 text-body-sm', className)}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
        <ExitGlyph className="text-muted-foreground" />
        <span className="font-medium">{text.exitPlan}</span>
        {tiers === undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-muted-foreground">{unsourced}</span>
          </>
        ) : (
          tiers.map((tier) => {
            const mock = tierIsMock(tier);
            const plated = tier.cost !== undefined && pinState(tier.cost.obs) === 'mock';
            return (
              <Fragment key={tier.text}>
                <span aria-hidden="true">·</span>
                <span
                  data-mock={mock || undefined}
                  className={cn('inline-flex items-center gap-2', mock && 'min-h-5')}
                >
                  {mock && <HatchBand />}
                  <span>
                    {tier.text}
                    {tier.cost && (
                      <>
                        {tier.text && ' · '}
                        {text.costPrefix}{' '}
                        <ProvenancePin
                          value={tier.cost.figure}
                          obs={tier.cost.obs}
                          detail={tier.cost.detail}
                        />
                      </>
                    )}
                  </span>
                  {mock && !plated && <MockWord />}
                </span>
              </Fragment>
            );
          })
        )}
      </p>
      {alert && (
        <p className="mt-1">
          <Status status={alert.status}>{alert.text}</Status>
        </p>
      )}
      {caveat && <p className="mt-1 text-muted-foreground">{caveat}</p>}
      {inKind && <p className="mt-1">{inKind}</p>}
    </div>
  );
}

export type ExitPanelTier = {
  id: string;
  /** "1", "2": the order money comes out. */
  label: string;
  /** "$4,000". */
  amount: string;
  /** "1 day". */
  time: string;
  /** The estimated cost with its source, or null when the tier has none (cash). */
  cost: { figure: string; obs: PinSource | null; detail?: string } | null;
  /** How it comes out: "redeem USDY", "sell on Jupiter at the thinnest hour". */
  route: string;
  mock?: boolean;
};

export type ExitPlanPanelProps = Shared & {
  tiers: readonly ExitPanelTier[];
  /** The heading level of "Access to cash". */
  level?: 2 | 3 | 4;
  /** Under the table: the full line's caveat, or a link to how exits are measured. */
  footer?: ReactNode;
};

/** A 45° architect's tick on a dimension line. */
function Tick({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
      className={cn('absolute -top-[5px]', className)}
    >
      <path d="M0.5 9.5L9.5 0.5" />
    </svg>
  );
}

export function ExitPlanPanel({
  tiers,
  alert,
  caveat,
  inKind,
  level = 3,
  footer,
  labels,
  className,
}: ExitPlanPanelProps) {
  const text = { ...EXIT_PLAN_LABELS, ...labels };
  const panelIsMock = (tier: ExitPanelTier) =>
    tier.mock === true || (tier.cost !== null && pinState(tier.cost.obs) === 'mock');
  return (
    <Card as="section" className={className}>
      <CardHeader
        level={level}
        title={
          <span className="inline-flex items-center gap-2">
            <ExitGlyph size={24} className="text-muted-foreground" />
            {text.accessToCash}
          </span>
        }
      />
      <CardBody className="flex flex-col gap-6">
        {/* The drawing repeats the table for the eye; the table carries the content. */}
        <div
          aria-hidden="true"
          data-ui="exit-dimension"
          className="grid auto-cols-fr grid-flow-col font-mono text-source"
        >
          {tiers.map((tier, index) => (
            <div key={tier.id} className="min-w-0">
              <p className="truncate px-2 pb-1 text-center">{tier.amount}</p>
              {/* dashed: projected, not measured */}
              <div className="relative border-t border-dashed border-foreground">
                {index === 0 && <Tick className="-left-[5px]" />}
                <Tick className="-right-[5px]" />
              </div>
              <p className="flex justify-between gap-2 pt-2 text-muted-foreground">
                <span>{index === 0 ? text.today : ''}</span>
                <span>{tier.time}</span>
              </p>
            </div>
          ))}
        </div>

        <DataTable
          caption={text.accessToCash}
          captionHidden
          rows={tiers}
          rowKey={(tier) => tier.id}
          rowMock={panelIsMock}
          columns={[
            { key: 'tier', header: text.tier, rowHeader: true, cell: (tier) => tier.label },
            { key: 'amount', header: text.amount, numeric: true, cell: (tier) => tier.amount },
            { key: 'time', header: text.time, cell: (tier) => tier.time },
            {
              key: 'cost',
              header: text.cost,
              numeric: true,
              cell: (tier) =>
                tier.cost === null ? (
                  '—'
                ) : (
                  <ProvenancePin
                    value={tier.cost.figure}
                    obs={tier.cost.obs}
                    detail={tier.cost.detail}
                  />
                ),
            },
            { key: 'route', header: text.route, cell: (tier) => tier.route },
          ]}
        />

        {alert && (
          <p>
            <Status status={alert.status}>{alert.text}</Status>
          </p>
        )}
        {caveat && <p className="text-body-sm text-muted-foreground">{caveat}</p>}
        {inKind && <p className="text-body-sm">{inKind}</p>}
        {footer}
      </CardBody>
    </Card>
  );
}
