import {
  attributeVocabularyOf,
  type ComposeContext,
  companyNamesOf,
  conversationText,
  Disagreement,
  filterMatchOf,
  IntakeAnswers,
  IntakeNarrative,
  IntakeQuestion,
  LimitsDraft,
  PersonalInputError,
  PersonalMix,
  PersonalSheet,
  riskForMix,
  riskForMixEstimate,
  riskForSleeves,
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
import { type PlanInputs, preparePersonalInputs } from '../../orders/personalize';
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
  /**
   * The form's answers as they stood when each of `followUps` was sent, one for each, in order (the
   * third review, Oct 7). A plain yes or no names no question: it is applied only to the question
   * that was the one open when it was said, with the form as it stood then. Left out, the form is
   * counted as empty at each message, so a yes or no answers only a question that was the one open
   * whatever the form says.
   */
  answersThen: z.array(IntakeAnswers).max(10).optional(),
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
  'A model reads the text into a draft of the sheet; it never sets weights, picks assets or states a figure, and every value it gives is checked in code. An amount must be written in the text in its role (the income as a rate a month, the sum put in never as one) and in dollars (an amount in another currency is asked in dollars); a bare number is the sum only where it can be one: not where it is said of the person ("I am 35") or where the text writes another sum as money ("$5,000"), which is flagged `not_a_sum:amountUsd` and asked. Where the last message that writes a sum writes several that could be the one put in ("I have $5,000 and owe $2,000 on my card"), the amount is asked once with the model\'s value as the start (`amount_several`); a sum that leads into what it is put in ("$500 in big tech") is a share and not one of them. A time frame must be written as one (not an age, and not the length of something else: "after 5 years of marriage"); where one message writes two, the date is asked (`horizon_several`), and across messages the last one written decides. A shared portfolio must be written in the text by its name or its slug and be said as a holding: as the shelf writes it inside a sentence, after a word that picks it where it ends its clause ("starting from the seven"), or alone; its words in another sense ("The 500 dollars I saved", "Home Team lost again") are not; "the seven of us are saving" is never taken (`no_cue:portfolios`), one its clause rules out is dropped (`portfolio_negated`, `portfolio_aside`), and it must be on the shelf of the person\'s chain. Where the model names a portfolio and the text writes its words with nothing that says they name it ("My pick is the seven."), it is asked once by its name (field `themes`, template `startFrom`: "Do you want to start from the shared portfolio The Seven?", its `read` the slug; flag `portfolio_asked`): a plain yes takes it, a plain no leaves it out, and `answers.themes` stands over the question. With no model a portfolio\'s name said as a holding ("Start me off from The Seven.") is asked by the same question, with it as the start (`from_rules:themes`), and never taken. A goal or a risk the text has no word for is asked with the model\'s value as the start; a risk word a negation is of ("I can\'t take high risk") is no word for that risk, and is asked with no start (`risk_negated:<risk>`); the negation may come after the word ("High risk is not for me."), and a word of degree said of something else ("low fees", "a high tax bracket") is no word for the risk (`no_cue:risk`, asked). A time to get the money out ("can take up to 3 months to get out") is never the time frame, a goal with no date ("no hard cap") is built with no date and said back so, a split ("70% safe, 30% to risk") must add up to the whole with each share written as a share of the money ("I can lose 30% and I am 70% sure" writes none), and a field the rules parser reads differently is flagged and asked.',
  'A refusal ("no stocks", "I don\'t want any crypto", "I can\'t hold stocks", "leave out gold", "sem crédito") is read from the text by code, with or without the model, and becomes the sheet\'s limits where its clause states it: it is taken, not asked, and the read-back says it back. It leads its list ("no stocks, crypto or gold" leaves out the three). A refusal of stocks leaves out the funds of stocks with them (`cannotHold.classes` holds `stock` and `etf`, said back as "You left out stocks and stock funds."), unless their own clause then holds them ("no stocks, but ETFs are fine": an ask, a contrast with the refusal, or something said of them); funds the refusal only goes on to name are left out with it ("No stocks, including ETFs.", "No stocks. Same goes for ETFs."), a refusal of funds by their own name ("no ETFs", "no index funds") leaves out `etf` only, and bare "funds" is money, not a class. One the clause negates, says of something else or only wonders about ("no stocks? not sure") is not taken, flagged `refusal_` with how and what, and said where the person was not sure. A refusal the model gives that the text check does not confirm ("Do not buy stocks for me.", "Nada de bolsa.") is asked once by the `limits` field ("Do you want to leave out stocks and stock funds?", its `read` the classes a yes leaves out): a plain yes takes it, a plain no leaves the class in and one line says so ("You said not to leave out stocks and stock funds, so the plan may hold them."), and `answers.limits` stands over the question. A yes to it is the person\'s last word on the class: a mix, a narrative or a shared portfolio that would hold it is then not held, and never shares the sheet with it. With no model, a refusal the text states that a later mention of its class would take back ("No stocks." then "Remember, stocks are out.") is asked by the same question and not taken back on one reader\'s word: a yes keeps it, a no takes it back and says so; an answer that says what is held, or the form\'s limits, settles it without the question. It is never taken and never dropped in silence (the third review, Oct 7). What the text states that the model missed is taken all the same and said in a line of its own that names the person\'s words ("I read “avoid stocks” as leaving out stocks and stock funds. Say so if that is not what you meant."). A refusal of a part of a class ("no stocks from China") and a name ruled out of a list the plan holds ("invest in AI but no Tesla") are not applied, and a line says so; a word is such a name only where it is a company the chain\'s sourced attributes know, by name, ticker or symbol ("No IRA involved" and "not in January" say nothing). A refusal and a holding of the same class in one conversation ("No stocks in my IRA, so here I want all stocks") are one question by the `mix` field (template `holdOrLeaveOut`), never a sheet with both: a share for the holding takes the refusal back, "none" leaves the holding out. The holding is whatever would hold the class: a mix stated or answered, a narrative, a shared portfolio the model names ("No stocks. Start from The Seven."), and for a refusal of stock funds a narrative too ("No ETFs. Put it all in index funds."). The last word wins over an answer given in words (the third review, Oct 7): an answer closes its question until a later message names a narrative again, states a mix or a share for the holding ("Put 20% in AI." after "all of it", "Make that 40%." after "Put 30% in AI."), asks again for one answered "none", or refuses its class ("Also, no stocks."). The question is then open again and asked once more, with the new reading as its start, which a plain yes takes (flag `answer_reopened`); a message that says nothing of the holding leaves the answer as it is, and the form\'s own answers are not reopened.',
  'The glide is off unless the text asks for it or names a date to come that the money is needed by. The country is neither asked nor read (gate COUNTRY-REMOVED).',
  'Who must read a holding before it is taken (the second review, Oct 7): a list of the ways a clause turns a holding down cannot be finished, so the rule is not one. With a model, a mix, a narrative or a share of the money is taken with no question only where the model\'s reply reads it and the text check confirms it; words the text check finds that the reply does not read are not taken, not asked and not said (flags `text_only:mix`, `text_only:market:<id>`). Where both read a mix and the two differ, neither is taken and the `mix` question is asked once with no start (flags `disagrees_with_rules:mix`, `mix_asked:differs`): the person says the mix and it is taken as said. With no model, a holding the text check reads is asked once, with its reading as the question\'s `read`, and is never taken. The last word wins: what a later message says of a mix, a narrative, its share or a refusal decides over an earlier one (`mix_refused_later`, `share_not_last:<id>`, `refusal_withdrawn:<what>`), and within one message any ask stands. A share is taken only in its plain forms: the words that give it (a verb in the form that asks, a sum, a percent or a half, "in") open their clause or follow the person\'s own words of wanting ("I want to", "I have $5,000 to"); after any other word ("I can lose 30% in AI", "at least 30% in big tech", "I\'m afraid to invest in AI", "70% of experts say invest in AI") it is asked, never taken. A share smaller than the least a line of a plan can be is not taken, and one line says that least (`share_too_small`).',
  'What the person says to hold (gate EXPLICIT-MIX: "all of it in stocks", "stocks only", "70% stocks and 30% cash", "70% in stocks and the rest in cash", "60/40 stocks and bonds", "only credit", "tudo em ações") is read as written in English or Portuguese, and only where its clause states it as what the person wants held, and goes in `mix`: the risk is then never asked, and the read-back says once which limits the plan uses for it. A mix its clause rules out or says of something else ("I wouldn\'t put all of it in stocks", "I am retired so no stocks please", "instead of only stocks", "my brother is all in crypto") is not taken and not asked: nothing is built from the opposite of what is written. A mix the person only wonders about ("Should I put all of it in stocks?"), one said of a part of the money ("70% safe, and the other 30% all in stocks"), and one the model reads that the words cannot confirm (`no_cue:mix`) are asked once (question field `mix`, its `read` the mix it is asked about where there is one), never dropped into the risk question. Where the person also gave a risk and the limits a mix or a theme needs are another\'s, the sheet takes the risk those limits need and the read-back says both in one line ("You said low risk, but to hold “all of it in stocks” the plan uses the limits for high risk."). A mix with stocks on a goal of income or to protect is asked once (grow, or no stocks).',
  'A market, an industry or a trend the person names to invest in ("big tech", "the S&P", "AI", "semiconductors", "space stocks", "pharma", "setor de defesa") is read by fixed word lists in English and Portuguese, as an ask: one the text rules out ("no big tech", "I would never invest in big tech", "anything but AI"), says of the person ("I work in software") or says of what they or someone else hold ("I already invest in the S&P 500 through my pension") is not read, and "crypto" and gold alone are no market. A list carries what leads it: in "invest in AI and defense" both are read, what is said of the first is said of each, and two things named after one share take it to neither.',
  'Code then reads each to the first of these the person\'s chain has, and `narratives` says which: a shared portfolio on the shelf (big tech: The Seven; the US market: The 500), the plan\'s starting point as before; a curated label that is confirmed and lists a name there (gate THEMES); the first of the narrative\'s filters over the sourced attributes, in the order of its list, that matches at least two names listed there (gate THEME-MATCHED: defense is industry Aerospace & Defense, then keyword defense), said as matched and never as a curated theme; or nothing (gate THEME-NONE-YET), said in one line that names the person\'s words and chain ("There is no stock for “space” on Solana at the moment. We will be adding more soon.") with the nearest shared portfolio or label the shelf has where it has one. A filter is never used to pick one stock: where it matches one name alone the line says so ("There is only one stock for “…” on Solana at the moment, and a theme is not made of one."). Nothing is held for a narrative that reads to nothing: no mix and no sleeve is made from it, its share is never asked, and the rest of the intake goes on as if it had not been named, so the risk is asked as for any goal.',
  'A market the lists have no word for ("obesity drugs") may come from the model as one attribute and its value with the person\'s own words (`marketFilter`): it must be a valid filter of a bounded length and its words must be written in the text, or it is dropped (`no_cue:marketFilter`, `model_invalid:marketFilter`) and nothing is asked. It is taken as a narrative only where those words write its value ("defense stocks" for Aerospace & Defense): one whole item of it, and nothing else but a word for the kind of holding ("my financial future" does not write Financials, nor "my emergency fund" index fund); where they do not ("obesity drugs" for keyword GLP-1, "my future" for a sector), the link is the model\'s alone (`filter_not_written`): it is never taken, and is asked once by a question that says the match (template `matchedShare`: "I read “obesity drugs” as names matched by keyword: GLP-1. How much of the $2,000 for them? Say none if that is not what you meant."), with the share the person wrote as its `read`. With no model only the fixed words are read. The model never names a company, a ticker, a portfolio or a label.',
  'A market read to a shared portfolio whose share of the money is written in a plain form ("invest in big tech", "put $500 in US stocks", "put 50% in big tech", "half in the S&P") is held as a mix (that share in stocks, the rest in cash) and the risk is not asked, and one with no share said ("I like big tech") asks once how much of the money (question field `mix`), never the risk. A market read to a label or a filter is held as a theme sleeve of the sheet by the same rule (`sleeves`: `{ kind: "theme", theme, shareBps }`, the slug a label\'s, or `matched-` with the attribute and the value, as `matched-industry-aerospace-defense`): the whole plan, or a written sum or percent ("30% in AI", "half in semiconductors") with the rest in the safe-yield sleeve, one sleeve for each narrative with a share; the risk is never asked and follows what is held, said once. A mix and sleeves are not combined by guessing. Where one theme alone has no share written, or stands beside a stated mix that says another share, how much is asked once (`mix`), and an answered `mix` of stocks and cash is that theme\'s share. Where several themes do not each have a written share, the split is asked once by a question that names them (`sleeves`, template `themeShares`: "How do you want to split the money between AI and semiconductors?"); where the text says where the rest goes and that is not cash or kept safe ("30% in AI and the rest in stocks"), or carves a sum out of the share, the share and the rest are asked (`rest_said`, template `themeAndRest`). A share is taken only where its message says nothing else about money or holdings (the third review, Oct 7; flag `share_not_alone`): a sum written as money that is not the goal\'s own, a percent, or something else to hold, whatever the words ("All of it in AI except for a $1,000 cushion", "Invest in AI, but only 10%", "Invest in AI, and some gold too"), means the share is asked. A percent with a decimal mark is a share too ("Put 0.5% in big tech."); and where a theme stands beside a shared portfolio the text also names or beside a written split, the split is asked (`sleeves`). Answered `sleeves` may carry a theme sleeve, whose slug must be a usable label or a filter that matches (else `answer_not_on_shelf:sleeves`, asked again), and a split that holds a theme is what is held, over a mix the text states. On a goal of income or to protect a theme is not held, as a market\'s share is not read there, and that is said; a market read to a shared portfolio is not put in `themes` there either, and the same line says so (flag `themes_dropped_for_goal`).',
  'A later message is read as the answer to the question about what is held that the messages before it left open, as an answer on the form is, and an answer on the form wins: a share or a mix ("70-30", "half", "a third", "all of it", "$500", "all of it in stocks") answers the `mix` question (flag `mix_from_words`); "none", "zero", "0%" or "nothing for AI" answers it too, leaves what was asked about out for good, and the question does not come back (`none_from_words`, `market_left_out:<id>`); "half each", "50-50", "60/40" or a share for each by name answers the question that names several themes (`sleeves_from_words`). A plain yes ("yes", "that\'s right", "sim", "isso") takes that question\'s `read`, the share the text states, where it has one (`mix_confirmed`), and a plain no leaves out what it asks about; both only where it is the one question asked. "The one question asked" is counted with the form as it stood when the yes or no was sent, not as it is now (the third review, Oct 7: "Put 30% in big tech.", then "no" with four questions open, then the form filled in, left big tech out for good): the request says it in `answersThen`, one entry for each of `followUps`; left out, the form is counted as empty then, so a yes or no answers only a question that was the one open whatever the form says. The same holds for the yes or no that answers the `limits` question and the question that asks of a shared portfolio by its name. A bare number ("5"), a time ("5 years"), a hedge ("maybe 20%") or a bound ("20% at most") is no answer: the same question stays.',
  'While the person has no chain, nothing is resolved and nothing is said of what a chain has (flags `market_unresolved:` with the id). The same where what their chain lists cannot be read just now (the chain is off, or its node does not answer): the goal is still read, no sheet is made from a goal that names a market, a theme or a portfolio, and one line says so (`shelf_unread`: "What is listed on Solana could not be read just now, so nothing is held for “AI” yet.").',
  "The limits a mix or a sheet held in themes takes are the engine's own, found on the shelf and the figures of the person's chain at their amount (at a fixed $10,000 until the amount is known): for themes, the lowest risk at which the plan holds the most in their names.",
  'The text may be in any language: the questions and the read-back are in English or Portuguese (any other language is answered in English), and a value the English and Portuguese checks cannot find in the text is asked, never taken.',
  'With no model (none configured, down, out of the daily budget for everyone or for this person), the rules parser fills the draft and every field it read is asked once. A refusal the text states and "no date" are read the same and taken; a mix or a narrative the text check reads is asked once and never taken. `reader` says which read it; a failed call is not cached, so a later turn may be read by the model and the draft can change.',
  '`questions` holds one question per field still open or unclear, in the person\'s language, from fixed templates. Once none is left, `sheet` is the validated sheet on the chain of the person\'s wallet and `readBack` says it back sentence by sentence, from templates, never from the model, with the time frame the way the person said it (in years, in months, or as a date: "over 5 years", "by January 2031").',
  "Nothing is built or stored: the person's confirm sends `sheet` to `POST /v1/baskets/personalize`. The plan that follows is not advice: see its `disclaimer`.",
].join(' ');

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/**
 * The amount the engine is asked the risk of a mix or of theme sleeves at, while the person has not
 * given theirs yet. Not a figure of the plan: once the amount is known, the person's own is used.
 */
