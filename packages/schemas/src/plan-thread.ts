import { z } from 'zod';
import { BasketSheet } from './basket-sheet';
import { ChainId } from './chain';

// A plan's thread (gate PLAN-THREAD): what the person asked, what the app understood, and what
// happened to the plan since, in the order it happened. One thread per plan, and so per vault: a vault
// is joined to its plan by its number on chain (`GET /v1/me/plans`). It is the person's own and nobody
// else's: `GET` and `POST /v1/baskets/{id}/thread`, signed in.
//
// The thread is a conversation's: every plan built in it shares it (apps/api/src/orders/thread.ts).
//
// Three kinds of turn:
//   person   their words, as they typed them. Plain text, and personal: never in a log, never on a
//            public route, never in what a shared plan shows.
//   app      what the app said back, as KEYS of a closed list and the facts it used, each of which
//            the plan's own sheet holds, never a sentence. The screen says
//            it from its dictionary in the person's language, with every figure taken from the facts.
//            No model's free text is stored, and no rendered figure: a figure kept as words could not
//            be told from one the app made up.
//   event    what happened, written by the server where an order changes state: the plan was built,
//            an order was made, its deposit landed, the buy was done or stopped, money was added or
//            taken out. A browser cannot write one.

export const THREAD_LIMITS = {
  /** The most a person's turn may hold, in characters: the goal box's own bound. */
  textMax: 2000,
  /** The most turns one page of a thread holds. */
  pageMax: 50,
  /** The most a reply may say or ask about in one turn. */
  sayMax: 8,
  /** The most turns of a thread started before sign-in that a new plan takes with it. */
  attachMax: 50,
  /** The most fields of a sheet a rebuilt plan may be said to have changed. */
  changedMax: 16,
} as const;

/**
 * Characters a person's words may not hold: the control characters (a line break and a tab are
 * allowed), and the marks that reorder text on the screen (bidi overrides and isolates), which can
 * make a sentence read as another.
 */
const NOT_PLAIN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is refused
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** A person's words: plain text of a bounded length, with something in it. */
export const ThreadText = z
  .string()
  // A browser on Windows sends a line break as two characters: stored as the one.
  .overwrite((text) => text.replace(/\r\n/g, '\n'))
  .max(THREAD_LIMITS.textMax)
  .refine((text) => text.trim().length > 0, 'a turn says something')
  .refine((text) => !NOT_PLAIN.test(text), 'plain text only: no control or direction characters');

/**
 * A key the screen has words for (`understood`, `set`, `plan.built`), or the name of a fact: letters
 * and digits in parts joined by a dot or an underscore. No space and no punctuation, so no sentence
 * and no figure with its unit fits in one.
 */
export const ThreadKey = z
  .string()
  .max(48)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._][A-Za-z0-9]+)*$/, 'a key: letters and digits, no spaces');

/** The facts of the sheet a reply used: values the sheet takes, each optional, and nothing else. */
export const ThreadFacts = z.strictObject({
  goal: BasketSheet.shape.goal.optional(),
  amountUsd: z.number().positive().max(1_000_000).optional(),
  /** Null: asked and declined, so it is not asked again. */
  incomeTargetUsdMonthly: z.number().positive().max(1_000_000).nullable().optional(),
  horizonMonths: z.number().int().min(1).max(480).optional(),
  risk: BasketSheet.shape.risk.optional(),
  chain: ChainId.optional(),
});
export type ThreadFacts = z.infer<typeof ThreadFacts>;

/**
 * The facts of a goal a conversation settles, by the names the screen's dictionary has for them: what
 * a line is about, the question asked next, what is still open. The whole list; the web's templates
 * are keyed by it.
 */
export const THREAD_FACT_NAMES = ['goal', 'amount', 'income', 'horizon', 'risk'] as const;
export const ThreadFactName = z.enum(THREAD_FACT_NAMES);
export type ThreadFactName = z.infer<typeof ThreadFactName>;

/** Why the reader gave nothing back, as the screen says it (`failed`). */
export const THREAD_WHYS = ['too_short', 'too_long', 'busy', 'unreachable', 'unreadable'] as const;

/**
 * The single names a person may ask for that a plan cannot be told to hold (`cantPick`), by the app's
 * own key for each: what is said back is the app's name for it, never the person's typed words.
 */
export const THREAD_PICKS = [
  'nvidia',
  'apple',
  'tesla',
  'microsoft',
  'amazon',
  'google',
  'meta',
  'bitcoin',
  'ether',
] as const;

const line = <K extends string, S extends z.ZodRawShape>(key: K, more: S = {} as S) =>
  z.strictObject({ key: z.literal(key), ...more });

/**
 * One thing the app said, by its key: a closed list, each key with the one value it is said with and
 * no other field. The screen has the words for each; a key that is not here has none, and is refused.
 */
export const ThreadSay = z.discriminatedUnion('key', [
  /** What was understood, said from the facts. */
  line('understood'),
  line('notUnderstood'),
  /** Words that change nothing while a goal is held. */
  line('held'),
  /** The fact was set by the answer. */
  line('set', { fact: ThreadFactName }),
  /** The reader could not be reached, or could not read the text. */
  line('failed', { why: z.enum(THREAD_WHYS) }),
  /** An answer that is not one the fact takes. */
  line('unfit', { fact: ThreadFactName }),
  /** One stock or coin asked for by name, which a plan cannot be told yet. */
  line('cantPick', { pick: z.enum(THREAD_PICKS) }),
  line('riskTop'),
  line('riskBottom'),
  /** Every fact is known: the plan is being built. */
  line('ready'),
]);
export type ThreadSay = z.infer<typeof ThreadSay>;
/** Every key a reply may say. */
export const THREAD_SAY_KEYS = ThreadSay.options.map((o) => o.shape.key.value);

