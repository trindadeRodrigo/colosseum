import {
  attributeVocabularyOf,
  conversationText,
  Disagreement,
  filterMatchOf,
  IntakeAnswers,
  IntakeNarrative,
  IntakeQuestion,
  LimitsDraft,
  PersonalMix,
  PersonalSheet,
  riskForMix,
  runIntake,
  shelfLabelsOf,
} from '@colosseum/engine/personal';
import {
  type BasketAsset,
  BasketSheetDraft,
  Language,
  OrderError,
  type Shelf,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { IntakeModel } from '../../llm';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { personChain } from '../../orders/person';
import { type PlanInputs, shelfVersionOf } from '../../orders/personalize';
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
   * The person's later messages, in their own words, in order ("70-30, I want to grow it", "half").
   * Each turn reads `text` with these through the same reader and checks (Oct 6), and a message that
   * says only a share or a mix is read as the answer to the `mix` question the ones before it left
   * open.
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
  /**
   * The refusals the text states ("no stocks", "sem crédito"), read by code with or without a model:
   * what the sheet's limits take.
   */
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
   * "only credit"), as stated in the text or answered; null when none is. The risk is then not asked.
   * A mix the text rules out, wonders about or says of something else is never here.
   */
  mix: PersonalMix.nullable(),
  /**
   * The markets, industries and trends the text asks for ("big tech", "semiconductors", "defense
   * stocks"), in the order written, each with what code reads it to on the person's chain: a shared
   * portfolio, a curated label (gate THEMES), a filter over the sourced attributes (gate
   * THEME-MATCHED), or nothing (gate THEME-NONE-YET: said, and nothing is held for it). Empty while
   * the person has no chain.
   */
  narratives: z.array(IntakeNarrative),
});
export type IntakeResponse = z.infer<typeof IntakeResponse>;

/**
 * What the route says of itself in the API document, sentence by sentence. One string there.
 */
