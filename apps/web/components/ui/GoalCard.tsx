import type { ChainId } from '@colosseum/schemas';
import { useId } from 'react';
import { Button } from './Button';
import { ChainBadge } from './ChainBadge';
import { cn } from './cn';
import { HatchBand, SampleNote } from './internal/mock-parts';
import { LatticeStatus } from './Lattice';
import { ProvenancePin } from './ProvenancePin';
import type { PinLabels, PinSource } from './provenance';
import { Status, type StatusKind, statusWord } from './StatusMark';

// goal-card.md. One goal, one sentence, where it stands, and where to look next. The card answers a
// person; it does not sell yield. No photograph, no pattern, no leaderboard, no big rate, no progress
// ring. The sentence is the only serif on the card, and the status comes from the engine.

export type GoalCardLabels = {
  /** While the card waits for its goal. */
  loading: string;
  /** A sample card's one quiet line (MOCK-QUIET). */
  sample: string;
};
export const GOAL_CARD_LABELS: GoalCardLabels = {
  loading: 'Loading your goal',
  sample: 'Sample figures',
};

export type GoalCardAmount = {
  /** The current value as shown: "$12,480 of $40,000". It is a priced figure, so it carries a pin. */
  figure: string;
  /** The priced part alone, for the pin's accessible name: "$12,480". */
  labelValue?: string;
  obs: PinSource | null;
};

type Common = {
  /** The goal in the person's words: "Your apartment fund is on track." */
  sentence: string;
  /** The one action: "See your plan". */
  action: { label: string; href: string };
  /** `card` in a list; `header` at the top of the plan view, where the sentence is the page's heading. */
  variant?: 'card' | 'header';
  /** Header only: profile · solver version · created. */
  meta?: string;
  /** An input of this plan is not live: a hatch band on the left edge and one quiet line. */
  mock?: boolean;
  /** The chain the goal's plan or vault is on, as a badge after the status. */
  chain?: ChainId;
  labels?: Partial<GoalCardLabels>;
  className?: string;
};

export type GoalCardProps = Common &
  (
    | {
        state?: 'ready';
        /**
         * From the engine, never worked out here. The word is always shown beside the mark: a card
         * handed an empty word throws.
         */
        status: { kind: StatusKind; word: string; date: string } | null;
        /**
         * Said in place of the status when the engine gives none: the card never works one out. The
         * date still stands beside it.
         */
        noStatus?: { sentence: string; date?: string };
        /** One sentence of reason, when the goal is on watch or off track. The card is not tinted. */
        reason?: string;
        amount?: GoalCardAmount;
        /** After the amount: "access to cash within 7 days". For an income goal, what it pays and from when. */
        detail?: string;
        /** The pin's words, in the language of the view. */
        pinLabels?: Partial<PinLabels>;
      }
    | {
        /** The sheet is not validated yet: no status mark and no amount. */
        state: 'draft';
        /** "Draft: finish the sheet". */
        note: string;
      }
    | { state: 'loading' }
  );

export function GoalCard(props: GoalCardProps) {
  const {
    sentence,
    action,
    variant = 'card',
    meta,
    mock = false,
    chain,
    labels,
    className,
  } = props;
  const sentenceId = useId();
  const header = variant === 'header';
  const Heading = header ? 'h1' : 'h3';

  if (props.state === 'loading')
    return (
      <article
        data-ui="goal-card"
        data-state="loading"
        className={cn('rounded-md border border-border bg-card p-6', className)}
      >
        <LatticeStatus label={labels?.loading ?? GOAL_CARD_LABELS.loading} />
      </article>
    );

  return (
    <article
      data-ui="goal-card"
      data-state={props.state ?? 'ready'}
      aria-labelledby={sentenceId}
      className={cn(
        'group/goal relative flex rounded-md border border-border bg-card text-card-foreground transition-colors hover:border-input',
        className,
      )}
    >
      {mock && <HatchBand />}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3 p-6">
        <Heading
          id={sentenceId}
          className={cn(
            'max-w-(--tf-measure-display) font-display font-normal text-balance',
            header ? 'text-display' : "text-h3 [font-variation-settings:'opsz'_36]",
          )}
        >
          {sentence}
        </Heading>

        {props.state === 'draft' ? (
          <p className="text-caption font-medium text-foreground">{props.note}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {props.status ? (
                <Status status={props.status.kind}>
                  {statusWord(props.status.word)} · {props.status.date}
                </Status>
              ) : (
                props.noStatus && (
                  <p data-ui="goal-no-status" className="text-caption text-muted-foreground">
                    {props.noStatus.sentence}
                    {props.noStatus.date ? ` · ${props.noStatus.date}` : ''}
                  </p>
                )
              )}
              {chain && <ChainBadge chain={chain} />}
            </div>
            {props.reason && <p className="text-body-sm text-foreground">{props.reason}</p>}
            {(props.amount || props.detail) && (
              <p className="text-body-sm tabular-nums">
                {props.amount && (
                  <ProvenancePin
                    value={props.amount.figure}
                    labelValue={props.amount.labelValue}
                    obs={props.amount.obs}
                    labels={props.pinLabels}
                  />
                )}
                {props.amount && props.detail && ' · '}
                {props.detail}
              </p>
            )}
          </>
        )}

        {props.state === 'draft' && chain && <ChainBadge chain={chain} />}
        {mock && <SampleNote line={labels?.sample ?? GOAL_CARD_LABELS.sample} />}
        {header && meta && <p className="text-caption text-muted-foreground">{meta}</p>}
        <Button
          variant="link"
          href={action.href}
          className="after:absolute after:inset-0 group-hover/goal:decoration-2"
        >
          {action.label}
        </Button>
      </div>
    </article>
  );
}
