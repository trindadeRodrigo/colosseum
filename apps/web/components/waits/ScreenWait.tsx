'use client';
import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Waiting } from '../ui/Waiting';

// A screen's wait for its data, in the reader's language: the screen's own skeleton, exactly its size,
// with the one status line over its foot (components/ui/Waiting.tsx, `float`). After 4 seconds the line
// says the server may be waking; after a minute the wait gives way to the failure and a retry.

export function ScreenWait({
  label,
  skeleton,
  onRetry,
  className,
}: {
  /** What is awaited, in words. */
  label: string;
  /** The screen in outline (a `…Wait` of its feature). */
  skeleton: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Waiting
      float
      label={label}
      words={t.shell.wait}
      skeleton={skeleton}
      onRetry={onRetry}
      className={className}
    />
  );
}
