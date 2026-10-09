import type { VaultAgentRequest, VaultAgentStatedPurpose } from '@colosseum/schemas';

// What a new goal's money is for and the risk the person accepts, read by the server from the person's
// own messages (gate DEPOSIT-STEP). The goal decides which assets a plan may hold, so this reader errs
// towards reading nothing: a miss is asked again by one tap on the deposit step, a wrong value is a
// wrong plan. It is an allow-list. A value is read only from a piece of a sentence that is a plain
// statement: one value of a short closed English and Portuguese word list, matched on whole words, and
// around it nothing but words of a closed list of everyday filler. Any other word, a digit, a negation,
// a question, a comparison or a hesitation, and the piece states nothing. The model has no part in it.

type Goal = NonNullable<VaultAgentStatedPurpose['goal']>;
type Risk = NonNullable<VaultAgentStatedPurpose['risk']>;

const EDGE_BEFORE = '(?<![\\p{L}\\p{N}])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}])';
const word = (pattern: string, flags = 'iu') =>
  new RegExp(`${EDGE_BEFORE}(?:${pattern})${EDGE_AFTER}`, flags);

/** The words that state each goal. */
export const GOAL_WORDS: Record<Goal, string> = {
  grow: 'grow|grows|growing|growth|crescer|cresça|cresca|cresce|crescimento|valorizar|valorize|valorização|valorizacao',
  income: 'income|renda',
  protect:
    'protect|protected|protecting|protection|preserve|preserved|preserving|preservation|safe|safety|proteger|proteja|protegido|protegida|proteção|protecao|preservar|preserve|preservação|preservacao|seguro|segura|segurança|seguranca',
};

// A level counts only bound to the word risk in the same piece, or as one of a few words that mean a
// level a person says of themselves ("I am conservative"). "risk" alone, or "low" alone, is nothing.
// "The risk is high" is a remark about a proposal, so the level stands right beside the word, or after
// "risk tolerance is" and its like.
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
    'conservative|conservatively|cautious|cautiously|conservador|conservadora|cauteloso|cautelosa',
  ),
  medium: level('medium|moderate', 'médio|medio|moderado', 'medium-risk'),
  high: level('high', 'alto', 'aggressive|aggressively|agressivo|agressiva|arrojado|arrojada'),
};

/** Anything about risk at all: in a piece that refuses or asks, it withdraws what was said before. */
const RISK_MENTION = word(
  'risk|risks|risky|riskier|risco|riscos|arriscad[oa]s?|volatility|volatile|volatilidade|volátil|volatil',
);
/** A level set against another ("lower risk", "mais risco"): relative to something, not a level. */
const RELATIVE = word(
  'lower|higher|less|more|fewer|smaller|bigger|safer|riskier|menos|mais|menor|maior',
);
const NEGATION = word(
  "not|no|nope|nah|never|none|nothing|neither|nor|without|avoid|avoiding|stop|cannot|\\p{L}+n't|dont|doesnt|wont|cant|isnt|não|nao|nem|sem|nunca|jamais|nenhum|nenhuma|nada|evitar|evite|evito|parar",
);
const HESITATION = word(
  'or|than|versus|vs|instead|rather|maybe|perhaps|might|could|if|unless|whether|depends|depending|probably|either|between|unsure|think|guess|wonder|ou|do\\s+que|em\\s+vez|ao\\s+invés|ao\\s+inves|talvez|se|caso|depende|dependendo|provavelmente|entre|acho|será|sera|melhor|better|best',
);
const QUESTION =
  /^(?:why|what|which|who|when|where|how|is|are|was|were|should|shall|can|could|would|do|does|did|will|por\s*que|porque|o\s+que|qual|quais|quem|quando|onde|como|será|sera|devo|vale)(?![\p{L}\p{N}])/iu;
/** A refusal with nothing else in it ("Actually no."): it takes back what was said, whatever it was. */
const BARE_NO =
  /^(?:(?:actually|wait|well|hmm|oh|sorry|na\s+verdade|espera|bem|desculpa)[\s,]+)*(?:no|nope|nah|not\s+that|não|nao|isso\s+não|isso\s+nao)$/iu;
/** What ends a piece: sentence punctuation, a line, and a turn in the sentence. */
const PIECES =
  /[.!;\n]+|(?<=\?)|(?<![\p{L}\p{N}])(?:but|however|though|although|mas|porém|porem|contudo|só\s+que)(?![\p{L}\p{N}])/iu;

/**
 * What shows the person is saying what they want or accept, before a value counts: "This is high risk"
 * and "My income is good" have none, and state nothing.
 */
