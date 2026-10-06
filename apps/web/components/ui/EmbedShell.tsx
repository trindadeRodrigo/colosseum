import type { CSSProperties, ReactNode } from 'react';
import { cn } from './cn';
import { Skeleton } from './Skeleton';

// embed-shell.md. Inside a partner's app the brand recedes: the partner's colours, font, radius and
// buttons take over. What survives is the proof: the pin and its popover, the hatch with the word
// MOCK, hairline structure, the disclaimer, explorer links, and a small credit.
//
// The shell is read-only: no navigation, no wallet, nothing to sign. It is a section, not a main: the
// host owns the landmarks. The receding is done in CSS (`tf-embed` in globals.css): the primitives
// placed inside read the partner's variables without knowing they are in an embed.
//
// The bare root it is placed in (no bar, no wallet, no font of ours) is `app/(embed)/layout.tsx`.

export type EmbedShellLabels = {
  loading: string;
  /** Under the loading line after a few seconds: the data service may be waking. */
  slow: string;
  unavailable: string;
  /** The summary of the schedule's disclosure, in a narrow container. */
  showSchedule: string;
  poweredBy: string;
};
export const EMBED_SHELL_LABELS: EmbedShellLabels = {
  loading: 'Loading plan…',
  slow: 'Waking the data service: this can take up to a minute the first time.',
  unavailable: 'This plan isn’t available.',
  showSchedule: 'Show schedule',
  poweredBy: 'Powered by',
};

export type EmbedCredit = {
  /** The name, as text in the partner's face. */
  name: string;
  /** The public page of this plan. Opens in a new tab. */
  href: string;
  /** The small cut of the symbol, one colour (`currentColor`). Left out, the credit is text only. */
  symbol?: ReactNode;
};

type Common = {
  /** The accessible name of the section: "Plan by tenonfi". */
  label: string;
  /** The plan's language. */
  lang?: string;
  labels?: Partial<EmbedShellLabels>;
  className?: string;
};

export type EmbedShellProps = Common &
  (
    | {
        state?: 'ready';
        /** The goal's name, in the partner's face. Never the serif. */
        title: string;
        /** The goal in one line: "$40,000 by June 2028 · cash within 7 days". */
        lead?: string;
        /** The plan: legs, the exit-plan line, the disclaimer, the transactions. */
        children: ReactNode;
        /**
         * The schedule chart. It sits beside the plan from 560px of width, under it below that, and
         * behind a "Show schedule" disclosure under 360px.
         */
        schedule?: ReactNode;
        credit: EmbedCredit;
        /**
         * The partner's muted colour is too faint on their ground (under 4.5:1): the hatch is not drawn
         * and the word MOCK stays. The embed's own check decides this; the shell obeys.
         */
        suppressHatch?: boolean;
      }
    | {
        state: 'loading';
        /** The wait has lasted a few seconds: one calm line says the data service may be waking. */
        slow?: boolean;
      }
    /** Not found, or revoked: one sentence and nothing else. */
    | { state: 'unavailable' }
  );

export function EmbedShell(props: EmbedShellProps) {
  const { label, lang, labels, className } = props;
  const text = { ...EMBED_SHELL_LABELS, ...labels };
  const frame = {
    'data-ui': 'embed-shell',
    'aria-label': label,
    lang,
    className: cn('tf-embed', className),
  };

  // Words and still boxes: in a partner's app the loader does not move (embed-shell.md, "Loading").
  if (props.state === 'loading')
    return (
      <section {...frame} data-state="loading" aria-busy="true">
        <span aria-hidden="true" className="mb-[0.75em] flex flex-col gap-[0.5em]">
          <Skeleton className="h-[1.25em] w-3/5" />
          <Skeleton className="h-[0.875em] w-full" />
          <Skeleton className="h-[0.875em] w-4/5" />
        </span>
        <p role="status">
          {text.loading}
          {props.slow && (
            <span data-ui="embed-slow" className="block text-muted-foreground">
              {text.slow}
            </span>
          )}
        </p>
      </section>
    );
  if (props.state === 'unavailable')
    return (
      <section {...frame} data-state="unavailable">
        <p>{text.unavailable}</p>
      </section>
    );

  const { title, lead, children, schedule, credit, suppressHatch = false } = props;
  return (
    <section
      {...frame}
      data-state="ready"
      style={suppressHatch ? ({ '--tf-hatch': 'transparent' } as CSSProperties) : undefined}
    >
      <h2 className="text-[length:var(--tf-e-title)] leading-tight font-semibold @max-[359px]:text-[length:var(--tf-e-lead)]">
        {title}
      </h2>
      {lead && <p className="mt-[0.5em] text-[length:var(--tf-e-lead)] leading-snug">{lead}</p>}
      <div className="mt-[1em] grid gap-[1em] border-t border-border pt-[1em] @min-[560px]:grid-cols-2">
        <div
          className={cn('flex min-w-0 flex-col gap-[1em]', !schedule && '@min-[560px]:col-span-2')}
        >
          {children}
        </div>
        {schedule && (
          <>
            <div data-ui="embed-schedule" className="min-w-0 @max-[359px]:hidden">
              {schedule}
            </div>
            <details data-ui="embed-schedule-disclosure" className="@min-[360px]:hidden">
              <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {text.showSchedule}
              </summary>
              <div className="mt-[0.5em]">{schedule}</div>
            </details>
          </>
        )}
      </div>
      <p className="mt-[1em] border-t border-border pt-[0.75em] text-[length:var(--tf-e-credit)] text-muted-foreground">
        <a
          data-ui="embed-credit"
          href={credit.href}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-[0.4em] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {text.poweredBy}
          {credit.symbol}
          <span>{credit.name}</span>
        </a>
      </p>
    </section>
  );
}
