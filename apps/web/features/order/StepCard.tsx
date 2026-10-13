'use client';
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';

// Steps on one card, one open at a time (gate BUY-STEPS): above them, where the person is, each step's
// number and name, filled once it is done; under that, each step with its heading, which opens it, and
// its panel. Opening a step moves the focus to its heading. The buy and the withdrawal share it: what
// a step holds, and when it is done, is theirs.

export type StepDef<Id extends string> = {
  id: Id;
  name: string;
  done: boolean;
  /** Said beside the heading of a step that is closed. */
  summary?: string | null;
  panel: ReactNode;
};

export function StepCard<Id extends string>({
  ui,
  label,
  doneWord,
  steps,
  open,
  onOpen,
  mock = false,
  mockAnnounce,
  note,
}: {
  /** The prefix of the `data-ui` names: `buy` gives `buy-steps`, `buy-progress`, `buy-step`. */
  ui: string;
  label: string;
  /** Read after a done step's name by a screen reader. */
  doneWord: string;
  steps: readonly StepDef<Id>[];
  open: Id;
  onOpen: (step: Id) => void;
  /** On the mock: the card's hatch band and its one quiet line at the foot (MOCK-QUIET). A card labelled
   * so draws its steps inside another element, so a caller keeps this steady while it reads: a label
   * that came and went would make every step again and drop the focus.
   */
  mock?: boolean;
  mockAnnounce?: string;
  /** One quiet line at the top, for figures of a test network: real reads, not samples. */
  note?: string | null;
}) {
  const ids = useId();
  const heads = useRef(new Map<Id, HTMLButtonElement | null>());
  const mounted = useRef(false);

  // Opening a step moves the focus to its heading; nothing is focused when the card first shows.
  // Before the browser paints the step, so no frame shows it open with the focus on what was hidden.
  useLayoutEffect(() => {
    if (mounted.current) heads.current.get(open)?.focus();
    mounted.current = true;
  }, [open]);

  return (
    <Card
      as="section"
      aria-label={label}
      mock={mock}
      mockLabels={{ announce: mockAnnounce }}
      className="max-w-3xl"
    >
      <div data-ui={`${ui}-steps`}>
        {note && (
          <p
            data-ui="data-note"
            className="px-6 pt-5 text-caption text-muted-foreground [overflow-wrap:anywhere]"
          >
            {note}
          </p>
        )}
        <ol
          data-ui={`${ui}-progress`}
          aria-label={label}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 p-6 text-body-sm sm:gap-x-5"
        >
          {steps.map((step, i) => (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done}
              aria-current={open === step.id ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-2',
                open === step.id ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              <StepNumber n={i + 1} done={step.done} current={open === step.id} />
              {/* On a phone the open step alone is named; the others keep their name for a reader. */}
              <span className={cn(open !== step.id && 'max-sm:sr-only')}>{step.name}</span>
              {step.done && <span className="sr-only">, {doneWord}</span>}
            </li>
          ))}
        </ol>
        {steps.map((step, i) => {
          const head = `${ids}-${step.id}-head`;
          const panel = `${ids}-${step.id}-panel`;
          const isOpen = open === step.id;
          return (
            <section
              key={step.id}
              data-ui={`${ui}-step`}
              data-step={step.id}
              data-open={isOpen}
              data-done={step.done}
              aria-labelledby={head}
              className="border-t border-border"
            >
              <h2 className="text-h4 font-semibold">
                <button
                  ref={(el) => {
                    heads.current.set(step.id, el);
                  }}
                  id={head}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panel}
                  onClick={() => onOpen(step.id)}
                  className="flex w-full items-center gap-3 px-6 py-4 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <StepNumber n={i + 1} done={step.done} current={isOpen} />
                  <span className="min-w-0 flex-1">
                    {step.name}
                    {step.done && <span className="sr-only">, {doneWord}</span>}
                  </span>
                  {!isOpen && step.summary && (
                    <span className="min-w-0 text-right text-body-sm font-normal text-muted-foreground [overflow-wrap:anywhere]">
                      {step.summary}
                    </span>
                  )}
                </button>
              </h2>
              <div id={panel} hidden={!isOpen} className="px-6 pb-6">
                {step.panel}
              </div>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

/** A step's number in a square: outlined until it is done, filled in the wood once it is. */
function StepNumber({ n, done, current }: { n: number; done: boolean; current: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center rounded-sm border font-mono text-caption font-medium',
        done
          ? 'border-primary bg-primary text-primary-foreground'
          : current
            ? 'border-foreground text-foreground'
            : 'border-input text-muted-foreground',
      )}
    >
      {n}
    </span>
  );
}
