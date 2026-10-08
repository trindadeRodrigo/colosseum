'use client';
import type { ChainId, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardEmpty } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonCards } from '../../components/ui/Skeleton';
import { Status } from '../../components/ui/StatusMark';
import type { Dictionary } from '../../i18n';
import { useT } from '../../i18n/I18nProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import type { ChainOut } from './api';
import { type Reading, usePortfolioSection } from './PortfolioProvider';
import { useWords } from './words';

// What the pages of the section share: the head of a page, the sentences every page says when there
// is nobody to read for, while it reads and when a read fails, the chains an answer could not cover,
// and the way to ask again. A page hands `SectionGate` the read it stands on and draws only what was
// read.

/** A page's title and its one paragraph. The title is the page's one serif line. */
export function PageHead({ title, lead }: { title: string; lead?: string }) {
  return (
    <header className="flex flex-col gap-3">
      <h1 className={PAGE_TITLE}>{title}</h1>
      {lead && <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{lead}</p>}
    </header>
  );
}

/** A chain's name as the screens say it: the wallet's word for it, or else the dictionary's. */
export function useChainName(): (chain: ChainId) => string {
  const t = useT();
  const port = useWalletPort();
  return (chain) => port.network(chain)?.name ?? t.chain.names[chain];
}

/**
 * The quiet line of a card whose figures are not live (gate MOCK-QUIET): "Test network" where they
 * are read from one, "Sample figures" for anything else that is not live.
 */
export const sampleLine = (words: Dictionary['shell'], provenance: Provenance): string =>
  provenance === 'sandbox' ? words.testNetworkLine : words.mockAnnounce;

/** Asks the section's reads afresh. Never the page's primary action. */
export function ReadAgain({ className }: { className?: string } = {}) {
  const w = useWords();
  const { again, busy } = usePortfolioSection();
  return (
    <Button
      variant="secondary"
      size="dense"
      busy={busy}
      busyLabel={w.shell.againBusy}
      onClick={again}
      data-action="read-again"
      className={className}
    >
      {w.shell.again}
    </Button>
  );
}

/** A card that says one thing, and offers one thing to do. */
export function Say({ sentence, action }: { sentence: string; action?: ReactNode }) {
  return (
    <Card>
      <CardEmpty sentence={sentence} action={action} />
    </Card>
  );
}

/**
 * The person's chains an answer could not cover, each in a sentence: never a zero in a chain's place.
 * One that may answer next time offers to read again; one that is switched off does not.
 */
export function ChainsOut({ unavailable }: { unavailable: readonly ChainOut[] }) {
  const t = useT();
  const nameOf = useChainName();
  if (unavailable.length === 0) return null;
  return (
    <>
      <ul data-ui="chains-out" className="flex flex-col gap-1.5">
        {unavailable.map((u) => (
          <li key={u.chain} data-chain={u.chain}>
            <Status status="watch">
              {u.retryable
                ? t.portfolio.chainOut(nameOf(u.chain))
                : t.portfolio.chainOff(nameOf(u.chain))}
            </Status>
          </li>
        ))}
      </ul>
      {unavailable.some((u) => u.retryable) && (
        <div>
          <ReadAgain />
        </div>
      )}
    </>
  );
}

/**
 * One read of the section, as a page stands on it. Signed out, while it is read, and each way it can
 * fail are a sentence each, with the way on where there is one; `children` draws the answer, and is
 * called only with one that was read for the person now signed in. While an answer on the screen is
 * read again it stays, and a screen reader is told.
 */
export function SectionGate<T>({
  read,
  children,
}: {
  read: Reading<T>;
  children: (answer: T) => ReactNode;
}) {
  const t = useT();
  const w = useWords();
  const pathname = usePathname();
  const { person, throwaway, again, busy } = usePortfolioSection();
  const link = buttonClass({ variant: 'link' });

  if (person === 'signed-out')
    return (
      <Say
        sentence={w.shell.signedOut}
        action={
          <Link href={`/sign-in?next=${pathname}`} className={link}>
            {t.shell.signIn}
          </Link>
        }
      />
    );
  if (person === 'loading' || read.kind === 'idle' || read.kind === 'reading')
    return (
      <Card>
        <CardWait label={w.shell.reading} skeleton={<SkeletonCards count={2} />} onRetry={again} />
      </Card>
    );

  switch (read.kind) {
    case 'read':
      return (
        <>
          <p role="status" className="sr-only">
            {busy ? w.shell.reading : ''}
          </p>
          <div data-ui="section-read" aria-busy={busy} className="flex flex-col gap-6">
            {children(read.answer)}
          </div>
        </>
      );
    case 'unavailable':
      return (
        <Say
          sentence={w.shell.failure.unavailable}
          action={
            <Link href="/goal" className={link}>
              {w.shell.startGoal}
            </Link>
          }
        />
      );
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
