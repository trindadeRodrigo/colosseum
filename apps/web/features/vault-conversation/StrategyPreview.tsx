'use client';
import { type CSSProperties, useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { LatticeLoader } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { useWaitPhase } from '../../components/ui/wait';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { dollars } from '../portfolio/figures';
import { fillOf, MixJoint, staggerMs, useJointMotion } from '../shared/MixJoint';
import type { VaultStrategyPreview } from './agent';
import { ProjectionChart } from './ProjectionChart';

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

/**
 * A sourced visual preview; this component has no order, signing or execution capability.
 *
 * The mix is drawn as a joint (MixJoint.tsx) tied to the rows under it: pointing at a piece lights its
 * row and pointing at a row lights its piece. A mix that has just come assembles, and one that
 * follows another moves only what changed. Every figure on the card is the proposal's own from the
 * first frame: motion slides and fades a final figure in, and never counts up to it.
 */
export function StrategyPreview({
  proposal,
  targets,
  previewOnly,
  pending,
  onDiscuss,
  use,
}: {
  proposal: VaultStrategyPreview;
  targets?: { asset: string; targetBps: number }[];
  previewOnly?: string;
  /**
   * A reply is on its way and this is the draft before it: the words that say so. The card stays, dimmed,
   * and its action waits, so the new draft can show what changed.
   */
  pending?: string;
  onDiscuss?: () => void;
  /**
   * The one action this preview leads to: a deposit for a new goal, which is the card's primary
   * button, or applying it to the vault.
   */
  use?: { label: string; onUse: () => void; primary?: boolean };
}) {
  const [pointed, setLit] = useState<string | null>(null);
  // a row the next draft dropped cannot stay lit
  const lit = proposal.allocations.some((line) => line.assetId === pointed) ? pointed : null;
  // how the mix on the card came to be there: a first one arrives, a next one changes it
  const shares = useMemo(
    () => proposal.allocations.map((line) => ({ key: line.assetId, bps: line.weightBps })),
    [proposal],
  );
  const { motion, run } = useJointMotion(shares);
  // the loader beside the pending words comes only once the wait is over 400ms (STYLE.md)
  const waiting = useWaitPhase(Boolean(pending)) !== 'quiet';
  const t = useT();
  const copy = t.shared.vault.conversation;
  const language = useLang();
  // The mix, or the monthly evolution when the server projected one from sourced yields.
  const [view, setView] = useState<'mix' | 'monthly'>('mix');
  const monthly = proposal.projection;
  const showing = monthly ? view : 'mix';
  const rows = [
    ...proposal.allocations.map((line, piece) => ({
      asset: line.assetId,
      piece: piece as number | null,
      symbol: line.symbol,
      proposed: line.weightBps,
      current: targets?.find((row) => row.asset === line.assetId)?.targetBps ?? 0,
      why: line.why,
    })),
    ...(targets ?? [])
      .filter((row) => !proposal.allocations.some((line) => line.assetId === row.asset))
      .map((row) => ({
        asset: row.asset,
        piece: null,
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
  const stagger = staggerMs(proposal.allocations.length);
  /** When a row follows its piece in: as the piece starts to slide home, on arrival and on a change. */
  const rowDelay = (row: (typeof rows)[number]): CSSProperties | undefined => {
    if (motion.kind === 'still' || row.piece === null) return undefined;
    const ms = (motion.kind === 'arrive' ? Math.round(row.piece * stagger) : 0) + 160;
    return { '--tf-joint-delay': `${ms}ms` } as CSSProperties;
  };
  const enters = (row: (typeof rows)[number]) =>
    row.piece !== null &&
    (motion.kind === 'arrive' || (motion.kind === 'change' && !motion.from.has(row.asset)));
  const figureMoves = (row: (typeof rows)[number]) =>
    enters(row) || (motion.kind === 'change' && motion.from.get(row.asset)?.bps !== row.proposed);
  return (
    <>
      <Card
        as="section"
        aria-label={copy.proposed}
        mock={proposal.sources.some((source) => source.provenance !== 'live')}
        mockLabels={{
          announce: proposal.sources.some((source) => source.provenance === 'mock')
            ? t.shell.mockAnnounce
            : t.shell.testNetworkLine,
        }}
      >
        <CardBody className="flex min-w-0 flex-col gap-4">
          <p className="text-body font-medium [overflow-wrap:anywhere]">{proposal.objective}</p>
          <p className="text-body-sm [overflow-wrap:anywhere]">{proposal.summary}</p>
          {/* One line's place for two: the note on the draft, or that a new one is being worked on. */}
          <div className="grid">
            <p
              aria-hidden={pending ? true : undefined}
              className={cn(
                'col-start-1 row-start-1 text-caption text-muted-foreground',
                pending && 'invisible',
              )}
            >
              {previewOnly ?? copy.previewOnly}
            </p>
            {/* the region is there before its words are, so a screen reader hears them come */}
            <p
              role="status"
              data-ui="preview-pending"
              className="col-start-1 row-start-1 flex items-start gap-2 text-caption text-muted-foreground"
            >
              {pending && (
                <>
                  <span className="flex size-5 shrink-0 items-center">
                    {waiting && <LatticeLoader size={16} />}
                  </span>
                  {pending}
                </>
              )}
            </p>
          </div>
          {monthly && (
            <fieldset
              aria-label={copy.view.label}
              data-ui="preview-view"
              className="m-0 flex min-w-0 gap-1 self-start rounded-full border border-border p-0.5"
            >
              {(['mix', 'monthly'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={showing === v}
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded-full px-3 py-1 text-caption font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    showing === v
                      ? 'bg-honey-tint text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {copy.view[v]}
                </button>
              ))}
            </fieldset>
          )}
          {showing === 'monthly' && monthly && (
            <ProjectionChart
              projection={monthly}
              lang={language}
              sample={monthly.sourceIds.some(
                (id) => proposal.sources.find((source) => source.id === id)?.provenance !== 'live',
              )}
            />
          )}
          {/* Only the beam recedes while a reply is on its way: every word and figure stays as
              readable as it was. */}
          <MixJoint
            pieces={rows.flatMap((row) =>
              row.piece === null
                ? []
                : [
                    {
                      key: row.asset,
                      bps: row.proposed,
                      name: row.symbol ?? displayName(row.asset, t.plan),
                      share: allocationShare(row.proposed),
                    },
                  ],
            )}
            words={{
              label: copy.jointLabel,
              hint: copy.jointHint,
              widenedLabel: copy.jointLabelWidened,
              widenedHint: copy.jointHintWidened,
            }}
            lit={lit}
            onLit={setLit}
            motion={motion}
            run={run}
            receded={Boolean(pending)}
          />
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
                <tr
                  key={row.asset}
                  data-row={row.asset}
                  data-lit={row.piece !== null ? lit === row.asset : undefined}
                  {...(row.piece !== null
                    ? {
                        // the row answers as its piece does: a mouse over it, or a finger's tap
                        onPointerEnter: (e) => e.pointerType === 'mouse' && setLit(row.asset),
                        onPointerLeave: (e) => e.pointerType === 'mouse' && setLit(null),
                        onPointerUp: (e) => {
                          if (e.pointerType !== 'mouse')
                            setLit((now) => (now === row.asset ? null : row.asset));
                        },
                      }
                    : {})}
                  style={enters(row) ? rowDelay(row) : undefined}
                  className={cn(
                    'border-b border-border align-top motion-safe:transition-colors motion-safe:duration-(--tf-dur-fade)',
                    lit === row.asset && 'bg-muted',
                    enters(row) && 'tf-joint-row',
                  )}
                >
                  <th scope="row" className="py-3 pr-2 pl-1 text-start font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      {/* the piece's own colour, so the row and the piece are one thing to the eye */}
                      <span
                        aria-hidden="true"
                        data-part="swatch"
                        className={cn(
                          'size-2.5 shrink-0',
                          row.piece === null ? 'border border-border' : fillOf(row.piece),
                        )}
                      />
                      <AssetMark asset={row.asset} />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {row.symbol ?? displayName(row.asset, t.plan)}
                      </span>
                    </span>
                    <span className="mt-2 block text-caption text-muted-foreground [overflow-wrap:anywhere]">
                      {row.why}
                    </span>
                  </th>
                  <td className="py-3 pr-1 text-end tabular-nums">
                    {/* the final figure, whole, from the first frame: it drops in, it never counts */}
                    <span
                      key={`${row.current}:${row.proposed}`}
                      data-part="share"
                      style={figureMoves(row) ? rowDelay(row) : undefined}
                      className={cn('inline-block', figureMoves(row) && 'tf-joint-figure')}
                    >
                      {targets
                        ? `${allocationShare(row.current)} → ${allocationShare(row.proposed)}`
                        : allocationShare(row.proposed)}
                    </span>
                  </td>
                  {targets && (
                    <td className="py-3 pr-1 text-end text-caption tabular-nums">
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
                <Button
                  variant={use.primary ? 'primary' : 'secondary'}
                  size={use.primary ? 'default' : 'dense'}
                  data-action={use.primary ? 'deposit' : 'use-mix'}
                  disabled={Boolean(pending)}
                  onClick={use.onUse}
                >
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
