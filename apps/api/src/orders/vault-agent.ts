import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { eligibleForGoal, PERSONAL_PARAMS } from '@colosseum/engine/personal';
import type {
  BasketAsset,
  ChainId,
  FactNullReason,
  FactRegime,
  FactUnit,
  Price,
  Provenance,
  Shelf,
  VaultState,
} from '@colosseum/schemas';
import {
  type VaultAgentSource as AgentSource,
  VaultAgentModelReply,
  VaultAgentReply,
  VaultAgentRequest,
  type VaultAgentResult,
  VaultAgentSource,
} from '@colosseum/schemas';
import type { VaultAgentModel, VaultAgentRepair } from '../vault-agent-model';
import type { ChainEntry } from './chains';
import type { PlanInputs } from './personalize';

type Figures = Awaited<ReturnType<PlanInputs>>;

/** One figure of an asset's analytics: a measured value with its pin, or null with the reason. */
type AnalyticsMetric = {
  metric:
    | 'exit_worst'
    | 'exit'
    | 'weekend'
    | 'lp_top1'
    | 'lp_exit'
    | 'cap_variation'
    | 'volume_28d'
    | 'volatility'
    | 'drawdown';
  regime?: FactRegime;
};
export type AnalyticsFigure =
  | (AnalyticsMetric & {
      value: number;
      unit: FactUnit;
      source: string;
      method: string;
      fetchedAt: string;
      provenance: Provenance;
      /** Measured at this size, not the analytics' size: the nearest grid point above it. */
      sizeUsd?: number;
      /** The true value is at least this: the deepest point the data measures. */
      lowerBound?: boolean;
    })
  | (AnalyticsMetric & { value: null; reason: FactNullReason });
/**
 * Bearing's figures for the listed assets at one size, projected from their fact sheets on the server
 * (agent-analytics.ts). `modelledOn` names the mainnet token a test-network token's figures are read from.
 * Null figures: Bearing has no sheet for the asset, or, with `unread`, its sheet is still being read or its
 * read failed. `unavailable` and `incomplete`: codes, for the log.
 */
export type AgentAnalyticsResult =
  | {
      sizeUsd: number;
      basis: 'reference' | 'vault';
      /** Cost tolerance behind the capacity figures, as a fraction. */
      tau: number;
      assets: Array<{
        assetId: string;
        modelledOn: string | null;
        figures: AnalyticsFigure[] | null;
        unread?: 'reading' | 'failed';
      }>;
      incomplete?: string;
    }
  | { unavailable: string };
type AgentAnalyticsQuery = {
  db: Parameters<PlanInputs>[0]['db'];
  chain: ChainId;
  assets: BasketAsset[];
  provenance?: Provenance;
  /** The size the costs refer to: the vault's value, or null for the reference size. */
  sizeUsd: number | null;
};
/**
 * Reads the analytics; injected, like `PlanInputs`, so nothing under /v1 reads a file or a fixture. `warm`
 * keeps a chain's reference-size reads current from the server's start; `stop` ends that.
 */
export type AgentAnalytics = ((q: AgentAnalyticsQuery) => Promise<AgentAnalyticsResult>) & {
  warm?: (q: Omit<AgentAnalyticsQuery, 'sizeUsd'>) => void;
  stop?: () => void;
};
/** The code a route logs for analytics that were not all read, or null. */
export function analyticsGap(read: AgentAnalyticsResult | null): string | null {
  if (!read) return null;
  return 'unavailable' in read ? read.unavailable : (read.incomplete ?? null);
}

