import type { VaultAgentRequest, VaultAgentStatedPurpose } from '@colosseum/schemas';

// What a new goal's money is for and the risk the person accepts, read by the server from the person's
// own messages (gate DEPOSIT-STEP). The goal decides which assets a plan may hold, so this reader errs
// towards reading nothing: a miss is asked again by one tap on the deposit step, a wrong value is a
// wrong plan. The model has no part in it.
//
// A message is read whole, never in pieces. It states a goal only when it holds exactly one goal value
// of a short closed English and Portuguese word list, on whole words, and every other word of the whole
// message is everyday filler or part of one statement of risk; and nowhere in it is there a refusal, a
// correction, a comparison, a hedge, a question, a digit or any character that is not a letter, a space
// or plain punctuation. The same for risk. The latest message wins, strictly: from the newest to the
// oldest, a message that states the value cleanly sets it, and any other message withdraws it, unless
// it is plainly about something else. That is an allow-list too: a message made only of listed asset
// and company names, figures and a few words for changing a mix ("add more Tesla"), a clean statement
// of the other kind, or a courtesy alone. A courtesy in answer to a question of the app's that names
// the kind withdraws it: the server does not read a value from "yes".

type Goal = NonNullable<VaultAgentStatedPurpose['goal']>;
type Risk = NonNullable<VaultAgentStatedPurpose['risk']>;

const word = (pattern: string, flags = 'iu') =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, flags);

/** The words that state each goal. */
export const GOAL_WORDS: Record<Goal, string> = {
  grow: 'grow|grows|growing|growth|crescer|cresça|cresca|cresce|crescimento|valorizar|valorize|valorização|valorizacao',
  income: 'income|renda',
  protect:
    'protect|protected|protecting|protection|preserve|preserved|preserving|preservation|safe|safety|proteger|proteja|protegido|protegida|proteção|protecao|preservar|preservação|preservacao|seguro|segura|segurança|seguranca',
};

// A level counts only beside the word risk, after "risk tolerance is" and its like, or as one of a few
// words a person says of themselves ("I am conservative"). "risk" alone, or "low" alone, is nothing,
// and "the risk is high" is a remark about a proposal.
const level = (en: string, pt: string, alone: string) =>
  [
    `(?:${en})[\\s-]+risk`,
    `risk\\s+(?:${en})`,
    `risk\\s+(?:tolerance|appetite|level|profile)(?:\\s+is)?\\s+(?:${en})`,
    `(?:${pt})\\s+risco`,
    `risco\\s+(?:${pt})`,
    `(?:tolerância|tolerancia|perfil|nível|nivel)\\s+(?:a|ao|de)\\s+risco(?:\\s+é)?\\s+(?:${pt})`,
    `(?:i\\s+am|i'm|sou|estou)\\s+(?:${alone})`,
  ].join('|');
/** The words that state each risk level. */
export const RISK_WORDS: Record<Risk, string> = {
  low: level(
    'low',
    'baixo|pouco',
    'conservative|cautious|conservador|conservadora|cauteloso|cautelosa',
  ),
  medium: level('medium|moderate', 'médio|medio|moderado', 'moderate|moderado|moderada'),
  high: level('high', 'alto', 'aggressive|agressivo|agressiva|arrojado|arrojada'),
};

/** Anything about a goal, or about risk: in a message that does not state one cleanly, it withdraws it. */
const GOAL_MENTION = word(Object.values(GOAL_WORDS).join('|'));
const RISK_MENTION = word(
  `${Object.values(RISK_WORDS).join('|')}|risk|risks|risky|riskier|risco|riscos|arriscad[oa]s?|volatility|volatile|volatilidade|volátil|volatil|conservative|cautious|aggressive|conservador[a]?|cautelos[oa]|agressiv[oa]|arrojad[oa]`,
);
/**
 * A refusal or a correction: with one anywhere in a message, nothing in it is a statement, and what was
 * said before it no longer stands. "but", "except" and "menos" refuse; they never separate.
 */
