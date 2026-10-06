'use client';
import { type ReactNode, useState } from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { LatticeLoader } from './Skeleton';
import { useWaitPhase } from './wait';

// A region waiting for data (Skeleton.tsx draws its boxes, wait.ts keeps its time).

export type WaitWords = {
  /** After 4 seconds: the data service may be waking. */
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
  className?: string;
};

/**
 * A region waiting for data: busy while it waits, its skeleton, and under it one status line that is
 * announced politely. After 4 seconds the line says the data service may be waking; after a minute
 * the skeleton gives way to the failure and a retry.
 */
export function Waiting({ label, words, skeleton, onRetry, className }: WaitingProps) {
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
        {phase !== 'quiet' && (
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
        )}
      </p>
    </div>
  );
}