/** The analytics when the server has a reader. A reader that throws is a code, never a failed reply. */
export async function readAgentAnalytics(
  read: AgentAnalytics | undefined,
  query: Parameters<AgentAnalytics>[0],
): Promise<AgentAnalyticsResult | null> {
  if (!read) return null;
  try {
    return await read(query);
  } catch {
    return { unavailable: 'analytics_threw' };
  }
}
type AgentContextData = {
  person: string;
  assets: BasketAsset[];
  evidence: AgentSource[];
  currentGoals: readonly unknown[];
  stockAttributes: Figures['stocks'] | null;
  liquidity: Array<{ assetId: string; observation: unknown | null }>;
  unknowns: string[];
  /** Bearing's analytics behind the evidence, for the model: their size and what is not measured. */
  analytics?: VaultAgentPrompt['analytics'];
  /** Additional server guardrail caps; these never determine allocation weights. */
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
  /** What the model cites; source and method stay on the server, which writes them into the reply. */
  evidence: Array<Pick<AgentSource, 'id' | 'assetId' | 'label' | 'value' | 'unit' | 'provenance'>>;
  /** The stock rows without their source lists, which are evidence already (`stock:<asset>:<n>`). */
  stockAttributes:
    | (Omit<NonNullable<Figures['stocks']>, 'stocks'> & {
        stocks: Array<Omit<NonNullable<Figures['stocks']>['stocks'][number], 'sources'>>;
      })
    | null;
  liquidity: VaultAgentContext['liquidity'];
  unknowns: string[];
  /**
   * The size Bearing's analytics evidence refers to, and the figures it does not measure with why. Null
   * when no analytics were read.
   */
  analytics: {
    sizeUsd?: number;
    basis?: 'reference' | 'vault';
    /** What each id measures, `<asset>` standing for the asset's id; units are in the evidence. */
    legend?: Record<string, string>;
    /** The measured figures by id, each id citable as evidence of its asset. */
    assets?: Array<{
      assetId: string;
      values: Record<string, number>;
      /** One label for every figure, or each figure's. */
      provenance: Provenance | Record<string, Provenance>;
      modelledOn?: string;
      worstRegime?: FactRegime;
      /** Ids whose value is a lower bound: the true figure is at least this. */
      lowerBound?: string[];
      /** Ids measured at the nearest measured size above `sizeUsd`. */
      largerSize?: string[];
    }>;
    unknowns: string[];
  } | null;
  /** The cost tolerance behind every capacity figure, as a fraction. */
  exitCostTolerance: number;
  caps: Record<string, number>;
  eligibilityGoal: 'grow' | 'income' | 'protect' | null;
  /** Person-authored limits projected onto the supplied catalog, never allocation choices. */
  allocationConstraints: Array<{
    assetIds: string[];
    minWeightBps: number;
    maxWeightBps: number;
    personQuote: string;
  }>;
};

/** Cash is the residual balance, not a capped creator target (compose's cash convention). */
function catalogCap(asset: BasketAsset): number {
  return asset.cls === 'cash' ? 10000 : asset.maxWeightBps;
}

/** This reads observations and guardrails only. It never calls an allocator, stores, or trades. */
type ContextInput = {
  entry: ChainEntry;
  prices: Price[];
  prepared: { shelf: Shelf; figures: Figures };
  person: string;
  currentGoals?: readonly unknown[];
  caps?: Record<string, number>;
  confirmedGoal?: 'grow' | 'income' | 'protect';
  analytics?: AgentAnalyticsResult | null;
};

