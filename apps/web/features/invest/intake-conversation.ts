import type { BasketSheet, ChainId } from '@colosseum/schemas';
import type { Lang } from '../../i18n';
import type { ApiFetch } from '../account/person';
import { fieldsOfDraft, type SheetFields } from '../goal/sheet';
import {
  type Conversation,
  EMPTY,
  FACTS,
  type Fact,
  fitAnswer,
  type IntakeState,
  QUICK,
  type Question,
  type QuickReply,
  type Reply,
  type Say,
  type Send,
  type Sheet,
  typedAnswer,
} from './conversation';
import {
  type IntakeAnswers,
  type IntakeQuestion,
  type IntakeReading,
  MAX_FOLLOW_UPS,
  type QuestionField,
  readIntake,
} from './intake';

// The guided intake behind the Invest screen's `Conversation` (gate GUIDED-INTAKE): our server reads
// the whole conversation each turn (POST /v1/baskets/intake), asks what is open one question at a
// time, and says back what it understood once nothing is. Every turn sends the first message, the
// later ones in the person's own words, and the answers given by a tap.
//
// Nothing here writes a sentence or a figure. A question and the read-back are our server's, from its
// fixed templates over the validated sheet, and are shown as given. The facts on the pane are the
// server's draft. The sheet a plan is built from is the server's, sent back as it came.
//
// The route needs a sign-in and a model may not be there: where it is not (404, 401, 403), the turn
// is the fallback's, which reads by rules and asks its own questions.

const FIELD_OF: Record<Fact, QuestionField> = {
  goal: 'goal',
  amount: 'amountUsd',
  income: 'incomeTargetUsdMonthly',
  horizon: 'horizonMonths',
  risk: 'risk',
};
const FACT_OF = Object.fromEntries(
  (Object.keys(FIELD_OF) as Fact[]).map((fact) => [FIELD_OF[fact], fact]),
) as Partial<Record<QuestionField, Fact>>;

/** The quick reply that says the goal has no date. */
export const NO_DATE = 'open';

const NEW: IntakeState = {
  answers: {},
  answersThen: [],
  sheet: null,
  question: null,
  mix: null,
  themes: [],
  horizonOpen: false,
};

/** The fields a conversation the rules reader held brings along, as answers by field. */
function answersOf(fields: SheetFields): IntakeAnswers {
  const number = (v: string) => (v === '' ? undefined : Number(v));
  return {
    ...(fields.goal ? { goal: fields.goal } : {}),
    ...(number(fields.amount) ? { amountUsd: number(fields.amount) } : {}),
    ...(number(fields.income) ? { incomeTargetUsdMonthly: number(fields.income) } : {}),
    ...(number(fields.horizon) ? { horizonMonths: number(fields.horizon) } : {}),
    ...(fields.risk ? { risk: fields.risk } : {}),
  };
}

/** An answer to a fact, as the route takes it: the answers with it set. */
function withAnswer(answers: IntakeAnswers, fact: Fact, value: string): IntakeAnswers {
  const next = { ...answers };
  if (fact === 'goal') next.goal = value as BasketSheet['goal'];
  else if (fact === 'risk') next.risk = value as BasketSheet['risk'];
  else if (fact === 'amount') next.amountUsd = Number(value);
  else if (fact === 'income') next.incomeTargetUsdMonthly = Number(value);
  else {
    next.horizonMonths = Number(value);
    delete next.horizonOpen;
  }
  return next;
}

