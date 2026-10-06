import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as schemas from '@colosseum/schemas';
import {
  AcceptVersionArgs,
  Address,
  ApproveArgs,
  AssetId,
  AssetUnits,
  AttemptFate,
  AttemptRef,
  assertChainsReady,
  BasketAsset,
  BasketId,
  BasketProposal,
  BasketProposalBase,
  BasketSheet,
  BasketSheetDraft,
  BasketTx,
  BuildLegResponse,
  BuiltTx,
  BuiltTxBase,
  CancelLegResponse,
  CHAIN_ERROR_RETRYABLE,
  ChainError,
  ChainErrorCode,
  CONTRACT_ERROR_CODE,
  ConsentRequest,
  CreateVaultArgs,
  CreatorLimitReason,
  chainFamily,
  creatorLimitReasonId,
  creatorLimitReasonOf,
  DepositArgs,
  EvmAddress,
  evmCallPreimage,
  FundingNeed,
  Holding,
  IntentRequest,
  isStalePrice,
  Leg,
  LegBase,
  LegRouteParams,
  LimitContext,
  LimitResult,
  normalizeAddress,
  ORDER_LIMITS,
  Order,
  OrderDetail,
  OrderError,
  OrderRouteParams,
  Owner,
  OwnerSwapArgs,
  PortfolioResponse,
  PROGRAM_ERRORS,
  Price,
  PublishRecipeArgs,
  parseChainConfigs,
  parseFlags,
  RawAmount,
  RawDelta,
  RebalancePlan,
  RebalancePolicy,
  Recipe,
  RecipeBase,
  RecipeDraft,
  ReportLegRequest,
  type RollUpContext,
  SCOPE_MAINNET,
  SetAutoFollowArgs,
  SetTargetsArgs,
  SolanaAddress,
  stampTx,
  Targets,
  Trade,
  UnsignedTx,
  VaultState,
  WalletAccount,
  WalletError,
  WalletErrorCode,
  WithdrawInKindArgs,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

const SOL = 'So11111111111111111111111111111111111111112';
const EVM = '0x204faca1764b154221e35c0d20abb3c525710498';
const HEX32 = 'ab'.repeat(32);
const NOW = '2026-10-02T15:00:00.000Z';

const recipe = {
  schemaVersion: 1,
  familyId: HEX32,
  chain: 'solana',
  onchainId: null,
  creator: SOL,
  kind: 'community',
  version: 1,
  effectiveAt: 0,
  components: [
    { kind: 'asset', asset: 'solana:spyx', weightBps: 6000 },
    { kind: 'asset', asset: 'solana:nvdax', weightBps: 4000 },
  ],
  metaHash: HEX32,
  maxFeeBps: 0,
  flags: 0,
};

describe('vault schemas, v0 (DESIGN-VAULT 3.1 to 3.6)', () => {
  it('exports a zod schema under the name of every type the design lists', () => {
    const names = [
      // 3.1
      ...['ChainId', 'Address', 'RawAmount', 'AssetId', 'Sourced', 'BasketAsset', 'Component'],
      ...['Recipe', 'Target', 'FamilyMeta', 'Price', 'Holding', 'VaultState', 'VaultView'],
      ...['Trade', 'Quote', 'Funding', 'TxStatus'],
      // 3.2
      'Capabilities',
      // 3.3
      ...['BuiltTx', 'BasketTx', 'LegStatus', 'LegKind', 'Leg', 'Attempt', 'Owner', 'Order'],
      ...['IntentRequest', 'Principal', 'BuildLegResponse', 'ReportLegRequest', 'ConsentRequest'],
      ...['OrderError', 'OrderDetail', 'PortfolioResponse', 'CancelLegResponse'],
      // 3.5
      'WalletAccount',
      // 3.6
      ...['BasketSheet', 'BasketSheetDraft', 'Shelf', 'PersonalParams', 'Reason', 'BasketLine'],
      'BasketCard',
      ...['Verdict', 'ObservationRef', 'BasketProposal', 'Share', 'LimitContext', 'LimitResult'],
      ...['RiskRollUp', 'CreatorLimitReason', 'AssetUnits', 'RebalancePolicy', 'RebalancePlan'],
    ];
    const exported = schemas as unknown as Record<string, { safeParse?: unknown } | undefined>;
    const missing = names.filter((n) => typeof exported[n]?.safeParse !== 'function');
    expect(missing).toEqual([]);
  });

  it('takes an address as base58 or lower-case 0x, so it compares as a string', () => {
    expect(Address.safeParse(SOL).success).toBe(true);
    expect(Address.safeParse(EVM).success).toBe(true);
    expect(Address.safeParse('0x204FAca1764B154221e35c0d20aBb3c525710498').success).toBe(false);
    expect(Address.safeParse('0x1234').success).toBe(false);
    expect(chainFamily('solana')).toBe('solana');
    expect([chainFamily('base'), chainFamily('robinhood')]).toEqual(['evm', 'evm']);
  });

  it('keeps amounts as integer strings, never a float', () => {
    for (const ok of ['0', '1', '250000000', '9'.repeat(78)])
      expect(RawAmount.safeParse(ok).success).toBe(true);
    for (const bad of ['', '1.5', '-1', '01', '1e6', ' 1', '9'.repeat(79)])
      expect(RawAmount.safeParse(bad).success).toBe(false);
    expect(RawAmount.safeParse(1).success).toBe(false);
    expect(RawDelta.safeParse('-250').success).toBe(true);
    expect(RawDelta.safeParse('-0').success).toBe(false);
  });

  it('names an asset as chain:slug and a plan id as a 64-bit number', () => {
    expect(AssetId.safeParse('solana:spyx').success).toBe(true);
    expect(AssetId.safeParse('ethereum:spyx').success).toBe(false);
    expect(AssetId.safeParse('solana:SPYx').success).toBe(false);
    expect(BasketId.safeParse('18446744073709551615').success).toBe(true);
    expect(BasketId.safeParse('18446744073709551616').success).toBe(false);
    expect(BasketId.safeParse('007').success).toBe(false);
  });

  it('holds a recipe to exactly 10,000 and a shared portfolio to assets only', () => {
    expect(Recipe.safeParse(recipe).success).toBe(true);
    const short = [recipe.components[0], { ...recipe.components[1], weightBps: 3999 }];
    expect(Recipe.safeParse({ ...recipe, components: short }).success).toBe(false);
    const viaIndex = [recipe.components[0], { kind: 'index', family: 'chips', weightBps: 4000 }];
    expect(Recipe.safeParse({ ...recipe, components: viaIndex }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, kind: 'personal', components: viaIndex }).success).toBe(
      true,
    );
    // Both are stored onchain and must be zero in the MVP.
    expect(Recipe.safeParse({ ...recipe, maxFeeBps: 25 }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, flags: 1 }).success).toBe(false);
    expect(Targets.safeParse([{ asset: 'solana:spyx', weightBps: 10_000 }]).success).toBe(true);
  });

  it("holds a person's own targets to at most 10,000: what is left is the plan's cash share", () => {
    const spy = { asset: 'solana:spyx', weightBps: 6000 };
    const nvda = { asset: 'solana:nvdax', weightBps: 3950 };
    expect(Targets.safeParse([{ ...spy, weightBps: 9_950 }]).success).toBe(true);
    expect(Targets.safeParse([spy, nvda]).success).toBe(true);
    expect(Targets.safeParse([spy, { ...nvda, weightBps: 4000 }]).success).toBe(true);
    // Over the whole is refused, and so are a weight of nothing, a repeated asset and an empty list.
    expect(Targets.safeParse([spy, { ...nvda, weightBps: 4001 }]).success).toBe(false);
    expect(Targets.safeParse([spy, { ...nvda, weightBps: 0 }]).success).toBe(false);
    expect(Targets.safeParse([spy, { ...spy, weightBps: 1000 }]).success).toBe(false);
    expect(Targets.safeParse([]).success).toBe(false);
    // A shared portfolio still adds up to exactly 10,000, on the page and in a publish request.
    const short = [recipe.components[0], { ...recipe.components[1], weightBps: 3950 }];
    expect(Recipe.safeParse({ ...recipe, components: short }).success).toBe(false);
    expect(RecipeDraft.safeParse({ chain: 'solana', components: short }).success).toBe(false);
    expect(RecipeDraft.safeParse({ chain: 'solana', components: recipe.components }).success).toBe(
      true,
    );
  });

  it('builds the transaction types from UnsignedTx without its structurer fields', () => {
    const keys = Object.keys(BuiltTx.shape);
    for (const reused of [
      'payload',
      'evm',
      'chain',
      'description',
      'provenance',
      'lastValidBlockHeight',
    ])
      expect(keys).toContain(reused);
    for (const dropped of ['kind', 'legAssetId', 'executionId', 'legId', 'attemptId'])
      expect(keys).not.toContain(dropped);
    expect(Object.keys(UnsignedTx.shape)).toContain('legAssetId');
    expect(Object.keys(BasketTx.shape)).toEqual([...keys, 'legId', 'attemptId']);
  });

  const built = {
    chain: 'solana',
    payload: 'AA==',
    lastValidBlockHeight: 1000,
    description: 'Add cash to the vault',
    provenance: 'mock',
    legKind: 'deposit',
    chainId: 'solana',
    signer: SOL,
    messageHash: HEX32,
    preview: {
      source: 'chain-mock',
      method: 'mock state transition',
      fetchedAt: NOW,
      provenance: 'mock',
      summary: 'Add cash to the vault',
      simulated: true,
      feeNativeRaw: '5000',
      changes: [{ holder: 'wallet', asset: 'solana:usdc', deltaRaw: '-1000000' }],
      minimums: [],
    },
  } as const;

  it('keeps two shapes: what an adapter builds, and the same with its leg and attempt', () => {
    expect(BuiltTx.safeParse(built).success).toBe(true);
    // An adapter returns no ids, and nothing without both ids is a BasketTx.
    expect(BasketTx.safeParse(built).success).toBe(false);
    expect(BasketTx.safeParse({ ...built, legId: 'leg-1' }).success).toBe(false);
    expect(BasketTx.safeParse({ ...built, legId: null, attemptId: null }).success).toBe(false);
    const stamped = stampTx(BuiltTx.parse(built), { legId: 'leg-1', attemptId: 'att-1' });
    expect(BasketTx.parse(stamped)).toEqual({ ...built, legId: 'leg-1', attemptId: 'att-1' });
    expect(BuiltTx.safeParse({ ...built, legKind: 'set_keeper' }).success).toBe(false);
    const { provenance: _, ...unlabelled } = built.preview;
    expect(BuiltTx.safeParse({ ...built, preview: unlabelled }).success).toBe(false);
  });

  it("holds a transaction's fields to each other", () => {
    const evm = { to: EVM, value: '0', chainId: 46630 };
    const { lastValidBlockHeight: _, ...noHeight } = built;
    const preview = { ...built.preview, changes: [] };
    const onRobinhood = {
      ...noHeight,
      chain: 'evm',
      chainId: 'robinhood',
      signer: EVM,
      evm,
      preview,
    };
    expect(BuiltTx.safeParse(onRobinhood).success).toBe(true);
    const otherChain = [{ holder: 'vault', asset: 'base:usdc', deltaRaw: '1' }];
    const bad = [
      { ...built, chainId: 'base' }, // the Solana family on an EVM chain
      { ...built, evm }, // evm on Solana
      noHeight, // Solana with no last valid block height
      { ...built, signer: EVM }, // an EVM signer on Solana
      { ...onRobinhood, evm: undefined }, // EVM with no evm
      { ...onRobinhood, signer: SOL },
      { ...built, preview: { ...built.preview, changes: otherChain } },
    ];
    for (const tx of bad) expect(BuiltTx.safeParse(tx).success, JSON.stringify(tx)).toBe(false);
    const stamped = { ...built, chainId: 'base', legId: 'l', attemptId: 'a' };
    expect(BasketTx.safeParse(stamped).success).toBe(false);
  });

  it('parses an order with a leg, and labels a leg on a test network as neither live nor mock', () => {
    const leg = {
      id: 'leg-1',
      orderId: 'order-1',
      chain: 'robinhood',
      seq: 0,
      kind: 'create_vault',
      signer: 'owner',
      description: 'Open the vault for this plan',
      trades: [{ sell: 'robinhood:usdc', buy: 'robinhood:nvda', amountInRaw: '1000000' }],
      expected: [{ inRaw: '1000000', outRaw: '20', minOutRaw: '19', costBps: 12 }],
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: 'sandbox',
    };
    expect(Leg.safeParse(leg).success).toBe(true);
    expect(
      Leg.safeParse({ ...leg, orderId: null, signer: 'keeper', kind: 'keeper_leg' }).success,
    ).toBe(true);
    expect(Leg.safeParse({ ...leg, status: 'signed' }).success).toBe(false);
    const order = {
      id: 'order-1',
      type: 'buy',
      owner: { evm: EVM },
      summary: 'Buy a plan on Robinhood Chain',
      legs: [leg],
      warnings: [{ code: 'MARKET_CLOSED', text: 'The stock market is closed.' }],
      needsConsent: [],
      fees: [],
      preparedBy: 'mcp',
      agentLabel: 'an agent',
      status: 'open',
      approvalUrl: '/orders/order-1',
      expiresAt: 1790000000,
      createdAt: NOW,
      disclaimer: schemas.DISCLAIMER.en,
    };
    expect(Order.safeParse(order).success).toBe(true);
    expect(Order.safeParse({ ...order, needsConsent: ['set_keeper'] }).success).toBe(false);
    // A leg belongs to its order, on a chain the owner has an address for.
    expect(Order.safeParse({ ...order, owner: { solana: SOL } }).success).toBe(false);
    expect(Order.safeParse({ ...order, id: 'order-2' }).success).toBe(false);
    // MARKET_CLOSED is a warning, never an error code.
    expect(schemas.OrderErrorCode.safeParse('MARKET_CLOSED').success).toBe(false);
    expect(schemas.OrderErrorCode.safeParse('NOT_FUNDED').success).toBe(true);
  });

  it('gives a leg one expected figure per trade, in the order of its trades', () => {
    const trade = { sell: 'robinhood:usdc', buy: 'robinhood:nvda', amountInRaw: '1000000' };
    const figure = { inRaw: '1000000', outRaw: '20', minOutRaw: '19', costBps: 12 };
    const leg = {
      id: 'leg-1',
      orderId: 'order-1',
      chain: 'robinhood',
      seq: 1,
      kind: 'swap',
      signer: 'owner',
      description: 'Buy NVDA and SPY',
      trades: [trade, { ...trade, buy: 'robinhood:spy' }],
      expected: [figure, { ...figure, outRaw: '7', minOutRaw: '6' }],
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: 'mock',
    };
    expect(Leg.parse(leg)).toEqual(leg);
    // No figure at all is allowed: nothing was quoted. One figure for two trades is not.
    expect(Leg.safeParse({ ...leg, expected: [] }).success).toBe(true);
    expect(Leg.safeParse({ ...leg, expected: [figure] }).success).toBe(false);
    expect(Leg.safeParse({ ...leg, expected: null }).success).toBe(false);
    expect(Leg.safeParse({ ...leg, expected: figure }).success).toBe(false);
    // A leg with no trade has no figure.
    expect(Leg.safeParse({ ...leg, kind: 'approve', trades: [], expected: [] }).success).toBe(true);
    expect(Leg.safeParse({ ...leg, kind: 'approve', trades: [], expected: [figure] }).success).toBe(
      false,
    );
  });

  it('states in a preview the least each trade may pay out, as it is in the bytes', () => {
    const floor = { sell: 'solana:usdc', buy: 'solana:spyx', inRaw: '1000000', minOutRaw: '990' };
    const swap = { ...built, legKind: 'swap', preview: { ...built.preview, minimums: [floor] } };
    expect(BuiltTx.parse(swap).preview.minimums).toEqual([floor]);
    // A transaction that trades nothing says so with an empty list. Leaving the field out is refused:
    // a preview that is silent about its trades cannot be held to its bytes.
    expect(BuiltTx.parse(built).preview.minimums).toEqual([]);
    const { minimums: _, ...silent } = built.preview;
    expect(BuiltTx.safeParse({ ...built, preview: silent }).success).toBe(false);
    expect(
      BasketTx.safeParse({ ...built, legId: 'l', attemptId: 'a', preview: silent }).success,
    ).toBe(false);
    const bad = [
      { ...floor, buy: 'solana:usdc' }, // one asset on both sides
      { ...floor, buy: 'base:spy' }, // another chain's asset
      { ...floor, minOutRaw: '9.9' },
      { sell: floor.sell, buy: floor.buy, inRaw: floor.inRaw },
    ];
    for (const entry of bad) {
      const tx = { ...swap, preview: { ...swap.preview, minimums: [entry] } };
      expect(BuiltTx.safeParse(tx).success, JSON.stringify(entry)).toBe(false);
    }
  });

  it('caps what a buy may ask for: its amount and its slippage', () => {
    const buy = { type: 'buy', owner: { solana: SOL }, amountUsd: 500, proposalId: 'p' };
    expect(ORDER_LIMITS).toEqual({ maxAmountUsd: 1_000_000, maxSlippageBps: 300 });
    expect(IntentRequest.safeParse({ ...buy, amountUsd: 1_000_000 }).success).toBe(true);
    const over = IntentRequest.safeParse({ ...buy, amountUsd: 1_000_000.01 });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toMatch(/1,000,000/);
    expect(IntentRequest.safeParse({ ...buy, amountUsd: 1e300 }).success).toBe(false);
    for (const ok of [0, 50, 300])
      expect(IntentRequest.safeParse({ ...buy, maxSlippageBps: ok }).success).toBe(true);
    for (const bad of [301, 10_000, -1, 0.5])
      expect(IntentRequest.safeParse({ ...buy, maxSlippageBps: bad }).success).toBe(false);
  });

  it('answers a refusal with the order code where one fits, and the chain code beside it', () => {
    const refusal = {
      error: 'the wallet holds less cash than this',
      code: 'NOT_FUNDED',
      fix: 'Add cash to the wallet on this chain, then build the step again.',
      details: { chainCode: 'NotFunded', retryable: false },
    };
    expect(OrderError.parse(refusal)).toEqual(refusal);
    // A refusal that is none of the ten has no code, and still says whether to try again.
    const plain = {
      error: 'the trade is too small',
      details: { chainCode: 'BadTrade', retryable: false },
    };
    expect(OrderError.parse(plain)).toEqual(plain);
    expect(OrderError.safeParse({ error: 'no' }).success).toBe(true);
    expect(OrderError.safeParse({ error: 'no', code: 'MARKET_CLOSED' }).success).toBe(false);
    expect(OrderError.safeParse({ error: 'no', details: { chainCode: 'Nope' } }).success).toBe(
      false,
    );
    expect(OrderError.safeParse({ error: 'no', details: { retryable: 'yes' } }).success).toBe(
      false,
    );
  });

  it('names what the order and portfolio routes answer', () => {
    expect(Object.keys(OrderDetail.shape)).toEqual([
      ...Object.keys(schemas.OrderBase.shape),
      'attempts',
    ]);
    expect(CancelLegResponse).toBe(OrderDetail);
    expect(LegRouteParams.safeParse({ id: HEX32, legId: HEX32 }).success).toBe(false);
    const ids = {
      id: '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d',
      legId: '5b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d',
    };
    expect(LegRouteParams.parse(ids)).toEqual(ids);
    expect(OrderRouteParams.parse({ id: ids.id })).toEqual({ id: ids.id });
    const empty = { chains: [], disclaimer: schemas.DISCLAIMER.en };
    expect(PortfolioResponse.parse(empty)).toEqual(empty);
    const chain = {
      chain: 'solana',
      name: 'Solana',
      mode: 'mock',
      provenance: 'mock',
      vaults: [],
      prices: [],
    };
    expect(PortfolioResponse.safeParse({ ...empty, chains: [chain] }).success).toBe(true);
    expect(
      PortfolioResponse.safeParse({ ...empty, chains: [{ ...chain, provenance: undefined }] })
        .success,
    ).toBe(false);
  });

  it('tells the six intents apart by type', () => {
    const ok = [
      { type: 'buy', owner: { solana: SOL }, amountUsd: 500, family: 'sand-to-server' },
      { type: 'rebalance', vaults: [SOL], reason: 'manual' },
      { type: 'follow', vault: EVM, family: 'sand-to-server', autoFollow: false },
      {
        type: 'publish',
        creator: { solana: SOL },
        family: 'x',
        name: 'X',
        copy: '',
        recipes: [{ chain: 'solana', components: recipe.components }],
      },
      { type: 'withdraw', vaults: [EVM], sellToCash: false },
      { type: 'settings', vault: EVM, autoFollow: true },
    ];
    for (const req of ok) expect(IntentRequest.safeParse(req).success).toBe(true);
    expect(IntentRequest.safeParse({ type: 'set_keeper', vault: EVM }).success).toBe(false);
    expect(IntentRequest.safeParse({ type: 'buy', owner: {}, amountUsd: 500 }).success).toBe(false);
    const noMoney = { type: 'buy', owner: { solana: SOL }, amountUsd: 0 };
    expect(IntentRequest.safeParse(noMoney).success).toBe(false);
    expect(
      IntentRequest.safeParse({ type: 'rebalance', vaults: [], reason: 'manual' }).success,
    ).toBe(false);
  });

  it('bounds the sheet and holds a plan to exactly 10,000', () => {
    const sheet = {
      basketType: 'standard',
      goal: 'grow',
      amountUsd: 5000,
      horizonMonths: 60,
      risk: 'medium',
      themes: ['sand-to-server'],
      country: 'BR',
      chains: ['solana', 'robinhood'],
      rules: { useHoldings: true, glide: true },
      language: 'en',
    };
    expect(BasketSheet.safeParse(sheet).success).toBe(true);
    expect(BasketSheet.safeParse({ ...sheet, amountUsd: 9 }).success).toBe(false);
    expect(BasketSheet.safeParse({ ...sheet, horizonMonths: 481 }).success).toBe(false);
    expect(BasketSheet.safeParse({ ...sheet, themes: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(BasketSheet.safeParse({ ...sheet, country: 'Brazil' }).success).toBe(false);
    // Gate COUNTRY-REMOVED (Oct 6): optional and unused in planning; a stored sheet with one parses.
    const { country: _, ...noCountry } = sheet;
    expect(BasketSheet.safeParse(noCountry).success).toBe(true);
    expect(BasketSheet.safeParse({ ...sheet, country: 'BR' }).success).toBe(true);
    expect(BasketSheet.safeParse({ ...sheet, chains: [] }).success).toBe(false);

    const line = {
      chain: 'solana',
      assetId: 'solana:spyx',
      weightBps: 6000,
      amountUsd: 3000,
      reasons: [],
    };
    const proposal = {
      sheet,
      engineVersion: 'personal-0.1',
      paramsHash: 'p',
      shelfVersion: 's',
      inputsHash: 'i',
      lines: [line, { ...line, chain: 'robinhood', assetId: 'robinhood:nvda', weightBps: 4000 }],
      recipes: [],
      removed: [],
      card: {
        moneyTodayUsd: 5000,
        termMonths: 60,
        cashFlow: 'none',
        expectedReturn: { lowPct: 0, highPct: 0, basis: 'none assumed', lossInFallUsd: 1000 },
        exit: { text: 'not measured', costBps: null },
      },
      flags: [],
      observations: [],
      disclaimer: schemas.DISCLAIMER.en,
    };
    expect(BasketProposal.safeParse(proposal).success).toBe(true);
    expect(BasketProposal.safeParse({ ...proposal, lines: [line] }).success).toBe(false);
  });

  it('reads a limit result as passed with its turnover, or refused with a code', () => {
    expect(LimitResult.safeParse({ ok: true, turnoverBps: 1500 }).success).toBe(true);
    // The code is one of the fourteen reasons, by its name in the shared vectors.
    const refused = { ok: false, code: 'TurnoverTooHigh', detail: '' };
    expect(LimitResult.safeParse(refused).success).toBe(true);
    expect(LimitResult.safeParse({ ...refused, code: 'TURNOVER' }).success).toBe(false);
    expect(LimitResult.safeParse({ ok: true }).success).toBe(false);
    // A refusal that waiting cures says from when, in unix seconds.
    const soon = { ok: false, code: 'VersionTooSoon', detail: '', allowedAt: 1_791_385_200 };
    expect(LimitResult.parse(soon)).toEqual(soon);
    expect(LimitResult.safeParse({ ...soon, allowedAt: 1.5 }).success).toBe(false);
    expect(LimitResult.safeParse({ ...soon, allowedAt: '1791385200' }).success).toBe(false);
    expect(new WalletError('no_gas')).toMatchObject({ code: 'no_gas', name: 'WalletError' });
  });

  it('names why a wallet call failed, where the first five codes could not say it', () => {
    expect(WalletErrorCode.options).toEqual([
      'rejected',
      'expired',
      'no_gas',
      'wrong_chain',
      'not_connected',
      'wrong_account',
      'unsupported',
      'changed',
      'unknown',
    ]);
    for (const code of ['not_connected', 'wrong_account', 'unsupported', 'changed'] as const)
      expect(new WalletError(code, 'why')).toMatchObject({ code, message: 'why' });
  });

  it('defines the message hash of an EVM call from the call alone, in one form', () => {
    const call = { chainId: 46630, signer: EVM, to: EVM, value: '7', data: '0xa9059cbb' };
    expect(evmCallPreimage(call)).toBe(`evm:46630:${EVM}:${EVM}:7:0xa9059cbb`);
    // Checksum case and upper-case hex are the same call.
    const shouted = {
      ...call,
      signer: '0x204FAca1764B154221e35c0d20aBb3c525710498',
      data: '0xA9059CBB',
    };
    expect(evmCallPreimage(shouted)).toBe(evmCallPreimage(call));
    // Each of the five fields is part of it.
    const others = [
      { ...call, chainId: 4663 },
      { ...call, signer: `0x${'11'.repeat(20)}` },
      { ...call, to: `0x${'11'.repeat(20)}` },
      { ...call, value: '8' },
      { ...call, data: '0x' },
    ];
    expect(new Set([call, ...others].map(evmCallPreimage)).size).toBe(6);
    for (const bad of [
      { ...call, value: '0x7' },
      { ...call, value: '-1' },
      { ...call, data: 'a9059cbb' },
      { ...call, data: '0xa9059cb' },
      { ...call, to: SOL },
      { ...call, chainId: 0.5 },
    ])
      expect(() => evmCallPreimage(bad), JSON.stringify(bad)).toThrow();
    // A transaction's message hash is 32 bytes of lower-case hex: a SHA-256, on both families.
    expect(BuiltTx.safeParse({ ...built, messageHash: 'x' }).success).toBe(false);
    expect(BuiltTx.safeParse({ ...built, messageHash: HEX32.toUpperCase() }).success).toBe(false);
  });

  it('lets an EVM transaction state its nonce and its gas limit, and a rebuild name the nonce to share', () => {
    const evm = { to: EVM, value: '0', chainId: 46630 };
    const { lastValidBlockHeight: _, ...noHeight } = built;
    const onRobinhood = {
      ...noHeight,
      chain: 'evm',
      chainId: 'robinhood',
      signer: EVM,
      preview: { ...built.preview, changes: [] },
    };
    const stated = { ...onRobinhood, evm: { ...evm, nonce: 7, gas: 300_000 } };
    expect(BuiltTx.parse(stated).evm).toEqual({ ...evm, nonce: 7, gas: 300_000 });
    // Both are optional in the shape: a transaction no adapter built may leave them to the wallet.
    expect(BuiltTx.safeParse({ ...onRobinhood, evm }).success).toBe(true);
    expect(BuiltTx.parse({ ...onRobinhood, evm: { ...evm, nonce: 0 } }).evm?.nonce).toBe(0);
    for (const bad of [
      { nonce: -1 },
      { nonce: 1.5 },
      { nonce: '7' },
      { gas: 0 },
      { gas: 21_000.5 },
    ])
      expect(
        BuiltTx.safeParse({ ...onRobinhood, evm: { ...evm, ...bad } }).success,
        JSON.stringify(bad),
      ).toBe(false);
    // The hash is of the call alone: the nonce and the gas are no part of it.
    const call = { chainId: 46630, signer: EVM, to: EVM, value: '0', data: '0x' };
    expect(evmCallPreimage({ ...call, ...{ nonce: 7, gas: 300_000 } })).toBe(evmCallPreimage(call));

    // Every owner builder takes the nonce a rebuild shares with the attempt that is still open.
    const vault = EVM;
    const withNonce: [{ safeParse(v: unknown): { success: boolean } }, object][] = [
      [ApproveArgs, { owner: EVM, basketId: '7', amountRaw: '1' }],
      [
        CreateVaultArgs,
        { owner: EVM, basketId: '7', targets: [], autoFollow: false, slippageBps: 100 },
      ],
      [DepositArgs, { vault, amountRaw: '1', slippageBps: 100 }],
      [
        OwnerSwapArgs,
        {
          vault,
          trades: [{ sell: 'robinhood:usdc', buy: 'robinhood:spy', amountInRaw: '1' }],
          slippageBps: 100,
        },
      ],
      [SetTargetsArgs, { vault, targets: [{ asset: 'robinhood:spy', weightBps: 5000 }] }],
      [AcceptVersionArgs, { vault, recipeOnchainId: 'r', expectedVersion: 2 }],
      [SetAutoFollowArgs, { vault, on: true }],
      [WithdrawInKindArgs, { vault }],
      [PublishRecipeArgs, { creator: SOL, recipe }],
    ];
    for (const [schema, args] of withNonce) {
      expect(schema.safeParse(args).success).toBe(true);
      expect(schema.safeParse({ ...args, nonce: 12 }).success).toBe(true);
      expect(schema.safeParse({ ...args, nonce: -1 }).success).toBe(false);
      expect(schema.safeParse({ ...args, nonce: 1.5 }).success).toBe(false);
    }
  });

  it('takes an approval by its plan, never by a spender a caller names', () => {
    const approve = { owner: EVM, basketId: '7', amountRaw: '1000000' };
    expect(ApproveArgs.parse(approve)).toEqual(approve);
    expect(ApproveArgs.safeParse({ ...approve, spender: EVM }).success).toBe(false);
    expect(ApproveArgs.safeParse({ owner: EVM, spender: EVM, amountRaw: '1' }).success).toBe(false);
    expect(ApproveArgs.safeParse({ ...approve, basketId: '-1' }).success).toBe(false);
  });

  it('says what became of an attempt nobody reported: open, gone, or landed with its id', () => {
    for (const fate of [{ state: 'open' }, { state: 'gone' }, { state: 'landed', txId: 'abc' }])
      expect(AttemptFate.parse(fate)).toEqual(fate);
    expect(AttemptFate.safeParse({ state: 'landed' }).success).toBe(false);
    expect(AttemptFate.safeParse({ state: 'confirmed', txId: 'abc' }).success).toBe(false);
    const attempt = { messageHash: HEX32, signer: SOL, validUntil: '1000', nonce: null };
    expect(AttemptRef.parse(attempt)).toEqual(attempt);
    expect(AttemptRef.safeParse({ ...attempt, validUntil: null, nonce: 3 }).success).toBe(true);
    const { signer: _, ...unsigned } = attempt;
    expect(AttemptRef.safeParse(unsigned).success).toBe(false);
  });

  it('lets a price say when it is too old, by itself', () => {
    const price = {
      source: 'price account, entry 344',
      method: 'value / 10^exponent',
      fetchedAt: NOW,
      provenance: 'sandbox',
      asset: 'solana:spyx',
      usdPerToken: '665.12',
      ageSeconds: 30,
      maxAgeSeconds: 120,
      market: 'open',
    };
    expect(Price.parse(price)).toEqual(price);
    // The chain's own limit travels with the price: without it a caller cannot tell stale from fresh.
    const { maxAgeSeconds: _, ...bare } = price;
    expect(Price.safeParse(bare).success).toBe(false);
    expect(Price.safeParse({ ...price, maxAgeSeconds: -1 }).success).toBe(false);
    expect(isStalePrice(Price.parse(price))).toBe(false);
    expect(isStalePrice({ ageSeconds: 120, maxAgeSeconds: 120 })).toBe(false);
    expect(isStalePrice({ ageSeconds: 121, maxAgeSeconds: 120 })).toBe(true);
  });

  it('shows a multiplier that is scheduled beside the one in force, and only when there is one', () => {
    const holding = {
      asset: 'solana:nvdax',
      raw: '250000000',
      multiplier: '1.02',
      display: '2.55',
    };
    expect(Holding.parse(holding)).toEqual(holding);
    const scheduled = { ...holding, scheduled: { multiplier: '2.5', effectiveAt: 4_102_444_800 } };
    expect(Holding.parse(scheduled)).toEqual(scheduled);
    for (const bad of [
      { multiplier: '2.5' },
      { multiplier: 2.5, effectiveAt: 4_102_444_800 },
      { multiplier: '2.5', effectiveAt: '4102444800' },
      { multiplier: '2.5', effectiveAt: 1.5 },
    ])
      expect(Holding.safeParse({ ...holding, scheduled: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    // A vault's position is a holding: it carries the same.
    const position = { ...scheduled, targetBps: 5000, lastKeeperAt: null };
    expect(VaultState.shape.positions.element.parse(position)).toEqual(position);
  });

  it('lets a funding need say how many of its steps open an account', () => {
    const need = { cashRaw: '1000000', legs: 4, newVault: true };
    expect(FundingNeed.parse(need)).toEqual(need);
    expect(FundingNeed.parse({ ...need, newAccounts: 3 })).toEqual({ ...need, newAccounts: 3 });
    expect(FundingNeed.parse({ ...need, newAccounts: 0 })).toEqual({ ...need, newAccounts: 0 });
    for (const bad of [-1, 1.5, '3'])
      expect(FundingNeed.safeParse({ ...need, newAccounts: bad }).success).toBe(false);
  });

  it('knows the price account of Solana mainnet, and the program that owns it', () => {
    expect(SCOPE_MAINNET).toEqual({
      prices: '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH',
      program: 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ',
    });
    for (const address of Object.values(SCOPE_MAINNET))
      expect(SolanaAddress.safeParse(address).success).toBe(true);
    for (const network of ['mainnet', 'local'])
      expect(parseChainConfigs({ CHAIN_NETWORK_SOLANA: network }).solana.priceSource).toEqual({
        kind: 'scope',
        address: SCOPE_MAINNET.prices,
      });
    // A test network has no Scope: its price account is ours, set at deploy.
    expect(parseChainConfigs({}).solana.priceSource).toEqual({ kind: 'scope', address: null });
    // With the account known, mainnet lacks only what a deploy brings.
    const env = { CHAIN_MODE_SOLANA: 'readonly', CHAIN_NETWORK_SOLANA: 'mainnet' };
    expect(() => assertChainsReady(parseFlags(env), parseChainConfigs(env))).toThrow(
      'CHAIN_MODE_SOLANA is readonly on mainnet-beta, but these are not set: contracts.solana.program',
    );
  });

  it('names the fourteen author-limit reasons as the shared vectors number them', () => {
    const vectors: { reasons: { id: number; name: string }[] } = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'creator-limits', 'vectors.json'), 'utf8'),
    );
    expect(vectors.reasons).toHaveLength(14);
    expect(CreatorLimitReason.options).toEqual(vectors.reasons.map((r) => r.name));
    for (const { id, name } of vectors.reasons) {
      const reason = CreatorLimitReason.parse(name);
      expect(creatorLimitReasonId(reason)).toBe(id);
      expect(creatorLimitReasonOf(id)).toBe(reason);
    }
    for (const none of [0, 15, -1, 1.5, Number.NaN]) expect(creatorLimitReasonOf(none)).toBeNull();
  });

  it('gives the author-limit check its delay, and the planner its policy and its units', () => {
    const listed = { id: 'solana:spyx', maxWeightBps: 5000, cls: 'etf' };
    const ctx = { assets: [listed], now: 1000, lastPublishAt: null, hasPending: false };
    // Without the delay "one version per publish delay" cannot be checked.
    expect(LimitContext.safeParse(ctx).success).toBe(false);
    expect(LimitContext.safeParse({ ...ctx, publishDelay: 172_800 }).success).toBe(true);
    expect(LimitContext.safeParse({ ...ctx, publishDelay: -1 }).success).toBe(false);
    expect(LimitContext.safeParse({ ...ctx, publishDelay: 0.5 }).success).toBe(false);
    // The check reads an asset's id, its ceiling and whether it is the cash token: all three are asked for.
    const { cls: _, ...unmarked } = listed;
    expect(LimitContext.safeParse({ ...ctx, publishDelay: 60, assets: [unmarked] }).success).toBe(
      false,
    );

    expect(RebalancePolicy.safeParse({ bandBps: 50, minTradeUsd: 1 }).success).toBe(true);
    expect(RebalancePolicy.safeParse({ bandBps: 0, minTradeUsd: 0, costBps: 100 }).success).toBe(
      true,
    );
    expect(RebalancePolicy.safeParse({ bandBps: 50 }).success).toBe(false);
    expect(RebalancePolicy.safeParse({ bandBps: 50, minTradeUsd: -1 }).success).toBe(false);
    expect(
      RebalancePolicy.safeParse({ bandBps: 50, minTradeUsd: 1, costBps: 10_001 }).success,
    ).toBe(false);
    expect(AssetUnits.safeParse({ id: 'solana:spyx', decimals: 8 }).success).toBe(true);
    expect(AssetUnits.safeParse({ id: 'solana:spyx' }).success).toBe(false);
    const plan = { trades: [], unpriced: ['solana:odd'], weighed: false };
    expect(RebalancePlan.parse(plan)).toEqual(plan);
    // The roll-up is told the time: a stored quote cannot be called fresh or stale without one.
    const rollUpTakesNow: RollUpContext = {
      shelf: { version: 's', assets: [], families: [] },
      quotes: [],
      now: NOW,
    };
    expect(rollUpTakesNow.now).toBe(NOW);
  });
  it('lists each asset once: a repeated asset is not a way to reach 10,000', () => {
    const spy = { asset: 'solana:spyx', weightBps: 5000 };
    expect(Targets.safeParse([spy, spy]).success).toBe(false);
    expect(Targets.safeParse([spy, { ...spy, asset: 'solana:nvdax' }]).success).toBe(true);
    const twice = [
      { kind: 'asset', asset: 'solana:spyx', weightBps: 5000 },
      { kind: 'asset', asset: 'solana:spyx', weightBps: 3000 },
      { kind: 'asset', asset: 'solana:gold', weightBps: 2000 },
    ];
    expect(Recipe.safeParse({ ...recipe, components: twice }).success).toBe(false);
    const families = [
      { kind: 'index', family: 'chips', weightBps: 5000 },
      { kind: 'index', family: 'chips', weightBps: 5000 },
    ];
    expect(Recipe.safeParse({ ...recipe, kind: 'personal', components: families }).success).toBe(
      false,
    );
    // A line of nothing is not a line, and an asset of another chain is not this recipe's.
    const withZero = [...recipe.components, { kind: 'asset', asset: 'solana:gold', weightBps: 0 }];
    expect(Recipe.safeParse({ ...recipe, components: withZero }).success).toBe(false);
    const elsewhere = [
      recipe.components[0],
      { kind: 'asset', asset: 'base:nvda', weightBps: 4000 },
    ];
    expect(Recipe.safeParse({ ...recipe, components: elsewhere }).success).toBe(false);
  });

  it('checks an address against its family', () => {
    const checksummed = '0x204FAca1764B154221e35c0d20aBb3c525710498';
    expect(normalizeAddress('evm', checksummed)).toBe(EVM);
    expect(normalizeAddress('solana', ` ${SOL} `)).toBe(SOL);
    expect(() => normalizeAddress('solana', EVM)).toThrow();
    expect(() => normalizeAddress('evm', SOL)).toThrow();
    expect(SolanaAddress.safeParse(EVM).success).toBe(false);
    expect(EvmAddress.safeParse(SOL).success).toBe(false);
    // Base58 of the right length that is not 32 bytes is not an address.
    expect(SolanaAddress.safeParse('abcdefghijkmnopqrstuvwxyzABCDEFG').success).toBe(false);
    expect(SolanaAddress.safeParse('1'.repeat(32)).success).toBe(true);

    expect(Owner.safeParse({ solana: SOL, evm: EVM }).success).toBe(true);
    expect(Owner.safeParse({ solana: EVM }).success).toBe(false);
    expect(Owner.safeParse({ evm: SOL }).success).toBe(false);
    expect(Owner.safeParse({ evm: checksummed }).success).toBe(false);
    expect(Owner.safeParse({}).success).toBe(false);

    const wallet = { family: 'evm', address: EVM, kind: 'embedded' };
    expect(WalletAccount.safeParse(wallet).success).toBe(true);
    expect(WalletAccount.safeParse({ ...wallet, family: 'solana' }).success).toBe(false);
    expect(WalletAccount.safeParse({ ...wallet, address: checksummed }).success).toBe(false);

    const asset = {
      id: 'robinhood:nvda',
      chain: 'robinhood',
      address: EVM,
      symbol: 'NVDA',
      decimals: 18,
      cls: 'stock',
      underlying: 'NVDA',
      issuer: 'x',
      tier: 'A',
      priceKind: 'chainlink',
      priceRef: '',
      session: 'us_equity',
      autoFollowEligible: true,
      maxWeightBps: 5000,
      blockedCountries: [],
      sheet: '',
      provenance: 'sandbox',
    };
    expect(BasketAsset.safeParse(asset).success).toBe(true);
    expect(BasketAsset.safeParse({ ...asset, chain: 'solana' }).success).toBe(false);
    expect(BasketAsset.safeParse({ ...asset, id: 'base:nvda' }).success).toBe(false);
    expect(BasketAsset.safeParse({ ...asset, address: SOL }).success).toBe(false);
    // A cash token may be counted in a currency of its own (the matching leg); nothing else may.
    const reais = { ...asset, id: 'robinhood:brlx', symbol: 'BRLX', cls: 'cash', currency: 'BRL' };
    expect(BasketAsset.safeParse(reais).success).toBe(true);
    expect(BasketAsset.safeParse({ ...reais, currency: 'brl' }).success).toBe(false);
    expect(BasketAsset.safeParse({ ...asset, currency: 'BRL' }).success).toBe(false);
  });

  it('holds a trade to two different assets on one chain, and a leg to its signer', () => {
    const trade = { sell: 'solana:usdc', buy: 'solana:spyx', amountInRaw: '1' };
    expect(Trade.safeParse(trade).success).toBe(true);
    expect(Trade.safeParse({ ...trade, buy: 'solana:usdc' }).success).toBe(false);
    expect(Trade.safeParse({ ...trade, buy: 'base:spy' }).success).toBe(false);

    const leg = {
      id: 'l',
      orderId: 'o',
      chain: 'base',
      seq: 0,
      kind: 'approve',
      signer: 'owner',
      description: '',
      trades: [],
      expected: [],
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: 'live',
    };
    expect(Leg.safeParse(leg).success).toBe(true);
    // A keeper leg belongs to no order and is one of the two keeper kinds; an owner leg is neither.
    expect(Leg.safeParse({ ...leg, signer: 'keeper' }).success).toBe(false);
    expect(Leg.safeParse({ ...leg, signer: 'keeper', orderId: null }).success).toBe(false);
    expect(Leg.safeParse({ ...leg, kind: 'keeper_leg' }).success).toBe(false);
    expect(Leg.safeParse({ ...leg, orderId: null }).success).toBe(false);
    const keeper = { ...leg, signer: 'keeper', orderId: null, kind: 'adopt_version' };
    expect(Leg.safeParse(keeper).success).toBe(true);
  });

  it('carries one refusal type, with one list of codes', () => {
    const e = new ChainError('VersionMismatch', 'the active version is 3');
    expect(e).toBeInstanceOf(Error);
    expect(e.toJSON()).toEqual({
      code: 'VersionMismatch',
      message: 'the active version is 3',
      retryable: false,
    });
    // Building again can succeed on its own for these, and only for these kinds of refusal.
    expect(new ChainError('ReceivedTooLittle', '').retryable).toBe(true);
    expect(new ChainError('MarketClosed', '').retryable).toBe(true);
    expect(new ChainError('NotFunded', '').retryable).toBe(false);
    expect(new ChainError('Unknown', '', true).retryable).toBe(true);
    // The vault's own errors, in the order the design freezes them, come first.
    expect(ChainErrorCode.options.slice(0, 3)).toEqual([
      'NotKeeper',
      'AutoFollowOff',
      'KeeperPaused',
    ]);
    expect(ChainErrorCode.options).toContain('BadInput');
    expect(new Set(ChainErrorCode.options).size).toBe(ChainErrorCode.options.length);
  });

  it("lists the program's errors first, in the program's own order, the appended fourteen included", () => {
    const idl: { errors: { code: number; name: string }[] } = JSON.parse(
      readFileSync(join(__dirname, '..', 'idl', 'basket.json'), 'utf8'),
    );
    expect(idl.errors.map((e) => e.name)).toEqual([...PROGRAM_ERRORS]);
    expect(idl.errors.map((e) => e.code)).toEqual(PROGRAM_ERRORS.map((_, i) => 6000 + i));
    expect(ChainErrorCode.options.slice(0, PROGRAM_ERRORS.length)).toEqual([...PROGRAM_ERRORS]);
    expect(PROGRAM_ERRORS.slice(23)).toEqual([
      'ParamOutOfBounds',
      'NotUpgradeAuthority',
      'InvalidTargets',
      'NotCashMint',
      'ZeroAddress',
      'LockedAtLaunch',
      'HookNotAllowed',
      'AssetListFull',
      'SameMint',
      'NoPendingVersion',
      'NotCreatorOrGuardian',
      'NotCashLeg',
      'KeeperAssetOff',
      'PriceOutOfRange',
      'NothingTraded',
    ]);
  });

  it('gives every custom error of the EVM contracts a code, and no code to an error they do not have', () => {
    const dir = join(__dirname, '..', 'contracts', 'src');
    const sources = (readdirSync(dir, { recursive: true }) as string[])
      .filter((name) => name.endsWith('.sol'))
      .map((name) => readFileSync(join(dir, name), 'utf8'));
    const declared = new Set(
      sources.flatMap((text) =>
        [...text.matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((m) => m[1] ?? ''),
      ),
    );
    expect(declared.size).toBeGreaterThanOrEqual(14);
    expect(Object.keys(CONTRACT_ERROR_CODE).sort()).toEqual([...declared].sort());
    for (const code of Object.values(CONTRACT_ERROR_CODE))
      expect(ChainErrorCode.safeParse(code).success, code).toBe(true);
    // The same name where the rule is the same, and one code where two errors mean one thing.
    expect(CONTRACT_ERROR_CODE).toMatchObject({
      ZeroAddress: 'ZeroAddress',
      ParamOutOfBounds: 'ParamOutOfBounds',
      InvalidPull: 'ParamOutOfBounds',
      AssetNotListed: 'MintNotAccepted',
      FeedRequired: 'AssetNotPriced',
      NotPendingAdmin: 'NotAdmin',
      // The owner swap and the registry: the program's name for the same rule.
      RouterNotAllowed: 'RouterNotAllowed',
      SpentTooMuch: 'SpentTooMuch',
      ReceivedTooLittle: 'ReceivedTooLittle',
      TokenNotAccepted: 'MintNotAccepted',
      OtherTokenDebited: 'OtherAccountDebited',
      AllowanceLeft: 'AccountTampered',
      InvalidTargets: 'InvalidTargets',
      VersionMismatch: 'VersionMismatch',
      CreatorLimit: 'CreatorLimit',
      NothingPending: 'NoPendingVersion',
      NotCreator: 'NotCreatorOrGuardian',
      // And the adapter's, where a contract refuses what an adapter already refuses under that code.
      IndexNotFound: 'RecipeNotFound',
      VaultExists: 'VaultExists',
      NotSorted: 'BadInput',
      // The keeper's path: the program's names, and the program's code where the rule is its own.
      NotKeeper: 'NotKeeper',
      PastTarget: 'PastTarget',
      LossCapReached: 'LossCapReached',
      PriceOutOfRange: 'PriceOutOfRange',
      ValueTooLow: 'ReceivedTooLittle',
      ValueTooLarge: 'AssetNotPriced',
      AssetHalted: 'MarketClosed',
      DeadlinePassed: 'Expired',
    });
    // A new code only where no program error means the same.
    const added = [...new Set(Object.values(CONTRACT_ERROR_CODE))].filter(
      (code) => !(PROGRAM_ERRORS as readonly string[]).includes(code),
    );
    expect(added.sort()).toEqual(
      [
        'AssetIsRouter',
        'CashTokenNotSet',
        'DepositShortfall',
        'GasTooLow',
        'NoCode',
        'NotAdmin',
        'NotOwner',
        'RouterIsAsset',
        // Added with the factory, the registry and the owner swap.
        'AlreadySet',
        'BalanceUnreadable',
        'CashTokenNotRemovable',
        'HandoverNotDone',
        'NotCreating',
        'RecipeExists',
        'RouterFailed',
        // Adapter codes a contract error means the same as.
        'BadInput',
        'NotSupported',
        'RecipeNotFound',
        'VaultExists',
        // Added with the keeper path: an owner's trade sent after its deadline.
        'Expired',
      ].sort(),
    );
  });

  it('says of every code whether building again can succeed on its own', () => {
    expect(Object.keys(CHAIN_ERROR_RETRYABLE).sort()).toEqual([...ChainErrorCode.options].sort());
    const retryable = ChainErrorCode.options.filter((code) => CHAIN_ERROR_RETRYABLE[code]);
    expect(retryable.sort()).toEqual(
      [
        'KeeperPaused',
        'ReceivedTooLittle',
        'PriceStale',
        'PriceDeviation',
        'MarketClosed',
        'MultiplierWindow',
        'Cooldown',
        // Both pass with time alone, like a cooldown: the loss counter decays, the version takes effect.
        'LossCapReached',
        'VersionNotEffective',
        'GasTooLow',
        // The router refused its own trade: a new build takes a fresh quote and a fresh deadline.
        'RouterFailed',
        'Expired',
        'Unavailable',
      ].sort(),
    );
    for (const code of ChainErrorCode.options)
      expect(new ChainError(code, '').retryable, code).toBe(CHAIN_ERROR_RETRYABLE[code]);
    expect(new ChainError('InvalidTargets', '').toJSON()).toEqual({
      code: 'InvalidTargets',
      message: '',
      retryable: false,
    });
  });

  it('exports the plain object beside each refined schema, since zod refuses to reshape a refined one', () => {
    expect(() => Recipe.omit({ onchainId: true })).toThrow();
    for (const base of [RecipeBase, BasketProposalBase, LegBase, BuiltTxBase, schemas.OrderBase])
      expect(Object.keys(base.partial().shape).length).toBeGreaterThan(5);
    expect(Object.keys(RecipeBase.omit({ onchainId: true }).shape)).not.toContain('onchainId');
    expect(Object.keys(BasketProposalBase.pick({ lines: true }).shape)).toEqual(['lines']);
  });

  it('names the bodies of the order routes', () => {
    expect(ReportLegRequest.safeParse({ txId: 'abc' }).success).toBe(true);
    expect(ReportLegRequest.safeParse({ signedTx: 'AA==' }).success).toBe(true);
    expect(ReportLegRequest.safeParse({ txId: 'abc', signedTx: 'AA==' }).success).toBe(false);
    expect(ReportLegRequest.safeParse({}).success).toBe(false);
    expect(ConsentRequest.safeParse({ kinds: ['auto_follow_on'], textVersion: '1' }).success).toBe(
      true,
    );
    expect(ConsentRequest.safeParse({ kinds: [], textVersion: '1' }).success).toBe(false);
    expect(Object.keys(BuildLegResponse.shape)).toEqual(['tx', 'attempt']);
    // The parser's draft: every field of the sheet, each allowed to be null.
    const empty = Object.fromEntries(Object.keys(BasketSheet.shape).map((k) => [k, null]));
    expect(BasketSheetDraft.safeParse(empty).success).toBe(true);
    expect(BasketSheetDraft.safeParse({ ...empty, amountUsd: 5 }).success).toBe(false);
    expect(Object.keys(BasketSheetDraft.shape)).toEqual(Object.keys(BasketSheet.shape));
    // A creator sends the chain and the weights; the server and the registry assign the rest.
    const publish = {
      type: 'publish',
      creator: { solana: SOL },
      family: 'x',
      name: 'X',
      copy: '',
      recipes: [{ chain: 'solana', components: recipe.components }],
    };
    expect(IntentRequest.safeParse(publish).success).toBe(true);
    const viaIndex = [{ kind: 'index', family: 'chips', weightBps: 10_000 }];
    const personal = { ...publish, recipes: [{ chain: 'solana', components: viaIndex }] };
    expect(IntentRequest.safeParse(personal).success).toBe(false);
  });
});
