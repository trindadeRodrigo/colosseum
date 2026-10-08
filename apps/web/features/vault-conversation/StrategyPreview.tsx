'use client';
import { useId } from 'react';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { dollars, share } from '../portfolio/figures';
import { HoldingsBar } from '../shared/HoldingsBar';
import type { VaultStrategyPreview } from './agent';

export function sourceValue(lang: Lang, value: number | null | undefined, unit?: string): string {
  if (value == null) return '—';
  if (unit === 'USD') return dollars(lang, String(value));
  if (unit === 'fraction' || unit === 'bps' || unit === 'percent' || unit === '%') {
    return new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(unit === 'fraction' ? value : unit === 'bps' ? value / 10000 : value / 100);
  }
  return `${new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 6 }).format(value)}${unit ? ` ${unit}` : ''}`;
}

/** A sourced visual preview; this component has no order, signing or execution capability. */
export function StrategyPreview({
  proposal,
  targets,
  previewOnly,
}: {
  proposal: VaultStrategyPreview;
  targets?: { asset: string; targetBps: number }[];
  previewOnly?: string;
}) {
  const id = useId();
  const t = useT();
  const copy = t.shared.vault.conversation;
  const language = useLang();
  return (
    <>
      <Card
        as="section"
        aria-labelledby={id}
        mock={proposal.sources.some((source) => source.provenance !== 'live')}
        mockLabels={{
          announce: proposal.sources.some((source) => source.provenance === 'mock')
            ? t.shell.mockAnnounce
            : t.shell.testNetworkLine,
        }}
      >
        <CardHeader id={id} title={copy.proposed} />
        <CardBody className="flex min-w-0 flex-col gap-4">
          <p className="text-body font-medium [overflow-wrap:anywhere]">{proposal.objective}</p>
          <p className="text-body-sm [overflow-wrap:anywhere]">{proposal.summary}</p>
          <p className="text-caption text-muted-foreground">{previewOnly ?? copy.previewOnly}</p>
          <HoldingsBar
            shares={proposal.allocations.map((line) => ({
              key: line.assetId,
              shareBps: line.weightBps,
            }))}
          />
          {targets && <p className="text-caption text-muted-foreground">{copy.comparison}</p>}
          <ul className="flex flex-col gap-4">
            {proposal.allocations.map((line) => (
              <li key={line.assetId} className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <AssetMark asset={line.assetId} />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {line.symbol ?? displayName(line.assetId, t.plan)}
                  </span>
                  <span className="shrink-0 text-caption tabular-nums">
                    {targets && (
                      <>
                        {share(
                          language,
                          targets.find((row) => row.asset === line.assetId)?.targetBps ?? 0,
                        )}{' '}
                        →{' '}
                      </>
                    )}
                    {share(language, line.weightBps)}
                  </span>
                </div>
                <p className="text-body-sm [overflow-wrap:anywhere]">{line.why}</p>
                <p className="font-mono text-source text-muted-foreground [overflow-wrap:anywhere]">
                  {line.evidenceIds.join(' · ')}
                </p>
              </li>
            ))}
          </ul>
          {targets
            ?.filter((row) => !proposal.allocations.some((line) => line.assetId === row.asset))
            .map((row) => (
              <p key={row.asset} className="text-caption [overflow-wrap:anywhere]">
                {displayName(row.asset, t.plan)} · {share(language, row.targetBps)} →{' '}
                {share(language, 0)}
              </p>
            ))}
          <details>
            <summary className="cursor-pointer text-body-sm">{copy.reasons}</summary>
            <div className="flex flex-col gap-3 pt-3">
              {proposal.tradeoffs.length > 0 && (
                <div>
                  <h3 className="text-caption font-medium">{copy.tradeoffs}</h3>
                  <ul className="list-inside list-disc text-body-sm">
                    {proposal.tradeoffs.map((word) => (
                      <li key={word} className="[overflow-wrap:anywhere]">
                        {word}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {proposal.unknowns.length > 0 && (
                <div>
                  <h3 className="text-caption font-medium">{copy.unknowns}</h3>
                  <ul className="list-inside list-disc text-body-sm">
                    {proposal.unknowns.map((word) => (
                      <li key={word} className="[overflow-wrap:anywhere]">
                        {word}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <h3 className="text-caption font-medium">{copy.sources}</h3>
              {proposal.sources.map((source) => (
                <div key={source.id} className="min-w-0 text-caption [overflow-wrap:anywhere]">
                  <ProvenancePin
                    value={
                      source.label
                        ? `${source.label}: ${sourceValue(language, source.value, source.unit)}`
                        : source.id
                    }
                    obs={source}
                    labels={t.pin}
                  />
                </div>
              ))}
            </div>
          </details>
        </CardBody>
      </Card>
      <Disclaimer lang={language} label={t.shell.disclaimer} />
    </>
  );
}
