import { randomUUID } from 'node:crypto';
import { type Attempt, DISCLAIMER, type Leg, type Order } from '@colosseum/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Person, person, testDb, testIssuer } from '../testing/harness';
import { Refusal } from './errors';
import { insertOrder, loadOrder, type Outcome, recordBuild, recordOutcome } from './store';

// The order store under two writers at once, on the real database. The review found a build and a
// report deadlocking, a report answered with nothing recorded, and a leg left `built` beside a
// confirmed attempt. Every writer now takes the leg row first, then its attempts.

let data: Awaited<ReturnType<typeof testDb>>;
let owner: Person;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  data = await testDb();
  undo.push(() => data.cleanUp());
  owner = data.track(await person(await testIssuer('store')));
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** A stored order with one planned leg on Robinhood Chain. */
async function oneLeg(): Promise<Leg> {
  const id = randomUUID();
  const leg: Leg = {
    id: randomUUID(),
    orderId: id,
    chain: 'robinhood',
    seq: 0,
    kind: 'deposit',
    signer: 'owner',
    description: 'test',
    trades: [],
    expected: [],
    status: 'planned',
    attempt: 0,
    txId: null,
    explorerUrl: null,
    validUntil: null,
    error: null,
    trigger: 'manual',
    provenance: 'mock',
  };
  const order: Order = {
    id,
    type: 'buy',
    owner: { evm: owner.evm },
    summary: 'test',
    legs: [leg],
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: 'app',
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    createdAt: new Date().toISOString(),
    disclaimer: DISCLAIMER.en,
  };
  await insertOrder(data.db, order, { type: 'buy', owner: order.owner, amountUsd: 10 });
  return leg;
}

const build = (leg: Leg) =>
  recordBuild(data.db, leg, {
    messageHash: `hash-${randomUUID()}`,
    validUntil: null,
    expected: [],
    stamp: {
      source: 'test',
      method: 'test',
      fetchedAt: new Date().toISOString(),
      provenance: 'mock',
    },
    builtAt: new Date(),
  });
const outcome = (
  status: Outcome['status'],
  txId: string | null = `0x${randomUUID()}`,
): Outcome => ({
  status,
  txId,
  explorerUrl: null,
  validUntil: null,
  error: null,
});
async function state(leg: Leg) {
  const stored = await loadOrder(data.db, leg.orderId ?? '');
  const now = stored?.order.legs[0];
  return {
    leg: [now?.status, now?.attempt, now?.txId],
    attempts: stored?.attempts.map((a) => [a.n, a.status]) ?? [],
  };
}
/** How a write ended: its value, or the status of the refusal it threw. Anything else is a fault. */
const ended = (result: PromiseSettledResult<unknown>) => {
  if (result.status === 'fulfilled') return result.value;
  if (result.reason instanceof Refusal) return result.reason.status;
  throw result.reason;
};

describe('the leg store under two writers', () => {
  /** An attempt closed without landing, as a cancel does: the leg can be built again. */
  async function cancelled() {
    const leg = await oneLeg();
    const one = await build(leg);
    await recordOutcome(data.db, one, outcome('expired', null));
    const closed: Leg = { ...leg, status: 'expired', attempt: 1 };
    return { leg, one, closed };
  }

  it('settles the leg on the attempt that landed, whichever of the build and the landing came first', async () => {
    // The landing first: the build finds the leg moved, and is refused.
    const a = await cancelled();
    const first = outcome('confirmed');
    expect(await recordOutcome(data.db, a.one, first)).toBe('recorded');
    expect(await build(a.closed).catch((e: unknown) => (e as Refusal).status)).toBe(409);
    expect(await state(a.leg)).toEqual({
      leg: ['confirmed', 1, first.txId],
      attempts: [[1, 'confirmed']],
    });

    // The build first: the landing still settles the leg, and closes the attempt just built.
    const b = await cancelled();
    expect((await build(b.closed)).n).toBe(2);
    const late = outcome('confirmed');
    expect(await recordOutcome(data.db, b.one, late)).toBe('recorded');
    expect(await state(b.leg)).toEqual({
      leg: ['confirmed', 1, late.txId],
      attempts: [
        [1, 'confirmed'],
        [2, 'expired'],
      ],
    });
  });

  it('a rebuild and a late landing at once: no deadlock, the landing recorded, one attempt confirmed', async () => {
    for (let i = 0; i < 40; i++) {
      const { leg, one, closed } = await cancelled();
      const landed = outcome('confirmed');
      const [rebuilt, recorded] = await Promise.allSettled([
        build(closed),
        recordOutcome(data.db, one, landed),
      ]);
      // A deadlock or any other fault throws here; a refused build is a 409.
      expect(ended(recorded)).toBe('recorded');
      const built = ended(rebuilt);
      const after = await state(leg);
      expect(after.leg).toEqual(['confirmed', 1, landed.txId]);
      expect(after.attempts).toEqual(
        built === 409
          ? [[1, 'confirmed']]
          : [
              [1, 'confirmed'],
              [2, 'expired'],
            ],
      );
    }
  }, 120_000);

  it('the same outcome from several callers is written once', async () => {
    for (let i = 0; i < 10; i++) {
      const leg = await oneLeg();
      const one = await build(leg);
      const landed = outcome('confirmed');
      const writes = await Promise.allSettled(
        [1, 2, 3, 4].map(() => recordOutcome(data.db, one, landed)),
      );
      expect(writes.map(ended).sort()).toEqual(['kept', 'kept', 'kept', 'recorded']);
      expect(await state(leg)).toEqual({
        leg: ['confirmed', 1, landed.txId],
        attempts: [[1, 'confirmed']],
      });
    }
  }, 120_000);

  it('never takes back what the chain has said, and logs a second landing without moving the leg', async () => {
    const leg = await oneLeg();
    const one = await build(leg);
    const first = outcome('confirmed');
    await recordOutcome(data.db, one, first);
    // A later, weaker word about the same attempt changes nothing.
    for (const status of ['sent', 'expired', 'failed'] as const)
      expect(await recordOutcome(data.db, one, outcome(status))).toBe('kept');
    expect((await state(leg)).leg).toEqual(['confirmed', 1, first.txId]);

    // Two attempts whose transactions both landed (a mock EVM chain has no nonce to stop the second).
    const other = await oneLeg();
    const a = await build(other);
    await recordOutcome(data.db, a, outcome('expired', null));
    const b = await build({ ...other, status: 'expired', attempt: 1 });
    const second = outcome('confirmed');
    await recordOutcome(data.db, b, second);
    await recordOutcome(data.db, a, outcome('confirmed'));
    expect(await state(other)).toEqual({
      leg: ['confirmed', 2, second.txId],
      attempts: [
        [1, 'confirmed'],
        [2, 'confirmed'],
      ],
    });
  });

  it('refuses a transaction id that another attempt already holds', async () => {
    const [x, y] = [await oneLeg(), await oneLeg()];
    const [ax, ay]: Attempt[] = [await build(x), await build(y)];
    const landed = outcome('confirmed');
    if (!ax || !ay) throw new Error('no attempt');
    await recordOutcome(data.db, ax, landed);
    const again = await recordOutcome(data.db, ay, landed).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(Refusal);
    expect((again as Refusal).status).toBe(409);
    expect((await state(y)).leg).toEqual(['built', 1, null]);
  });
});
