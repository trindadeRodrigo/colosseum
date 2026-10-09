import { EXIT_WINDOW_DAYS, personWeights } from '@colosseum/basket';
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
  VaultAgentStatedPurpose,
  VaultState,
} from '@colosseum/schemas';
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
import { statedPurpose } from './stated-purpose';

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
  /** The chain's curated theme lists, for the relaxed intake's investable sheet (RELAXED-INTAKE). */
  themes?: NonNullable<Figures['themes']>;
  liquidity: Array<{ assetId: string; observation: unknown | null }>;
  unknowns: string[];
  /** Bearing's analytics behind the evidence, for the model: their size and what is not measured. */
  analytics?: VaultAgentPrompt['analytics'];
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
  /** Measured exit capacity as a share of the vault; above it is allowed and warned, not refused. */
  exitCapacityBps: Record<string, number>;
  eligibilityGoal: 'grow' | 'income' | 'protect' | null;
  /**
   * For a new goal, the goal and risk the server read in the person's own messages, null where it read
   * none, so the model asks for what is missing. Null for a vault.
   */
  statedPurpose: VaultAgentStatedPurpose | null;
  /** The listed assets a plan for eligibilityGoal cannot hold, by the registry's rule. */
  outsideGoal: string[];
  /** The stocks among outsideGoal that the person asked for in their own words. */
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
  not_a_number: 'the computed figure was not a number',
  beyond_measured_size: 'the size is beyond the measured depth',
  no_reference_price: 'no reference prices collected',
  no_external_source: 'no external price source',
  chain_not_covered: 'this chain is not measured',
  not_collected: 'not collected yet',
  not_imported: 'not imported yet',
  not_followed: 'not traced',
  gate_open: 'waiting on a decision',
  not_applicable: 'does not apply',
  no_oracle: 'no price oracle for this asset',
};
const UNITS: Record<FactUnit, string> = {
  fraction: 'fraction',
  usd: 'USD',
  ratio: 'ratio',
  count: 'count',
  hours: 'hours',
  seconds: 'seconds',
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
  // An id names one figure: a second row for an asset, or a second figure under an id, is left out, since
  // the reply refuses a context whose evidence repeats an id.
  const taken = new Set<string>();
  for (const row of analytics.assets) {
    const asset = listed.get(row.assetId);
    if (!asset || asset.cls === 'cash' || taken.has(asset.id)) continue;
    taken.add(asset.id);
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
      if (taken.has(id)) continue;
      taken.add(id);
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
  const notionalUsd = state ? vaultNotionalUsd(state, input.prices) : null;
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
    ...(prepared.figures.themes ? { themes: prepared.figures.themes } : {}),
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

/**
 * The goal and risk the person's messages state (stated-purpose.ts), read with the catalog's names so a
 * later message about the mix ("add more Tesla") is known for what it is.
 */
export function statedPurposeIn(
  messages: VaultAgentRequest['messages'],
  context: Pick<ConversationAgentContext, 'assets' | 'stockAttributes'>,
): VaultAgentStatedPurpose {
  return statedPurpose(messages, [
    ...context.assets.flatMap((asset) => [asset.symbol, asset.underlying]),
    ...(context.stockAttributes?.stocks ?? []).flatMap((row) => [row.symbol, row.company]),
  ]);
}

export function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasNonFiniteNumber);
  return false;
}

