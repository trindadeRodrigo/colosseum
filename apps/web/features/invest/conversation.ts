import type { BasketSheet, BasketSheetDraft, ChainId } from '@colosseum/schemas';
import type { Lang } from '../../i18n';
import type { ApiFetch } from '../account/person';
import { exampleDraft } from '../goal/examples';
import { browserCountry, preRead, type Words } from '../goal/pre-read';
import { type ReadFailure, ReadGoalError, readGoal } from '../goal/read-goal';
import { checkSheet, fieldsOfDraft, parseNumber, type SheetFields } from '../goal/sheet';

// The conversation of the Invest screen, behind one small interface (gate INVEST-TWO-PANE): a person
// sends words or an answer, and gets back the sheet so far, what is still open, and what to say next.
// What reads the words is behind it. Today that is the reader on `staging` (POST /goals) with the
// words this app reads for itself (pre-read.ts); Rodrigo's guided intake (POST /v1/baskets/intake)
// drops in as another `Conversation`, and the screen does not change.
//
// Nothing here writes a sentence, and no model writes a figure: a reply names what to say by a key and
// the facts it is about, and the screen says it from the dictionary, with every number taken from the
// sheet (i18n `invest.say`).

/** The facts of a goal the conversation settles, in the order it asks for them. */
export const FACTS = ['goal', 'amount', 'income', 'horizon', 'risk'] as const;
export type Fact = (typeof FACTS)[number];

/** What is known so far: the sheet's fields, and the optional facts the person chose to leave out. */
export type Sheet = {
  fields: SheetFields;
  /** Asked and declined: "no set amount a month". Not asked again unless the person taps the fact. */
  skipped: Fact[];
};

/** What the person sends: their own words, or an answer to the fact that was asked. */
export type Send =
  /** `asked`: the question that is open on the screen, where it is one the person reopened. */
  | { kind: 'text'; text: string; asked?: Fact | null }
  | { kind: 'answer'; fact: Fact; value: string }
  /** A tap on a fact in the plan pane: the person wants to change it. */
  | { kind: 'reopen'; fact: Fact };

/** What to say back, as a key the screen has words for. Never a sentence, never a figure. */
export type Say =
  /** What was understood, said from the sheet. */
  | { key: 'understood' }
  /** The words said nothing this app could read into the sheet. */
  | { key: 'notUnderstood' }
  /**
   * Words that change nothing while a goal is held (a question, small talk, anything off the
   * subject): what is held is said back, with what can be done next. Never the whole goal asked again.
   */
  | { key: 'held' }
  /** The fact was set by the answer. */
  | { key: 'set'; fact: Fact }
  /** The reader could not be reached, or could not read the text. */
  | { key: 'failed'; why: ReadFailure }
  /** An answer that is not one the fact takes: "abc" for an amount, an amount under $10. */
  | { key: 'unfit'; fact: Fact }
  /**
   * The words name one stock or coin to buy, which a plan cannot be told yet. `pick` is a key of this
   * file's own list (`PICKS`): the name said back is ours, never the person's typed words.
   */
  | { key: 'cantPick'; pick: Pick }
  /** "More risk" at the highest risk, "less risk" at the lowest: nothing to change. */
  | { key: 'riskTop' }
  | { key: 'riskBottom' }
  /** Every fact is known: the plan is being built. */
  | { key: 'ready' };

export type Reply = {
  sheet: Sheet;
  /** The facts still to settle before a plan can be built, in asking order. */
  open: Fact[];
  say: Say[];
  /** The one question to ask next, with its quick replies. Null when nothing is open. */
  ask: Fact | null;
  /** The sheet as the API takes it, once it is whole and valid: what a plan is built from. */
  valid: BasketSheet | null;
};

export interface Conversation {
  /** A turn: what the person sent, against what was known. */
  turn(input: Send, known: Sheet | null): Promise<Reply>;
}

/**
 * "Yes", "ok", "go", "build", "sim": the person's go-ahead once every fact is known. Only these few
 * words, alone; anything longer is read as words about the goal.
 */
