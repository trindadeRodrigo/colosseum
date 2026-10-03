import type { Language, Reason } from '@colosseum/schemas';

// The wording of the personalization engine: one template per rule, in English and Portuguese,
// filled from the inputs. No model writes any of it. Rodrigo owns the wording, as he owns the
// parameter table. `templates.test.ts` bans what reads as advice or as a return promise.
//
// A value is written `{name}` (as it came) or `{name|format}`:
//   usd     whole dollars                     $4,000          US$ 4.000
//   pct     basis points as a percentage      14.32%          14,32%
//   month   a YYYY-MM month                   April 2028      abril de 2028
//   months  a count of months                 18 months       18 meses
//   goal, risk, sleeve, chain                 the word for it, from WORDS

/** The inputs a person gives. A reason names the ones that caused it. */
export const INPUT_NAMES = [
  'goal',
  'risk',
  'horizon',
  'amount',
  'themes',
  'holdings',
  'country',
  'chains',
  'cannotHold',
  'mustKeep',
  'mayNeed',
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

type Template = { inputs: readonly InputName[]; en: string; pt: string };
const rule = (inputs: InputName[], en: string, pt: string): Template => ({ inputs, en, pt });

export const REASON_TEMPLATES = {
  // Exposure: how big each sleeve is.
  SLEEVE: rule(
    ['goal', 'risk'],
    '{sleeveBps|pct} of the plan in {sleeve|sleeve}: {goal|goal}, at {risk|risk}.',
    '{sleeveBps|pct} do plano em {sleeve|sleeve}: {goal|goal}, com {risk|risk}.',
  ),
  GLIDE: rule(
    ['horizon'],
    'At least {floorBps|pct} in dollar yield: you need this money in {months|months}, by {by|month}.',
    'Pelo menos {floorBps|pct} em renda em dólar: você precisa deste dinheiro em {months|months}, até {by|month}.',
  ),
  CASH_NEAR_DATE: rule(
    ['horizon'],
    'At least {floorBps|pct} stays in cash: you need this money in {months|months}.',
    'Pelo menos {floorBps|pct} fica em caixa: você precisa deste dinheiro em {months|months}.',
  ),
  CASH_MAY_NEED: rule(
    ['mayNeed'],
    'At least {floorBps|pct} stays in cash: you may need money in {months|months}.',
    'Pelo menos {floorBps|pct} fica em caixa: você pode precisar de dinheiro em {months|months}.',
  ),
  MUST_KEEP: rule(
    ['mustKeep'],
    'At least {floorBps|pct} stays in dollar yield and cash, out of stocks, crypto and gold: you must not lose {keepUsd|usd}.',
    'Pelo menos {floorBps|pct} fica em renda em dólar e caixa, fora de ações, cripto e ouro: você não pode perder {keepUsd|usd}.',
  ),

  // Exposure: what is inside each sleeve.
  FROM_THEME: rule(
    ['themes'],
    'From {theme}, a shared portfolio you chose.',
    'De {theme}, um portfólio compartilhado que você escolheu.',
  ),
  SLEEVE_DEFAULT: rule(
    ['goal'],
    '{what}: where {goal|goal} starts when you choose no shared portfolio.',
    '{what}: de onde parte {goal|goal} quando você não escolhe um portfólio compartilhado.',
  ),
  FOLLOWS: rule(
    ['themes'],
    'Held in the weights {theme} publishes, so this part can follow its updates.',
    'Mantido nos pesos que {theme} publica, então esta parte pode acompanhar as atualizações.',
  ),
  OPENED: rule(
    ['themes'],
    '{theme} is held token by token here, in the weights of this plan, so this part does not follow its updates.',
    '{theme} entra aqui token por token, nos pesos deste plano, então esta parte não acompanha as atualizações.',
  ),
  ALREADY_HELD: rule(
    ['holdings'],
    'Less {asset}: you already hold {heldUsd|usd} of it.',
    'Menos {asset}: você já tem {heldUsd|usd}.',
  ),
  ALREADY_HELD_NONE: rule(
    ['holdings'],
    'No {asset}: you already hold {heldUsd|usd} of it.',
    'Sem {asset}: você já tem {heldUsd|usd}.',
  ),
  SINGLE_STOCK_CAP: rule(
    ['risk'],
    '{asset} is held to {capBps|pct} of the plan: the most in one stock or one crypto asset at {risk|risk}.',
    '{asset} fica limitado a {capBps|pct} do plano: o máximo em uma ação ou um criptoativo com {risk|risk}.',
  ),
  THEME_UNKNOWN: rule(
    ['themes'],
    '{theme} is left out: no shared portfolio has that name.',
    '{theme} fica de fora: nenhum portfólio compartilhado tem esse nome.',
  ),
  THEME_NOT_ON_YOUR_CHAINS: rule(
    ['chains', 'themes'],
    '{theme} is left out: it is not published on a chain you funded.',
    '{theme} fica de fora: não está publicado em nenhuma das suas redes.',
  ),

  // What a person cannot hold, and why.
  NOT_FOR_GOAL: rule(
    ['goal'],
    '{asset} is left out: the asset list does not allow it in a plan for {goal|goal}.',
    '{asset} fica de fora: a lista de ativos não o permite em um plano para {goal|goal}.',
  ),
  EXCLUDED: rule(
    ['cannotHold'],
    '{asset} is left out: you said you cannot hold it.',
    '{asset} fica de fora: você disse que não pode tê-lo.',
  ),
  NOT_IN_COUNTRY: rule(
    ['country'],
    '{asset} is left out: it is not offered in {country}.',
    '{asset} fica de fora: não é oferecido em {country}.',
  ),
  NOT_ON_YOUR_CHAINS: rule(
    ['chains'],
    '{asset} is left out: no chain you funded lists it.',
    '{asset} fica de fora: nenhuma das suas redes o lista.',
  ),

  // Placement: which chain's token carries each exposure.
  ON_CHAIN: rule(
    ['chains'],
    'On {chain|chain}: of the chains you funded, the first that lists it and has room.',
    'Em {chain|chain}: das suas redes, a primeira que o lista e tem espaço.',
  ),
  BY_YIELD: rule(
    [],
    'Chosen among the dollar-yield tokens you can hold by its yield after haircut.',
    'Escolhido entre os tokens de renda em dólar que você pode ter pelo rendimento após o desconto.',
  ),
  YIELD_NOT_READ: rule(
    [],
    'There is no yield reading for this token, so the plan counts none for it.',
    'Não há leitura de rendimento para este token, então o plano não conta nenhum para ele.',
  ),
  EXIT_CEILING: rule(
    ['amount'],
    '{asset} on {chain|chain} is limited to {maxUsd|usd}: beyond that, selling it would cost too much.',
    '{asset} em {chain|chain} fica limitado a {maxUsd|usd}: acima disso, vender custaria caro demais.',
  ),
  ISSUER_CAP: rule(
    ['risk'],
    'No more than {capBps|pct} of the plan with one issuer at {risk|risk}: {issuer} is at that limit.',
    'No máximo {capBps|pct} do plano com um emissor com {risk|risk}: {issuer} está nesse limite.',
  ),
  MAX_LINES: rule(
    ['themes'],
    '{asset} is left out on {chain|chain}: a plan holds at most {max} lines on one chain.',
    '{asset} fica de fora em {chain|chain}: um plano tem no máximo {max} linhas em uma rede.',
  ),
  BELOW_MINIMUM: rule(
    ['amount'],
    '{asset} is left out: {usd|usd} is too small to hold as a line.',
    '{asset} fica de fora: {usd|usd} é pequeno demais para ser uma linha.',
  ),
  OVERFLOW: rule(
    ['amount'],
    'Includes {usd|usd} that {asset} could not take at this size.',
    'Inclui {usd|usd} que {asset} não comporta neste tamanho.',
  ),

  // Cash.
  NO_DOLLAR_YIELD: rule(
    ['chains'],
    'No dollar-yield token you can hold is on a chain you funded, so {usd|usd} stays in cash.',
    'Nenhum token de renda em dólar que você pode ter está nas suas redes, então {usd|usd} fica em caixa.',
  ),
  UNPLACED: rule(
    ['amount'],
    '{usd|usd} stays in cash: no token you can hold has room for it at this size.',
    '{usd|usd} fica em caixa: nenhum token que você pode ter comporta esse valor neste tamanho.',
  ),
  ROUNDING: rule(
    ['amount'],
    '{usd|usd} stays in cash: targets are whole basis points, and no line may pass its limit.',
    '{usd|usd} fica em caixa: os alvos são pontos-base inteiros, e nenhuma linha pode passar do limite.',
  ),
  CASH_ON_CHAIN: rule(
    ['chains'],
    'The cash sits on {chain|chain}, the chain that holds the most of this plan.',
    'O caixa fica em {chain|chain}, a rede que concentra a maior parte deste plano.',
  ),

  // The card, line by line.
  NO_RETURN_ASSUMED: rule(
    [],
    'No return is assumed for this line. In a {fallBps|pct} fall it would lose {lossUsd|usd}.',
    'Nenhum retorno é presumido para esta linha. Em uma queda de {fallBps|pct}, ela perderia {lossUsd|usd}.',
  ),
} as const satisfies Record<string, Template>;

export type RuleId = keyof typeof REASON_TEMPLATES;

type Text = { en: string; pt: string };

/** The sentences of the card and of the verdict. */
export const TEXT_TEMPLATES = {
  RETURN_BASIS: {
    en: 'A yearly range on the dollar-yield part only: after haircut at the low end, as quoted at the high end. Rates change. No return is assumed for stocks, crypto and gold.',
    pt: 'Faixa anual só sobre a parte em renda em dólar: após o desconto no piso, como cotado no teto. As taxas mudam. Nenhum retorno é presumido para ações, cripto e ouro.',
  },
  RETURN_NOT_READ: {
    en: 'There is no yield reading for the dollar-yield part yet, so no figure is shown. No return is assumed for stocks, crypto and gold.',
    pt: 'Ainda não há leitura de rendimento para a parte em renda em dólar, então nenhum número é mostrado. Nenhum retorno é presumido para ações, cripto e ouro.',
  },
  RETURN_NONE: {
    en: 'This plan holds no dollar yield, and no return is assumed for stocks, crypto and gold.',
    pt: 'Este plano não tem renda em dólar, e nenhum retorno é presumido para ações, cripto e ouro.',
  },
  EXIT_MEASURED: {
    en: 'You can withdraw the tokens to your own wallet at any time. Selling everything in the worst hours measured would cost about {costBps|pct}; that is measured for {shareBps|pct} of the plan.',
    pt: 'Você pode sacar os tokens para a sua carteira a qualquer momento. Vender tudo nas piores horas medidas custaria cerca de {costBps|pct}; isso está medido para {shareBps|pct} do plano.',
  },
  EXIT_NOT_MEASURED: {
    en: 'You can withdraw the tokens to your own wallet at any time. The cost of selling is not measured for this plan yet.',
    pt: 'Você pode sacar os tokens para a sua carteira a qualquer momento. O custo de vender ainda não está medido para este plano.',
  },
  WAY_AMOUNT: {
    en: 'Put in {toUsd|usd} instead of {fromUsd|usd}.',
    pt: 'Aplicar {toUsd|usd} em vez de {fromUsd|usd}.',
  },
  WAY_TARGET: {
    en: 'Aim for {toUsd|usd} a month instead of {fromUsd|usd}.',
    pt: 'Mirar {toUsd|usd} por mês em vez de {fromUsd|usd}.',
  },
} as const satisfies Record<string, Text>;

export type TextId = keyof typeof TEXT_TEMPLATES;

type Words = Record<'goal' | 'risk' | 'sleeve' | 'chain', Record<string, string>>;

export const WORDS: Record<Language, Words> = {
  en: {
    goal: { grow: 'a goal to grow', income: 'a goal of income', protect: 'a goal to protect' },
    risk: { low: 'low risk', medium: 'medium risk', high: 'high risk' },
    sleeve: {
      growth: 'stocks and crypto',
      dollarYield: 'dollar yield',
      gold: 'gold',
      cash: 'cash',
    },
    chain: { solana: 'Solana', robinhood: 'Robinhood Chain', base: 'Base' },
  },
  pt: {
    goal: {
      grow: 'um objetivo de crescer',
      income: 'um objetivo de renda',
      protect: 'um objetivo de proteger',
    },
    risk: { low: 'risco baixo', medium: 'risco médio', high: 'risco alto' },
    sleeve: {
      growth: 'ações e cripto',
      dollarYield: 'renda em dólar',
      gold: 'ouro',
      cash: 'caixa',
    },
    chain: { solana: 'Solana', robinhood: 'Robinhood Chain', base: 'Base' },
  },
};

const MONTHS: Record<Language, string[]> = {
  en: 'January February March April May June July August September October November December'.split(
    ' ',
  ),
  pt: 'janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro'.split(
    ' ',
  ),
};

type Value = string | number;

/** Digits in threes: 1250000 is 1,250,000 in English and 1.250.000 in Portuguese. */
const grouped = (whole: number, lang: Language) =>
  String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'pt' ? '.' : ',');

