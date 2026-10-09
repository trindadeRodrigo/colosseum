import { amountInText, mentionsIn } from '@colosseum/engine/personal';
import type { VaultAgentRequest } from '@colosseum/schemas';

// The amount a new goal starts with, as the person wrote it in their own messages (gate DEPOSIT-DERIVE,
// Rodrigo, Oct 9). It fills the deposit step's amount, which the person can change and confirms on the
// review before anything is stored, so it is a starting value, never a figure the plan is bound to.
// The model has no part in it. Like the reader of the goal and risk (stated-purpose.ts), it errs
// towards reading nothing: an empty field is typed in a moment, a wrong sum in it is a wrong deposit
// to notice.
//
// A sum is read only where it is plainly the money put in: written in dollars by the engine's reader
// (`amountInText`: "$2,000", "2k", a bare "2000" where no other currency is written; never a rate a
// month, an age, a year or a duration), and either leading its clause ("2k, 70% in…") or straight
// after a word that puts money in ("invest", "put", "start with", "grow", "make it", "investir",
// "aplicar"…), with at most a few small words between ("invest in 2k", "put about $500"). A sum after
// any other word is not read: a target ("reach $100,000", "grow it to $50k", "retire with $1M"), a
// price ("Tesla at $250"), a loss ("I lost $2,000"), an income ("an income of $500"). Nor is a sum
// followed by a rate other than a month ("$300 every year", "$200 weekly").
//
// From the newest of the person's messages to the oldest, the first that writes such a sum settles
// it: one sum there is the amount, two different sums there are none (it is not guessed which). A
// message with none ("in five years", "$100 a month") leaves the one before standing.

/** The words that put money in, as the last word before the sum (or the last two, "make it"). */
const PUTS_IN = new Set([
  'invest',
  'investing',
  'put',
  'putting',
  'deposit',
  'depositing',
  'start',
  'starting',
  'begin',
  'beginning',
  'grow',
  'protect',
  'split',
  'allocate',
  'place',
  'have',
  'got',
  'investir',
  'invisto',
  'investindo',
  'aplicar',
  'aplico',
  'colocar',
  'coloco',
  'depositar',
  'deposito',
  'tenho',
  'começar',
  'começo',
  'crescer',
  'proteger',
]);
/** Small words that may stand between that word and the sum: "invest in 2k", "put about $500". */
const BETWEEN = new Set([
  'in',
  'into',
  'with',
  'about',
  'around',
  'roughly',
  'some',
  'my',
  'the',
  'a',
  'an',
  'all',
  'just',
  'only',
  'em',
  'com',
  'cerca',
  'de',
  'uns',
  'umas',
  'o',
  'os',
  'meus',
  'mais',
  'ou',
  'menos',
  // "$2,000 or maybe $3,000": the second is put in as much as the first, so the two are none
  'or',
  'maybe',
  'perhaps',
  'talvez',
]);
/** A rate other than a month, right after the sum. A month's is the engine's `perMonth`. */
const OTHER_RATE =
  /^\s*(?:(?:a|an|per|every|each|por|cada|ao|a\s+cada)\s+)?(?:years?|yrs?|weeks?|days?|quarters?|anos?|semanas?|dias?|trimestres?)(?![\p{L}])|^\s*(?:weekly|yearly|annually|daily|quarterly|anual(?:mente)?|semanal(?:mente)?|di[aá]rio|diariamente)(?![\p{L}])/iu;

/** Whether the sum written from `at` to `end` is the money put in, by the words around it. */
function putIn(text: string, at: number, end: number): boolean {
  if (OTHER_RATE.test(text.slice(end, end + 30))) return false;
  const clause =
    text
      .slice(0, at)
      .split(/[.!?;:\n]/u)
      .at(-1) ?? '';
  const words = (clause.toLowerCase().match(/[\p{L}'’]+/gu) ?? []).filter(Boolean);
  // A clause that opens with the sum ("2k, 70% in…", "$2,000 into…") puts it in.
  if (words.length === 0) return clause.trim() === '' || /^[\s,(]*$/.test(clause);
  let i = words.length - 1;
  for (let n = 0; n < 3 && i >= 0 && BETWEEN.has(words[i] as string); n += 1) i -= 1;
  // Only small words before it ("about $500 into…", "or maybe $3,000"): it leads its clause.
  if (i < 0) return true;
  const last = words[i] as string;
  return PUTS_IN.has(last) || (last === 'it' && words[i - 1] === 'make');
}

export function statedAmountUsd(messages: VaultAgentRequest['messages']): number | null {
  for (const message of [...messages].reverse()) {
    if (message.who !== 'person') continue;
    const sums = new Set(
      mentionsIn(message.text)
        .filter(
          (m) =>
            m.kind === 'amount' &&
            !m.perMonth &&
            m.value > 0 &&
            amountInText(message.text, m.value) === 'dollars' &&
            putIn(message.text, m.at, m.end),
        )
        .map((m) => m.value),
    );
    if (sums.size === 0) continue;
    return sums.size === 1 ? ([...sums][0] ?? null) : null;
  }
  return null;
}
