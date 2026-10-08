import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { eligibleForGoal, PERSONAL_PARAMS } from '@colosseum/engine/personal';
import type { BasketAsset, Price, Shelf, VaultState } from '@colosseum/schemas';
import {
  type VaultAgentSource as AgentSource,
  VaultAgentModelReply,
  VaultAgentReply,
  VaultAgentRequest,
  type VaultAgentResult,
  VaultAgentSource,
} from '@colosseum/schemas';
import type { VaultAgentModel } from '../vault-agent-model';
import type { ChainEntry } from './chains';
import type { PlanInputs } from './personalize';

type Figures = Awaited<ReturnType<PlanInputs>>;
export type VaultAgentContext = {
  person: string;
  state: VaultState;
  assets: BasketAsset[];
  evidence: AgentSource[];
  currentGoals: readonly unknown[];
  stockAttributes: Figures['stocks'] | null;
  liquidity: Array<{ assetId: string; observation: unknown | null }>;
  unknowns: string[];
  /** Additional server guardrail caps; these never determine allocation weights. */
  caps?: Record<string, number>;
  /** Only a separately confirmed, server-owned goal change can replace existing eligibility. */
  confirmedGoal?: 'grow' | 'income' | 'protect';
};
export type VaultAgentPrompt = {
  version: 1;
  language: 'en' | 'pt';
  messages: VaultAgentRequest['messages'];
  latestPerson: string;
  vault: VaultState;
  currentGoals: readonly unknown[];
  catalog: Array<
    Pick<
      BasketAsset,
      | 'id'
      | 'symbol'
      | 'underlying'
      | 'cls'
      | 'tier'
      | 'issuer'
      | 'maxWeightBps'
      | 'provenance'
      | 'sheet'
    >
  >;
  evidence: AgentSource[];
  stockAttributes: Figures['stocks'] | null;
  liquidity: VaultAgentContext['liquidity'];
  unknowns: string[];
  caps: Record<string, number>;
  eligibilityGoal: 'grow' | 'income' | 'protect' | null;
};

/** Cash is the residual balance, not a capped creator target (compose's cash convention). */
function catalogCap(asset: BasketAsset): number {
  return asset.cls === 'cash' ? 10000 : asset.maxWeightBps;
}

