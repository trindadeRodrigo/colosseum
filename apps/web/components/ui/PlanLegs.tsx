import type { AssetKind, Profile } from '@colosseum/schemas';
import type { CSSProperties } from 'react';
import { cn } from './cn';
import { HatchBand, MockWord } from './internal/mock-parts';
import { ProvenancePin } from './ProvenancePin';
import { type PinSource, pinState } from './provenance';

// plan-leg.md. The plan as pieces: a stacked bar of at most four legs, each with its own label right
// under it. The bar shows proportion; the labels carry the meaning. Never a legend away from the bar,
// never a donut, never rounded segments.
//
// Four legs is the limit of the bar, not of a plan: a plan with more assets shows its sleeves here and
// the tokens of each sleeve in a table under it (DESIGN-VAULT.md, section 11).

export type PlanLeg = {
  id: string;
  /** "Tokenized treasuries". The BRL leg is named by its parameters, never by a partner's product. */
  name: string;
  /** The share of the plan, 0 to 1. It sets the width of the segment. */
  weight: number;
  /** The share as shown: "45%". */
  weightLabel: string;
  /** The asset kind, when known. An income plan with an equity leg is refused. */
  kind?: AssetKind;
  /**
   * The yield after haircut, with its source, and the quoted rate beside it. Null for a leg with no
   * yield (cash), shown as a dash. Never the quoted rate alone, and never a rate without a pin.
   */
  rate: {
    afterHaircut: string;
    quoted?: string;
    obs: PinSource | null;
    /** The second line of the pin's popover: the quoted rate, the rate after haircut, and the rule. */
    detail?: string;
  } | null;
  /** After the rate: "reachable today", "integration in progress". */
  note?: string;
  /** One line of why this leg is in the plan. */
  why?: string;
  /** Not live. The segment is hatched, and the label carries the hatch band and the sample glyph. */
  mock?: boolean;
};

export type PlanLegsLabels = {
  /** After the rate: "after haircut". */
  afterHaircut: string;
  /** Before the quoted rate. `{rate}` is the figure. */
  quoted: string;
};
export const PLAN_LEGS_LABELS: PlanLegsLabels = {
  afterHaircut: 'after haircut',
  quoted: 'quoted {rate}',
};

export type PlanLegsProps = {
  /** In the solver's order, largest first. At most four. */
  legs: readonly PlanLeg[];
  /** The plan's profile. An income plan may not hold an equity leg. */
  profile?: Profile;
  /** 12px, or 24px at the top of a consumer plan. */
  size?: 'default' | 'hero';
  /** Play the plan-lock once: the legs slide and seat, then the pins drop. */
  lock?: boolean;
  /**
   * "Why this plan?": true parts the segments and shows each leg's `why`; false closes them again.
   * Left out, the `why` lines are simply shown.
   */
  parted?: boolean;
  labels?: Partial<PlanLegsLabels>;
  className?: string;
};

const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;
// The segment that matches a hovered or focused label gets a 2px rule on top. Nothing is dimmed.
const MARK = [
  'group-has-[[data-leg="0"]:is(:hover,:focus-within)]/legs:border-t-2',
  'group-has-[[data-leg="1"]:is(:hover,:focus-within)]/legs:border-t-2',
  'group-has-[[data-leg="2"]:is(:hover,:focus-within)]/legs:border-t-2',
  'group-has-[[data-leg="3"]:is(:hover,:focus-within)]/legs:border-t-2',
] as const;
/** How far each of n segments moves when the bar parts, in px: 12 to 24 between neighbours. */
const PART = 16;

export const MAX_LEGS = 4;

export function PlanLegs({
  legs,
  profile,
  size = 'default',
  lock = false,
  parted,
  labels,
  className,
}: PlanLegsProps) {
  if (legs.length > MAX_LEGS)
    throw new Error(
      `PlanLegs takes at most ${MAX_LEGS} legs and was given ${legs.length}. This is an engine error, not something to squeeze into the bar: group the plan into sleeves.`,
    );
  if (
    process.env.NODE_ENV !== 'production' &&
    profile === 'income' &&
    legs.some((leg) => leg.kind === 'equity')
  )
    throw new Error(
      'PlanLegs: an income plan may not hold tokenized stocks, and this one has an equity leg. The asset registry should have refused it.',
    );

  const text = { ...PLAN_LEGS_LABELS, ...labels };
  const isMock = (leg: PlanLeg) =>
    leg.mock === true || (leg.rate !== null && pinState(leg.rate.obs) === 'mock');

  return (
    <div data-ui="plan-legs" className={cn('group/legs', className)}>
      <div
        aria-hidden="true"
        data-ui="plan-legs-bar"
        className={cn('flex gap-0.5 bg-background', size === 'hero' ? 'h-6' : 'h-3')}
      >
        {legs.map((leg, index) => {
          const offset = (index - (legs.length - 1) / 2) * PART;
          return (
            <div
              key={leg.id}
              data-leg={index}
              style={
                {
                  width: `${leg.weight * 100}%`,
                  animationDelay: lock ? `calc(${index} * var(--tf-stagger))` : undefined,
                  transform: parted ? `translateX(${offset}px)` : undefined,
                } as CSSProperties
              }
              className={cn(
                'min-w-0.5 rounded-none border-foreground transition-transform duration-(--tf-dur-slide) ease-seat motion-reduce:transition-none',
                isMock(leg) ? 'tf-hatch bg-card' : FILL[index],
                MARK[index],
                lock && 'animate-seat',
              )}
            />
          );
        })}
      </div>

      <ol className="mt-3 divide-y divide-border border-y border-border">
        {legs.map((leg, index) => {
          const mock = isMock(leg);
          // A rate with no source is not shown, and neither is anything said about it.
          const sourced = leg.rate !== null && pinState(leg.rate.obs) !== 'missing';
          return (
            <li
              key={leg.id}
              data-leg={index}
              data-mock={mock || undefined}
              style={
                lock
                  ? ({
                      '--tf-delay-pin': `calc(var(--tf-dur-slide) + 120ms + ${index} * var(--tf-stagger))`,
                    } as CSSProperties)
                  : undefined
              }
              className="flex gap-3"
            >
              {mock && <HatchBand />}
              <div className="min-w-0 flex-1 py-3">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2.5 shrink-0',
                      mock ? 'tf-hatch border border-hatch' : FILL[index],
                    )}
                  />
                  <span className="font-medium">{leg.name}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{leg.weightLabel}</span>
                  <span aria-hidden="true">·</span>
                  {leg.rate === null ? (
                    <span>—</span>
                  ) : (
                    <span className="font-mono">
                      <ProvenancePin value={leg.rate.afterHaircut} obs={leg.rate.obs} drop={lock} />
                    </span>
                  )}
                  {sourced && <span>{text.afterHaircut}</span>}
                  {mock && (leg.rate === null || pinState(leg.rate.obs) !== 'mock') && <MockWord />}
                  {sourced && leg.rate?.quoted && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-muted-foreground">
                        {text.quoted.replace('{rate}', leg.rate.quoted)}
                      </span>
                    </>
                  )}
                  {leg.note && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{leg.note}</span>
                    </>
                  )}
                </p>
                {leg.why && (
                  <p
                    hidden={parted === false}
                    className={cn(
                      'mt-1 pl-4.5 text-caption text-muted-foreground',
                      parted === true && 'animate-[fade_var(--tf-dur-fade)_linear_both]',
                    )}
                  >
                    {leg.why}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
