import { type ComponentPropsWithoutRef, type ReactNode, useId } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';
import { StatusMark } from './StatusMark';

// field.md. A control is edged in member (3:1 or better), never in hair; it sits in a sunk well; its
// label is always visible above it; an error says what to change and never blames. The goal input and
// the subscribe field are not fields: they are the composer.

export type FieldLabels = {
  /** Shown in the hint of a field the person changed after the parser read it. */
  edited: string;
};
export const FIELD_LABELS: FieldLabels = { edited: 'edited' };

/** What a control needs from its field: its id, what describes it, and whether it is in error. */
export type ControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
};

export type FieldProps = {
  label: string;
  /** Under the control, in muted text. For a disabled control, the reason goes here. */
  hint?: string;
  /** A sentence that says what to change: "Enter an amount in reais." Sets the control invalid. */
  error?: string;
  /** Announce the error when it appears. Set it on submit, not on each keystroke. */
  announce?: boolean;
  /** The person changed this after the parser read the goal: a 6px square before the label, and "edited". */
  edited?: boolean;
  /** The schema key, as a tooltip for developers only. The label is always the human one. */
  schemaKey?: string;
  /** A fixed id, when something links to the control ("Go to field"). */
  id?: string;
  children: (control: ControlProps) => ReactNode;
  labels?: Partial<FieldLabels>;
  className?: string;
};

/** A label, a control, a hint and an error, wired together. */
export function Field({
  label,
  hint,
  error,
  announce = false,
  edited = false,
  schemaKey,
  id,
  children,
  labels,
  className,
}: FieldProps) {
  const auto = useId();
  const control = id ?? auto;
  const hintId = `${control}-hint`;
  const errorId = `${control}-error`;
  const hintText = [hint, edited ? (labels?.edited ?? FIELD_LABELS.edited) : null]
    .filter(Boolean)
    .join(' · ');
  const describedBy = [hintText ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div data-ui="field" className={cn('flex flex-col items-start gap-1.5', className)}>
      <label
        htmlFor={control}
        title={schemaKey}
        className="inline-flex items-center gap-1.5 text-caption font-medium text-foreground"
      >
        {edited && <span aria-hidden="true" className="size-1.5 shrink-0 bg-primary" />}
        {label}
      </label>
      {children({
        id: control,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {hintText && (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hintText}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role={announce ? 'alert' : undefined}
          className="flex items-start gap-1.5 text-body-sm text-destructive"
        >
          <StatusMark status="off-track" size={12} className="mt-1.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type Look = { invalid?: boolean; readOnly?: boolean; disabled?: boolean };

/** The box every control shares: the member edge and the sunk well, or neither when it cannot be edited. */
function box({ invalid, readOnly, disabled }: Look): string {
  return cn(
    'max-w-full rounded-md border px-3 text-body tabular-nums',
    FOCUS,
    disabled
      ? 'border-border bg-transparent text-muted-foreground'
      : readOnly
        ? 'border-border bg-transparent text-foreground'
        : cn('bg-muted text-foreground', invalid ? 'border-destructive' : 'border-input'),
  );
}

type Sizing = {
  /** The width follows the content, not the grid cell: `12ch` for an amount, `9ch` for a month. */
  width?: string;
  className?: string;
};

export type InputProps = Omit<ComponentPropsWithoutRef<'input'>, 'className' | 'width'> &
  Sizing & {
    /** Amounts sit on the right, so their digits line up. */
    align?: 'start' | 'end';
  };

export function Input({ width, align = 'start', className, style, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      data-ui="input"
      style={width ? { ...style, width: `calc(${width} + 1.5rem + 2px)` } : style}
      className={cn(
        'h-10',
        !width && 'w-full',
        align === 'end' && 'text-right',
        box({
          invalid: rest['aria-invalid'] === true || rest['aria-invalid'] === 'true',
          readOnly: rest.readOnly,
          disabled: rest.disabled,
        }),
        className,
      )}
    />
  );
}

export type SelectProps = Omit<ComponentPropsWithoutRef<'select'>, 'className'> & Sizing;

/** A native select in the same box. Its options carry human labels, never raw enum keys. */
export function Select({ width, className, style, children, ...rest }: SelectProps) {
  return (
    <span
      data-ui="select"
      style={width ? { ...style, width: `calc(${width} + 3rem + 2px)` } : style}
      className={cn('relative inline-block max-w-full', !width && 'w-full', className)}
    >
      <select
        {...rest}
        className={cn(
          'h-10 w-full appearance-none pr-9',
          box({
            invalid: rest['aria-invalid'] === true || rest['aria-invalid'] === 'true',
            disabled: rest.disabled,
          }),
        )}
      >
        {children}
      </select>
      <Icon
        name="ChevronDown"
        size={16}
        className="pointer-events-none absolute top-3 right-3 text-muted-foreground"
      />
    </span>
  );
}

export type TextareaProps = Omit<ComponentPropsWithoutRef<'textarea'>, 'className'> & Sizing;

export function Textarea({ width, className, style, rows = 3, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      rows={rows}
      data-ui="textarea"
      style={width ? { ...style, width: `calc(${width} + 1.5rem + 2px)` } : style}
      className={cn(
        'block py-2',
        !width && 'w-full',
        box({
          invalid: rest['aria-invalid'] === true || rest['aria-invalid'] === 'true',
          readOnly: rest.readOnly,
          disabled: rest.disabled,
        }),
        className,
      )}
    />
  );
}
