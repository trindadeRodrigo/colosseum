'use client';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { formatAge } from '../../components/ui/format';
import { StalePlate } from '../../components/ui/MockPlate';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { Status } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import { dollars, utc } from '../portfolio/figures';
import type { Plan, PlansChain } from './api';
import { sampleLine } from './parts';
import { leastLive, putInPin, snapshotPin } from './pins';
import { sayStatus } from './status';
import { useWords } from './words';

// Under the goal, where a plan stands, in the words of the overview: the status as the server says it, with its shape, the chain, the reason and the
// rule's name; what the vault is worth now and what the person put in, each on its pin; and when the
// vault was last read, said as stale when the answer says it is. Nothing is worked out: the status,
// the two figures, the age and whether the read is stale are the answer's. A vault that was never
// read says so, and shows no value in a zero's place.

export function PlanHead({ chain, plan }: { chain: PlansChain; plan: Plan }) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const words = w.overview.card;
  const { newest, putIn } = plan;

  // The block is live only when everything it shows is.
  const label = leastLive(
    chain.provenance,
    plan.provenance,
    ...(newest ? [newest.provenance] : []),
    ...(putIn ? [putIn.provenance] : []),
  );
  const said = sayStatus(plan.status, lang, w.status, (asset) => displayName(asset, t.plan));
  const missing = newest ? newest.positions.filter((p) => p.valueUsd === null).length : 0;
  const age = newest ? formatAge(newest.ageSeconds) : null;
  const ago = age
    ? `${age.count} ${t.pin.age[age.unit][age.count === 1 ? 0 : 1] ?? ''}`.trim()
    : t.pin.ageUnknown;

  return (
    <Card
      as="section"
      aria-label={w.plan.head.label}
      mock={label !== 'live'}
      mockLabels={{ announce: sampleLine(t.shell, label) }}
    >
      <div
        data-ui="plan-head"
        data-line={plan.status.line}
        className="flex flex-col items-start gap-3 p-6"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {said.kind ? (
            <Status status={said.kind}>{said.word}</Status>
          ) : (
            <p data-ui="plan-no-status" className="text-caption font-medium text-foreground">
              {said.word}
            </p>
          )}
          <ChainBadge chain={plan.chain} />
        </div>
        <p data-ui="plan-reason" className="max-w-(--tf-measure-body) text-body text-foreground">
          {said.reason}
        </p>
        <p data-ui="plan-rule" className="font-mono text-source text-muted-foreground">
          {w.status.rule(said.rule)}
        </p>

        <dl
          data-ui="plan-figures"
          className="grid w-full gap-x-6 gap-y-1 text-body min-[480px]:grid-cols-[auto_1fr]"
        >
          <dt className="text-muted-foreground">{words.value}</dt>
          <dd className="tabular-nums">
            {newest ? (
              <ProvenancePin
                value={dollars(lang, newest.valueUsd)}
                obs={snapshotPin(newest, chain.provenance, plan.provenance)}
                labels={t.pin}
              />
            ) : (
              // never a zero in the place of a vault that was not read
              <span data-ui="plan-never-read">{words.neverRead}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{words.putIn}</dt>
          <dd className="tabular-nums">
            {putIn ? (
              <ProvenancePin
                value={dollars(lang, putIn.usd)}
                obs={putInPin(putIn, chain.provenance, plan.provenance)}
                labels={t.pin}
              />
            ) : (
              <span data-ui="plan-no-put-in">{words.noPutIn}</span>
            )}
          </dd>
        </dl>
        {missing > 0 && (
          <p data-ui="plan-unpriced" className="text-body-sm text-muted-foreground">
            {words.unpriced(missing)}
          </p>
        )}

        {newest && (
          <p
            data-ui="plan-read"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground"
          >
            <span>{words.read(ago, utc(lang, newest.observedAt))}</span>
            {/* Older than an hour, as the answer says: stale, with its age (mock-plate.md). A live
                figure's own pin says it too; one that is not live keeps its hatched pin. */}
            {newest.stale && (
              <StalePlate
                ageSec={newest.ageSeconds}
                labels={{ stale: t.pin.stale, ageUnknown: t.pin.ageUnknown }}
              />
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
