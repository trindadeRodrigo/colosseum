'use client';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import { formatAge } from '../../components/ui/format';
import { StalePlate } from '../../components/ui/MockPlate';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { Status } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars as whole } from '../goal/sheet';
import { displayName, goalLine } from '../order/plain';
import { dollars, utc } from '../portfolio/figures';
import type { Plan, PlansChain } from './api';
import { planHref } from './pages';
import { sampleLine, useChainName } from './parts';
import { leastLive, putInPin, snapshotPin } from './pins';
import { sayStatus } from './status';
import { useWords } from './words';

// One plan on the overview, in the order of the goal card (goal-card.md): the goal in one serif
// sentence, where it stands as the server says with the reason, what the vault is worth and what the
// person put in, each with its pin, how long ago the vault was read, and one link, to the plan's own
// page. The card holds two pinned figures and the age of the read, which the goal card primitive has
// no place for, so it is built here from the same parts. Nothing on it is worked out: the status, the
// value, what was put in, the age and whether the read is stale are the answer's.

/** What a vault with no goal of its own is called: what it follows, its own name, or its chain. */
function sentenceOf(
  plan: Plan,
  words: ReturnType<typeof useWords>['overview']['card'],
  chainName: string,
): { sentence: string; notes: string[] } {
  const named = plan.name ? [plan.name] : [];
  const followed = plan.follows?.name;
  const opened = plan.openedFor;
  if (followed) {
    // What the chain shows now leads; what the vault was opened as is said under it when it differs.
    const differs =
      opened !== null &&
      plan.follows?.familyId !== undefined &&
      plan.follows.familyId !== opened.familyId;
    return {
      sentence: words.follows(followed),
      notes: differs ? [words.openedAs(opened.name), ...named] : named,
    };
  }
  if (opened) return { sentence: words.openedFor(opened.name), notes: named };
  if (plan.follows || plan.plan?.kind === 'follow')
    return { sentence: words.followsShared, notes: named };
  if (plan.name) return { sentence: plan.name, notes: [] };
  return { sentence: words.unknown(chainName), notes: [] };
}

export function PlanCard({ chain, plan }: { chain: PlansChain; plan: Plan }) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const sentenceId = useId();
  const words = w.overview.card;
  const { newest, putIn } = plan;

  // The card is live only when everything it shows is.
  const label = leastLive(
    chain.provenance,
    plan.provenance,
    ...(newest ? [newest.provenance] : []),
    ...(putIn ? [putIn.provenance] : []),
  );
  const said = sayStatus(plan.status, lang, w.status, (asset) => displayName(asset, t.plan));

  const sheet = plan.plan?.sheet;
  const put = putIn ? Number(putIn.usd) : null;
  const goal = sheet
    ? {
        // The goal, at what was put in, as the monitor's card says it: a goal of $50,000 that $40
        // went into is not said as $50,000, and the income asked of the plan's amount is not said of
        // another (features/portfolio/VaultGoalCard.tsx).
        sentence:
          put !== null && put !== sheet.amountUsd
            ? goalLine(
                { ...sheet, incomeTargetUsdMonthly: undefined },
                t,
                whole(put, lang),
                (usd) => whole(usd, lang),
              )
            : goalLine(sheet, t, whole(sheet.amountUsd, lang), (usd) => whole(usd, lang)),
        notes: plan.name ? [plan.name] : [],
      }
    : sentenceOf(plan, words, nameOf(plan.chain));

  const missing = newest ? newest.positions.filter((p) => p.valueUsd === null).length : 0;
  const age = newest ? formatAge(newest.ageSeconds) : null;
  const ago = age
    ? `${age.count} ${t.pin.age[age.unit][age.count === 1 ? 0 : 1] ?? ''}`.trim()
    : t.pin.ageUnknown;

  return (
    <li
      data-ui="plan-card"
      data-chain={plan.chain}
      data-address={plan.address}
      data-line={plan.status.line}
      className="flex"
    >
      <Card
        as="article"
        interactive
        aria-labelledby={sentenceId}
        mock={label !== 'live'}
        mockLabels={{ announce: sampleLine(t.shell, label) }}
        className="w-full"
      >
        <div className="flex flex-col items-start gap-3 p-6">
          <h3
            id={sentenceId}
            className="max-w-(--tf-measure-display) font-display text-h3 font-normal text-balance [font-variation-settings:'opsz'_36]"
          >
            {goal.sentence}
          </h3>
          {goal.notes.map((note) => (
            <p key={note} data-ui="plan-note" className="text-caption text-muted-foreground">
              {note}
            </p>
          ))}

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
          <p data-ui="plan-reason" className="text-body-sm text-foreground">
            {said.reason}
          </p>

          <dl
            data-ui="plan-figures"
            className="grid w-full gap-x-6 gap-y-1 text-body-sm min-[480px]:grid-cols-[auto_1fr]"
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
          <p data-ui="plan-rule" className="font-mono text-source text-muted-foreground">
            {w.status.rule(said.rule)}
          </p>

          <Link
            href={planHref(plan.chain, plan.address)}
            // every card's link reads the same: its goal says which plan it opens
            aria-describedby={sentenceId}
            className={cn(
              buttonClass({ variant: 'link' }),
              'after:absolute after:inset-0 group-hover/card:decoration-2',
            )}
          >
            {words.open}
          </Link>
        </div>
      </Card>
    </li>
  );
}
