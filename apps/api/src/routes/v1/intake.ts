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
  type IntakeResult,
  LimitsDraft,
  PersonalInputError,
  PersonalMix,
  PersonalSheet,
  riskForMix,
  riskForMixEstimate,
  riskForSleeves,
  runIntake,
  type StockAttributesFile,
  shelfLabelsOf,
  type ThemeList,
  yesOrNoSaidIn,
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
import type { IntakeModel, IntakeVocabulary } from '../../llm';
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
export const INTAKE_TEXT_BUDGET = 22_000;
export const INTAKE_FOLLOW_UPS = 199;

export const PendingInterest = z.strictObject({
  quote: z.string().trim().min(1).max(160),
  sourceTurn: z.number().int().min(0),
});
export type PendingInterest = z.infer<typeof PendingInterest>;

export const IntakeRequest = z
  .object({
    text: z.string().trim().min(GOAL_TEXT.min).max(GOAL_TEXT.max),
    /** The language of the page, when the text does not settle it. */
    language: Language.optional(),
    /**
     * The person's later messages, in their own words, in order ("70-30, I want to grow it", "half").
     * Each turn reads `text` with these through the same reader and checks (Oct 6), and a message that
     * says only a share or a mix is read as the answer to the `mix` question the ones before it left
     * open.
     */
    followUps: z
      .array(z.string().trim().min(1).max(GOAL_TEXT.max))
      .max(INTAKE_FOLLOW_UPS)
      .optional(),
    /** The person's answers to earlier questions, by field, from a form. */
    answers: IntakeAnswers.optional(),
    /**
     * The form's answers as they stood when each of `followUps` was sent, one for each, in order (the
     * third review, Oct 7). A plain yes or no names no question: it is applied only to the question
     * that was the one open when it was said, with the form as it stood then. Left out, the form is
     * counted as empty at each message, so a yes or no answers only a question that was the one open
     * whatever the form says.
     */
    answersThen: z.array(IntakeAnswers).max(INTAKE_FOLLOW_UPS).optional(),
    /** Capability opt-in: legacy clients never receive a contextual question they cannot retain. */
    dialogueVersion: z.literal(1).optional(),
    pendingInterest: PendingInterest.nullable().optional(),
    /** The actual question addressed by each person reply, aligned with followUps. */
    questionThen: z
      .array(z.literal('interestClarification').nullable())
      .max(INTAKE_FOLLOW_UPS)
      .optional(),
  })
  .superRefine((body, ctx) => {
    const words = [body.text, ...(body.followUps ?? [])];
    if (conversationText(body.text, body.followUps).length > INTAKE_TEXT_BUDGET)
      ctx.addIssue({
        code: 'custom',
        path: ['followUps'],
        message: 'the conversation exceeds 22,000 characters',
      });
    if (body.dialogueVersion === 1 && (body.questionThen?.length ?? 0) !== words.length - 1)
      ctx.addIssue({
        code: 'custom',
        path: ['questionThen'],
        message: 'Question origins must align with followUps.',
      });
    if (body.answersThen !== undefined && body.answersThen.length !== words.length - 1)
      ctx.addIssue({
        code: 'custom',
        path: ['answersThen'],
        message: 'send one answersThen entry per follow-up',
      });
    if (
      body.pendingInterest &&
      !words[body.pendingInterest.sourceTurn]?.includes(body.pendingInterest.quote)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['pendingInterest'],
        message: 'The pending interest must quote its original person turn.',
      });
    if (body.dialogueVersion !== 1 && (body.pendingInterest || body.questionThen))
      ctx.addIssue({
        code: 'custom',
        path: ['dialogueVersion'],
        message: 'Contextual state requires dialogueVersion 1.',
      });
  })
  .describe(
    'At most 200 chronological messages and 22,000 characters in their trimmed text joined by blank lines. Each message is at most 2,000 characters. When answersThen is provided, it has one entry per follow-up.',
  );
export type IntakeRequest = z.infer<typeof IntakeRequest>;