const number = (value: Value, key: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`template value ${key} must be a number`);
  return value;
};

const FORMATS: Record<string, (value: Value, lang: Language, key: string) => string> = {
  usd: (value, lang, key) => {
    const whole = grouped(Math.round(number(value, key)), lang);
    return lang === 'pt' ? `US$ ${whole}` : `$${whole}`;
  },
  pct: (value, lang, key) => {
    // Basis points over a hundred, with no trailing zeros: 8000 is 80, 1432 is 14.32.
    const text = String(Math.round(number(value, key)) / 100);
    return `${lang === 'pt' ? text.replace('.', ',') : text}%`;
  },
  month: (value, lang, key) => {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value));
    const name = match ? MONTHS[lang][Number(match[2]) - 1] : undefined;
    if (!match || !name) throw new Error(`template value ${key} must be a YYYY-MM month`);
    return lang === 'pt' ? `${name} de ${match[1]}` : `${name} ${match[1]}`;
  },
  months: (value, lang, key) => {
    const count = number(value, key);
    const unit = lang === 'pt' ? (count === 1 ? 'mês' : 'meses') : count === 1 ? 'month' : 'months';
    return `${count} ${unit}`;
  },
  goal: (value, lang) => WORDS[lang].goal[String(value)] ?? String(value),
  risk: (value, lang) => WORDS[lang].risk[String(value)] ?? String(value),
  sleeve: (value, lang) => WORDS[lang].sleeve[String(value)] ?? String(value),
  chain: (value, lang) => WORDS[lang].chain[String(value)] ?? String(value),
};