const INTAKE_DESCRIPTION = [
  "The guided intake. Send the text of a goal, and on later turns the same text with the person's later messages in `followUps` (their own words, read again with the text by the same reader and checks) or `answers` (by field, from a form).",
  'A model reads the text into a draft of the sheet; it never sets weights, picks assets or states a figure, and every value it gives is checked in code: an amount must be written in the text in its role (the income as a rate a month, the sum put in never as one) and in dollars (an amount in another currency is asked in dollars), a time frame must be written as one (not an age), a shared portfolio must be written in the text by its name or its slug (one the model names that the text does not write is dropped, `no_cue:portfolios`, and nothing is asked) and be on the shelf of the person\'s chain, a refusal ("no stocks", "I don\'t want any crypto", "I can\'t hold stocks", "sem crédito") is read from the text by code, with or without the model, and becomes the sheet\'s limits where its clause states it: it is taken, not asked, and the read-back says it back (one the clause negates, says of something else, says of a part of a class as "no US stocks", or only wonders about as "no stocks? not sure", is not taken, flagged `refusal_` with how and what, and said where the person was not sure; what the model gives that the text does not write is dropped, and what the text states that the model missed is taken all the same), a goal or a risk the text has no word for is asked with the model\'s value as the start, a time to get the money out ("can take up to 3 months to get out") is never the time frame, a goal with no date ("no hard cap") is built with no date and said back so, a split ("70% safe, 30% to risk") must be written and add up to the whole, and a field the rules parser reads differently is flagged and asked.',
  'The glide is off unless the text asks for it or names a date the money is needed by. The country is neither asked nor read (gate COUNTRY-REMOVED).',
  'What the person says to hold (gate EXPLICIT-MIX: "all of it in stocks", "stocks only", "70% stocks and 30% cash", "70% in stocks and the rest in cash", "60/40 stocks and bonds", "only credit", "tudo em ações") is taken only as written in English or Portuguese, and only where its clause states it as what the person wants held, and goes in `mix`: the risk is then never asked, and the read-back says once which limits the plan uses for it. A mix its clause rules out or says of something else ("I wouldn\'t put all of it in stocks", "I am retired so no stocks please", "instead of only stocks", "my brother is all in crypto") is not taken and not asked: nothing is built from the opposite of what is written. A mix the person only wonders about ("Should I put all of it in stocks?"), one said of a part of the money ("70% safe, and the other 30% all in stocks"), and one the model reads that the words cannot confirm (`no_cue:mix`) are asked once (question field `mix`, its `read` the mix it is asked about where there is one), never dropped into the risk question. Where the person also gave a risk and the limits a mix or a theme needs are another\'s, the sheet takes the risk those limits need and the read-back says both in one line ("You said low risk, but to hold “all of it in stocks” the plan uses the limits for high risk."). A mix with stocks on a goal of income or to protect is asked once (grow, or no stocks).',
  'A market, an industry or a trend the person names to invest in ("big tech", "the S&P", "AI", "semiconductors", "space stocks", "pharma", "setor de defesa") is read by fixed word lists in English and Portuguese, as an ask: one the text rules out ("no big tech", "I would never invest in big tech", "anything but AI"), says of the person ("I work in software") or says of what they or someone else hold ("I already invest in the S&P 500 through my pension") is not read, and "crypto" and gold alone are no market.',
  "Code then reads each to the first of these the person's chain has, and `narratives` says which: a shared portfolio on the shelf (big tech: The Seven; the US market: The 500), the plan's starting point as before; a curated label that is confirmed and lists a name there (gate THEMES); the first of the narrative's filters over the sourced attributes, in the order of its list, that matches a name listed there (gate THEME-MATCHED: defense is industry Aerospace & Defense, then keyword defense), said as matched and never as a curated theme; or nothing (gate THEME-NONE-YET), said in one line that names the person's words and chain (\"There is no stock for “space” on Solana at the moment. We will be adding more soon.\") with the nearest shared portfolio or label the shelf has where it has one. Nothing is held for a narrative that reads to nothing: no mix and no sleeve is made from it, its share is never asked, and the rest of the intake goes on as if it had not been named, so the risk is asked as for any goal.",
  'A market the lists have no word for ("obesity drugs") may come from the model as one attribute and its value with the person\'s own words (`marketFilter`): it must be a valid filter of a bounded length and its words must be written in the text, or it is dropped (`no_cue:marketFilter`, `model_invalid:marketFilter`) and nothing is asked; with no model only the fixed words are read. The model never names a company, a ticker, a portfolio or a label.',
  'A market read to a shared portfolio whose share of the money is written ("invest in big tech", "put $500 in US stocks", "put 50% in big tech", "half in the S&P") is held as a mix (that share in stocks, the rest in cash) and the risk is not asked, and one with no share said ("I like big tech") asks once how much of the money (question field `mix`), never the risk. A market read to a label or a filter is held as a theme sleeve of the sheet by the same rule (`sleeves`: `{ kind: "theme", theme, shareBps }`, the slug a label\'s, or `matched-` with the attribute and the value, as `matched-industry-aerospace-defense`): the whole plan, or a written sum or percent ("30% in AI", "half in semiconductors") with the rest in the safe-yield sleeve, one sleeve for each narrative with a share; the risk is never asked and follows what is held, said once. A mix and sleeves are not combined by guessing. Where one theme alone has no share written, or stands beside a stated mix that says another share, how much is asked once (`mix`), and an answered `mix` of stocks and cash is that theme\'s share. Where several themes do not each have a written share, or a theme stands beside a shared portfolio the text also names or beside a written split, the split is asked once (`sleeves`): only a split says a share for each part. Answered `sleeves` may carry a theme sleeve, whose slug must be a usable label or a filter that matches (else `answer_not_on_shelf:sleeves`, asked again), and a split that holds a theme is what is held, over a mix the text states. On a goal of income or to protect a theme is not held, as a market\'s share is not read there, and that is said.',
  'A later message that says only a share or a mix ("70-30", "half", "all of it", "all of it in stocks") is read as the answer to the `mix` question the messages before it left open, as an answer on the form is (flag `mix_from_words`); an answer on the form wins.',
  'While the person has no chain, nothing is resolved and nothing is said of what a chain has (flags `market_unresolved:` with the id).',
  'The text may be in any language: the questions and the read-back are in English or Portuguese (any other language is answered in English), and a value the English and Portuguese checks cannot find in the text is asked, never taken.',
  'With no model (none configured, down, out of the daily budget for everyone or for this person), the rules parser fills the draft, every field it read is asked once, and the same questions are asked; `reader` says which read it; a failed call is not cached, so a later turn may be read by the model and the draft can change.',
  '`questions` holds one question per field still open or unclear, in the person\'s language, from fixed templates. Once none is left, `sheet` is the validated sheet on the chain of the person\'s wallet and `readBack` says it back sentence by sentence, from templates, never from the model, with the time frame the way the person said it (in years, in months, or as a date: "over 5 years", "by January 2031").',
  "Nothing is built or stored: the person's confirm sends `sheet` to `POST /v1/baskets/personalize`. The plan that follows is not advice: see its `disclaimer`.",
].join(' ');

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/**
 * What the person's chain can hold for a narrative, read the way `POST /v1/baskets/personalize` reads
 * it: the tokens the chain's adapter lists, the shared portfolios in effect, and what the server hands
 * in as a plan's inputs (the curated lists and the stock attributes among them, which are files, and
 * no file a /v1 route reaches may read one). Null where the chain is off: the goal is still read, with
 * nothing known of what the chain holds.
 */