/** The vault's value at the reference prices, or null when a holding has no usable price. */
export function vaultNotionalUsd(state: VaultState, prices: Price[]): number | null {
  const byAsset = new Map(prices.map((price) => [price.asset, Number(price.usdPerToken)]));
  const values = [state.cash, ...state.positions].map((holding) => {
    const price = byAsset.get(holding.asset);
    return price === undefined ? null : Number(holding.display) * price;
  });
  return values.every((value) => value !== null && Number.isFinite(value))
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

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

const REGIME_NAMES: Record<FactRegime, string> = {
  us_market_hours: 'US market hours',
  us_offhours_weekday: 'weekday off-hours',
  weekend: 'weekend',
  us_holiday: 'US holiday',
};
const NULL_REASONS: Record<FactNullReason, string> = {
  no_samples_in_regime: 'no samples in that regime yet',
  insufficient_samples: 'too few samples',
  beyond_measured_size: 'the size is beyond the measured depth',
  no_reference_price: 'no reference prices collected',
  no_external_source: 'no external price source',
  chain_not_covered: 'this chain is not measured',
  not_collected: 'not collected yet',
  not_imported: 'not imported yet',
  not_followed: 'not traced',
  gate_open: 'waiting on a decision',
  not_applicable: 'does not apply',
};
const UNITS: Record<FactUnit, string> = {
  fraction: 'fraction',
  usd: 'USD',
  ratio: 'ratio',
  count: 'count',
  hours: 'hours',
};

/** What each analytics id measures, for the model's legend and, with the asset's details, the reply. */
const MEASURES: Record<AnalyticsFigure['metric'], { id: string; says: string }> = {
  exit_worst: { id: 'exit:<asset>:worst', says: 'Exit cost at {size}, worst measured regime' },
  exit: { id: 'exit:<asset>:<regime>', says: 'Exit cost at {size} in that regime' },
  weekend: { id: 'weekend:<asset>', says: 'Weekend ÷ market-hours exit capacity' },
  lp_top1: {
    id: 'lp:<asset>:top1',
    says: "Largest liquidity provider's share of the main dollar pool",
  },
  lp_exit: {
    id: 'lpexit:<asset>',
    says: 'Exit cost at {size} if the largest liquidity providers leave',
  },
  cap_variation: {
    id: 'capvar:<asset>',
    says: 'How much exit capacity varies between snapshots (deviation ÷ mean)',
  },
  volume_28d: { id: 'volume:<asset>', says: 'Traded volume over the last four weeks' },
  volatility: { id: 'vol:<asset>', says: 'Annualised price volatility' },
  drawdown: { id: 'drawdown:<asset>', says: 'Largest price drawdown' },
};
const LOWER_BOUND = '; a lower bound, the true figure is at least this';

/**
 * Bearing's analytics as evidence: each measured figure an id the model may cite, with a label that says
 * the size and the regime it refers to in words (the figures themselves are structured, so a label holds
 * no number the model could repeat); each missing one a line of what is unknown and why, never zero, one
 * line per figure and reason with the assets it holds for. The model reads the figures as one compact
 * block; the full sources stay on the server for the reply.
 */
function analyticsEvidence(
  analytics: AgentAnalyticsResult | null,
  listed: Map<string, BasketAsset>,
): { evidence: AgentSource[]; prompt: NonNullable<VaultAgentPrompt['analytics']> } | null {
  if (!analytics) return null;
  const evidence: AgentSource[] = [];
  const unknowns: string[] = [];
  if ('unavailable' in analytics)
    return {
      evidence,
      prompt: {
        unknowns: [
          "Bearing's exit, liquidity and market analytics could not be read for this reply; those figures are unknown, not zero.",
        ],
      },
    };
  const size = analytics.basis === 'vault' ? "about the vault's size" : 'the reference size';
  const unsheeted: string[] = [];
  const unread = { reading: [] as string[], failed: [] as string[] };
  const read: string[] = [];
  const missing = new Map<string, string[]>();
  const assets: NonNullable<NonNullable<VaultAgentPrompt['analytics']>['assets']> = [];
  for (const row of analytics.assets) {
    const asset = listed.get(row.assetId);
    if (!asset || asset.cls === 'cash') continue;
    if (row.unread) {
      unread[row.unread].push(asset.symbol);
      continue;
    }
    if (!row.figures) {
      unsheeted.push(asset.symbol);
      continue;
    }
    read.push(asset.symbol);
    const compact: (typeof assets)[number] = { assetId: asset.id, values: {}, provenance: {} };
    for (const figure of row.figures) {
      const regime = figure.regime ? REGIME_NAMES[figure.regime] : null;
      const measure = MEASURES[figure.metric];
      const id = measure.id
        .replace('<asset>', asset.id)
        .replace('<regime>', figure.regime ?? 'unknown');
      const larger = figure.value !== null && figure.sizeUsd !== undefined;
      const said = measure.says.replace(
        '{size}',
        larger ? `the nearest measured size above ${size}` : size,
      );
      const label =
        figure.metric === 'exit_worst' ||
        figure.metric === 'exit' ||
        figure.metric === 'cap_variation'
          ? `${said}${regime ? ` (${regime})` : ''}`
          : said;
      const twin = row.modelledOn ? `; ${row.modelledOn} mainnet figures on a test network` : '';
      // A stored figure that does not make a valid source is unknown too: it never fails the reply.
      const parsed =
        figure.value === null
          ? null
          : VaultAgentSource.safeParse({
              id,
              assetId: asset.id,
              label: `${label}${figure.lowerBound ? LOWER_BOUND : ''}${twin}`,
              value: figure.value,
              unit: UNITS[figure.unit],
              source: figure.source,
              // the size it was measured at is a figure: it goes in the pin, not in the words
              method:
                figure.sizeUsd === undefined
                  ? figure.method
                  : `${figure.method}; measured at $${figure.sizeUsd.toLocaleString('en-US')}`,
              fetchedAt: figure.fetchedAt,
              provenance: figure.provenance,
            });
      if (parsed?.success && figure.value !== null) {
        evidence.push(parsed.data);
        compact.values[id] = parsed.data.value as number;
        (compact.provenance as Record<string, Provenance>)[id] = parsed.data.provenance;
        if (figure.metric === 'exit_worst' && figure.regime) compact.worstRegime = figure.regime;
        if (figure.lowerBound) compact.lowerBound = [...(compact.lowerBound ?? []), id];
        if (larger) compact.largerSize = [...(compact.largerSize ?? []), id];
        continue;
      }
      const reason =
        figure.value === null ? NULL_REASONS[figure.reason] : 'the stored figure could not be read';
      const line = `${label}: unknown (${reason})`;
      missing.set(line, [...(missing.get(line) ?? []), asset.symbol]);
    }
    // One label when every figure of the asset has the same, which is the usual case.
    const labels = new Set(Object.values(compact.provenance as Record<string, Provenance>));
    if (labels.size <= 1) compact.provenance = [...labels][0] ?? asset.provenance;
    if (row.modelledOn) compact.modelledOn = row.modelledOn;
    if (Object.keys(compact.values).length) assets.push(compact);
  }
  for (const [line, symbols] of missing)
    unknowns.push(
      `${line}, for ${symbols.length === read.length && read.length > 1 ? 'every asset with a sheet' : symbols.join(', ')}.`,
    );
  if (unsheeted.length)
    unknowns.push(
      `No Bearing fact sheet, so exit, liquidity and market figures are unknown, for ${unsheeted.join(', ')}.`,
    );
  if (unread.reading.length)
    unknowns.push(
      `Bearing's figures are still being read, so unknown for this reply, for ${unread.reading.join(', ')}.`,
    );
  if (unread.failed.length)
    unknowns.push(
      `Bearing's figures could not be read this time, so unknown for this reply, for ${unread.failed.join(', ')}.`,
    );
  return {
    evidence,
    prompt: {
      sizeUsd: analytics.sizeUsd,
      basis: analytics.basis,
      legend: Object.fromEntries(
        Object.values(MEASURES).map((m) => [m.id, m.says.replace('{size}', size)]),
      ),
      assets,
      unknowns,
    },
  };
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
      label: `${asset.symbol} catalog cap`,
      value: catalogCap(asset),
      unit: 'bps',
      source: entry.source,
      fetchedAt: input.observedAt,
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
  const notionalUsd = state ? vaultNotionalUsd(state, input.prices) : null;
  if (notionalUsd === null)
    unknowns.push(
      state
        ? 'Some current holdings lack a usable reference price; the full vault value is unknown.'
        : 'No planning amount has been confirmed for this new goal; size-dependent exit capacity and feasibility are unknown. There is no existing vault or current holdings.',
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
  // Size-free for a new goal, which has no amount yet: the most that sells at the cost tolerance.
  const measuredCapacity = new Set<string>();
  const provider = prepared.figures.liquidity?.provider;
  if (input.kind === 'new_goal' && provider && prepared.figures.liquidity)
    for (const asset of assets) {
      if (asset.cls === 'cash') continue;
      const capacity = provider.exitCapacity(asset.id, PERSONAL_PARAMS.tau, EXIT_WINDOW_DAYS);
      if (!capacity || capacity.samples <= 0 || !capacity.dataTo) continue;
      // A reading that does not make a valid source is not measured: the unknown below says so.
      const source = VaultAgentSource.safeParse({
        id: `capacity:${asset.id}`,
        assetId: asset.id,
        label: `Largest sale within the cost tolerance, worst regime of the exit window; does not depend on an amount${capacity.lowerBound ? LOWER_BOUND : ''}`,
        value: capacity.capacityUsd,
        unit: 'USD',
        source: prepared.figures.liquidity.source,
        fetchedAt: capacity.dataTo,
        method: `${provider.methodVersion}; cost tolerance ${PERSONAL_PARAMS.tau}`,
        provenance: provider.provenance,
      });
      if (!source.success) continue;
      measuredCapacity.add(asset.id);
      evidence.push(source.data);
    }
  const analytics = analyticsEvidence(input.analytics ?? null, listed);
  for (const source of analytics?.evidence ?? []) add(source);
  if (
    liquidity.some(
      (item) =>
        listed.get(item.assetId)?.cls !== 'cash' &&
        item.observation === null &&
        !measuredCapacity.has(item.assetId),
    )
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
    ...(analytics ? { analytics: analytics.prompt } : {}),
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
  allocation_over_cap: "An allocation's weightBps was above that asset's limit in caps.",
  allocation_ineligible:
    'An allocation used an asset that is not eligible for eligibilityGoal: stocks are not eligible for income or protect.',
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
  const caps = Object.fromEntries(
    [...catalog.values()].map((asset) => [
      asset.id,
      Math.min(catalogCap(asset), context.caps?.[asset.id] ?? catalogCap(asset)),
    ]),
  );
  if (Object.values(caps).some((cap) => !Number.isInteger(cap) || cap < 0 || cap > 10_000))
    return invalid('context_caps');
  const inAnalytics = new Set(
    (context.analytics?.assets ?? []).flatMap((row) => Object.keys(row.values)),
  );
  const constraints = holdingConstraints(parsed.data.messages, [...catalog.values()]);
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
    // The analytics' figures go once, in their compact block; every other source goes here.
    evidence: [...sourceById.values()]
      .filter(({ id }) => !inAnalytics.has(id))
      .map(({ id, assetId, label, value, unit, provenance }) => ({
        id,
        ...(assetId === undefined ? {} : { assetId }),
        ...(label === undefined ? {} : { label }),
        ...(value === undefined ? {} : { value }),
        ...(unit === undefined ? {} : { unit }),
        provenance,
      })),
    stockAttributes: context.stockAttributes
      ? {
          ...context.stockAttributes,
          stocks: context.stockAttributes.stocks.map(({ sources: _sources, ...row }) => row),
        }
      : null,
    liquidity: context.liquidity,
    unknowns: context.unknowns,
    analytics: context.analytics ?? null,
    exitCostTolerance: PERSONAL_PARAMS.tau,
    caps,
    eligibilityGoal: eligibilityGoal(context),
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
          reply: { version: 1, messageId: request.messageId, ...conversation, proposal: null },
        },
      };
    const ids = new Set<string>();
    const sources = new Set<string>();
    let sum = 0;
    for (const allocation of proposal.allocations) {
      const asset = catalog.get(allocation.assetId);
      if (!asset) return rejected('allocation_unlisted');
      if (ids.has(asset.id)) return rejected('allocation_duplicate');
      if (allocation.weightBps > (caps[asset.id] ?? 0)) return rejected('allocation_over_cap');
      if (prompt.eligibilityGoal && !eligibleForGoal(asset, prompt.eligibilityGoal))
        return rejected('allocation_ineligible');
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