export function isGoAhead(text: string): boolean {
  return /^(y|yes|yep|yeah|ok|okay|k|go|go ahead|so|and|then|next|sure|do it|please|build|build it|build my plan|build the plan|s|sim|pode|pode sim|vai|bora|claro|isso|monta|montar|monte|e ai|e aí|então)[\s.!?…]*$/i.test(
    text.trim(),
  );
}

/**
 * Single names a person may ask for, which a plan cannot be told to hold yet: the engine picks the
 * assets (CLAUDE.md: the reader never picks one). Each with the words that name it and how it is
 * said back.
 */
export const PICKS = {
  nvidia: { name: 'Nvidia', kind: 'stock', said: /\b(nvidia|nvda|nvdax)\b/i },
  apple: { name: 'Apple', kind: 'stock', said: /\b(apple|aapl|aaplx)\b/i },
  tesla: { name: 'Tesla', kind: 'stock', said: /\b(tesla|tsla|tslax)\b/i },
  microsoft: { name: 'Microsoft', kind: 'stock', said: /\b(microsoft|msft)\b/i },
  amazon: { name: 'Amazon', kind: 'stock', said: /\b(amazon|amzn)\b/i },
  google: { name: 'Google', kind: 'stock', said: /\b(google|alphabet|googl)\b/i },
  meta: { name: 'Meta', kind: 'stock', said: /\b(meta|facebook)\b/i },
  bitcoin: { name: 'Bitcoin', kind: 'coin', said: /\b(bitcoin|btc)\b/i },
  ether: { name: 'Ethereum', kind: 'coin', said: /\b(ethereum|ether|eth)\b/i },
} as const;
export type Pick = keyof typeof PICKS;

/** The first single name the words ask for, if any. */
export function pickOf(text: string): Pick | null {
  return (Object.keys(PICKS) as Pick[]).find((pick) => PICKS[pick].said.test(text)) ?? null;
}

const RISKS = ['low', 'medium', 'high'] as const;
/** "More risk", "safer": a step from the risk that is held, not a risk of its own. */
function riskStep(text: string): 1 | -1 | null {
  const t = text.toLowerCase();
  if (
    /\b(more|higher|bigger|increase|raise|mais|maior|aumenta\w*)\b[^.?!]{0,20}\b(risk|risco)\b/.test(
      t,
    ) ||
    /\b(riskier|more aggressive|mais arriscad\w+|mais agressiv\w+)\b/.test(t)
  )
    return 1;
  if (
    /\b(less|lower|smaller|reduce|menos|menor|diminu\w*|reduz\w*)\b[^.?!]{0,20}\b(risk|risco)\b/.test(
      t,
    ) ||
    /\b(safer|more careful|mais segur\w+|mais conservador\w*)\b/.test(t)
  )
    return -1;
  return null;
}

/** The quick replies of each question, as values the sheet takes. The screen has the words. */
export const QUICK: Record<Fact, readonly string[]> = {
  goal: ['grow', 'income', 'protect'],
  amount: ['1000', '10000', '50000'],
  // an empty value is "no set amount": the monthly income is optional
  income: ['100', '300', '500', ''],
  horizon: ['12', '36', '60', '120'],
  risk: ['low', 'medium', 'high'],
};

/**
 * The country the sheet is sent with. The person is never asked (gate COUNTRY-REMOVED), and the API's
 * sheet still needs one (`BasketSheet.country`): the browser's own region where it names one this app
 * lists, else Brazil. It decides nothing the person sees here.
 */
export function silentCountry(languages: readonly string[]): string {
  return browserCountry(languages) ?? 'BR';
}

const EMPTY = (lang: Lang, country: string): SheetFields => ({
  goal: '',
  amount: '',
  income: '',
  horizon: '',
  risk: '',
  country,
  holdings: 'yes',
  glide: 'yes',
  language: lang,
});

/** The facts a plan cannot be built without that are not known yet, in asking order. */
export function openFacts(sheet: Sheet): Fact[] {
  const { fields, skipped } = sheet;
  return FACTS.filter((fact) => {
    if (fact === 'income')
      return fields.goal === 'income' && fields.income.trim() === '' && !skipped.includes('income');
    return fields[fact].trim() === '';
  });
}