export const REFUSAL_WORDS =
  "not|no|nope|nah|never|none|nothing|neither|nor|without|avoid|avoiding|stop|stops|stopped|cannot|\\p{L}+n't|dont|doesnt|wont|cant|isnt|but|except|excluding|however|though|although|instead|rather|sorry|actually|honestly|wait|change|changed|changing|prefer|away|out\\s+of|não|nao|nem|sem|nunca|jamais|nenhum|nenhuma|nada|evitar|evite|evito|parar|pare|parou|para\\s+de|sair|mas|porém|porem|contudo|exceto|menos|desculpa|desculpe|na\\s+verdade|aliás|alias|espera|prefiro|melhor|mudar|mudei|mudo|pensando";
const REFUSAL = word(REFUSAL_WORDS);
/** A comparison, a hedge or a level set against another: the message states nothing, and withdraws only what it names. */
const HEDGE = word(
  'or|than|versus|vs|maybe|perhaps|might|could|if|unless|whether|depends|depending|probably|either|between|unsure|think|guess|wonder|better|best|lower|higher|less|more|fewer|smaller|bigger|safer|riskier|ou|do\\s+que|em\\s+vez|ao\\s+invés|ao\\s+inves|talvez|se|caso|depende|dependendo|provavelmente|entre|acho|será|sera|mais|menor|maior',
);
const QUESTION =
  /^(?:why|what|which|who|when|where|how|is|are|was|were|should|shall|can|could|would|do|does|did|will|por\s*que|porque|o\s+que|qual|quais|quem|quando|onde|como|será|sera|devo|vale)(?![\p{L}\p{N}])/iu;
/** A goal word in another sense: insurance, "safely", "safe to", "my income" as what the person has. */
const OTHER_SENSE = word(
  '(?:um|uns|o|os|meu|de|do|fazer)\\s+seguros?|com\\s+(?:segurança|seguranca)|safe\\s+(?:to|for)|safely|(?:my|our|meu|minha|nosso|nossa)\\s+(?:income|renda)|renda\\s+fixa|fixed\\s+income',
);
/** What shows the person is saying what they want or accept: "This is high risk" has none. */
const MEANS_IT = word(
  'want|wants|wanna|need|needs|like|goal|objective|aim|aiming|looking|hoping|trying|for|to|make|keep|is\\s+(?:fine|ok|okay)|comfortable|accept|take|handle|quero|queria|gostaria|preciso|busco|procuro|objetivo|meta|para|pra|fazer|manter|aceito|aceitar|tolero|topo|posso|confortável|confortavel|tudo\\s+bem',
);
/** "My risk tolerance is low" and "I am conservative" say whose it is in the words themselves. */
const OWN_LEVEL = word(
  "risk\\s+(?:tolerance|appetite|profile)|(?:tolerância|tolerancia|perfil)\\s+(?:a|ao|de)\\s+risco|(?:i\\s+am|i'm|sou|estou)\\s+(?:conservative|cautious|moderate|aggressive|conservador|conservadora|cauteloso|cautelosa|moderado|moderada|agressivo|agressiva|arrojado|arrojada)",
);
/** Or the value stands by itself, with no more than these around it: "Growth, please.", "ok, high risk". */
const COURTESY = new Set(
  'please yes yeah ok okay just only mainly and with at a the sim por favor só so apenas principalmente e com o um uma'.split(
    ' ',
  ),
);
/** Every other word a statement may hold. Any word outside it, and the message states nothing. */
const FILLER = new Set(
  `i i'm im i'd id we my me our the a an this that it its it's is are be to for of with at on in and so
  want wants wanna need needs would like looking hoping trying aim aiming goal objective after
  money savings capital portfolio plan vault investment investments funds cash please just only mainly
  really very over time long term level tolerance appetite profile fine ok okay good can take accept
  handle comfortable am yes yeah sure now then make keep some monthly every month regular
  steady should will go lets let's here as well also thanks thank you hi hello all main mine
  eu nós nos meu minha o os as um uma isso isto esse este essa esta é são ser para pra de do da com em
  na e então entao quero queria gostaria preciso busco procuro objetivo meta dinheiro
  patrimônio patrimonio capital carteira plano cofre investimento investimentos por favor só so apenas
  principalmente muito tempo longo prazo nível nivel tolerância tolerancia perfil tudo bem posso aceito
  aceitar tolero topo correr assumir tomar estou confortável confortavel sim claro agora fazer manter
  algum alguma mensal todo mês mes que ele ela vai obrigado obrigada olá ola oi ao principal passive
  passiva sou`
    .split(/\s+/)
    .filter(Boolean),
);

