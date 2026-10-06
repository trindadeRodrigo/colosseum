'use client';
import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Waiting } from '../ui/Waiting';

// A wait for data, in the reader's language: the skeleton of what comes, what is awaited, the line that
// says the data service may be waking, and the retry after a minute (components/ui/Skeleton.tsx).

export function Wait({
  label,
  skeleton,
  onRetry,
  className,
}: {
  label: string;
  skeleton?: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Waiting
      label={label}
      words={t.shell.wait}
      skeleton={skeleton}
      onRetry={onRetry}
      className={className}
    />
  );
}

/** A card's body waiting for its data: the card's own padding around the wait. */
export function CardWait(props: { label: string; skeleton?: ReactNode; onRetry?: () => void }) {
  return (
    <div data-ui="card-loading" className="p-6">
      <Wait {...props} />
    </div>
  );
}
