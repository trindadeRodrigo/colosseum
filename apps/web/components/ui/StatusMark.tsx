import type { ReactNode } from 'react';
import { cn } from './cn';

// Goal state is a word, a shape and an earth colour, never the colour alone (STYLE.md, rule 6).
// On track: a solid square, forest. Watch: a half-filled square, ochre. Off track: a square outline
// with a notch, madder. The state comes from the engine; nothing here works it out.

export type StatusKind = 'on-track' | 'watch' | 'off-track';

const COLOUR: Record<StatusKind, string> = {
  'on-track': 'text-status-on',
  watch: 'text-status-watch',
  'off-track': 'text-status-off',
};
const TINT: Record<StatusKind, string> = {
  'on-track': 'bg-status-on-bg',
  watch: 'bg-status-watch-bg',
  'off-track': 'bg-status-off-bg',
};

export type StatusMarkProps = {
  status: StatusKind;
  /** 10 beside a status word, 12 before an error sentence. */
  size?: 10 | 12;
  className?: string;
};

/** The shape alone. It is hidden from screen readers: the word beside it says the state. */
export function StatusMark({ status, size = 10, className }: StatusMarkProps) {
  return (
    <svg
      data-ui="status-mark"
      data-status={status}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={cn('shrink-0', COLOUR[status], className)}
    >
      {status === 'on-track' && <rect width="12" height="12" fill="currentColor" />}
      {status === 'watch' && (
        <>
          <rect
            x="0.75"
            y="0.75"
            width="10.5"
            height="10.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect x="0" y="6" width="12" height="6" fill="currentColor" />
        </>
      )}
      {status === 'off-track' && (
        <path
          d="M0.75 0.75H11.25V7.5H7.5V11.25H0.75Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
}

export type StatusProps = {
  status: StatusKind;
  /** The word, and anything that goes with it ("On track · June 2028"). There is no status without it. */
  children: ReactNode;
  className?: string;
};

/** The mark and its word on one line, in the status colour. */
export function Status({ status, children, className }: StatusProps) {
  return (
    <span
      data-ui="status"
      data-status={status}
      className={cn(
        'inline-flex items-center gap-2 text-caption font-medium',
        COLOUR[status],
        className,
      )}
    >
      <StatusMark status={status} />
      <span>{children}</span>
    </span>
  );
}

/** A status badge: square, 20px tall, the tint behind the mark and the word. */
export function StatusBadge({ status, children, className }: StatusProps) {
  return (
    <span
      data-ui="status-badge"
      data-status={status}
      className={cn(
        'inline-flex h-5 items-center gap-1.5 rounded-none px-2 text-caption font-medium',
        COLOUR[status],
        TINT[status],
        className,
      )}
    >
      <StatusMark status={status} />
      <span>{children}</span>
    </span>
  );
}

/** The row tint that goes with a status in a table. Only ever beside the mark and the word. */
export const statusTint = (status: StatusKind): string => TINT[status];
