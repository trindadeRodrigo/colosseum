import type { BasketTx, ChainId, Leg, OrderDetail } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import * as e from '../../test/evm';
import vectors from '../../test/fixtures/evm-vectors.json';
import * as s from '../../test/solana';
import { base64Decode, base64Encode, concatBytes, hexDecode, hexEncode } from '../bytes';
import { BASKET_PROGRAM } from '../guard/generated/basket-program';
import type { ApprovedStep, GuardDeployment } from '../guard/types';
import type { OrderApi } from './api';
import type { ExecutorDeps, SignedRecord } from './execute';
import { execute } from './index';
import { signedEvm } from './signed';

// The executor on the bytes of a real chain: a one-step order whose transaction is a Solana message or
// an EVM call, as the guard's own tests build them. The other executor tests run on the mock chain,
// whose transactions the executor does not read once the guard has passed them. These hold it to what
// a wallet hands back: the transaction the guard passed, signed, or nothing is reported.

/** A one-step order, an API that builds the one transaction it is given, and a wallet that answers `hand`. */
function scene(
  chain: ChainId,
  owner: string,
  leg: Partial<Leg>,
  tx: BasketTx,
  hand: () => string,
  after: Partial<Leg>[] = [],
) {
  const base = {
    id: 'leg-1',
    orderId: 'order-1',
    chain,
    seq: 0,
    signer: 'owner',
    description: 'a test step',
    cashRaw: '1000',
    trades: [],
    expected: [],
    status: 'planned',
    attempt: 0,
    txId: null,
    explorerUrl: null,
    validUntil: null,
    error: null,
  };
  const order = {
    id: 'order-1',
    type: 'buy',
    owner: chain === 'solana' ? { solana: owner } : { evm: owner },
    summary: 'a test order',
    status: 'open',
    depositRaw: '1000',
    legs: [{ ...base, ...leg }, ...after.map((more) => ({ ...base, ...more }))],
    attempts: [],
  } as unknown as OrderDetail;
  let now = order;
  const reported: unknown[] = [];
  const calls: string[] = [];
  const set = (status: Leg['status']) => {
    now = structuredClone(now);
    (now.legs[0] as Leg).status = status;
    return now;
  };
  const api: OrderApi = {
    createOrder: async () => now,
    getOrder: async () => now,
    async buildLeg() {
      calls.push('build');
      set('built');
      const attempt = {
        id: tx.attemptId,
        legId: 'leg-1',
        n: 1,
        messageHash: tx.messageHash,
        nonce: tx.evm?.nonce ?? null,
        status: 'built' as const,
        txId: null,
        explorerUrl: null,
        validUntil: null,
        builtAt: new Date(0).toISOString(),
      };
      return { tx, attempt };
    },
    async reportLeg(_order, _leg, body) {
      calls.push('report');
      reported.push(body);
      return set('confirmed');
    },
    async cancelLeg() {
      calls.push('cancel');
      return set('expired');
    },
  };
  const asked: BasketTx[] = [];
  const deps = (deployment: GuardDeployment): ExecutorDeps => ({
    api,
    signer: {
      active: () => ({ address: owner }),
      caps: () => ({ signOnly: true }),
      sign: async (_chain, txs) => {
        asked.push(...txs);
        return [hand()];
      },
      send: async () => {
        throw new Error('signs only');
      },
    },
    deployments: { [chain]: deployment },
    plan: { basketId: chain === 'solana' ? s.BASKET_ID : e.BASKET_ID },
    signed: new Map<string, SignedRecord>(),
    sleep: async () => {},
  });
  return { order, deps, reported, calls, asked };
}

const depositStep: ApprovedStep = {
  legId: 'leg-1',
  chain: 'solana',
  owner: s.OWNER,
  basketId: s.BASKET_ID,
  kind: 'deposit',
  amountRaw: '1000',
  trades: [],
};
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 11 + 5) % 256);
const signedBy = (payload: string) => {
  const bytes = base64Decode(payload);
  bytes.set(SIGNATURE, 1);
  return base64Encode(bytes);
};

describe('the executor on Solana bytes', () => {
  const run = async (hand: (payload: string, other: string) => string) => {
    const bytes = s.wire([await s.depositIx(BASKET_PROGRAM, '1000')]);
    const other = s.wire([await s.depositIx(BASKET_PROGRAM, '1001')]);
    const tx = s.solanaTx(depositStep, bytes);
    const sc = scene('solana', s.OWNER, { kind: 'deposit' }, tx, () =>
      hand(bytes.payload, other.payload),
    );
    return { ...sc, bytes, result: await execute(sc.order, sc.deps(s.SOLANA)) };
  };

  it('reports the transaction the guard passed, signed', async () => {
    const { result, reported, bytes, asked } = await run((payload) => signedBy(payload));
    expect(result.status).toBe('done');
    expect(reported).toEqual([{ signedTx: signedBy(bytes.payload) }]);
    expect(asked.map((tx) => tx.payload)).toEqual([bytes.payload]);
  });

  it('reports nothing when the wallet hands back another message, the same one unsigned, or no transaction', async () => {
    const hands: [string, (payload: string, other: string) => string][] = [
      ['another message, signed', (_payload, other) => signedBy(other)],
      ['the message it was given, not signed', (payload) => payload],
      ['something that is no transaction', () => 'AAAA'],
    ];
    for (const [name, hand] of hands) {
      const { result, reported, calls, deps, order } = await run(hand);
      expect(result, name).toMatchObject({ status: 'cancelled', wallet: { code: 'changed' } });
      expect(reported, name).toEqual([]);
      expect(calls, name).toEqual(['build', 'cancel']);
      // Nothing is remembered as signed: what came back was dropped.
      expect(await deps(s.SOLANA).signed.get(`${order.id}:leg-1`), name).toBeUndefined();
    }
  });
});

