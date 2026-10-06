'use client';
import type { Provenance } from '@colosseum/schemas';
import { type ReactNode, useId, useRef } from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { Field, Input, Select, Textarea } from './Field';
import { isoUtc } from './format';
import { LatticeStatus } from './Lattice';
import { CONSTRAINT_SHEET_LABELS, type ConstraintSheetLabels } from './labels';
import { MockPlate } from './MockPlate';
import { StatusMark } from './StatusMark';

// constraint-sheet.md. The model only reads a goal into a typed sheet. The person sees exactly what
// was read and can change any field, and the solver never runs on a sheet that failed validation.
// This component is where that rule is visible: with anything left to fix, "Build my plan" does not
// call out; it moves focus to the list of what to fix.
//
// The sheet holds limits, not outcomes: no yield or price appears on it, so it carries no pins. It
// knows nothing of the schema. The caller validates (zod), words each issue from its copy dictionary,
// and hands over the fields with human labels and the parsed sheet once it is valid.

export type SheetOption = { value: string; label: string };

export type SheetField = {
  /** The DOM id of the control. The error summary links to it. */
  id: string;
  /** The human label: "Monthly income", never `target.kind`. */
  label: string;
  /** The schema path, as a tooltip for developers only. */
  schemaKey?: string;
  /** `month` is typed as YYYY-MM in a plain field: the same in every browser. */
  kind: 'text' | 'amount' | 'number' | 'month' | 'select' | 'textarea';
  /** The draft value, as text. */
  value: string;
  /** For a select. The labels are human ones. */
  options?: readonly SheetOption[];
  hint?: string;
  /** A note under the field: "Income plans don't include tokenized stocks." */
  caption?: string;
  /** Changed by the person after the parser read the goal. */
  edited?: boolean;
  /** What to change, as a sentence, when this field does not fit. Never the validator's raw text. */
  error?: string;
  /** How wide the control is: `12ch` for an amount, `9ch` for a month. */
  width?: string;
  /** In read mode, the value as shown. Left out, it is the option's label or the value itself. */
  display?: string;
};

export type SheetGroup = { legend: string; fields: readonly SheetField[] };

/**
 * Something the sheet states and the person does not set on it: the chain their plan lives on, which
 * is their wallet's. It is shown with the limits and is not a field.
 */
export type SheetFact = {
  label: string;
  /** The value, in words, with whatever goes beside it: a sample glyph, a link to where it is set. */
  value: ReactNode;
  /** One sentence under it. */
  note?: string;
};

export type SheetSource = {
  /** How the goal was read: "llm-v3", "rules-v1". */
  method: string;
  model?: string;
  fetchedAt: string;
  /** A reading that came from a fixture or a mock carries the sample glyph. */
  provenance: Provenance;
};

export type { ConstraintSheetLabels } from './labels';

type Common = {
  /** The goal as the person wrote it. Shown quoted, and kept when they go back. */
  goalText?: string;
  source?: SheetSource;
  groups: readonly SheetGroup[];
  /** What the sheet states beside its fields: under the title, in edit mode and in read mode. */
  facts?: readonly SheetFact[];
  /** The id of the sheet in the page, for a link that leads to it ("Edit limits"). */
  id?: string;
  /** The level of its title in the page outline: 2 right under the page's heading, 3 inside a section. */
  level?: 2 | 3;
  labels?: Partial<ConstraintSheetLabels>;
  className?: string;
};

export type ConstraintSheetProps<Sheet> = Common &
  (
    | {
        mode?: 'edit';
        /**
         * `idle` can be edited. `parsing`: the goal is being read. `solving`: the plan is being built,
         * and the sheet can be read but not changed. `no-plan`: the sheet is valid and no plan fits it.
         */
        state?: 'idle' | 'parsing' | 'solving' | 'no-plan';
        onChange: (fieldId: string, value: string) => void;
        /**
         * The sheet as the validator parsed it, or null while anything fails. Only this reaches
         * `onBuild`: a draft that did not validate cannot be sent, by type and by construction.
         */
        valid: Sheet | null;
        onBuild: (sheet: Sheet) => void;
        /** Issues that belong to no single field (the server refused the sheet as a whole). */
        otherIssues?: readonly string[];
        /** With `no-plan`: which limit binds. */
        binding?: string;
        /** The last field and the button share a row: the capital to plan with. */
        capital?: SheetField;
      }
    | {
        /** The plan view: the same labels and values, with no wells. */
        mode: 'read';
        /** Goes back to the goal screen with the sheet filled in. A new solve makes a new plan. */
        onEdit?: () => void;
        editHref?: string;
      }
  );

