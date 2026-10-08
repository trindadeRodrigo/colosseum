import { EXIT_WINDOW_DAYS, personWeights } from '@colosseum/basket';
import { eligibleForGoal, PERSONAL_PARAMS } from '@colosseum/engine/personal';
import type { BasketAsset, ChainId, Price, Shelf, VaultState } from '@colosseum/schemas';
import {
  type VaultAgentSource as AgentSource,
  VaultAgentModelReply,
  VaultAgentReply,
  VaultAgentRequest,
  type VaultAgentResult,
  VaultAgentSource,
  type VaultAgentWarning,
  type VaultAgentWeightNote,
} from '@colosseum/schemas';
import type { VaultAgentModel, VaultAgentRepair } from '../vault-agent-model';
import type { ChainEntry } from './chains';
import type { PlanInputs } from './personalize';

type Figures = Awaited<ReturnType<PlanInputs>>;
type AgentContextData = {
  person: string;
  assets: BasketAsset[];
  evidence: AgentSource[];
  currentGoals: readonly unknown[];
  stockAttributes: Figures['stocks'] | null;
  liquidity: Array<{ assetId: string; observation: unknown | null }>;
  unknowns: string[];
  /**
   * The share of the vault each asset's measured exit capacity can sell at its current size, keyed by
   * asset, each with its `liquidity:<asset>` source. A weight above it is allowed with a warning
   * (ANY-COMPOSITION); it never chooses a weight.
   */
  caps?: Record<string, number>;
  /** Only a separately confirmed, server-owned goal change can replace existing eligibility. */
  confirmedGoal?: 'grow' | 'income' | 'protect';
};
export type VaultAgentContext = AgentContextData & { kind?: 'vault'; state: VaultState };
export type GoalAgentContext = AgentContextData & { kind: 'new_goal'; chain: ChainId; state: null };
export type ConversationAgentContext = VaultAgentContext | GoalAgentContext;
export type VaultAgentPrompt = {
  version: 1;
  kind: 'vault' | 'new_goal';
  chain: ChainId;
  language: 'en' | 'pt';
  messages: VaultAgentRequest['messages'];
  latestPerson: string;
  vault: VaultState | null;
  currentGoals: readonly unknown[];
  catalog: Array<
    Pick<
      BasketAsset,
      'id' | 'symbol' | 'underlying' | 'cls' | 'tier' | 'issuer' | 'provenance' | 'sheet'
    >
  >;
  evidence: AgentSource[];
  stockAttributes: Figures['stocks'] | null;
  liquidity: VaultAgentContext['liquidity'];
  unknowns: string[];
  /** Measured exit capacity as a share of the vault; above it is allowed and warned, not refused. */
  exitCapacityBps: Record<string, number>;
  eligibilityGoal: 'grow' | 'income' | 'protect' | null;
  /** Assets outside eligibilityGoal that the person asked for in their own words. */
  requestedOutsideGoal: string[];
  /** The shares the server read in the person's own words, which set the weights; `personQuote` is those words. */
  allocationConstraints: Array<{
    assetIds: string[];
    minWeightBps: number;
    maxWeightBps: number;
    personQuote: string;
  }>;
};

/** This reads observations and guardrails only. It never calls an allocator, stores, or trades. */
type ContextInput = {
  entry: ChainEntry;
  prices: Price[];
  prepared: { shelf: Shelf; figures: Figures };
  person: string;
  currentGoals?: readonly unknown[];
  confirmedGoal?: 'grow' | 'income' | 'protect';
};

export function buildVaultAgentContext(
  input: ContextInput & { state: VaultState },
): VaultAgentContext {
  return buildAgentContext({
    ...input,
    kind: 'vault',
    chain: input.state.chain,
    observedAt: input.state.observedAt,
  }) as VaultAgentContext;
}

/** A new-goal draft has no vault, holdings or planning size. Catalog observations remain real. */
export function buildGoalAgentContext(
  input: ContextInput & { chain: ChainId; observedAt: string },
): GoalAgentContext {
  return buildAgentContext({ ...input, kind: 'new_goal', state: null }) as GoalAgentContext;
}

