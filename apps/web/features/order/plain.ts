import type { BasketLine, BasketProposal } from '@colosseum/schemas';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { dollars } from '../goal/sheet';

// The plan in plain words (Thom, Oct 6: the plan screen read as a list of engine codes). Nothing here
// shows an engine code: an asset by its name, a kind of asset by a word, a flag by a sentence, and a
// code this file does not know by one sentence that says only that there is a note. The sentences are
// the dictionary's, in the language of the view.

/** Names a person reads, by the token's symbol written in lower case: the shelf's symbols. */
const SYMBOLS: Record<string, string> = Object.fromEntries(
  [
    'USDC',
    'USDG',
    'USDY',
    'jlUSDC',
    'syrupUSDC',
    'SGOV',
    'SPYx',
    'QQQx',
    'NVDAx',
    'TSLAx',
    'AAPLx',
    'GOOGLx',
    'METAx',
    'MSFTx',
    'AMZNx',
    'SPCXx',
    'MSTRx',
    'CRCLx',
    'HOODx',
    'COINx',
    'PLTRx',
    'GLDx',
    'SOL',
    'JitoSOL',
    'cbBTC',
    'cbETH',
    'SPY',
    'QQQ',
    'NVDA',
    'TSLA',
    'AAPL',
    'META',
    'GLD',
    'SPCX',
    'MSTR',
    'CRCL',
  ].map((s) => [s.toLowerCase(), s]),
);

/** Who issues a dollar-yield token, where saying so tells the person what it is. */
const ISSUERS: Record<string, string> = {
  syrupusdc: 'Maple',
  jlusdc: 'Jupiter Lend',
  usdy: 'Ondo',
  sgov: 'iShares',
};

/** The cash tokens: shown as cash, with the token named after it. */
const CASH = new Set(['usdc', 'usdg', 'tusdc', 'tusdg']);

/** The asset is the chain's dollar, held as cash. */
export const isCashId = (assetId: string) =>
  CASH.has(assetId.slice(assetId.indexOf(':') + 1).toLowerCase());

/**
 * An asset as a person reads it: "syrupUSDC (Maple)", "Cash (USDC)", "NVDAx". A test network's token
 * (`tSPYx`) goes by the token it stands in for; the card says it is a test network. An asset this file
 * does not know goes by its symbol as the id writes it, in capitals, never by the id itself.
 */
export function displayName(assetId: string, words: Pick<Dictionary['plan'], 'cash'>): string {
  const tail = assetId.slice(assetId.indexOf(':') + 1).toLowerCase();
  if (CASH.has(tail)) return words.cash(tail.replace(/^t(?=usd)/, '').toUpperCase());
  const bare = SYMBOLS[tail] ? tail : tail.replace(/^t(?=[a-z])/, '');
  const symbol = SYMBOLS[bare] ?? (bare === 'gold' ? 'Gold' : bare.toUpperCase());
  const issuer = ISSUERS[bare];
  return issuer ? `${symbol} (${issuer})` : symbol;
}

/** A kind of asset (a class key of the roll-up) as a word; an unknown one is "other". */
export function kindLabel(key: string, words: Dictionary['plan']['kinds']): string {
  const k = key.replace(/-/g, '_') as keyof typeof words;
  return k in words && k !== 'other' ? (words[k] as string) : words.other;
}

/** A flag of the engine or the roll-up as one sentence. Never the code. */
export function flagSentence(
  flag: string,
  words: Dictionary['plan'],
  name: (assetId: string) => string,
): string {
  const [code = '', ...rest] = flag.split(':');
  const f = words.flagWords;
  // an asset id is `chain:token`, so it takes the next two parts
  const asset = rest.length >= 2 ? name(`${rest[0]}:${rest[1]}`) : (rest[0] ?? '');
  const currency = rest[0] ?? '';
  if (code.endsWith('_provenance')) return f.notLive;
  switch (code) {
    case 'ceiling_from_tier':
      return f.ceilingFromTier(asset);
    case 'coverage_from_tier':
      return f.coverageFromTier(asset);
    case 'exit_capacity_thin':
      return f.capacityThin(asset);
    case 'exit_regime_not_measured':
      return f.regimeNotMeasured(asset);
    case 'liquidity_undated':
      return f.undated(asset);
    case 'fx_open':
      return f.fxOpen(currency);
    case 'no_matching_leg':
      return f.noMatchingLeg(currency);
    case 'schedule_no_fx':
      return f.noFx(currency);
    case 'exit_quote_missing':
    case 'exit_quote_partial':
    case 'exit_quote_stale':
    case 'exit_quote_far_from_size':
      return f.noQuote;
    case 'set_aside_short':
    case 'coverage_short':
    case 'schedule_unpaid':
      return f.withdrawalsShort;
    default: {
      const plain = f.simple[code as keyof typeof f.simple];
      return plain ?? f.other;
    }
  }
}

/** The sentences of a plan's flags, each once. */
export function flagSentences(
  flags: readonly string[],
  words: Dictionary['plan'],
  name: (assetId: string) => string,
): string[] {
  return [...new Set(flags.map((flag) => flagSentence(flag, words, name)))];
}

/** The lines from the largest, cash last among equals. */
export const bySize = (lines: readonly BasketLine[]) =>
  [...lines].sort((a, b) => b.amountUsd - a.amountUsd || a.assetId.localeCompare(b.assetId));

/**
 * A plan in one sentence, from its lines: what goes where, largest first (three at most, then how many
 * more), and the largest holding's own reason. "$200 for 2 months, high risk, on Solana: $150 stays in
 * Cash (USDC) and $50 goes to syrupUSDC (Maple)." No rate: a plan carries none per line.
 */
export function planSummary(
  proposal: Pick<BasketProposal, 'sheet' | 'lines'>,
  t: Pick<Dictionary, 'plan' | 'goal'>,
  lang: Lang,
  chainName: string,
): string {
  const { sheet } = proposal;
  const name = (assetId: string) => displayName(assetId, t.plan);
  const lines = bySize(proposal.lines.filter((l) => l.amountUsd > 0));
  const parts = lines
    .slice(0, 3)
    .map((l) =>
      (isCashId(l.assetId) ? t.plan.summary.stays : t.plan.summary.goes)(
        dollars(l.amountUsd, lang),
        name(l.assetId),
      ),
    );
  if (lines.length > 3) parts.push(t.plan.summary.more(lines.length - 3));
  const why = lines.find((l) => !isCashId(l.assetId))?.reasons[0]?.text;
  const head = t.plan.summary.head(
    dollars(sheet.amountUsd, lang),
    t.goal.card.months(sheet.horizonMonths),
    t.plan.riskWord[sheet.risk].toLowerCase(),
    chainName,
  );
  const list = new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(parts);
  return [`${head} ${list}.`, why].filter(Boolean).join(' ');
}
