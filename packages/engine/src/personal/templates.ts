import type { Language, Reason } from '@colosseum/schemas';

// The wording of the personalization engine: one template per rule, in English and Portuguese,
// filled from the inputs. No model writes any of it. Rodrigo owns the wording, as he owns the
// parameter table. `templates.test.ts` bans what reads as advice or as a return promise.
//
// A value is written `{name}` (as it came) or `{name|format}`:
//   usd     dollars, cents under one          $4,000  $0.40   US$ 4.000  US$ 0,40
//   usdUp   the same, rounded up (a loss)     $229            US$ 229
//   amount  any currency, cents if any        3,000  2,500.50 3.000  2.500,50
//   pct     basis points as a percentage      14.32%          14,32%
//   month   a YYYY-MM month                   April 2028      abril de 2028
//   months  a count of months                 18 months       18 meses
//   goal, risk, sleeve, chain                 the word for it, from WORDS
//   inCountry                                 in Brazil       no Brasil
//   regimes  times of the week, by their codes   at the weekend and on US holidays
//   list     names joined by commas            AAPL, MSFT and NVDA   AAPL, MSFT e NVDA

/** The inputs a person gives. A reason names the ones that caused it. */
export const INPUT_NAMES = [
  'goal',
  'risk',
  'horizon',
  'amount',
  'themes',
  'holdings',
  'country',
  'chain',
  'cannotHold',
  'mustKeep',
  'mayNeed',
  'credit',
  'sleeves',
  'currency',
  'obligations',
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

type Template = { inputs: readonly InputName[]; en: string; pt: string };
const rule = (inputs: InputName[], en: string, pt: string): Template => ({ inputs, en, pt });

export const REASON_TEMPLATES = {
  // Exposure: how big each sleeve is.
  SLEEVE: rule(
    ['goal', 'risk'],
    'For {goal|goal} at {risk|risk}, the starting share of {sleeve|sleeve} is {sleeveBps|pct}.',
    'Para {goal|goal}, com {risk|risk}, a parcela inicial de {sleeve|sleeve} é {sleeveBps|pct}.',
  ),
  // The person's split of the plan (gate SLEEVES).
  SPLIT_GOAL: rule(
    ['sleeves', 'goal'],
    'You set {shareBps|pct} of the plan for {goal|goal}; the shares here are of the whole plan.',
    'Você destinou {shareBps|pct} do plano para {goal|goal}; as parcelas aqui são do plano inteiro.',
  ),
  SPLIT_SAFE_YIELD: rule(
    ['sleeves'],
    'You set {shareBps|pct} of the plan apart for dollar yield from a rate alone: tokens that pass through a government or money-market rate, with no lending to borrowers and no trading spread.',
    'Você separou {shareBps|pct} do plano para rendimento em dólar só de taxa: tokens que repassam uma taxa de governo ou de mercado monetário, sem empréstimo a tomadores e sem spread de negociação.',
  ),
  SAFE_YIELD_NO_RATE: rule(
    ['sleeves', 'chain'],
    'No token you can hold on {chain|chain} pays a rate alone, so {usd|usd} of the part you set apart for it stays in cash.',
    'Nenhum token que você pode ter na {chain|chain} paga só uma taxa, então {usd|usd} da parte separada para isso fica em caixa.',
  ),
  // A goal in a currency other than dollars.
  FX_OPEN: rule(
    ['currency'],
    'This line is not counted in {currency}, the currency of your goal: its value in {currency} moves with the exchange rate.',
    'Esta linha não é contada em {currency}, a moeda da sua meta: o valor dela em {currency} muda com o câmbio.',
  ),
  // Withdrawals: what is set aside for the next months of them (slice 2).
  SET_ASIDE: rule(
    ['obligations'],
    '{usd|usd} of the plan is set aside for your withdrawals from {from|month} to {to|month}, the next {months|months} of them; this line holds some or all of it.',
    '{usd|usd} do plano ficam separados para os seus saques de {from|month} a {to|month}, os próximos {months|months}; esta linha guarda parte ou todo esse valor.',
  ),
  WITHDRAWAL: rule(
    ['obligations'],
    'You withdraw {amount|amount} {currency} in {month|month}.',
    'Você saca {amount|amount} {currency} em {month|month}.',
  ),
  SET_ASIDE_SHORT: rule(
    ['obligations', 'amount'],
    'Your withdrawals from {from|month} to {to|month} come to {owedUsd|usd}, more than the {goalUsd|usd} of the plan kept for your goal: all of it is set aside, and {shortUsd|usd} of them is not covered.',
    'Os seus saques de {from|month} a {to|month} somam {owedUsd|usd}, mais do que os {goalUsd|usd} do plano destinados à sua meta: tudo isso fica separado, e {shortUsd|usd} deles não está coberto.',
  ),
  SET_ASIDE_CASH: rule(
    ['obligations', 'chain'],
    '{usd|usd} of what is set aside for your withdrawals stays in cash: no token on {chain|chain} that pays a rate alone has room for it.',
    '{usd|usd} do que fica separado para os seus saques fica em caixa: nenhum token na {chain|chain} que paga só uma taxa comporta esse valor.',
  ),
  NO_MATCHING_LEG: rule(
    ['currency', 'obligations', 'chain'],
    'No token you can hold on {chain|chain} is counted in {currency}, so {usd|usd} set aside for your withdrawals in {currency} stays in dollar cash.',
    'Nenhum token que você pode ter na {chain|chain} é contado em {currency}, então {usd|usd} separados para os seus saques em {currency} ficam em caixa em dólar.',
  ),
  // The coverage check: what can be sold in time pays the withdrawals of the next months.
  COVERAGE_MOVED: rule(
    ['obligations'],
    '{usd|usd} of this line is held in cash instead: by {month|month}, {assets|list} can be sold for {sellUsd|usd} after the cost of selling, and your withdrawals to then come to more than that and the cash.',
    '{usd|usd} desta linha ficam em caixa: até {month|month}, {assets|list} podem ser vendidos por {sellUsd|usd} depois do custo de venda, e os seus saques até lá somam mais do que isso e o caixa.',
  ),
  COVERAGE_MOVED_UNCOUNTED: rule(
    ['obligations'],
    '{usd|usd} of this line is held in cash instead: what is set aside cannot be sold in time for all of your withdrawals to {month|month}, and a withdrawal is not paid by selling stocks, crypto or gold.',
    '{usd|usd} desta linha ficam em caixa: o que está separado não pode ser vendido a tempo para todos os seus saques até {month|month}, e um saque não é pago vendendo ações, cripto ou ouro.',
  ),
  COVERAGE_CASH: rule(
    ['obligations'],
    '{usd|usd} is held in cash so that your withdrawals to {month|month} can be paid in time: the tokens of the plan cannot all be sold by then at a cost within the limit.',
    '{usd|usd} ficam em caixa para que os seus saques até {month|month} possam ser pagos a tempo: os tokens do plano não podem ser todos vendidos até lá com um custo dentro do limite.',
  ),
  COVERAGE_SHORT: rule(
    ['obligations', 'amount'],
    'Your withdrawals to {month|month} come to {owedUsd|usd}; this plan can pay {paidUsd|usd} of them in time.',
    'Os seus saques até {month|month} somam {owedUsd|usd}; este plano consegue pagar {paidUsd|usd} deles a tempo.',
  ),
  // The date sets a floor on dollar yield. What dollar yield has no room for stays in cash, so the
  // sentence names both: it is true of every plan, whatever the chain lists and whatever is capped.
  GLIDE: rule(
    ['horizon'],
    'At least {floorBps|pct} is kept out of stocks, crypto and gold, in dollar yield or cash: you need this money in {months|months}, by {by|month}.',
    'Pelo menos {floorBps|pct} fica fora de ações, cripto e ouro, em rendimento em dólar ou caixa: você precisa deste dinheiro em {months|months}, até {by|month}.',
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
    'Pelo menos {floorBps|pct} fica em rendimento em dólar e caixa, fora de ações, cripto e ouro: você não pode perder {keepUsd|usd}.',
  ),

  // Exposure: what is inside each sleeve.
  FROM_THEME: rule(
    ['themes', 'chain'],
    'From {theme}, a shared portfolio you chose, in its version for {chain|chain}.',
    'De {theme}, um portfólio compartilhado que você escolheu, na versão para a {chain|chain}.',
  ),
  SLEEVE_DEFAULT: rule(
    ['goal'],
    '{what}: where {goal|goal} starts when you choose no shared portfolio.',
    '{what}: de onde parte {goal|goal} quando você não escolhe um portfólio compartilhado.',
  ),
  SLEEVE_FILLED: rule(
    ['themes'],
    '{what} holds the {sleeve|sleeve} share of this plan: no shared portfolio you chose fills it.',
    '{what} fica com a parcela de {sleeve|sleeve} deste plano: nenhum portfólio compartilhado que você escolheu preenche essa parcela.',
  ),
  FOLLOWS: rule(
    ['themes'],
    'Held in the weights {theme} publishes, so this part of your plan can follow its updates.',
    'Mantido nos pesos que {theme} publica, então esta parte do seu plano pode acompanhar as atualizações.',
  ),
  OPENED: rule(
    ['themes'],
    '{theme} is held token by token here, in the weights of this plan, so this part of your plan does not follow its updates.',
    '{theme} entra aqui token por token, nos pesos deste plano, então esta parte do seu plano não acompanha as atualizações.',
  ),
  NOT_WHOLE_PARTS: rule(
    ['themes'],
    '{theme} cannot be held whole: a plan holds at most {max} parts, and it would make {would}.',
    '{theme} não cabe inteiro: um plano tem no máximo {max} partes, e ele faria {would}.',
  ),
  NOT_WHOLE_CEILING: rule(
    ['amount'],
    '{theme} cannot be held whole: {asset} takes at most {maxUsd|usd}.',
    '{theme} não cabe inteiro: {asset} comporta no máximo {maxUsd|usd}.',
  ),
  NOT_WHOLE_ISSUER_PLAN: rule(
    [],
    '{theme} cannot be held whole: more than {capBps|pct} of the plan would be with {issuer}, the most with one issuer.',
    '{theme} não cabe inteiro: mais de {capBps|pct} do plano ficaria com {issuer}, o máximo com um só emissor.',
  ),
  NOT_WHOLE_ISSUER: rule(
    ['risk'],
    '{theme} cannot be held whole: more than {capBps|pct} of the plan would be with {issuer}, the most with one issuer at {risk|risk}.',
    '{theme} não cabe inteiro: mais de {capBps|pct} do plano ficaria com {issuer}, o máximo com um só emissor com {risk|risk}.',
  ),
  NOT_WHOLE_SMALL: rule(
    ['amount'],
    '{theme} cannot be held whole: {asset} would be {usd|usd}, too small to be a part of your plan.',
    '{theme} não cabe inteiro: {asset} seria {usd|usd}, pequeno demais para ser uma parte do seu plano.',
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
  MORE_BECAUSE_HELD: rule(
    ['holdings'],
    'A larger share here: you already hold {heldUsd|usd} of {asset}, so this plan buys less of it.',
    'Uma parcela maior aqui: você já tem {heldUsd|usd} de {asset}, então este plano compra menos desse ativo.',
  ),
  SINGLE_STOCK_CAP: rule(
    ['risk'],
    '{asset} is held to {capBps|pct} of the plan: the most in one stock or one crypto asset at {risk|risk}.',
    '{asset} fica limitado a {capBps|pct} do plano: o máximo em uma só ação ou cripto com {risk|risk}.',
  ),
  THEME_UNKNOWN: rule(
    ['themes'],
    '{theme} is left out: no shared portfolio has that name.',
    '{theme} fica de fora: nenhum portfólio compartilhado tem esse nome.',
  ),
  THEME_NOT_ON_CHAIN: rule(
    ['chain', 'themes'],
    '{theme} is left out: it has no version on {chain|chain}.',
    '{theme} fica de fora: não tem versão na {chain|chain}.',
  ),

  THEME_NOT_FOR_GOAL: rule(
    ['goal', 'themes'],
    '{theme} is left out: it holds {asset}, and the asset list does not allow {asset} in a plan for {goal|goal}.',
    '{theme} fica de fora: tem {asset}, e a lista de ativos não permite {asset} em um plano para {goal|goal}.',
  ),

  // What a person cannot hold, and why.
  NOT_FOR_GOAL: rule(
    ['goal'],
    '{asset} is left out: the asset list does not allow it in a plan for {goal|goal}.',
    '{asset} fica de fora: a lista de ativos não permite esse ativo em um plano para {goal|goal}.',
  ),
  EXCLUDED: rule(
    ['cannotHold'],
    '{asset} is left out: you said you cannot hold it.',
    '{asset} fica de fora: você disse que não pode ter esse ativo.',
  ),
  NOT_ON_CHAIN: rule(
    ['chain'],
    '{asset} is left out: {chain|chain} does not list it.',
    '{asset} fica de fora: a {chain|chain} não tem esse ativo.',
  ),

  // Placement: which token carries each exposure, on the person's chain.
  BY_YIELD: rule(
    ['chain'],
    'Chosen by its yield after haircut, among the dollar-yield tokens you can hold on {chain|chain}.',
    'Escolhido pelo rendimento após o deságio, entre os tokens de rendimento em dólar que você pode ter na {chain|chain}.',
  ),
  NO_YIELD: rule(
    [],
    '{asset} is left out: there is no yield reading for it, and the plan never counts a missing yield as zero.',
    '{asset} fica de fora: não há leitura de rendimento para ele, e o plano nunca conta um rendimento ausente como zero.',
  ),
  NO_LEG_TYPE: rule(
    [],
    '{asset} is left out: what kind of yield it pays is not on the asset list yet.',
    '{asset} fica de fora: o tipo de rendimento que ele paga ainda não está na lista de ativos.',
  ),
  SHARED_IN_BAND: rule(
    [],
    'Yields after haircut that differ by {bandBps|pct} or less count as equal, so {assets|list} share this part equally, each up to its limit.',
    'Rendimentos após o deságio que diferem em {bandBps|pct} ou menos contam como iguais, então {assets|list} dividem esta parte igualmente, cada um até o seu limite.',
  ),
  ASSET_CAP: rule(
    ['amount'],
    '{asset} takes at most {capBps|pct} of the plan, {maxUsd|usd}: the limit for one token of its kind.',
    '{asset} comporta no máximo {capBps|pct} do plano, {maxUsd|usd}: o limite para um token desse tipo.',
  ),
  ISSUER_CAP_PLAN: rule(
    [],
    'No more than {capBps|pct} of the plan with one issuer: {issuer} is at that limit.',
    'No máximo {capBps|pct} do plano com um só emissor: {issuer} está nesse limite.',
  ),
  CREDIT_BUDGET: rule(
    ['credit'],
    'No more than {capBps|pct} of the plan in tokens that lend to borrowers or trade a spread, at the credit risk you accept: those tokens together are at that limit.',
    'No máximo {capBps|pct} do plano em tokens que emprestam a tomadores ou operam uma diferença de taxas, com o risco de crédito que você aceita: esses tokens juntos estão nesse limite.',
  ),
  CREDIT_NONE: rule(
    ['credit'],
    '{asset} is left out: it lends to borrowers or trades a spread, and you accept no credit risk.',
    '{asset} fica de fora: ele empresta a tomadores ou opera uma diferença de taxas, e você não aceita risco de crédito.',
  ),
  CREDIT_BUDGET_UNSAID: rule(
    [],
    'No more than {capBps|pct} of the plan in tokens that lend to borrowers or trade a spread: you have not said how much credit risk you accept, and this is the limit until you do. Those tokens together are at that limit.',
    'No máximo {capBps|pct} do plano em tokens que emprestam a tomadores ou operam uma diferença de taxas: você não disse quanto risco de crédito aceita, e este é o limite até dizer. Esses tokens juntos estão nesse limite.',
  ),
  EXIT_CEILING: rule(
    ['amount'],
    '{asset} is limited to {maxUsd|usd}: beyond that, selling it would cost too much.',
    '{asset} fica limitado a {maxUsd|usd}: acima disso, vender custaria caro demais.',
  ),
  TIER_CEILING: rule(
    ['amount'],
    '{asset} takes at most {maxUsd|usd}: what selling it costs is not measured yet, so the limit is the one for its tier on the asset list.',
    '{asset} comporta no máximo {maxUsd|usd}: o custo de vender ainda não está medido, então o limite é o da faixa dele na lista de ativos.',
  ),
  EXIT_PARTLY_MEASURED: rule(
    [],
    'The limit for {asset} comes from part of the week only: selling it {when|regimes} is not measured, and may cost more.',
    'O limite de {asset} vem de só uma parte da semana: a venda {when|regimes} não está medida, e pode custar mais.',
  ),
  ISSUER_CAP: rule(
    ['risk'],
    'No more than {capBps|pct} of the plan with one issuer at {risk|risk}: {issuer} is at that limit.',
    'No máximo {capBps|pct} do plano com um só emissor, com {risk|risk}: {issuer} está nesse limite.',
  ),
  MAX_LINES: rule(
    ['themes'],
    '{asset} is left out: a plan holds at most {max} parts.',
    '{asset} fica de fora: um plano tem no máximo {max} partes.',
  ),
  BELOW_MINIMUM: rule(
    ['amount'],
    '{asset} is left out: {usd|usd} is too small to be a part of your plan.',
    '{asset} fica de fora: {usd|usd} é pequeno demais para ser uma parte do seu plano.',
  ),

  // Money meant for something this plan could not hold, or not in full: where it is held instead, and
  // what kept it out. One sentence for each cause: `placement.ts` picks it by the rule that did. It is
  // said on the dollar-yield line that took it in and, where dollar yield had no room, on the cash line.
  OVERFLOW_CEILING: rule(
    ['amount'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: {asset} takes at most {maxUsd|usd}.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: {asset} comporta no máximo {maxUsd|usd}.',
  ),
  OVERFLOW_ISSUER: rule(
    ['risk'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: no more than {capBps|pct} of the plan is with one issuer at {risk|risk}, and {issuer} is at that limit.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: no máximo {capBps|pct} do plano fica com um só emissor, com {risk|risk}, e {issuer} está nesse limite.',
  ),
  OVERFLOW_ISSUER_PLAN: rule(
    [],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: no more than {capBps|pct} of the plan is with one issuer, and {issuer} is at that limit.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: no máximo {capBps|pct} do plano fica com um só emissor, e {issuer} está nesse limite.',
  ),
  OVERFLOW_STOCK_CAP: rule(
    ['risk'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: no more than {capBps|pct} of the plan is in one stock or one crypto asset at {risk|risk}.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: no máximo {capBps|pct} do plano fica em uma só ação ou cripto, com {risk|risk}.',
  ),
  OVERFLOW_MAX_LINES: rule(
    ['themes'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: a plan holds at most {max} parts.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: um plano tem no máximo {max} partes.',
  ),
  OVERFLOW_TOO_SMALL: rule(
    ['amount'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: it is too small to be a part of your plan.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: é pequeno demais para ser uma parte do seu plano.',
  ),
  OVERFLOW_NOT_ON_CHAIN: rule(
    ['chain'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: {chain|chain} does not list it.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: a {chain|chain} não tem esse ativo.',
  ),
  OVERFLOW_EXCLUDED: rule(
    ['cannotHold'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: you said you cannot hold it.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: você disse que não pode ter esse ativo.',
  ),
  OVERFLOW_NOT_FOR_GOAL: rule(
    ['goal'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: the asset list does not allow it in a plan for {goal|goal}.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: a lista de ativos não permite esse ativo em um plano para {goal|goal}.',
  ),
  OVERFLOW_HELD: rule(
    ['holdings'],
    '{usd|usd} this plan does not put in {assets|list} is held in dollar yield or cash instead: you already hold {heldUsd|usd} of it.',
    '{usd|usd} que este plano não coloca em {assets|list} fica em rendimento em dólar ou caixa: você já tem {heldUsd|usd} desse ativo.',
  ),

  // Cash.
  YIELD_TOO_SMALL: rule(
    ['amount'],
    '{usd|usd} meant for dollar yield stays in cash: it is too small to be a part of your plan.',
    '{usd|usd} que iria para rendimento em dólar fica em caixa: é pequeno demais para ser uma parte do seu plano.',
  ),
  NO_DOLLAR_YIELD: rule(
    ['chain'],
    'No dollar-yield token you can hold is on {chain|chain}, so {usd|usd} stays in cash.',
    'Nenhum token de rendimento em dólar que você pode ter está na {chain|chain}, então {usd|usd} fica em caixa.',
  ),
  UNPLACED: rule(
    ['amount'],
    '{usd|usd} stays in cash: no token you can hold has room for it at this size.',
    '{usd|usd} fica em caixa: nenhum token que você pode ter comporta esse valor neste tamanho.',
  ),
  ROUNDING: rule(
    ['amount'],
    '{bps|pct} stays in cash: targets are whole basis points, and {asset} may not pass its limit.',
    '{bps|pct} fica em caixa: os alvos são pontos-base inteiros, e {asset} não pode passar do limite.',
  ),

  // The card, line by line.
  NO_RETURN_ASSUMED: rule(
    [],
    'No return is assumed for this part of your plan. In a {fallBps|pct} fall it would lose {lossUsd|usdUp}.',
    'Nenhum retorno é presumido para esta parte do seu plano. Em uma queda de {fallBps|pct}, ela perderia {lossUsd|usdUp}.',
  ),
} as const satisfies Record<string, Template>;

export type RuleId = keyof typeof REASON_TEMPLATES;

type Text = { en: string; pt: string };

/** The sentences of the card and of the verdict. */
export const TEXT_TEMPLATES = {
  RETURN_BASIS: {
    en: 'A yearly range for the dollar-yield part only. The low end is its yield after haircut; the high end is its quoted yield. Rates change. No return is assumed for stocks, crypto and gold.',
    pt: 'Faixa anual, só para a parte em rendimento em dólar. O piso é o rendimento após o deságio; o teto é o rendimento cotado. As taxas mudam. Nenhum retorno é presumido para ações, cripto e ouro.',
  },
  RETURN_NOT_READ: {
    en: 'There is no yield reading for the dollar-yield part yet, so no figure is shown. No return is assumed for stocks, crypto and gold.',
    pt: 'Ainda não há leitura de rendimento para a parte em rendimento em dólar, então nenhum número é mostrado. Nenhum retorno é presumido para ações, cripto e ouro.',
  },
  RETURN_NONE: {
    en: 'This plan holds no dollar yield, and no return is assumed for stocks, crypto and gold.',
    pt: 'Este plano não tem rendimento em dólar, e nenhum retorno é presumido para ações, cripto e ouro.',
  },
  EXIT_MEASURED: {
    en: 'You can withdraw the tokens to your own wallet at any time. Selling everything in the worst hours measured would cost about {costBps|pct}; that is measured for {shareBps|pct} of the plan.',
    pt: 'Você pode sacar os tokens para a sua carteira a qualquer momento. Vender tudo nas piores horas medidas custaria cerca de {costBps|pct}; isso está medido para {shareBps|pct} do plano.',
  },
  EXIT_MEASURED_ZERO: {
    en: 'You can withdraw the tokens to your own wallet at any time. In the worst hours measured, selling everything cost nothing: the sale price was at or above the reference price. That is measured for {shareBps|pct} of the plan.',
    pt: 'Você pode sacar os tokens para a sua carteira a qualquer momento. Nas piores horas medidas, vender tudo não custou nada: o preço de venda ficou igual ou acima do preço de referência. Isso está medido para {shareBps|pct} do plano.',
  },
  EXIT_NOT_MEASURED: {
    en: 'You can withdraw the tokens to your own wallet at any time. The cost of selling is not measured for this plan yet.',
    pt: 'Você pode sacar os tokens para a sua carteira a qualquer momento. O custo de vender ainda não está medido para este plano.',
  },
  WAY_AMOUNT: {
    en: 'You can add {addUsd|usd}, for {toUsd|usd} in all.',
    pt: 'Você pode aplicar mais {addUsd|usd}, {toUsd|usd} no total.',
  },
  WAY_TARGET: {
    en: 'You can aim for {toUsd|usd} a month instead of {fromUsd|usd}.',
    pt: 'Você pode mirar {toUsd|usd} por mês em vez de {fromUsd|usd}.',
  },
  NO_AMOUNT_CLOSES: {
    en: 'No larger amount closes the gap with the dollar-yield tokens you can hold.',
    pt: 'Nenhum valor maior fecha a diferença com os tokens de rendimento em dólar que você pode ter.',
  },
} as const satisfies Record<string, Text>;

export type TextId = keyof typeof TEXT_TEMPLATES;

type Words = Record<
  'goal' | 'risk' | 'sleeve' | 'chain' | 'inCountry' | 'regime',
  Record<string, string>
> & { and: string };

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
    // The times of the week the risk layer measures apart, in the order they are written.
    regime: {
      us_market_hours: 'in US market hours',
      us_offhours_weekday: 'on weekdays outside US market hours',
      weekend: 'at the weekend',
      us_holiday: 'on US holidays',
    },
    and: 'and',
    // A country by its name. One this list does not hold is written by its code.
    inCountry: {
      AE: 'in the United Arab Emirates',
      AR: 'in Argentina',
      AU: 'in Australia',
      BR: 'in Brazil',
      CA: 'in Canada',
      CH: 'in Switzerland',
      CL: 'in Chile',
      CO: 'in Colombia',
      DE: 'in Germany',
      ES: 'in Spain',
      FR: 'in France',
      GB: 'in the United Kingdom',
      IE: 'in Ireland',
      IT: 'in Italy',
      JP: 'in Japan',
      MX: 'in Mexico',
      NL: 'in the Netherlands',
      PE: 'in Peru',
      PT: 'in Portugal',
      PY: 'in Paraguay',
      SG: 'in Singapore',
      US: 'in the United States',
      UY: 'in Uruguay',
    },
  },
  pt: {
    goal: {
      grow: 'um objetivo de crescimento',
      income: 'um objetivo de renda',
      protect: 'um objetivo de proteção',
    },
    risk: { low: 'risco baixo', medium: 'risco médio', high: 'risco alto' },
    // "Rendimento em dólar", not "renda em dólar": "renda" is the income goal.
    sleeve: {
      growth: 'ações e cripto',
      dollarYield: 'rendimento em dólar',
      gold: 'ouro',
      cash: 'caixa',
    },
    chain: { solana: 'Solana', robinhood: 'Robinhood Chain', base: 'Base' },
    regime: {
      us_market_hours: 'no horário do mercado dos EUA',
      us_offhours_weekday: 'em dias úteis fora do horário do mercado dos EUA',
      weekend: 'no fim de semana',
      us_holiday: 'em feriados dos EUA',
    },
    and: 'e',
    inCountry: {
      AE: 'nos Emirados Árabes Unidos',
      AR: 'na Argentina',
      AU: 'na Austrália',
      BR: 'no Brasil',
      CA: 'no Canadá',
      CH: 'na Suíça',
      CL: 'no Chile',
      CO: 'na Colômbia',
      DE: 'na Alemanha',
      ES: 'na Espanha',
      FR: 'na França',
      GB: 'no Reino Unido',
      IE: 'na Irlanda',
      IT: 'na Itália',
      JP: 'no Japão',
      MX: 'no México',
      NL: 'nos Países Baixos',
      PE: 'no Peru',
      PT: 'em Portugal',
      PY: 'no Paraguai',
      SG: 'em Singapura',
      US: 'nos Estados Unidos',
      UY: 'no Uruguai',
    },
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

const CENTS = 100;

/**
 * Dollars: whole above a dollar, with cents under one, so a small amount is never written as zero.
 * `up` rounds away from zero-cost: a loss or a cost is never written smaller than it is.
 */
function dollars(amount: number, lang: Language, up: boolean): string {
  const round = up ? Math.ceil : Math.round;
  const cents = round(amount * CENTS);
  const small = cents > 0 && cents < CENTS;
  const digits = small
    ? `0${lang === 'pt' ? ',' : '.'}${String(cents).padStart(2, '0')}`
    : grouped(up ? Math.ceil(cents / CENTS) : Math.round(amount), lang);
  return lang === 'pt' ? `US$ ${digits}` : `$${digits}`;
}

/** "a", "a and b", "a, b and c". */
const listed = (words: string[], lang: Language): string =>
  words.length > 1
    ? `${words.slice(0, -1).join(', ')} ${WORDS[lang].and} ${words.at(-1)}`
    : (words[0] ?? '');

const FORMATS: Record<string, (value: Value, lang: Language, key: string) => string> = {
  usd: (value, lang, key) => dollars(number(value, key), lang, false),
  // An amount in any currency, as the person gave it: digits in threes, cents only when there are.
  amount: (value, lang, key) => {
    const cents = Math.round(number(value, key) * CENTS);
    const whole = grouped(Math.floor(cents / CENTS), lang);
    const part = cents % CENTS;
    return part === 0
      ? whole
      : `${whole}${lang === 'pt' ? ',' : '.'}${String(part).padStart(2, '0')}`;
  },
  usdUp: (value, lang, key) => dollars(number(value, key), lang, true),
  inCountry: (value, lang) =>
    WORDS[lang].inCountry[String(value)] ?? `${lang === 'pt' ? 'em' : 'in'} ${value}`,
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
  // Codes joined by commas, written in the order of the list above: "a, b and c".
  regimes: (value, lang, key) => {
    const given = String(value).split(',');
    const known = Object.keys(WORDS[lang].regime).filter((code) => given.includes(code));
    if (known.length === 0 || known.length !== given.length)
      throw new Error(`template value ${key} must be times of the week`);
    return listed(
      known.map((code) => WORDS[lang].regime[code] ?? code),
      lang,
    );
  },
  // Names joined by commas, written as they came: "a, b and c".
  list: (value, lang, key) => {
    const names = String(value).split(',');
    if (names.some((name) => name.trim() === ''))
      throw new Error(`template value ${key} must be a list of names`);
    return listed(names, lang);
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
    if (value === undefined || value === '') throw new Error(`template value ${key} is missing`);
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

// ---------------------------------------------------------------------------------------------------
// The guided intake (gate GUIDED-INTAKE, ENG-3 slice 4). Kept in a block of its own.
//
// The questions the intake asks, one per field the text leaves open or unclear, and the read-back the
// person confirms. A model chooses none of these words: it says which fields it could not read, and
// code picks the question; the read-back is drawn from the validated sheet. Rodrigo owns the wording.

/** One question per field of the sheet the person may be asked about. */
export const QUESTION_TEMPLATES = {
  goal: {
    en: 'What is this money for: to grow it, to earn an income from it, or to protect it?',
    pt: 'Para que é este dinheiro: fazer crescer, ter uma renda ou proteger?',
  },
  amountUsd: {
    en: 'How much do you put in, in dollars?',
    pt: 'Quanto você aplica, em dólares?',
  },
  amountOtherCurrency: {
    en: 'You wrote {amount|amount} {currency}. How much is that in dollars, the currency the plan is funded in?',
    pt: 'Você escreveu {amount|amount} {currency}. Quanto é isso em dólares, a moeda em que o plano é aplicado?',
  },
  // A date, never a number "the tool needs": no date is an answer too (gate GLIDE-OPT-IN, Oct 6).
  horizonMonths: {
    en: 'Is there a date by which you need this money? If not, say so and the plan has none.',
    pt: 'Existe uma data em que você precisa deste dinheiro? Se não, diga e o plano fica sem data.',
  },
  risk: {
    en: 'How much risk can you take: low, medium or high?',
    pt: 'Quanto risco você aceita: baixo, médio ou alto?',
  },
  // With a part kept safe, the risk is the other part's: one risk for the whole plan is never asked.
  riskGoalPart: {
    en: 'For the part that seeks a return, how much risk can you take: low, medium or high?',
    pt: 'Para a parte que busca retorno, quanto risco você aceita: baixo, médio ou alto?',
  },
  sleeves: {
    en: 'How do you want to split the money: how much kept safe and easy to take out, and how much to seek a return?',
    pt: 'Como você quer dividir o dinheiro: quanto fica seguro e fácil de tirar, e quanto busca retorno?',
  },
  sleevesMismatch: {
    en: 'You wrote {pct}% and the other half, which come to more than the whole. Which split do you mean: {pct}% and {rest}%, or half and half?',
    pt: 'Você escreveu {pct}% e a outra metade, o que passa do total. Qual divisão você quer: {pct}% e {rest}%, ou metade e metade?',
  },
  incomeTargetUsdMonthly: {
    en: 'How much income a month, in dollars, do you aim for?',
    pt: 'Quanto de renda por mês, em dólares, você busca?',
  },
  // Always asked when not given, with its reason (Oct 6).
  country: {
    en: "Some assets aren't offered in every country, and some can't be offered to people in certain countries. Where do you live?",
    pt: 'Alguns ativos não são oferecidos em todos os países, e alguns não podem ser oferecidos a quem mora em certos países. Onde você mora?',
  },
  themes: {
    en: 'Which shared portfolio, if any, do you want to start from?',
    pt: 'De qual portfólio compartilhado você quer partir, se de algum?',
  },
  currency: {
    en: 'In which currency do you count this goal?',
    pt: 'Em que moeda você conta este objetivo?',
  },
  chains: {
    en: 'Pick the chain your plans live on first: a plan is made on the chain of your wallet.',
    pt: 'Escolha antes a rede em que seus planos ficam: um plano é feito na rede da sua carteira.',
  },
} as const satisfies Record<string, Text>;
export type QuestionId = keyof typeof QUESTION_TEMPLATES;

/** The sentences of the read-back, each filled from the validated sheet and nothing else. */
export const READBACK_TEMPLATES = {
  GOAL: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You set {goal|goal} with ${amount|amount} over {months|months}, at {risk|risk}.',
    pt: 'Você definiu {goal|goal} com US$ {amount|amount} em {months|months}, com {risk|risk}.',
  },
  // A goal with no date (gate GLIDE-OPT-IN, Oct 6): the months the plan is built over are not said.
  GOAL_OPEN: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You set {goal|goal} with ${amount|amount}, with no date set, at {risk|risk}.',
    pt: 'Você definiu {goal|goal} com US$ {amount|amount}, sem data definida, com {risk|risk}.',
  },
  INCOME: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You aim for ${income|amount} a month of income.',
    pt: 'Você busca US$ {income|amount} por mês de renda.',
  },
  CURRENCY: {
    en: 'The goal is counted in {currency}.',
    pt: 'O objetivo é contado em {currency}.',
  },
  THEMES: {
    en: 'The plan starts from {themes|list}.',
    pt: 'O plano parte de {themes|list}.',
  },
  COUNTRY: {
    en: 'You live {country|inCountry}.',
    pt: 'Você mora {country|inCountry}.',
  },
  CHAIN: {
    en: 'The plan lives on {chain|chain}, the chain of your wallet.',
    pt: 'O plano fica na rede {chain|chain}, a rede da sua carteira.',
  },
  HOLDINGS_ON: {
    en: 'Tokens you already hold count toward the plan.',
    pt: 'Os tokens que você já tem contam para o plano.',
  },
  HOLDINGS_OFF: {
    en: 'Tokens you already hold are not counted.',
    pt: 'Os tokens que você já tem não são contados.',
  },
  GLIDE_ON: {
    en: 'As the date nears, more of the plan is kept in dollar yield and cash.',
    pt: 'Conforme a data se aproxima, mais do plano fica em rendimento em dólar e caixa.',
  },
  NO_CREDIT: {
    en: 'No tokens that lend to borrowers or trade a spread.',
    pt: 'Nenhum token que empresta a tomadores ou opera um spread.',
  },
  CANNOT_HOLD: {
    en: 'You left out {classes|list}.',
    pt: 'Você deixou de fora {classes|list}.',
  },
  MUST_KEEP: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'At least ${amount|amount} stays out of stocks, crypto and gold.',
    pt: 'Pelo menos US$ {amount|amount} fica fora de ações, cripto e ouro.',
  },
  MAY_NEED: {
    en: 'You may need the money in {months|months}.',
    pt: 'Você pode precisar do dinheiro em {months|months}.',
  },
  CANNOT_HOLD_NAMES: {
    en: 'You left out {names|list}.',
    pt: 'Você deixou de fora {names|list}.',
  },
  CREDIT_LIMITED: {
    en: 'Only a limited share in tokens that lend to borrowers or trade a spread.',
    pt: 'Só uma parcela limitada em tokens que emprestam a tomadores ou operam um spread.',
  },
  CREDIT_ACCEPT: {
    en: 'You accept tokens that lend to borrowers or trade a spread.',
    pt: 'Você aceita tokens que emprestam a tomadores ou operam um spread.',
  },
  OBLIGATION: {
    en: 'A withdrawal of {amount|amount} {currency} in {month|month}.',
    pt: 'Um saque de {amount|amount} {currency} em {month|month}.',
  },
  SLEEVE_GOAL: {
    en: '{share|pct} of the plan for the goal.',
    pt: '{share|pct} do plano para o objetivo.',
  },
  SLEEVE_SAFE_YIELD: {
    en: '{share|pct} of the plan for dollar yield from a rate alone.',
    pt: '{share|pct} do plano para rendimento em dólar só de taxa.',
  },
  // The plan has one risk, and with a part kept safe it is the risk of the rest (Oct 6).
  SLEEVE_RISK: {
    en: 'The {risk|risk} is for the part that seeks the goal. The part kept safe holds dollar yield from a rate alone, or cash, whatever the risk.',
    pt: 'O {risk|risk} vale para a parte que busca o objetivo. A parte guardada fica em rendimento em dólar só de taxa, ou em caixa, qualquer que seja o risco.',
  },
  SLEEVE_THEME: {
    en: '{share|pct} of the plan for the theme {theme}.',
    pt: '{share|pct} do plano para o tema {theme}.',
  },
  RESTORE_ON: {
    en: 'A part of the plan that has grown is brought back to its share.',
    pt: 'Uma parte do plano que cresceu é trazida de volta à sua parcela.',
  },
  RESTORE_OFF: {
    en: 'A part of the plan that has grown is left as it grew.',
    pt: 'Uma parte do plano que cresceu fica como cresceu.',
  },
  CONFIRM: {
    en: 'If this is right, confirm it and the plan is made from it.',
    pt: 'Se estiver certo, confirme e o plano é feito a partir disso.',
  },
} as const satisfies Record<string, Text>;
export type ReadBackId = keyof typeof READBACK_TEMPLATES;

/**
 * What the intake assumed, said with the read-back so the person can correct it (Oct 6). `words` is
 * the person's own words, as written, from the fixed lists of intake-text.ts.
 */
export const ASSUMPTION_TEMPLATES = {
  RISK_WORDS: {
    en: 'I took “{words}” as {risk|risk}.',
    pt: 'Entendi “{words}” como {risk|risk}.',
  },
  RISK_WORDS_PART: {
    en: 'I took “{words}” as {risk|risk} for the {share|pct} that seeks the goal.',
    pt: 'Entendi “{words}” como {risk|risk} para os {share|pct} que buscam o objetivo.',
  },
  OPEN_ENDED: {
    en: 'I took “{words}” as no date for the goal.',
    pt: 'Entendi “{words}” como objetivo sem data.',
  },
  EXIT_TIME: {
    en: 'I read “{words}” as how long you can wait to get money out, not as a date for the goal.',
    pt: 'Li “{words}” como o tempo que você pode esperar para tirar o dinheiro, não como uma data para o objetivo.',
  },
  GLIDE_OFFER: {
    en: 'Nothing moves toward cash as the date nears unless you ask for it.',
    pt: 'Nada vai para caixa conforme a data se aproxima, a menos que você peça.',
  },
  MAX_YIELD_LATER: {
    en: 'A part that seeks the highest yield is not built yet, so the part that seeks the goal is built as a goal to grow.',
    pt: 'Uma parte que busca o maior rendimento ainda não existe, então a parte que busca o objetivo é feita como um objetivo de crescimento.',
  },
} as const satisfies Record<string, Text>;
export type AssumptionId = keyof typeof ASSUMPTION_TEMPLATES;

/** The classes a person can leave out, as the read-back writes them. */
export const CLASS_WORDS: Record<Language, Record<string, string>> = {
  en: {
    stock: 'stocks',
    etf: 'funds',
    gold: 'gold',
    commodity: 'commodities',
    dollar_yield: 'dollar yield',
    crypto: 'crypto',
  },
  pt: {
    stock: 'ações',
    etf: 'fundos',
    gold: 'ouro',
    commodity: 'commodities',
    dollar_yield: 'rendimento em dólar',
    crypto: 'cripto',
  },
};