/** A group's name, then a hairline to the end of the row. */
const RULE =
  'mb-3 flex w-full items-center gap-3 p-0 text-caption font-semibold after:h-px after:flex-1 after:bg-border';

function shown(field: SheetField): string {
  if (field.display !== undefined) return field.display;
  const option = field.options?.find((o) => o.value === field.value);
  return option?.label ?? (field.value === '' ? '—' : field.value);
}

export function ConstraintSheet<Sheet>(props: ConstraintSheetProps<Sheet>) {
  const { goalText, source, groups, facts, id, level = 3, labels, className } = props;
  const Title = `h${level}` as 'h2' | 'h3';
  const text = { ...CONSTRAINT_SHEET_LABELS, ...labels };
  const summary = useRef<HTMLDivElement>(null);
  const fixId = useId();
  const summaryId = useId();
  const when = source ? isoUtc(source.fetchedAt) : null;

  const head = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Title className="text-h4 font-semibold">{text.title}</Title>
        {source && (
          <p className="flex flex-wrap items-center gap-2 font-mono text-source text-muted-foreground">
            <span>
              {text.parser}: {source.method}
              {source.model ? ` (${source.model})` : ''}
              {when ? ` · ${when}` : ''}
            </span>
            {source.provenance !== 'live' && <MockPlate labels={{ figure: text.mockAnnounce }} />}
          </p>
        )}
      </div>
      {goalText && <p className="text-body-sm text-muted-foreground">“{goalText}”</p>}
      {facts && facts.length > 0 && (
        <dl data-ui="sheet-facts" className="mt-2 flex flex-col gap-3">
          {facts.map((fact) => (
            <div key={fact.label} className="flex flex-col gap-0.5">
              <dt className="text-caption font-medium text-foreground">{fact.label}</dt>
              <dd className="text-body">{fact.value}</dd>
              {fact.note && <dd className="text-caption text-muted-foreground">{fact.note}</dd>}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
  const frame = cn(
    'flex flex-col gap-6 rounded-md border border-border bg-card p-6 text-card-foreground',
    className,
  );

  if (props.mode === 'read')
    return (
      <section id={id} data-ui="constraint-sheet" data-mode="read" className={frame}>
        {head}
        {groups.map((group) => (
          <div key={group.legend}>
            <p className={RULE}>{group.legend}</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              {group.fields.map((field) => (
                <div key={field.id}>
                  <dt title={field.schemaKey} className="text-caption text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd className="text-body tabular-nums">{shown(field)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        {(props.onEdit || props.editHref) && (
          <div>
            <Button onClick={props.onEdit} href={props.editHref}>
              {text.editSheet}
            </Button>
          </div>
        )}
      </section>
    );

  const { state = 'idle', onChange, valid, onBuild, otherIssues = [], binding, capital } = props;

  if (state === 'parsing')
    return (
      <section id={id} data-ui="constraint-sheet" data-state="parsing" className={frame}>
        {head}
        <LatticeStatus label={text.reading} />
      </section>
    );

  const every = [...groups.flatMap((g) => g.fields), ...(capital ? [capital] : [])];
  const wrong = every.filter((field) => field.error);
  const count = wrong.length + otherIssues.length;
  // A field with nothing in it yet is missing: it has not been found not to fit. Right after a goal
  // is read, what the reader left empty is said that way.
  const missing = wrong.filter((field) => field.value.trim() === '').length;
  const unfit = count - missing;
  const solving = state === 'solving';
  const blocked = count > 0 || valid === null;
  const plural = (one: string, other: string, n: number) =>
    (n === 1 ? one : other).replace('{n}', String(n));

  function control(field: SheetField) {
    const set = (value: string) => onChange(field.id, value);
    return (
      <Field
        key={field.id}
        id={field.id}
        label={field.label}
        schemaKey={field.schemaKey}
        hint={[field.hint, field.caption].filter(Boolean).join(' ') || undefined}
        error={field.error}
        edited={field.edited}
        labels={{ edited: text.edited }}
      >
        {(wired) =>
          field.kind === 'select' && solving ? (
            <Input {...wired} readOnly value={shown(field)} width={field.width} />
          ) : field.kind === 'select' ? (
            <Select
              {...wired}
              value={field.value}
              width={field.width}
              onChange={(event) => set(event.target.value)}
            >
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : field.kind === 'textarea' ? (
            <Textarea
              {...wired}
              value={field.value}
              readOnly={solving}
              width={field.width}
              onChange={(event) => set(event.target.value)}
            />
          ) : (
            <Input
              {...wired}
              inputMode={
                field.kind === 'amount' ? 'decimal' : field.kind === 'text' ? undefined : 'numeric'
              }
              align={field.kind === 'amount' || field.kind === 'number' ? 'end' : 'start'}
              value={field.value}
              readOnly={solving}
              width={
                field.width ??
                (field.kind === 'month' ? '9ch' : field.kind === 'text' ? undefined : '12ch')
              }
              onChange={(event) => set(event.target.value)}
            />
          )
        }
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        id={id}
        data-ui="constraint-sheet"
        data-state={state}
        aria-busy={solving || undefined}
        className={frame}
      >
        {head}

        {count > 0 && (
          <div
            ref={summary}
            id={summaryId}
            tabIndex={-1}
            role="alert"
            data-ui="sheet-errors"
            className="rounded-md border border-destructive bg-status-off-bg p-4 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <p className="flex items-start gap-2 text-body-sm font-medium">
              <StatusMark status="off-track" size={12} className="mt-1.5" />
              <span>
                {[
                  missing > 0 ? plural(text.missingOne, text.missingOther, missing) : null,
                  unfit > 0 ? plural(text.summaryOne, text.summaryOther, unfit) : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </span>
            </p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-9 text-body-sm">
              {wrong.map((field) => (
                <li key={field.id}>
                  {field.label}: {field.error}{' '}
                  <a
                    href={`#${field.id}`}
                    className="text-primary underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {text.goToField}
                  </a>
                </li>
              ))}
              {otherIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}

        {groups.map((group) => (
          <fieldset key={group.legend} className="min-w-0">
            <legend className={RULE}>{group.legend}</legend>
            <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
              {group.fields.map(control)}
            </div>
          </fieldset>
        ))}

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-t border-border pt-4">
          {capital ? control(capital) : <span />}
          <div className="flex flex-col items-end gap-1.5">
            <Button
              variant="primary"
              busy={solving}
              busyLabel={text.building}
              disabled={blocked && !solving}
              // What blocks the build is said where the button can point to it: the line under
              // it while fields are wrong, the list above when what blocks is not a field.
              aria-describedby={
                blocked && count > 0 ? (wrong.length > 0 ? fixId : summaryId) : undefined
              }
              onDisabledClick={() => summary.current?.focus()}
              onClick={() => {
                // The button refuses a click while it is disabled or busy. This is the sheet's own
                // check, and it holds without the button's: only a parsed sheet with nothing left to
                // fix is handed on, and never while a plan is already being built.
                if (!solving && valid !== null && count === 0) onBuild(valid);
              }}
            >
              {text.build}
            </Button>
            {blocked && wrong.length > 0 && (
              <p id={fixId} className="text-caption text-muted-foreground">
                {missing === wrong.length
                  ? plural(text.fillOne, text.fillOther, wrong.length)
                  : plural(text.fixOne, text.fixOther, wrong.length)}
              </p>
            )}
            <p role="status" className="sr-only">
              {solving ? text.building : ''}
            </p>
          </div>
        </div>
      </section>
      {state === 'no-plan' && (
        <div
          data-ui="sheet-no-plan"
          className="flex flex-col items-start gap-2 rounded-md border border-border bg-card p-6"
        >
          <p className="text-body font-medium">{text.noPlan}</p>
          {binding && <p className="text-body-sm text-muted-foreground">{binding}</p>}
          <Button onClick={() => document.getElementById(every[0]?.id ?? '')?.focus()}>
            {text.editSheet}
          </Button>
        </div>
      )}
    </div>
  );
}
