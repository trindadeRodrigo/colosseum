import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
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
  /** Person-authored limits projected onto the supplied catalog, never allocation choices. */
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
    'Prose contained a financial figure, percentage, price, yield, date or written-out number. Numbers may appear in prose only inside an exact catalog name or an exact quote of the person in attributed quotation marks. Put proposed weights only in weightBps.',
  prose_claims_applied:
    'Prose said something was applied, created, funded, traded or approved. A proposal is only a private preview; nothing has been applied.',
  allocation_unlisted: "An allocation named an assetId that is not in this chain's catalog.",
  allocation_duplicate: 'The same assetId appeared in more than one allocation.',
  allocation_lines:
    'The proposal held more than sixteen assets besides cash; a vault holds at most sixteen.',
  allocation_ineligible:
    'An allocation used an asset that is outside eligibilityGoal (stocks in income or protect) and is not in requestedOutsideGoal. Only the person can ask for such an asset; never add one on your own.',
  allocation_evidence:
    'An allocation cited an evidenceId that does not exist in evidence or belongs to a different asset.',
  allocation_sum: 'Allocation weightBps did not add up to exactly 10000.',
  allocation_constraint:
    'The proposal broke a limit the person stated. The limits in allocationConstraints are theirs and still stand.',
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

/** A quote, a hypothetical, someone else's view or a request to talk: not the person's instruction. */
const NOT_AN_INSTRUCTION =
  /^["“‘']|\b(?:if|should\s+i|my\s+friend|my\s+advisor|someone|said|quoted|explain|understand|discuss|talk\s+about|learn|example|se\s+eu|meu\s+amigo|disse|entender|discutir|exemplo)\b/iu;
const STOCK_WORDS = ['stocks?', 'shares?', 'equities', 'ações', 'acoes'];
const isStock = (asset: Pick<BasketAsset, 'cls'>) => asset.cls === 'stock' || asset.cls === 'etf';
const namesAny = (text: string, words: string[]) =>
  words.length > 0 &&
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(text);
const literal = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Assets the person asked for in their own words: a kept percentage minimum on them, or an instruction
 * that names the asset, its company or stocks in general and refuses nothing. The model's reply never
 * counts. Gate ANY-COMPOSITION: an asset outside the goal's eligibility is allowed only from here.
 */
function requestedAssets(
  messages: VaultAgentRequest['messages'],
  assets: BasketAsset[],
  companies: Map<string, string[]>,
  constraints: HoldingConstraint[],
): Set<string> {
  const requested = new Set<string>();
  for (const constraint of constraints)
    if (constraint.min > 0)
      for (const asset of assets) if (constraint.matches(asset)) requested.add(asset.id);
  for (const message of messages) {
    if (message.who !== 'person') continue;
    const text = message.text.trim();
    if (
      NOT_AN_INSTRUCTION.test(text) ||
      !/\b(?:want|would\s+like|prefer|add|include|buy|put|allocate|invest|hold|keep|quero|queria|prefiro|adicione|inclua|compre|coloque|aloque|invista|mantenha)\b/iu.test(
        text,
      ) ||
      /\b(?:do\s+not|don't|dont|never|without|não|nao|nunca|sem)\b/iu.test(text)
    )
      continue;
    for (const asset of assets) {
      const words = [asset.symbol, asset.underlying, ...(companies.get(asset.id) ?? [])].map(
        literal,
      );
      if (namesAny(text, words) || (isStock(asset) && namesAny(text, STOCK_WORDS)))
        requested.add(asset.id);
    }
  }
  return requested;
}

type HoldingConstraint = {
  key: string;
  matches(asset: BasketAsset): boolean;
  min: number;
  max: number;
  quote: string;
};

/** Bounded person-authored percentage limits are guards only; nothing here assigns a weight. */
function holdingConstraints(
  messages: VaultAgentRequest['messages'],
  assets: BasketAsset[],
): HoldingConstraint[] {
  const constraints = new Map<string, HoldingConstraint>();
  const targets: Array<{ key: string; words: string[]; matches(asset: BasketAsset): boolean }> = [
    { key: 'stocks', words: STOCK_WORDS, matches: isStock },
    { key: 'cash', words: ['cash', 'caixa'], matches: (asset) => asset.cls === 'cash' },
    { key: 'gold', words: ['gold', 'ouro'], matches: (asset) => asset.cls === 'gold' },
    { key: 'crypto', words: ['crypto', 'cripto'], matches: (asset) => asset.cls === 'crypto' },
    ...assets.map((asset) => ({
      key: asset.id,
      words: [asset.symbol, asset.underlying].map((word) =>
        word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
      matches: (candidate: BasketAsset) => candidate.id === asset.id,
    })),
  ];
  let last: HoldingConstraint | undefined;
  for (const message of messages) {
    if (message.who !== 'person') continue;
    const text = message.text.trim();
    if (NOT_AN_INSTRUCTION.test(text)) continue;
    const instruction =
      /^(?:please\s+)?(?:i\s+(?:think\s+i\s+)?(?:want|would\s+like|would\s+prefer)|we\s+want|put|allocate|hold|keep|set|make|increase|reduce|replace|quero|prefiro|coloque|aloque|mantenha|aumente|reduza|faça|faca)\b/iu.test(
        text,
      );
    if (
      /^(?:ignore|drop|remove|forget|esqueça|esqueca|ignore|remova)\b/iu.test(text) &&
      /\b(?:limit|requirement|constraint|minimum|maximum|limite|mínimo|minimo|máximo|maximo)\b/iu.test(
        text,
      )
    ) {
      const named = targets.filter((target) =>
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(
          text,
        ),
      );
      if (named.length > 0) for (const target of named) constraints.delete(target.key);
      else if (/\b(?:that|this|esse|este)\b/iu.test(text) && last) constraints.delete(last.key);
      continue;
    }
    if (
      !instruction ||
      /\b(?:do\s+not|don't|não|nao)\s+(?:want|quero|allocate|put|increase|invest)\b/iu.test(text)
    )
      continue;
    const percent =
      /(?:(at\s+least|at\s+most|no\s+more\s+than|minimum|maximum|exactly|pelo\s+menos|no\s+m[ií]nimo|no\s+m[aá]ximo)\s*)?(\d+(?:[.,]\d+)?)\s*%/giu;
    for (const match of text.matchAll(percent)) {
      const bps = Number(match[2]?.replace(',', '.')) * 100;
      if (!Number.isInteger(bps) || bps < 0 || bps > 10000) continue;
      const after =
        text
          .slice((match.index ?? 0) + match[0].length)
          .split(/[,;.!?](?!\d)|\b(?:and|but|e|mas)\b/iu)[0] ?? '';
      const before =
        text
          .slice(0, match.index)
          .split(/[,;.!?](?!\d)|\b(?:and|but|e|mas)\b/iu)
          .at(-1) ?? '';
      const named = targets.filter((target) =>
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(
          after,
        ),
      );
      const beforeNames =
        named.length === 0
          ? targets.filter((target) =>
              new RegExp(
                `(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`,
                'iu',
              ).test(before),
            )
          : [];
      const wholeNames = targets.filter((target) =>
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${target.words.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(
          text,
        ),
      );
      const target =
        named.length === 1
          ? named[0]
          : beforeNames.length === 1
            ? beforeNames[0]
            : named.length === 0 && beforeNames.length === 0 && /^make\s+that\b/iu.test(text)
              ? last
              : named.length === 0 && beforeNames.length === 0 && wholeNames.length === 1
                ? wholeNames[0]
                : undefined;
      if (!target) continue;
      const bound = match[1]?.toLocaleLowerCase() ?? '';
      const minimum = /least|minimum|pelo\s+menos|m[ií]nimo/u.test(bound);
      const maximum = /most|no\s+more|maximum|m[aá]ximo/u.test(bound);
      last = {
        key: target.key,
        matches: target.matches,
        min: maximum ? 0 : bps,
        max: minimum ? 10000 : bps,
        quote: text,
      };
      constraints.set(target.key, last);
    }
  }
  return [...constraints.values()];
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
  const constraints = holdingConstraints(parsed.data.messages, [...catalog.values()]);
  const goal = eligibilityGoal(context);
  const companies = new Map<string, string[]>();
  for (const row of context.stockAttributes?.stocks ?? [])
    for (const asset of catalog.values())
      if (asset.symbol === row.symbol) companies.set(asset.id, [row.company]);
  const requested = requestedAssets(
    parsed.data.messages,
    [...catalog.values()],
    companies,
    constraints,
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
    allocationConstraints: constraints.map((constraint) => ({
      assetIds: [...catalog.values()].filter(constraint.matches).map((asset) => asset.id),
      minWeightBps: constraint.min,
      maxWeightBps: constraint.max,
      personQuote: constraint.quote,
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
  const check = (output: Output): Checked => {
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
          },
        },
      };
    const ids = new Set<string>();
    const sources = new Set<string>();
    const warnings: VaultAgentWarning[] = [];
    let sum = 0;
    for (const allocation of proposal.allocations) {
      const asset = catalog.get(allocation.assetId);
      if (!asset) return rejected('allocation_unlisted');
      if (ids.has(asset.id)) return rejected('allocation_duplicate');
      // Any listed composition may be proposed (ANY-COMPOSITION): exit capacity and a goal's
      // eligibility warn; only an asset outside the goal that the person never asked for is refused.
      const cap = caps[asset.id];
      if (cap !== undefined && allocation.weightBps > cap) {
        warnings.push({
          code: 'over_exit_capacity',
          assetId: asset.id,
          evidenceId: `liquidity:${asset.id}`,
        });
        sources.add(`liquidity:${asset.id}`);
      }
      if (goal && !eligibleForGoal(asset, goal)) {
        if (!requested.has(asset.id)) return rejected('allocation_ineligible');
        const listed = sourceById.has(`catalog:${asset.id}`)
          ? `catalog:${asset.id}`
          : allocation.evidenceIds[0];
        if (listed) {
          warnings.push({ code: 'outside_goal_requested', assetId: asset.id, evidenceId: listed });
          sources.add(listed);
        }
      }
      ids.add(asset.id);
      sum += allocation.weightBps;
      for (const id of allocation.evidenceIds) {
        const source = sourceById.get(id);
        if (!source || (source.assetId !== undefined && source.assetId !== asset.id))
          return rejected('allocation_evidence');
        sources.add(id);
      }
    }
    if (sum !== 10_000) return rejected('allocation_sum');
    if (
      proposal.allocations.filter((allocation) => catalog.get(allocation.assetId)?.cls !== 'cash')
        .length > 16
    )
      return rejected('allocation_lines');
    for (const [index, constraint] of constraints.entries()) {
      const actual = proposal.allocations.reduce((weight, allocation) => {
        const asset = catalog.get(allocation.assetId);
        return weight + (asset && constraint.matches(asset) ? allocation.weightBps : 0);
      }, 0);
      if (actual < constraint.min || actual > constraint.max) {
        // Which limit, in words: the server's own constraint and the person's quote, never the model's weights.
        const side = actual < constraint.min ? 'below its minWeightBps' : 'above its maxWeightBps';
        return {
          failed: 'allocation_constraint',
          problems: [
            REPAIR_HINTS.allocation_constraint ?? 'allocation_constraint',
            `At allocationConstraints.${index} (the person said “${constraint.quote}”): the weightBps of its assetIds together came ${side}.`,
          ],
          result: {
            kind: 'reply',
            reply: {
              version: 1,
              messageId: request.messageId,
              proposal: null,
              warnings: [],
              message:
                request.language === 'pt'
                  ? `A proposta não respeitou seu pedido: “${constraint.quote}”. Esse limite continua valendo; nada foi aplicado.`
                  : `The draft did not meet your request: “${constraint.quote}”. That requirement still stands; nothing was applied.`,
              question:
                request.language === 'pt'
                  ? 'Quer que eu proponha outra divisão respeitando esse limite, ou prefere alterá-lo?'
                  : 'Would you like another draft within that limit, or would you like to change the requirement?',
            },
          },
        };
      }
    }
    const reply = VaultAgentReply.safeParse({
      version: 1,
      messageId: request.messageId,
      ...conversation,
      proposal: {
        ...proposal,
        allocations: proposal.allocations.map((allocation) => ({
          ...allocation,
          symbol: catalog.get(allocation.assetId)?.symbol,
        })),
        unknowns: [...new Set([...context.unknowns, ...proposal.unknowns])].slice(0, 12),
        sources: [...sources].map((id) => sourceById.get(id)),
      },
      warnings,
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
