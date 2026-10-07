import type { BasketSheet, ChainId } from '@colosseum/schemas';
import type { Lang } from '../../i18n';
import type { ApiFetch } from '../account/person';
import { preRead } from '../goal/pre-read';
import { fieldsOfDraft, type SheetFields } from '../goal/sheet';
import {
  affirmed,
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
  baseOf,
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

/**
 * What a message speaks of, as the keys of the answers it then decides: read by this app's own rules
 * over the words (never sent anywhere), and `mix` where it names what to hold or a share.
 */
function spokenOf(text: string, lang: Lang): Set<string> {
  const words = preRead(affirmed(text, lang) || text);
  const keys = new Set<string>();
  if (words.goal) keys.add('goal');
  if (words.amountUsd != null) keys.add('amountUsd');
  if (words.incomeTargetUsdMonthly != null) keys.add('incomeTargetUsdMonthly');
  if (words.horizonMonths != null) {
    keys.add('horizonMonths');
    keys.add('horizonOpen');
  }
  if (words.risk || /\b(risk|risco|safer|riskier|segur\w+|arriscad\w+)\b/i.test(text))
    keys.add('risk');
  if (
    /%|\b(stocks?|shares|equit\w+|crypto|cash|gold|bonds?|yield|ações|acoes|cripto|caixa|ouro|renda fixa)\b/i.test(
      text,
    )
  )
    keys.add('mix');
  return keys;
}

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
  if (fact === 'goal') {
    next.goal = value as BasketSheet['goal'];
    // a monthly income is an income goal's: another goal does not carry one
    if (value !== 'income') delete next.incomeTargetUsdMonthly;
  } else if (fact === 'risk') next.risk = value as BasketSheet['risk'];
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
  // How the money is held, or how much of it goes to what was named: a share by a press, sent as
  // the answer to this question, so words that say something else do not ask it again.
  else if (q.field === 'mix')
    replies = [
      { posts: { kind: 'hold', shareBps: 10_000 }, label: { kind: 'word', word: 'all' } },
      { posts: { kind: 'hold', shareBps: 7000 }, label: { kind: 'share', bps: 7000 } },
      { posts: { kind: 'hold', shareBps: 5000 }, label: { kind: 'word', word: 'half' } },
      { posts: { kind: 'hold', shareBps: 3000 }, label: { kind: 'share', bps: 3000 } },
      { posts: { kind: 'hold', shareBps: null }, label: { kind: 'word', word: 'none' } },
    ];
  // What our server read and asks to be sure of is the first reply: one press confirms it.
  const read = fact && q.read !== undefined ? fitAnswer(fact, String(q.read), lang) : null;
  if (fact && read !== null)
    replies = [
      answer(read),
      ...replies.filter((r) => !(r.posts.kind === 'answer' && r.posts.value === read)),
    ];
  return { text: q.text, replies };
}

/**
 * The fields the pane shows, one source for the whole conversation: the confirmed sheet's where there
 * is one; else what our server read, with every answer the person gave by a press over it. An answer
 * is never dropped because the server's draft, which is of the text alone, does not carry it.
 */
