'use client';
import type { ExposureExit } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { Card } from '../../components/ui/Card';
import { shorten } from '../../components/ui/format';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { useLang, useT } from '../../i18n/I18nProvider';
import { ChainMark } from '../account/ChainName';
import { tokenName } from '../order/amounts';
import { displayName } from '../order/plain';
import { dollars, sharesOf, tokens, utc } from '../portfolio/figures';
import type { ExposureChain } from './api';
import { flagsSaid, largestFirst } from './exposure';
import { basisPoints } from './list-figures';
import { planHref } from './pages';
import { sampleLine, useChainName } from './parts';
import { exitPin, exposurePin, leastLive } from './pins';
import { ShareBars, type ShareRow } from './ShareBars';
import { useWords } from './words';

// What a person holds on one chain, as GET /v1/portfolio/exposure answers it: how many vaults were
// counted and what they hold together, with the time of the oldest reading the sums stand on; the
// holdings by underlying and by issuer, largest first; what selling each holding that is not cash
// would cost; the risk roll-up's flags in a person's words; and the holdings with no price, which are
// in no sum. Every dollar figure carries the stamp of the chain's sums, and a selling cost Bearing's
// own: a cost with no source or no time is not written as a number. Nothing is added across chains.
// On the sample chain every issuer is a stand-in, so no split by issuer is drawn there.

const H3 = 'text-h4 font-semibold';

/** What the answer says of one holding's selling cost. */
type ExitState = 'measured' | 'undated' | 'unsourced' | 'beyond' | 'tier' | 'unmeasured';

function exitState(exit: ExposureExit, cost: PinSource | null): ExitState {
  // A tier is a ceiling on a share and states no cost: nothing is made from one.
  if (!exit.measured) return exit.fallbackTier ? 'tier' : 'unmeasured';
  // Measured, and this size is beyond what was measured.
  if (exit.costBps === null) return 'beyond';
  if (cost !== null) return 'measured';
  return exit.fetchedAt === undefined ? 'undated' : 'unsourced';
}

