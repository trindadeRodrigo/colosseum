'use client';
import type { ExposureExit, Provenance } from '@colosseum/schemas';
import { useId } from 'react';
import { Card, CardBody } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName, kindLabel } from '../order/plain';
import { dollars, sharesOf } from '../portfolio/figures';
import type { ExposureAnswer, ExposureChain, Plan, PlansChain } from './api';
import type { Reading } from './PortfolioProvider';
import { ChainsOut, sampleLine } from './parts';
import { exitPin, exposurePin, leastLive } from './pins';
import { Block, BlockRead } from './plan-blocks';
import { useWords } from './words';

// Two blocks of a plan's page that stand on one read, GET /v1/portfolio/exposure narrowed to the
// plan's vault: what leaving would cost, and where the risk sits.
//
// What leaving would cost is one line for each asset held that is not cash: Bearing's measured cost of
// selling the vault's whole holding of it, alone, in basis points on its own pin; or, where Bearing
// does not measure the asset, the sentence that it is not measured and that its tier, named, is only a
// ceiling on its share and states no cost (gate EXIT-SOURCE). A cost never stands without its pin: one
// whose answer carries no time, or no source, shows no number and says so. The page says once what
// the figure is: one asset sold alone at this size, never the cost of selling everything at once.
//
// Where the risk sits is the roll-up of packages/basket over the same holdings: the vault's shares by
// issuer and by kind of asset, of a value that carries the answer's own pin, and each flag the
// roll-up raised as a sentence. A flag this page has no sentence for is shown by its own name.

type Shown = { chain: PlansChain; plan: Plan; read: Reading<ExposureAnswer> };

/** The chain's entry of the answer under the labels of what it sits in, and whether the chain was left out. */
function entryOf(answer: ExposureAnswer, chain: PlansChain, plan: Plan) {
  const entry = answer.chains.find((c) => c.chain === plan.chain) ?? null;
  return {
    entry,
    out: answer.unavailable.find((u) => u.chain === plan.chain) ?? null,
    label: leastLive(chain.provenance, plan.provenance, ...(entry ? [entry.provenance] : [])),
  };
}

/** The pin of the vault's sums, never more live than the vault's chain. Null where no snapshot stands behind them. */
function sumsPin(entry: ExposureChain, label: Provenance): PinSource | null {
  const pin = exposurePin(entry);
  return pin && { ...pin, provenance: leastLive(pin.provenance, label) };
}

export function PlanExit({ chain, plan, read }: Shown) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const words = w.plan.exit;
  const name = (asset: string) => displayName(asset, t.plan);
  const number = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 2 }).format(bps).replace('-', '−');

  /** What is said of the cost of one holding: the figure on its pin, or why there is none. */
  const cost = (exit: ExposureExit, label: Provenance) => {
    if (!exit.measured)
      return exit.fallbackTier ? words.tier(exit.fallbackTier) : words.notMeasured;
    if (exit.costBps === null) return words.beyond;
    const pin = exitPin(exit, label);
    // no pin, no number: the measurement came without its time, or without its source
    if (!pin) return exit.fetchedAt === undefined ? words.notDated : words.noSource;
    return (
      <ProvenancePin
        value={words.cost(exit.costBps, number(exit.costBps))}
        obs={pin}
        labels={t.pin}
      />
    );
  };

  return (
    <Block ui="plan-exit" heading={words.heading} lead={words.lead}>
      <BlockRead read={read} label={words.reading} skeleton={<SkeletonRows rows={2} columns={2} />}>
        {(answer) => {
          const { entry, out, label } = entryOf(answer, chain, plan);
          if (out) return <ChainsOut unavailable={[out]} />;
          const size = entry && sumsPin(entry, label);
          if (!entry || !size)
            return (
              <p data-ui="exit-nothing" className="text-body-sm text-foreground">
                {words.nothing}
              </p>
            );
          const unvalued = [...new Set(entry.unvalued.map((held) => name(held.asset)))];
          return (
            <Card mock={label !== 'live'} mockLabels={{ announce: sampleLine(t.shell, label) }}>
              <CardBody className="flex flex-col gap-4">
                {entry.exit.length === 0 ? (
                  <p data-ui="exit-none" className="text-body-sm text-foreground">
                    {words.none}
                  </p>
                ) : (
                  <ul data-ui="exit-lines" className="flex list-none flex-col p-0">
                    {entry.exit.map((exit) => (
                      <li
                        key={exit.asset}
                        data-ui="exit-line"
                        data-asset={exit.asset}
                        className="flex flex-col gap-1 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
                      >
                        <p className="text-body-sm font-medium">{name(exit.asset)}</p>
                        <dl className="grid gap-x-6 gap-y-1 text-body-sm min-[480px]:grid-cols-[auto_1fr]">
                          <dt className="text-muted-foreground">{words.holding}</dt>
                          <dd data-ui="exit-size" className="tabular-nums">
                            <ProvenancePin
                              value={dollars(lang, exit.usd)}
                              obs={size}
                              labels={t.pin}
                            />
                          </dd>
                          <dt className="text-muted-foreground">{words.costLabel}</dt>
                          <dd data-ui="exit-cost" className="tabular-nums">
                            {cost(exit, label)}
                          </dd>
                        </dl>
                      </li>
                    ))}
                  </ul>
                )}
                {unvalued.length > 0 && (
                  <p data-ui="exit-unvalued" className="text-body-sm text-muted-foreground">
                    {words.unvalued(
                      unvalued.length,
                      new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(unvalued),
                    )}
                  </p>
                )}
              </CardBody>
            </Card>
          );
        }}
      </BlockRead>
    </Block>
  );
}

