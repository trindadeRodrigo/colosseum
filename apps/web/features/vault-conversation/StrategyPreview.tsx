'use client';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { dollars } from '../portfolio/figures';
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
  onDiscuss,
  use,
}: {
  proposal: VaultStrategyPreview;
  targets?: { asset: string; targetBps: number }[];
  previewOnly?: string;
  onDiscuss?: () => void;
  /** The one action this preview leads to: buying it for a new goal, or applying it to the vault. */
  use?: { label: string; onUse: () => void };
}) {
  const id = useId();
  const t = useT();
  const copy = t.shared.vault.conversation;
  const language = useLang();
  const rows = [
    ...proposal.allocations.map((line) => ({
      asset: line.assetId,
      symbol: line.symbol,
      proposed: line.weightBps,
      current: targets?.find((row) => row.asset === line.assetId)?.targetBps ?? 0,
      why: line.why,
    })),
    ...(targets ?? [])
      .filter((row) => !proposal.allocations.some((line) => line.assetId === row.asset))
      .map((row) => ({
        asset: row.asset,
        symbol: undefined,
        proposed: 0,
        current: row.targetBps,
        why: copy.removed,
      })),
  ];
  const allocationShare = (bps: number) => sourceValue(language, bps / 10000, 'fraction');
  const m = t.mix.preview;
  const nameOf = (asset: string) =>
    proposal.allocations.find((line) => line.assetId === asset)?.symbol ??
    displayName(asset, t.plan);
  const change = (bps: number) =>
    `${new Intl.NumberFormat(LOCALE[language], { maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(bps / 100).replace('-', '−')} ${copy.points}`;
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
          <div className="rounded-xs border border-dashed border-border p-2">
            <HoldingsBar
              shares={proposal.allocations.map((line) => ({
                key: line.assetId,
                shareBps: line.weightBps,
              }))}
            />
          </div>
          <table className="w-full table-fixed border-collapse text-body-sm">
            <caption className="sr-only">{targets ? copy.comparison : copy.proposed}</caption>
            <thead className="text-caption text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 text-start font-normal">
                  {t.shared.vault.columns.asset}
                </th>
                <th
                  scope="col"
                  className={`py-2 text-end font-normal ${targets ? 'w-[6.5rem] sm:w-[8.5rem]' : 'w-20'}`}
                >
                  {targets ? copy.comparison : copy.proposedShare}
                </th>
                {targets && (
                  <th scope="col" className="w-14 py-2 text-end font-normal">
                    {copy.change}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.asset} className="border-b border-border align-top">
                  <th scope="row" className="py-3 pr-2 text-start font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <AssetMark asset={row.asset} />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {row.symbol ?? displayName(row.asset, t.plan)}
                      </span>
                    </span>
                    <span className="mt-2 block text-caption text-muted-foreground [overflow-wrap:anywhere]">
                      {row.why}
                    </span>
                  </th>
                  <td className="py-3 text-end tabular-nums">
                    {targets
                      ? `${allocationShare(row.current)} → ${allocationShare(row.proposed)}`
                      : allocationShare(row.proposed)}
                  </td>
                  {targets && (
                    <td className="py-3 text-end text-caption tabular-nums">
                      {change(row.proposed - row.current)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <WeightNotes notes={proposal.weightNotes} allocations={proposal.allocations} />
          {proposal.warnings.length > 0 && (
            <div data-ui="mix-warnings" className="flex flex-col gap-2">
              <h3 className="text-caption font-medium">{m.warnings}</h3>
              {proposal.warnings.map((warning) => {
                const figure = proposal.sources.find((source) => source.id === warning.evidenceId);
                return (
                  <p
                    key={`${warning.code}:${warning.assetId}`}
                    data-warning={warning.code}
                    className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
                  >
                    <StatusMark status="watch" className="mt-1.5" />
                    <span className="[overflow-wrap:anywhere]">
                      {warning.code === 'over_exit_capacity'
                        ? m.warning.overExit(nameOf(warning.assetId))
                        : m.warning.outsideGoal(nameOf(warning.assetId))}
                      {warning.code === 'over_exit_capacity' && figure?.value != null && (
                        <>
                          {' '}
                          <ProvenancePin
                            value={`${figure.label ?? ''}: ${sourceValue(language, figure.value, figure.unit)}`}
                            obs={figure}
                            labels={t.pin}
                          />
                        </>
                      )}
                    </span>
                  </p>
                );
              })}
            </div>
          )}
          {(onDiscuss || use) && (
            <div className="flex flex-wrap gap-3">
              {use && (
                <Button variant="secondary" size="dense" data-action="use-mix" onClick={use.onUse}>
                  {use.label}
                </Button>
              )}
              {onDiscuss && (
                <Button variant="secondary" size="dense" onClick={onDiscuss}>
                  {copy.discuss}
                </Button>
              )}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-body-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {copy.reasons}
            </summary>
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

/**
 * What the server did with the weights, in words: the code, the served picks and the person's own
 * quote. Also stands alone under a reply with no proposal, where a share was not applied.
 */
export function WeightNotes({
  notes,
  allocations = [],
}: {
  notes: readonly VaultStrategyPreview['weightNotes'][number][];
  allocations?: VaultStrategyPreview['allocations'];
}) {
  const t = useT();
  const language = useLang();
  const m = t.mix.preview;
  if (notes.length === 0) return null;
  const names = (assets: readonly string[]) =>
    new Intl.ListFormat(LOCALE[language], { type: 'conjunction' }).format(
      assets.map(
        (asset) =>
          allocations.find((line) => line.assetId === asset)?.symbol ?? displayName(asset, t.plan),
      ),
    );
  const noteOf = (note: (typeof notes)[number]): string => {
    switch (note.code) {
      case 'equal_split':
        return note.assetIds.length === allocations.length
          ? m.note.equalAll
          : m.note.equalRest(names(note.assetIds));
      case 'stated':
        return m.note.stated(names(note.assetIds), note.quote ?? '');
      case 'scaled':
        return m.note.scaled;
      case 'pick_dropped':
        return m.note.dropped(names(note.assetIds));
      case 'share_unmet':
        return m.note.unmet(note.quote ?? '');
      case 'share_unread':
        return m.note.unread(note.quote ?? '');
      case 'share_withdrawn':
        return m.note.withdrawn(note.quote ?? '');
    }
  };
  return (
    <div data-ui="weight-notes">
      <h3 className="text-caption font-medium">{allocations.length ? m.notes : m.notesAlone}</h3>
      <ul className="list-inside list-disc text-body-sm">
        {notes.map((note) => (
          <li
            key={`${note.code}:${note.assetIds.join(',')}:${note.quote ?? ''}`}
            className="[overflow-wrap:anywhere]"
          >
            {noteOf(note)}
          </li>
        ))}
      </ul>
    </div>
  );
}