// A type 2 transaction around a call, as a wallet makes one: RLP by hand, for the test only. What it
// writes is read back by `signedEvm`, which signed.test.ts holds to viem.
const rlpBytes = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length === 1 && (bytes[0] as number) < 0x80) return bytes;
  if (bytes.length <= 55) return concatBytes(Uint8Array.of(0x80 + bytes.length), bytes);
  const length = hexDecode(`0x${bytes.length.toString(16).padStart(4, '0').replace(/^00/, '')}`);
  return concatBytes(Uint8Array.of(0xb7 + length.length), length, bytes);
};
const rlpList = (items: Uint8Array[]): Uint8Array => {
  const body = concatBytes(...items);
  if (body.length <= 55) return concatBytes(Uint8Array.of(0xc0 + body.length), body);
  const length = hexDecode(`0x${body.length.toString(16).padStart(4, '0').replace(/^00/, '')}`);
  return concatBytes(Uint8Array.of(0xf7 + length.length), length, body);
};
const number = (n: bigint) => {
  const hex = n.toString(16);
  return rlpBytes(n === 0n ? new Uint8Array() : hexDecode(`0x${hex.length % 2 ? '0' : ''}${hex}`));
};
type Call = { chainId: bigint; to: string; value: bigint; data: string; accessList?: Uint8Array[] };
const typeTwo = (c: Call) =>
  `0x${hexEncode(
    concatBytes(
      Uint8Array.of(2),
      rlpList([
        number(c.chainId),
        number(7n),
        number(1_000_000n),
        number(2_000_000_000n),
        number(310_000n),
        rlpBytes(hexDecode(c.to)),
        number(c.value),
        rlpBytes(hexDecode(c.data)),
        rlpList(c.accessList ?? []),
        number(1n),
        rlpBytes(SIGNATURE.slice(0, 32)),
        rlpBytes(SIGNATURE.slice(32)),
      ]),
    ),
  )}`;

describe('the executor on an EVM call', () => {
  const approveStep: ApprovedStep = {
    legId: 'leg-1',
    chain: 'robinhood',
    owner: e.OWNER,
    basketId: e.BASKET_ID,
    kind: 'approve',
    amountRaw: '1000',
  };
  const token = e.tokenOf('robinhood:usdc');
  const data = e.calls.approve(e.VAULT, 1000n);
  const honest: Call = {
    chainId: BigInt(e.CHAIN_ID),
    to: token,
    value: 0n,
    data: `0x${hexEncode(data)}`,
  };
  const run = async (signedTx: string) => {
    const tx = e.evmTx(approveStep, { to: token, data });
    // The order is an approval and the deposit it serves. The deposit is already done: only the
    // approval is run here.
    const sc = scene('robinhood', e.OWNER, { kind: 'approve' }, tx, () => signedTx, [
      { id: 'leg-2', seq: 1, kind: 'deposit', status: 'confirmed' },
    ]);
    return { ...sc, result: await execute(sc.order, sc.deps(e.EVM)) };
  };

  it('the hand-made transaction reads back as it was written', () => {
    const read = signedEvm(typeTwo(honest));
    expect(read).toMatchObject({
      type: 2,
      chainId: honest.chainId,
      nonce: 7,
      to: token,
      value: 0n,
    });
    expect(`0x${hexEncode(read.data)}`).toBe(honest.data);
  });

  it('reports the call the guard passed, in the transaction the wallet made around it', async () => {
    const { result, reported } = await run(typeTwo(honest));
    expect(result.status).toBe('done');
    expect(reported).toEqual([{ signedTx: typeTwo(honest) }]);
  });

  it('reports nothing when the transaction is for another chain, target, value or data, or carries more than the call', async () => {
    const hands: [string, string][] = [
      ['another chain', typeTwo({ ...honest, chainId: 4663n })],
      ['another target', typeTwo({ ...honest, to: e.STRANGER })],
      ['native value', typeTwo({ ...honest, value: 1n })],
      [
        'an approval of a stranger',
        typeTwo({ ...honest, data: `0x${hexEncode(e.calls.approve(e.STRANGER, 1000n))}` }),
      ],
      [
        'an access list',
        typeTwo({
          ...honest,
          accessList: [rlpList([rlpBytes(hexDecode(e.STRANGER)), rlpList([])])],
        }),
      ],
      ['an authorization list', vectors.delegating],
      ['no transaction', '0x'],
    ];
    for (const [name, signedTx] of hands) {
      const { result, reported, calls } = await run(signedTx);
      expect(result, name).toMatchObject({ status: 'cancelled', wallet: { code: 'changed' } });
      expect(reported, name).toEqual([]);
      expect(calls, name).toEqual(['build', 'cancel']);
    }
  });
});
