import { Order } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { apiDouble } from '../../test/api-double';
import { refusalOf } from '../../test/bites';
import { mockWorld } from '../../test/mock';
import { approvedSteps } from './approved';
import type { PlanTerms } from './types';

// The order the review screen showed, as what each of its steps may sign.

async function bought(chain: 'solana' | 'robinhood') {
  const w = mockWorld(chain);
  const double = apiDouble(w);
  const order = await double.buy(1000);
  return { w, double, order };
}

describe('the approved steps of an order', () => {
  it('a buy on an EVM chain: the approval and the create are both about the deposit, said once each', async () => {
    const { w, double, order } = await bought('robinhood');
    // What the double answers is an order the shared type takes.
    expect(Order.safeParse(order).success).toBe(true);
    const steps = approvedSteps(order, double.plan, w.deployment);
    expect(steps.map((s) => s.kind)).toEqual(['approve', 'create_vault']);
    const [approve, create] = steps;
    expect(approve).toMatchObject({ amountRaw: '1000000000', owner: w.owner, basketId: '9001' });
    expect(create).toMatchObject({
      depositRaw: '1000000000',
      targets: double.plan.targets,
      follow: null,
      autoFollow: false,
    });
    // The trades spend what the plan invests, 95%, and each carries the minimum the order showed.
    if (create?.kind !== 'create_vault') throw new Error('a create');
    expect(create.trades.reduce((n, t) => n + BigInt(t.inRaw), 0n)).toBe(950_000_000n);
    expect(create.trades.map((t) => t.minOutRaw)).toEqual(
      order.legs[1]?.expected.map((e) => e.minOutRaw),
    );
  });

  it('a buy on Solana: the create carries the cash, and each trade is a step of its own', async () => {
    const { w, double, order } = await bought('solana');
    const steps = approvedSteps(order, double.plan, w.deployment);
    expect(steps.map((s) => [s.kind, s.legId])).toEqual(order.legs.map((l) => [l.kind, l.id]));
    expect(steps[0]).toMatchObject({ kind: 'create_vault', depositRaw: '1000000000', trades: [] });
    expect(steps[1]).toMatchObject({
      kind: 'swap',
      trades: [{ buy: 'solana:spy', inRaw: '500000000' }],
    });
  });

  it('takes the steps in the order they are signed, whatever order they come in', async () => {
    const { w, double, order } = await bought('solana');
    const shuffled = { ...order, legs: [...order.legs].reverse() };
    expect(approvedSteps(shuffled, double.plan, w.deployment).map((s) => s.legId)).toEqual(
      order.legs.map((l) => l.id),
    );
  });

  it('a plan that is all cash opens a vault with no targets, when the plan says so', async () => {
    const { w, double, order } = await bought('solana');
    const create = { ...order, legs: order.legs.slice(0, 1) };
    const allCash: PlanTerms = { basketId: '1', targets: [] };
    expect(approvedSteps(create, allCash, w.deployment)[0]).toMatchObject({
      targets: [],
      follow: null,
    });
    // Nothing said about targets is not the same as none.
    expect(refusalOf(() => approvedSteps(create, { basketId: '1' }, w.deployment))?.code).toBe(
      'order',
    );
    const follows: PlanTerms = {
      basketId: '1',
      follow: { recipeOnchainId: 'r', version: 2 },
      autoFollow: true,
    };
    expect(approvedSteps(create, follows, w.deployment)[0]).toMatchObject({
      targets: [],
      follow: follows.follow,
      autoFollow: true,
    });
    expect(double.plan.targets?.length).toBe(3);
  });

  it('refuses an order that cannot mean what it says', async () => {
    const { w, double, order } = await bought('robinhood');
    const [approve, create] = order.legs;
    if (!approve || !create) throw new Error('two steps');
    const cases: [string, object, string][] = [
      ['no steps', { legs: [] }, 'order'],
      ['an owner with no address on the chain', { owner: { solana: w.owner } }, 'order'],
      ['a step on another chain', { legs: [approve, { ...create, chain: 'base' }] }, 'order'],
      ['a step of another order', { legs: [approve, { ...create, orderId: 'x' }] }, 'order'],
      ['two steps in one place', { legs: [approve, { ...create, seq: 0 }] }, 'order'],
      ['two steps with one id', { legs: [approve, { ...create, id: approve.id }] }, 'order'],
      [
        'an approval that states no cash',
        { legs: [{ ...approve, cashRaw: undefined }, create] },
        'order',
      ],
      [
        'an approval of nothing',
        {
          depositRaw: '0',
          legs: [
            { ...approve, cashRaw: '0' },
            { ...create, cashRaw: '0' },
          ],
        },
        'order',
      ],
      [
        'a step about more cash than the order deposits',
        { legs: [approve, { ...create, cashRaw: '1000000001' }] },
        'order',
      ],
      ['a trade with no minimum shown', { legs: [approve, { ...create, expected: [] }] }, 'order'],
      [
        'a step the keeper signs',
        { legs: [approve, { ...create, signer: 'keeper' }] },
        'unsupported',
      ],
      ['a keeper step', { legs: [approve, { ...create, kind: 'keeper_leg' }] }, 'unsupported'],
      // Signed since AGT-4, once the screen says what is published: with nothing said, refused.
      [
        'a publish step with no terms',
        { legs: [approve, { ...create, kind: 'publish' }] },
        'order',
      ],
    ];
    for (const [name, change, code] of cases)
      expect(
        refusalOf(() => approvedSteps({ ...order, ...change } as never, double.plan, w.deployment))
          ?.code,
        name,
      ).toBe(code);
  });

  it('an order moves the cash it states, once, and an approval only serves that step', async () => {
    const { w, double, order } = await bought('robinhood');
    const [approve, create] = order.legs;
    if (!approve || !create) throw new Error('two steps');
    const deposit = { ...create, kind: 'deposit' as const };
    const refused = (change: object) =>
      refusalOf(() => approvedSteps({ ...order, ...change } as never, double.plan, w.deployment));
    const cases: [string, object][] = [
      // An order that states no deposit moves no cash, whatever its steps say of themselves.
      [
        'no deposit stated, an approval and a deposit at their own figures',
        {
          depositRaw: undefined,
          legs: [
            { ...approve, cashRaw: '999000000' },
            { ...deposit, cashRaw: '5' },
          ],
        },
      ],
      ['no deposit stated, a create that carries cash', { depositRaw: undefined, legs: [create] }],
      [
        'no deposit stated, a deposit',
        { depositRaw: undefined, legs: [{ ...deposit, cashRaw: undefined, seq: 0 }] },
      ],
      [
        'no deposit stated, an approval with no figure',
        { depositRaw: undefined, legs: [{ ...approve, cashRaw: undefined }] },
      ],
      [
        'no deposit stated, cash on a step that moves none',
        { depositRaw: undefined, legs: [{ ...create, kind: 'swap', cashRaw: '7' }] },
      ],
      // An approval is for the step that deposits, and for nothing else.
      ['an approval and no step that deposits', { legs: [approve] }],
      [
        'an approval of nearly everything and no step that deposits',
        {
          depositRaw: ((1n << 255n) - 1n).toString(),
          legs: [{ ...approve, cashRaw: ((1n << 255n) - 1n).toString() }],
        },
      ],
      [
        'an approval after the step it is for',
        {
          legs: [
            { ...create, seq: 0 },
            { ...approve, seq: 1 },
          ],
        },
      ],
      [
        'two approvals',
        { legs: [approve, { ...approve, id: 'another', seq: 5 }, { ...create, seq: 6 }] },
      ],
      [
        'two steps that move the cash',
        { legs: [approve, create, { ...deposit, id: 'another', seq: 2 }] },
      ],
      [
        'a deposit stated and no step that moves it',
        { legs: [{ ...create, kind: 'swap', cashRaw: undefined }] },
      ],
      [
        'a create that carries no cash where the order deposits',
        { legs: [approve, { ...create, cashRaw: undefined }] },
      ],
      [
        'cash on a trade step beside the deposit',
        { legs: [approve, create, { ...create, id: 'another', kind: 'swap', seq: 2 }] },
      ],
    ];
    for (const [name, change] of cases) expect(refused(change)?.code, name).toBe('order');
    // What stands: the order as the API made it, and a create that deposits nothing where none is stated.
    expect(refused({})).toBeNull();
    expect(
      refused({ depositRaw: undefined, legs: [{ ...create, cashRaw: undefined, seq: 0 }] }),
    ).toBeNull();
    expect(
      refused({ depositRaw: undefined, legs: [{ ...create, cashRaw: '0', seq: 0 }] }),
    ).toBeNull();
  });

  it('the other steps take their terms from the plan, and refuse to guess them', async () => {
    const { w, order } = await bought('solana');
    const leg = order.legs[1];
    if (!leg) throw new Error('a step');
    const one = (kind: string) => ({
      ...order,
      depositRaw: undefined,
      legs: [{ ...leg, kind, seq: 0, trades: [], expected: [] }],
    });
    const plan: PlanTerms = {
      basketId: '5',
      targets: [{ asset: 'solana:spy', weightBps: 100 }],
      follow: { recipeOnchainId: 'r', version: 2 },
      autoFollow: true,
      withdrawals: [{ asset: 'solana:spy', amountRaw: null }],
    };
    const stepOf = (kind: string, terms: PlanTerms) =>
      approvedSteps(one(kind) as never, terms, w.deployment)[0];
    expect(stepOf('set_targets', plan)).toMatchObject({ targets: plan.targets });
    expect(stepOf('accept_version', plan)).toMatchObject({ follow: plan.follow });
    expect(stepOf('set_auto_follow', plan)).toMatchObject({ on: true });
    expect(stepOf('withdraw', plan)).toMatchObject({ withdrawals: plan.withdrawals });
    expect(stepOf('withdraw', { basketId: '5' })).toMatchObject({ withdrawals: 'all' });
    for (const kind of ['set_targets', 'accept_version', 'set_auto_follow'])
      expect(refusalOf(() => stepOf(kind, { basketId: '5' }))?.code, kind).toBe('order');
  });
});