/** This reads observations and guardrails only. It never calls an allocator, stores, or trades. */
export function buildVaultAgentContext(input: {
  state: VaultState;
  entry: ChainEntry;
  prices: Price[];
  prepared: { shelf: Shelf; figures: Figures };
  person: string;
  currentGoals?: readonly unknown[];
  caps?: Record<string, number>;
  confirmedGoal?: 'grow' | 'income' | 'protect';
}): VaultAgentContext {
  const { state, entry, prepared } = input;
  const assets = prepared.shelf.assets.filter((asset) => asset.chain === state.chain);
  const listed = new Map(assets.map((asset) => [asset.id, asset]));
  const evidence: AgentSource[] = [];
  const add = (source: AgentSource) => {
    evidence.push(VaultAgentSource.parse(source));
  };
  for (const asset of assets) {
    add({
      id: `catalog:${asset.id}`,
      assetId: asset.id,
      label: `${asset.symbol} catalog cap`,
      value: catalogCap(asset),
      unit: 'bps',
      source: entry.source,
      fetchedAt: state.observedAt,
      method:
        asset.cls === 'cash'
          ? 'listed asset catalog; cash residual has no catalog holding cap'
          : 'listed asset catalog',
      provenance: entry.provenance,
    });
    const tier = prepared.figures.tiers?.find((row) => row.assetId === asset.id);
    add({
      id: `tier:${asset.id}`,
      assetId: asset.id,
      label: `Risk tier ${tier?.tier ?? asset.tier}`,
      source: tier?.source ?? entry.source,
      fetchedAt: tier?.fetchedAt ?? state.observedAt,
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
  const holdings = [state.cash, ...state.positions];
  const prices = new Map(input.prices.map((price) => [price.asset, Number(price.usdPerToken)]));
  const values = holdings.map((holding) => {
    const price = prices.get(holding.asset);
    return price === undefined ? null : Number(holding.display) * price;
  });
  const notionalUsd = values.every((value) => value !== null && Number.isFinite(value))
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  if (notionalUsd === null)
    unknowns.push(
      'Some current holdings lack a usable reference price; the full vault value is unknown.',
    );
  const caps = { ...input.caps };
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
      caps[asset.id] = Math.min(
        catalogCap(asset),
        caps[asset.id] ?? catalogCap(asset),
        Math.min(10000, Math.floor((observation.capacityUsd / notionalUsd) * 10000)),
      );
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
    unknowns.push('No sourced yield observations were returned for this vault catalog.');
  if (!input.currentGoals?.length && !input.confirmedGoal)
    unknowns.push(
      'The current investment goal is unavailable; this preview has not been checked against income or protection eligibility.',
    );
  return {
    person: input.person,
    state,
    assets,
    evidence,
    currentGoals: input.currentGoals ?? [],
    stockAttributes: prepared.figures.stocks ?? null,
    liquidity,
    unknowns,
    caps,
    ...(input.confirmedGoal ? { confirmedGoal: input.confirmedGoal } : {}),
  };
}

function eligibilityGoal(context: VaultAgentContext): 'grow' | 'income' | 'protect' | null {
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

function claimsApplied(text: string): boolean {
  return (
    /\bi\s+(?:have\s+)?(?:changed|applied|updated|rebalanced)\s+(?:your|the)\s+(?:vault|portfolio|strategy|allocations?)\b/iu.test(
      text,
    ) ||
    /\b(?:eu\s+)?(?:alterei|apliquei|atualizei|rebalanceei)\s+(?:o\s+seu|a\s+sua|seu|sua|o|a)\s+(?:cofre|carteira|estratégia|estrategia|alocação|alocacao|alocações|alocacoes)\b/iu.test(
      text,
    )
  );
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
    {
      key: 'stocks',
      words: ['stocks?', 'shares?', 'equities', 'ações', 'acoes'],
      matches: (asset) => asset.cls === 'stock' || asset.cls === 'etf',
    },
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
    if (
      /^["“‘']|\b(?:if|should\s+i|my\s+friend|my\s+advisor|someone|said|quoted|explain|understand|discuss|talk\s+about|learn|example|se\s+eu|meu\s+amigo|disse|entender|discutir|exemplo)\b/iu.test(
        text,
      )
    )
      continue;
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
  context: VaultAgentContext,
  model: VaultAgentModel | null,
): Promise<VaultAgentResult> {
  const parsed = VaultAgentRequest.safeParse(request);
  if (!parsed.success) return { kind: 'failure', reason: 'invalid' };
  if (!model) return { kind: 'failure', reason: 'unavailable' };
  if (hasNonFiniteNumber(context)) return { kind: 'failure', reason: 'invalid' };
  const sourceById = new Map<string, AgentSource>();
  for (const raw of context.evidence) {
    const source = VaultAgentSource.safeParse(raw);
    if (!source.success || sourceById.has(source.data.id))
      return { kind: 'failure', reason: 'invalid' };
    sourceById.set(source.data.id, source.data);
  }
  const catalog = new Map(
    context.assets
      .filter((asset) => asset.chain === context.state.chain)
      .map((asset) => [asset.id, asset]),
  );
  const caps = Object.fromEntries(
    [...catalog.values()].map((asset) => [
      asset.id,
      Math.min(catalogCap(asset), context.caps?.[asset.id] ?? catalogCap(asset)),
    ]),
  );
  if (Object.values(caps).some((cap) => !Number.isInteger(cap) || cap < 0 || cap > 10_000))
    return { kind: 'failure', reason: 'invalid' };
  const prompt: VaultAgentPrompt = {
    version: 1,
    language: parsed.data.language,
    messages: parsed.data.messages,
    latestPerson: parsed.data.messages.at(-1)?.text ?? '',
    vault: context.state,
    currentGoals: context.currentGoals,
    catalog: [...catalog.values()].map(
      ({ id, symbol, underlying, cls, tier, issuer, maxWeightBps, provenance, sheet }) => ({
        id,
        symbol,
        underlying,
        cls,
        tier,
        issuer,
        maxWeightBps: cls === 'cash' ? 10000 : maxWeightBps,
        provenance,
        sheet,
      }),
    ),
    evidence: [...sourceById.values()],
    stockAttributes: context.stockAttributes,
    liquidity: context.liquidity,
    unknowns: context.unknowns,
    caps,
    eligibilityGoal: eligibilityGoal(context),
  };
  let output: Awaited<ReturnType<VaultAgentModel['read']>>;
  try {
    output = await model.read(context.person, prompt);
  } catch {
    return { kind: 'failure', reason: 'unavailable' };
  }
  if (output.reply === null)
    return { kind: 'failure', reason: 'why' in output ? output.why : 'invalid' };
  const candidate = VaultAgentModelReply.safeParse(output.reply);
  if (!candidate.success) return { kind: 'failure', reason: 'invalid' };
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
  if (
    prose.some((text) => hasFinancialFigure(text, personWords, catalogNames) || claimsApplied(text))
  )
    return { kind: 'failure', reason: 'invalid' };
  if (!proposal)
    return {
      kind: 'reply',
      reply: { version: 1, messageId: request.messageId, ...conversation, proposal: null },
    };
  const ids = new Set<string>();
  const sources = new Set<string>();
  let sum = 0;
  for (const allocation of proposal.allocations) {
    const asset = catalog.get(allocation.assetId);
    if (
      !asset ||
      ids.has(asset.id) ||
      allocation.weightBps > (caps[asset.id] ?? 0) ||
      (prompt.eligibilityGoal && !eligibleForGoal(asset, prompt.eligibilityGoal))
    )
      return { kind: 'failure', reason: 'invalid' };
    ids.add(asset.id);
    sum += allocation.weightBps;
    for (const id of allocation.evidenceIds) {
      const source = sourceById.get(id);
      if (!source || (source.assetId !== undefined && source.assetId !== asset.id))
        return { kind: 'failure', reason: 'invalid' };
      sources.add(id);
    }
  }
  if (sum !== 10_000) return { kind: 'failure', reason: 'invalid' };
  for (const constraint of holdingConstraints(parsed.data.messages, [...catalog.values()])) {
    const actual = proposal.allocations.reduce((weight, allocation) => {
      const asset = catalog.get(allocation.assetId);
      return weight + (asset && constraint.matches(asset) ? allocation.weightBps : 0);
    }, 0);
    if (actual < constraint.min || actual > constraint.max) {
      return {
        kind: 'reply',
        reply: {
          version: 1,
          messageId: request.messageId,
          proposal: null,
          message:
            request.language === 'pt'
              ? `A proposta não respeitou seu pedido: “${constraint.quote}”. Esse limite continua valendo; nada foi aplicado.`
              : `The draft did not meet your request: “${constraint.quote}”. That requirement still stands; nothing was applied.`,
          question:
            request.language === 'pt'
              ? 'Quer que eu proponha outra divisão respeitando esse limite, ou prefere alterá-lo?'
              : 'Would you like another draft within that limit, or would you like to change the requirement?',
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
  });
  return reply.success
    ? { kind: 'reply', reply: reply.data }
    : { kind: 'failure', reason: 'invalid' };
}
