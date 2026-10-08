import { createHash } from 'node:crypto';
import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { eligibleForGoal, PERSONAL_PARAMS as P } from '@colosseum/engine/personal';
import {
  type BasketAsset,
  type LiquidityProvider,
  Price,
  type VaultAgentRequest,
  VaultAgentSource,
} from '@colosseum/schemas';
import { CREDIT_LEG_TYPES, legTypesOf } from '../../../../packages/engine/src/personal/leg-types';
import {
  ModelPlanCatalog,
  ModelPlanConfirmationV1,
  ModelPlanNetwork,
  ModelPlanV2,
  modelLineAmounts,
  StoredModelDraftV1,
} from '../../../../packages/schemas/src/model-plan';

/** Production must load a durable, private receipt; this interface does not implement storage. */
export interface DurableModelDraftReader {
  loadOwned(ownerPrivyId: string, id: string): Promise<StoredModelDraftV1 | null>;
}
export type ConfirmationPolicy = { maxObservationAgeMs: number; validationLifetimeMs: number };
export type FreshModelEvidence = {
  network: ModelPlanNetwork;
  assets: BasketAsset[];
  cashAssetId: string;
  prices: Price[];
  sources: VaultAgentSource[];
  liquidity: { provider: LiquidityProvider; source: string } | null;
};
export type ModelConfirmationResult =
  | { kind: 'validated'; plan: ModelPlanV2; confirmationHash: string }
  | { kind: 'invalid' | 'unavailable'; issues: string[] };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
/** Domain separated hashes never accept a client-selected digest as authority. */
export function modelContractHash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(
      canonical({
        domain: `tenonfi:model-plan:${domain}`,
        schema: 1,
        policyVersion: 'model-confirmation-1',
        value,
      }),
    )
    .digest('hex');
}
export function modelRequestHash(
  ownerPrivyId: string,
  network: ModelPlanNetwork,
  request: VaultAgentRequest,
): string {
  return modelContractHash('request', { ownerPrivyId, network, request });
}
export function modelDraftHash(receipt: Omit<StoredModelDraftV1, 'draftHash'>): string {
  return modelContractHash('immutable-draft', receipt);
}
const currentPolicy = (policy: ConfirmationPolicy) => ({
  version: 'model-confirmation-1',
  parameters: P,
  exitWindowDays: EXIT_WINDOW_DAYS,
  privateTargetLimit: 16,
  ...policy,
});
const isFresh = (at: string | null, now: number, age: number) => {
  const parsed = at === null ? Number.NaN : Date.parse(at);
  return Number.isFinite(parsed) && parsed <= now && now - parsed <= age;
};
const liveCompatible = (network: ModelPlanNetwork, provenance: string) =>
  network.provenance !== 'live' || provenance === 'live';