// Add money: a buy that names a vault of the person's. Its order is a deposit and its swaps, and the
// terms are the vault's number, from the person's own read of their vaults, with no plan beside it.
describe('the approved steps of an order that adds to a vault', () => {
  async function adding(chain: 'solana' | 'robinhood') {
    const { w, order } = await bought(chain);
    const legs = order.legs.map((l) => (l.kind === 'create_vault' ? { ...l, kind: 'deposit' } : l));
    const terms: PlanTerms = { basketId: '424242' };
    return { w, order: { ...order, legs } as typeof order, terms };
  }

  it.each(['solana', 'robinhood'] as const)(
    'on %s holds every step to the vault named and the deposit to the amount reviewed',
    async (chain) => {
      const { w, order, terms } = await adding(chain);
      const steps = approvedSteps(order, terms, w.deployment);
      expect(steps.map((s) => s.kind)).not.toContain('create_vault');
      for (const s of steps) expect(s).toMatchObject({ basketId: '424242', owner: w.owner });
      const deposit = steps.find((s) => s.kind === 'deposit');
      expect(deposit).toMatchObject({ amountRaw: order.depositRaw });
    },
  );

  it('refuses an order whose deposit is not the amount it states: a figure changed after the review', async () => {
    const { w, order, terms } = await adding('solana');
    const changed = (cashRaw: string) => ({
      ...order,
      legs: order.legs.map((l) => (l.kind === 'deposit' ? { ...l, cashRaw } : l)),
    });
    for (const cashRaw of ['1000000001', '999999999', '0'])
      expect(
        refusalOf(() => approvedSteps(changed(cashRaw) as never, terms, w.deployment))?.code,
        cashRaw,
      ).toBe('order');
    // and one that states another deposit than its step moves
    expect(
      refusalOf(() =>
        approvedSteps({ ...order, depositRaw: '5000000000' } as never, terms, w.deployment),
      )?.code,
    ).toBe('order');
  });

  it('refuses one that deposits twice', async () => {
    const { w, order, terms } = await adding('solana');
    const [deposit] = order.legs.filter((l) => l.kind === 'deposit');
    if (!deposit) throw new Error('a deposit');
    const twice = { ...order, legs: [...order.legs, { ...deposit, id: 'again', seq: 99 }] };
    expect(refusalOf(() => approvedSteps(twice as never, terms, w.deployment))?.code).toBe('order');
  });
});
