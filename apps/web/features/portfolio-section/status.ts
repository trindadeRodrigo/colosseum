import type { TrackLine, TrackStatus, TrackWord } from '@colosseum/schemas';
import type { StatusKind } from '../../components/ui/StatusMark';
import { type Lang, LOCALE } from '../../i18n';
import type { PortfolioDictionary } from '../../i18n/portfolio';
import { share } from '../portfolio/figures';

// A plan's status as a page says it (gate ON-TRACK-V1): the server's word with its shape, and the
// reason in the person's language, made from the line of the rule that gave it and the figures that
// line names. Nothing here decides a status or reads a clock: `status.status` and `status.line` are the
// server's, and the server's own English sentence (`status.text`) is never shown.

export type SaidStatus = {
  /** The shape and colour of the mark; null where the rule gives no status yet. */
  kind: StatusKind | null;
  /** "On track", "Watch", "Off track", or "No status yet". */
  word: string;
  /** Why, in one sentence. Where there is no status, why there is none. */
  reason: string;
  /** The rule's name as the server printed it: `ON-TRACK-V1`, or the rule of a verdict handed in. */
  rule: string;
  /** The line of the rule that gave the status. */
  line: TrackLine;
};

const KIND: Record<TrackWord, StatusKind> = {
  on_track: 'on-track',
  watch: 'watch',
  off_track: 'off-track',
};

/** The mark of a status word. */
export const statusKind = (word: TrackWord): StatusKind => KIND[word];

/** A whole percent as the language writes it: `12%`. */
const percent = (lang: Lang, whole: number) =>
  new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 0 }).format(
    whole / 100,
  );

/**
 * The sentence of a line, from the figures it names. Null where a figure the sentence needs did not
 * come, or came as something else: the sentence is then not made up.
 */
function reasonOf(
  status: TrackStatus,
  lang: Lang,
  words: PortfolioDictionary['status']['lines'],
  nameOf: (assetId: string) => string,
): string | null {
  const { params } = status;
  const number = (key: string) => {
    const value = params[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const text = (key: string) => {
    const value = params[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  /** Basis points as a share, and never a negative one. */
  const bps = (key: string) => {
    const value = number(key);
    return value === null ? null : share(lang, Math.abs(value));
  };
  const used = () => {
    const value = number('usedPct');
    return value === null ? null : percent(lang, value);
  };
  const asset = () => {
    const id = text('asset');
    return id === null ? null : nameOf(id);
  };

  switch (status.line) {
    case 'verdict': {
      const now = number('coveredNow');
      if (now === null) return null;
      const stress = number('coveredUnderStress');
      const found =
        now === 0
          ? words.verdict.notCovered
          : stress === null
            ? words.verdict.coveredNoStress
            : stress === 0
              ? words.verdict.coveredNotStress
              : words.verdict.coveredBoth;
      const day = text('observedOn');
      return day === null ? found : `${found} ${words.verdict.observedOn(day)}`;
    }
    case 'never_read':
      return words.never_read;
    case 'empty':
      return words.empty;
    case 'chain_silent': {
      const hours = number('hours');
      return hours === null ? null : words.chain_silent(hours);
    }
    case 'loss_half': {
      const spent = used();
      return spent === null ? null : words.loss_half(spent);
    }
    case 'unpriced': {
      const name = asset();
      const count = number('count');
      if (name === null || count === null) return null;
      return count === 1 ? words.unpriced.one(name) : words.unpriced.many(count, name);
    }
    case 'no_band':
      return words.no_band;
    case 'outside_band': {
      const name = asset();
      const drift = number('driftBps');
      const by = bps('driftBps');
      const band = bps('bandBps');
      if (name === null || drift === null || by === null || band === null) return null;
      return (drift > 0 ? words.outside_band.over : words.outside_band.under)(name, by, band);
    }
    case 'cash_over': {
      const by = bps('overBps');
      const band = bps('bandBps');
      return by === null || band === null ? null : words.cash_over(by, band);
    }
    case 'loss_quarter': {
      const spent = used();
      return spent === null ? null : words.loss_quarter(spent);
    }
    case 'stale': {
      const minutes = number('minutes');
      return minutes === null ? null : words.stale(minutes);
    }
    case 'inside': {
      const band = bps('bandBps');
      const spent = used();
      return band === null || spent === null ? null : words.inside(band, spent);
    }
    case 'inside_no_budget': {
      const band = bps('bandBps');
      return band === null ? null : words.inside_no_budget(band);
    }
  }
}

/**
 * A status as a page says it. `nameOf` names an asset as the screens do ("USDY (Ondo)"), for the lines
 * that name one.
 */
export function sayStatus(
  status: TrackStatus,
  lang: Lang,
  words: PortfolioDictionary['status'],
  nameOf: (assetId: string) => string,
): SaidStatus {
  return {
    kind: status.status === null ? null : KIND[status.status],
    word: status.status === null ? words.none : words.words[status.status],
    reason: reasonOf(status, lang, words.lines, nameOf) ?? words.noFigures,
    rule: status.rule,
    line: status.line,
  };
}