/** What the app said back: what to say by key, the next question, what is still open, and the facts. */
export const ThreadReply = z.strictObject({
  say: z.array(ThreadSay).max(THREAD_LIMITS.sayMax),
  /** The one question asked next, by the fact it asks for; null when none. */
  ask: ThreadFactName.nullable(),
  /** The facts still to settle. */
  open: z.array(ThreadFactName).max(THREAD_FACT_NAMES.length),
  facts: ThreadFacts,
});
export type ThreadReply = z.infer<typeof ThreadReply>;

/**
 * The facts of a reply that the sheet does not hold, by name: a figure or a value that is not the
 * plan's own. A reply's facts are said back to the person as the app's, so each one given must be the
 * sheet's; a fact not settled yet is left out. An income target given as null (asked and declined)
 * is held by a sheet that has none.
 */
export function factsNotHeld(facts: ThreadFacts, sheet: BasketSheet): (keyof ThreadFacts)[] {
  const held: {
    [K in keyof ThreadFacts]-?: (value: NonNullable<ThreadFacts[K]> | null) => boolean;
  } = {
    goal: (v) => v === sheet.goal,
    amountUsd: (v) => v === sheet.amountUsd,
    incomeTargetUsdMonthly: (v) => (v ?? undefined) === sheet.incomeTargetUsdMonthly,
    horizonMonths: (v) => v === sheet.horizonMonths,
    risk: (v) => v === sheet.risk,
    chain: (v) => v !== null && sheet.chains.includes(v),
  };
  return (Object.keys(held) as (keyof ThreadFacts)[]).filter(
    (name) => facts[name] !== undefined && !held[name](facts[name] as never),
  );
}

/** What happened to the plan, as the server saw it. `orderId` reads at `GET /v1/orders/{id}`. */
export const ThreadEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan_built'), planId: z.string().uuid() }),
  /**
   * A plan built again in the same conversation: the new plan, the one it follows, and the names of
   * the sheet's fields that differ between the two (`amountUsd`, `risk`), never their values.
   */
  z.object({
    type: z.literal('plan_rebuilt'),
    planId: z.string().uuid(),
    previousPlanId: z.string().uuid(),
    changed: z.array(ThreadKey).max(THREAD_LIMITS.changedMax),
  }),
  z.object({
    type: z.literal('order_made'),
    orderId: z.string().uuid(),
    /** A first buy, more money into the vault, the rest of a stopped buy, or money taken out. */
    kind: z.enum(['buy', 'add', 'finish', 'withdraw']),
    /** The dollars the order moves in; null for an order that moves none in. */
    amountUsd: z.number().nullable(),
  }),
  z.object({ type: z.literal('deposit_landed'), orderId: z.string().uuid() }),
  z.object({ type: z.literal('buy_done'), orderId: z.string().uuid() }),
  /** The deposit landed and the buy did not finish: its cash is in the vault. */
  z.object({ type: z.literal('buy_stopped'), orderId: z.string().uuid() }),
  z.object({ type: z.literal('withdrawal_done'), orderId: z.string().uuid() }),
]);
export type ThreadEvent = z.infer<typeof ThreadEvent>;

const turn = { id: z.string().uuid(), at: z.string().datetime() };
export const ThreadTurn = z.discriminatedUnion('who', [
  z.object({ ...turn, who: z.literal('person'), text: z.string() }),
  z.object({ ...turn, who: z.literal('app'), reply: ThreadReply }),
  z.object({ ...turn, who: z.literal('event'), event: ThreadEvent }),
]);
export type ThreadTurn = z.infer<typeof ThreadTurn>;

/** The path of the thread routes. */
export const ThreadParams = z.object({ id: z.string().uuid() });

/** `GET /v1/baskets/{id}/thread`: a page of at most `limit` turns, those before `before`. */
export const ThreadQuery = z.object({
  limit: z.coerce.number().int().min(1).max(THREAD_LIMITS.pageMax).default(THREAD_LIMITS.pageMax),
  /** The `before` of the page read last: the page of the turns older than it. */
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});
export type ThreadQuery = z.infer<typeof ThreadQuery>;

/**
 * A page of a thread: the newest turns, oldest first, so the newest is last. `before` is what to send
 * for the page of older turns, and null when this page starts at the thread's first turn.
 */
export const ThreadResponse = z.object({
  planId: z.string().uuid(),
  turns: z.array(ThreadTurn),
  before: z.string().nullable(),
});
export type ThreadResponse = z.infer<typeof ThreadResponse>;

/** `POST /v1/baskets/{id}/thread`: the person's words and what the app said back to them. */
export const ThreadTurnRequest = z.strictObject({ text: ThreadText, reply: ThreadReply });
export type ThreadTurnRequest = z.infer<typeof ThreadTurnRequest>;

/** The two turns as they were stored: the person's, then the app's. */
export const ThreadTurnResponse = z.object({
  planId: z.string().uuid(),
  turns: z.array(ThreadTurn),
});
export type ThreadTurnResponse = z.infer<typeof ThreadTurnResponse>;

/**
 * A thread started before the plan was the person's own (signed out, in the tab): the turns so far,
 * sent with the sheet when the plan is made (`POST /v1/baskets/personalize`) and stored once.
 */
export const ThreadStart = z.array(ThreadTurnRequest).max(THREAD_LIMITS.attachMax);
export type ThreadStart = z.infer<typeof ThreadStart>;