const PLACEHOLDER = /\{(\w+)(?:\|(\w+))?\}/g;

/** The values a template takes, with the format each is written in ('' for as it came). */
export function placeholdersOf(template: string): { key: string; format: string }[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => ({ key: m[1] ?? '', format: m[2] ?? '' }));
}

/** A template with its values written in. A value that is missing is an error, never a blank. */
export function render(template: string, params: Record<string, Value>, lang: Language): string {
  return template.replace(PLACEHOLDER, (_, key: string, format: string | undefined) => {
    const value = params[key];
    if (value === undefined) throw new Error(`template value ${key} is missing`);
    if (!format) return String(value);
    const write = FORMATS[format];
    if (!write) throw new Error(`no template format called ${format}`);
    return write(value, lang, key);
  });
}

/** A reason: the rule, the inputs it names, the values, and the text in the person's language. */
export function reason(id: RuleId, params: Record<string, Value>, lang: Language): Reason {
  const template = REASON_TEMPLATES[id];
  return {
    rule: id,
    inputs: [...template.inputs],
    params,
    text: render(template[lang], params, lang),
  };
}

/** A sentence of the card or of the verdict. */
export function text(id: TextId, params: Record<string, Value>, lang: Language): string {
  return render(TEXT_TEMPLATES[id][lang], params, lang);
}
