import * as schemas from '@colosseum/schemas';
import {
  Address,
  AssetId,
  BasketId,
  BasketProposal,
  BasketSheet,
  BasketTx,
  chainFamily,
  IntentRequest,
  Leg,
  LimitResult,
  Order,
  RawAmount,
  RawDelta,
  Recipe,
  Targets,
  UnsignedTx,
  WalletError,
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
      ...['BasketTx', 'LegStatus', 'LegKind', 'Leg', 'Attempt', 'Owner', 'Order'],
      ...['IntentRequest', 'Principal'],
      // 3.5
      'WalletAccount',
      // 3.6
      ...['BasketSheet', 'Shelf', 'PersonalParams', 'Reason', 'BasketLine', 'BasketCard'],
      ...['Verdict', 'ObservationRef', 'BasketProposal', 'Share', 'LimitContext', 'LimitResult'],
      'RiskRollUp',
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
    expect(Targets.safeParse([{ asset: 'solana:spyx', weightBps: 9_950 }]).success).toBe(false);
  });

  it('builds BasketTx from UnsignedTx without its structurer fields', () => {
    const keys = Object.keys(BasketTx.shape);
    for (const reused of [
      'payload',
      'evm',
      'chain',
      'description',
      'provenance',
      'lastValidBlockHeight',
    ])
      expect(keys).toContain(reused);
    for (const dropped of ['kind', 'legAssetId', 'executionId'])
      expect(keys).not.toContain(dropped);
    expect(Object.keys(UnsignedTx.shape)).toContain('legAssetId');

    const tx = {
      chain: 'solana',
      payload: 'AA==',
      description: 'Add cash to the vault',
      provenance: 'mock',
      legId: null,
      attemptId: null,
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
      },
    };
    expect(BasketTx.safeParse(tx).success).toBe(true);
    expect(BasketTx.safeParse({ ...tx, legId: 'leg-1', attemptId: 'att-1' }).success).toBe(true);
    expect(BasketTx.safeParse({ ...tx, legKind: 'set_keeper' }).success).toBe(false);
    const { provenance: _, ...unlabelled } = tx.preview;
    expect(BasketTx.safeParse({ ...tx, preview: unlabelled }).success).toBe(false);
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
      expected: { inRaw: '1000000', outRaw: '20', minOutRaw: '19', costBps: 12 },
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
    // MARKET_CLOSED is a warning, never an error code.
    expect(schemas.OrderErrorCode.safeParse('MARKET_CLOSED').success).toBe(false);
    expect(schemas.OrderErrorCode.safeParse('NOT_FUNDED').success).toBe(true);
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
        recipes: [recipe],
      },
      { type: 'withdraw', vaults: [EVM], sellToCash: false },
      { type: 'settings', vault: EVM, autoFollow: true },
    ];
    for (const req of ok) expect(IntentRequest.safeParse(req).success).toBe(true);
    expect(IntentRequest.safeParse({ type: 'set_keeper', vault: EVM }).success).toBe(false);
    expect(IntentRequest.safeParse({ type: 'buy', owner: {}, amountUsd: 0 }).success).toBe(false);
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
    expect(LimitResult.safeParse({ ok: false, code: 'TURNOVER', detail: '' }).success).toBe(true);
    expect(LimitResult.safeParse({ ok: true }).success).toBe(false);
    expect(new WalletError('no_gas')).toMatchObject({ code: 'no_gas', name: 'WalletError' });
  });
});