function buildAgentContext(
  input: ContextInput & {
    kind: 'vault' | 'new_goal';
    state: VaultState | null;
    chain: ChainId;
    observedAt: string;
  },
): ConversationAgentContext {
  const { state, entry, prepared } = input;
  const assets = prepared.shelf.assets.filter((asset) => asset.chain === input.chain);
  const listed = new Map(assets.map((asset) => [asset.id, asset]));
  const evidence: AgentSource[] = [];
  const add = (source: AgentSource) => {
    evidence.push(VaultAgentSource.parse(source));
  };
  for (const asset of assets) {
    add({
      id: `catalog:${asset.id}`,
      assetId: asset.id,
      // A shared portfolio's ceiling (maxWeightBps) does not bind the person's own vault, so it is not
      // offered as a figure here (ANY-COMPOSITION).
      label: `${asset.symbol} listed on this chain`,
      source: entry.source,
      fetchedAt: input.observedAt,
      method:
        asset.cls === 'cash'
          ? 'listed asset catalog; cash is the residual balance'
          : 'listed asset catalog',
      provenance: entry.provenance,
    });
    const tier = prepared.figures.tiers?.find((row) => row.assetId === asset.id);
    add({
      id: `tier:${asset.id}`,
      assetId: asset.id,
      label: `Risk tier ${tier?.tier ?? asset.tier}`,
      source: tier?.source ?? entry.source,
      fetchedAt: tier?.fetchedAt ?? input.observedAt,
      method: tier?.method ?? 'listed asset catalog tier; not a measured risk observation',
      provenance: tier?.provenance ?? entry.provenance,
    });
  }
  for (const price of input.prices) {
    if (!listed.has(price.asset)) continue;
    add({
      id: `price:${price.asset}`,
      assetId: price.asset,
      label: 'Reference price',
      value: Number(price.usdPerToken),
      unit: 'USD',
      source: price.source,
      fetchedAt: price.fetchedAt,
      method: price.method,
      provenance: price.provenance,
    });
  }
  for (const [index, observation] of (prepared.figures.yields ?? []).entries()) {
    if (!listed.has(observation.assetId)) continue;
    for (const [kind, value] of [
      ['quoted', observation.quotedYield],
      ['haircut', observation.haircutYield],
    ] as const)
      add({
        id: `yield:${observation.assetId}:${index}:${kind}`,
        assetId: observation.assetId,
        label: `${kind} yield`,
        value,
        unit: 'fraction',
        source: observation.source,
        fetchedAt: observation.fetchedAt,
        method: observation.method,
        provenance: observation.provenance,
      });
  }
  for (const row of prepared.figures.stocks?.stocks ?? []) {
    const asset = assets.find((item) => item.symbol === row.symbol);
    if (!asset) continue;
    row.sources.forEach((source, index) => {
      add({
        id: `stock:${asset.id}:${index}`,
        assetId: asset.id,
        label: source.title,
        source: source.url,
        fetchedAt: `${source.readOn}T00:00:00.000Z`,
        method: 'sourced stock attributes; fetchedAt represents the recorded read day',
        provenance: asset.provenance,
      });
    });
  }
  const unknowns: string[] = [];
  const holdings = state ? [state.cash, ...state.positions] : [];
  const prices = new Map(input.prices.map((price) => [price.asset, Number(price.usdPerToken)]));
  const values = holdings.map((holding) => {
    const price = prices.get(holding.asset);
    return price === undefined ? null : Number(holding.display) * price;
  });
  const notionalUsd =
    state && values.every((value) => value !== null && Number.isFinite(value))
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  if (notionalUsd === null)
    unknowns.push(
      state
        ? 'Some current holdings lack a usable reference price; the full vault value is unknown.'
        : 'No planning amount has been confirmed for this new goal; size-dependent exit capacity and feasibility are unknown. There is no existing vault or current holdings.',
    );
  const caps: Record<string, number> = {};
  const liquidity = assets.map((asset) => {
    const observed =
      asset.cls !== 'cash' && notionalUsd !== null && notionalUsd > 0
        ? (prepared.figures.liquidity?.provider.entry(asset.id, {
            tau: PERSONAL_PARAMS.tau,
            windowDays: EXIT_WINDOW_DAYS,
            legAmountUsd: notionalUsd,
          }) ?? null)
        : null;
    const observation = observed && observed.samples > 0 && observed.dataTo ? observed : null;
    if (observation && notionalUsd !== null && notionalUsd > 0) {
      if (!Number.isFinite(observation.capacityUsd) || observation.capacityUsd < 0)
        throw new Error('Invalid measured exit capacity');
      caps[asset.id] = Math.min(10000, Math.floor((observation.capacityUsd / notionalUsd) * 10000));
    }
    if (observation?.dataTo && prepared.figures.liquidity)
      add({
        id: `liquidity:${asset.id}`,
        assetId: asset.id,
        label: 'Measured exit capacity at the current vault size',
        value: observation.capacityUsd,
        unit: 'USD',
        source: prepared.figures.liquidity.source,
        fetchedAt: observation.dataTo,
        method: observation.methodVersion,
        provenance: observation.provenance,
      });
    return { assetId: asset.id, observation };
  });
  if (
    liquidity.some((item) => listed.get(item.assetId)?.cls !== 'cash' && item.observation === null)
  )
    unknowns.push(
      'Measured exit evidence is missing for some listed assets; missing evidence is not zero exit cost.',
    );
  if (!prepared.figures.stocks)
    unknowns.push('Sourced company classifications are unavailable for this chain.');
  if (!prepared.figures.yields?.length)
    unknowns.push('No sourced yield observations were returned for this catalog.');
  if (!input.currentGoals?.length && !input.confirmedGoal)
    unknowns.push(
      state
        ? 'The current investment goal is unavailable; this preview has not been checked against income or protection eligibility.'
        : 'A new investment goal has not been confirmed; this preview has not been checked against income or protection eligibility. Funding requires fresh confirmation of the goal and amount.',
    );
  return {
    person: input.person,
    kind: input.kind,
    ...(input.kind === 'new_goal' ? { chain: input.chain } : {}),
    state,
    assets,
    evidence,
    currentGoals: input.currentGoals ?? [],
    stockAttributes: prepared.figures.stocks ?? null,
    liquidity,
    unknowns,
    caps,
    ...(input.confirmedGoal ? { confirmedGoal: input.confirmedGoal } : {}),
  } as ConversationAgentContext;
}

function eligibilityGoal(context: ConversationAgentContext): 'grow' | 'income' | 'protect' | null {
  if (context.confirmedGoal) return context.confirmedGoal;
  for (const value of [...context.currentGoals].reverse()) {
    if (typeof value !== 'object' || value === null) continue;
    const goal =
      (value as { goal?: unknown; sheet?: { goal?: unknown } }).goal ??
      (value as { sheet?: { goal?: unknown } }).sheet?.goal;
    if (goal === 'grow' || goal === 'income' || goal === 'protect') return goal;
  }
  return null;
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasNonFiniteNumber);
  return false;
}

/** Exact attributed person quotes and catalog names may contain numbers; new metrics may not. */
function hasFinancialFigure(text: string, personWords: string[], catalogNames: string[]): boolean {
  const names = catalogNames.filter((name) => /\p{N}/u.test(name));
  let remainder = text.replace(
    /\b(?:you said|you wrote|you asked|your request was|você disse|voce disse|você escreveu|voce escreveu|seu pedido foi)\s*:?\s*[“"]([^”"]+)[”"]/giu,
    (excerpt, quote: string) => (personWords.some((words) => words.includes(quote)) ? '' : excerpt),
  );
  for (const name of names) remainder = remainder.replaceAll(name, '');
  return (
    /[\p{N}%$€£]/u.test(remainder) ||
    /\b(?:guaranteed|risk[- ]free|garantido|sem risco)\b/iu.test(text) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|um|dois|três|tres|quatro|cinco|dez|cem|mil)\s+(?:percent|per\s+cent|basis\s+points?|dollars?|months?|years?|por\s+cento|d[oó]lares|meses|anos)\b/iu.test(
      remainder,
    )
  );
}

/**
 * What each repairable check means, in the words the model reads on its one repair call. Only checks on
 * the model's own reply are here: a timeout, a spent budget or a bad request is not the model's to fix.
 */
const REPAIR_HINTS: Record<string, string> = {
  reply_schema:
    'The reply did not match the required structure: a field was missing, had the wrong type, or was outside its length or count limits.',
  prose_figure:
    'Prose contained a financial figure, percentage, price, yield, date or written-out number. Numbers may appear in prose only inside an exact catalog name or an exact quote of the person in attributed quotation marks. The server sets the weights.',
  prose_claims_applied:
    'Prose said something was applied, created, funded, traded or approved. A proposal is only a private preview; nothing has been applied.',
  allocation_unlisted: "An allocation named an assetId that is not in this chain's catalog.",
  allocation_duplicate: 'The same assetId appeared in more than one allocation.',
  allocation_lines:
    'The proposal held more than sixteen assets besides cash; a vault holds at most sixteen.',
  allocation_ineligible:
    'An allocation used an asset that is outside eligibilityGoal (stocks in income or protect) and is not in requestedOutsideGoal. Only the person can ask for such an asset; never add one on your own. If the person seems to want it but has not plainly asked, leave it out and ask them to confirm in question.',
  allocation_evidence:
    'An allocation cited an evidenceId that does not exist in evidence or belongs to a different asset.',
  allocation_constraint:
    'The picks cannot meet a share the person stated, which the server read in their own words (allocationConstraints). Pick the assets it covers, with room for the rest, so the server can meet it, or ask the person about it in question. The share is theirs and still stands.',
  stated_ungrounded:
    'A share in stated is not one the server read in the person\'s words, so it is not applied. The server reads a share only where the person wrote the number beside the asset ("70% TSLA", "TSLA 70%", "at least 40% stocks", "70/30 TSLA and NVDA") in a sentence with no refusal and no return, yield, growth or loss word; allocationConstraints lists what it read. Remove the share, do not describe it as applied, and ask the person in question to say it as a percentage beside the asset name.',
  reply_shape:
    'The proposal did not fit the final preview limits once the server added its own unknowns and sources: keep fields shorter and lists smaller.',
};

