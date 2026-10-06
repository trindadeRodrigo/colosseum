import {
  conversationText,
  Disagreement,
  IntakeAnswers,
  IntakeNarrative,
  IntakeQuestion,
  LimitsDraft,
  PersonalMix,
  PersonalSheet,
  runIntake,
} from '@colosseum/engine/personal';
import { BasketSheetDraft, Language, OrderError } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { IntakeModel } from '../../llm';
import type { OrderDeps } from '../../orders/legs';
import { personChain } from '../../orders/person';
import { loadFamilies } from '../../orders/store';
import { signedIn } from './orders';

// The guided intake (gate GUIDED-INTAKE; DESIGN-VAULT section 7). The person sends the text of their
// goal, and on later turns the same text with their answers. The answer is what was read, the
// questions still open, and, once none is, the sheet and its read-back. The person's confirm sends that
// sheet to POST /v1/baskets/personalize: this route builds nothing and stores nothing.

/** What a goal's text may be: the bounds of the first reader (`PostGoalsRequest`), kept. */
export const GOAL_TEXT = { min: 3, max: 2000 } as const;

export const IntakeRequest = z.object({
  text: z.string().trim().min(GOAL_TEXT.min).max(GOAL_TEXT.max),
  /** The language of the page, when the text does not settle it. */
  language: Language.optional(),
  /**
   * The person's later messages, in their own words, in order ("70-30, I want to grow it", "I live in
   * Brazil"). Each turn reads `text` with these through the same reader and checks (Oct 6).
   */
  followUps: z.array(z.string().trim().min(1).max(GOAL_TEXT.max)).max(10).optional(),
  /** The person's answers to earlier questions, by field, from a form. */
  answers: IntakeAnswers.optional(),
});
export type IntakeRequest = z.infer<typeof IntakeRequest>;

export const IntakeResponse = z.object({
  /** How the text was read. A model reply replayed in a test is `mock`, and says so. */
  reader: z.object({
    method: z.enum(['model', 'rules']),
    model: z.string().nullable(),
    provenance: z.enum(['live', 'mock']).nullable(),
    /** Why no model read it, when none did: `model_not_configured`, `model_timeout`, `model_budget_spent`, `model_person_budget_spent`. */
    why: z.string().nullable(),
  }),
  language: Language,
  /** What the text says, after the checks: every field null that it does not say or that failed. */
  draft: BasketSheetDraft,
  /** The refusals the text writes ("no stocks", "sem crédito"), as read. */
  limits: LimitsDraft,
  /** One per field still open or unclear, from fixed templates. Empty once the sheet is whole. */
  questions: z.array(IntakeQuestion),
  flags: z.array(z.string()),
  disagreements: z.array(Disagreement),
  /** The sheet the person confirms, once nothing is left to ask. What `personalize` will run on. */
  sheet: PersonalSheet.nullable(),
  /**
   * What was understood, said back sentence by sentence from the sheet by templates, with what was
   * assumed before the last sentence.
   */
  readBack: z.array(z.string()).nullable(),
  /** What was assumed from the person's words ("I took 'go crazy' as high risk"), from templates. */
  assumptions: z.array(z.string()),
  /**
   * What the person said to hold (gate EXPLICIT-MIX: "all of it in stocks", "70% stocks and 30% cash",
   * "only credit"), as written in the text; null when none is. The risk is then not asked.
   */
  mix: PersonalMix.nullable(),
  /**
   * The markets, industries and trends the text asks for ("big tech", "semiconductors", "defense
   * stocks"), in the order written, each with what code reads it to on the person's chain: a shared
   * portfolio, a curated label (gate THEMES), a filter over the stocks' sourced attributes (gate
   * THEME-MATCHED), or nothing. Empty while the person has no chain.
   */
  narratives: z.array(IntakeNarrative),
});
export type IntakeResponse = z.infer<typeof IntakeResponse>;

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

