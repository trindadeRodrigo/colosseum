import {
  type BasketLine,
  BasketProposal,
  type ChainId,
  OrderDetail as Order,
  type OrderDetail,
} from '@colosseum/schemas';
import type { OrderRecord } from '../order-record';
import type { StoredPlan } from '../plan-store';

// What the tests of the plan, buy and order screens share: a plan as "Build my plan" answers it, and an
// order as POST /v1/orders answers a buy of it on Solana, in the shared shapes. Every figure here is
// made up, and its observation says so.

export const USER = 'did:privy:test';
// The fake port's two addresses (features/wallet/test/fake-port.ts). Written out here: a file outside
// the wallet's own test folder imports nothing from it (features/wallet/imports.test.ts).
const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM = '0x204faca1764b154221e35c0d20abb3c525710498';
export const PLAN_ID = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
export const ORDER_ID = '5b1e7c2d-3a4f-4b6c-9d8e-7f6a5b4c3d2e';

export function linesOn(chain: ChainId): BasketLine[] {
  const cash = chain === 'solana' ? 'solana:usdc' : `${chain}:usdc`;
  return [
    { chain, assetId: `${chain}:spyx`, weightBps: 6000, amountUsd: 24_000, reasons: [] },
    {
      chain,
      assetId: `${chain}:gldx`,
      weightBps: 3500,
      amountUsd: 14_000,
      reasons: [{ rule: 'gold', inputs: [], params: {}, text: 'Gold steadies the plan.' }],
    },
    { chain, assetId: cash, weightBps: 500, amountUsd: 2_000, reasons: [] },
  ];
}

export function planOn(chain: ChainId = 'solana', provenance = 'sandbox' as const): StoredPlan {
  const lines = linesOn(chain);
  return {
    id: PLAN_ID,
    userId: USER,
    rollUp: null,
    proposal: BasketProposal.parse({
      sheet: {
        basketType: 'standard',
        goal: 'grow',
        amountUsd: 40_000,
        horizonMonths: 36,
        risk: 'medium',
        themes: [],
        country: 'BR',
        chains: [chain],
        rules: { useHoldings: true, glide: true },
        language: 'en',
      },
      engineVersion: 'personal-0.1',
      paramsHash: 'params',
      shelfVersion: 'shelf',
      inputsHash: 'inputs',
      lines,
      recipes: [
        {
          chain,
          amountUsd: 40_000,
          components: lines
            .slice(0, 2)
            .map((l) => ({ kind: 'asset', asset: l.assetId, weightBps: l.weightBps })),
        },
      ],
      removed: [],
      card: {
        moneyTodayUsd: 40_000,
        termMonths: 36,
        cashFlow: 'none',
        expectedReturn: { lowPct: 1, highPct: 2, basis: 'a test', lossInFallUsd: 4_000 },
        exit: { text: 'up to $40,000 within a day', costBps: 30 },
      },
      flags: [],
      observations: [
        {
          id: 'obs-yield',
          kind: 'yield',
          source: 'a test',
          method: 'fixture',
          fetchedAt: '2026-10-05T12:00:00.000Z',
          provenance,
        },
        {
          id: 'obs-exit',
          kind: 'liquidity',
          source: 'a test',
          method: 'fixture',
          fetchedAt: '2026-10-05T12:00:00.000Z',
          provenance,
        },
      ],
      disclaimer: 'the disclaimer',
    }),
  };
}

export const LEG_CREATE = '11111111-1111-4111-8111-111111111111';
export const LEG_SWAP = '22222222-2222-4222-8222-222222222222';

/** A buy of $10 on a chain: open the vault with the deposit, then one swap. */
export function orderOn(chain: ChainId = 'solana', minOutRaw = '990000'): OrderDetail {
  const evm = chain !== 'solana';
  const leg = {
    orderId: ORDER_ID,
    chain,
    signer: 'owner',
    description: 'server text',
    attempt: 0,
    txId: null,
    explorerUrl: null,
    validUntil: null,
    error: null,
    trigger: 'manual',
    provenance: 'sandbox',
    status: 'planned',
  } as const;
  return Order.parse({
    id: ORDER_ID,
    type: 'buy',
    owner: evm ? { evm: EVM } : { solana: SOLANA },
    summary: 'server text',
    depositRaw: '10000000',
    legs: [
      {
        ...leg,
        id: LEG_CREATE,
        seq: 0,
        kind: 'create_vault',
        cashRaw: '10000000',
        trades: [],
        expected: [],
      },
      {
        ...leg,
        id: LEG_SWAP,
        seq: 1,
        kind: 'swap',
        trades: [{ sell: `${chain}:usdc`, buy: `${chain}:spyx`, amountInRaw: '6000000' }],
        expected: [{ inRaw: '6000000', outRaw: '1000000', minOutRaw, costBps: 10 }],
      },
    ],
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: 'app',
    status: 'open',
    approvalUrl: `/orders/${ORDER_ID}`,
    expiresAt: 1_791_200_000,
    createdAt: '2026-10-05T12:00:00.000Z',
    attempts: [],
    disclaimer: 'the disclaimer',
  });
}

/** The order as it stands once every step landed. */
export function doneOrder(chain: ChainId = 'solana'): OrderDetail {
  const order = orderOn(chain);
  return {
    ...order,
    status: 'done',
    legs: order.legs.map((leg, i) => ({
      ...leg,
      status: 'confirmed',
      attempt: 1,
      txId: `sig${i}`,
      explorerUrl: `https://explorer.example/tx/sig${i}?cluster=devnet`,
    })),
  };
}

/** What the buy screen keeps when it makes the order. */
export function recordOf(chain: ChainId = 'solana', over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: ORDER_ID,
    userId: USER,
    proposalId: PLAN_ID,
    chain,
    amountUsd: 10,
    lines: linesOn(chain),
    approved: null,
    ...over,
  };
}