function claimsApplied(text: string): boolean {
  return (
    /\bi\s+(?:have\s+)?(?:changed|applied|updated|rebalanced|created|opened|funded)\s+(?:your|the)\s+(?:vault|portfolio|strategy|allocations?)\b/iu.test(
      text,
    ) ||
    /\b(?:eu\s+)?(?:alterei|apliquei|atualizei|rebalanceei|criei|abri|financiei)\s+(?:o\s+seu|a\s+sua|seu|sua|o|a)\s+(?:cofre|carteira|estratégia|estrategia|alocação|alocacao|alocações|alocacoes)\b/iu.test(
      text,
    )
  );
}

const STOCK_WORDS = ['stocks?', 'shares?', 'equities', 'ações', 'acoes'];
const isStock = (asset: Pick<BasketAsset, 'cls'>) => asset.cls === 'stock' || asset.cls === 'etf';
const literal = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (pattern: string, flags: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, flags);

// The reader of "the person asked for this stock" (gate ANY-COMPOSITION). It errs towards missing a
// request: a stock outside an income or protect goal that the person did not plainly ask for is refused,
// and the model is told to ask them instead.
const ASKS = word(
  "want|wanna|i'?d\\s+like|would\\s+like|prefer|add|include|put|buy|allocate|invest|quero|queria|gostaria|prefiro|adicione|adiciona|adicionar|inclua|inclui|incluir|compre|compra|comprar|coloque|coloca|colocar|aloque|aloca|alocar|invista|investir|bote|bota|botar|põe|ponha|pôr",
  'iu',
);
const POLITE_ASK =
  /^(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:add|put|include|buy)\b|^(?:você\s+|voce\s+)?(?:pode|poderia)\s+(?:por\s+favor\s+)?(?:colocar|adicionar|incluir|comprar|pôr|botar)(?![\p{L}\p{N}])/iu;
// A refusal, an exclusion, an upper bound, a withdrawal or a sale: the clause asks for nothing.
const REFUSES = word(
  "no|not|none|never|nothing|without|except|excluding|exclude|avoid|avoiding|out|sell|selling|remove|drop|scratch|cut|minus|instead|rather|risky|less|fewer|stop|don'?t|do\\s+not|doesn'?t|won'?t|at\\s+most|no\\s+more|max|maximum|up\\s+to|already|menos|sem|não|nao|nada|nenhum|nenhuma|nunca|exceto|tirar|tire|tira|vender|venda|vende|evitar|evite|evita|arriscad[ao]s?|fora|máximo|maximo|até|já",
  'iu',
);
// Someone else's view, a condition or a wish to talk about it: not the person's instruction.
const NOT_THEIRS = word(
  'if|whether|should|my\\s+friend|my\\s+advisor|someone|somebody|said|says|suggests?|suggested|quoted|explain|discuss|talk\\s+about|learn|example|imagine|suppose|know|understand|compare|see|look|something\\s+like|style|se|caso|meu\\s+amigo|disse|diz|sugere|sugeriu|discutir|exemplo|saber|conhecer|entender|comparar|ver|como\\s+[ao]s?|algo\\s+como|estilo',
  'iu',
);
// A condition anywhere in a sentence voids all of it: "Quero ações, mas só se for seguro."
const CONDITION = word('if|unless|only\\s+if|se|caso|só\\s+se|a\\s+menos\\s+que', 'iu');
const ASKS_A_QUESTION =
  /^(?:why|what|which|how|is|are|was|should|can|could|would|do|does|did|will|por\s*que|porque|o\s+que|qual|quais|como|será|sera|devo|vale)(?![\p{L}\p{N}])/iu;
// Company short names that are everyday words; the ticker still names the asset.
const COMMON_NAMES = new Set(['meta', 'strategy', 'circle', 'oracle', 'target', 'block']);
const CORPORATE =
  /\s+(?:inc\.?|incorporated|corp\.?|corporation|company|co\.?|limited|ltd\.?|lp|n\.v\.|plc|group|holdings?|platforms|global|technologies|markets|trust|series\s+\d+)$/iu;

/** The company names a person may use: the registered name and its short form ("Apple"). */
function companyNames(companies: string[]): string[] {
  const names = new Set<string>();
  for (const company of companies) {
    let name = company.split(',')[0]?.trim() ?? '';
    names.add(name);
    for (let shorter = name.replace(CORPORATE, ''); shorter !== name; ) {
      name = shorter;
      shorter = name.replace(CORPORATE, '');
    }
    names.add(name.replace(/\.com$/iu, ''));
  }
  return [...names].filter((name) => name.length > 2);
}

/** The case-sensitive tickers and the case-insensitive company names that name one asset. */
function assetNames(asset: BasketAsset, companies: string[]): RegExp[] {
  const tickers = [...new Set([asset.symbol, asset.underlying])].map(literal);
  const spoken = companyNames(companies).filter((name) => !COMMON_NAMES.has(name.toLowerCase()));
  return [
    word(tickers.join('|'), 'u'),
    ...(spoken.length ? [word(spoken.map(literal).join('|'), 'iu')] : []),
  ];
}

/**
 * The stocks the person asked for in their own words, read clause by clause. A stock, its company or
 * "stocks" counts only in an affirmative clause: an asking verb before it in the sentence, and in that
 * clause no refusal, exclusion, upper bound, sale, condition or someone else's view. A message with a
 * question mark counts only through a polite request ("can you add", "pode colocar"). The latest mention
 * of a stock wins, so "no AAPL" withdraws an earlier "I want AAPL". The model's reply never counts.
 */