const RISK_PROBE_USD = 10_000;

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
  let entry: ReturnType<OrderDeps['chains']['get']>;
  let assets: BasketAsset[];
  try {
    entry = deps.chains.get(chain);
    assets = await refusing(() => entry.adapter.listAssets());
  } catch (err) {
    if (err instanceof Refusal) return null;
    throw err;
  }
  return preparePersonalInputs(
    chain,
    assets,
    families,
    entry.provenance,
    (chain, assets, provenance) => inputs({ db: deps.db, chain, assets, provenance }),
  );
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
      const { language, answers, answersThen } = req.body;
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
      // No model read it: said in the log with why (the request's id is on the line), and never
      // with the text. The answer says the same to the screen (`reader.why`).
      if (read.reply === null)
        req.log.warn(
          { why: read.why ?? 'model_no_reply', model: model?.id ?? null },
          'the intake fell back to the rules parser',
        );
      // What the read-back's risk is found on: this chain's shelf and figures, as the plan route
      // reads them, at the time of this request.
      const context: ComposeContext | null = held
        ? {
            now: deps.now().toISOString(),
            ...(held.figures.yields ? { yields: held.figures.yields } : {}),
            ...(held.figures.themes ? { themes: held.figures.themes } : {}),
            ...(stocks ? { stocks } : {}),
            ...(held.figures.liquidity
              ? {
                  liquidity: held.figures.liquidity.provider,
                  liquiditySource: held.figures.liquidity.source,
                }
              : {}),
          }
        : null;
      /**
       * The sheet the engine is asked the risk of: what is held, the shared portfolios read and the
       * chain, with no date, withdrawal or holding in the way. The amount is the person's where the
       * intake knows it (the engine's rule depends on it); before they have given one, a fixed
       * `RISK_PROBE_USD` stands in, and the read-back is made again once the amount is known.
       */
      const probe = (themes: string[], amountUsd: number | undefined) => ({
        basketType: 'standard' as const,
        goal: 'grow' as const,
        amountUsd: amountUsd ?? RISK_PROBE_USD,
        horizonMonths: 120,
        risk: 'low' as const,
        themes,
        chains: chain ? [chain] : [],
        rules: { useHoldings: false, glide: false },
        language: 'en' as const,
      });
      const result = runIntake({
        text,
        nowMonth,
        language,
        reply: read.reply,
        answers,
        ...(answersThen ? { answersThen } : {}),
        homeChain: chain,
        portfolios,
        // The person has a chain and what it lists could not be read (the chain is off, or its
        // adapter refused): nothing is resolved on it and no sheet is made from a goal that names
        // something only the shelf can settle; one line says so.
        ...(chain && !held ? { shelfKnown: false } : {}),
        ...(held && context
          ? {
              // The curated labels of the chain and what a filter matches there (gates THEMES,
              // THEME-MATCHED): pure code over the lists and the sourced attributes.
              labels: shelfLabelsOf(held.figures.themes ?? [], held.shelf.assets),
              matchOf: (filter) => filterMatchOf(filter, stocks, held.shelf.assets),
              // The companies the chain's attributes know, by name, ticker and symbol: a name the
              // person rules out is said back as not applied only where it is one of them.
              names: companyNamesOf(stocks),
              // The limits a stated mix takes, by the engine's own rule on this chain's shelf and
              // figures, so the read-back names the risk the plan will take (gate EXPLICIT-MIX).
              riskOfMix: (mix, themes, amountUsd) =>
                riskForMix({ ...probe(themes, amountUsd), mix }, held.shelf, context),
              // And the limits a sheet held in themes takes, by the same engine: the lowest risk at
              // which the plan holds the most in its theme sleeves' names. Where the engine cannot
              // make the plan of such a sheet, the intake's estimate on the caps stands.
              riskOfSleeves: (sleeves, themes, amountUsd) => {
                try {
                  return riskForSleeves(
                    { ...probe(themes, amountUsd), sleeves },
                    held.shelf,
                    context,
                  );
                } catch (err) {
                  if (!(err instanceof PersonalInputError)) throw err;
                  return riskForMixEstimate({
                    growthBps: sleeves.reduce(
                      (n, x) => (x.kind === 'theme' ? n + x.shareBps : n),
                      0,
                    ),
                  });
                }
              },
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