export function registerIntakeRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  model: IntakeModel | null,
) {
  const f = scope.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/v1/baskets/intake',
    {
      config: { auth: 'user', limit: 'parse' },
      schema: {
        tags: ['plans'],
        summary:
          'Read a goal into a sheet, ask what it leaves open, and say back what was understood',
        description:
          'The guided intake. Send the text of a goal, and on later turns the same text with the person\'s later messages in `followUps` (their own words, read again with the text by the same reader and checks) or `answers` (by field, from a form). A model reads the text into a draft of the sheet; it never sets weights, picks assets or states a figure, and every value it gives is checked in code: an amount must be written in the text in its role (the income as a rate a month, the sum put in never as one) and in dollars (an amount in another currency is asked in dollars), a time frame must be written as one (not an age), a shared portfolio must be on the shelf of the person\'s chain, a refusal ("no stocks", "sem crédito") must be written, a goal or a risk the text has no word for is asked with the model\'s value as the start, a time to get the money out ("can take up to 3 months to get out") is never the time frame, a goal with no date ("no hard cap") is built with no date and said back so, a split ("70% safe, 30% to risk") must be written and add up to the whole, and a field the rules parser reads differently is flagged and asked. The glide is off unless the text asks for it or names a date the money is needed by. The country is neither asked nor read (gate COUNTRY-REMOVED). What the person says to hold (gate EXPLICIT-MIX: "all of it in stocks", "70% stocks and 30% cash", "only credit", "tudo em ações") is taken only as written in English or Portuguese and goes in `mix`: the risk is then never asked, and the read-back says once which limits the plan uses for it; a mix with stocks on a goal of income or to protect is asked once (grow, or no stocks). A market, an industry or a trend the person names to invest in ("big tech", "the S&P", "AI", "semiconductors", "space stocks", "setor de defesa") is read by fixed word lists in English and Portuguese, as an ask: one the text rules out ("no big tech") or says of the person ("I work in software") is not read, and "crypto" and gold alone are no market. Code then reads each to the first of these the person\'s chain has, and `narratives` says which: a shared portfolio on the shelf (big tech: The Seven; the US market: The 500), the plan\'s starting point as before; a curated label that is confirmed and lists a stock there (gate THEMES); a filter over the stocks\' sourced attributes that matches a stock listed there (gate THEME-MATCHED: defense is industry Aerospace & Defense), said as matched and never as a curated theme; or nothing, said in one line that names the person\'s words and chain ("There is no stock for “space” on Solana at the moment. We will be adding more soon.") with the nearest shared portfolio or label the shelf has where it has one. A market the lists have no word for ("obesity drugs") may come from the model as one attribute and its value with the person\'s own words (`marketFilter`): it must be a valid filter and its words must be written in the text, or it is dropped (`no_cue:marketFilter`, `model_invalid:marketFilter`) and nothing is asked; with no model only the fixed words are read. The model never names a company, a ticker, a portfolio or a label. A market read to a shared portfolio, or to nothing, whose share of the money is written ("invest in big tech", "put $500 in US stocks") is held as a mix (that share in stocks, the rest in cash) and the risk is not asked, and one with no share said ("I like AI") asks once how much of the money (question field `mix`), never the risk. A market read to a label or a filter is held as a theme sleeve of the sheet by the same rule (`sleeves`: `{ kind: "theme", theme, shareBps }`, the slug a label\'s, or `matched-` with the attribute and the value, as `matched-industry-aerospace-defense`): the whole plan, or a written sum with the rest in the safe-yield sleeve, one sleeve for each narrative with a sum; the risk is never asked and follows what is held, said once. A mix and sleeves are not combined by guessing. Where one theme alone has no share written, or stands beside a stated mix that says another share, how much is asked once (`mix`), and an answered `mix` of stocks and cash is that theme\'s share. Where several themes do not each have a written share, or a theme stands beside a shared portfolio the text also names or beside a written split, the split is asked once (`sleeves`): only a split says a share for each part. Answered `sleeves` may carry a theme sleeve, whose slug must be a usable label or a filter that matches (else `answer_not_on_shelf:sleeves`, asked again), and a split that holds a theme is what is held, over a mix the text states. On a goal of income or to protect a theme is not held, as a market\'s share is not read there, and that is said. While the person has no chain, nothing is resolved and nothing is said of what a chain has (flags `market_unresolved:` with the id). The text may be in any language: the questions and the read-back are in English or Portuguese (any other language is answered in English), and a value the English and Portuguese checks cannot find in the text is asked, never taken. With no model (none configured, down, out of the daily budget for everyone or for this person), the rules parser fills the draft, every field it read is asked once, and the same questions are asked; `reader` says which read it; a failed call is not cached, so a later turn may be read by the model and the draft can change. `questions` holds one question per field still open or unclear, in the person\'s language, from fixed templates. Once none is left, `sheet` is the validated sheet on the chain of the person\'s wallet and `readBack` says it back sentence by sentence, from templates, never from the model. Nothing is built or stored: the person\'s confirm sends `sheet` to `POST /v1/baskets/personalize`. The plan that follows is not advice: see its `disclaimer`.',
        body: IntakeRequest,
        response: { 200: IntakeResponse, default: OrderError },
      },
    },
    async (req): Promise<IntakeResponse> => {
      const principal = signedIn(req);
      const { language, answers } = req.body;
      const text = conversationText(req.body.text, req.body.followUps);
      const nowMonth = monthOf(deps.now());
      const { chain } = await personChain(deps.db, principal);
      const portfolios = chain
        ? (await loadFamilies(deps.db, chain)).map((f) => ({
            slug: f.meta.slug,
            name: f.meta.name,
          }))
        : [];
      const read: { reply: unknown; why?: string } = model
        ? await model.read(text, nowMonth, language, principal.userId ?? principal.ip)
        : { reply: null, why: 'model_not_configured' };
      const result = runIntake({
        text,
        nowMonth,
        language,
        reply: read.reply,
        answers,
        homeChain: chain,
        portfolios,
      });
      const byModel = read.reply !== null && model !== null;
      return {
        reader: {
          method: result.method,
          model: byModel ? model.id : null,
          provenance: byModel ? model.provenance : null,
          why: read.why ?? null,
        },
        language: result.language,
        draft: result.draft,
        limits: result.limits,
        questions: result.questions,
        flags: result.flags,
        disagreements: result.disagreements,
        sheet: result.sheet,
        readBack: result.readBack,
        assumptions: result.assumptions,
        mix: result.mix,
        narratives: result.narratives,
      };
    },
  );
}
