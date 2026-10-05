'use client';
import type { ChainId } from '@colosseum/schemas';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import type { ChainCheck } from './chain-recipe';
import type { TermsSource } from './terms';

// Where a portfolio's version and weights come from, as a word and a shape (STYLE.md rule 6): read
// from the chain by this app, or our server's word, not checked, and why. A difference between the two
// is said as an alarm.

export function SourceMark({
  source,
  check,
  chain,
  mock = false,
}: {
  source?: TermsSource;
  check?: ChainCheck;
  chain: ChainId;
  /** With `source` alone: the chain runs on the mock, which is why nothing was read. */
  mock?: boolean;
}) {
  const t = useT();
  const c = t.shared.check;
  const name = t.chain.names[chain];
  const read = check ? check.state === 'read' : source === 'chain';
  const differs = check?.state === 'read' && check.differs;
  const sentence =
    check?.state === 'reading'
      ? c.reading
      : differs
        ? c.differs(name)
        : read
          ? c.read(name)
          : check?.state === 'unverified'
            ? check.why === 'mock' || check.why === 'family-id'
              ? c.unverified[check.why]
              : c.unverified[check.why](name)
            : mock
              ? c.unverified.mock
              : c.unverified['no-node'](name);
  return (
    <p
      data-ui="source-mark"
      data-source={read ? 'chain' : 'api'}
      className={
        differs
          ? 'flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive'
          : 'flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm'
      }
    >
      <StatusMark status={differs ? 'off-track' : read ? 'on-track' : 'watch'} className="mt-1.5" />
      <span>
        <span className="font-medium">{read ? c.verified : c.notChecked}.</span> {sentence}
      </span>
    </p>
  );
}
