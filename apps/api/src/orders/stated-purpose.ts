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
// oldest, a message that states the value cleanly sets it; one that does not, but names any value of
// that kind or holds any refusal or correction, withdraws it; only a message with neither is passed
// over for an older one.

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

/** The values of one kind whose words are in the message. */
function found<T extends string>(text: string, words: Record<T, string>): T[] {
  return (Object.keys(words) as T[]).filter((value) => word(words[value]).test(text));
}

/** One message, read whole. */
function readMessage(message: string): { goal: Read<Goal>; risk: Read<Risk> } {
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
  const tokens = rest
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
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
  return {
    goal: read(goals, meant, GOAL_MENTION.test(text)),
    risk: read(risks, meant || OWN_LEVEL.test(text), RISK_MENTION.test(text)),
  };
}

/**
 * The goal and risk as the person's messages state them now, each null when they do not. Only the
 * person's messages are read, the newest first, for the goal and for the risk separately: the first
 * that states the value or withdraws it settles it. So an earlier statement stands only through
 * messages that have nothing to do with it, and "yes" to a question of the app's states nothing.
 */
export function statedPurpose(messages: VaultAgentRequest['messages']): VaultAgentStatedPurpose {
  const reads = messages
    .filter((message) => message.who === 'person')
    .map((message) => readMessage(message.text))
    .reverse();
  const settled = <T>(of: (read: (typeof reads)[number]) => Read<T>): T | null => {
    for (const read of reads) {
      const kind = of(read);
      if (kind.state === 'said') return kind.value;
      if (kind.state === 'withdrawn') return null;
    }
    return null;
  };
  return { goal: settled((read) => read.goal), risk: settled((read) => read.risk) };
}
