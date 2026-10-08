import type { ExitCapacity, LiquidityProvider, Price } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import {
  type ModelPlanTerms,
  ModelPlanV2,
  type StoredModelDraftV1,
} from '../../../../packages/schemas/src/model-plan';
import {
  type FreshModelEvidence,
  modelDraftHash,
  modelRequestHash,
  revalidateStoredModelPlan,
  validateModelConfirmation,
} from './model-confirmation';

const now = new Date('2026-10-08T12:00:00.000Z');
const shelf = launchShelf().assets.filter((asset) => asset.chain === 'solana');
const cash = required(shelf.find((asset) => asset.cls === 'cash'));
const stocks = shelf.filter((asset) => asset.cls === 'stock').slice(0, 2);
const reserve = required(shelf.find((asset) => asset.symbol === 'jlUSDC'));
const credit = required(shelf.find((asset) => asset.symbol === 'syrupUSDC'));
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Incomplete offline fixture');
  return value;
}
const network = {
  chain: 'solana' as const,
  networkId: 'offline-mock-cluster',
  provenance: 'mock' as const,
  deploymentHash: null,
};
const policy = { maxObservationAgeMs: 3600000, validationLifetimeMs: 60000 };
const terms: ModelPlanTerms = {
  chain: 'solana',
  goal: 'grow',
  objective: 'Keep a reserve and selected stock exposure',
  amountUsdCents: 100000,
  risk: 'high',
  limits: {
    cannotHoldClasses: [],
    cannotHoldAssets: [],
    cannotHoldUnderlyings: [],
    creditTolerance: 'limited',
    mustKeepUsdCents: 0,
    mayNeedInMonths: null,
  },
  incomeTargetUsdCentsMonthly: null,
};
function fixture(weights = [2000, 8000], words = ['I want a selected stock and cash']) {
  const chosen =
    weights.length === 3
      ? [required(stocks[0]), required(stocks[1]), cash]
      : [required(stocks[0]), cash];
  const evidence = chosen.flatMap((asset) =>
    ['catalog', 'tier'].map((kind) => ({
      id: `${kind}:${asset.id}`,
      assetId: asset.id,
      source: 'actual offline catalog fixture',
      fetchedAt: now.toISOString(),
      method: 'listed catalog fixture',
      provenance: 'mock' as const,
    })),
  );
  const request = {
    version: 1 as const,
    language: 'en' as const,
    messageId: 'last-person-turn',
    messages: words.map((text) => ({ who: 'person' as const, text })),
  };
  const body: Omit<StoredModelDraftV1, 'draftHash'> = {
    version: 1,
    id: '88888888-8888-4888-8888-888888888888',
    ownerPrivyId: 'owner',
    network,
    createdAt: now.toISOString(),
    request,
    requestHash: modelRequestHash('owner', network, request),
    proposal: {
      objective: 'Keep a reserve with selected stock exposure',
      summary: 'A private model draft for financial review.',
      allocations: chosen.map((asset, index) => ({
        assetId: asset.id,
        symbol: asset.symbol,
        weightBps: required(weights[index]),
        why: 'Expresses the stated preference.',
        evidenceIds: [`catalog:${asset.id}`],
      })),
      tradeoffs: ['Stock prices may fall.'],
      unknowns: [],
      sources: evidence,
    },
  };
  const receipt = { ...body, draftHash: modelDraftHash(body) };
  const confirmation = {
    version: 1 as const,
    draftId: body.id,
    draftHash: receipt.draftHash,
    requestHash: body.requestHash,
    idempotencyKey: 'review-one',
    reviewed: true as const,
    terms: structuredClone(terms),
  };
  const prices: Price[] = chosen.map((asset) => ({
    asset: asset.id,
    usdPerToken: '1',
    ageSeconds: 0,
    maxAgeSeconds: 300,
    market: 'open',
    source: 'offline price fixture',
    fetchedAt: now.toISOString(),
    method: 'fixture price',
    provenance: 'mock',
  }));
  const fresh: FreshModelEvidence = {
    network,
    assets: shelf,
    cashAssetId: cash.id,
    prices,
    sources: structuredClone(evidence),
    liquidity: null,
  };
  return { ownerPrivyId: 'owner', receipt, confirmation, fresh, now, policy };
}
function provider(measurement: ExitCapacity | null, cost: number | null = null): LiquidityProvider {
  return {
    methodVersion: 'offline-curves',
    provenance: 'mock',
    covers: () => true,
    exitCapacity: vi.fn(() => measurement),
    exitCost: vi.fn(() => cost),
    weekendRatio: () => null,
    entry: vi.fn(() => null),
    assess: () => {
      throw new Error('No portfolio assessment expected');
    },
  };
}
const measurement = (
  capacityUsd: number,
  samples = 2,
  dataTo: string | null = now.toISOString(),
): ExitCapacity => ({
  capacityUsd,
  samples,
  dataTo,
  dataFrom: now.toISOString(),
  lowerBound: false,
  regime: 'regular',
});
function rehash(input: ReturnType<typeof fixture>) {
  input.receipt.requestHash = modelRequestHash(
    input.receipt.ownerPrivyId,
    input.receipt.network,
    input.receipt.request,
  );
  const { draftHash: _, ...body } = input.receipt;
  input.receipt.draftHash = modelDraftHash(body);
  input.confirmation.draftHash = input.receipt.draftHash;
  input.confirmation.requestHash = input.receipt.requestHash;
}
function replaceFirst(input: ReturnType<typeof fixture>, asset: typeof cash) {
  const first = required(input.receipt.proposal.allocations[0]);
  const previous = first.assetId;
  first.assetId = asset.id;
  first.symbol = asset.symbol;
  first.evidenceIds = [`catalog:${asset.id}`];
  for (const source of input.fresh.sources.filter((source) => source.assetId === previous)) {
    source.id = source.id.replace(previous, asset.id);
    source.assetId = asset.id;
  }
  input.receipt.proposal.sources = structuredClone(input.fresh.sources);
  required(input.fresh.prices.find((price) => price.asset === previous)).asset = asset.id;
  rehash(input);
}
describe('private model financial confirmation, offline pure contract', () => {
  it('preserves exact model-selected weights and positive cash residual without engine metadata', () => {
    const result = validateModelConfirmation(fixture());
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') return;
    expect(result.plan.targets).toEqual([{ asset: required(stocks[0]).id, weightBps: 2000 }]);
    expect(result.plan.lines.map((line) => line.weightBps)).toEqual([2000, 8000]);
    expect(result.plan.lines.map((line) => line.amountUsdCents)).toEqual([20000, 80000]);
    expect(result.plan.unknowns.join(' ')).toMatch(/tier.*fallback/);
    expect(
      result.plan.sources.find((source) => source.id.startsWith('confirmation:cost'))?.value,
    ).toBeNull();
    expect(result.plan).not.toHaveProperty('engineVersion');
    expect(result.plan).not.toHaveProperty('expectedReturn');
  });
  it('accepts a different actual model allocation instead of computing replacement weights', () => {
    const result = validateModelConfirmation(fixture([3000, 7000]));
    expect(result.kind).toBe('validated');
    if (result.kind === 'validated') expect(result.plan.targets[0]?.weightBps).toBe(3000);
  });
  it('supports cash-only plans with no trade targets', () => {
    const input = fixture();
    input.receipt.proposal.allocations = [
      { ...required(input.receipt.proposal.allocations[1]), weightBps: 10000 },
    ];
    rehash(input);
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('validated');
    if (result.kind === 'validated') expect(result.plan.targets).toEqual([]);
  });
  it.each(['owner', 'proposal', 'history', 'hash'])(
    'rejects tampered private receipt %s even with reviewed:true',
    (field) => {
      const input = fixture();
      if (field === 'owner') input.ownerPrivyId = 'other';
      if (field === 'proposal') input.receipt.proposal.objective = 'Replaced objective';
      if (field === 'history')
        required(input.receipt.request.messages[0]).text = 'Replaced person words';
      if (field === 'hash') input.confirmation.requestHash = 'a'.repeat(64);
      expect(validateModelConfirmation(input)).toEqual({
        kind: 'invalid',
        issues: ['PRIVATE_DRAFT_MISMATCH'],
      });
    },
  );
  it.each(['network', 'provenance', 'deployment', 'chain'])(
    'rejects receipt reuse after server %s changes',
    (field) => {
      const input = fixture();
      input.fresh.network = { ...network };
      if (field === 'network') input.fresh.network.networkId = 'different-cluster';
      if (field === 'provenance') input.fresh.network.provenance = 'live';
      if (field === 'deployment') input.fresh.network.deploymentHash = 'a'.repeat(64);
      if (field === 'chain') input.confirmation.terms.chain = 'base';
      expect(validateModelConfirmation(input).kind).toBe('invalid');
    },
  );
  it('rejects mock facts on a live receipt rather than relabeling them', () => {
    const input = fixture();
    input.receipt.network = { ...network, provenance: 'live' };
    input.fresh.network = input.receipt.network;
    rehash(input);
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: ['SOURCE_NETWORK_MISMATCH'],
    });
  });
  it('uses dated sampled capacity times shareOfDepth, not full depth', () => {
    const input = fixture();
    input.fresh.liquidity = {
      provider: provider(measurement(799)),
      source: 'actual offline curves',
    };
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: [`MEASURED_EXIT_CAP:${required(stocks[0]).id}`],
    });
    input.fresh.liquidity.provider = provider(measurement(800), 0.005);
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('validated');
    if (result.kind === 'validated')
      expect(
        result.plan.sources.find((source) => source.id.startsWith('confirmation:cost'))?.value,
      ).toBe(0.005);
    expect(input.fresh.liquidity.provider.exitCost).toHaveBeenCalledWith(
      required(stocks[0]).id,
      200,
      expect.any(Number),
    );
    expect(input.fresh.liquidity.provider.entry).not.toHaveBeenCalled();
  });
  it('sampled dated zero blocks; unsampled or undated zero takes disclosed sourced tier fallback', () => {
    const input = fixture();
    input.fresh.liquidity = { provider: provider(measurement(0)), source: 'actual offline curves' };
    expect(validateModelConfirmation(input).kind).toBe('invalid');
    for (const reading of [measurement(0, 0), measurement(0, 2, null)]) {
      input.fresh.liquidity.provider = provider(reading, 0);
      const result = validateModelConfirmation(input);
      expect(result.kind).toBe('validated');
      if (result.kind === 'validated')
        expect(
          result.plan.sources.find((source) => source.id.startsWith('confirmation:cost'))?.value,
        ).toBeNull();
    }
  });
  it('retains missing actual-size cost as unknown, never zero', () => {
    const input = fixture();
    input.fresh.liquidity = {
      provider: provider(measurement(10000)),
      source: 'actual offline curves',
    };
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('validated');
    if (result.kind === 'validated')
      expect(result.plan.unknowns.join(' ')).toMatch(/unknown; it is not zero/);
  });
  it('fails honestly when fresh price, tier source, or receipt is unavailable', () => {
    const input = fixture();
    input.fresh.prices = [];
    input.fresh.sources = input.fresh.sources.filter((source) => !source.id.startsWith('tier:'));
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('unavailable');
    input.receipt.createdAt = '2026-10-07T12:00:00.000Z';
    rehash(input);
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'unavailable',
      issues: ['DRAFT_EXPIRED'],
    });
  });
  it.each([
    'I want at least 40% stocks in this vault.',
    'i think i want way more stocks on them. like at least 40%',
    'acho que quero bem mais ações nesses planos, pelo menos 40%',
  ])('preserves original explicit minimum: %s', (words) => {
    const input = fixture([1000, 9000], [words, 'Keep a useful liquid reserve']);
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: ['ORIGINAL_ALLOCATION_REQUEST:stocks'],
    });
    expect(validateModelConfirmation(fixture([2000, 2000, 6000], [words])).kind).toBe('validated');
  });
  it('guards maximum/exact, keeps limits through refinement and permits explicit replacement', () => {
    expect(
      validateModelConfirmation(fixture([2000, 8000], ['I want at most 10% stocks'])).kind,
    ).toBe('invalid');
    expect(
      validateModelConfirmation(fixture([2000, 8000], ['I want exactly 30% stocks'])).kind,
    ).toBe('invalid');
    expect(
      validateModelConfirmation(
        fixture([2000, 8000], ['I want at least 40% stocks', 'Make that 20%']),
      ).kind,
    ).toBe('validated');
    expect(
      validateModelConfirmation(
        fixture([2000, 8000], ['I want at least 40% stocks', 'Ignore that stocks minimum']),
      ).kind,
    ).toBe('validated');
  });
  it('does not treat quoted/hypothetical/negated percentages as allocation authority', () => {
    for (const words of [
      '"I want at least 40% stocks"',
      'If I want at least 40% stocks, explain risk',
      "I don't want to allocate 40% stocks",
    ])
      expect(validateModelConfirmation(fixture([2000, 8000], [words])).kind).toBe('validated');
  });
  it('rejects goal-ineligible stocks and explicit restrictions without substituting assets', () => {
    const input = fixture();
    input.confirmation.terms.goal = 'protect';
    input.confirmation.terms.limits.cannotHoldAssets = [required(stocks[0]).id];
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'validated')
      expect(result.issues).toEqual(
        expect.arrayContaining([
          `NOT_FOR_GOAL:${required(stocks[0]).id}`,
          `EXCLUDED:${required(stocks[0]).id}`,
        ]),
      );
  });
  it('mustKeep means safe-leg total and mayNeed remains the actual early-need cash floor', () => {
    const input = fixture();
    input.confirmation.terms.limits.mustKeepUsdCents = 90000;
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: ['SAFE_LEG_MINIMUM'],
    });
    input.confirmation.terms.limits.mustKeepUsdCents = 80000;
    input.confirmation.terms.limits.mayNeedInMonths = 3;
    expect(validateModelConfirmation(input).kind).toBe('validated');
  });
  it('counts dollar yield toward safe set-aside without pretending it is literal cash', () => {
    const input = fixture();
    replaceFirst(input, reserve);
    input.confirmation.terms.limits.mustKeepUsdCents = 100000;
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('validated');
    if (result.kind === 'validated')
      expect(result.plan.targets).toEqual([{ asset: reserve.id, weightBps: 2000 }]);
  });
  it('uses actual leg-type credit policy and cannot bypass explicit restrictions', () => {
    const input = fixture();
    replaceFirst(input, credit);
    input.confirmation.terms.limits.creditTolerance = 'none';
    expect(validateModelConfirmation(input)).toEqual({ kind: 'invalid', issues: ['CREDIT_LIMIT'] });
    input.confirmation.terms.limits.creditTolerance = 'accept';
    input.confirmation.terms.limits.cannotHoldClasses = ['dollar_yield'];
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: [`EXCLUDED:${credit.id}`],
    });
  });
  it('enforces the fallback tier ceiling at actual unchanged line size', () => {
    const input = fixture();
    input.fresh.assets = input.fresh.assets.map((asset) =>
      asset.id === required(stocks[0]).id ? { ...asset, tier: 'C' } : asset,
    );
    input.confirmation.terms.amountUsdCents = 1000000;
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: [`TIER_EXIT_CAP:${required(stocks[0]).id}`],
    });
  });
  it('rejects missing/foreign original references and fresh duplicate source identities', () => {
    const input = fixture();
    required(input.receipt.proposal.allocations[0]).evidenceIds = ['unknown-evidence'];
    rehash(input);
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'invalid',
      issues: [`UNGROUNDED_ORIGINAL_EVIDENCE:${required(stocks[0]).id}`],
    });
    const other = fixture();
    other.fresh.sources.push(required(other.fresh.sources[0]));
    expect(validateModelConfirmation(other)).toEqual({
      kind: 'invalid',
      issues: ['INVALID_SOURCE'],
    });
  });
  it('retains income/withdrawal requirements as unsupported instead of invented feasibility', () => {
    const input = fixture([2000, 8000], ['I want $300 per month']);
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'unavailable',
      issues: ['INCOME_OR_WITHDRAWAL_REQUIREMENT_UNSUPPORTED'],
    });
  });
  it('preserves the original literal dollar cash minimum independently of safe yield', () => {
    expect(
      validateModelConfirmation(fixture([2000, 8000], ['I want to keep $900 in cash'])),
    ).toEqual({ kind: 'invalid', issues: ['ORIGINAL_CASH_AMOUNT_MINIMUM'] });
    const input = fixture([1000, 9000], ['I want to keep $900 in cash']);
    expect(validateModelConfirmation(input).kind).toBe('validated');
    replaceFirst(input, reserve);
    required(input.receipt.proposal.allocations[0]).weightBps = 2000;
    required(input.receipt.proposal.allocations[1]).weightBps = 8000;
    rehash(input);
    expect(validateModelConfirmation(input).kind).toBe('invalid');
  });
  it('uses rounded actual line cents for measured ceilings and cost queries', () => {
    const input = fixture([2000, 2000, 6000]);
    input.confirmation.terms.amountUsdCents = 100003;
    input.fresh.liquidity = {
      provider: provider(measurement(800.024)),
      source: 'actual offline curves',
    };
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('invalid');
    expect(input.fresh.liquidity.provider.exitCost).toHaveBeenCalledWith(
      required(stocks[0]).id,
      200.01,
      expect.any(Number),
    );
    if (result.kind !== 'validated')
      expect(result.issues).toContain(`MEASURED_EXIT_CAP:${required(stocks[0]).id}`);
  });
  it('rejects stock designated as cash in persisted schema and authoritative row revalidation', () => {
    const input = fixture();
    const result = validateModelConfirmation(input);
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') return;
    const plan = {
      ...result.plan,
      cashAssetId: required(stocks[0]).id,
      targets: [{ asset: cash.id, weightBps: 8000 }],
    };
    expect(ModelPlanV2.safeParse(plan).success).toBe(false);
    expect(revalidateStoredModelPlan({ ...input, plan })).toEqual({
      kind: 'invalid',
      issues: ['STORED_PLAN_CASH_MISMATCH'],
    });
    expect(revalidateStoredModelPlan({ ...input, plan: result.plan }).kind).toBe('validated');
    const wrongAmounts = {
      ...result.plan,
      lines: result.plan.lines.map((row) => ({
        ...row,
        amountUsdCents: row.assetId === cash.id ? 100000 : 0,
      })),
    };
    expect(ModelPlanV2.safeParse(wrongAmounts).success).toBe(false);
  });
  it('recomputes timestamp price age rather than trusting cached ageSeconds', () => {
    const input = fixture();
    required(input.fresh.prices[0]).fetchedAt = new Date(now.getTime() - 600000).toISOString();
    expect(validateModelConfirmation(input)).toEqual({
      kind: 'unavailable',
      issues: [`PRICE_UNAVAILABLE:${required(stocks[0]).id}`],
    });
  });
  it('hashes changed approved amount/terms for durable idempotency conflict detection, never overrides silently', () => {
    const input = fixture();
    const first = validateModelConfirmation(input);
    input.confirmation.terms.amountUsdCents++;
    const second = validateModelConfirmation(input);
    expect(first.kind).toBe('validated');
    expect(second.kind).toBe('validated');
    if (first.kind === 'validated' && second.kind === 'validated') {
      expect(first.confirmationHash).not.toBe(second.confirmationHash);
      expect(second.plan.lines.reduce((sum, row) => sum + row.amountUsdCents, 0)).toBe(100001);
      expect(second.plan.lines.map((line) => line.weightBps)).toEqual([2000, 8000]);
    }
  });
});