/** A question of our server as the screen asks it: its words, and the replies one press gives. */
function questionOf(q: IntakeQuestion, lang: Lang): Question {
  const fact = FACT_OF[q.field];
  const answer = (value: string): QuickReply => ({
    posts: { kind: 'answer', fact: fact as Fact, value },
    label: { kind: 'fact', fact: fact as Fact, value },
  });
  const say = (word: 'yes' | 'no'): QuickReply => ({
    // said in the person's words, so our server reads it as the answer to the one open question
    posts: { kind: 'text', text: lang === 'pt' ? (word === 'yes' ? 'sim' : 'não') : word },
    label: { kind: 'word', word },
  });
  let replies: QuickReply[] = [];
  if (fact === 'goal' || fact === 'risk') {
    // the choices our server names, where it names them; each is a value the sheet takes
    const choices = (q.options ?? QUICK[fact]).filter((o) => fitAnswer(fact, o, lang) !== null);
    replies = (choices.length > 0 ? choices : QUICK[fact]).map(answer);
  } else if (fact === 'amount') replies = QUICK.amount.map(answer);
  else if (fact === 'income') replies = QUICK.income.filter((v) => v !== '').map(answer);
  else if (fact === 'horizon')
    replies = [
      ...QUICK.horizon.map(answer),
      {
        posts: { kind: 'answer', fact: 'horizon', value: NO_DATE },
        label: { kind: 'word', word: 'noDate' },
      },
    ];
  else if (q.options && q.options.length > 0)
    replies = q.options.map((text) => ({
      posts: { kind: 'text', text },
      label: { kind: 'option', text },
    }));
  else if (q.field === 'limits' || q.template === 'startFrom') replies = [say('yes'), say('no')];
  // What our server read and asks to be sure of is the first reply: one press confirms it.
  const read = fact && q.read !== undefined ? fitAnswer(fact, String(q.read), lang) : null;
  if (fact && read !== null)
    replies = [
      answer(read),
      ...replies.filter((r) => !(r.posts.kind === 'answer' && r.posts.value === read)),
    ];
  return { text: q.text, replies };
}

/** The fields the pane shows: the confirmed sheet's where there is one, else the draft's. */
function fieldsOf(reading: IntakeReading, lang: Lang): SheetFields {
  const s = reading.sheet;
  const fields = fieldsOfDraft({ ...reading.draft, country: null }, lang);
  if (!s) return { ...fields, horizon: reading.draft.horizonOpen ? '' : fields.horizon };
  return {
    ...fields,
    goal: s.goal,
    amount: String(s.amountUsd),
    income: s.incomeTargetUsdMonthly === undefined ? '' : String(s.incomeTargetUsdMonthly),
    // a goal with no date shows none: the months it is built over are never shown
    horizon: s.horizonOpen ? '' : String(s.horizonMonths),
    risk: s.risk,
  };
}

