import type { BasketLine, BasketProposal } from '@colosseum/schemas';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { dollars } from '../goal/sheet';
import { CASH, SYMBOLS, tail, tokenName } from './amounts';

// The plan in plain words (Thom, Oct 6: the plan screen read as a list of engine codes). Nothing here
// shows an engine code: an asset by its name, a kind of asset by a word, a flag by a sentence, and a
// code this file does not know by one plain line that says there is a note. The sentences are
// the dictionary's, in the language of the view.

/** Who issues a dollar-yield token, where saying so tells the person what it is. */
const ISSUERS: Record<string, string> = {
  syrupusdc: 'Maple',
  jlusdc: 'Jupiter Lend',
  usdy: 'Ondo',
  sgov: 'iShares',
};

/** A test network's name for a token this app knows: "tSPYx", "tsyrupUSDC". Never "tUSDG": that is its name. */
const TEST_NAME = new RegExp(
  `\\bt(${Object.keys(SYMBOLS)
    .filter((symbol) => symbol !== 'usdg')
    .join('|')})\\b`,
  'gi',
);

/** The asset is the chain's dollar, held as cash. */
export const isCashId = (assetId: string) => CASH.has(tail(assetId));

/**
 * An asset as a person reads it, the one name every screen uses for it: "syrupUSDC (Maple)", "Cash
 * (USDC)", "NVDAx". The token's own name is `tokenName` (amounts.ts): a test network's token goes by
 * the token it stands in for, and the card says it is a test network.
 */
export function displayName(assetId: string, words: Pick<Dictionary['plan'], 'cash'>): string {
  const symbol = tokenName(assetId);
  if (isCashId(assetId)) return words.cash(symbol);
  const issuer = ISSUERS[symbol.toLowerCase()];
  return issuer ? `${symbol} (${issuer})` : symbol;
}

/**
 * A sentence of the engine with its tokens named as the screens name them: the engine writes a test
 * network's token as the deploy record does ("tsyrupUSDC"), and the page says "syrupUSDC" (the flow
 * audit, finding 13). Only a name written that way is changed, never a word of the sentence.
 */
export const plainNames = (text: string): string =>
  text.replace(TEST_NAME, (whole, symbol: string) => SYMBOLS[symbol.toLowerCase()] ?? whole);

/** A kind of asset (a class key of the roll-up) as a word; an unknown one is "other". */
export function kindLabel(key: string, words: Dictionary['plan']['kinds']): string {
  const k = key.replace(/-/g, '_') as keyof typeof words;
  return k in words && k !== 'other' ? (words[k] as string) : words.other;
}

/**
 * A flag of the engine or the roll-up as one sentence. Never the code: a code this file has no
 * sentence for is said by one plain line, so a note the engine wrote is never dropped in silence.
 */
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
 * The rules that say what stopped a holding where it is, most telling first: the person's credit
 * limit, the cap on one token or one issuer, what selling would cost. One of these on a line is why it
 * holds what it holds; the sleeve's starting share ("starting share of dollar yield is 100%") is not,
 * once a cap has cut it.
 */
const BINDING = [
  'CREDIT_BUDGET',
  'CREDIT_BUDGET_UNSAID',
  'ASSET_CAP',
  'ISSUER_CAP_PLAN',
  'ISSUER_CAP',
  'SINGLE_STOCK_CAP',
  'EXIT_CEILING',
  'TIER_CEILING',
];
/** On cash: why money that was meant for something else stayed. */
const BINDING_CASH = [
  'UNPLACED',
  'NO_DOLLAR_YIELD',
  'YIELD_TOO_SMALL',
  'SET_ASIDE_CASH',
  'COVERAGE_CASH',
  'CASH_MAY_NEED',
];
/** Where a line starts from, not what decided it: said only when nothing else is. */
const STARTING = new Set(['SLEEVE', 'SLEEVE_DEFAULT', 'SLEEVE_FILLED', 'CASH_NEAR_DATE', 'GLIDE']);

/**
 * The reason that decided a line: the cap or limit that binds it, in the engine's own sentence. With
 * none of those, its first reason that is not only where it started; with none of those either, its
 * first. Undefined for a line the engine gave no reason.
 */
export function bindingReason(line: BasketLine) {
  const order = isCashId(line.assetId) ? [...BINDING_CASH, ...BINDING] : BINDING;
  for (const rule of order) {
    const found = line.reasons.find((r) => r.rule === rule || r.rule.startsWith(`${rule}_`));
    if (found) return found;
  }
  const overflow = line.reasons.find((r) => r.rule.startsWith('OVERFLOW_'));
  return overflow ?? line.reasons.find((r) => !STARTING.has(r.rule)) ?? line.reasons[0];
}

/** A line's reasons with the one that decided it first, each once. */
export const reasonsOf = (line: BasketLine): string[] => {
  const first = bindingReason(line);
  return [
    ...new Set(
      [...(first ? [first.text] : []), ...line.reasons.map((r) => r.text)].map(plainNames),
    ),
  ];
};

/**
 * A plan in one sentence, from its lines: what goes where, largest first (three at most, then how many
 * more), then why the largest holding holds what it does and why cash holds the rest, each the reason
 * that decided it (`bindingReason`), never the share a part only started from. "$80,000 for 12 months,
 * low risk, on Solana: $60,000 stays in Cash (USDC) and $20,000 goes to syrupUSDC (Maple). No more than
 * 25% of the plan in tokens that lend to borrowers… $60,000 stays in cash: no token you can hold has
 * room for it at this size." No rate: a plan carries none per line.
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
  const holding = lines.find((l) => !isCashId(l.assetId));
  const cash = lines.find((l) => isCashId(l.assetId));
  // Cash explains itself only by what kept money there, not by where it started.
  const cashWhy = cash?.reasons.find((r) => BINDING_CASH.includes(r.rule))?.text;
  const head = t.plan.summary.head(
    dollars(sheet.amountUsd, lang),
    t.goal.card.months(sheet.horizonMonths),
    t.plan.riskWord[sheet.risk].toLowerCase(),
    chainName,
  );
  const list = new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(parts);
  const whys = [holding ? bindingReason(holding)?.text : undefined, cashWhy];
  return [`${head} ${list}.`, ...new Set(whys.map((why) => why && plainNames(why)))]
    .filter(Boolean)
    .join(' ');
}

/**
 * The goal in one line, as the page's heading says it. An income goal with an amount a month says it
 * ("Earn $300 a month from $80,000 for 12 months."), so what the plan pays of it makes sense below.
 */
export function goalLine(
  sheet: Pick<
    BasketProposal['sheet'],
    'goal' | 'amountUsd' | 'horizonMonths' | 'incomeTargetUsdMonthly'
  >,
  t: Pick<Dictionary, 'goal'>,
  amount: string,
  income: (usd: number) => string,
): string {
  const months = t.goal.card.months(sheet.horizonMonths);
  return sheet.goal === 'income' && sheet.incomeTargetUsdMonthly !== undefined
    ? t.goal.card.sentenceIncome(income(sheet.incomeTargetUsdMonthly), amount, months)
    : t.goal.card.sentence[sheet.goal](amount, months);
}

/**
 * What the engine left out of a plan, each in its own sentence ("jlUSDC is left out: there is no
 * yield reading for it…"), each once. The sentences are the engine's, in the plan's language.
 */
export const leftOut = (proposal: Pick<BasketProposal, 'removed'>): string[] => [
  ...new Set(proposal.removed.flatMap((r) => r.reasons.map((reason) => plainNames(reason.text)))),
];
