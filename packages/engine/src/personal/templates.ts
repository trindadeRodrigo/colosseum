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
//   part     one of the person's sleeves: goal, safe_yield, or theme:<slug>
//   regimes  times of the week, by their codes   at the weekend and on US holidays
//   raisers  what raised a mix's limits, by code  what you already hold   o que você já tem
//   steps    how many risks up                    one step up     um nível acima
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
  'chain',
  'cannotHold',
  'mustKeep',
  'mayNeed',
  'credit',
  'sleeves',
  'currency',
  'obligations',
  'restoreSplit',
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
  // A mix whose weights were chosen outside the engine (gate ANY-COMPOSITION, Oct 8): what each
  // line says, and what the person is warned of and confirms before it is bought or applied.
  MIX_FROM_MODEL: rule(
    ['mix'],
    '{asset} at {weightBps|pct}: proposed in your conversation, and confirmed by you.',
    '{asset} com {weightBps|pct}: proposto na sua conversa, e confirmado por você.',
  ),
  MIX_FROM_PERSON: rule(
    ['mix'],
    'You chose {weightBps|pct} for {asset}.',
    'Você escolheu {weightBps|pct} para {asset}.',
  ),
  MIX_OVER_EXIT: rule(
    ['mix', 'amount'],
    '{asset} at {usd|usd} is more than {maxUsd|usd}, the part of its measured exit a plan counts on: selling all of it could cost more than planned.',
    '{asset} com {usd|usd} passa de {maxUsd|usd}, a parte da saída medida com que um plano conta: vender tudo pode custar mais que o previsto.',
  ),
  MIX_OVER_EXIT_UNSOURCED: rule(
    ['mix', 'amount'],
    '{asset} at {usd|usd} is more than the part of its exit a plan counts on. That measurement names no source, so its limit is not stated.',
    '{asset} com {usd|usd} passa da parte da saída com que um plano conta. Essa medida não tem fonte, então o limite não é informado.',
  ),
  MIX_OVER_TIER: rule(
    ['mix', 'amount'],
    '{asset} at {usd|usd} is more than {maxUsd|usd}, the limit for its tier on the asset list. What selling it costs is not measured yet.',
    '{asset} com {usd|usd} passa de {maxUsd|usd}, o limite da faixa dele na lista de ativos. O custo de vender ainda não está medido.',
  ),
  MIX_OVER_LISTED: rule(
    ['mix'],
    '{asset} at {weightBps|pct} weighs more than {maxBps|pct}, its cap on the asset list.',
    '{asset} com {weightBps|pct} pesa mais que {maxBps|pct}, o teto dele na lista de ativos.',
  ),
  MIX_NOT_FOR_GOAL: rule(
    ['mix', 'goal'],
    '{asset} is in the mix you chose. The asset list does not put it in a plan for {goal|goal}: it can fall in value.',
    '{asset} está na divisão que você escolheu. A lista de ativos não o coloca em um plano para {goal|goal}: ele pode perder valor.',
  ),
  MIX_STOPS_FOLLOWING: rule(
    ['mix'],
    'Your own targets replace the shared portfolio this vault follows, and auto-follow goes off.',
    'As suas metas substituem a carteira compartilhada que este cofre segue, e o acompanhamento automático é desligado.',
  ),
  // The limits a read-back could state are the ones the mix takes on its own. Where the plan takes
  // higher ones for what else the person's sheet carries, it says so, and names what raised them.
  MIX_LIMITS_RAISED: rule(
    ['mix'],
    'On its own, this mix takes the limits for {alone|risk}. Because of {by|raisers}, the plan uses the limits {steps|steps}, for {risk|risk}: at lower limits it would hold less in stocks and crypto.',
    'Sozinha, esta composição usa os limites de {alone|risk}. Por causa de {by|raisers}, o plano usa os limites {steps|steps}, de {risk|risk}: com limites mais baixos ele teria menos em ações e cripto.',
  ),
  // The cents a mix's shares leave over, each written in whole cents, where the mix has no cash.
  MIX_ODD_CENTS: rule(
    ['amount', 'mix'],
    '{usd|usd} is left over once each share of your mix is written in whole cents, and stays in cash.',
    '{usd|usd} sobram quando cada parcela da sua composição é escrita em centavos inteiros, e ficam em caixa.',
  ),
  // Withdrawals come before the mix: what the next months owe is set aside first. Said on the lines
  // of each class of the mix that holds less for it, and on the lines that hold what is set aside.
  MIX_SET_ASIDE: rule(
    ['obligations', 'mix'],
    '{usd|usd} of the {askedBps|pct} you asked for in {sleeve|sleeve} is set aside for your withdrawals from {from|month} to {to|month} instead, which leaves {leftBps|pct} of the plan for {sleeve|sleeve}: what your withdrawals need in those months is set aside before the mix is held.',
    '{usd|usd} dos {askedBps|pct} que você pediu em {sleeve|sleeve} ficam separados para os seus saques de {from|month} a {to|month}, o que deixa {leftBps|pct} do plano para {sleeve|sleeve}: o que os seus saques precisam nesses meses fica separado antes de a composição ser montada.',
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
    '{theme} cannot be held whole: {scope|lines} at most {max} parts, and it would make {would}.',
    '{theme} não cabe inteiro: {scope|lines} no máximo {max} partes, e ele faria {would}.',
  ),
  NOT_WHOLE_CEILING: rule(
    ['amount'],
    '{theme} cannot be held whole: {asset} takes at most {maxUsd|usd}.',
    '{theme} não cabe inteiro: {asset} comporta no máximo {maxUsd|usd}.',
  ),
  NOT_WHOLE_ISSUER_PLAN: rule(
    [],
    '{theme} cannot be held whole: more than {capBps|pct} of the plan would be in dollar yield, gold and other currencies with {issuer}, the most of those with one issuer.',
    '{theme} não cabe inteiro: mais de {capBps|pct} do plano ficaria em rendimento em dólar, ouro e outras moedas com {issuer}, o máximo desses com um só emissor.',
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
    'No more than {capBps|pct} of the plan in dollar yield, gold and other currencies with one issuer: {issuer} is at that limit.',
    'No máximo {capBps|pct} do plano em rendimento em dólar, ouro e outras moedas com um só emissor: {issuer} está nesse limite.',
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
    '{asset} is left out: {scope|lines} at most {max} parts.',
    '{asset} fica de fora: {scope|lines} no máximo {max} partes.',
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
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: no more than {capBps|pct} of the plan is in dollar yield, gold and other currencies with one issuer, and {issuer} is at that limit.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: no máximo {capBps|pct} do plano fica em rendimento em dólar, ouro e outras moedas com um só emissor, e {issuer} está nesse limite.',
  ),
  OVERFLOW_STOCK_CAP: rule(
    ['risk'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: no more than {capBps|pct} of the plan is in one stock or one crypto asset at {risk|risk}.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: no máximo {capBps|pct} do plano fica em uma só ação ou cripto, com {risk|risk}.',
  ),
  OVERFLOW_MAX_LINES: rule(
    ['themes'],
    '{usd|usd} meant for {assets|list} is held in dollar yield or cash instead: {scope|lines} at most {max} parts.',
    '{usd|usd} que iria para {assets|list} fica em rendimento em dólar ou caixa: {scope|lines} no máximo {max} partes.',
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

  // Rebalancing, sleeve by sleeve (slice 4): proposals the person taps; nothing is sent for them.
  REBALANCE_DRIFT: rule(
    ['sleeves'],
    'In the {part|part}, the holdings are {driftBps|pct} away from their targets, at or over the {bandBps|pct} at which a rebalance is proposed: these trades bring them back.',
    'Na {part|part}, as posições estão {driftBps|pct} longe dos alvos, no limite de {bandBps|pct} a partir do qual um rebalanceamento é proposto, ou acima: estas operações as trazem de volta.',
  ),
  REBALANCE_DEPOSIT: rule(
    ['amount', 'sleeves'],
    '{usd|usd} of new money goes into the {part|part}, to what is under its targets first.',
    '{usd|usd} de dinheiro novo vão para a {part|part}, primeiro para o que está abaixo dos alvos.',
  ),
  REBALANCE_WITHDRAWAL: rule(
    ['amount', 'sleeves'],
    '{usd|usd} of what you withdraw comes out of the {part|part}, from what is over its targets first.',
    '{usd|usd} do que você saca saem da {part|part}, primeiro do que está acima dos alvos.',
  ),
  SAFE_YIELD_SWITCH: rule(
    ['sleeves'],
    'In the {part|part}, {from} moves to {to}: on each of the last {days} days of readings, {to} yielded more than {from} after haircut, by over {bandBps|pct} a year.',
    'Na {part|part}, {from} passa para {to}: em cada um dos últimos {days} dias de leituras, {to} rendeu mais que {from} após o deságio, por mais de {bandBps|pct} ao ano.',
  ),
  SAFE_YIELD_SWITCH_CAPPED: rule(
    ['sleeves'],
    '{usd|usd} stays in {from}: {to} may hold at most {capBps|pct} of the plan.',
    '{usd|usd} ficam em {from}: {to} pode ter no máximo {capBps|pct} do plano.',
  ),
  SAFE_YIELD_SWITCH_ISSUER: rule(
    ['sleeves'],
    '{usd|usd} stays in {from}: {issuer} may hold at most {capBps|pct} of the plan.',
    '{usd|usd} ficam em {from}: {issuer} pode ter no máximo {capBps|pct} do plano.',
  ),
  SAFE_YIELD_SWITCH_EXIT: rule(
    ['sleeves', 'amount'],
    '{usd|usd} stays in {from}: past {ceilingUsd|usd} in {to}, selling it would cost more than {tauBps|pct}, as measured.',
    '{usd|usd} ficam em {from}: acima de {ceilingUsd|usd} em {to}, vender custaria mais de {tauBps|pct}, pelo que foi medido.',
  ),
  SAFE_YIELD_SWITCH_TIER: rule(
    ['sleeves', 'amount'],
    '{usd|usd} stays in {from}: the cost of selling {to} is not measured, so it takes at most {ceilingUsd|usd}, the limit of its tier on the asset list, a fallback.',
    '{usd|usd} ficam em {from}: o custo de vender {to} não está medido, então ele recebe no máximo {ceilingUsd|usd}, o limite da faixa dele na lista de ativos, um substituto provisório.',
  ),
  SWITCH_MOCK: rule(
    ['sleeves'],
    'MOCK: the yield readings this switch is decided on are not live readings.',
    'MOCK: as leituras de rendimento em que esta troca se baseia não são leituras ao vivo.',
  ),
  SWITCH_SANDBOX: rule(
    ['sleeves'],
    'Test network: the yield readings this switch is decided on come from a test network, not live readings.',
    'Rede de teste: as leituras de rendimento em que esta troca se baseia vêm de uma rede de teste, não são leituras ao vivo.',
  ),
  SET_ASIDE_REFILL: rule(
    ['obligations'],
    'Your withdrawals from {from|month} to {to|month} come to {owedUsd|usd}, and the cash and rate legs of the {part|part} hold {heldUsd|usd}: {shortUsd|usd} is moved to cash to set them aside again.',
    'Os seus saques de {from|month} a {to|month} somam {owedUsd|usd}, e o caixa e os tokens só de taxa da {part|part} guardam {heldUsd|usd}: {shortUsd|usd} vão para o caixa para separá-los de novo.',
  ),
  RESTORE_SPLIT: rule(
    ['restoreSplit', 'sleeves'],
    'You chose to bring each part of your plan back to its share. The parts are {driftBps|pct} away from the shares you set, at or over {bandBps|pct}: these trades restore them.',
    'Você escolheu trazer cada parte do seu plano de volta à sua parcela. As partes estão {driftBps|pct} longe das parcelas que você definiu, no limite de {bandBps|pct} ou acima: estas operações as restauram.',
  ),
  LIQUIDITY_BREACH: rule(
    ['obligations'],
    'Selling in time for your withdrawals from {first|month} may fall {shortfallUsd|usdUp} short when markets are thin, so these sales to cash come first, and every other rebalance waits until they are done.',
    'Vender a tempo para os seus saques a partir de {first|month} pode ficar {shortfallUsd|usdUp} abaixo do necessário quando o mercado está raso, então estas vendas para caixa vêm primeiro, e qualquer outro rebalanceamento espera até elas terminarem.',
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
    en: '{plan|candidate} is not shown: it would hold {heldBps|pct} of the plan in {sleeve|sleeve}, where the plan for the mix you asked for holds {mixBps|pct}.',
    pt: '{plan|candidate} não aparece: ele teria {heldBps|pct} do plano em {sleeve|sleeve}, e o plano para a composição que você pediu tem {mixBps|pct}.',
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
  | 'goal'
  | 'risk'
  | 'sleeve'
  | 'chain'
  | 'regime'
  | 'candidate'
  | 'part'
  | 'raiser'
  | 'steps'
  | 'lines',
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
    // One of the person's sleeves, as a rebalance names it; a theme's slug is written after it.
    part: {
      goal: 'part of your plan for your goal',
      safe_yield: 'part of your plan in dollar yield from a rate alone',
      theme: 'part of your plan for the theme',
    },
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
    // What a person adds to a mix that can raise the limits its plan takes, in the order written.
    raiser: {
      withdrawals: 'what is set aside for your withdrawals',
      holdings: 'what you already hold',
      cannotHold: 'what you cannot hold',
      limits: 'your other limits',
      date: 'your date',
    },
    steps: { 1: 'one step up', 2: 'two steps up' },
    // What the limit on lines counts (gate LINES-PER-SET): the plan, or each of its two sets.
    lines: {
      plan: 'a plan holds',
      set: 'stocks and crypto, and the rest of the plan, each hold',
    },
    and: 'and',
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
    part: {
      goal: 'parte do seu plano para a sua meta',
      safe_yield: 'parte do seu plano em rendimento em dólar só de taxa',
      theme: 'parte do seu plano para o tema',
    },
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
    raiser: {
      withdrawals: 'o que fica separado para os seus saques',
      holdings: 'o que você já tem',
      cannotHold: 'o que você não pode ter',
      limits: 'os seus outros limites',
      date: 'a sua data',
    },
    steps: { 1: 'um nível acima', 2: 'dois níveis acima' },
    lines: {
      plan: 'um plano tem',
      set: 'as ações e cripto, e o resto do plano, têm cada um',
    },
    and: 'e',
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
  years: (value, lang, key) => {
    const count = number(value, key);
    const unit = lang === 'pt' ? (count === 1 ? 'ano' : 'anos') : count === 1 ? 'year' : 'years';
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
  // What raised a mix's limits, by code, written in the order of the list above: "a, b and c".
  raisers: (value, lang, key) => {
    const given = String(value).split(',');
    const known = Object.keys(WORDS[lang].raiser).filter((code) => given.includes(code));
    if (known.length === 0 || known.length !== given.length)
      throw new Error(`template value ${key} must be what raised the limits`);
    return listed(
      known.map((code) => WORDS[lang].raiser[code] ?? code),
      lang,
    );
  },
  // What the limit on lines counts: `plan` or `set`, and no other.
  lines: (value, lang, key) => {
    const words = WORDS[lang].lines[String(value)];
    if (!words) throw new Error(`template value ${key} must be plan or set`);
    return words;
  },
  // How many risks above: a count the table of words has, and no other.
  steps: (value, lang, key) => {
    const words = WORDS[lang].steps[String(number(value, key))];
    if (!words) throw new Error(`template value ${key} must be a number of steps`);
    return words;
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
  // A sleeve by its kind, or `theme:<slug>` for a theme sleeve.
  part: (value, lang) => {
    const [kind = '', ...slug] = String(value).split(':');
    const word = WORDS[lang].part[kind];
    if (!word) return String(value);
    return slug.length > 0 ? `${word} ${slug.join(':')}` : word;
  },
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
  // A mix with stocks on a goal of income or to protect (gates EXPLICIT-MIX, PROTECT-NO-STOCKS): asked
  // once, as the one choice that changes the plan.
  goalMixConflict: {
    en: 'You set {goal|goal} and wrote “{words}”, but a plan for income or to protect holds no stocks or crypto. Do you mean a goal to grow, or the plan with no stocks?',
    pt: 'Você definiu {goal|goal} e escreveu “{words}”, mas um plano de renda ou de proteção não tem ações nem cripto. Você quer um objetivo de crescimento, ou o plano sem ações?',
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
  // What is held, asked once in place of the risk (gate EXPLICIT-MIX): a holding the person may mean
  // and the text does not state ("Should I put all of it in stocks?", or a mix the model reads that the
  // text's words cannot confirm) and, by the two after it, a market named with no share of the money
  // said ("I like big tech").
  // A refusal one reader read and the other did not confirm (the third review, Oct 7): asked once.
  limits: {
    en: 'Do you want to leave out {classes|list}?',
    pt: 'Você quer deixar de fora {classes|list}?',
  },
  mix: {
    en: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
    pt: 'Como você quer o dinheiro: quanto em ações e cripto, e quanto em caixa?',
  },
  marketShare: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'How much of the ${amount|amount} for {market}?',
    pt: 'Quanto dos US$ {amount|amount} para {market}?',
  },
  marketShareNoAmount: {
    en: 'How much of the money for {market}?',
    pt: 'Quanto do dinheiro para {market}?',
  },
  // A filter the model names for words that do not write its value ("obesity drugs" for keyword
  // GLP-1; "my future" for sector Consumer Discretionary, the review of Oct 7): the link between the
  // two is the model's alone, so it is never taken. One question says what it would be matched by,
  // and "none" leaves it out. `matched` is `MATCHED_NAME`, filled.
  // In Portuguese "Diga nada" reads as "say nothing" (the third review, Oct 7): the way out is
  // said as the answer it is, "nenhum", which `noneSaidIn` reads.
  matchedShare: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'I read “{market}” as {matched}. How much of the ${amount|amount} for them? Say none if that is not what you meant.',
    pt: 'Li “{market}” como {matched}. Quanto dos US$ {amount|amount} para eles? Diga nenhum se não era isso que você quis dizer.',
  },
  matchedShareNoAmount: {
    en: 'I read “{market}” as {matched}. How much of the money for them? Say none if that is not what you meant.',
    pt: 'Li “{market}” como {matched}. Quanto do dinheiro para eles? Diga nenhum se não era isso que você quis dizer.',
  },
  // Several things named to hold, and no share for each (the review of Oct 7): the question names
  // them, in the person's words, and "half each" answers it. `themes` is those words, joined.
  themeShares: {
    en: 'How do you want to split the money between {themes}?',
    pt: 'Como você quer dividir o dinheiro entre {themes}?',
  },
  // One thing named with a share, and the text says where the rest goes, or carves a sum out of it
  // ("30% in AI and the rest in stocks", "all of it in AI except $1,000"): the rest is asked, never
  // put in the safe part by guessing.
  themeAndRest: {
    en: 'How much of the money for {market}, and how do you want the rest held: kept safe and easy to take out, or seeking a return?',
    pt: 'Quanto do dinheiro para {market}, e como você quer o restante: seguro e fácil de tirar, ou buscando retorno?',
  },
  // A refusal and a holding of the same class in one conversation ("No stocks in my IRA, so here I
  // want all stocks"): one question, never a sheet with both. `refusal` and `held` are the person's
  // words.
  holdOrLeaveOut: {
    en: 'You wrote “{refusal}” and also “{held}”. Which one stands? Say how much of the money goes to it, or none.',
    pt: 'Você escreveu “{refusal}” e também “{held}”. Qual dos dois vale? Diga quanto do dinheiro vai para isso, ou nada.',
  },
  incomeTargetUsdMonthly: {
    en: 'How much income a month, in dollars, do you aim for?',
    pt: 'Quanto de renda por mês, em dólares, você busca?',
  },
  themes: {
    en: 'Which shared portfolio, if any, do you want to start from?',
    pt: 'De qual portfólio compartilhado você quer partir, se de algum?',
  },
  // A shared portfolio one reader read alone (the third review, Oct 7): the model names it and the
  // text writes its words with nothing that says they name it ("My pick is the seven."), or, with no
  // model, the text says its name as a holding. Asked once by its name, never taken and never
  // dropped. `portfolios` is the names as the shelf writes them, joined.
  startFrom: {
    en: 'Do you want to start from the shared portfolio {portfolios}?',
    pt: 'Você quer partir do portfólio compartilhado {portfolios}?',
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

/**
 * How long the goal runs, as the read-back's first sentence says it (Oct 6): the way the person said
 * it. In months, unless they said years ("about 5 years") or a date ("by 2031"). The figure is always
 * the sheet's: its months, those months as whole years, or the month they end in.
 */
export const TERM_SAID = {
  months: { en: 'over {months|months}', pt: 'em {months|months}' },
  years: { en: 'over {years|years}', pt: 'em {years|years}' },
  date: { en: 'by {month|month}', pt: 'até {month|month}' },
} as const satisfies Record<string, Text>;

/** The sentences of the read-back, each filled from the validated sheet and nothing else. */
export const READBACK_TEMPLATES = {
  // `term` is `TERM_SAID`, filled.
  GOAL: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You set {goal|goal} with ${amount|amount} {term}, at {risk|risk}.',
    pt: 'Você definiu {goal|goal} com US$ {amount|amount} {term}, com {risk|risk}.',
  },
  // A goal with no date (gate GLIDE-OPT-IN, Oct 6): the months the plan is built over are not said.
  GOAL_OPEN: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You set {goal|goal} with ${amount|amount}, with no date set, at {risk|risk}.',
    pt: 'Você definiu {goal|goal} com US$ {amount|amount}, sem data definida, com {risk|risk}.',
  },
  // With a stated mix (gate EXPLICIT-MIX) the risk is the mix's, said once as an assumption: not here.
  GOAL_MIX: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You set {goal|goal} with ${amount|amount} {term}.',
    pt: 'Você definiu {goal|goal} com US$ {amount|amount} {term}.',
  },
  GOAL_OPEN_MIX: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'You set {goal|goal} with ${amount|amount}, with no date set.',
    pt: 'Você definiu {goal|goal} com US$ {amount|amount}, sem data definida.',
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
  // What the person said to hold (gate EXPLICIT-MIX), part by part, of the whole plan.
  MIX_GROWTH: {
    en: '{share|pct} of the plan in stocks and crypto.',
    pt: '{share|pct} do plano em ações e cripto.',
  },
  MIX_DOLLAR_YIELD: {
    en: '{share|pct} of the plan in dollar yield.',
    pt: '{share|pct} do plano em rendimento em dólar.',
  },
  MIX_CREDIT: {
    en: 'Of the dollar yield, up to {share|pct} of the plan in tokens that lend to borrowers or trade a spread.',
    pt: 'Do rendimento em dólar, até {share|pct} do plano em tokens que emprestam a tomadores ou operam um spread.',
  },
  MIX_GOLD: {
    en: '{share|pct} of the plan in gold.',
    pt: '{share|pct} do plano em ouro.',
  },
  MIX_CASH: {
    en: '{share|pct} of the plan in cash.',
    pt: '{share|pct} do plano em caixa.',
  },
  SLEEVE_THEME: {
    en: '{share|pct} of the plan for the theme {theme}.',
    pt: '{share|pct} do plano para o tema {theme}.',
  },
  // A theme sleeve filled by a filter (gate THEME-MATCHED): `matched` is `MATCHED_NAME`, filled.
  SLEEVE_MATCHED: {
    en: '{share|pct} of the plan for {matched}.',
    pt: '{share|pct} do plano para {matched}.',
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
  // The risk a mix needs, said once (gate EXPLICIT-MIX): the person is never asked it.
  MIX_LIMITS: {
    en: 'To hold “{words}”, the plan uses the limits for {risk|risk}.',
    pt: 'Para manter “{words}”, o plano usa os limites de {risk|risk}.',
  },
  // The same line where the person also said a risk and the limits the mix needs are another's: their
  // answer, and the limits the plan uses to hold what they asked. Never changed in silence.
  MIX_LIMITS_OTHER_RISK: {
    en: 'You said {said|risk}, but to hold “{words}” the plan uses the limits for {risk|risk}.',
    pt: 'Você disse {said|risk}, mas para manter “{words}” o plano usa os limites de {risk|risk}.',
  },
  // Said right after either line where those limits are the ones for medium or high risk (gate
  // STATED-SHARE, Rodrigo, Oct 7): the person is told what holding their share makes of the plan.
  MIX_MORE_RISK: {
    en: 'We count this as a plan that accepts more risk.',
    pt: 'Consideramos este um plano que aceita mais risco.',
  },
  // A refusal the text writes that its clause does not state as the person's ("no stocks? not sure",
  // "maybe no stocks"), or that the model read as one and the clause says otherwise: not taken, and
  // said so, so it is never dropped in silence. `words` is the refusal as written.
  REFUSAL_DECLINED: {
    en: 'You said not to leave out {classes|list}, so the plan may hold them.',
    pt: 'Você disse para não deixar de fora {classes|list}, então o plano pode ter.',
  },
  REFUSAL_NOT_TAKEN: {
    en: 'I did not read “{words}” as something to leave out. Say so if you want it left out.',
    pt: 'Não li “{words}” como algo a deixar de fora. Diga se quiser que fique de fora.',
  },
  // A refusal the text states that the model did not read (the review of Oct 7): taken all the same,
  // since a plan must not hold what a person refused, and said in a line of its own that names their
  // words, so a clause read wrongly is seen and corrected. `classes` is what it leaves out.
  REFUSAL_TAKEN: {
    en: 'I read “{words}” as leaving out {classes|list}. Say so if that is not what you meant.',
    pt: 'Li “{words}” como deixar de fora {classes|list}. Diga se não era isso que você quis dizer.',
  },
  REFUSAL_TAKEN_CREDIT: {
    en: 'I read “{words}” as no tokens that lend to borrowers or trade a spread. Say so if that is not what you meant.',
    pt: 'Li “{words}” como nenhum token que empresta a tomadores ou opera um spread. Diga se não era isso que você quis dizer.',
  },
  // A refusal of a part of a class ("no stocks from China"), and a name ruled out of a list the plan
  // holds ("invest in AI but no Tesla"): a plan leaves out a class, so neither is applied, and that
  // is said, never done in silence.
  REFUSAL_OF_A_PART: {
    en: 'A plan can leave out a whole class, not a part of one, so “{words}” was not applied.',
    pt: 'Um plano pode deixar de fora uma classe inteira, não uma parte dela, então “{words}” não foi aplicado.',
  },
  CANNOT_LEAVE_OUT: {
    en: 'A plan cannot leave one company out of a list it holds, so “{words}” was not applied.',
    pt: 'Um plano não deixa uma empresa de fora de uma lista que mantém, então “{words}” não foi aplicado.',
  },
  // A share smaller than the least a line of the plan can be (the parameter table's `minLineUsd`
  // and `minLineBps`; the review of Oct 7: "$20" of $5,000 gave a sheet with 0.4% in a theme): a plan
  // could not hold it, so it is not taken, and how much is asked again. `least` is that floor in
  // dollars for the amount of the plan.
  SHARE_TOO_SMALL: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
    en: 'The smallest part a plan of this size can hold is ${least|amount}, so a smaller one was not taken.',
    pt: 'A menor parte que um plano deste tamanho pode ter é US$ {least|amount}, então uma parte menor não foi considerada.',
  },
  MIX_DROPPED: {
    en: 'A plan for {goal|goal} holds no stocks or crypto, so “{words}” is not held.',
    pt: 'Um plano com {goal|goal} não tem ações nem cripto, então “{words}” não é mantido.',
  },
  // A market, an industry or a trend the person's chain has nothing for (no shared portfolio, no
  // curated label that holds a stock there, no filter that matches one): said in one line, never
  // guessed. `nearest` is the name of a shared portfolio or a label the shelf does have.
  MARKET_NONE: {
    en: 'There is no stock for “{words}” on {chain|chain} at the moment. We will be adding more soon.',
    pt: 'No momento não há nenhuma ação para “{words}” na {chain|chain}. Vamos incluir mais em breve.',
  },
  MARKET_NEAREST: {
    en: 'There is no stock for “{words}” on {chain|chain} at the moment, and we will be adding more soon. The nearest today is {nearest}, which you can choose.',
    pt: 'No momento não há nenhuma ação para “{words}” na {chain|chain}, e vamos incluir mais em breve. O mais próximo hoje é {nearest}, que você pode escolher.',
  },
  // A filter that matches one name alone on the person's chain is never used to pick that stock (Oct
  // 7): nothing is held for it, and the line says why, with the nearest the shelf has where it has one.
  MARKET_ONE: {
    en: 'There is only one stock for “{words}” on {chain|chain} at the moment, and a theme is not made of one. We will be adding more soon.',
    pt: 'No momento há só uma ação para “{words}” na {chain|chain}, e um tema não se faz de uma só. Vamos incluir mais em breve.',
  },
  MARKET_ONE_NEAREST: {
    en: 'There is only one stock for “{words}” on {chain|chain} at the moment, and a theme is not made of one. We will be adding more soon. The nearest today is {nearest}, which you can choose.',
    pt: 'No momento há só uma ação para “{words}” na {chain|chain}, e um tema não se faz de uma só. Vamos incluir mais em breve. O mais próximo hoje é {nearest}, que você pode escolher.',
  },
  // No curated list for what the person named, and a filter over the sourced attributes that matches
  // some (gate THEME-MATCHED): the plan holds those, said as matched, never as curated. "Names", not
  // "stocks": a fund can be matched too, by a keyword.
  MARKET_MATCHED: {
    en: 'No curated list covers “{words}” on {chain|chain}, so the plan holds the names matched by {by}: {value}. Matched from the sourced attributes of each, not a curated theme.',
    pt: 'Nenhuma lista com curadoria cobre “{words}” na {chain|chain}, então o plano fica com os nomes filtrados por {by}: {value}. Filtrados pelos atributos de cada um, que têm fonte; não é um tema com curadoria.',
  },
  // What the chain lists could not be read (the chain is off, its adapter failed): what the person
  // named is not looked up, nothing is held for it, and nothing is said of what the chain has.
  SHELF_UNREAD: {
    en: 'What is listed on {chain|chain} could not be read just now, so nothing is held for “{words}” yet.',
    pt: 'Não foi possível ler agora o que está listado na {chain|chain}, então nada é mantido para “{words}” por enquanto.',
  },
  MAX_YIELD_LATER: {
    en: 'A part that seeks the highest yield is not built yet, so the part that seeks the goal is built as a goal to grow.',
    pt: 'Uma parte que busca o maior rendimento ainda não existe, então a parte que busca o objetivo é feita como um objetivo de crescimento.',
  },
} as const satisfies Record<string, Text>;
export type AssumptionId = keyof typeof ASSUMPTION_TEMPLATES;

/** What a filter reads (gate THEME-MATCHED), as the read-back and the assumptions write it. */
export const FILTER_BY_WORDS: Record<Language, Record<MarketFilterBy, string>> = {
  en: {
    sector: 'sector',
    industry: 'industry',
    sub_industry: 'sub-industry',
    keyword: 'keyword',
  },
  pt: {
    sector: 'setor',
    industry: 'indústria',
    sub_industry: 'subindústria',
    keyword: 'palavra-chave',
  },
};

/**
 * How a theme sleeve filled by a filter is named, in the read-back and to a caller: by what it was
 * matched by, never as a curated theme. `by` is a word of `FILTER_BY_WORDS`; `value` is the value as
 * the sourced attributes write it. "Names", as the theme sleeve says it: a fund can be matched too.
 */
export const MATCHED_NAME = {
  en: 'names matched by {by}: {value}',
  pt: 'nomes filtrados por {by}: {value}',
} as const satisfies Text;

/**
 * The classes a person can leave out, as the read-back writes them, in the order it says them:
 * stocks, then the funds of them. `etf` is said "stock funds": every fund of that class is a fund of
 * stocks, and the shelf also has funds that pay a dollar yield, which that class is not.
 */
/** What "no credit" leaves out, where a line lists it beside classes of asset. */
export const CREDIT_WORDS: Record<Language, string> = {
  en: 'tokens that lend to borrowers or trade a spread',
  pt: 'tokens que emprestam a tomadores ou operam um spread',
};
export const CLASS_WORDS: Record<Language, Record<string, string>> = {
  en: {
    stock: 'stocks',
    etf: 'stock funds',
    gold: 'gold',
    commodity: 'commodities',
    dollar_yield: 'dollar yield',
    crypto: 'crypto',
  },
  pt: {
    stock: 'ações',
    etf: 'fundos de ações',
    gold: 'ouro',
    commodity: 'commodities',
    dollar_yield: 'rendimento em dólar',
    crypto: 'cripto',
  },
};