function fieldsOf(reading: IntakeReading, answers: IntakeAnswers, lang: Lang): SheetFields {
  const s = reading.sheet;
  const draft = fieldsOfDraft({ ...reading.draft, country: null }, lang);
  if (!s) {
    const open = (answers.horizonOpen ?? reading.draft.horizonOpen) === true;
    return {
      ...draft,
      ...(answers.goal ? { goal: answers.goal } : {}),
      ...(answers.amountUsd !== undefined ? { amount: String(answers.amountUsd) } : {}),
      ...(answers.incomeTargetUsdMonthly !== undefined
        ? { income: String(answers.incomeTargetUsdMonthly) }
        : {}),
      ...(answers.risk ? { risk: answers.risk } : {}),
      horizon: open
        ? ''
        : answers.horizonMonths !== undefined
          ? String(answers.horizonMonths)
          : draft.horizon,
    };
  }
  return {
    ...draft,
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
      if (input.kind === 'hold') {
        const bps = input.shareBps;
        state = {
          ...state,
          held:
            bps === null
              ? null
              : { growthBps: bps, dollarYieldBps: 0, goldBps: 0, cashBps: 10_000 - bps },
        };
      }
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
        else {
          // What the words speak of is the words' to decide: an answer pressed earlier for the
          // same fact no longer stands over them ("High" pressed, then "make it low risk").
          const spoken = spokenOf(text, lang);
          const answers = Object.fromEntries(
            Object.entries(state.answers).filter(([key]) => !spoken.has(key)),
          ) as IntakeAnswers;
          const { held: pressed, ...rest } = state;
          state = spoken.has('mix') ? { ...rest, answers } : { ...rest, answers, held: pressed };
          if (state.held === undefined) delete state.held;
          if (words.length === 0) words = [text];
          else {
            words = [...words, text];
            // one for each later message, also for those a rules reader's turns left none for
            const then = words.slice(1, -1).map((_, i) => state.answersThen[i] ?? {});
            state = { ...state, answersThen: [...then, state.answers] };
          }
        }
      }
      if (words.length === 0) return local(held, [{ key: 'held' }], state);

      // A conversation has no end at ten messages. The route takes ten later ones: past that, the
      // messages our server had already read into its last read-back are left out of the request
      // (they stay on the screen), and what that sheet held goes in their place as answers. A
      // stretch longer than ten with no read-back in it keeps its last ten.
      const later = words.slice(1);
      const long = later.length > MAX_FOLLOW_UPS;
      const from = long
        ? Math.max((state.absorbed?.upTo ?? 1) - 1, later.length - MAX_FOLLOW_UPS)
        : 0;
      const spokenNow = input.kind === 'text' ? spokenOf(input.text, lang) : new Set<string>();
      const base =
        long && state.absorbed && from >= state.absorbed.upTo - 1
          ? Object.fromEntries(
              // a fact the newest message speaks of is the message's to decide
              Object.entries(state.absorbed.answers).filter(
                ([key]) =>
                  !spokenNow.has(key) &&
                  !(spokenNow.has('mix') && (key === 'sleeves' || key === 'themes')),
              ),
            )
          : undefined;
      const outcome = await readIntake(apiFetch, {
        text: words[0] as string,
        language: lang,
        followUps: later.slice(from),
        // one for each later message that is sent
        answersThen: later.map((_, i) => state.answersThen[i] ?? {}).slice(from),
        answers: state.answers,
        ...(state.held !== undefined ? { mix: state.held } : {}),
        ...(base ? { base } : {}),
      });
      if (
        outcome.kind === 'unavailable' ||
        outcome.kind === 'signed-out' ||
        outcome.kind === 'no-identity' ||
        outcome.kind === 'unreachable' ||
        outcome.kind === 'unreadable'
      ) {
        // The intake did not answer: this turn is read by the rules, with every fact held carried
        // over, and that is said, once. The next turn asks the intake again.
        const { intake: _, ...plain } = held;
        const read = await fallback.turn(
          input.kind === 'hold' || input.kind === 'replay' ? { kind: 'replay' } : input,
          known ? plain : null,
        );
        const told = held.simple === true;
        return {
          ...read,
          sheet: { ...read.sheet, simple: true },
          say: told ? read.say : [{ key: 'simple' }, ...read.say],
          reader: { by: 'app rules', why: `intake ${outcome.kind}` },
        };
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
      const fields = fieldsOf(reading, state.answers, lang);
      const next: IntakeState = {
        answers: state.answers,
        answersThen: state.answersThen,
        ...(state.held !== undefined ? { held: state.held } : {}),
        ...(reading.readBack ? { readBack: reading.readBack } : {}),
        // where this read-back stands, or the last one did
        ...(reading.sheet
          ? { absorbed: { upTo: words.length, answers: baseOf(reading.sheet) } }
          : state.absorbed
            ? { absorbed: state.absorbed }
            : {}),
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
      // The same question again after words that were meant to answer it: said, so it does not
      // read as a loop.
      const again =
        input.kind === 'text' && question !== null && held.intake?.question?.text === question.text;
      // The same sheet as before is not said back a second time: only what the read-back says now
      // that it did not say before (that no stock fits a name, say).
      const before = new Set(held.intake?.readBack ?? []);
      const fresh = (reading.readBack ?? []).filter((line) => !before.has(line));
      let say: Say[] = same
        ? fresh.length > 0
          ? [{ key: 'said', lines: fresh }]
          : [{ key: 'held' }]
        : reading.readBack
          ? [{ key: 'said', lines: reading.readBack }]
          : [
              ...(again ? [{ key: 'notAnswer' as const }] : []),
              // What was understood so far is said before the question, from our server's own
              // fields: the facts, what it read the person wants held, what nothing fits.
              ...(found && !again ? [{ key: 'understood' as const }] : []),
              ...(!again && (reading.themes.length > 0 || reading.mix)
                ? [
                    {
                      key: 'heard' as const,
                      themes: reading.themes.map((theme) => theme.name),
                      mix: reading.mix,
                    },
                  ]
                : []),
              ...(!again && reading.noneYet ? [{ key: 'noneYet' as const }] : []),
              ...(reading.assumptions.length > 0
                ? [{ key: 'said' as const, lines: reading.assumptions }]
                : []),
              ...(question && !again ? [{ key: 'first' as const }] : []),
            ];
      // Never an empty turn: with nothing to say and nothing to ask, what is held is said.
      if (say.length === 0 && question === null) say = [{ key: found ? 'held' : 'notUnderstood' }];
      return {
        sheet,
        open: reading.questions.flatMap((q) => FACT_OF[q.field] ?? []),
        say,
        ask: first ? (FACT_OF[first.field] ?? null) : null,
        question,
        valid,
        // Our server says, by its code, that stocks or a theme asked for are not held because of
        // the goal: making it a goal to grow is the change that would hold them.
        ...(reading.flags.some(
          (f) => f === 'mix_dropped_for_goal' || f === 'themes_dropped_for_goal',
        ) &&
        fields.goal !== '' &&
        fields.goal !== 'grow'
          ? {
              offers: [
                {
                  posts: { kind: 'answer', fact: 'goal', value: 'grow' },
                  label: { kind: 'word', word: 'growGoal' },
                },
              ],
            }
          : {}),
        reader: {
          by: reading.reader.method === 'model' ? 'model' : 'server rules',
          why: reading.reader.why,
        },
      };
    },
  };
}
