'use client';
import { type ReactNode, useState } from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { LatticeLoader } from './Skeleton';
import { useWaitPhase } from './wait';

// A region waiting for data (Skeleton.tsx draws its boxes, wait.ts keeps its time).

export type WaitWords = {
  /** After 4 seconds: the server may be waking. */
  slow: string;
  /** After a minute: nothing came. */
  over: string;
  /** The button that asks again. */
  retry: string;
};

export type WaitingProps = {
  /** What is awaited, in words: "Reading the pools…". Said once, politely. */
  label: string;
  words: WaitWords;
  /** The boxes of what comes, in its own layout. */
  skeleton?: ReactNode;
  /** Asks again. Left out, the page is loaded again. */
  onRetry?: () => void;
  /**
   * For a skeleton as tall as a page: the status line takes no room of its own, so the region is
   * exactly its skeleton, and it stays at the foot of the window while the skeleton runs below it.
   */
  float?: boolean;
  className?: string;
};

/**
 * A region waiting for data: busy while it waits, its skeleton, and under it one status line that is
 * announced politely. After 4 seconds the line says the server may be waking; after a minute
 * the skeleton gives way to the failure and a retry.
 */
export function Waiting({ label, words, skeleton, onRetry, float, className }: WaitingProps) {
  const [attempt, setAttempt] = useState(0);
  const phase = useWaitPhase(true, attempt);
  const retry = () => {
    setAttempt((n) => n + 1);
    if (onRetry) onRetry();
    else window.location.reload();
  };
  if (phase === 'over')
    return (
      <div
        data-ui="waiting"
        data-phase="over"
        className={cn('flex flex-col items-start gap-3', className)}
      >
        <p role="alert" className="text-body-sm text-foreground">
          {words.over}
        </p>
        <Button variant="secondary" onClick={retry}>
          {words.retry}
        </Button>
      </div>
    );
  const said = phase !== 'quiet' && (
    <>
      <LatticeLoader />
      <span>
        {label}
        {phase === 'slow' && (
          <span data-ui="waiting-slow" className="block">
            {words.slow}
          </span>
        )}
      </span>
    </>
  );
  if (float)
    return (
      <div
        data-ui="waiting"
        data-phase={phase}
        aria-busy="true"
        className={cn('relative', className)}
      >
        {skeleton}
        {/* No height of its own: the line sits over the skeleton's foot, or the window's while the
            skeleton runs below it, on the ground's own colour so the boxes under it do not show. */}
        <div className="pointer-events-none sticky bottom-4 z-10 h-0">
          <p
            role="status"
            aria-live="polite"
            className={cn(
              'absolute bottom-0 left-0 flex max-w-full items-center gap-3 text-body-sm text-muted-foreground',
              phase !== 'quiet' && 'rounded-md border border-border bg-background px-3 py-2',
            )}
          >
            {said}
          </p>
        </div>
      </div>
    );
  return (
    <div
      data-ui="waiting"
      data-phase={phase}
      aria-busy="true"
      className={cn('flex flex-col gap-4', className)}
    >
      {skeleton}
      {/* The line keeps its place from the start; its words come after 400ms, so a short wait shows
          only the still boxes and says nothing. */}
      <p
        role="status"
        aria-live="polite"
        className="flex min-h-6 items-center gap-3 text-body-sm text-muted-foreground"
      >
        {said}
      </p>
    </div>
  );
}
