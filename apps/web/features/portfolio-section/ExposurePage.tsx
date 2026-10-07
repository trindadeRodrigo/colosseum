'use client';
import Link from 'next/link';
import { buttonClass } from '../../components/ui/button-class';
import type { ExposureAnswer } from './api';
import { ExposureChainBlock } from './ExposureChain';
import { holds } from './exposure';
import { usePortfolioSection } from './PortfolioProvider';
import { href, METHODOLOGY } from './pages';
import { ChainsOut, PageHead, ReadAgain, Say, SectionGate, useChainName } from './parts';
import { useWords } from './words';

// The exposure page (/portfolio/exposure): what the person holds across their vaults, as
// GET /v1/portfolio/exposure answers it, one block a chain (ExposureChain.tsx). Sums are a chain's
// own: the answer's `total`, which adds the chains up, is never read here, and the page says once
// that chains are not added together. It says once, too, what a selling cost is: one asset sold
// alone at the size of the person's holding, not everything at once. A chain that holds nothing is a
// sentence beside the ones that do, and one that could not be read is a sentence, never a zero.
// Nothing here signs.

export function ExposurePage() {
  const w = useWords();
  const { exposure } = usePortfolioSection();
  return (
    <div data-ui="portfolio-exposure" className="flex flex-col gap-8">
      <PageHead title={w.exposure.title} lead={w.exposure.lead} />
      <SectionGate read={exposure}>{(answer) => <Holdings answer={answer} />}</SectionGate>
    </div>
  );
}

function Holdings({ answer }: { answer: ExposureAnswer }) {
  const w = useWords();
  const nameOf = useChainName();
  const words = w.exposure;
  const held = answer.chains.filter(holds);
  const empty = answer.chains.filter((chain) => !holds(chain));
  return (
    <>
      <ChainsOut unavailable={answer.unavailable} />
      {held.length === 0 && answer.unavailable.length === 0 ? (
        // "Nothing held yet" is said only when every chain of theirs was read: one that could not
        // be read may hold something.
        <Say sentence={words.empty} />
      ) : (
        <>
          {held.length > 0 && (
            <ul
              data-ui="exposure-notes"
              className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1.5 pl-5 text-body-sm"
            >
              {[words.notes.chains, words.notes.vaults, words.notes.exit, words.notes.bps].map(
                (note) => (
                  <li key={note}>{note}</li>
                ),
              )}
            </ul>
          )}
          {held.map((chain) => (
            <ExposureChainBlock key={chain.chain} chain={chain} />
          ))}
          {empty.map((chain) => (
            <p
              key={chain.chain}
              data-ui="chain-empty"
              data-chain={chain.chain}
              className="text-body-sm text-muted-foreground"
            >
              {chain.vaults === 0
                ? words.chain.noneRead(nameOf(chain.chain))
                : words.chain.none(chain.vaults, nameOf(chain.chain))}
            </p>
          ))}
        </>
      )}
      <p data-ui="exposure-more">
        <Link href={href(METHODOLOGY)} className={buttonClass({ variant: 'link' })}>
          {words.more}
        </Link>
      </p>
      <p
        data-ui="exposure-refresh"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-sm text-muted-foreground"
      >
        <span>{w.overview.refresh}</span>
        <ReadAgain />
      </p>
    </>
  );
}