/** What the words say, as fields: only what was found. */
function fieldsOfWords(words: Words): Partial<SheetFields> {
  return {
    ...(words.goal ? { goal: words.goal } : {}),
    ...(words.amountUsd != null ? { amount: String(words.amountUsd) } : {}),
    ...(words.horizonMonths != null ? { horizon: String(words.horizonMonths) } : {}),
    ...(words.risk ? { risk: words.risk } : {}),
    ...(words.incomeTargetUsdMonthly != null
      ? { income: String(words.incomeTargetUsdMonthly) }
      : {}),
  };
}

/** An answer as the field takes it, or null when it is not one the fact takes. */
export function fitAnswer(fact: Fact, value: string, lang: Lang): string | null {
  const text = value.trim();
  if (fact === 'goal') return ['grow', 'income', 'protect'].includes(text) ? text : null;
  if (fact === 'risk') return ['low', 'medium', 'high'].includes(text) ? text : null;
  if (fact === 'horizon') {
    const months = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    return months >= 1 && months <= 480 ? String(months) : null;
  }
  const n = parseNumber(text, lang);
  if (n === null || Number.isNaN(n)) return null;
  if (fact === 'amount') return n >= 10 && n <= 1_000_000 ? String(n) : null;
  return n > 0 ? String(n) : null;
}

/** A typed answer to the question that is open, read from the words or, failing that, as a bare figure. */
function typedAnswer(fact: Fact, text: string, lang: Lang): string | null {
  const words = fieldsOfWords(preRead(text));
  const said = words[fact];
  if (said !== undefined) return fitAnswer(fact, said, lang);
  // "5" to "for how long?" is five years; "40000" to "how much?" is dollars
  const bare = text.trim();
  if (fact === 'horizon') {
    const years = parseNumber(bare, lang);
    return years !== null && Number.isInteger(years)
      ? fitAnswer(fact, String(years * 12), lang)
      : null;
  }
  if (fact === 'amount' || fact === 'income') return fitAnswer(fact, bare, lang);
  return null;
}

/** The sheet as the API takes it, once every fact is known and it is valid for the chain; else null. */
export function validOf(sheet: Sheet, chain: ChainId | null): BasketSheet | null {
  if (openFacts(sheet).length > 0) return null;
  const check = checkSheet(sheet.fields, chain);
  return Object.keys(check.errors).length === 0 ? check.sheet : null;
}

function reply(sheet: Sheet, say: Say[], chain: ChainId | null, reopened?: Fact): Reply {
  const open = openFacts(sheet);
  const valid = validOf(sheet, chain);
  return {
    sheet,
    open,
    say: valid && !reopened ? [...say, { key: 'ready' }] : say,
    ask: reopened ?? open[0] ?? null,
    valid: reopened ? null : valid,
  };
}

/**
 * Today's reader behind the interface: POST /goals for a first sentence, the words this app reads for
 * itself over it, and the answers to its questions taken as they are. What the reader answers with a
 * default of its own (a goal or a risk nobody said) is left open and asked, never assumed.
 */