async function shelfOf(
  deps: OrderDeps,
  inputs: PlanInputs,
  chain: NonNullable<Awaited<ReturnType<typeof personChain>>['chain']>,
  families: Shelf['families'],
) {
  let assets: BasketAsset[];
  try {
    assets = await refusing(() => deps.chains.get(chain).adapter.listAssets());
  } catch (err) {
    if (err instanceof Refusal) return null;
    throw err;
  }
  const shelf: Shelf = { version: shelfVersionOf(chain, assets, families), assets, families };
  return { shelf, figures: await inputs({ db: deps.db, chain, assets }) };
}

export function registerIntakeRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  model: IntakeModel | null,
  inputs: PlanInputs = async () => ({}),
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
        description: INTAKE_DESCRIPTION,
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
      const families = chain ? await loadFamilies(deps.db, chain) : [];
      const portfolios = families.map((f) => ({ slug: f.meta.slug, name: f.meta.name }));
      const held = chain ? await shelfOf(deps, inputs, chain, families) : null;
      const stocks = held?.figures.stocks ?? null;
      // The model is shown our own keywords, never a symbol or a company's name, and no name of the
      // stock classification (DESIGN-VAULT section 17, item 30): it knows those names by itself.
      const vocabulary = stocks
        ? {
            sectors: [],
            industries: [],
            subIndustries: [],
            keywords: attributeVocabularyOf(stocks).keywords,
          }
        : undefined;
      const read: { reply: unknown; why?: string } = model
        ? await model.read(text, nowMonth, language, principal.userId ?? principal.ip, vocabulary)
        : { reply: null, why: 'model_not_configured' };
      const now = deps.now().toISOString();
      const result = runIntake({
        text,
        nowMonth,
        language,
        reply: read.reply,
        answers,
        homeChain: chain,
        portfolios,
        ...(held && chain
          ? {
              // The curated labels of the chain and what a filter matches there (gates THEMES,
              // THEME-MATCHED): pure code over the lists and the sourced attributes.
              labels: shelfLabelsOf(held.figures.themes ?? [], held.shelf.assets),
              matchOf: (filter) => filterMatchOf(filter, stocks, held.shelf.assets),
              // The limits a stated mix takes, by the engine's own rule on this chain's shelf and
              // figures, so the read-back names the risk the plan will take (gate EXPLICIT-MIX).
              riskOfMix: (mix, themes) =>
                riskForMix(
                  {
                    basketType: 'standard',
                    goal: 'grow',
                    amountUsd: 10_000,
                    horizonMonths: 120,
                    risk: 'low',
                    themes,
                    chains: [chain],
                    rules: { useHoldings: false, glide: false },
                    language: 'en',
                    mix,
                  },
                  held.shelf,
                  {
                    now,
                    ...(held.figures.yields ? { yields: held.figures.yields } : {}),
                    ...(held.figures.themes ? { themes: held.figures.themes } : {}),
                    ...(stocks ? { stocks } : {}),
                    ...(held.figures.liquidity
                      ? {
                          liquidity: held.figures.liquidity.provider,
                          liquiditySource: held.figures.liquidity.source,
                        }
                      : {}),
                  },
                ),
            }
          : {}),
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
