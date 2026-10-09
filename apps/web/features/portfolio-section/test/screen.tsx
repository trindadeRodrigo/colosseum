import type { ReactNode } from 'react';
import type { Lang } from '../../../i18n';
import { withAccount } from '../../account/test/screen';
import { readHistory } from '../api';
import { PortfolioProvider, usePortfolioSection, useSectionRead } from '../PortfolioProvider';
import { PortfolioShell } from '../PortfolioShell';
import { ChainsOut, ReadAgain, SectionGate } from '../parts';

// What a page of the portfolio section sits in, for its tests: the language of the view, the account,
// and the section's provider, with or without the frame around the page. The wallet under them is the
// test's own (features/wallet/test/mock-provider.ts). The JSX is here because test files are plain .ts.

/** A page under the section's provider, as the layout mounts it, without the frame. */
export const inSection = (lang: Lang, page: ReactNode) =>
  withAccount(lang, <PortfolioProvider>{page}</PortfolioProvider>);

/** A page in the section's frame: the side menu, the page, the disclaimer under it. */
export const inFrame = (lang: Lang, page: ReactNode) =>
  inSection(lang, <PortfolioShell>{page}</PortfolioShell>);

/** What the provider holds, written out for a test to read: who, each read's outcome, and "again". */
export function Probe() {
  const { person, throwaway, plans, exposure, rebalances, again, busy } = usePortfolioSection();
  return (
    <div
      data-ui="probe"
      data-person={person}
      data-throwaway={throwaway}
      data-plans={plans.kind}
      data-exposure={exposure.kind}
      data-rebalances={rebalances.kind}
      data-busy={busy}
    >
      <button type="button" data-action="again" onClick={again}>
        again
      </button>
      <output data-ui="probe-plans">
        {plans.kind === 'read'
          ? plans.answer.chains.flatMap((c) => c.plans.map((p) => p.address)).join(' ')
          : ''}
      </output>
    </div>
  );
}

/** A page that stands on the plans, as every page of the section stands on a read: its gate, the chains out. */
export function GatePage() {
  const { plans } = usePortfolioSection();
  return (
    <SectionGate read={plans}>
      {(answer) => (
        <>
          <ChainsOut unavailable={answer.unavailable} />
          <p data-ui="gate-read">{answer.chains.map((chain) => chain.chain).join(' ')}</p>
          <ReadAgain />
        </>
      )}
    </SectionGate>
  );
}

/** A read of a page's own, as a plan's page asks for its vault's history. */
export function OwnHistory({ address }: { address: string | null }) {
  const { reading, busy } = useSectionRead(address === null ? null : `history:${address}`, (api) =>
    readHistory(api, address === null ? {} : { address, step: '1d' }),
  );
  return (
    <output data-ui="own-read" data-kind={reading.kind} data-busy={busy}>
      {reading.kind === 'read'
        ? reading.answer.chains.flatMap((c) => c.vaults.map((v) => v.address)).join(' ')
        : ''}
    </output>
  );
}
