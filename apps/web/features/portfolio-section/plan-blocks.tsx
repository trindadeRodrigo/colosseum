'use client';
import { type ReactNode, useId } from 'react';
import { Card } from '../../components/ui/Card';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { useT } from '../../i18n/I18nProvider';
import { type Reading, usePortfolioSection } from './PortfolioProvider';
import { ReadAgain, Say } from './parts';
import { useWords } from './words';

// What the blocks of a plan's page share: a block under its heading, and a read of one block's own.
// The page stands on the person's plans through `SectionGate` (parts.tsx); under it each block that
// reads something more (the vault's history, its exposure, its trades) waits and fails by itself, in
// the same sentences, so one read that fails leaves the rest of the page standing. A block's gate
// announces nothing of its own while the page reads again: the page's gate says that once.

/** An EVM address compares in any case, as the API reads one; a Solana address as it is written. */
export const sameVault = (a: string, b: string): boolean =>
  a === b || (a.startsWith('0x') && a.toLowerCase() === b.toLowerCase());

/** One block of the page: its heading, one line under it, and what stands beside the heading. */
export function Block({
  ui,
  heading,
  lead,
  tools,
  children,
}: {
  ui: string;
  heading: string;
  lead?: string;
  /** Beside the heading: the choice of a window. */
  tools?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section data-ui={ui} aria-labelledby={id} className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <h2 id={id} className="text-h3 font-semibold">
            {heading}
          </h2>
          {tools}
        </div>
        {lead && (
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">{lead}</p>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * One read a block stands on. While it is on its way, the shape of what comes and what is awaited;
 * each way it can fail, the sentence the section says for it (`SectionGate`), with the way on where
 * there is one; `children` draws the answer.
 */
export function BlockRead<T>({
  read,
  label,
  skeleton,
  children,
}: {
  read: Reading<T>;
  /** What is awaited, in words. */
  label: string;
  skeleton: ReactNode;
  children: (answer: T) => ReactNode;
}) {
  const t = useT();
  const w = useWords();
  const { throwaway, again } = usePortfolioSection();
  switch (read.kind) {
    case 'idle':
    case 'reading':
      return (
        // The frame is exactly its skeleton (the line floats over its foot), as the page's own wait
        // drew it: a block that reads after the plans does not move the blocks under it.
        <Card>
          <div data-ui="card-loading" className="p-6">
            <ScreenWait label={label} skeleton={skeleton} onRetry={again} />
          </div>
        </Card>
      );
    case 'read':
      return <>{children(read.answer)}</>;
    case 'unavailable':
      return <Say sentence={w.shell.failure.unavailable} />;
    // The throwaway wallet of development has no account on a real API: that is why, not the sign-in.
    case 'signed-out':
      return <Say sentence={throwaway ? w.shell.failure.throwaway : w.shell.failure.signedOut} />;
    case 'no-identity':
      return throwaway ? (
        <Say sentence={w.shell.failure.throwaway} />
      ) : (
        <Say sentence={w.shell.failure.noIdentity} action={<ReadAgain />} />
      );
    case 'busy':
      return <Say sentence={t.shell.slowDown} action={<ReadAgain />} />;
    case 'refused':
      return <Say sentence={w.shell.failure.refused} />;
    case 'unreachable':
      return <Say sentence={w.shell.failure.unreachable} action={<ReadAgain />} />;
    case 'unreadable':
      return <Say sentence={w.shell.failure.unreadable} action={<ReadAgain />} />;
  }
}