export const IntakeResponse = z.object({
  /** Present for supported dialogue clients; absence never discharges a stored pending interest. */
  pendingInterest: PendingInterest.nullable().optional(),
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

const Interest = z.strictObject({
  kind: z.literal('interest'),
  quote: z.string().min(1).max(160),
  keywords: z.array(z.string().min(1).max(80)).max(3),
});

const Resolution = z.strictObject({
  kind: z.enum(['business', 'allocation', 'decline']),
  quote: z.string().min(1).max(GOAL_TEXT.max),
});

/** Keep all original words for the model. Only an ambiguous answer to the contextual question is
 * withheld from the execution reader, with its aligned historic form snapshot. No words are made up. */
export function executionHistory(body: IntakeRequest) {
  const turns = (body.followUps ?? [])
    .map((text, index) => ({ text, index }))
    .filter(
      ({ text, index }) =>
        !(
          body.dialogueVersion === 1 &&
          body.questionThen?.[index] === 'interestClarification' &&
          yesOrNoSaidIn(text) !== null
        ),
    );
  return {
    text: conversationText(
      body.text,
      turns.map((turn) => turn.text),
    ),
    ...(body.answersThen
      ? { answersThen: turns.map((turn) => body.answersThen?.[turn.index] ?? {}) }
      : {}),
  };
}

// This checks the provenance/personal instruction of semantic resolution; it does not map a name
// to any asset. A quoted, hypothetical or third-party sentence cannot begin one of these requests.
const BUSINESS_REQUEST =
  /^(?:please\s+)?(?:i\s+(?:want|would\s+like|would\s+prefer)\s+to\s+invest|invest|(?:eu\s+)?(?:quero|prefiro)\s+investir|(?:eu\s+)?gostaria\s+de\s+investir|invista)\b/iu;
const ALLOCATION_REQUEST =
  /^(?:please\s+)?(?:i\s+(?:want|would\s+like|would\s+prefer)\s+to\s+)?(?:put|allocate|hold|buy|add|increase|reduce|replace)\b|^(?:(?:eu\s+)?(?:quero|prefiro)\s+)?(?:colocar|alocar|manter|comprar|aumentar|reduzir|coloque|aloque|mantenha|compre|aumente|reduza)\b/iu;
const COMPLETE_REQUEST =
  /^(?:please\s+)?(?:grow|protect|earn|invest|i\s+(?:want|would\s+like|plan|intend)\s+to\s+(?:grow|protect|earn|invest|save)|(?:eu\s+)?(?:quero|gostaria\s+de|pretendo)\s+(?:crescer|proteger|investir|ganhar|poupar)|crescer|proteger|investir)\b/iu;
const DECLINE_INTEREST =
  /^(?:ignore\s+that\s+interest|ignore\s+esse\s+interesse|esque[cç]a\s+esse\s+interesse)[.!]?$/iu;
const NON_REQUEST =
  /\b(?:if|would\s+you|should\s+i|my\s+friend|someone|said|quoted|se\s+eu|meu\s+amigo|disse)\b/iu;
const FINANCIAL_ACTION =
  /\b(?:invest|investir|invista|allocate|aloque|hold|mantenha|stocks?|shares?|a[cç][oõ]es|empresas?|business(?:es)?|industr(?:y|ies)|setor(?:es)?|allocation|aloca[cç][aã]o|cash|caixa|gold|ouro|bonds?|t[ií]tulos|crypto|cripto)\b/iu;
const EXPLORATORY_REQUEST =
  /\b(?:explain|understand|know|learn|discuss|read\s+about|hear\s+about|saber|entender|explique|explicar|conhecer|aprender)\b/iu;

type CompanyDialogue = { quote: string; name: string; listed: boolean; options: string[] };

/** Only a company the person actually names; alternatives come from confirmed shelf membership. */
export function namedCompanyDialogue(
  text: string,
  stocks: StockAttributesFile | null,
  themes: ThemeList[],
  assets: BasketAsset[],
  language: 'en' | 'pt',
): CompanyDialogue | undefined {
  if (!stocks || NON_REQUEST.test(text) || EXPLORATORY_REQUEST.test(text)) return;
  for (const row of stocks.stocks) {
    if (row.unverified.includes('company')) continue;
    const short = row.company.replace(/,?\s+(?:Inc\.?|Corporation|Corp\.?|Ltd\.?|plc)$/iu, '');
    for (const name of [row.company, short, row.underlying, row.symbol]) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const found = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
      if (!found) continue;
      // A plain contextual answer may name the business; an unsolicited mention is not an order.
      if (
        !BUSINESS_REQUEST.test(text) &&
        !ALLOCATION_REQUEST.test(text) &&
        text.trim() !== found[0]
      )
        continue;
      const available = shelfLabelsOf(themes, assets);
      const options = themes
        .filter(
          (theme) =>
            theme.chain === stocks.chain &&
            theme.status === 'confirmed' &&
            theme.members.some((member) => member.symbol === row.symbol) &&
            available.some((label) => label.slug === theme.slug && label.listed > 0),
        )
        .slice(0, 3)
        .map((theme) =>
          language === 'pt'
            ? `Quero investir em ${theme.name.pt}.`
            : `I want to invest in ${theme.name.en}.`,
        );
      return {
        quote: found[0],
        name: row.company,
        listed: assets.some((asset) => asset.chain === stocks.chain && asset.symbol === row.symbol),
        options,
      };
    }
  }
}

/** Non-executable reader metadata can ask a question, never set a holding or a sheet field. */
export function contextualIntake(
  result: IntakeResult,
  reply: unknown,
  latestText: string,
  nowMonth: string,
  vocabulary?: IntakeVocabulary,
  dialogue?: { pendingInterest: PendingInterest | null; sourceTurn: number },
  company?: CompanyDialogue,
): IntakeResult & { pendingInterest?: PendingInterest | null } {
  if (!dialogue) return result;
  let pending = dialogue.pendingInterest;
  const raw = z.object({ clarification: Interest }).safeParse(reply);
  const fresh =
    yesOrNoSaidIn(latestText) === null &&
    raw.success &&
    raw.data.clarification.quote.trim() === raw.data.clarification.quote &&
    latestText.includes(raw.data.clarification.quote) &&
    raw.data.clarification.keywords.every((word) => vocabulary?.keywords.includes(word));
  // A complete latest instruction is handled by the execution reader, even with bad metadata.
  // This is a pure read, with no historic form answers and no second model call.
  const latest = runIntake({
    text: latestText,
    nowMonth,
    language: result.language,
    reply,
    homeChain: result.sheet?.chains[0] ?? result.draft.chains?.[0] ?? null,
    portfolios: [],
  });
  const resolution = z.object({ interestResolution: Resolution }).safeParse(reply);
  const explicit =
    resolution.success &&
    resolution.data.interestResolution.quote === latestText &&
    yesOrNoSaidIn(latestText) === null &&
    !NON_REQUEST.test(latestText) &&
    !EXPLORATORY_REQUEST.test(latestText) &&
    (resolution.data.interestResolution.kind === 'business'
      ? BUSINESS_REQUEST.test(latestText)
      : resolution.data.interestResolution.kind === 'allocation'
        ? latest.mix !== null ||
          (ALLOCATION_REQUEST.test(latestText) && FINANCIAL_ACTION.test(latestText))
        : DECLINE_INTEREST.test(latestText));
  const complete =
    latest.sheet !== null &&
    COMPLETE_REQUEST.test(latestText) &&
    !NON_REQUEST.test(latestText) &&
    !EXPLORATORY_REQUEST.test(latestText);
  const needsTarget =
    explicit &&
    resolution.success &&
    resolution.data.interestResolution.kind === 'business' &&
    /\b(?:benefit\s+from|related\s+to|connected\s+to|ligad[oa]s?\s+a)\b/iu.test(latestText) &&
    result.narratives.length === 0 &&
    result.mix === null;
  // The explicit authored decline is usable even when the reader timed out or spent its budget.
  if (
    DECLINE_INTEREST.test(latestText.trim()) ||
    (reply !== null && (complete || (explicit && !needsTarget)))
  )
    pending = null;
  else if (!pending && fresh && raw.success)
    pending = { quote: raw.data.clarification.quote, sourceTurn: dialogue.sourceTurn };
  if ((needsTarget || company) && !DECLINE_INTEREST.test(latestText.trim()))
    pending ??= {
      quote: company?.quote ?? latestText.slice(0, 160),
      sourceTurn: dialogue.sourceTurn,
    };
  if (!pending) return { ...result, pendingInterest: null };
  const quote = pending.quote;
  const keywords = fresh && raw.success ? raw.data.clarification.keywords : [];
  const pt = result.language === 'pt';
  const question: IntakeQuestion = {
    field: 'themes',
    template: 'interestClarification',
    text: pt
      ? `Quando você diz “${quote}”, há um negócio ou setor que você quer refletir neste plano? Diga qual.`
      : `When you say “${quote}”, is there a business or industry you want this plan to reflect? Tell me which one.`,
  };
  if (company) {
    question.text = pt
      ? `Você nomeou ${company.name}. ${company.listed ? 'O ativo está listado nesta rede, mas o plano ainda não aceita escolher uma ação individual.' : 'Esse ativo não está listado nesta rede.'} ${company.options.length > 0 ? 'Quer explorar um tema relacionado disponível, ou deixar essa ideia de lado?' : 'Nenhum tema relacionado está disponível nesta rede. Nomeie outra empresa ou setor, ou deixe essa ideia de lado.'}`
      : `You named ${company.name}. ${company.listed ? 'The instrument is listed on this chain, but the plan does not support choosing an individual stock yet.' : 'This instrument is not listed on this chain.'} ${company.options.length > 0 ? 'Would you like to explore a related available theme, or leave this idea aside?' : 'No related theme is available on this chain. Name another company or sector, or leave this idea aside.'}`;
  } else if (needsTarget) {
    question.text = pt
      ? 'Entendi que você quer investir em ações ligadas a esse interesse. Qual empresa ou setor você tem em mente?'
      : 'You want stocks connected to this interest. Which particular company or sector do you have in mind?';
  } else if (fresh && latestText !== quote) {
    question.text = pt
      ? 'Qual parte desse interesse você quer refletir no investimento? Pode nomear uma empresa ou setor, ou deixar a ideia de lado.'
      : 'What part of this interest would you like your investment to reflect? You can name a company or sector, or leave the idea aside.';
  }
  // Choices repeat only a vocabulary value the person actually wrote. Clicking one creates a new
  // person-origin message, not a themes form answer or an inferred holding.
  const named = [...new Set(keywords)].filter((word) =>
    quote.toLocaleLowerCase().includes(word.toLocaleLowerCase()),
  );
  question.options = [
    ...(company?.options ??
      named.map((word) =>
        pt
          ? `Quero investir em negócios ligados a ${word}.`
          : `I want to invest in businesses related to ${word}.`,
      )),
    pt ? 'Ignore esse interesse.' : 'Ignore that interest.',
  ];
  return {
    ...result,
    pendingInterest: pending,
    questions: [question, ...result.questions],
    sheet: null,
    readBack: null,
  };
}

/**
 * What the route says of itself in the API document, sentence by sentence. One string there.
 */
const INTAKE_DESCRIPTION = [
  "The guided intake. Send the text of a goal, and on later turns the same text with the person's later messages in `followUps` (their own words, read again with the text by the same reader and checks) or `answers` (by field, from a form).",
  'Contextual dialogue requires `dialogueVersion: 1`; legacy clients receive ordinary questions only. A personal exploratory interest whose investment meaning is unclear can receive a contextual question (field `themes`, template `interestClarification`). Non-executable model metadata must quote exact words of the latest person message; the API authors the question in English or Portuguese. No company, asset or allocation is inferred from admiration. Optional choices repeat only person-written sourced shelf keywords as new natural-language messages, never form answers. The response `pendingInterest` carries the original quote and its `sourceTurn` (0 is `text`, 1 is the first `followUps` turn). Send this conservative state back, with `questionThen` aligned to `followUps` recording which replies addressed `interestClarification`. Invalid quote/source alignment is refused. The original words all reach the model; only bare yes/no addressed to the contextual question, and the matching `answersThen` slots, are omitted from execution-history interpretation so they cannot confirm older holdings. No replacement person words are fabricated. While pending, sheet and read-back remain null through missing metadata, model fallback, thanks and ambiguous yes/no. A model-validated explicit business/allocation request, explicit decline or complete valid latest instruction clears pending state; ordinary missing facts can still be asked. Rules-only fallback conservatively retains pending state even after a complete new instruction. The authored choices “Ignore that interest.” and “Ignore esse interesse.” are exact person commands that clear pending state without a model; bare no, quotation, negation or a third-party story do not. At most three sourced business choices plus this decline are offered. An absent response marker never clears client state.',
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
      const { language, answers } = req.body;
      const text = conversationText(req.body.text, req.body.followUps);
      const execution = executionHistory(req.body);
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
        ? await model.read(
            text,
            nowMonth,
            language,
            principal.userId ?? principal.ip,
            vocabulary,
            req.body.dialogueVersion === 1
              ? {
                  turns: [req.body.text, ...(req.body.followUps ?? [])],
                  latestTurn: req.body.followUps?.length ?? 0,
                  pendingInterest: req.body.pendingInterest ?? null,
                  questionOrigin: req.body.questionThen?.at(-1) ?? null,
                }
              : undefined,
          )
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
      const reading = runIntake({
        text: execution.text,
        nowMonth,
        language,
        reply: read.reply,
        answers,
        ...(execution.answersThen ? { answersThen: execution.answersThen } : {}),
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
      const result = contextualIntake(
        reading,
        read.reply,
        req.body.followUps?.at(-1) ?? req.body.text,
        nowMonth,
        vocabulary,
        req.body.dialogueVersion === 1
          ? {
              pendingInterest: req.body.pendingInterest ?? null,
              sourceTurn: req.body.followUps?.length ?? 0,
            }
          : undefined,
        held
          ? namedCompanyDialogue(
              req.body.followUps?.at(-1) ?? req.body.text,
              stocks,
              held.figures.themes ?? [],
              held.shelf.assets,
              reading.language,
            )
          : undefined,
      );
      const byModel = read.reply !== null && model !== null;
      return {
        ...(req.body.dialogueVersion === 1
          ? { pendingInterest: result.pendingInterest ?? null }
          : {}),
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