/** Exact attributed person quotes and catalog names may contain numbers; new metrics may not. */
export function hasFinancialFigure(
  text: string,
  personWords: string[],
  catalogNames: string[],
): boolean {
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
 * The text as sentences, each with the space after it. A full stop splits only before a new line or a
 * word that does not start in lower case or with a digit, and never inside a catalog name or quotation
 * marks, so "Tesla, Inc. is listed" and a quote of the person with its attribution stay whole. A line
 * break alone ends a sentence only before a list marker: a clause that runs over the line goes with it.
 */
function sentencesOf(text: string, catalogNames: string[]): string[] {
  const held: [number, number][] = [];
  // up to the quote's last character: a full stop that ends the quote ends the sentence after it
  for (const quote of text.matchAll(/[“"][^”"]*[”"]/gu))
    held.push([quote.index, quote.index + quote[0].length - 2]);
  for (const name of new Set(catalogNames.filter((value) => /[.!?…]/u.test(value))))
    for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + name.length))
      held.push([at, at + name.length]);
  const sentences: string[] = [];
  let start = 0;
  for (const stop of text.matchAll(
    /[.!?…]+[”"'’)\]]*(?:\s*\n\s*|\s+(?![\s\p{Ll}\p{N}]))|\s*\n\s*(?=(?:[-*•–—]|\p{N}+[.)])\s)/gu,
  )) {
    if (held.some(([from, to]) => stop.index >= from && stop.index < to)) continue;
    const end = stop.index + stop[0].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

/** Said by the server in place of a required field of the proposal whose every sentence was removed. */
export const FIGURE_REMOVED = {
  en: 'This part of the draft was left out because it stated a figure that could not be confirmed.',
  pt: 'Esta parte da proposta foi omitida porque trazia um número que não pôde ser confirmado.',
};
/** Said by the server on a line of its own after what is left of a message, and once in a list that lost an item or part of one. */
export const FIGURE_CUT = {
  en: 'Part of this reply was left out because it stated a figure that could not be confirmed.',
  pt: 'Parte desta resposta foi omitida porque trazia um número que não pôde ser confirmado.',
};

/**
 * `text` without the sentences `figure` flags, and how many were cut. A figure that only shows across
 * two sentences leaves nothing of the text, and every sentence counts. Shared with the relaxed intake.
 */
export function trimFigureSentences(
  text: string,
  figure: (text: string) => boolean,
  catalogNames: string[],
): { text: string; cut: number } {
  if (!figure(text)) return { text, cut: 0 };
  const sentences = sentencesOf(text, catalogNames);
  const kept = sentences.filter((sentence) => !figure(sentence));
  const rest = kept.join('').trim();
  if (!figure(rest)) return { text: rest, cut: sentences.length - kept.length };
  return { text: '', cut: sentences.length };
}

/**
 * The repair attempt's reply without the sentences that state a figure (`figure`), so one stray number
 * does not cost the person the whole reply and none of the model's reaches them. No cut is silent where
 * a caveat may have gone with it: the message ends with the server's `FIGURE_CUT`, and a list of
 * tradeoffs or unknowns that lost an item or part of one holds it once. A question left empty is
 * dropped; an objective, a summary or a pick's reason left empty is the server's `FIGURE_REMOVED`,
 * never words made up for the model. Null when nothing of the message is left, or no room for the note.
 */
function withoutFigureSentences(
  reply: VaultAgentModelReply,
  figure: (text: string) => boolean,
  catalogNames: string[],
  language: 'en' | 'pt',
): { reply: VaultAgentModelReply; cut: number } | null {
  let cut = 0;
  const trim = (text: string): string => {
    const trimmed = trimFigureSentences(text, figure, catalogNames);
    cut += trimmed.cut;
    return trimmed.text;
  };
  const list = (items: string[]): string[] => {
    const before = cut;
    const kept = items.map(trim).filter(Boolean);
    return cut === before ? kept : [...kept.slice(0, 11), FIGURE_CUT[language]];
  };
  const message = trim(reply.message);
  const said = cut ? `${message}\n${FIGURE_CUT[language]}` : message;
  if (!message || said.length > 2400) return null;
  const { proposal } = reply;
  return {
    reply: {
      message: said,
      question: (reply.question === null ? null : trim(reply.question)) || null,
      proposal: proposal && {
        ...proposal,
        objective: trim(proposal.objective) || FIGURE_REMOVED[language],
        summary: trim(proposal.summary) || FIGURE_REMOVED[language],
        tradeoffs: list(proposal.tradeoffs),
        unknowns: list(proposal.unknowns),
        allocations: proposal.allocations.map((allocation) => ({
          ...allocation,
          why: trim(allocation.why) || FIGURE_REMOVED[language],
        })),
      },
    },
    cut,
  };
}

/**
 * What each repairable check means, in the words the model reads on its one repair call. Only checks on
 * the model's own reply are here: a timeout, a spent budget or a bad request is not the model's to fix.
 */
const REPAIR_HINTS: Record<string, string> = {
  reply_schema:
    'The reply did not match the required structure: a field was missing, had the wrong type, or was outside its length or count limits.',
  prose_figure:
    'Prose contained a financial figure, percentage, price, yield, date or written-out number. Numbers may appear in prose only inside an exact catalog name or an exact quote of the person in attributed quotation marks. The server sets the weights. Rewrite every prose field with no digit, no percent or currency sign and no "guaranteed" or "risk-free": describe a measured figure in words and cite its id in evidenceIds instead of repeating its value.',
  prose_claims_applied:
    'Prose said something was applied, created, funded, traded or approved. A proposal is only a private preview; nothing has been applied.',
  allocation_unlisted: "An allocation named an assetId that is not in this chain's catalog.",
  allocation_duplicate: 'The same assetId appeared in more than one allocation.',
  allocation_lines:
    'The proposal held more than sixteen assets besides cash; a vault holds at most sixteen.',
  allocation_ineligible:
    'An allocation used an asset that is in outsideGoal and not in requestedOutsideGoal, so the server left it out. A plan for eligibilityGoal cannot hold it: a stock only when the person asks for it themselves, any other class never. Remove it and every mention of it as proposed. For a stock the person seems to want but has not plainly asked for, ask them to confirm in question; for any other class, say that a plan with this goal cannot hold it.',
  allocation_evidence:
    'An allocation cited an evidenceId that does not exist in evidence or belongs to a different asset.',
  allocation_constraint:
    'The picks cannot meet a share the person stated, which the server read in their own words (allocationConstraints). Pick the assets it covers, with room for the rest, so the server can meet it, or ask the person about it in question. The share is theirs and still stands until they say "forget" or "drop" it, or ask for an equal split.',
  stated_ungrounded:
    'A share in stated is not one the server read in the person\'s words, so it is not applied. The server reads a share only where the person plainly asked for it with the number beside the asset ("I want 70% TSLA", "TSLA 70%", "at least 40% stocks", "70/30 TSLA and NVDA"), in a sentence with nothing else in it, no refusal and no return, yield, growth or loss word; allocationConstraints lists what it read. Remove the share, do not describe it as applied, and ask the person in question to say it as a percentage beside the asset name.',
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
// and the model is told to ask them instead. These are the words for wanting to hold or add something;
// "prefer" is not one, since it compares ("I prefer bonds to NVDA").
const ASKS_WORDS =
  "want|wanna|i'?d\\s+like|would\\s+like|add|include|put|buy|keep|allocate|invest|quero|queria|gostaria|adicione|adiciona|adicionar|inclua|inclui|incluir|compre|compra|comprar|coloque|coloca|colocar|aloque|aloca|alocar|invista|investir|bote|bota|botar|põe|ponha|pôr|manter|mantenha|mantém|mantem";
const ASKS = word(ASKS_WORDS, 'iu');
// "more NVDA" asks with no verb, but only for the name right after it.
const ASKS_OR_MORE = word(`${ASKS_WORDS}|more|mais`, 'giu');
// All that may stand between an asking word and the name it asks for ("I want [some] NVDA", "put [a
// bit of my money in] NVDA"), and all that may stand after the name ("NVDA [in my plan, please]"). Two
// short closed lists: any other word there and the name is not read as asked for. No quantity or degree
// word stands after a name ("NVDA too little"), and a number counts only as a share, with its sign.
const ASK_BEFORE_NAME = word(
  'to\\s+(?:have|hold|own|get)|exposure\\s+to|a\\s+(?:bit|little|lot)(?:\\s+of)?|at\\s+least|exactly|some|a|an|the|of|in|into|my|me|more|also|just|tokenized|half|money|ter|exposição\\s+(?:a|em)|um\\s+pouco(?:\\s+de)?|pelo\\s+menos|exatamente|um|uma|uns|umas|o|os|as|de|do|da|dos|das|em|no|na|nos|nas|meu|minha|mais|também|tambem|metade|dinheiro',
  'giu',
);
const ASK_AFTER_NAME = word(
  '(?:in|into|to|on)\\s+(?:(?:my|the|this|that)\\s+)?(?:it|there|vault|plan|portfolio|mix)|(?:em|n[oa]|neste|nesse|nesta|nessa|para|pra|pro|ao)\\s+(?:(?:o|a|meu|minha)\\s+)?(?:cofre|plano|carteira)|for\\s+me|(?:pra|para)\\s+mim|after\\s+all|as\\s+well|at\\s+least|pelo\\s+menos|por\\s+favor|de\\s+novo|please|too|also|again|now|there|here|at|exactly|também|tambem|agora|afinal|aqui|nele|nela|em|com|exatamente',
  'giu',
);
// A share: a number with its percent sign. A number without one is no filler.
const ASK_SHARE =
  /\d+(?:[.,]\d+)?\s*(?:%|(?:percent|per\s*cent|por\s*cento|pct)(?![\p{L}\p{N}]))/giu;
// The kinds of asset a person names without a ticker. A piece that asks for one ("I want bonds") asks
// for a thing, so a list may continue it; "I want safety, NVDA" asks for no thing.
const KIND_WORDS = word(
  'reserves?|bonds?|treasur(?:y|ies)|gold|cash|income|yield|stablecoins?|crypto|commodit(?:y|ies)|renda(?:\\s+fixa)?|ouro|caixa|reservas?|títulos|titulos|tesouro|cripto',
  'iu',
);
const SETS_AGAINST =
  /^(?:from|against|than|over|to|for|with|about|on|contra|que|para|pra|por|sobre|com)$/iu;
const EXCEPT = /^(?:just|only|só|apenas|somente)(?![\p{L}\p{N}])/iu;
// One asking verb or one refusal covers a list: "I want TSLA, NVDA and a reserve", "sell TSLA and NVDA".
const ASK_PIECES =
  /(?<!\d),|,(?!\d)|(?<![\p{L}\p{N}])(?:and|or|then|e|ou|depois)(?![\p{L}\p{N}])/iu;
const POLITE_ASK =
  /^(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:add|put|include|buy)\b|^(?:você\s+|voce\s+)?(?:pode|poderia)\s+(?:por\s+favor\s+)?(?:colocar|adicionar|incluir|comprar|pôr|botar)(?![\p{L}\p{N}])/iu;
// A refusal, an exclusion, an upper bound, a withdrawal, a sale, a reduction, a swap, a comparison
// against or a worry: the clause asks for nothing.
const REFUSES = word(
  "zero|rid|reduce[sd]?|reducing|away|off|lower|trim|shrink\\p{L}*|halve[sd]?|swap|replace|trade|exit|dump|sold|gone|down|smaller|safer|riskier|versus|vs|compared|worr\\p{L}*|scared|afraid|nervous|concern\\p{L}*|sair|saia|reduzir|reduza|reduz|diminuir|diminua|trocar|troque|troca|substituir|substitua|livrar|desfazer|preocup\\p{L}*|medo|receio|mais\\s+segur[oa]s?|do\\s+que|em\\s+vez|ao\\s+invés|no|not|none|never|nothing|without|except|excluding|exclude|avoid|avoiding|out|sell|selling|remove|drop|scratch|cut|minus|instead|rather|risky|less|fewer|stop|don'?t|do\\s+not|doesn'?t|won'?t|at\\s+most|no\\s+more|max|maximum|up\\s+to|already|menos|sem|não|nao|nada|nenhum|nenhuma|nunca|exceto|tirar|tire|tira|vender|venda|vende|evitar|evite|evita|arriscad[ao]s?|fora|máximo|maximo|até|já",
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
 * The stocks the person asked for in their own words, read piece by piece: a sentence cut at its commas
 * and at "and", "or", "then". A stock, its company or "stocks" counts only as what an asking word asks
 * for: the word stands before it in the same piece with nothing but filler between them ("I want some
 * NVDA", "add NVDA", "more NVDA"), or the piece is a bare list of names continuing such a piece. A piece
 * with a refusal, an exclusion, an upper bound, a sale, a reduction, a swap, a comparison or a worry
 * asks for nothing and refuses the names in it, and a bare list after it is refused with it ("sell TSLA
 * and NVDA"). A condition or someone else's view counts for nothing, and neither does anything unclear
 * ("I want protection from NVDA"). A message with a question mark counts only through a polite request
 * ("can you add", "pode colocar"). The latest mention of a stock wins, so "no AAPL" withdraws an
 * earlier "I want AAPL". The model's reply never counts.
 */
export function requestedStocks(
  messages: VaultAgentRequest['messages'],
  language: 'en' | 'pt',
  assets: BasketAsset[],
  companies: Map<string, string[]>,
): Set<string> {
  const stocks = assets.filter(isStock);
  const general = word(STOCK_WORDS.join('|'), 'iu');
  const named: Array<[string, RegExp[]]> = [
    ['*', [general]],
    ...stocks.map((asset): [string, RegExp[]] => [
      asset.id,
      assetNames(asset, companies.get(asset.id) ?? []),
    ]),
  ];
  // Every listed name, a stock's or not, may stand in a list beside the one read.
  const anyName = [
    general,
    ...assets.flatMap((asset) => assetNames(asset, companies.get(asset.id) ?? [])),
  ].map((pattern) => new RegExp(pattern.source, `g${pattern.flags}`));
  const besidesFiller = (text: string) =>
    anyName
      .reduce((rest, pattern) => rest.replace(pattern, ' '), text)
      .replace(ASK_SHARE, ' ')
      .replace(ASK_BEFORE_NAME, ' ');
  const WORDS = /[\p{L}\p{N}'-]+/gu;
  // Another listed name is read only in a bare list, name beside name with at most a share between:
  // behind a preposition it is where the stock goes ("NVDA in USDC"), not something asked for with it.
  const NAME = '\u0001';
  const marked = (text: string) =>
    anyName.reduce((rest, pattern) => rest.replace(pattern, NAME), text).replace(ASK_SHARE, ' ');
  const worded = (text: string) => /[\p{L}\p{N}]/u.test(text);
  /** Between the asking word and the name: filler, then at most a bare run of other names. */
  const leads = (text: string) => {
    const all = marked(text);
    const run = all.indexOf(NAME);
    return (
      !worded((run < 0 ? all : all.slice(0, run)).replace(ASK_BEFORE_NAME, ' ')) &&
      !worded(run < 0 ? '' : all.slice(run))
    );
  };
  /** From the name to the end of the piece: at most a bare run of other names, then filler. */
  const trails = (text: string) => {
    const all = marked(text);
    const run = all.lastIndexOf(NAME) + 1;
    return !worded(all.slice(0, run)) && !worded(all.slice(run).replace(ASK_AFTER_NAME, ' '));
  };
  /** A piece that is a list of names and nothing else: "a little NVDA", "TSLA, NVDA too". */
  const bareList = (text: string) => {
    const all = marked(text);
    const from = all.indexOf(NAME);
    const to = all.lastIndexOf(NAME) + 1;
    return (
      from >= 0 &&
      !worded(all.slice(0, from).replace(ASK_BEFORE_NAME, ' ')) &&
      !worded(all.slice(from, to)) &&
      !worded(all.slice(to).replace(ASK_AFTER_NAME, ' '))
    );
  };
  // "Stocks" names a kind, so a word or two may describe it ("electric vehicle stocks"), but nothing
  // that sets it against something ("protection from stocks").
  const describes = (text: string) => {
    const words = besidesFiller(text).match(WORDS) ?? [];
    return words.length <= 3 && !words.some((one) => SETS_AGAINST.test(one));
  };
  // A piece that asks for a kind of asset, with at most one word describing it ("steady income").
  const asksForKind = (rest: string) => {
    const words =
      besidesFiller(rest.replace(new RegExp(KIND_WORDS.source, 'giu'), ' ')).match(WORDS) ?? [];
    return (
      KIND_WORDS.test(rest) && words.length <= 1 && !words.some((one) => SETS_AGAINST.test(one))
    );
  };
  // Portuguese "no" is "in the"; its refusals are não, nenhum, nada, sem.
  // A share of zero, with or without its sign, refuses as well: "NVDA at 0".
  const refuses = (clause: string) =>
    REFUSES.test(language === 'pt' ? clause.replace(word('no', 'iu'), 'em') : clause) ||
    (clause.match(/\d+(?:[.,]\d+)?/gu) ?? []).some((n) => Number(n.replace(',', '.')) === 0);
  // The latest affirmative (true) or refusing (false) mention of each stock, and of stocks in general.
  const latest = new Map<string, { at: number; asked: boolean }>();
  let at = 0;
  for (const message of messages) {
    if (message.who !== 'person') continue;
    const text = message.text.trim();
    if (/^["“‘']/u.test(text)) continue;
    const questioned = text.includes('?');
    const sentences = text
      // A stop or a comma between digits is part of a number ("0.5%", "0,5%").
      .split(/[;!?\n]+|\.(?!\d)/u)
      .filter((sentence) => !CONDITION.test(sentence))
      .flatMap((sentence) =>
        sentence.split(
          /(?<![\p{L}\p{N}])(?:but|however|mas|porém|porem|contudo)(?![\p{L}\p{N}])/iu,
        ),
      );
    for (const sentence of sentences) {
      // What a bare list of names continues: an ask (true), a refusal (false) or neither.
      let carried: boolean | null = null;
      let wanted = false;
      for (const piece of sentence.split(ASK_PIECES).map((part) => part.trim())) {
        if (!piece) continue;
        const polite = POLITE_ASK.test(piece);
        if (NOT_THEIRS.test(piece) || (!polite && (questioned || ASKS_A_QUESTION.test(piece)))) {
          carried = null;
          continue;
        }
        at += 1;
        // Where each name first stands in the piece.
        const found = named.flatMap(([key, patterns]) => {
          const first = patterns
            .flatMap((pattern) => {
              const match = pattern.exec(piece);
              return match ? [match] : [];
            })
            .sort((a, b) => a.index - b.index)[0];
          return first ? [{ key, where: first.index, end: first.index + first[0].length }] : [];
        });
        if (refuses(piece)) {
          for (const { key } of found) latest.set(key, { at, asked: false });
          carried = false;
          wanted ||= ASKS.test(piece);
          continue;
        }
        const asks = [...piece.matchAll(ASKS_OR_MORE)];
        if (!asks.length) {
          // "I want no stocks, just AAPL": the exception to a refusal the person wanted is asked for.
          const except = wanted ? piece.replace(EXCEPT, '') : piece;
          if (carried === null || !found.length || !bareList(except)) carried = null;
          else
            for (const { key } of found)
              latest.set(key, { at, asked: carried || except !== piece });
          continue;
        }
        wanted = true;
        let unclear = false;
        for (const { key, where, end } of found) {
          const ask = asks.filter((match) => match.index < where).at(-1);
          const between = ask ? piece.slice(ask.index + ask[0].length, where) : '';
          // Only filler may stand before the name and after it: "I want NVDA removed" asks for
          // something to happen to it, not for it.
          if (
            ask &&
            (key === '*' ? describes(between) : leads(between)) &&
            trails(piece.slice(end))
          )
            latest.set(key, { at, asked: true });
          else unclear = true;
        }
        // A list continues only an ask for a thing: a listed asset, stocks, or a kind of asset.
        const last = asks.at(-1);
        const rest = last ? piece.slice(last.index + last[0].length) : '';
        const thing = found.length > 0 || bareList(rest) || asksForKind(rest);
        carried = !unclear && thing ? true : null;
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

/**
 * `text` without the sentences that name one of `named`, cut where `sentencesOf` cuts. Each line is
 * read on its own, so the server's note on a line of its own (`FIGURE_CUT`) stays when the line before
 * it goes.
 */
function withoutSentencesNaming(text: string, named: RegExp[], catalogNames: string[]): string {
  return text
    .split('\n')
    .map((line) =>
      sentencesOf(line, catalogNames)
        .filter((sentence) => !named.some((pattern) => pattern.test(sentence)))
        .join('')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
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
const ASSET_THEN_NUMBER = /^\s*(?:(?:at|to|a|em|com|=|:|-)\s*)?$/iu;
const JOINS = /^\s*(?:and|e|&|\+|\/)\s*$/iu;
// A share of the vault is never a return, a yield, a price move, a fee or a loss: a clause with one
// of these words sets no share ("10% a year", "TSLA fell 30%", "90% do CDI").
const RETURNS = word(
  'a\\s+year|per\\s+year|yearly|annual(?:ly)?|per\\s+annum|a\\s+month|per\\s+month|monthly|earn|earns|earning|return|returns|yield|yields|interest|apy|apr|dividends?|fees?|gain|gains|profit|upside|downside|grow|grows|growth|rise|rises|rose|fell|fall|falls|dropped|lose|loses|losing|loss|losses|drawdown|ao\\s+ano|por\\s+ano|anual|a\\.a|ao\\s+m[eê]s|por\\s+m[eê]s|mensal|render|rende|rendendo|rendimento|rentabilidade|retorno|juros|taxa|cdi|selic|ipca|dividendos?|ganho|ganhar|ganhe|lucro|valoriz\\p{L}+|desvaloriz\\p{L}+|crescer|cresça|cresce|crescimento|subir|suba|sobe|subiu|cair|caia|cai|caiu|perder|perca|perde|perda|perdas|queda',
  'iu',
);
// A refusal: the sentence sets no share. It withdraws nothing either; only the exact forms below do.
const SHARE_REFUSES = word(
  "no|not|never|none|without|except|excluding|exclude|avoid|avoiding|sell|selling|remove|drop|forget|ignore|scratch|cancel|stop|instead\\s+of|rather\\s+than|too\\s+much|no\\s+longer|anymore|don'?t|do\\s+not|doesn'?t|won'?t|wouldn'?t|can'?t|cannot|isn'?t|não|nao|nunca|jamais|sem|nem|exceto|menos|nenhum|nenhuma|tirar|tire|tira|vender|venda|vende|evitar|evite|evita|esqueça|esqueca|esquece|ignora|remova|cancele|cancela|chega\\s+de|demais",
  'iu',
);
// A share is applied only where the person plainly asks for it. All that may stand before the first
// share of a piece, start to end: leads, then a first-person subject, then one asking verb. Any other
// word there ("You put", "I'm scared to put", "I want to reduce", "My wife wants") and it is unread.
const ASK_LEAD =
  '(?:\\s*(?:and|e|ok|okay|yes|sim|so|then|also|actually|just|like|with|com|now|agora|então|entao|please|por\\s+favor)(?![\\p{L}\\p{N}]))*\\s*';
const ASK_SUBJECT =
  "(?:i\\s+want(?:\\s+to)?|we\\s+want(?:\\s+to)?|i(?:'d|\\s+would)\\s+like(?:\\s+to)?|(?:eu\\s+)?(?:quero|queria|gostaria\\s+de))";
const ASK_VERB =
  '(?:put|make\\s+(?:it|that)|(?:change|set)\\s+(?:it|that)\\s+to|set|give(?:\\s+me)?|allocate|use|add|coloc(?:ar|a|que)|p[oô]r|ponha|põe|bot(?:ar|a|e)|deix(?:ar|a|e)|aloc(?:ar|a|que)|us(?:ar|a|e))';
const END_OF_WORD = '(?![\\p{L}\\p{N}])';
const ASK_BEFORE = new RegExp(
  `^${ASK_LEAD}(?:${ASK_SUBJECT}${END_OF_WORD})?\\s*(?:${ASK_VERB}${END_OF_WORD})?\\s*$`,
  'iu',
);
// A piece that asks for something and holds no share ("I want EV stocks") opens the same way.
const ASK_START = new RegExp(`^${ASK_LEAD}(?:${ASK_SUBJECT}|${ASK_VERB})${END_OF_WORD}`, 'iu');
const BETWEEN_SHARES = /^\s*(?:(?:and|e|&|\+)\s*)?$/iu;
const AFTER_SHARES =
  /^\s*(?:(?:in|for|on)\s+(?:this|the|my)\s+(?:vault|portfolio|plan)|n[oa]\s+(?:meu\s+|minha\s+)?(?:cofre|carteira|plano)|overall|in\s+total|no\s+total|ao\s+todo|please|por\s+favor)?\s*$/iu;
const COURTESY = /^(?:please|por\s+favor|ok|okay|yes|sim|thanks|thank\s+you|obrigad[oa])$/iu;
// "the rest in gold": never read as a share; said back unless the rest did go where it says.
const REST = word('rest|remainder|remaining|resto|restante', 'iu');
const REST_AFTER_SHARES = /^\s*(?:and|e|&|\+)\s+/iu;
const ADVERSATIVE = /((?<![\p{L}\p{N}])(?:but|however|mas|porém|porem|contudo)(?![\p{L}\p{N}]))/iu;
// The only words that withdraw a share (with the asset or class of a standing share, or a kind of
// limit when one such share stands), and the only way to ask for an equal split again.
const WITHDRAWS =
  /^(?:(?:please|actually|ok|okay|por\s+favor)\s+)*(?:forget|drop|remove|ignore|scratch|cancel|esqueça|esqueca|esquece|tire|tira|remova|ignora|cancele|cancela)\s+(?:(?:the|that|this|my|o|a|os|as|esse|essa|este|esta|aquele|aquela|meu|minha)\s+)?(.+?)(?:\s+(?:please|por\s+favor))?$/iu;
const LIMIT_KINDS: Array<[PersonShare['kind'] | 'any', string]> = [
  ['min', 'minimum|min|m[ií]nimo'],
  ['max', 'maximum|max|m[aá]ximo'],
  ['any', 'shares?|limits?|requirements?|percentages?|limites?|percentual|porcentagem|parte'],
];
const EQUAL_SPLIT =
  /^(?:(?:please|actually|ok|okay|just|por\s+favor|i\s+want|quero|make\s+it)\s+)*(?:(?:an?\s+)?equal\s+split|split\s+(?:(?:it|them|everything|all)\s+)?(?:equally|evenly)|equal\s+(?:parts|shares|weights)|(?:divid[ai]r?\s+)?(?:tudo\s+)?(?:em\s+)?partes\s+iguais|divid[ai]r?\s+(?:tudo\s+)?igualmente|divis[aã]o\s+igual)(?:\s+(?:please|por\s+favor))?$/iu;
// "Make that at least 10%": a new number for the one share that stands, naming no asset.
const AMENDS =
  /^(?:(?:please|por\s+favor)\s+)?(?:(?:make|change|set)\s+(?:that|it)(?:\s+to)?|(?:mude|muda|altere|troque|faça|faca|faz)(?:\s+isso)?\s+(?:para|pra))\s+/iu;
// What reads as a share in the person's words, applied or not.
const SHARE_WORDS =
  /%|(?<![\p{L}\p{N}])(?:percent|per\s*cent|por\s*cento)(?![\p{L}\p{N}])|(?<![\d.,])\d+\s*\/\s*\d+(?![\d.,])|(?<![\p{L}\p{N}])(?:half|metade|mostly|mainly|majority|most\s+of|maioria|maior\s+parte|principalmente|sobretudo)(?![\p{L}\p{N}])/iu;
// A quantity that reads as a share only beside a named asset: a bare number that is not money or
// time ("70 TSLA", "70-30", "0.7"), a fraction, a whole or a multiple. Never read, only said back.
const QUANTITY =
  /(?<![$€£]\s?)(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?(?![\p{L}\p{N}])(?!\s*(?:days?|weeks?|months?|years?|dias?|semanas?|m[eê]s|meses|anos?|usd|dollars?|d[oó]lares|reais|brl)(?![\p{L}]))|(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?x(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:thirds?|quarters?|terços?|tercos?|quartos?|all|everything|tudo|double|twice|dobro|triple|triplo)(?![\p{L}\p{N}])/iu;
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
/** A share and where it sits in its piece. */
type Found = PersonShare & { start: number; end: number };
export type PersonShare = {
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
function sharesInPiece(piece: string, named: (text: string) => Named[]): Found[] {
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
    const [start, end] = span;
    return pair.map((asset, i) => ({
      assetIds: asset.ids,
      kind: 'exact' as const,
      bps: parts[i] as number,
      quote: piece.slice(start, end),
      start,
      end,
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
    const [from, to] = isForward ? [start, asset.end] : [asset.start, end];
    return {
      assetIds: asset.ids,
      ...numberOf(match),
      quote: piece.slice(from, to),
      start: from,
      end: to,
    };
  });
  return shares.every(wholeBps) ? shares : [];
}

/** "Make that at least 10%": the one share that stands, with the new number and nothing else. */
function amendedShare(piece: string, only: PersonShare): Found[] {
  const rest = piece.replace(AMENDS, '').trim();
  const [match, ...others] = [...rest.matchAll(NUMBER)];
  if (!AMENDS.test(piece) || !match || others.length || match[0].length !== rest.length) return [];
  const share = {
    assetIds: only.assetIds,
    ...numberOf(match),
    quote: piece,
    start: 0,
    end: piece.length,
  };
  return wholeBps(share) ? [share] : [];
}
const sameAssets = (a: Pick<PersonShare, 'assetIds'>, b: Pick<PersonShare, 'assetIds'>) =>
  a.assetIds.length === b.assetIds.length && a.assetIds.every((id) => b.assetIds.includes(id));
/** A later share on the same asset or class replaces an earlier one, unless they are a floor and a ceiling that fit. */
const replaces = (next: PersonShare, earlier: PersonShare) =>
  sameAssets(next, earlier) &&
  (next.kind === earlier.kind ||
    next.kind === 'exact' ||
    earlier.kind === 'exact' ||
    (next.kind === 'min' ? next.bps > earlier.bps : next.bps < earlier.bps));

/**
 * The shares the person stated, read by the server from their own messages and from nothing else (gate
 * ANY-COMPOSITION). The default is not to apply: unread and said back is always acceptable, applied or
 * withdrawn wrongly is not.
 *
 * Applied: a sentence (or its side of "but" that has its own asking verb) sets shares only when it is
 * no question, condition, someone else's view or refusal and holds no return or loss word, and every
 * comma-separated piece of it is a plain ask: shares read by `sharesInPiece` with nothing before them
 * but leads, a first-person subject and one asking verb, start to end ("I want", "please put", "quero",
 * "make it"; not "You put", "I'm scared to put", "I want to reduce"), nothing between them but
 * "and", and nothing after them but "in this vault", "overall" or what the rest should do. A piece
 * that only asks ("I want EV stocks"), only says where the rest goes, or is a courtesy may stand
 * beside them. Anything else in the sentence ("70% TSLA is too risky", "Hypothetically, 70% in TSLA",
 * "Increase TSLA 10%") and none of it is applied.
 *
 * Replaced: a later share on exactly the same asset or class. A class share and an asset share stand
 * together. "Make that at least 10%" re-numbers the one share that stands.
 *
 * Withdrawn, by these whole sentences only: "forget/drop/remove [the] X [share/limit]" where X is the
 * asset or class of a standing share; "drop the minimum/maximum/limit" when exactly one such share
 * stands; and "split it equally" / "equal split" / "partes iguais".
 *
 * `standing` is what holds now and `read` everything ever read (to compare with what the model
 * reports). For the latest message: `withdrawn` the shares it withdrew, `unread` the pieces that read
 * as a share and set none, and `rest` where it said the rest should go, with the assets it named.
 */
export function personShares(
  messages: VaultAgentRequest['messages'],
  language: 'en' | 'pt',
  assets: BasketAsset[],
  companies: Map<string, string[]>,
): {
  standing: PersonShare[];
  read: PersonShare[];
  withdrawn: PersonShare[];
  unread: string[];
  rest: Array<{ quote: string; assetIds: string[] }>;
} {
  const named = assetNamer(assets, companies);
  const idsIn = (text: string) => [...new Set(named(text).flatMap((asset) => asset.ids))];
  const bounds = new RegExp(`(?<![\\p{L}\\p{N}])(?:${BOUND})(?![\\p{L}\\p{N}])`, 'giu');
  // Reads as a share: a share word anywhere, or a quantity beside a named asset. A bare return
  // target ("10% a year") is not a share of anything.
  const noticed = (piece: string) =>
    (SHARE_WORDS.test(piece) || QUANTITY.test(piece)) &&
    (named(piece).length > 0 ||
      (SHARE_WORDS.test(piece) && !RETURNS.test(piece.replace(bounds, ' '))));
  let standing: PersonShare[] = [];
  const read: PersonShare[] = [];
  let withdrawn: PersonShare[] = [];
  let unread: string[] = [];
  let rest: Array<{ quote: string; assetIds: string[] }> = [];
  const withdraw = (gone: (share: PersonShare) => boolean) => {
    withdrawn.push(...standing.filter(gone));
    standing = standing.filter((share) => !gone(share));
  };
  /** True when the sentence is one of the withdrawal forms, whether or not it found a share. */
  const withdraws = (sentence: string): boolean => {
    if (EQUAL_SPLIT.test(sentence)) {
      withdraw(() => true);
      return true;
    }
    const body = WITHDRAWS.exec(sentence)?.[1]?.trim();
    if (!body) return false;
    for (const [kind, words] of LIMIT_KINDS) {
      const fits = (share: PersonShare) => kind === 'any' || share.kind === kind;
      if (new RegExp(`^(?:${words})$`, 'iu').test(body)) {
        // "Drop the minimum" names no asset: it is that share only when one such share stands.
        const [only, ...others] = standing.filter(fits);
        if (only && !others.length) withdraw((share) => share === only);
        else unread.push(sentence.slice(0, 400));
        return true;
      }
      const target =
        new RegExp(`^(.+?)\\s+(?:${words})$`, 'iu').exec(body)?.[1] ??
        new RegExp(`^(?:${words})\\s+(?:of|on|for|in|de|do|da|dos|das|em)\\s+(.+)$`, 'iu').exec(
          body,
        )?.[1];
      if (target && withdrawsOn(target, fits)) return true;
    }
    return withdrawsOn(body, () => true);
  };
  const withdrawsOn = (target: string, fits: (share: PersonShare) => boolean): boolean => {
    const whole = (span?: { start: number; end: number }) =>
      span?.start === 0 && span.end === target.length;
    // The target is the asset or class alone: with a number beside it ("Drop TSLA to 10%", "Remove
    // 30% NVDA") the sentence is no withdrawal, and is said back as unread.
    const [asset, ...more] = named(target);
    const on = !more.length && whole(asset) ? asset?.ids : null;
    if (!on) return false;
    withdraw((standing) => fits(standing) && sameAssets(standing, { assetIds: on }));
    return true;
  };
  for (const message of messages) {
    if (message.who !== 'person') continue;
    withdrawn = [];
    unread = [];
    rest = [];
    const text = message.text.trim();
    const quoted = /^["“‘']/u.test(text);
    for (const [, sentence = '', end = ''] of text.matchAll(
      /((?:[^.;!?\n]|(?<=\d)\.(?=\d))+)([.;!?\n]*)/gu,
    )) {
      if (!quoted && !end.includes('?') && withdraws(sentence.trim())) {
        const said = sentence.trim().slice(0, 400);
        if (noticed(said) && !unread.includes(said)) unread.push(said);
        continue;
      }
      // "but" starts a clause of its own only when what follows asks for something.
      const clauses: string[] = [];
      sentence.split(ADVERSATIVE).forEach((part, i, parts) => {
        if (i % 2) return;
        if (i === 0 || ASKS.test(part)) clauses.push(part);
        else clauses[clauses.length - 1] += `${parts[i - 1]}${part}`;
      });
      for (const clause of clauses) {
        const pieces = clause
          .split(/(?<!\d),|,(?!\d)/u)
          .map((piece) => piece.trim())
          .filter(Boolean);
        // Bounds hold words that would read as a refusal or a move ("no more than", "up to").
        const plain = clause.replace(bounds, ' ');
        const spoken = language === 'pt' ? plain.replace(word('no', 'giu'), 'em') : plain;
        const open =
          !quoted &&
          !end.includes('?') &&
          !NOT_THEIRS.test(plain) &&
          !CONDITION.test(plain) &&
          !ASKS_A_QUESTION.test(clause.trim()) &&
          !RETURNS.test(plain) &&
          !SHARE_REFUSES.test(spoken);
        const only = standing.length === 1 ? standing[0] : undefined;
        const parts = pieces.map((piece) => {
          const found =
            only && named(piece).length === 0
              ? amendedShare(piece, only)
              : sharesInPiece(piece, named);
          const [first, last] = [found[0], found.at(-1)];
          if (first && last) {
            const before = piece.slice(0, first.start);
            const after = piece.slice(last.end);
            const trailing = REST_AFTER_SHARES.test(after) && REST.test(after);
            const plainAsk =
              ASK_BEFORE.test(before) &&
              found.every(
                (share, i) =>
                  i === 0 ||
                  share.start === found[i - 1]?.start ||
                  BETWEEN_SHARES.test(piece.slice(found[i - 1]?.end, share.start)),
              ) &&
              (AFTER_SHARES.test(after) || trailing);
            if (plainAsk)
              return {
                piece,
                found,
                fits: true,
                rest: trailing ? after.replace(REST_AFTER_SHARES, '').trim() : '',
              };
          }
          const says = REST.test(piece) && !SHARE_WORDS.test(piece);
          return {
            piece,
            found: [],
            fits: says || COURTESY.test(piece) || (ASK_START.test(piece) && !noticed(piece)),
            rest: says ? piece : '',
          };
        });
        const applies =
          open && parts.every((part) => part.fits) && parts.some((part) => part.found.length);
        for (const part of parts) {
          if (part.rest && open && (applies || !part.found.length))
            rest.push({ quote: part.rest.slice(0, 400), assetIds: idsIn(part.rest) });
          if (applies && part.found.length) {
            const shares = part.found.map(({ start: _start, end: _end, ...share }) => share);
            read.push(...shares);
            standing = [
              ...standing.filter((earlier) => !shares.some((next) => replaces(next, earlier))),
              ...shares,
            ];
          } else if ((part.found.length || !part.rest) && noticed(part.piece))
            unread.push(part.piece.slice(0, 400));
        }
      }
    }
  }
  return { standing, read, withdrawn, unread, rest };
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
  const inAnalytics = new Set(
    (context.analytics?.assets ?? []).flatMap((row) => Object.keys(row.values)),
  );
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
  // What a plan for the goal cannot hold, by the rule the review of a mix reads (`eligibleForGoal`).
  const outside = new Set(
    goal
      ? [...catalog.values()].filter((asset) => !eligibleForGoal(asset, goal)).map(({ id }) => id)
      : [],
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
    exitCapacityBps: caps,
    eligibilityGoal: goal,
    statedPurpose:
      context.kind === 'new_goal' ? statedPurposeIn(parsed.data.messages, context) : null,
    outsideGoal: [...outside],
    requestedOutsideGoal: [...outside].filter((id) => requested.has(id)),
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
  // Sentences the repair attempt lost for stating a figure; a count for the log, never their words.
  let sentencesCut = 0;
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
    const personWords = parsed.data.messages
      .filter((message) => message.who === 'person')
      .map((message) => message.text);
    const catalogNames = [
      ...[...catalog.values()].flatMap((asset) => [asset.symbol, asset.underlying]),
      ...(context.stockAttributes?.stocks ?? [])
        .filter((row) => [...catalog.values()].some((asset) => asset.symbol === row.symbol))
        .map((row) => row.company),
    ];
    const figure = (text: string) => hasFinancialFigure(text, personWords, catalogNames);
    const proseOf = ({ message, question, proposal: draft }: VaultAgentModelReply) => [
      message,
      question ?? '',
      ...(draft
        ? [
            draft.objective,
            draft.summary,
            ...draft.tradeoffs,
            ...draft.unknowns,
            ...draft.allocations.map((allocation) => allocation.why),
          ]
        : []),
    ];
    // A figure is repaired once; one still there on the repair attempt costs its sentence, not the reply.
    let model = candidate.data;
    if (proseOf(model).some(figure)) {
      const kept = final
        ? withoutFigureSentences(model, figure, catalogNames, request.language)
        : null;
      if (!kept) return rejected('prose_figure');
      model = kept.reply;
      sentencesCut = kept.cut;
    }
    const { proposal, ...conversation } = model;
    const prose = proseOf(model);
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
    const leftOut: string[] = [];
    for (const allocation of proposal.allocations) {
      const asset = catalog.get(allocation.assetId);
      if (!asset) return rejected('allocation_unlisted');
      if (ids.has(asset.id)) return rejected('allocation_duplicate');
      // Any listed composition may be proposed (ANY-COMPOSITION), but for the goal: a pick outside it
      // is left out, as the review of the mix would refuse it, unless it is a stock the person asked
      // for (`requested` holds stocks only), which warns below, as exit capacity does.
      if (outside.has(asset.id) && !requested.has(asset.id)) leftOut.push(asset.id);
      ids.add(asset.id);
      for (const id of allocation.evidenceIds) {
        const source = sourceById.get(id);
        if (!source || (source.assetId !== undefined && source.assetId !== asset.id))
          return rejected('allocation_evidence');
      }
    }
    const kept = proposal.allocations.filter(({ assetId }) => !leftOut.includes(assetId));
    if (kept.filter((allocation) => catalog.get(allocation.assetId)?.cls !== 'cash').length > 16)
      return rejected('allocation_lines');
    // Said, never silent, and the model is asked once to write the reply without them. Should that
    // fail too, the reply stands as corrected here.
    const outsideNotes: VaultAgentWeightNote[] = leftOut.length
      ? [{ code: 'pick_outside_goal', assetIds: leftOut.slice(0, 64) }]
      : [];
    const corrected = (result: VaultAgentResult): Checked =>
      leftOut.length
        ? {
            result,
            failed: 'allocation_ineligible',
            problems: [
              REPAIR_HINTS.allocation_ineligible ?? 'allocation_ineligible',
              `Left out: ${leftOut.join(', ')}.`,
            ],
          }
        : { result };
    if (!kept.length)
      return corrected({
        kind: 'reply',
        reply: {
          version: 1,
          messageId: request.messageId,
          proposal: null,
          warnings: [],
          weightNotes: outsideNotes,
          message:
            request.language === 'pt'
              ? 'Um plano com o seu objetivo não pode ter os ativos escolhidos nesta proposta, então nada foi proposto; nada foi aplicado.'
              : 'A plan with your goal cannot hold the assets picked for this draft, so nothing is proposed; nothing was applied.',
          question:
            request.language === 'pt'
              ? 'Quer uma proposta dentro do seu objetivo?'
              : 'Would you like a draft within your goal?',
        },
      });
    // The weights come from the person's words, never from the model (Rodrigo's rule 2): an equal
    // split, or the shares the server read in the person's messages. What the model reports in
    // `stated` sets nothing: a share there that the server did not read is named once for the repair,
    // so the model asks the person instead of describing a share that was not applied.
    // The model wrote its prose with the picks left out in it: every sentence that names one goes, and
    // one sentence of the server's says what was left out and why. No word is added in the model's voice.
    const gone = leftOut.map((id) => catalog.get(id) as BasketAsset);
    const naming = gone.flatMap((asset) => [
      new RegExp(literal(asset.id), 'u'),
      // The symbol in any case, and gold by its plain word.
      word(literal(asset.symbol), 'iu'),
      ...(asset.cls === 'gold' ? [word('gold|ouro', 'iu')] : []),
      ...assetNames(asset, companies.get(asset.id) ?? []),
    ]);
    const clean = (text: string) =>
      gone.length ? withoutSentencesNaming(text, naming, catalogNames) : text;
    // A stock is left out because the person did not ask for it; any other class because the goal
    // cannot hold it whoever asks.
    const pt = request.language === 'pt';
    const listed = (of: BasketAsset[]) =>
      of
        .slice(0, 16)
        .map((asset) => asset.symbol)
        .join(', ');
    const unasked = gone.filter(isStock);
    const barred = gone.filter((asset) => !isStock(asset));
    const leftOutSaid = [
      unasked.length
        ? pt
          ? `Esta proposta deixa de fora ${listed(unasked)}: ${unasked.length === 1 ? 'fica fora do objetivo do seu plano e você não pediu esse ativo' : 'ficam fora do objetivo do seu plano e você não pediu esses ativos'}.`
          : `This draft leaves out ${listed(unasked)}: ${unasked.length === 1 ? 'it is' : 'they are'} outside your plan's goal and you did not ask for ${unasked.length === 1 ? 'it' : 'them'}.`
        : '',
      barred.length
        ? pt
          ? `Esta proposta deixa de fora ${listed(barred)}: um plano com o seu objetivo não pode ter ${barred.length === 1 ? 'esse ativo' : 'esses ativos'}.`
          : `This draft leaves out ${listed(barred)}: a plan with your goal cannot hold ${barred.length === 1 ? 'it' : 'them'}.`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1600);
    const told = [clean(conversation.message), leftOutSaid].filter(Boolean).join(' ');
    // With no room for what is left of the message, the server's notes alone: the figure's, if the
    // message carried it, and this one.
    const figureCut = FIGURE_CUT[request.language];
    const notes = conversation.message.includes(figureCut)
      ? `${figureCut} ${leftOutSaid}`
      : leftOutSaid;
    const said = gone.length
      ? {
          message: told.length > 2400 ? notes : told,
          question: clean(conversation.question ?? '') || null,
        }
      : conversation;
    const { stated, ...preview } = {
      ...proposal,
      objective: clean(proposal.objective),
      // The summary describes the draft as the model picked it, so the server's sentence replaces it.
      summary: gone.length ? leftOutSaid : proposal.summary,
      tradeoffs: proposal.tradeoffs.map(clean).filter(Boolean),
      unknowns: proposal.unknowns.map(clean).filter(Boolean),
      allocations: kept.map((allocation) => ({ ...allocation, why: clean(allocation.why) })),
    };
    // An objective or a pick's reason that was only about a pick left out has no server sentence that
    // fits its place: the model is asked again, and the reply fails if it is still so.
    if (!preview.objective || preview.allocations.some((allocation) => !allocation.why))
      return rejected('allocation_ineligible', [`Left out: ${leftOut.join(', ')}.`]);
    // What is served is read whole for a figure once more, after both cuts and with the server's own
    // sentences in it.
    if (gone.length && proseOf({ ...said, proposal: { ...preview, stated } }).some(figure))
      return rejected('prose_figure');
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
      // A share on assets the goal cannot hold is unmet whatever the picks: the goal is why, and the
      // reply says so instead of asking for another draft within a limit no draft can meet.
      const barred = missed.assetIds.every((id) => outside.has(id) && !requested.has(id));
      const those = missed.assetIds.length === 1;
      // Which share, in words: its place and the person's quote, never a weight.
      return {
        failed: barred ? 'allocation_ineligible' : 'allocation_constraint',
        problems: barred
          ? [
              REPAIR_HINTS.allocation_ineligible ?? 'allocation_ineligible',
              `The person said “${missed.quote}”: a plan for eligibilityGoal cannot hold ${missed.assetIds.slice(0, 16).join(', ')}, so no picks can meet that share. Propose nothing that needs it and say that a plan with this goal cannot hold it.`,
            ]
          : [
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
              ...outsideNotes,
            ],
            message: barred
              ? request.language === 'pt'
                ? `Seu pedido, “${missed.quote}”, não pode ser atendido: um plano com o seu objetivo não pode ter ${those ? 'esse ativo' : 'esses ativos'}. Nada foi proposto; nada foi aplicado.`
                : `Your request, “${missed.quote}”, cannot be met: a plan with your goal cannot hold ${those ? 'that asset' : 'those assets'}. Nothing is proposed; nothing was applied.`
              : request.language === 'pt'
                ? `A proposta não respeitou seu pedido: “${missed.quote}”. Esse limite continua valendo; nada foi aplicado.`
                : `The draft did not meet your request: “${missed.quote}”. That requirement still stands; nothing was applied.`,
            question: barred
              ? request.language === 'pt'
                ? 'Quer uma proposta dentro do seu objetivo, sem essa parcela?'
                : 'Would you like a draft within your goal, without that share?'
              : request.language === 'pt'
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
      if (outside.has(asset.id)) {
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
      // What the person's latest words withdrew, and what reads as a share in them and set none, is
      // said, never dropped. "The rest in gold" is said unless the rest did go only where it names.
      ...person.withdrawn.map((share) => ({
        code: 'share_withdrawn' as const,
        assetIds: share.assetIds.slice(0, 64),
        quote: share.quote,
      })),
      ...[
        ...new Set([
          ...person.unread,
          ...person.rest
            .filter(
              ({ assetIds }) =>
                assetIds.length > 0 && !(free.length && free.every((id) => assetIds.includes(id))),
            )
            .map(({ quote }) => quote),
        ]),
      ].map((quote) => ({ code: 'share_unread' as const, assetIds: [], quote })),
    ].slice(0, 64 - outsideNotes.length);
    weightNotes.push(...outsideNotes);
    const reply = VaultAgentReply.safeParse({
      version: 1,
      messageId: request.messageId,
      ...said,
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
      ? corrected({ kind: 'reply', reply: reply.data })
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
        ? sentencesCut
          ? 'prose_figure_trimmed'
          : 'repaired'
        : (second.result.detail ?? second.result.reason),
    ...(sentencesCut && second.result.kind === 'reply' ? { sentencesCut } : {}),
  };
  // A stated limit the repair still missed, or missed at first and then failed another way: the person
  // is asked about the limit, as before the repair.
  const final =
    second.result.kind === 'failure' && checked.result.kind === 'reply'
      ? checked.result
      : second.result;
  return { ...final, repair };
}