/** Pure eligibility check only. No allocator, database, order builder or signing module is called. */
export function validateModelConfirmation(input: {
  ownerPrivyId: string;
  receipt: unknown;
  confirmation: unknown;
  fresh: FreshModelEvidence;
  now: Date;
  policy: ConfirmationPolicy;
}): ModelConfirmationResult {
  const receiptParsed = StoredModelDraftV1.safeParse(input.receipt);
  const confirmed = ModelPlanConfirmationV1.safeParse(input.confirmation);
  const catalogParsed = ModelPlanCatalog.safeParse(input.fresh.assets);
  const networkParsed = ModelPlanNetwork.safeParse(input.fresh.network);
  if (
    !receiptParsed.success ||
    !confirmed.success ||
    !catalogParsed.success ||
    !networkParsed.success
  )
    return { kind: 'invalid', issues: ['INVALID_CONTRACT'] };
  const receipt = receiptParsed.data;
  const request = confirmed.data;
  const terms = request.terms;
  const now = input.now.getTime();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(input.policy.maxObservationAgeMs) ||
    input.policy.maxObservationAgeMs <= 0 ||
    !Number.isFinite(input.policy.validationLifetimeMs) ||
    input.policy.validationLifetimeMs <= 0 ||
    !Number.isFinite(new Date(now + input.policy.validationLifetimeMs).getTime())
  )
    return { kind: 'invalid', issues: ['INVALID_POLICY'] };
  const { draftHash, ...draftBody } = receipt;
  if (
    receipt.ownerPrivyId !== input.ownerPrivyId ||
    receipt.id !== request.draftId ||
    receipt.requestHash !==
      modelRequestHash(receipt.ownerPrivyId, receipt.network, receipt.request) ||
    draftHash !== modelDraftHash(draftBody) ||
    draftHash !== request.draftHash ||
    receipt.requestHash !== request.requestHash
  )
    return { kind: 'invalid', issues: ['PRIVATE_DRAFT_MISMATCH'] };
  if (
    canonical(receipt.network) !== canonical(networkParsed.data) ||
    terms.chain !== receipt.network.chain
  )
    return { kind: 'invalid', issues: ['NETWORK_MISMATCH'] };
  if (!isFresh(receipt.createdAt, now, input.policy.maxObservationAgeMs))
    return { kind: 'unavailable', issues: ['DRAFT_EXPIRED'] };
  const assets = new Map(catalogParsed.data.map((asset) => [asset.id, asset]));
  if (assets.size !== catalogParsed.data.length)
    return { kind: 'invalid', issues: ['DUPLICATE_CATALOG_ASSET'] };
  const cash = assets.get(input.fresh.cashAssetId);
  if (
    cash?.cls !== 'cash' ||
    cash.chain !== terms.chain ||
    (cash.currency && cash.currency !== 'USD')
  )
    return { kind: 'invalid', issues: ['INVALID_DOLLAR_CASH'] };
  const sources: VaultAgentSource[] = [];
  const sourceById = new Map<string, VaultAgentSource>();
  for (const raw of input.fresh.sources) {
    const parsed = VaultAgentSource.safeParse(raw);
    if (!parsed.success || sourceById.has(parsed.data.id))
      return { kind: 'invalid', issues: ['INVALID_SOURCE'] };
    if (!liveCompatible(receipt.network, parsed.data.provenance))
      return { kind: 'invalid', issues: ['SOURCE_NETWORK_MISMATCH'] };
    sourceById.set(parsed.data.id, parsed.data);
    sources.push(parsed.data);
  }
  const originalSources = new Map(receipt.proposal.sources.map((source) => [source.id, source]));
  if (originalSources.size !== receipt.proposal.sources.length)
    return { kind: 'invalid', issues: ['INVALID_DRAFT_SOURCE'] };
  const allocations = receipt.proposal.allocations;
  if (
    allocations.reduce((sum, row) => sum + row.weightBps, 0) !== 10000 ||
    new Set(allocations.map((row) => row.assetId)).size !== allocations.length ||
    allocations.filter((row) => row.assetId !== cash.id).length > 16
  )
    return { kind: 'invalid', issues: ['INVALID_EXACT_WEIGHTS'] };
  const lines = modelLineAmounts(
    allocations.map(({ assetId, weightBps }) => ({ assetId, weightBps })),
    terms.amountUsdCents,
  );
  const invalid: string[] = [];
  const unavailable: string[] = [];
  const unknowns: string[] = [...receipt.proposal.unknowns];
  const excludedUnderlyings = new Set(
    terms.limits.cannotHoldUnderlyings.map((word) => word.toLowerCase()),
  );
  const issuers = new Map<string, number>();
  const safeIssuers = new Map<string, number>();
  let safeCents = 0;
  let cashBps = 0;
  let creditBps = 0;
  const prices = new Map<string, Price>();
  for (const raw of input.fresh.prices) {
    const parsed = Price.safeParse(raw);
    if (
      !parsed.success ||
      prices.has(parsed.data.asset) ||
      !Number.isFinite(Number(parsed.data.usdPerToken)) ||
      Number(parsed.data.usdPerToken) <= 0
    )
      return { kind: 'invalid', issues: ['INVALID_PRICE'] };
    prices.set(parsed.data.asset, parsed.data);
  }
  for (const allocation of allocations) {
    const asset = assets.get(allocation.assetId);
    if (!asset || asset.chain !== terms.chain) {
      invalid.push(`NOT_LISTED:${allocation.assetId}`);
      continue;
    }
    if (!liveCompatible(receipt.network, asset.provenance))
      invalid.push(`ASSET_NETWORK_MISMATCH:${asset.id}`);
    if (asset.symbol !== allocation.symbol) invalid.push(`CATALOG_IDENTITY_CHANGED:${asset.id}`);
    if (!eligibleForGoal(asset, terms.goal)) invalid.push(`NOT_FOR_GOAL:${asset.id}`);
    if (
      terms.limits.cannotHoldAssets.includes(asset.id) ||
      terms.limits.cannotHoldClasses.includes(asset.cls as never) ||
      excludedUnderlyings.has(asset.underlying.toLowerCase())
    )
      invalid.push(`EXCLUDED:${asset.id}`);
    if (
      allocation.evidenceIds.some(
        (id) =>
          !originalSources.has(id) ||
          originalSources.get(id)?.assetId !== asset.id ||
          !liveCompatible(receipt.network, originalSources.get(id)?.provenance ?? ''),
      )
    )
      invalid.push(`UNGROUNDED_ORIGINAL_EVIDENCE:${asset.id}`);
    const catalogSource = sourceById.get(`catalog:${asset.id}`);
    if (
      !catalogSource ||
      catalogSource.assetId !== asset.id ||
      !isFresh(catalogSource.fetchedAt, now, input.policy.maxObservationAgeMs)
    )
      unavailable.push(`CATALOG_EVIDENCE_UNAVAILABLE:${asset.id}`);
    if (asset.cls === 'cash') {
      if (asset.id !== cash.id) invalid.push(`FOREIGN_CASH:${asset.id}`);
      cashBps += allocation.weightBps;
      safeCents += lines.find((line) => line.assetId === asset.id)?.amountUsdCents ?? 0;
      continue;
    }
    const price = prices.get(asset.id);
    if (
      !price ||
      !liveCompatible(receipt.network, price.provenance) ||
      !isFresh(price.fetchedAt, now, input.policy.maxObservationAgeMs) ||
      Math.max(price.ageSeconds, (now - Date.parse(price.fetchedAt)) / 1000) > price.maxAgeSeconds
    )
      unavailable.push(`PRICE_UNAVAILABLE:${asset.id}`);
    let cap = asset.maxWeightBps;
    if (['stock', 'etf', 'crypto'].includes(asset.cls))
      cap = Math.min(cap, P.capPerStockBps[terms.risk] ?? 0);
    if (asset.cls === 'dollar_yield') {
      safeCents += lines.find((line) => line.assetId === asset.id)?.amountUsdCents ?? 0;
      const leg = legTypesOf(asset.symbol);
      if (!leg) unavailable.push(`LEG_TYPE_UNKNOWN:${asset.id}`);
      else {
        cap = Math.min(
          cap,
          P.capPerAssetBps.bySymbol[asset.symbol] ??
            Math.min(...leg.types.map((type) => P.capPerAssetBps.byLegType[type] ?? 10000)),
        );
        if (leg.types.some((type) => CREDIT_LEG_TYPES.includes(type)))
          creditBps += allocation.weightBps;
      }
    }
    if (allocation.weightBps > cap) invalid.push(`ASSET_CAP:${asset.id}`);
    issuers.set(asset.issuer, (issuers.get(asset.issuer) ?? 0) + allocation.weightBps);
    if (asset.cls === 'dollar_yield' || asset.cls === 'gold')
      safeIssuers.set(asset.issuer, (safeIssuers.get(asset.issuer) ?? 0) + allocation.weightBps);
    const lineUsd = (lines.find((line) => line.assetId === asset.id)?.amountUsdCents ?? 0) / 100;
    if (lineUsd < P.minLineUsd || allocation.weightBps < P.minLineBps)
      invalid.push(`LINE_TOO_SMALL:${asset.id}`);
    const liquidity = input.fresh.liquidity;
    if (
      liquidity &&
      (!liquidity.source.trim() || !liveCompatible(receipt.network, liquidity.provider.provenance))
    ) {
      unavailable.push(`LIQUIDITY_SOURCE_UNAVAILABLE:${asset.id}`);
      continue;
    }
    let measured: ReturnType<LiquidityProvider['exitCapacity']> = null;
    let cost: number | null = null;
    try {
      if (liquidity?.provider.covers(asset.id)) {
        measured = liquidity.provider.exitCapacity(asset.id, P.tau, EXIT_WINDOW_DAYS);
        cost = liquidity.provider.exitCost(asset.id, lineUsd, EXIT_WINDOW_DAYS);
      }
    } catch {
      unavailable.push(`LIQUIDITY_UNAVAILABLE:${asset.id}`);
      continue;
    }
    if (
      (measured &&
        (!Number.isFinite(measured.capacityUsd) ||
          measured.capacityUsd < 0 ||
          !Number.isInteger(measured.samples) ||
          measured.samples < 0)) ||
      (cost !== null && (!Number.isFinite(cost) || cost < 0))
    ) {
      invalid.push(`INVALID_LIQUIDITY:${asset.id}`);
      continue;
    }
    const usable =
      measured &&
      measured.samples > 0 &&
      isFresh(measured.dataTo, now, input.policy.maxObservationAgeMs);
    if (usable && liquidity && measured) {
      if (lineUsd > measured.capacityUsd * P.shareOfDepth)
        invalid.push(`MEASURED_EXIT_CAP:${asset.id}`);
      sources.push({
        id: `confirmation:exit:${asset.id}`,
        assetId: asset.id,
        source: liquidity.source,
        method: liquidity.provider.methodVersion,
        fetchedAt: measured.dataTo as string,
        provenance: liquidity.provider.provenance,
        value: measured.capacityUsd,
        unit: 'USD capacity',
      });
    } else {
      const tierSource = sourceById.get(`tier:${asset.id}`);
      if (
        !tierSource ||
        tierSource.assetId !== asset.id ||
        !isFresh(tierSource.fetchedAt, now, input.policy.maxObservationAgeMs)
      )
        unavailable.push(`TIER_EVIDENCE_UNAVAILABLE:${asset.id}`);
      if (lineUsd > (P.tierCeilingUsd[asset.tier] ?? 0)) invalid.push(`TIER_EXIT_CAP:${asset.id}`);
      unknowns.push(
        `Exit capacity for ${asset.symbol} is not freshly measured; the sourced catalog tier ${asset.tier} ceiling is used as the disclosed EXIT-SOURCE fallback.`,
      );
      cost = null; // No valid dated capacity means no claim that a numeric cost is measured.
    }
    sources.push({
      id: `confirmation:cost:${asset.id}`,
      assetId: asset.id,
      source:
        usable && liquidity
          ? liquidity.source
          : (sourceById.get(`tier:${asset.id}`)?.source ?? 'unavailable'),
      method:
        usable && liquidity
          ? liquidity.provider.methodVersion
          : 'EXIT-SOURCE tier fallback; actual-size cost unknown',
      fetchedAt: usable
        ? (measured?.dataTo as string)
        : (sourceById.get(`tier:${asset.id}`)?.fetchedAt ?? input.now.toISOString()),
      provenance:
        usable && liquidity
          ? liquidity.provider.provenance
          : (sourceById.get(`tier:${asset.id}`)?.provenance ?? receipt.network.provenance),
      value: cost,
      unit: 'fraction',
    });
    if (cost === null)
      unknowns.push(
        `Exit cost for ${asset.symbol} at the confirmed line size is unknown; it is not zero.`,
      );
  }
  if (creditBps > (P.creditShareBps[terms.limits.creditTolerance] ?? 0))
    invalid.push('CREDIT_LIMIT');
  if (
    [...issuers.values()].some((weight) => weight > (P.capPerIssuerBps[terms.risk] ?? 0)) ||
    [...safeIssuers.values()].some((weight) => weight > P.issuerCapBps)
  )
    invalid.push('ISSUER_CAP');
  if (safeCents < terms.limits.mustKeepUsdCents) invalid.push('SAFE_LEG_MINIMUM');
  const earlyNeed = terms.limits.mayNeedInMonths;
  const floor =
    earlyNeed === null ? 0 : (P.cashFloor.find((row) => earlyNeed <= row.monthsLeft)?.cashBps ?? 0);
  if (cashBps < floor) invalid.push('EARLY_NEED_CASH_FLOOR');
  for (const bound of holdingConstraints(receipt.request.messages, [...assets.values()])) {
    const weight = allocations.reduce(
      (sum, row) =>
        sum +
        (assets.get(row.assetId) && bound.matches(assets.get(row.assetId) as BasketAsset)
          ? row.weightBps
          : 0),
      0,
    );
    if (weight < bound.min || weight > bound.max)
      invalid.push(`ORIGINAL_ALLOCATION_REQUEST:${bound.key}`);
  }
  if (
    terms.incomeTargetUsdCentsMonthly !== null ||
    receipt.request.messages.some(
      (message) => message.who === 'person' && hasUnsupportedIncomeRequirement(message.text),
    )
  )
    unavailable.push('INCOME_OR_WITHDRAWAL_REQUIREMENT_UNSUPPORTED');
  const cashCents = lines.find((line) => line.assetId === cash.id)?.amountUsdCents ?? 0;
  if (cashCents < literalCashMinimum(receipt.request.messages))
    invalid.push('ORIGINAL_CASH_AMOUNT_MINIMUM');
  if (invalid.length) return { kind: 'invalid', issues: [...new Set(invalid)] };
  if (unavailable.length) return { kind: 'unavailable', issues: [...new Set(unavailable)] };
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    return { kind: 'invalid', issues: ['DUPLICATE_VALIDATION_SOURCE'] };
  const policyHash = modelContractHash('policy', currentPolicy(input.policy));
  const termsHash = modelContractHash('confirmed-terms', {
    ownerPrivyId: receipt.ownerPrivyId,
    network: receipt.network,
    draftHash,
    requestHash: receipt.requestHash,
    terms,
    policyHash,
  });
  const parsedPlan = ModelPlanV2.safeParse({
    version: 2,
    kind: 'model',
    network: receipt.network,
    terms,
    draft: { id: receipt.id, hash: draftHash, requestHash: receipt.requestHash },
    proposal: receipt.proposal,
    lines,
    targets: lines
      .filter((row) => row.assetId !== cash.id)
      .map((row) => ({ asset: row.assetId, weightBps: row.weightBps })),
    cashAssetId: cash.id,
    cashAsset: cash,
    sources,
    unknowns: [...new Set(unknowns)],
    validation: {
      version: 1,
      policyHash,
      catalogHash: modelContractHash('catalog', catalogParsed.data),
      evidenceHash: modelContractHash('evidence', sources),
      termsHash,
      validatedAt: input.now.toISOString(),
      expiresAt: new Date(now + input.policy.validationLifetimeMs).toISOString(),
    },
  });
  if (!parsedPlan.success) return { kind: 'invalid', issues: ['VALIDATED_PLAN_SHAPE'] };
  // Durable integration must atomically scope owner+key to this hash and conflict on changed content.
  return {
    kind: 'validated',
    plan: parsedPlan.data,
    confirmationHash: modelContractHash('confirmation-idempotency', {
      ownerPrivyId: receipt.ownerPrivyId,
      idempotencyKey: request.idempotencyKey,
      draftHash,
      termsHash,
    }),
  };
}

