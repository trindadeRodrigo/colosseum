import {
  OrderDetail as Order,
  type OrderDetail,
  type SharedFamily,
  type SharedRecipe,
  type VaultView,
} from '@colosseum/schemas';

// What the tests of the shared-portfolio screens share: a shared portfolio as GET /v1/indexes/{slug}
// answers it, and the orders POST /v1/orders answers for a publish, a buy of it and a follow, in the
// shared shapes, on Solana's test network. Every figure here is made up.

export const USER = 'did:privy:test';
/** The fake port's Solana address (features/wallet/test/fake-port.ts), written out. */
export const SOLANA = 'So11111111111111111111111111111111111111112';
/** 32 bytes of 7, 9 and 11, in base58: addresses a node's bytes can name. */
export const CREATOR = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx';
export const ORDER_ID = '7c1e7c2d-3a4f-4b6c-9d8e-7f6a5b4c3d2e';
export const LEG_A = '33333333-3333-4333-8333-333333333333';
export const LEG_B = '44444444-4444-4444-8444-444444444444';
export const LEG_C = '55555555-5555-4555-8555-555555555555';
export const SLUG = 'three-of-the-largest';
/** familyIdOf(SLUG): SHA-256 of `family:three-of-the-largest`. */
export const FAMILY_ID = 'd5fb660548c6d1795095afb31262d62ff35cf212f1875aa2d776d9cc247dd3bd';
export const RECIPE = 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN';
export const VAULT = 'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn';

export const WEIGHTS = [
  { asset: 'solana:spyx', weightBps: 4000 },
  { asset: 'solana:nvdax', weightBps: 3000 },
  { asset: 'solana:tslax', weightBps: 3000 },
];

export function recipeOf(over: Partial<SharedRecipe> = {}): SharedRecipe {
  return {
    chain: 'solana',
    name: 'Solana',
    onchainId: RECIPE,
    creator: CREATOR,
    active: {
      version: 2,
      effectiveAt: 1_791_000_000,
      components: WEIGHTS,
      metaHash: 'ab'.repeat(32),
      status: 'active',
    },
    pending: null,
    autoFollow: { offered: true },
    textMatches: 'active',
    source: 'chain',
    observedAt: '2026-10-05T12:00:00.000Z',
    provenance: 'sandbox',
    ...over,
  };
}

export function familyOf(familyId: string, over: Partial<SharedFamily> = {}): SharedFamily {
  return {
    familyId,
    slug: SLUG,
    name: 'Three of the largest',
    copy: 'Three test tokens.',
    kind: 'index',
    platform: false,
    creatorKind: 'community',
    chains: ['solana'],
    recipes: [recipeOf()],
    ...over,
  };
}

const leg = {
  orderId: ORDER_ID,
  chain: 'solana',
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
  trades: [],
  expected: [],
} as const;

const order = (over: Record<string, unknown>): OrderDetail =>
  Order.parse({
    id: ORDER_ID,
    owner: { solana: SOLANA },
    summary: 'server text',
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
    ...over,
  });

/** A publish, as POST /v1/orders answers it: one step, the consent `publish`, nothing deposited. */
export const publishOrder = (more: object[] = []) =>
  order({
    type: 'publish',
    needsConsent: ['publish'],
    legs: [{ ...leg, id: LEG_A, seq: 0, kind: 'publish' }, ...more],
  });

/** A buy of the portfolio for $10: the vault that follows it, then a swap per asset. */
export function familyBuyOrder(amounts = ['4000000', '3000000', '3000000']) {
  const swaps = WEIGHTS.map((t, i) => ({
    ...leg,
    id: [LEG_B, LEG_C, '66666666-6666-4666-8666-666666666666'][i],
    seq: i + 1,
    kind: 'swap',
    trades: [{ sell: 'solana:usdc', buy: t.asset, amountInRaw: amounts[i] }],
    expected: [{ inRaw: amounts[i], outRaw: '100', minOutRaw: '99', costBps: 10 }],
  }));
  return order({
    type: 'buy',
    depositRaw: '10000000',
    legs: [{ ...leg, id: LEG_A, seq: 0, kind: 'create_vault', cashRaw: '10000000' }, ...swaps],
  });
}

/** A follow by a vault the person has: accept the version, and switch auto-follow on. */
export const followOrder = (kinds: ('accept_version' | 'set_auto_follow')[]) =>
  order({
    type: 'follow',
    needsConsent: [
      ...(kinds.includes('accept_version') ? ['new_asset'] : []),
      ...(kinds.includes('set_auto_follow') ? ['auto_follow_on'] : []),
    ],
    legs: kinds.map((kind, seq) => ({ ...leg, id: [LEG_A, LEG_B][seq], seq, kind })),
  });

export function vaultOf(over: Partial<VaultView> = {}): VaultView {
  return {
    chain: 'solana',
    address: VAULT,
    owner: SOLANA,
    basketId: '42',
    recipeOnchainId: RECIPE,
    acceptedVersion: 2,
    autoFollow: false,
    keeper: CREATOR,
    cash: { asset: 'solana:usdc', raw: '0', multiplier: '1', display: '0' },
    positions: [],
    lossUsedBps: 0,
    observedAt: '2026-10-05T12:00:00.000Z',
    pending: null,
    valueUsd: '0',
    ...over,
  } as VaultView;
}

/** GET /v1/funding: the wallet has what a buy of $10 needs, on the test network. */
const figure = {
  source: 'devnet RPC',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  method: 'a balance read',
  provenance: 'sandbox',
};
export const FUNDED = {
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  wallet: SOLANA,
  cash: {
    ...figure,
    asset: 'solana:usdc',
    symbol: 'USDC',
    decimals: 6,
    haveRaw: '50000000',
    needRaw: '10000000',
    missingRaw: '0',
  },
  gas: { ...figure, symbol: 'SOL', decimals: 9, haveRaw: '1', needRaw: '0', missingRaw: '0' },
  steps: 4,
  newVault: true,
  ok: true,
};

/**
 * A withdrawal, as POST /v1/orders answers it: one `withdraw` step per list, each naming what it takes
 * out (`amountRaw` null: all the vault holds of the token).
 */
export const withdrawOrder = (
  steps: { asset: string; amountRaw: string | null; heldRaw: string }[][],
  over: Record<string, unknown> = {},
) =>
  order({
    type: 'withdraw',
    legs: steps.map((withdrawals, seq) => ({
      ...leg,
      id: [LEG_A, LEG_B, LEG_C][seq],
      seq,
      kind: 'withdraw',
      withdrawals,
    })),
    ...over,
  });
