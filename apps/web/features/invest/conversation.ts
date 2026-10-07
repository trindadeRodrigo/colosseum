import type { BasketSheet, BasketSheetDraft, ChainId } from '@colosseum/schemas';
import type { Lang } from '../../i18n';
import type { ApiFetch } from '../account/person';
import { exampleDraft } from '../goal/examples';
import { preRead, type Words } from '../goal/pre-read';
import { type ReadFailure, ReadGoalError, readGoal } from '../goal/read-goal';
import { checkSheet, fieldsOfDraft, parseNumber, type SheetFields } from '../goal/sheet';
import type { HeldMix, HeldTheme, IntakeAnswers } from './intake';

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
export const isFact = (v: unknown): v is Fact => FACTS.includes(v as Fact);

/** What is known so far: the sheet's fields, and the optional facts the person chose to leave out. */
export type Sheet = {
  fields: SheetFields;
  /** Asked and declined: "no set amount a month". Not asked again unless the person taps the fact. */
  skipped: Fact[];
  /** The person's own messages so far, in order: what a reader is sent again on a later turn. */
  words?: string[];
  /** What the guided intake holds for this conversation (intake-conversation.ts). */
  intake?: IntakeState;
  /** It was said that the intake did not answer and the rules read instead: not said twice. */
  simple?: boolean;
};

/**
 * The guided intake's side of a conversation: the answers given by a tap, and what our server last
 * said of the whole. The server's sheet and its question are never read back from the tab's storage:
 * they are asked for again.
 */
export type IntakeState = {
  answers: IntakeAnswers;
  /** The answers as they stood when each later message was sent, one for each. */
  answersThen: IntakeAnswers[];
  /** The sheet the person confirms, as the server sent it; null while anything is open. */
  sheet: BasketSheet | null;
  /** The question that is open, with its replies; null when none is. */
  question: Question | null;
  /** What the person said to hold, and the themes the plan holds, from the server's reading. */
  mix: HeldMix | null;
  themes: HeldTheme[];
  /** The goal has no date (gate GLIDE-OPT-IN): the time frame shows "No date set". */
  horizonOpen: boolean;
  /** What the person answered to hold by a press: a mix of stocks and cash, or none. */
  held?: HeldMix | null;
  /** The read-back our server last gave, to say only what is new of the next one. */
  readBack?: string[];
};

/** A quick reply: what it sends, and what it is said by. The screen has the words. */
export type QuickReply = {
  /** What a press posts as the person's turn. */
  posts: Send;
  label:
    | { kind: 'fact'; fact: Fact; value: string }
    | { kind: 'word'; word: 'yes' | 'no' | 'noDate' | 'none' | 'all' | 'half' }
    /** A share of the money, in basis points. */
    | { kind: 'share'; bps: number }
    /** A choice our server offers, in its own words. */
    | { kind: 'option'; text: string };
};

/** A question our server asks, in its own words from its fixed templates. */
export type Question = { text: string; replies: QuickReply[] };

/** What the person sends: their own words, or an answer to the fact that was asked. */
export type Send =
  /** `asked`: the question that is open on the screen, where it is one the person reopened. */
  | { kind: 'text'; text: string; asked?: Fact | null }
  | { kind: 'answer'; fact: Fact; value: string }
  /** A tap on a fact in the plan pane: the person wants to change it. */
  | { kind: 'reopen'; fact: Fact }
  /** Nothing new: what is held is read again, after the page was left and came back. */
  | { kind: 'replay' }
  /**
   * An answer to "how do you want the money held": this share in stocks and crypto and the rest in
   * cash, or null for none of it.
   */
  | { kind: 'hold'; shareBps: number | null };

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
  /**
   * Sentences our server wrote from its own templates over the validated sheet: what it understood,
   * said back. Shown as given. Never kept in the tab's storage, and never a model's words.
   */
  | { key: 'said'; lines: string[] }
  /** The conversation has as many messages as a reader takes: a fact is changed by a tap. */
  | { key: 'full' }
  /** The guided intake did not answer: this turn was read by the rules instead. Said once. */
  | { key: 'simple' }
  /** The words were not an answer our server could take to the question that is open. */
  | { key: 'notAnswer' }
  /** Every fact is known: the plan is being built. */
  | { key: 'ready' };