/** Dollar cash minima remain separate from the existing safe-leg set-aside policy. */
function literalCashMinimum(messages: VaultAgentRequest['messages']): number {
  let minimum = 0;
  for (const message of messages) {
    if (message.who !== 'person') continue;
    const text = message.text.trim();
    if (
      /^["“‘']|\b(?:if|said|quoted|example|explain|understand|se\s+eu|disse|exemplo|entender)\b/iu.test(
        text,
      )
    )
      continue;
    if (
      /^(?:ignore|drop|remove|forget|esqueça|esqueca|remova)\b/iu.test(text) &&
      /\b(?:cash|caixa)\b/iu.test(text) &&
      /\b(?:minimum|requirement|limit|mínimo|minimo|limite)\b/iu.test(text)
    ) {
      minimum = 0;
      continue;
    }
    if (
      !/^(?:please\s+)?(?:i\s+(?:think\s+i\s+)?(?:want|would\s+like)|keep|reserve|(?:acho\s+que\s+)?quero|mantenha|reserve)\b/iu.test(
        text,
      ) ||
      /\b(?:do\s+not|don't|não|nao)\b/iu.test(text) ||
      !/\b(?:cash|caixa)\b/iu.test(text)
    )
      continue;
    const amounts = [...text.matchAll(/\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/gu)];
    if (amounts.length !== 1) continue;
    const cents = Math.round(Number(amounts[0]?.[1]?.replaceAll(',', '')) * 100);
    if (Number.isSafeInteger(cents)) minimum = cents;
  }
  return minimum;
}

/** Persisted rows have no authority until their receipt, terms and current catalog are revalidated. */
export function revalidateStoredModelPlan(
  input: Parameters<typeof validateModelConfirmation>[0] & { plan: unknown },
): ModelConfirmationResult {
  const parsed = ModelPlanV2.safeParse(input.plan);
  if (
    !parsed.success ||
    parsed.data.cashAssetId !== input.fresh.cashAssetId ||
    canonical(parsed.data.cashAsset) !==
      canonical(input.fresh.assets.find((asset) => asset.id === input.fresh.cashAssetId))
  )
    return { kind: 'invalid', issues: ['STORED_PLAN_CASH_MISMATCH'] };
  const result = validateModelConfirmation(input);
  if (result.kind !== 'validated') return result;
  const previous = parsed.data;
  if (
    canonical(previous.network) !== canonical(result.plan.network) ||
    canonical(previous.terms) !== canonical(result.plan.terms) ||
    canonical(previous.proposal) !== canonical(result.plan.proposal) ||
    canonical(previous.draft) !== canonical(result.plan.draft) ||
    canonical(previous.lines) !== canonical(result.plan.lines) ||
    canonical(previous.targets) !== canonical(result.plan.targets)
  )
    return { kind: 'invalid', issues: ['STORED_PLAN_IMMUTABLE_MISMATCH'] };
  return result;
}

/** Numeric cash-flow requests need a dedicated sourced feasibility evaluator, not objective prose. */
function hasUnsupportedIncomeRequirement(text: string): boolean {
  if (
    /^["“‘']|\b(?:if|should\s+i|said|quoted|example|explain|understand|se\s+eu|disse|exemplo|entender)\b/iu.test(
      text,
    )
  )
    return false;
  if (
    !/^(?:please\s+)?(?:i\s+(?:think\s+i\s+)?(?:want|would\s+like|need|plan)|we\s+want|withdraw|pay|quero|preciso|retirar|saque)\b/iu.test(
      text,
    )
  )
    return false;
  if (/\b(?:do\s+not|don't|não|nao)\s+(?:want|need|quero|preciso|withdraw)\b/iu.test(text))
    return false;
  return /(?:[$€£]|\d)\s*[\d,.]*[^.!?]*(?:per\s+month|monthly|a\s+month|por\s+m[eê]s|mensal)|\b(?:withdraw|withdrawals|saque|retirar)\b[^.!?]*\d/iu.test(
    text,
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
      /^(?:please\s+)?(?:i\s+(?:think\s+i\s+)?(?:want|would\s+like|would\s+prefer)|we\s+want|put|allocate|hold|keep|set|make|increase|reduce|replace|(?:acho\s+que\s+)?quero|prefiro|coloque|aloque|mantenha|aumente|reduza|faça|faca)\b/iu.test(
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