function requestedStocks(
  messages: VaultAgentRequest['messages'],
  language: 'en' | 'pt',
  assets: BasketAsset[],
  companies: Map<string, string[]>,
): Set<string> {
  const stocks = assets.filter(isStock);
  const names = new Map(
    stocks.map((asset) => [asset.id, assetNames(asset, companies.get(asset.id) ?? [])]),
  );
  const general = word(STOCK_WORDS.join('|'), 'iu');
  // Portuguese "no" is "in the"; its refusals are não, nenhum, nada, sem.
  const refuses = (clause: string) =>
    REFUSES.test(language === 'pt' ? clause.replace(word('no', 'iu'), 'em') : clause);
  // The latest affirmative (true) or refusing (false) mention of each stock, and of stocks in general.
  const latest = new Map<string, { at: number; asked: boolean }>();
  let at = 0;
  for (const message of messages) {
    if (message.who !== 'person') continue;
    const text = message.text.trim();
    if (/^["“‘']/u.test(text)) continue;
    const questioned = text.includes('?');
    const sentences = text
      .split(/[.;!?\n]+/u)
      .filter((sentence) => !CONDITION.test(sentence))
      .flatMap((sentence) =>
        sentence.split(
          /(?<![\p{L}\p{N}])(?:but|however|mas|porém|porem|contudo)(?![\p{L}\p{N}])/iu,
        ),
      );
    for (const sentence of sentences) {
      let asking = false;
      for (const clause of sentence.split(',').map((part) => part.trim())) {
        if (!clause) continue;
        const polite = POLITE_ASK.test(clause);
        if (NOT_THEIRS.test(clause) || (!polite && (questioned || ASKS_A_QUESTION.test(clause)))) {
          asking = false;
          continue;
        }
        const verb = polite ? 0 : clause.search(ASKS);
        if (verb >= 0) asking = true;
        const refused = refuses(clause);
        if (!refused && !asking) continue;
        // An affirmative clause asks for what follows its own verb; a refusal covers the whole clause.
        const read = refused || verb < 0 ? clause : clause.slice(verb);
        at += 1;
        if (general.test(read)) latest.set('*', { at, asked: !refused });
        for (const asset of stocks)
          if (names.get(asset.id)?.some((pattern) => pattern.test(read)))
            latest.set(asset.id, { at, asked: !refused });
      }
    }
  }
  return new Set(
    stocks
      .filter((asset) => {
        const own = latest.get(asset.id);
        const all = latest.get('*');
        const last = !own ? all : !all || own.at >= all.at ? own : all;
        return last?.asked === true;
      })
      .map((asset) => asset.id),
  );
}

// The person's shares, read by the server from their own messages (gate ANY-COMPOSITION). The weights
// are a preview the person confirms on an editable review screen, so the bar is a deterministic read
// that is never silent: a few fixed patterns set a share, and anything else that looks like one is
// said back as unread. Nothing here comes from the model.
const BOUNDS = {
  min: 'at\\s+least|no\\s+less\\s+than|not\\s+less\\s+than|more\\s+than|over|above|mais\\s+de|acima\\s+de|(?:a\\s+)?minimum(?:\\s+of)?|min|pelo\\s+menos|ao\\s+menos|no\\s+m[ií]nimo|m[ií]nimo\\s+de',
  max: 'at\\s+most|up\\s+to|no\\s+more\\s+than|not\\s+more\\s+than|less\\s+than|under|below|menos\\s+de|abaixo\\s+de|(?:a\\s+)?maximum(?:\\s+of)?|max|no\\s+m[aá]ximo|m[aá]ximo\\s+de|até',
  exact: 'exactly|exatamente',
};
const BOUND = `${BOUNDS.min}|${BOUNDS.max}|${BOUNDS.exact}`;
// "70%", "70 percent", "70 por cento", "half", "metade", with the bound written before it.
const NUMBER = new RegExp(
  `(?<![\\p{L}\\p{N}.,/])(?:(${BOUND})\\s+)?(?:(\\d+(?:[.,]\\d+)?)\\s*(?:%|(?:percent|per\\s*cent|por\\s*cento|pct)(?![\\p{L}\\p{N}]))|(half|metade)(?![\\p{L}\\p{N}]))`,
  'giu',
);
// "70/30", read only with the two assets it splits written beside it, in order.
const RATIO = /(?<![\p{L}\p{N}.,/])(\d{1,3})\s*\/\s*(\d{1,3})(?![\p{N}.,/%])/gu;
// What may stand between a number and the asset after it ("70% in TSLA", "70% da carteira em TSLA"),
// between an asset and the number after it ("TSLA at 70%"), and between two assets of a ratio.
const NUMBER_THEN_ASSET =
  /^\s*(?:(?:of\s+(?:my|the)\s+(?:vault|portfolio|money|savings)|d[ao]\s+(?:meu\s+|minha\s+)?(?:cofre|carteira|dinheiro))\s+)?(?:(?:in|into|to|em|no|na|nos|nas|de|para|pra)\s+)?$/iu;
const ASSET_THEN_NUMBER = /^\s*(?:(?:at|to|a|em|com|is|é|=|:|-)\s*)?$/iu;
const JOINS = /^\s*(?:and|e|&|\+|\/)\s*$/iu;
// A share of the vault is never a return, a yield, a price move, a fee or a loss: a clause with one
// of these words sets no share ("10% a year", "TSLA fell 30%", "90% do CDI").
const RETURNS = word(
  'a\\s+year|per\\s+year|yearly|annual(?:ly)?|per\\s+annum|a\\s+month|per\\s+month|monthly|earn|earns|earning|return|returns|yield|yields|interest|apy|apr|dividends?|fees?|gain|gains|profit|upside|downside|grow|grows|growth|rise|rises|rose|fell|fall|falls|dropped|lose|loses|losing|loss|losses|drawdown|ao\\s+ano|por\\s+ano|anual|a\\.a|ao\\s+m[eê]s|por\\s+m[eê]s|mensal|render|rende|rendendo|rendimento|rentabilidade|retorno|juros|taxa|cdi|selic|ipca|dividendos?|ganho|ganhar|ganhe|lucro|valoriz\\p{L}+|desvaloriz\\p{L}+|crescer|cresça|cresce|crescimento|subir|suba|sobe|subiu|cair|caia|cai|caiu|perder|perca|perde|perda|perdas|queda',
  'iu',
);
// A refusal or a withdrawal: the clause sets no share, and withdraws the earlier shares on what it names.
const SHARE_REFUSES = word(
  "no|not|never|none|without|except|excluding|exclude|avoid|avoiding|sell|selling|remove|drop|forget|ignore|scratch|cancel|stop|instead\\s+of|rather\\s+than|too\\s+much|no\\s+longer|anymore|don'?t|do\\s+not|doesn'?t|won'?t|wouldn'?t|can'?t|cannot|isn'?t|não|nao|nunca|jamais|sem|nem|exceto|menos|nenhum|nenhuma|tirar|tire|tira|vender|venda|vende|evitar|evite|evita|esqueça|esqueca|esquece|ignora|remova|cancele|cancela|chega\\s+de|demais",
  'iu',
);
const LIMIT_WORDS = word(
  'limits?|requirements?|constraints?|minimum|maximum|shares?|percentages?|split|limites?|m[ií]nimo|m[aá]ximo|percentual|porcentagem|divis[aã]o',
  'iu',
);
const EQUAL_SPLIT = word(
  'equal(?:ly)?\\s+split|split\\s+(?:it\\s+|them\\s+)?(?:equally|evenly)|equal\\s+(?:parts|shares|weights)|evenly|partes\\s+iguais|igualmente|divis[aã]o\\s+igual|divid[ai]r?\\s+igual(?:mente)?',
  'iu',
);
// "Make that at least 10%": a new number for the one share that stands, naming no asset.
const AMENDS =
  /^(?:(?:please|por\s+favor)\s+)?(?:(?:make|change|set)\s+(?:that|it)(?:\s+to)?|(?:mude|muda|altere|troque|faça|faca|faz)(?:\s+isso)?\s+(?:para|pra))\s+/iu;
// What reads as a share in the person's words, applied or not.
const SHARE_WORDS =
  /\d+(?:[.,]\d+)?\s*(?:%|percent|per\s*cent|por\s*cento)|(?<![\d.,])\d+\s*\/\s*\d+(?![\d.,])|(?<![\p{L}\p{N}])(?:half|metade|mostly|mainly|majority|most\s+of|maioria|maior\s+parte|principalmente|sobretudo)(?![\p{L}\p{N}])/iu;
const CLASS_WORDS: Array<[(asset: BasketAsset) => boolean, string[]]> = [
  [isStock, STOCK_WORDS],
  [(asset) => asset.cls === 'cash', ['cash', 'caixa']],
  [(asset) => asset.cls === 'gold', ['gold', 'ouro']],
  [(asset) => asset.cls === 'crypto', ['crypto', 'cripto', 'criptomoedas?']],
];
// Tickers that are everyday words in English or Portuguese ("na minha meta", "pump"): beside a number
// they name the asset only as written (META, METAx) or as the company is capitalised (Meta).
const EVERYDAY = new Set([
  ...COMMON_NAMES,
  'met',
  'pump',
  'coin',
  'hood',
  'ray',
  'aero',
  'virtual',
  'mu',
]);

type Named = { start: number; end: number; ids: string[] };
/** The bound and the basis points one NUMBER match holds. */
const isBound = (kind: keyof typeof BOUNDS, text: string) =>
  new RegExp(`^(?:${BOUNDS[kind]})$`, 'iu').test(text);
const numberOf = (match: RegExpMatchArray): Pick<PersonShare, 'kind' | 'bps'> => ({
  kind: isBound('min', match[1] ?? '') ? 'min' : isBound('max', match[1] ?? '') ? 'max' : 'exact',
  bps: match[3] ? 5000 : Math.round(Number((match[2] ?? '').replace(',', '.')) * 100),
});
const wholeBps = (share: Pick<PersonShare, 'bps'>) =>
  Number.isInteger(share.bps) && share.bps >= 0 && share.bps <= 10_000;
type PersonShare = {
  assetIds: string[];
  kind: 'exact' | 'min' | 'max';
  bps: number;
  /** The person's words that hold the share: the number and the asset beside it. */
  quote: string;
};

/** Finds the assets and classes a text names, longest name first, each with the catalog ids it covers. */
function assetNamer(
  assets: BasketAsset[],
  companies: Map<string, string[]>,
): (text: string) => Named[] {
  const patterns: Array<{ pattern: RegExp; ids: string[] }> = [];
  const global = (regex: RegExp) => new RegExp(regex.source, `${regex.flags}g`);
  for (const asset of assets) {
    const names = [
      ...new Set([asset.symbol, asset.underlying, ...companyNames(companies.get(asset.id) ?? [])]),
    ];
    const asWritten = names.filter((name) => EVERYDAY.has(name.toLowerCase()));
    const anyCase = names.filter((name) => !EVERYDAY.has(name.toLowerCase()));
    if (asWritten.length)
      patterns.push({
        pattern: global(word(asWritten.map(literal).join('|'), 'u')),
        ids: [asset.id],
      });
    if (anyCase.length)
      patterns.push({
        pattern: global(word(anyCase.map(literal).join('|'), 'iu')),
        ids: [asset.id],
      });
  }
  for (const [matches, words] of CLASS_WORDS) {
    const ids = assets.filter(matches).map((asset) => asset.id);
    if (ids.length) patterns.push({ pattern: global(word(words.join('|'), 'iu')), ids });
  }
  return (text) => {
    const spans = new Map<string, Named>();
    for (const { pattern, ids } of patterns)
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const span = spans.get(`${start}:${end}`) ?? { start, end, ids: [] };
        span.ids = [...new Set([...span.ids, ...ids])];
        spans.set(`${start}:${end}`, span);
      }
    const kept: Named[] = [];
    for (const span of [...spans.values()].sort((a, b) => b.end - b.start - (a.end - a.start)))
      if (!kept.some((other) => span.start < other.end && other.start < span.end)) kept.push(span);
    return kept.sort((a, b) => a.start - b.start);
  };
}

/**
 * The shares one comma-separated piece of a clause sets, from fixed patterns only: a number with the
 * asset written straight after it ("70% TSLA", "at least 40% in stocks", "metade em Apple"), an asset
 * with the number straight after it ("TSLA 70%", "TSLA at 70%"), or a ratio with its two assets in
 * order ("70/30 TSLA and NVDA"). Every number in the piece must pair the same way, or none is read: a
 * number with something else beside it ("10% upside in gold"), or one number over two joined assets
 * ("40% in TSLA and NVDA"), sets nothing.
 */
function sharesInPiece(piece: string, named: (text: string) => Named[]): PersonShare[] {
  const assets = named(piece);
  const after = (at: number) => assets.find((asset) => asset.start >= at);
  const before = (at: number) => assets.filter((asset) => asset.end <= at).at(-1);
  const ratios = [...piece.matchAll(RATIO)];
  const numbers = [...piece.matchAll(NUMBER)];
  if (ratios.length) {
    const ratio = ratios[0];
    if (!ratio || ratios.length > 1 || numbers.length) return [];
    const parts = [Number(ratio[1]) * 100, Number(ratio[2]) * 100];
    if ((parts[0] ?? 0) + (parts[1] ?? 0) !== 10_000) return [];
    const [from, to] = [ratio.index, ratio.index + ratio[0].length];
    let pair: [Named, Named] | undefined;
    let span: [number, number] | undefined;
    const first = after(to);
    const second = first && after(first.end);
    const earlier = before(from);
    const earliest = earlier && before(earlier.start);
    if (
      first &&
      second &&
      NUMBER_THEN_ASSET.test(piece.slice(to, first.start)) &&
      JOINS.test(piece.slice(first.end, second.start))
    ) {
      const third = after(second.end);
      if (third && JOINS.test(piece.slice(second.end, third.start))) return [];
      pair = [first, second];
      span = [from, second.end];
    } else if (
      earlier &&
      earliest &&
      ASSET_THEN_NUMBER.test(piece.slice(earlier.end, from)) &&
      JOINS.test(piece.slice(earliest.end, earlier.start))
    ) {
      const third = before(earliest.start);
      if (third && JOINS.test(piece.slice(third.end, earliest.start))) return [];
      pair = [earliest, earlier];
      span = [earliest.start, to];
    }
    if (!pair || !span) return [];
    const quote = piece.slice(span[0], span[1]);
    return pair.map((asset, i) => ({
      assetIds: asset.ids,
      kind: 'exact' as const,
      bps: parts[i] as number,
      quote,
    }));
  }
  if (!numbers.length) return [];
  const spans = numbers.map((match) => [match.index, match.index + match[0].length] as const);
  const forward = spans.map(([, end]) => {
    const asset = after(end);
    return asset && NUMBER_THEN_ASSET.test(piece.slice(end, asset.start)) ? asset : undefined;
  });
  const backward = spans.map(([start]) => {
    const asset = before(start);
    return asset && ASSET_THEN_NUMBER.test(piece.slice(asset.end, start)) ? asset : undefined;
  });
  const isForward = forward.every(Boolean);
  if (isForward === backward.every(Boolean)) return [];
  const paired = (isForward ? forward : backward) as Named[];
  // One number over two joined assets ("40% in TSLA and NVDA") does not say whose share it is.
  for (const asset of paired) {
    const other = isForward ? after(asset.end) : before(asset.start);
    if (!other || paired.includes(other)) continue;
    const between = isForward
      ? piece.slice(asset.end, other.start)
      : piece.slice(other.end, asset.start);
    if (JOINS.test(between)) return [];
  }
  const shares = numbers.map((match, i) => {
    const asset = paired[i] as Named;
    const [start, end] = spans[i] as readonly [number, number];
    return {
      assetIds: asset.ids,
      ...numberOf(match),
      quote: isForward ? piece.slice(start, asset.end) : piece.slice(asset.start, end),
    };
  });
  return shares.every(wholeBps) ? shares : [];
}

/** "Make that at least 10%": the one share that stands, with the new number and nothing else. */
function amendedShare(piece: string, only: PersonShare): PersonShare[] {
  const rest = piece.replace(AMENDS, '').trim();
  const [match, ...others] = [...rest.matchAll(NUMBER)];
  if (!AMENDS.test(piece) || !match || others.length || match[0].length !== rest.length) return [];
  const share = { assetIds: only.assetIds, ...numberOf(match), quote: piece };
  return wholeBps(share) ? [share] : [];
}
const sameAssets = (a: PersonShare, b: PersonShare) =>
  a.assetIds.length === b.assetIds.length && a.assetIds.every((id) => b.assetIds.includes(id));

/**
 * The shares the person stated, read by the server from their own messages and from nothing else (gate
 * ANY-COMPOSITION). A clause is a sentence, or its part on one side of "but". A clause that is a
 * question, a condition or someone else's view, or that holds a return, yield, price-move or loss word,
 * sets nothing. A clause with a refusal ("don't want", "não quero", "except", "forget") sets nothing
 * and withdraws the earlier shares on the assets it names. Otherwise each comma-separated piece is read
 * by `sharesInPiece`. A later message's share replaces an earlier one whose assets it covers.
 *
 * `standing` is what holds now, `read` everything ever read (to compare with what the model reports),
 * and `unread` the pieces of the latest message that look like a share and set none.
 */
function personShares(
  messages: VaultAgentRequest['messages'],
  language: 'en' | 'pt',
  assets: BasketAsset[],
  companies: Map<string, string[]>,
): { standing: PersonShare[]; read: PersonShare[]; unread: string[] } {
  const named = assetNamer(assets, companies);
  const bounds = new RegExp(`(?<![\\p{L}\\p{N}])(?:${BOUND})(?![\\p{L}\\p{N}])`, 'giu');
  let standing: Array<PersonShare & { at: number }> = [];
  const read: PersonShare[] = [];
  let unread: string[] = [];
  messages.forEach((message, at) => {
    if (message.who !== 'person') return;
    unread = [];
    const text = message.text.trim();
    const quoted = /^["“‘']/u.test(text);
    for (const [, sentence = '', end = ''] of text.matchAll(
      /((?:[^.;!?\n]|\.(?=\d))+)([.;!?\n]*)/gu,
    ))
      for (const clause of sentence.split(
        /(?<![\p{L}\p{N}])(?:but|however|mas|porém|porem|contudo)(?![\p{L}\p{N}])/iu,
      )) {
        const pieces = clause
          .split(/,(?!\d)/u)
          .map((piece) => piece.trim())
          .filter(Boolean);
        // Bounds hold words that would read as a refusal or a move ("no more than", "up to").
        const plain = clause.replace(bounds, ' ');
        const spoken = language === 'pt' ? plain.replace(word('no', 'giu'), 'em') : plain;
        const applied = new Set<string>();
        if (
          !quoted &&
          !end.includes('?') &&
          !NOT_THEIRS.test(plain) &&
          !CONDITION.test(plain) &&
          !ASKS_A_QUESTION.test(clause.trim()) &&
          !RETURNS.test(plain)
        ) {
          if (SHARE_REFUSES.test(spoken)) {
            const refused = named(clause).flatMap((asset) => asset.ids);
            if (refused.length)
              standing = standing.filter(
                (share) => !share.assetIds.some((id) => refused.includes(id)),
              );
            else if (LIMIT_WORDS.test(clause)) standing = standing.slice(0, -1);
          } else {
            if (EQUAL_SPLIT.test(plain)) standing = [];
            for (const piece of pieces) {
              const only = standing.length === 1 ? standing[0] : undefined;
              const shares =
                only && named(piece).length === 0
                  ? amendedShare(piece, only)
                  : sharesInPiece(piece, named);
              if (!shares.length) continue;
              applied.add(piece);
              read.push(...shares);
              const covered = new Set(shares.flatMap((share) => share.assetIds));
              standing = [
                ...standing.filter((share) =>
                  share.at === at
                    ? !shares.some((next) => sameAssets(next, share))
                    : !share.assetIds.every((id) => covered.has(id)),
                ),
                ...shares.map((share) => ({ ...share, at })),
              ];
            }
          }
        }
        for (const piece of pieces)
          if (
            SHARE_WORDS.test(piece) &&
            !applied.has(piece) &&
            // A bare return target ("10% a year") is not a share of anything.
            !(RETURNS.test(piece.replace(bounds, ' ')) && named(piece).length === 0)
          )
            unread.push(piece.slice(0, 400));
      }
  });
  return { standing: standing.map(({ at: _at, ...share }) => share), read, unread };
}

export async function replyToVaultConversation(
  request: VaultAgentRequest,
  context: ConversationAgentContext,
  model: VaultAgentModel | null,
): Promise<VaultAgentResult> {
  const invalid = (detail: string): VaultAgentResult => ({
    kind: 'failure',
    reason: 'invalid',
    detail,
  });
  const parsed = VaultAgentRequest.safeParse(request);
  if (!parsed.success) return invalid('request_shape');
  if (!model) return { kind: 'failure', reason: 'unavailable', detail: 'no_model' };
  if (hasNonFiniteNumber(context)) return invalid('context_non_finite');
  const sourceById = new Map<string, AgentSource>();
  for (const raw of context.evidence) {
    const source = VaultAgentSource.safeParse(raw);
    if (!source.success || sourceById.has(source.data.id)) return invalid('context_evidence');
    sourceById.set(source.data.id, source.data);
  }
  const chain = context.kind === 'new_goal' ? context.chain : context.state.chain;
  const catalog = new Map(
    context.assets.filter((asset) => asset.chain === chain).map((asset) => [asset.id, asset]),
  );
  // Every exit-capacity share must be a listed asset's, whole, in range and backed by its measured
  // figure: a warning cites that figure, so a share without one is a server fault.
  const caps = context.caps ?? {};
  if (
    Object.entries(caps).some(
      ([id, cap]) =>
        !catalog.has(id) ||
        !Number.isInteger(cap) ||
        cap < 0 ||
        cap > 10_000 ||
        !sourceById.has(`liquidity:${id}`),
    )
  )
    return invalid('context_caps');
  const goal = eligibilityGoal(context);
  const companies = new Map<string, string[]>();
  for (const row of context.stockAttributes?.stocks ?? [])
    for (const asset of catalog.values())
      if (asset.symbol === row.symbol) companies.set(asset.id, [row.company]);
  // Read once, from the person's messages alone: the same shares whatever the model replies.
  const person = personShares(
    parsed.data.messages,
    parsed.data.language,
    [...catalog.values()],
    companies,
  );
  const requested = requestedStocks(
    parsed.data.messages,
    parsed.data.language,
    [...catalog.values()],
    companies,
  );
  const prompt: VaultAgentPrompt = {
    version: 1,
    kind: context.kind ?? 'vault',
    chain,
    language: parsed.data.language,
    messages: parsed.data.messages,
    latestPerson: parsed.data.messages.at(-1)?.text ?? '',
    vault: context.state,
    currentGoals: context.currentGoals,
    catalog: [...catalog.values()].map(
      ({ id, symbol, underlying, cls, tier, issuer, provenance, sheet }) => ({
        id,
        symbol,
        underlying,
        cls,
        tier,
        issuer,
        provenance,
        sheet,
      }),
    ),
    evidence: [...sourceById.values()],
    stockAttributes: context.stockAttributes,
    liquidity: context.liquidity,
    unknowns: context.unknowns,
    exitCapacityBps: caps,
    eligibilityGoal: goal,
    requestedOutsideGoal: goal
      ? [...catalog.values()]
          .filter((asset) => requested.has(asset.id) && !eligibleForGoal(asset, goal))
          .map((asset) => asset.id)
      : [],
    allocationConstraints: person.standing.map((share) => ({
      assetIds: share.assetIds,
      minWeightBps: share.kind === 'max' ? 0 : share.bps,
      maxWeightBps: share.kind === 'min' ? 10_000 : share.bps,
      personQuote: share.quote,
    })),
  };
  type Output = Awaited<ReturnType<VaultAgentModel['read']>>;
  // `problems` marks a check the model may repair once; `failed` names it. A broken stated limit already
  // has its final reply (asking the person about the limit), which stands if the repair fails too.
  type Checked = { result: VaultAgentResult; failed?: string; problems?: string[] };
  const ask = async (repair?: VaultAgentRepair): Promise<Output> => {
    try {
      return await (repair
        ? model.read(context.person, prompt, repair)
        : model.read(context.person, prompt));
    } catch {
      return { reply: null, why: 'unavailable', detail: 'model_threw' };
    }
  };
  // Where a schema check failed and its limit, for the model's repair turn only; never logged.
  const where = (issues: readonly { path: PropertyKey[]; message: string }[]) =>
    issues
      .slice(0, 5)
      .map((issue) => `At ${issue.path.map(String).join('.') || 'the top'}: ${issue.message}`);
  const rejected = (detail: string, extra: string[] = []): Checked => ({
    result: invalid(detail),
    failed: detail,
    problems: [REPAIR_HINTS[detail] ?? detail, ...extra],
  });
  // `final` is the repair attempt: a share it still reports without the person's words is ignored.
  const check = (output: Output, final = false): Checked => {
    if ('why' in output)
      return {
        result: {
          kind: 'failure',
          reason: output.why,
          ...(output.detail ? { detail: output.detail } : {}),
        },
      };
    const candidate = VaultAgentModelReply.safeParse(output.reply);
    if (!candidate.success) return rejected('reply_schema', where(candidate.error.issues));
    const { proposal, ...conversation } = candidate.data;
    const prose = [
      conversation.message,
      conversation.question ?? '',
      ...(proposal
        ? [
            proposal.objective,
            proposal.summary,
            ...proposal.tradeoffs,
            ...proposal.unknowns,
            ...proposal.allocations.map((allocation) => allocation.why),
          ]
        : []),
    ];
    const personWords = parsed.data.messages
      .filter((message) => message.who === 'person')
      .map((message) => message.text);
    const catalogNames = [
      ...[...catalog.values()].flatMap((asset) => [asset.symbol, asset.underlying]),
      ...(context.stockAttributes?.stocks ?? [])
        .filter((row) => [...catalog.values()].some((asset) => asset.symbol === row.symbol))
        .map((row) => row.company),
    ];
    if (prose.some((text) => hasFinancialFigure(text, personWords, catalogNames)))
      return rejected('prose_figure');
    if (prose.some(claimsApplied)) return rejected('prose_claims_applied');
    if (!proposal)
      return {
        result: {
          kind: 'reply',
          reply: {
            version: 1,
            messageId: request.messageId,
            ...conversation,
            proposal: null,
            warnings: [],
            weightNotes: [],
          },
        },
      };
    const ids = new Set<string>();
    for (const allocation of proposal.allocations) {
      const asset = catalog.get(allocation.assetId);
      if (!asset) return rejected('allocation_unlisted');
      if (ids.has(asset.id)) return rejected('allocation_duplicate');
      // Any listed composition may be proposed (ANY-COMPOSITION): only a stock outside the goal that the
      // person never asked for is refused; exit capacity and an asked-for stock warn, below.
      if (goal && !eligibleForGoal(asset, goal) && !requested.has(asset.id))
        return rejected('allocation_ineligible');
      ids.add(asset.id);
      for (const id of allocation.evidenceIds) {
        const source = sourceById.get(id);
        if (!source || (source.assetId !== undefined && source.assetId !== asset.id))
          return rejected('allocation_evidence');
      }
    }
    if (
      proposal.allocations.filter((allocation) => catalog.get(allocation.assetId)?.cls !== 'cash')
        .length > 16
    )
      return rejected('allocation_lines');
    // The weights come from the person's words, never from the model (Rodrigo's rule 2): an equal
    // split, or the shares the server read in the person's messages. What the model reports in
    // `stated` sets nothing: a share there that the server did not read is named once for the repair,
    // so the model asks the person instead of describing a share that was not applied.
    const { stated, ...preview } = proposal;
    const unconfirmed = stated.flatMap((share, index) =>
      person.read.some(
        (own) =>
          own.bps === share.bps &&
          own.kind === share.kind &&
          own.assetIds.some((id) => share.assetIds.includes(id)),
      )
        ? []
        : [
            `At stated.${index} (“${share.quote}”): the server did not read this share in the person's words, so it is not applied.`,
          ],
    );
    if (unconfirmed.length && !final) return rejected('stated_ungrounded', unconfirmed);
    const shares = person.standing;
    const picks = preview.allocations.map((allocation) => ({
      allocation,
      asset: catalog.get(allocation.assetId) as BasketAsset,
    }));
    const members = shares.map((share) =>
      picks.flatMap(({ asset }, i) => (share.assetIds.includes(asset.id) ? [i] : [])),
    );
    const { weights, unmet, scaled } = personWeights(
      picks.length,
      shares.map((share, i) => ({
        members: members[i] ?? [],
        min: share.kind === 'max' ? 0 : share.bps,
        max: share.kind === 'min' ? 10_000 : share.bps,
      })),
    );
    const missed = unmet[0] === undefined ? undefined : shares[unmet[0]];
    if (missed) {
      // Which share, in words: its place and the person's quote, never a weight.
      return {
        failed: 'allocation_constraint',
        problems: [
          REPAIR_HINTS.allocation_constraint ?? 'allocation_constraint',
          `The person said “${missed.quote}”: the picks cannot meet it.`,
        ],
        result: {
          kind: 'reply',
          reply: {
            version: 1,
            messageId: request.messageId,
            proposal: null,
            warnings: [],
            weightNotes: [
              { code: 'share_unmet', assetIds: missed.assetIds.slice(0, 64), quote: missed.quote },
            ],
            message:
              request.language === 'pt'
                ? `A proposta não respeitou seu pedido: “${missed.quote}”. Esse limite continua valendo; nada foi aplicado.`
                : `The draft did not meet your request: “${missed.quote}”. That requirement still stands; nothing was applied.`,
            question:
              request.language === 'pt'
                ? 'Quer que eu proponha outra divisão respeitando esse limite, ou prefere alterá-lo?'
                : 'Would you like another draft within that limit, or would you like to change the requirement?',
          },
        },
      };
    }
    const sources = new Set<string>();
    const warnings: VaultAgentWarning[] = [];
    const lines = picks.flatMap(({ allocation, asset }, i) => {
      const weightBps = weights[i] ?? 0;
      if (weightBps === 0) return [];
      const cap = caps[asset.id];
      if (cap !== undefined && weightBps > cap) {
        warnings.push({
          code: 'over_exit_capacity',
          assetId: asset.id,
          evidenceId: `liquidity:${asset.id}`,
        });
        sources.add(`liquidity:${asset.id}`);
      }
      if (goal && !eligibleForGoal(asset, goal)) {
        const listed = sourceById.has(`catalog:${asset.id}`)
          ? `catalog:${asset.id}`
          : allocation.evidenceIds[0];
        if (listed) {
          warnings.push({ code: 'outside_goal_requested', assetId: asset.id, evidenceId: listed });
          sources.add(listed);
        }
      }
      for (const id of allocation.evidenceIds) sources.add(id);
      return [{ ...allocation, weightBps, symbol: asset.symbol }];
    });
    const served = (indexes: readonly number[]) =>
      indexes.filter((i) => (weights[i] ?? 0) > 0).map((i) => picks[i]?.asset.id as string);
    const held = new Set(members.flat());
    const free = served(picks.map((_, i) => i).filter((i) => !held.has(i)));
    const weightNotes: VaultAgentWeightNote[] = [
      ...shares.flatMap((share, i) => {
        const assetIds = served(members[i] ?? []);
        return assetIds.length ? [{ code: 'stated' as const, assetIds, quote: share.quote }] : [];
      }),
      ...(scaled ? [{ code: 'scaled' as const, assetIds: served(picks.map((_, i) => i)) }] : []),
      ...(free.length ? [{ code: 'equal_split' as const, assetIds: free }] : []),
      ...picks.flatMap(({ asset }, i) =>
        (weights[i] ?? 0) === 0 ? [{ code: 'pick_dropped' as const, assetIds: [asset.id] }] : [],
      ),
      // What reads as a share in the person's latest words and set none is said, never dropped.
      ...[...new Set(person.unread)].map((quote) => ({
        code: 'share_unread' as const,
        assetIds: [],
        quote,
      })),
    ].slice(0, 64);
    const reply = VaultAgentReply.safeParse({
      version: 1,
      messageId: request.messageId,
      ...conversation,
      proposal: {
        ...preview,
        allocations: lines,
        unknowns: [...new Set([...context.unknowns, ...preview.unknowns])].slice(0, 12),
        sources: [...sources].map((id) => sourceById.get(id)),
      },
      warnings,
      weightNotes,
    });
    return reply.success
      ? { result: { kind: 'reply', reply: reply.data } }
      : rejected('reply_shape', where(reply.error.issues));
  };
  const started = Date.now();
  const first = await ask();
  const checked = check(first);
  if (!checked.problems || !checked.failed) return checked.result;
  const second = check(
    await ask({
      previous: first.reply,
      problems: checked.problems,
      elapsedMs: Date.now() - started,
    }),
    true,
  );
  const repair = {
    failed: checked.failed,
    outcome: second.problems
      ? (second.failed ?? 'invalid')
      : second.result.kind === 'reply'
        ? 'repaired'
        : (second.result.detail ?? second.result.reason),
  };
  // A stated limit the repair still missed, or missed at first and then failed another way: the person
  // is asked about the limit, as before the repair.
  const final =
    second.result.kind === 'failure' && checked.result.kind === 'reply'
      ? checked.result
      : second.result;
  return { ...final, repair };
}