const MEANS_IT = word(
  'want|wants|wanna|need|needs|like|prefer|goal|objective|aim|aiming|looking|hoping|trying|for|to|make|keep|is\\s+(?:fine|ok|okay)|comfortable|accept|take|handle|quero|queria|gostaria|preciso|prefiro|busco|procuro|objetivo|meta|para|pra|fazer|manter|aceito|aceitar|tolero|topo|posso|confortável|confortavel|tudo\\s+bem',
);
/** "My risk tolerance is low" says whose it is in the words themselves. */
const OWN_LEVEL = word(
  "risk\\s+(?:tolerance|appetite|profile)|(?:tolerância|tolerancia|perfil)\\s+(?:a|ao|de)\\s+risco|(?:i\\s+am|i'm|sou|estou)\\s+(?:conservative|cautious|aggressive|conservador|conservadora|cauteloso|cautelosa|agressivo|agressiva|arrojado|arrojada)",
);
/** "My income" is what the person has, not what they want the money to do. */
const THEIRS_ALREADY = word('(?:my|our|meu|minha|nosso|nossa)\\s+(?:income|renda)');
/** Or the value stands by itself, with no more than these around it: "Growth, please." */
const COURTESY = new Set(
  'please yes yeah ok okay just only mainly and with at a the sim por favor só so apenas principalmente e com o um uma'.split(
    ' ',
  ),
);
/** Every other word a plain statement may hold. Any word outside it, and the piece states nothing. */
const FILLER = new Set(
  `i i'm im i'd id we my me our the a an this that it its it's is are be to for of with at on in and so
  want wants wanna need needs would like prefer looking hoping trying aim aiming goal objective after
  money savings capital portfolio plan vault investment investments funds cash please just only mainly
  really very over time long term level tolerance appetite profile fine ok okay good can take accept
  handle comfortable am yes yeah sure actually now then make keep some monthly every month regular
  steady should will go lets let's here as well also thanks thank you hi hello all main mine
  eu nós nos meu minha o os as um uma isso isto esse este essa esta é são ser para pra de do da com em
  no na e então entao quero queria gostaria preciso prefiro busco procuro objetivo meta dinheiro
  patrimônio patrimonio capital carteira plano cofre investimento investimentos por favor só so apenas
  principalmente muito tempo longo prazo nível nivel tolerância tolerancia perfil tudo bem posso aceito
  aceitar tolero topo correr assumir tomar estou confortável confortavel sim claro agora fazer manter
  algum alguma mensal todo mês mes que ele ela vai obrigado obrigada olá ola oi ao principal passive
  passiva sou verdade`
    .split(/\s+/)
    .filter(Boolean),
);

type Read<T> = { state: 'none' } | { state: 'withdrawn' } | { state: 'said'; value: T };

/** The values of one kind whose words are in the piece. */
function found<T extends string>(piece: string, words: Record<T, string>): T[] {
  return (Object.keys(words) as T[]).filter((value) => word(words[value]).test(piece));
}

function readPiece(text: string): { goal: Read<Goal>; risk: Read<Risk> } {
  const piece = text.replace(/’/g, "'").trim();
  const question = piece.endsWith('?') || QUESTION.test(piece);
  const body = piece.replace(/[?,:]+/g, ' ').trim();
  if (BARE_NO.test(body)) return { goal: { state: 'withdrawn' }, risk: { state: 'withdrawn' } };
  const goals = found(body, GOAL_WORDS);
  const risks = found(body, RISK_WORDS);
  const refused = question || NEGATION.test(body) || HESITATION.test(body);
  // What is left once the values are taken out is filler and nothing else: no other word, no digit.
  let rest = body;
  for (const words of [...Object.values(RISK_WORDS), ...Object.values(GOAL_WORDS)])
    rest = rest.replace(word(words, 'giu'), ' ');
  const tokens = rest
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  const plain = !/\p{N}/u.test(rest) && tokens.every((token) => FILLER.has(token));
  const meant = MEANS_IT.test(rest) || tokens.every((token) => COURTESY.has(token));
  const goal: Read<Goal> =
    goals.length === 0
      ? { state: 'none' }
      : refused || goals.length > 1
        ? { state: 'withdrawn' }
        : plain && meant && !THEIRS_ALREADY.test(body)
          ? { state: 'said', value: goals[0] as Goal }
          : { state: 'none' };
  const risk: Read<Risk> = !(risks.length > 0 || RISK_MENTION.test(body))
    ? { state: 'none' }
    : refused || risks.length > 1 || RELATIVE.test(body)
      ? { state: 'withdrawn' }
      : risks.length === 1 && plain && (meant || OWN_LEVEL.test(body))
        ? { state: 'said', value: risks[0] as Risk }
        : { state: 'none' };
  return { goal, risk };
}

/**
 * The goal and risk as the person's messages state them now, each null when they do not. Only the
 * person's messages are read, in order, piece by piece: a piece that states a value sets it, a piece
 * that refuses, questions or hedges about one withdraws it, and any other piece changes nothing. So
 * the latest statement wins, and "yes" to a question of the app's states nothing.
 */
export function statedPurpose(messages: VaultAgentRequest['messages']): VaultAgentStatedPurpose {
  let goal: Goal | null = null;
  let risk: Risk | null = null;
  for (const message of messages) {
    if (message.who !== 'person') continue;
    for (const piece of message.text.split(PIECES)) {
      if (!piece?.trim()) continue;
      const read = readPiece(piece);
      if (read.goal.state === 'said') goal = read.goal.value;
      else if (read.goal.state === 'withdrawn') goal = null;
      if (read.risk.state === 'said') risk = read.risk.value;
      else if (read.risk.state === 'withdrawn') risk = null;
    }
  }
  return { goal, risk };
}
