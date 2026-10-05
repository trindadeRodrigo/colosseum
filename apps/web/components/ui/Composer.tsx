'use client';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from './cn';
import { sendsOnKey } from './composer-keys';
import { Icon } from './Icon';
import { LatticeGlyph } from './Lattice';
import { COMPOSER_LABELS, type ComposerLabels } from './labels';
import { StatusMark } from './StatusMark';

// composer.md. The typing box: the one place where a person talks to us in their own words, and the
// only rounded shape in the system (20px, with a round send button). Everything around it stays
// square. It sends the text and nothing else: what reads it, and what happens next, is the caller's.
// It never shows a figure, so it carries no pin.

export type { ComposerLabels } from './labels';

const MAX_HEIGHT = 120; // five lines of 24px

export type ComposerProps = {
  /** Always given. Shown above the box unless a heading already names it (`labelHidden`). */
  label: string;
  labelHidden?: boolean;
  /** Controlled text. Left out, the composer keeps its own. */
  value?: string;
  defaultValue?: string;
  onChange?: (text: string) => void;
  /** Called with the trimmed text. Never called while empty, busy or disabled. */
  onSubmit: (text: string) => void;
  placeholder?: string;
  /** The most characters the box takes: what the reader behind it accepts. */
  maxLength?: number;
  /** Under the box: "Enter to fit · Shift+Enter for a new line". */
  hint?: string;
  /** The text is being read: the box is read-only and the send button shows the still lattice. */
  busy?: boolean;
  /** The request failed. A sentence that says what to do. The typed text is kept. */
  error?: string;
  /** Marks the box as in error when the sentence is shown elsewhere (the subscribe block's status line). */
  invalid?: boolean;
  disabled?: boolean;
  /**
   * `multiline` grows from one line to five. `single` is one line of input: the subscribe field.
   */
  variant?: 'multiline' | 'single';
  /** For `single`: the input type and what the browser may fill in. */
  inputType?: 'text' | 'email';
  autoComplete?: string;
  name?: string;
  /**
   * For `single`: the send button carries this word instead of the arrow ("Subscribe"). Below 520px
   * it is the arrow again, with the word as its name.
   */
  sendText?: string;
  /** For `single` with `sendText`: the word on the button while busy ("Subscribing…"). */
  busySendText?: string;
  /** The language of what is typed. */
  lang?: string;
  labels?: Partial<ComposerLabels>;
  className?: string;
};

export function Composer({
  label,
  labelHidden = false,
  value,
  defaultValue = '',
  onChange,
  onSubmit,
  placeholder,
  maxLength,
  hint,
  busy = false,
  error,
  disabled = false,
  variant = 'multiline',
  inputType = 'text',
  autoComplete,
  name,
  sendText,
  busySendText,
  invalid = false,
  lang,
  labels,
  className,
}: ComposerProps) {
  const text = { ...COMPOSER_LABELS, ...labels };
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const empty = current.trim() === '';
  const inert = empty || busy || disabled;
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const area = useRef<HTMLTextAreaElement>(null);

  // Where `field-sizing: content` is not supported, grow the box by hand, up to five lines.
  useEffect(() => {
    const el = area.current;
    if (!el || CSS.supports('field-sizing', 'content')) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  });

  function change(event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (value === undefined) setOwn(event.target.value);
    onChange?.(event.target.value);
  }
  function send() {
    if (inert) return;
    onSubmit(current.trim());
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    send();
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!sendsOnKey(event)) return;
    event.preventDefault();
    send();
  }

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const control = cn(
    'min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground',
    disabled ? 'text-muted-foreground' : 'text-foreground',
  );
  const wordy = variant === 'single' && sendText !== undefined;
  // The button is named for what it shows: the word on it, unless the caller names it otherwise.
  const sendName = labels?.submit ?? (wordy ? sendText : text.submit);

  return (
    <form
      data-ui="composer"
      onSubmit={submit}
      noValidate
      className={cn('flex scroll-mt-24 flex-col gap-2', className)}
    >
      <label
        htmlFor={id}
        className={labelHidden ? 'sr-only' : 'text-caption font-medium text-foreground'}
      >
        {label}
      </label>
      <div
        data-ui="composer-box"
        aria-busy={busy || undefined}
        className={cn(
          'flex min-h-13 cursor-text gap-2 rounded-composer border bg-card py-2 pr-2 pl-4 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
          variant === 'single' ? 'items-center' : 'items-end',
          error || invalid ? 'border-destructive' : disabled ? 'border-border' : 'border-input',
        )}
      >
        {variant === 'single' ? (
          <input
            id={id}
            type={inputType}
            name={name}
            autoComplete={autoComplete}
            lang={lang}
            value={current}
            onChange={change}
            placeholder={placeholder}
            maxLength={maxLength}
            readOnly={busy}
            disabled={disabled}
            aria-describedby={describedBy || undefined}
            aria-invalid={error || invalid ? true : undefined}
            className={cn(control, 'h-9')}
          />
        ) : (
          <textarea
            ref={area}
            id={id}
            rows={1}
            name={name}
            lang={lang}
            value={current}
            onChange={change}
            onKeyDown={keyDown}
            placeholder={placeholder}
            maxLength={maxLength}
            readOnly={busy}
            disabled={disabled}
            aria-describedby={describedBy || undefined}
            aria-invalid={error ? true : undefined}
            className={cn(
              control,
              'max-h-[120px] min-h-6 resize-none py-1.5 [field-sizing:content]',
            )}
          />
        )}
        <button
          type="submit"
          data-ui="composer-send"
          aria-label={sendName}
          aria-disabled={inert || undefined}
          aria-busy={busy || undefined}
          tabIndex={disabled ? -1 : undefined}
          className={cn(
            'grid h-9 shrink-0 place-items-center rounded-round transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            wordy ? 'min-w-9 px-0 min-[520px]:px-4' : 'w-9',
            inert && !busy
              ? 'cursor-default bg-muted text-muted-foreground'
              : 'bg-primary text-primary-foreground',
            !inert && 'cursor-pointer hover:bg-primary-hover active:bg-primary-pressed',
          )}
        >
          {busy && wordy && busySendText ? (
            <span
              aria-hidden="true"
              className="px-3 text-[0.9375rem]/5 font-medium min-[520px]:px-0"
            >
              {busySendText}
            </span>
          ) : busy ? (
            <LatticeGlyph size={20} tone="current" />
          ) : wordy ? (
            <>
              <span
                aria-hidden="true"
                className="text-[0.9375rem]/5 font-medium max-[519px]:hidden"
              >
                {sendText}
              </span>
              <Icon name="ArrowUp" className="min-[520px]:hidden" />
            </>
          ) : (
            <Icon name="ArrowUp" />
          )}
        </button>
      </div>
      {hint && (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
      {text.busy !== '' && (
        <p role="status" className={busy ? 'text-caption text-muted-foreground' : 'sr-only'}>
          {busy ? text.busy : ''}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-body-sm text-destructive"
        >
          <StatusMark status="off-track" size={12} className="mt-1.5" />
          <span>{error}</span>
        </p>
      )}
    </form>
  );
}