type Read<T> = { state: 'none' } | { state: 'withdrawn' } | { state: 'said'; value: T };

/** What a later message may be made of and leave an earlier goal or risk standing: changes to the mix. */
const MIX_WORDS = new Set(
  `add remove drop swap replace put include buy sell more less some half rest split equally equal percent
  with and for in of to the a an i i'd want would like can could you me also too into my please thanks
  thank ok okay
  adicione adiciona adicionar coloque coloca colocar inclua inclui incluir compre comprar venda vender
  tire tira tirar remova remove remover troque troca trocar mais menos pouco metade resto por cento
  com e de em o os as um uma eu quero queria gostaria pode também tambem favor obrigado obrigada`
    .split(/\s+/)
    .filter(Boolean),
);
/** Kinds of asset a person names without a ticker. */
const ASSET_KINDS = new Set(
  'stock stocks shares bonds gold cash crypto fund funds etf etfs treasuries ações acoes títulos titulos ouro caixa fundo fundos cripto'.split(
    ' ',
  ),
);
/** A message of nothing but these is a courtesy. */
const COURTESY_ALONE = new Set(
  'thanks thank you ok okay yes yeah yep sure great good perfect nice cool fine please obrigado obrigada sim claro certo beleza valeu ótimo otimo perfeito bom legal'.split(
    ' ',
  ),
);
/** Words of a company's or a token's name that are everyday words: they do not make a message about an asset. */
const NOT_A_NAME = new Set(
  'meta strategy circle oracle target block inc corp corporation company co group holdings holding trust platforms global technologies markets the and of class series limited ltd plc fund etf token tokenized'.split(
    ' ',
  ),
);
const tokensOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);

/** The values of one kind whose words are in the message. */
function found<T extends string>(text: string, words: Record<T, string>): T[] {
  return (Object.keys(words) as T[]).filter((value) => word(words[value]).test(text));
}

type MessageRead = {
  goal: Read<Goal>;
  risk: Read<Risk>;
  text: string;
  mentions: { goal: boolean; risk: boolean };
};

/** One message, read whole. */
function readMessage(message: string): MessageRead {
  // The same letters however they were typed; a line break, like a colon, is a space.
  const text = message
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[\s:]+/g, ' ')
    .trim();
  // Anything but letters, digits, spaces and plain punctuation (an emoji, a sign) and it is not read.
  const readable = !/[^\p{L}\p{N} .,!?;:'"()-]/u.test(text);
  const refuses = REFUSAL.test(text);
  const goals = found(text, GOAL_WORDS);
  const risks = found(text, RISK_WORDS);
  // What is left once the values are taken out is filler and nothing else: no other word, no digit.
  let rest = text;
  for (const words of [...Object.values(RISK_WORDS), ...Object.values(GOAL_WORDS)])
    rest = rest.replace(word(words, 'giu'), ' ');
  const tokens = tokensOf(rest);
  const plain =
    readable &&
    !refuses &&
    !HEDGE.test(text) &&
    !OTHER_SENSE.test(text) &&
    !text.includes('?') &&
    !QUESTION.test(text) &&
    goals.length <= 1 &&
    risks.length <= 1 &&
    tokens.every((token) => FILLER.has(token));
  const meant = MEANS_IT.test(rest) || tokens.every((token) => COURTESY.has(token));
  const read = <T>(values: T[], ok: boolean, mentioned: boolean): Read<T> =>
    plain && values.length === 1 && ok
      ? { state: 'said', value: values[0] as T }
      : mentioned || refuses
        ? { state: 'withdrawn' }
        : { state: 'none' };
  const mentions = { goal: GOAL_MENTION.test(text), risk: RISK_MENTION.test(text) };
  return {
    goal: read(goals, meant, mentions.goal),
    risk: read(risks, meant || OWN_LEVEL.test(text), mentions.risk),
    text,
    mentions,
  };
}