export function readerConversation(
  apiFetch: ApiFetch,
  o: {
    lang: Lang;
    /** The chain a plan would be built on: the person's, or the one a visitor is looking at. */
    chain: ChainId | null;
    /** The page's own example sentences, whose facts are known without a reader. */
    examples: readonly string[];
    country: string;
  },
): Conversation {
  const { lang, chain, examples, country } = o;

  async function first(text: string): Promise<Reply> {
    const known = exampleDraft(text, examples, lang);
    let draft: BasketSheetDraft;
    let guessed: ReadonlySet<string> = new Set();
    if (known) draft = known;
    else {
      try {
        const reading = await readGoal(apiFetch, text, lang);
        draft = reading.draft;
        guessed = reading.guessed;
      } catch (e) {
        const why = e instanceof ReadGoalError ? e.kind : 'unreachable';
        return reply(
          { fields: EMPTY(lang, country), skipped: [] },
          [{ key: 'failed', why }],
          chain,
        );
      }
    }
    const read = fieldsOfDraft({ ...draft, country }, lang);
    const words = fieldsOfWords(preRead(text));
    const fields: SheetFields = {
      ...EMPTY(lang, country),
      // what the reader read, less what it only assumed
      goal: guessed.has('goal') ? '' : read.goal,
      amount: read.amount,
      income: read.income,
      horizon: guessed.has('horizonMonths') ? '' : read.horizon,
      risk: guessed.has('risk') ? '' : read.risk,
      // and what the words themselves say, over both
      ...words,
    };
    // a monthly figure is an income's
    if (fields.goal !== 'income') fields.income = '';
    const sheet = { fields, skipped: [] };
    const found = FACTS.some((fact) => fields[fact] !== '');
    const pick = pickOf(text);
    return reply(
      sheet,
      [
        { key: found ? 'understood' : 'notUnderstood' },
        ...(pick ? [{ key: 'cantPick' as const, pick }] : []),
      ],
      chain,
    );
  }

  return {
    async turn(input, known) {
      if (input.kind === 'reopen') {
        const sheet = known ?? { fields: EMPTY(lang, country), skipped: [] };
        return reply(
          { ...sheet, skipped: sheet.skipped.filter((f) => f !== input.fact) },
          [],
          chain,
          input.fact,
        );
      }
      if (input.kind === 'answer') {
        const sheet = known ?? { fields: EMPTY(lang, country), skipped: [] };
        // the monthly income may be left out
        if (input.fact === 'income' && input.value.trim() === '')
          return reply(
            {
              fields: { ...sheet.fields, income: '' },
              skipped: [...new Set([...sheet.skipped, 'income' as const])],
            },
            [{ key: 'set', fact: 'income' }],
            chain,
          );
        const fit = fitAnswer(input.fact, input.value, lang);
        if (fit === null)
          return reply(sheet, [{ key: 'unfit', fact: input.fact }], chain, input.fact);
        const fields = { ...sheet.fields, [input.fact]: fit };
        if (fields.goal !== 'income') fields.income = '';
        return reply({ ...sheet, fields }, [{ key: 'set', fact: input.fact }], chain);
      }
      const text = input.text.trim();
      if (!known || FACTS.every((fact) => known.fields[fact] === '')) return first(text);
      // Words after the first: an answer to the open question, or facts said in passing ("make it
      // five years, low risk"). Words that say none are not sent to the reader again: it would start
      // the goal over.
      // The question the words answer: the one the person reopened, else the first still open.
      const reopened = input.asked ?? undefined;
      const open = reopened ?? openFacts(known)[0];
      const words = fieldsOfWords(preRead(text));
      const answered = open ? typedAnswer(open, text, lang) : null;
      // What the words ask for that the sheet cannot take is said, never passed over in silence: a
      // single stock to buy, or more risk than the highest.
      const pick = pickOf(text);
      const aside: Say[] = pick ? [{ key: 'cantPick', pick }] : [];
      const step = words.risk === undefined && open !== 'risk' ? riskStep(text) : null;
      const at = RISKS.indexOf(known.fields.risk as (typeof RISKS)[number]);
      const stepped = step !== null && at >= 0 ? RISKS[at + step] : undefined;
      if (step !== null && at >= 0 && stepped === undefined)
        aside.push({ key: step === 1 ? 'riskTop' : 'riskBottom' });
      const said: Partial<SheetFields> = {
        ...words,
        ...(stepped ? { risk: stepped } : {}),
        ...(open && answered !== null ? { [open]: answered } : {}),
      };
      if (Object.keys(said).length === 0)
        return reply(
          known,
          // with something specific to say, the general "I need an amount" is not said as well
          [...aside, open && aside.length === 0 ? { key: 'unfit', fact: open } : { key: 'held' }],
          chain,
          // a reopened fact stays the question until it is answered
          reopened,
        );
      const fields = { ...known.fields, ...said };
      if (fields.goal !== 'income') fields.income = '';
      // words that say only what is already held change nothing
      const same = FACTS.every((fact) => fields[fact] === known.fields[fact]);
      if (same && !reopened) return reply(known, [...aside, { key: 'held' }], chain);
      return reply({ ...known, fields }, [{ key: 'understood' }, ...aside], chain);
    },
  };
}