export function intakeConversation(
  apiFetch: ApiFetch,
  o: {
    lang: Lang;
    /** The chain of the person's wallet: a sheet for another is not one a plan is built from here. */
    chain: ChainId | null;
    /** Reads the turn where the intake cannot: no route, or no sign-in our server knows. */
    fallback: Conversation;
  },
): Conversation {
  const { lang, chain, fallback } = o;

  /** A reply that asks our server nothing: what is held, with something said. */
  const local = (sheet: Sheet, say: Say[], state: IntakeState, ask?: Fact): Reply => ({
    sheet: { ...sheet, intake: state },
    open: [],
    say,
    ask: ask ?? null,
    // a fact the person reopened is asked in the screen's own words
    question: ask ? null : state.question,
    valid: ask
      ? null
      : state.sheet && chain && state.sheet.chains[0] === chain
        ? state.sheet
        : null,
  });

  return {
    async turn(input: Send, known: Sheet | null): Promise<Reply> {
      const held: Sheet = known ?? { fields: EMPTY(lang), skipped: [] };
      // A conversation the rules reader held, with nothing to send again, stays with it.
      if (known && !known.intake && (known.words ?? []).length === 0 && input.kind !== 'text')
        return fallback.turn(input, known);
      let words = held.words ?? [];
      // A conversation the rules reader began: the facts it had are the answers, and nothing is
      // known of how they stood at each earlier message.
      let state: IntakeState = held.intake ?? {
        ...NEW,
        answers: answersOf(held.fields),
        answersThen: words.slice(1).map(() => ({})),
      };

      if (input.kind === 'reopen') return local(held, [], state, input.fact);
      if (input.kind === 'answer') {
        if (input.fact === 'horizon' && input.value === NO_DATE) {
          const { horizonMonths: _, ...rest } = state.answers;
          state = { ...state, answers: { ...rest, horizonOpen: true } };
        } else if (input.fact === 'income' && input.value.trim() === '') {
          const { incomeTargetUsdMonthly: _, ...rest } = state.answers;
          state = { ...state, answers: rest };
        } else {
          const fit = fitAnswer(input.fact, input.value, lang);
          if (fit === null)
            return local(held, [{ key: 'unfit', fact: input.fact }], state, input.fact);
          state = { ...state, answers: withAnswer(state.answers, input.fact, fit) };
        }
      }
      if (input.kind === 'text') {
        const text = input.text.trim();
        // A bare figure typed to the question that is open is its answer: "5" to "for how long?".
        const asked = input.asked ?? null;
        const bare = asked && /^[^\p{L}]*$/u.test(text) ? typedAnswer(asked, text, lang) : null;
        if (asked && bare !== null)
          state = { ...state, answers: withAnswer(state.answers, asked, bare) };
        else if (words.length === 0) words = [text];
        else if (words.length > MAX_FOLLOW_UPS) return local(held, [{ key: 'full' }], state);
        else {
          words = [...words, text];
          state = { ...state, answersThen: [...state.answersThen, state.answers] };
        }
      }
      if (words.length === 0) return local(held, [], state);

      const outcome = await readIntake(apiFetch, {
        text: words[0] as string,
        language: lang,
        followUps: words.slice(1),
        // one for each later message
        answersThen: words.slice(1).map((_, i) => state.answersThen[i] ?? {}),
        answers: state.answers,
      });
      if (
        outcome.kind === 'unavailable' ||
        outcome.kind === 'signed-out' ||
        outcome.kind === 'no-identity'
      ) {
        const { intake: _, ...plain } = held;
        return fallback.turn(input, known ? plain : null);
      }
      if (outcome.kind !== 'read') {
        // Nothing was read: what was held stands, and the message is not kept as sent.
        const before = held.intake ?? state;
        if (outcome.kind === 'refused')
          return local(
            held,
            [
              input.kind === 'answer'
                ? { key: 'unfit', fact: input.fact }
                : { key: 'failed', why: 'unreadable' },
            ],
            before,
          );
        return local(held, [{ key: 'failed', why: outcome.kind }], before);
      }

      const reading = outcome.reading;
      const first = reading.questions[0] ?? null;
      const question = first ? questionOf(first, lang) : null;
      const fields = fieldsOf(reading, lang);
      const next: IntakeState = {
        answers: state.answers,
        answersThen: state.answersThen,
        sheet: reading.sheet,
        question,
        mix: reading.mix,
        themes: reading.themes,
        horizonOpen: (reading.sheet?.horizonOpen ?? reading.draft.horizonOpen) === true,
      };
      const sheet: Sheet = {
        fields,
        skipped: held.skipped,
        words,
        intake: next,
      };
      const valid =
        reading.sheet && chain && reading.sheet.chains[0] === chain ? reading.sheet : null;
      // The same sheet as before: nothing changed, and it is not said back a second time.
      const same =
        input.kind !== 'replay' &&
        held.intake?.sheet != null &&
        JSON.stringify(held.intake.sheet) === JSON.stringify(reading.sheet);
      const found = FACTS.some((fact) => fields[fact] !== '');
      const say: Say[] = same
        ? [{ key: 'held' }]
        : reading.readBack
          ? [{ key: 'said', lines: reading.readBack }]
          : [
              ...(found ? [{ key: 'understood' as const }] : []),
              ...(reading.assumptions.length > 0
                ? [{ key: 'said' as const, lines: reading.assumptions }]
                : []),
            ];
      return {
        sheet,
        open: reading.questions.flatMap((q) => FACT_OF[q.field] ?? []),
        say,
        ask: first ? (FACT_OF[first.field] ?? null) : null,
        question,
        valid,
      };
    },
  };
}