/** One holding that is not cash: its size, and what selling it alone would cost, or why no cost is shown. */
function ExitLine({
  exit,
  chain,
  holding,
}: {
  exit: ExposureExit;
  chain: Pick<ExposureChain, 'provenance'>;
  /** The stamp of the chain's sums, which the holding's dollars carry; null where they have none. */
  holding: PinSource | null;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const words = w.exposure.exit;
  const cost = exitPin(exit, chain.provenance);
  const state = exitState(exit, cost);
  return (
    <li
      data-ui="exit"
      data-asset={exit.asset}
      data-state={state}
      className="flex flex-col gap-1 py-3"
    >
      <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-body-sm">
        <span data-ui="exit-name" className="font-medium">
          {displayName(exit.asset, t.plan)}
        </span>
        {holding && (
          <span data-ui="exit-holding" className="tabular-nums">
            <span className="text-muted-foreground">{words.holding}</span>{' '}
            <ProvenancePin value={dollars(lang, exit.usd)} obs={holding} labels={t.pin} />
          </span>
        )}
      </p>
      <p data-ui="exit-cost" className="max-w-(--tf-measure-body) text-body-sm">
        {state === 'measured' && cost !== null && exit.costBps !== null ? (
          <>
            <span>{words.measured}</span>{' '}
            <span className="tabular-nums">
              <ProvenancePin
                value={words.bps(basisPoints(lang, exit.costBps))}
                obs={cost}
                labels={t.pin}
              />
            </span>
          </>
        ) : state === 'tier' ? (
          words.tier(exit.fallbackTier ?? '')
        ) : state === 'beyond' ? (
          words.beyond
        ) : state === 'undated' ? (
          words.undated
        ) : state === 'unsourced' ? (
          words.unsourced
        ) : (
          words.unmeasured
        )}
      </p>
    </li>
  );
}

export function ExposureChainBlock({ chain }: { chain: ExposureChain }) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const id = useId();
  const words = w.exposure;
  const name = nameOf(chain.chain);
  const pin = exposurePin(chain);
  const sample = chain.provenance === 'mock';
  const summed = chain.byUnderlying.length > 0 || chain.byIssuer.length > 0;
  // The block is live only when everything it shows is: the sums, and each measured cost.
  const label = leastLive(
    chain.provenance,
    ...chain.exit.flatMap((exit) => (exit.provenance ? [exit.provenance] : [])),
  );
  const flags = chain.rollUp ? flagsSaid(chain.rollUp.flags, words.flags.say, sample) : [];
  /** A list of shares as rows, largest first, the percentages rounded together so they add up. */
  const rowsOf = (
    shares: ExposureChain['byUnderlying'],
    said: (key: string) => string,
  ): ShareRow[] => {
    const sorted = largestFirst(shares);
    const percents = sharesOf(
      lang,
      sorted.map((share) => share.bps),
    );
    return sorted.map((share, i) => ({
      key: share.key,
      name: said(share.key),
      dollars: dollars(lang, share.usd),
      percent: percents[i] ?? '',
      bps: share.bps,
    }));
  };
  // A test network's placeholder issuer is said in words; every other issuer by its own name.
  const issuer = (key: string) => (key === 'test network' ? words.shares.testNetwork : key);

  return (
    <div data-ui="chain-exposure" data-chain={chain.chain}>
      <Card
        as="section"
        aria-labelledby={`${id}-chain`}
        mock={label !== 'live'}
        mockLabels={{ announce: sampleLine(t.shell, label) }}
      >
        <header className="flex flex-col gap-1 border-b border-border p-6">
          <h2
            id={`${id}-chain`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-h3 font-semibold"
          >
            <span>{name}</span>
            <ChainMark
              provenance={chain.provenance}
              labels={{ testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure }}
              announce={false}
            />
          </h2>
          {!summed ? (
            <p data-ui="exposure-no-sum" className="text-body">
              {words.chain.noPriced}
            </p>
          ) : pin === null ? (
            // sums with no time have no pin, so no figure of theirs is written
            <p data-ui="exposure-undated" className="text-body">
              {words.chain.undated}
            </p>
          ) : (
            <>
              <p data-ui="exposure-total" className="text-body">
                {words.chain.total(chain.vaults)}{' '}
                <ProvenancePin value={dollars(lang, chain.valueUsd)} obs={pin} labels={t.pin} />
              </p>
              <p data-ui="exposure-oldest" className="text-caption text-muted-foreground">
                {words.chain.oldest(utc(lang, pin.fetchedAt))}
              </p>
            </>
          )}
        </header>
        <div className="flex flex-col gap-8 p-6">
          {summed && pin !== null && (
            <>
              <section aria-labelledby={`${id}-underlying`} className="flex flex-col gap-3">
                <h3 id={`${id}-underlying`} className={H3}>
                  {words.shares.byUnderlying}
                </h3>
                <ShareBars
                  by="underlying"
                  labelledBy={`${id}-underlying`}
                  rows={rowsOf(chain.byUnderlying, (key) => key)}
                  obs={pin}
                  pinLabels={t.pin}
                />
              </section>
              {sample ? (
                <p
                  data-ui="issuer-stand-ins"
                  className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
                >
                  {words.shares.standIns}
                </p>
              ) : (
                <section aria-labelledby={`${id}-issuer`} className="flex flex-col gap-3">
                  <h3 id={`${id}-issuer`} className={H3}>
                    {words.shares.byIssuer}
                  </h3>
                  <ShareBars
                    by="issuer"
                    labelledBy={`${id}-issuer`}
                    rows={rowsOf(chain.byIssuer, issuer)}
                    obs={pin}
                    pinLabels={t.pin}
                  />
                </section>
              )}
            </>
          )}

          {chain.exit.length > 0 && (
            <section aria-labelledby={`${id}-exit`} className="flex flex-col gap-3">
              <h3 id={`${id}-exit`} className={H3}>
                {words.exit.heading}
              </h3>
              <ul
                data-ui="exits"
                aria-labelledby={`${id}-exit`}
                className="list-none divide-y divide-border border-y border-border p-0"
              >
                {chain.exit.map((exit) => (
                  <ExitLine key={exit.asset} exit={exit} chain={chain} holding={pin} />
                ))}
              </ul>
            </section>
          )}

          {flags.length > 0 && (
            <section aria-labelledby={`${id}-flags`} className="flex flex-col gap-3">
              <h3 id={`${id}-flags`} className={H3}>
                {words.flags.heading}
              </h3>
              <ul
                data-ui="flags"
                aria-labelledby={`${id}-flags`}
                className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1.5 pl-5 text-body-sm"
              >
                {flags.map(({ flag, sentence }) => (
                  <li key={flag} data-flag={flag}>
                    {sentence ?? (
                      // no sentence for it yet: its own name, never dropped
                      <>
                        {words.flags.unnamed}{' '}
                        <span data-ui="flag-name" className="font-mono text-source">
                          {flag}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {chain.unvalued.length > 0 && (
            <section aria-labelledby={`${id}-unvalued`} className="flex flex-col gap-3">
              <h3 id={`${id}-unvalued`} className={H3}>
                {words.unvalued.heading}
              </h3>
              <p data-ui="unvalued-note" className="max-w-(--tf-measure-body) text-body-sm">
                {words.unvalued.note}
              </p>
              <ul
                data-ui="unvalued"
                aria-labelledby={`${id}-unvalued`}
                className="flex list-none flex-col gap-1.5 p-0 text-body-sm"
              >
                {chain.unvalued.map((held) => {
                  const amount = tokens(lang, held.display);
                  return (
                    <li
                      key={`${held.vault}:${held.asset}`}
                      data-asset={held.asset}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
                    >
                      <span data-ui="unvalued-name" className="font-medium">
                        {displayName(held.asset, t.plan)}
                      </span>
                      {/* an amount held, as its vault's reading gave it: it has no price to go with it */}
                      {pin && (
                        <span className="tabular-nums">
                          <ProvenancePin
                            value={amount}
                            labelValue={`${amount} ${tokenName(held.asset)}`}
                            obs={pin}
                            labels={t.pin}
                          />
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {words.unvalued.vault}{' '}
                        <Link
                          href={planHref(chain.chain, held.vault)}
                          title={held.vault}
                          aria-label={words.unvalued.open(shorten(held.vault))}
                          className="font-mono text-source text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {shorten(held.vault)}
                        </Link>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </Card>
    </div>
  );
}