export type Reply = {
  sheet: Sheet;
  /** The facts still to settle before a plan can be built, in asking order. */
  open: Fact[];
  say: Say[];
  /** The one question to ask next, with its quick replies. Null when nothing is open. */
  ask: Fact | null;
  /** The question in our server's words, where it wrote one; else the screen's own for `ask`. */
  question?: Question | null;
  /** Who read this turn, for the people building this: shown in development only. */
  reader?: { by: 'model' | 'server rules' | 'app rules'; why: string | null };
  /** The sheet as the API takes it, once it is whole and valid: what a plan is built from. */
  valid: BasketSheet | null;
};

export interface Conversation {
  /** A turn: what the person sent, against what was known. */
  turn(input: Send, known: Sheet | null): Promise<Reply>;
}

/**
 * "Yes", "ok", "go", "build", "sim": the person's go-ahead once every fact is known. Only these few
 * words and their Portuguese forms, alone. A filler ("so", "and", "then", "please") is not one, and
 * anything longer is read as words about the goal.
 */
export function isGoAhead(text: string): boolean {
  return /^(y|yes|yep|yeah|ok|okay|go|go ahead|do it|build|build it|build my plan|build the plan|s|sim|pode|pode sim|vai|bora|monta|montar|monte|pode montar)[\s.!?…]*$/i.test(
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
  // "meta" alone is Portuguese for a goal ("minha meta é…"): it names the company only in English
  meta: { name: 'Meta', kind: 'stock', said: /\b(meta platforms|facebook)\b/i, en: /\bmeta\b/i },
  bitcoin: { name: 'Bitcoin', kind: 'coin', said: /\b(bitcoin|btc)\b/i },
  ether: { name: 'Ethereum', kind: 'coin', said: /\b(ethereum|ether|eth)\b/i },
} as const;
export type Pick = keyof typeof PICKS;

/** The first single name the words ask for, if any. */
export function pickOf(text: string, lang: Lang): Pick | null {
  return (
    (Object.keys(PICKS) as Pick[]).find((pick) => {
      const p: { said: RegExp; en?: RegExp } = PICKS[pick];
      return p.said.test(text) || (lang === 'en' && p.en?.test(text) === true);
    }) ?? null
  );
}

/**
 * The words without what they refuse: "I don't want more risk", "not $5,000, make it $8,000", "não
 * quero dez anos". A clause with a negation in it states nothing to take, so it is left out before
 * the words are read; what is left is read as usual. A clause ends at a full stop, a semicolon, a
 * comma followed by a space, or "but"/"mas".
 */
export function affirmed(text: string, lang: Lang): string {
  // "no" is English only: in Portuguese it is "in the" ("no longo prazo")
  const negation = new RegExp(
    `(^|[^\\p{L}])(${lang === 'en' ? 'no|' : ''}not|don'?t|do not|doesn'?t|won'?t|never|without|neither|nor|n[ãa]o|sem|nunca|nem|jamais)([^\\p{L}]|$)|n['’]t\\b`,
    'iu',
  );
  // a mark inside a figure ("$40.5", "R$ 40.000", "$5,000") ends nothing
  const clauses = text.split(/[.;!?]+(?:\s+|$)|\n+|,\s+|\s+(?:but|mas|porém)\s+/i);
  const kept = clauses.filter((clause) => !negation.test(clause));
  // words that refuse nothing are read exactly as typed
  return kept.length === clauses.length ? text : kept.join('. ');
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

/**
 * "Start over", "clear it out", "reset", "recomeçar": the person wants an empty conversation. Only
 * these few words, alone or after one word of address ("bro clear it out").
 */
export function isStartOver(text: string): boolean {
  return /^(?:[\p{L}]+[\s,]+)?(clear|clear it|clear it out|clear everything|clear all|start over|start again|reset|restart|new goal|recomeçar|recomecar|limpar|limpar tudo|começar de novo|comecar de novo|apagar tudo|zerar)[\s.!?…]*$/iu.test(
    text.trim(),
  );
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

// No country: no plan is shaped by one, and none is asked or sent (gate COUNTRY-REMOVED).
export const EMPTY = (lang: Lang): SheetFields => ({
  goal: '',
  amount: '',
  income: '',
  horizon: '',
  risk: '',
  country: '',
  holdings: 'yes',
  // off unless the person asks for it (gate GLIDE-OPT-IN): the words here cannot say they did
  glide: 'no',
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
export function typedAnswer(fact: Fact, text: string, lang: Lang): string | null {
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
  // Read by the guided intake: the sheet is our server's, sent back as it came, on the person's chain.
  if (sheet.intake)
    return sheet.intake.sheet && chain && sheet.intake.sheet.chains[0] === chain
      ? sheet.intake.sheet
      : null;
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
    reader: { by: 'app rules', why: null },
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
  },
): Conversation {
  const { lang, chain, examples } = o;

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
        return reply({ fields: EMPTY(lang), skipped: [] }, [{ key: 'failed', why }], chain);
      }
    }
    const read = fieldsOfDraft({ ...draft, country: null }, lang);
    const words = fieldsOfWords(preRead(affirmed(text, lang)));
    // what the words name only to refuse ("not high risk") is not taken from the reader either
    const refused = new Set(
      Object.keys(fieldsOfWords(preRead(text))).filter((fact) => !(fact in words)),
    );
    const fields: SheetFields = {
      ...EMPTY(lang),
      // what the reader read, less what it only assumed
      goal: guessed.has('goal') ? '' : read.goal,
      amount: read.amount,
      income: read.income,
      horizon: guessed.has('horizonMonths') ? '' : read.horizon,
      risk: guessed.has('risk') ? '' : read.risk,
      // and what the words themselves say, over both
      ...words,
    };
    for (const fact of refused) if (isFact(fact)) fields[fact] = '';
    // A monthly figure is an income's. With no goal said yet it is kept: it is asked what the money
    // is for, and the figure stands if the answer is income.
    if (fields.goal !== '' && fields.goal !== 'income') fields.income = '';
    const sheet = { fields, skipped: [] };
    const found = FACTS.some((fact) => fields[fact] !== '');
    const pick = pickOf(text, lang);
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
      if (input.kind === 'replay')
        return reply(known ?? { fields: EMPTY(lang), skipped: [] }, [], chain);
      // an answer only the guided intake asks for: nothing here takes it
      if (input.kind === 'hold')
        return reply(known ?? { fields: EMPTY(lang), skipped: [] }, [{ key: 'held' }], chain);
      if (input.kind === 'reopen') {
        const sheet = known ?? { fields: EMPTY(lang), skipped: [] };
        return reply(
          { ...sheet, skipped: sheet.skipped.filter((f) => f !== input.fact) },
          [],
          chain,
          input.fact,
        );
      }
      if (input.kind === 'answer') {
        const sheet = known ?? { fields: EMPTY(lang), skipped: [] };
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
        if (fields.goal !== '' && fields.goal !== 'income') fields.income = '';
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
      // what the words refuse is not read as what they ask for
      const meant = affirmed(text, lang);
      const words = fieldsOfWords(preRead(meant));
      const answered = open && meant.trim() !== '' ? typedAnswer(open, meant, lang) : null;
      // What the words ask for that the sheet cannot take is said, never passed over in silence: a
      // single stock to buy, or more risk than the highest.
      const pick = pickOf(text, lang);
      const aside: Say[] = pick ? [{ key: 'cantPick', pick }] : [];
      const step = words.risk === undefined && open !== 'risk' ? riskStep(meant) : null;
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
      if (fields.goal !== '' && fields.goal !== 'income') fields.income = '';
      // words that say only what is already held change nothing
      const same = FACTS.every((fact) => fields[fact] === known.fields[fact]);
      if (same && !reopened) return reply(known, [...aside, { key: 'held' }], chain);
      return reply({ ...known, fields }, [{ key: 'understood' }, ...aside], chain);
    },
  };
}