/**
 * The words that name a listed asset: each word of a symbol, an underlying or a company name, and a
 * token's symbol without the letters a token adds ("tSPYx" is SPY). Everyday words are left out.
 */
function nameWords(names: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const token of names.flatMap((name) => tokensOf(name.normalize('NFC')))) {
    for (const form of [token, token.replace(/x$/, ''), token.replace(/^t/, '').replace(/x$/, '')])
      if (form.length >= 2 && !NOT_A_NAME.has(form)) words.add(form);
  }
  return words;
}

/**
 * The goal and risk as the person's messages state them now, each null when they do not. Only the
 * person's messages are read, the newest first, for the goal and for the risk separately. A message
 * that states the value cleanly settles it. Any other message withdraws it and ends the walk, unless
 * it is plainly about something else: a change to the mix in listed names, figures and mix words, a
 * clean statement of the other kind alone, or a courtesy that does not answer a question about this
 * kind. `names` are the catalog's symbols, underlyings and company names.
 */
export function statedPurpose(
  messages: VaultAgentRequest['messages'],
  names: readonly string[] = [],
): VaultAgentStatedPurpose {
  const listed = nameWords(names);
  const turns = messages.flatMap((message, index) => {
    if (message.who !== 'person') return [];
    const before = messages[index - 1];
    const read = readMessage(message.text);
    const tokens = tokensOf(read.text);
    // Readable as a change to the mix: letters, figures, spaces and plain punctuation with % and $.
    const readable = !/[^\p{L}\p{N} .,!?;:'"()%$/-]/u.test(read.text);
    const figure = (token: string) => /^\d+$/.test(token);
    const names = (token: string) => listed.has(token) || ASSET_KINDS.has(token) || figure(token);
    const aboutTheMix =
      readable &&
      !read.mentions.goal &&
      !read.mentions.risk &&
      tokens.some(names) &&
      tokens.every((token) => names(token) || MIX_WORDS.has(token));
    const courtesy =
      readable && tokens.length > 0 && tokens.every((token) => COURTESY_ALONE.has(token));
    // The question the courtesy answers, where the app's message just before it is one.
    const asked =
      before?.who === 'app' && before.text.includes('?')
        ? { goal: GOAL_MENTION.test(before.text), risk: RISK_MENTION.test(before.text) }
        : { goal: false, risk: false };
    return [{ read, aboutTheMix, courtesy, asked }];
  });
  const settled = <K extends 'goal' | 'risk'>(
    kind: K,
    other: 'goal' | 'risk',
  ): VaultAgentStatedPurpose[K] => {
    for (const turn of [...turns].reverse()) {
      const mine = turn.read[kind];
      if (mine.state === 'said') return mine.value as VaultAgentStatedPurpose[K];
      const elsewhere =
        turn.aboutTheMix ||
        (turn.courtesy && !turn.asked[kind]) ||
        (turn.read[other].state === 'said' && !turn.read.mentions[kind]);
      if (!elsewhere) return null;
    }
    return null;
  };
  return { goal: settled('goal', 'risk'), risk: settled('risk', 'goal') };
}