type Share = { key: string; bps: number };

export function PlanRisk({ chain, plan, read }: Shown) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const flagsId = useId();
  const words = w.plan.risk;

  /** A flag of the roll-up as a sentence; one with no sentence here, by its own name. */
  const flagSaid = (flag: string): string => {
    const known: Record<string, string> = words.flags.known;
    const sentence = Object.hasOwn(known, flag) ? known[flag] : undefined;
    if (sentence) return sentence;
    const [code, kind = ''] = flag.split(':');
    const kinds: Record<string, string> = words.flags.kinds;
    const source = Object.hasOwn(kinds, kind) ? (kinds[kind] as string) : words.flags.otherKind;
    if (code === 'quoted_provenance' && kind !== '') return words.flags.quoted(source);
    if (code === 'measured_provenance' && kind !== '') return words.flags.measured(source);
    return words.flags.unknown(flag);
  };

  const shares = (caption: string, rows: readonly Share[], said: (key: string) => string) => {
    const written = sharesOf(
      lang,
      rows.map((row) => row.bps),
    );
    return (
      <DataTable<Share>
        caption={caption}
        rows={rows}
        rowKey={(row) => row.key}
        columns={[
          {
            key: 'name',
            header: t.plan.risk.name,
            rowHeader: true,
            cell: (row) => said(row.key),
          },
          {
            key: 'share',
            header: t.plan.risk.share,
            numeric: true,
            cell: (row) => written[rows.indexOf(row)] ?? '',
          },
        ]}
      />
    );
  };

  return (
    <Block ui="plan-risk" heading={words.heading} lead={words.lead}>
      <BlockRead read={read} label={words.reading} skeleton={<SkeletonRows rows={3} columns={2} />}>
        {(answer) => {
          const { entry, out, label } = entryOf(answer, chain, plan);
          if (out) return <ChainsOut unavailable={[out]} />;
          const pin = entry && sumsPin(entry, label);
          // null where the vault holds nothing with a value: there is no split, and it is said
          if (!entry || !pin || !entry.rollUp)
            return (
              <p data-ui="risk-nothing" className="text-body-sm text-foreground">
                {words.nothing}
              </p>
            );
          const flags = [...new Set(entry.rollUp.flags.map(flagSaid))];
          return (
            <Card mock={label !== 'live'} mockLabels={{ announce: sampleLine(t.shell, label) }}>
              <CardBody className="flex flex-col gap-6">
                <p data-ui="risk-of" className="text-body-sm">
                  {words.of}{' '}
                  <ProvenancePin value={dollars(lang, entry.valueUsd)} obs={pin} labels={t.pin} />
                </p>
                <div className="grid gap-6 min-[700px]:grid-cols-2">
                  <div data-ui="risk-issuers">
                    {shares(t.plan.risk.byIssuer, entry.rollUp.byIssuer, (key) => key)}
                  </div>
                  <div data-ui="risk-classes">
                    {shares(t.plan.risk.byClass, entry.rollUp.byClass, (key) =>
                      kindLabel(key, t.plan.kinds),
                    )}
                  </div>
                </div>
                {/* on the mock every issuer is the mock: the split says nothing of a real one */}
                {entry.provenance === 'mock' && (
                  <p data-ui="risk-stand-in" className="text-body-sm text-muted-foreground">
                    {words.standIn}
                  </p>
                )}
                <section aria-labelledby={flagsId} className="flex flex-col gap-2">
                  <h3 id={flagsId} className="text-h4 font-semibold">
                    {words.flags.heading}
                  </h3>
                  {flags.length === 0 ? (
                    <p data-ui="risk-no-flags" className="text-body-sm text-foreground">
                      {words.flags.none}
                    </p>
                  ) : (
                    <ul
                      data-ui="risk-flags"
                      className="flex list-disc flex-col gap-1 pl-5 text-body-sm"
                    >
                      {flags.map((flag) => (
                        <li key={flag}>{flag}</li>
                      ))}
                    </ul>
                  )}
                </section>
              </CardBody>
            </Card>
          );
        }}
      </BlockRead>
    </Block>
  );
}
