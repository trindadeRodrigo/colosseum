import type { Language, Reason } from '@colosseum/schemas';
import type { MarketFilterBy } from './market-filter';

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
//   goal, risk, sleeve, chain, candidate, by  the word for it, from WORDS
//   inCountry                                 in Brazil       no Brasil
//   regimes  times of the week, by their codes   at the weekend and on US holidays
//   list     names joined by commas            AAPL, MSFT and NVDA   AAPL, MSFT e NVDA
//            (no space after the comma that joins: a comma inside a name is followed by one)

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
  'mix',
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
  // What the person said they want held (gate EXPLICIT-MIX): it replaces the row of the table.
  MIX: rule(
    ['mix'],
    'You asked for {sleeveBps|pct} of the plan in {sleeve|sleeve}.',
    'Você pediu {sleeveBps|pct} do plano em {sleeve|sleeve}.',
  ),
  MIX_ALL: rule(
    ['mix'],
    'You asked for all of it in {sleeve|sleeve}.',
    'Você pediu tudo em {sleeve|sleeve}.',
  ),
  MIX_LIMITS: rule(
    ['mix'],
    'To hold {sleeveBps|pct} of the plan in stocks and crypto, the plan uses the limits for {risk|risk}: at most {stockCapBps|pct} in one stock or crypto asset, and {issuerCapBps|pct} with one issuer.',
    'Para ter {sleeveBps|pct} do plano em ações e cripto, o plano usa os limites de {risk|risk}: no máximo {stockCapBps|pct} em uma só ação ou cripto, e {issuerCapBps|pct} com um só emissor.',
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
  // A theme sleeve (gates SLEEVES, THEMES): equal shares of the names on a curated list.
  THEME_SLEEVE: rule(
    ['sleeves', 'themes', 'chain'],
    'You set {shareBps|pct} of the plan for the theme {theme}: equal shares of the names on its list for {chain|chain} that you can hold and that can be sold at this size, each up to its limit.',
    'Você destinou {shareBps|pct} do plano para o tema {theme}: partes iguais dos nomes da lista dele na {chain|chain} que você pode ter e que podem ser vendidos neste tamanho, cada um até o seu limite.',
  ),
  THEME_MEMBER: rule(
    ['themes', 'chain'],
    '{asset} is on the {theme} list for {chain|chain}, version {version}, kept by {curator}: {why}.',
    '{asset} está na lista {theme} da {chain|chain}, versão {version}, mantida por {curator}: {why}.',
  ),
  THEME_EASIEST: rule(
    ['themes'],
    '{theme} lists more names than this plan has parts left, so it holds the {count} easiest to sell: first the names whose exit is measured, by how much of each can be sold, then the others, by their tier.',
    '{theme} tem mais nomes do que as partes que restam neste plano, então fica com os {count} mais fáceis de vender: primeiro os nomes com saída medida, por quanto de cada um pode ser vendido, depois os outros, pela faixa.',
  ),
  THEME_HELD: rule(
    ['holdings', 'themes'],
    'Less {asset} in {theme}: of the {totalUsd|usd} of it you hold, {heldUsd|usd} counts here, so the theme buys it only up to the total of each of its other names.',
    'Menos {asset} em {theme}: dos {totalUsd|usd} que você tem desse ativo, {heldUsd|usd} contam aqui, então o tema compra só até o total de cada um dos outros nomes.',
  ),
  THEME_HELD_NONE: rule(
    ['holdings', 'themes'],
    'No {asset} in {theme}: of the {totalUsd|usd} of it you hold, {heldUsd|usd} counts here, as much as each of its other names holds.',
    'Sem {asset} em {theme}: dos {totalUsd|usd} que você tem desse ativo, {heldUsd|usd} contam aqui, tanto quanto cada um dos outros nomes.',
  ),
  // What the person holds, where a theme counted part of it first (gate THEME-FIRST).
  ALREADY_HELD_PART: rule(
    ['holdings', 'themes'],
    'Less {asset}: of the {totalUsd|usd} of it you hold, {heldUsd|usd} counts here; a theme you asked for counts the rest.',
    'Menos {asset}: dos {totalUsd|usd} que você tem desse ativo, {heldUsd|usd} contam aqui; um tema que você pediu conta o resto.',
  ),
  ALREADY_HELD_NONE_PART: rule(
    ['holdings', 'themes'],
    'No {asset}: of the {totalUsd|usd} of it you hold, {heldUsd|usd} counts here; a theme you asked for counts the rest.',
    'Sem {asset}: dos {totalUsd|usd} que você tem desse ativo, {heldUsd|usd} contam aqui; um tema que você pediu conta o resto.',
  ),
  MORE_BECAUSE_HELD_PART: rule(
    ['holdings', 'themes'],
    'A larger share here: of the {totalUsd|usd} of {asset} you hold, {heldUsd|usd} counts here, so this part buys less of it.',
    'Uma parcela maior aqui: dos {totalUsd|usd} de {asset} que você tem, {heldUsd|usd} contam aqui, então esta parte compra menos desse ativo.',
  ),
  OVERFLOW_HELD_PART: rule(
    ['holdings', 'themes'],
    '{usd|usd} this plan does not put in {assets|list} is held in dollar yield or cash instead: of the {totalUsd|usd} of it you hold, {heldUsd|usd} counts here.',
    '{usd|usd} que este plano não coloca em {assets|list} fica em rendimento em dólar ou caixa: dos {totalUsd|usd} que você tem desse ativo, {heldUsd|usd} contam aqui.',
  ),
  ISSUER_CAP_THEME: rule(
    ['risk', 'sleeves', 'themes'],
    'No more than {capBps|pct} of the plan with one issuer at {risk|risk}: {issuer} is at that limit, and the theme {themes|list} you asked for holds its share of it first.',
    'No máximo {capBps|pct} do plano com um só emissor, com {risk|risk}: {issuer} está nesse limite, e o tema {themes|list} que você pediu fica com a parte dele primeiro.',
  ),
  THEME_TOO_THIN: rule(
    ['amount', 'themes'],
    '{asset} is left out of {theme}: selling it at this size would cost too much, so it cannot take {minUsd|usd}, the least a part of your plan can be.',
    '{asset} fica de fora de {theme}: vender neste tamanho custaria caro demais, então ele não comporta {minUsd|usd}, o mínimo de uma parte do seu plano.',
  ),
  THEME_NO_LIST: rule(
    ['themes', 'chain'],
    'The theme {theme} holds no name: there is no list for it on {chain|chain}.',
    'O tema {theme} não tem nenhum nome: não há lista para ele na {chain|chain}.',
  ),
  THEME_NOT_CONFIRMED: rule(
    ['themes', 'chain'],
    'The theme {theme} holds no name: its list for {chain|chain} is proposed and not confirmed yet.',
    'O tema {theme} não tem nenhum nome: a lista dele na {chain|chain} foi proposta e ainda não foi confirmada.',
  ),
  // A matched theme (gate THEME-MATCHED): the sleeve holds the stocks whose sourced attributes carry
  // the value a filter names. Every line says it is matched, and by what: never a curated theme.
  THEME_MATCHED_SLEEVE: rule(
    ['sleeves', 'themes', 'chain'],
    'You set {shareBps|pct} of the plan for names matched by {by|by}: {value}. Matched from the sourced attributes of each, not a curated theme: equal shares of the ones you can hold on {chain|chain} and that can be sold at this size, each up to its limit.',
    'Você destinou {shareBps|pct} do plano para nomes filtrados por {by|by}: {value}. Filtrados pelos atributos de cada um, que têm fonte, e não por um tema com curadoria: partes iguais dos que você pode ter na {chain|chain} e que podem ser vendidos neste tamanho, cada um até o seu limite.',
  ),
  THEME_MATCHED_MEMBER: rule(
    ['themes', 'chain'],
    '{asset} is matched by {by|by}: {value} (attributes version {version}, read {readOn}), not from a curated theme: {why}.',
    '{asset} entra pelo filtro de {by|by}: {value} (atributos na versão {version}, lidos em {readOn}), e não por um tema com curadoria: {why}.',
  ),
  // The founder's wording of Oct 6, kept as written: the chain lists no stock that carries the value,
  // so the sleeve holds no name.
  THEME_NO_MATCH: rule(
    ['themes', 'chain'],
    'There is no stock for {theme} on {chain|chain} at the moment. We will be adding more soon.',
    'No momento não há nenhuma ação para {theme} na {chain|chain}. Vamos incluir mais em breve.',
  ),
  // No attributes were given for the chain: nothing can be said to match or not.
  THEME_NO_ATTRIBUTES: rule(
    ['themes', 'chain'],
    'Nothing is held for {theme}: the stocks of {chain|chain} have no sourced attributes to match by yet.',
    'Nada fica em {theme}: as ações da {chain|chain} ainda não têm atributos com fonte para filtrar.',
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
  SHARED_EVENLY: rule(
    ['chain'],
    'This plan spreads its dollar yield evenly instead of by yield: {assets|list} share this part equally, each up to its limit.',
    'Este plano distribui o rendimento em dólar por igual, e não pelo rendimento: {assets|list} dividem esta parte igualmente, cada um até o seu limite.',
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
  CREDIT_BUDGET_MIX: rule(
    ['mix'],
    'You asked for up to {capBps|pct} of the plan in tokens that lend to borrowers or trade a spread: those tokens together are at that limit.',
    'Você pediu até {capBps|pct} do plano em tokens que emprestam a tomadores ou operam uma diferença de taxas: esses tokens juntos estão nesse limite.',
  ),
  CREDIT_NONE_MIX: rule(
    ['mix'],
    '{asset} is left out: it lends to borrowers or trades a spread, and the mix you asked for holds none of those.',
    '{asset} fica de fora: ele empresta a tomadores ou opera uma diferença de taxas, e a composição que você pediu não tem nenhum desses.',
  ),
  CREDIT_NONE: rule(
    ['credit'],
    '{asset} is left out: it lends to borrowers or trades a spread, and you accept no credit risk.',
    '{asset} fica de fora: ele empresta a tomadores ou opera uma diferença de taxas, e você não aceita risco de crédito.',
  ),
  CREDIT_BUDGET_PLAN: rule(
    ['credit'],
    'This plan holds no more than {capBps|pct} in tokens that lend to borrowers or trade a spread, less than the credit risk you accept: those tokens together are at that limit.',
    'Este plano guarda no máximo {capBps|pct} em tokens que emprestam a tomadores ou operam uma diferença de taxas, menos do que o risco de crédito que você aceita: esses tokens juntos estão nesse limite.',
  ),
  CREDIT_NONE_PLAN: rule(
    ['credit'],
    '{asset} is left out: it lends to borrowers or trades a spread, and this plan holds none of those, whatever the credit risk you accept.',
    '{asset} fica de fora: ele empresta a tomadores ou opera uma diferença de taxas, e este plano não guarda nenhum desses, qualquer que seja o risco de crédito que você aceita.',
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
  OVERFLOW_ISSUER_THEME: rule(
    ['risk', 'sleeves', 'themes'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: no more than {capBps|pct} of the plan is with one issuer at {risk|risk}, {issuer} is at that limit, and the theme {themes|list} you asked for holds its share of it first.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: no máximo {capBps|pct} do plano fica com um só emissor, com {risk|risk}, {issuer} está nesse limite, e o tema {themes|list} que você pediu fica com a parte dele primeiro.',
  ),
  OVERFLOW_THEME_NO_LIST: rule(
    ['themes', 'chain'],
    '{usd|usd} meant for the theme {assets|list} is held in dollar yield or cash instead: there is no list for it on {chain|chain}.',
    '{usd|usd} que iria para o tema {assets|list} fica em rendimento em dólar ou caixa: não há lista para ele na {chain|chain}.',
  ),
  OVERFLOW_THEME_NOT_CONFIRMED: rule(
    ['themes', 'chain'],
    '{usd|usd} meant for the theme {assets|list} is held in dollar yield or cash instead: its list for {chain|chain} is not confirmed yet.',
    '{usd|usd} que iria para o tema {assets|list} fica em rendimento em dólar ou caixa: a lista dele na {chain|chain} ainda não foi confirmada.',
  ),
  OVERFLOW_THEME_NO_MATCH: rule(
    ['themes', 'chain'],
    '{usd|usd} meant for {theme} is held in dollar yield or cash instead: there is no stock for it on {chain|chain} at the moment.',
    '{usd|usd} que iria para {theme} fica em rendimento em dólar ou caixa: no momento não há nenhuma ação para isso na {chain|chain}.',
  ),
  OVERFLOW_THEME_NO_ATTRIBUTES: rule(
    ['themes', 'chain'],
    '{usd|usd} meant for {theme} is held in dollar yield or cash instead: the stocks of {chain|chain} have no sourced attributes to match by yet.',
    '{usd|usd} que iria para {theme} fica em rendimento em dólar ou caixa: as ações da {chain|chain} ainda não têm atributos com fonte para filtrar.',
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
  STATUS_NO_AMOUNT_CLOSES: {
    en: 'No larger amount pays every withdrawal, at the rates observed and under every stress, with what you can hold.',
    pt: 'Nenhum valor maior paga todos os saques, às taxas observadas e em cada cenário de estresse, com o que você pode ter.',
  },
  WAY_WITHDRAW_LESS: {
    en: 'You can withdraw {scaleBps|pct} of each amount you set.',
    pt: 'Você pode sacar {scaleBps|pct} de cada valor que definiu.',
  },
  CANDIDATE_SAME: {
    en: '{plan|candidate} is not shown: it differs from {other|candidate} by {distanceBps|pct} of the plan, under {distinctBps|pct}, so the two are one choice.',
    pt: '{plan|candidate} não aparece: ele difere de {other|candidate} em {distanceBps|pct} do plano, menos de {distinctBps|pct}, então os dois são uma só escolha.',
  },
  CANDIDATE_IDENTICAL: {
    en: '{plan|candidate} is not shown: it holds the same as {other|candidate}.',
    pt: '{plan|candidate} não aparece: ele guarda o mesmo que {other|candidate}.',
  },
  CANDIDATE_BREAKS_MIX: {
    en: '{plan|candidate} is not shown: it would hold {heldBps|pct} of the plan in {sleeve|sleeve}, which is not the mix you asked for.',
    pt: '{plan|candidate} não aparece: ele teria {heldBps|pct} do plano em {sleeve|sleeve}, o que não é a composição que você pediu.',
  },
  CANDIDATE_DOMINATED: {
    en: '{plan|candidate} is not shown: {other|candidate} is as good on every line of the comparison, and better on one.',
    pt: '{plan|candidate} não aparece: {other|candidate} é tão bom em todas as linhas da comparação, e melhor em uma.',
  },
  CANDIDATE_NO_LEAD: {
    en: '{plan|candidate} is not shown: it is ahead of the others on no line of the comparison.',
    pt: '{plan|candidate} não aparece: ele não fica à frente dos outros em nenhuma linha da comparação.',
  },
  NO_AMOUNT_CLOSES: {
    en: 'No larger amount closes the gap with the dollar-yield tokens you can hold.',
    pt: 'Nenhum valor maior fecha a diferença com os tokens de rendimento em dólar que você pode ter.',
  },
} as const satisfies Record<string, Text>;

export type TextId = keyof typeof TEXT_TEMPLATES;

type Words = Record<
  'goal' | 'risk' | 'sleeve' | 'chain' | 'inCountry' | 'regime' | 'candidate',
  Record<string, string>
> & {
  /** What a market filter reads (gate THEME-MATCHED), by its name. */
  by: Record<MarketFilterBy, string>;
  /** A stock's own fact about it, which its value follows: "its industry is Aerospace & Defense". */
  itsBy: Record<MarketFilterBy, string>;
  /** The same for a fund matched by a keyword, which says what it holds or is: "a fund described as gold". */
  fundIs: string;
  and: string;
};

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
    // The names of the three candidates (gates THREE-PLANS, CANDIDATE-NAMES, Rodrigo, Oct 6).
    candidate: { cover: 'Cover', spread: 'Spread', carry: 'Carry' },
    // What a matched theme was matched by, and the fact of a stock that puts it there.
    by: {
      sector: 'sector',
      industry: 'industry',
      sub_industry: 'sub-industry',
      keyword: 'keyword',
    },
    itsBy: {
      sector: 'its sector is',
      industry: 'its industry is',
      sub_industry: 'its sub-industry is',
      keyword: 'one of its business lines is',
    },
    fundIs: 'a fund described as',
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
    candidate: { cover: 'Cobertura', spread: 'Diversificação', carry: 'Rendimento' },
    by: {
      sector: 'setor',
      industry: 'indústria',
      sub_industry: 'subindústria',
      keyword: 'palavra-chave',
    },
    // "Dela": of the company.
    itsBy: {
      sector: 'o setor dela é',
      industry: 'a indústria dela é',
      sub_industry: 'a subindústria dela é',
      keyword: 'uma das linhas de negócio dela é',
    },
    fundIs: 'um fundo descrito como',
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

/**
 * A name as a list of names holds it (the `list` format). A list is joined by commas with no space
 * after them, so every comma inside a name is followed by one: "Technology Hardware, Storage &
 * Peripherals" stays one name. A name written from free text (a theme's, an attribute's value)
 * goes through this before it is put in a list.
 */
export const asListed = (name: string): string => name.replace(/,(?! )/g, ', ');

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
  // Names joined by commas, written as they came: "a, b and c". A comma followed by a space is part
  // of a name (`asListed`), not a join.
  list: (value, lang, key) => {
    const names = String(value).split(/,(?! )/);
    if (names.some((name) => name.trim() === ''))
      throw new Error(`template value ${key} must be a list of names`);
    return listed(names, lang);
  },
  by: (value, lang) => (WORDS[lang].by as Record<string, string>)[String(value)] ?? String(value),
  goal: (value, lang) => WORDS[lang].goal[String(value)] ?? String(value),
  risk: (value, lang) => WORDS[lang].risk[String(value)] ?? String(value),
  sleeve: (value, lang) => WORDS[lang].sleeve[String(value)] ?? String(value),
  chain: (value, lang) => WORDS[lang].chain[String(value)] ?? String(value),
  candidate: (value, lang) => WORDS[lang].candidate[String(value)] ?? String(value),
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
