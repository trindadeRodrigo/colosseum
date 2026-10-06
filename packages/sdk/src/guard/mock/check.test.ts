import { createHash } from 'node:crypto';
import { mockAddress } from '@colosseum/chain-mock';
import {
  type BasketTx,
  type BuiltTx,
  type ChainId,
  type ConsentKind,
  evmCallPreimage,
} from '@colosseum/schemas';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eachBites, type Negative, refusalOf } from '../../../test/bites';
import {
  type MockWorld,
  mockWorld,
  recipeIdOf,
  recipeOf,
  stamped,
  tampered,
  tradesOfTx,
  usd,
} from '../../../test/mock';
import { SOLANA } from '../../../test/solana';
import { deploymentsOf } from '../deployment';
import { guardTransaction } from '../index';
import { familyTextHash } from '../meta';
import type { GuardCheck } from '../refusal';
import type { ApprovedStep, GuardInput } from '../types';
import { mockVaultAddress } from './check';

vi.mock('../rules', () => import('../../../test/rules'));
vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));

// The guard on what packages/chain-mock builds. The honest transactions are the mock's own, for every
// step it has, on both families; each negative is one of them with one field of its operation changed.

const BASKET = '42';
const FAMILY = 'ab'.repeat(32);
const OWN_FAMILY = 'cd'.repeat(32);
const OWN_TEXT = {
  slug: 'own',
  name: 'My portfolio',
  copy: 'Three test tokens.',
  kind: 'index' as const,
};
const TARGETS = (chain: ChainId) => [
  { asset: `${chain}:spy`, weightBps: 6000 },
  { asset: `${chain}:gold`, weightBps: 4000 },
];

type Case = { step: ApprovedStep; tx: BasketTx; consents: ConsentKind[] };
type World = MockWorld & { cases: Record<string, Case>; vault: string };

/** Every step the owner signs, built by the mock and landed in order, each kept with its step. */
async function build(chain: ChainId): Promise<World> {
  const w = mockWorld(chain);
  const { adapter, owner } = w;
  const base = { legId: 'leg-1', chain, owner, basketId: BASKET } as const;
  const vault = mockVaultAddress(chain, owner, BASKET);
  const cases: Record<string, Case> = {};
  const keep = async (
    name: string,
    step: ApprovedStep,
    tx: BuiltTx,
    consents: ConsentKind[] = [],
  ) => {
    cases[name] = { step, tx: stamped(tx), consents };
    await w.send(tx);
  };
  const spy = { sell: adapter.mock.cash, buy: `${chain}:spy`, amountInRaw: usd(300) };
  const riding = adapter.capabilities.tradesInCreate ? [spy] : [];

  if (adapter.capabilities.needsApprove) {
    const tx = await adapter.buildApprove({ owner, basketId: BASKET, amountRaw: usd(1000) });
    await keep('approve', { ...base, kind: 'approve', amountRaw: usd(1000) }, tx);
  }
  const create = await adapter.buildCreateVault({
    owner,
    basketId: BASKET,
    targets: TARGETS(chain),
    autoFollow: false,
    depositRaw: usd(1000),
    trades: riding,
    slippageBps: 100,
  });
  await keep(
    'create_vault',
    {
      ...base,
      kind: 'create_vault',
      targets: TARGETS(chain),
      follow: null,
      autoFollow: false,
      depositRaw: usd(1000),
      trades: tradesOfTx(create),
    },
    create,
  );
  const swap = await adapter.buildOwnerSwap({
    vault,
    trades: [{ ...spy, buy: `${chain}:gold`, amountInRaw: usd(100) }],
    slippageBps: 100,
  });
  await keep('swap', { ...base, kind: 'swap', trades: tradesOfTx(swap) }, swap);
  if (adapter.capabilities.needsApprove)
    await w.send(await adapter.buildApprove({ owner, basketId: BASKET, amountRaw: usd(500) }));
  const deposit = await adapter.buildDeposit({
    vault,
    amountRaw: usd(500),
    trades: riding,
    slippageBps: 100,
  });
  await keep(
    'deposit',
    { ...base, kind: 'deposit', amountRaw: usd(500), trades: tradesOfTx(deposit) },
    deposit,
  );
  const targets = [{ asset: `${chain}:nvda`, weightBps: 2500 }];
  await keep(
    'set_targets',
    { ...base, kind: 'set_targets', targets },
    await adapter.buildSetTargets({ vault, targets }),
  );

  // A shared portfolio, and a second version of it that adds an asset: the owner has to accept that one.
  await w.send(
    await adapter.buildPublishRecipe({
      creator: w.stranger,
      recipe: recipeOf(w, FAMILY, { spy: 5000, nvda: 3000, gold: 2000 }),
    }),
  );
  const recipe = recipeIdOf(w, FAMILY);
  const followed = await adapter.buildCreateVault({
    owner,
    basketId: '43',
    targets: [],
    recipeOnchainId: recipe,
    expectedVersion: 1,
    autoFollow: true,
    slippageBps: 100,
  });
  await keep(
    'follow',
    {
      ...base,
      basketId: '43',
      kind: 'create_vault',
      targets: [],
      follow: { recipeOnchainId: recipe, version: 1 },
      autoFollow: true,
      depositRaw: '0',
      trades: [],
    },
    followed,
    ['auto_follow_on'],
  );
  adapter.mock.advance(300);
  await w.send(
    await adapter.buildPublishRecipe({
      creator: w.stranger,
      recipe: recipeOf(w, FAMILY, { spy: 4000, nvda: 3000, gold: 2000, tsla: 1000 }),
    }),
  );
  adapter.mock.advance(301);
  const following = mockVaultAddress(chain, owner, '43');
  await keep(
    'accept_version',
    {
      ...base,
      basketId: '43',
      kind: 'accept_version',
      follow: { recipeOnchainId: recipe, version: 2 },
    },
    await adapter.buildAcceptVersion({
      vault: following,
      recipeOnchainId: recipe,
      expectedVersion: 2,
    }),
    ['new_asset'],
  );
  await keep(
    'auto_off',
    { ...base, basketId: '43', kind: 'set_auto_follow', on: false },
    await adapter.buildSetAutoFollow({ vault: following, on: false }),
  );
  await keep(
    'auto_on',
    { ...base, basketId: '43', kind: 'set_auto_follow', on: true },
    await adapter.buildSetAutoFollow({ vault: following, on: true }),
    ['auto_follow_on'],
  );
  // The owner's own shared portfolio: the text the form showed, and its hash in the bytes.
  if (chain === 'solana') {
    const mine = {
      ...recipeOf(w, OWN_FAMILY, { spy: 4000, nvda: 3000, gold: 3000 }),
      creator: owner,
    };
    mine.metaHash = familyTextHash({ familyId: OWN_FAMILY, ...OWN_TEXT });
    await keep(
      'publish',
      {
        ...base,
        basketId: '0',
        kind: 'publish',
        action: 'publish',
        familyId: OWN_FAMILY,
        components: [
          { asset: 'solana:spy', weightBps: 4000 },
          { asset: 'solana:nvda', weightBps: 3000 },
          { asset: 'solana:gold', weightBps: 3000 },
        ],
        text: OWN_TEXT,
        version: 1,
      },
      await adapter.buildPublishRecipe({ creator: owner, recipe: mine }),
      ['publish'],
    );
  }
  const [withdraw] = await adapter.buildWithdrawInKind({ vault, assets: [`${chain}:gold`] });
  if (!withdraw) throw new Error('the mock built no withdrawal');
  await keep(
    'withdraw',
    { ...base, kind: 'withdraw', withdrawals: [{ asset: `${chain}:gold`, amountRaw: null }] },
    withdraw,
  );
  return { ...w, cases, vault };
}

const worlds = {} as Record<'solana' | 'robinhood', World>;
beforeAll(async () => {
  worlds.solana = await build('solana');
  worlds.robinhood = await build('robinhood');
});

const input = (w: World, name: string, tx?: BasketTx, consents?: ConsentKind[]): GuardInput => {
  const c = w.cases[name];
  if (!c) throw new Error(`no case ${name}`);
  return {
    step: c.step,
    tx: tx ?? c.tx,
    deployment: w.deployment,
    consents: consents ?? c.consents,
  };
};

describe('the guard on the mock chain: what the mock builds passes', () => {
  it("the vault it derives is the mock's own", async () => {
    for (const w of Object.values(worlds)) {
      expect(w.vault).toBe(mockAddress(w.chain, `vault:${w.owner}:${BASKET}`));
      expect((await w.adapter.getVaults(w.owner)).map((v) => v.address)).toContain(w.vault);
    }
  });

  it("a creator's publish, held to the form's text and weights; a version taken back is not the mock's", () => {
    const w = worlds.solana;
    expect(refusalOf(() => guardTransaction(input(w, 'publish')))).toBeNull();
    const c = w.cases.publish as Case;
    const cancel = { ...c.step, action: 'cancel', components: [], text: null } as ApprovedStep;
    expect(
      refusalOf(() =>
        guardTransaction({
          step: cancel,
          tx: c.tx,
          deployment: w.deployment,
          consents: ['publish'],
        }),
      )?.code,
    ).toBe('unsupported');
    expect(refusalOf(() => guardTransaction(input(w, 'publish', undefined, [])))?.code).toBe(
      'consent',
    );
  });

  it('every step the owner signs, on Solana and on an EVM chain', () => {
    for (const w of Object.values(worlds)) {
      const names = Object.keys(w.cases);
      expect(names).toContain('create_vault');
      expect(names.includes('approve')).toBe(w.chain !== 'solana');
      for (const name of names)
        expect(
          refusalOf(() => guardTransaction(input(w, name)))?.message ?? null,
          `${w.chain} ${name}`,
        ).toBeNull();
    }
  });

  it('a withdrawal of everything, whatever the mock lists', () => {
    const w = worlds.solana;
    const c = w.cases.withdraw as Case;
    const step = { ...c.step, withdrawals: 'all' } as ApprovedStep;
    expect(refusalOf(() => guardTransaction({ ...input(w, 'withdraw'), step }))).toBeNull();
  });
});

describe('the guard on the mock chain: a mock transaction is never taken for a real one', () => {
  it('is refused by a deployment that is a real network, and a real one by the mock', () => {
    const w = worlds.solana;
    const real = { ...input(w, 'swap'), deployment: SOLANA };
    expect(refusalOf(() => guardTransaction(real))?.code).toBe('network');
    const labelled = { ...(w.cases.swap as Case).tx, provenance: 'sandbox' as const };
    expect(refusalOf(() => guardTransaction(input(w, 'swap', labelled)))?.code).toBe('network');
  });

  it("refuses the deployment of another chain, each chain's own file entry though it is", () => {
    for (const [chain, other] of [
      ['robinhood', 'base'],
      ['solana', 'robinhood'],
    ] as const) {
      const theirs = deploymentsOf('mock')[other];
      if (!theirs) throw new Error(`the mock's file has no ${other}`);
      const given = { ...input(worlds[chain], 'swap'), deployment: theirs };
      const refusal = refusalOf(() => guardTransaction(given));
      expect(refusal?.code, chain).toBe('unsupported');
      expect(refusal?.message).toBe(`no deployment was given for ${chain}`);
    }
  });

  it('refuses the call a mock deployment once passed: native value to a stranger on a real chain id', () => {
    const w = worlds.robinhood;
    const { tx } = w.cases.approve as Case;
    const hostile = recalled(
      tx,
      { value: '5000000000000000000', chainId: 4663, gas: 21_000 },
      w.stranger,
    );
    const refusal = refusalOf(() => guardTransaction(input(w, 'approve', hostile)));
    expect(['value', 'network', 'target']).toContain(refusal?.code);
    // And the mock's own target for each step is the one the guard works out.
    for (const name of Object.keys(w.cases))
      expect(refusalOf(() => guardTransaction(input(w, name)))?.message ?? null, name).toBeNull();
  });

  it('refuses bytes that are not an operation of the mock, and a field a step has no use for', () => {
    const w = worlds.solana;
    const { tx } = w.cases.swap as Case;
    const junk = { ...tx, payload: Buffer.from('not a transaction').toString('base64') };
    expect(refusalOf(() => guardTransaction(input(w, 'swap', junk)))?.code).toBe('malformed');
    const extra = tampered(tx, (m) => {
      m.op.a.recipient = w.stranger;
    });
    const refusal = refusalOf(() => guardTransaction(input(w, 'swap', extra)));
    expect(refusal?.code).toBe('malformed');
    expect(refusal?.message).toMatch(/recipient/);
  });
});

const lie = (
  chain: 'solana' | 'robinhood',
  name: string,
  check: GuardCheck,
  what: string,
  change: (message: Parameters<Parameters<typeof tampered>[1]>[0], w: World) => void,
): Negative => ({
  name: `${chain}: ${what}`,
  check,
  input: () => {
    const w = worlds[chain];
    return input(
      w,
      name,
      tampered((w.cases[name] as Case).tx, (m) => change(m, w)),
    );
  },
});

/** The recipe a mock publish carries, to change one of its fields. */
const recipeIn = (m: { op: { a: Record<string, unknown> } }) =>
  m.op.a.recipe as Record<string, unknown>;

const negatives: Negative[] = [
  lie('solana', 'publish', 'signer', "a publish in another creator's name", (m, w) => {
    m.op.a.creator = w.stranger;
  }),
  lie('solana', 'publish', 'recipe', 'another family than the form shows', (m) => {
    recipeIn(m).familyId = 'ef'.repeat(32);
  }),
  lie('solana', 'publish', 'recipe', 'the hash of other words than the form shows', (m) => {
    recipeIn(m).metaHash = familyTextHash({
      familyId: OWN_FAMILY,
      ...OWN_TEXT,
      copy: 'Other words.',
    });
  }),
  lie('solana', 'publish', 'recipe', "the portfolio of another creator's account", (m) => {
    recipeIn(m).onchainId = 'somewhere';
  }),
  lie('solana', 'publish', 'targets', 'other weights than the form shows', (m) => {
    recipeIn(m).components = [
      { kind: 'asset', asset: 'solana:spy', weightBps: 3000 },
      { kind: 'asset', asset: 'solana:nvda', weightBps: 4000 },
      { kind: 'asset', asset: 'solana:gold', weightBps: 3000 },
    ];
  }),
  lie('solana', 'publish', 'limits', 'a fee cap in the bytes', (m) => {
    recipeIn(m).maxFeeBps = 50;
  }),
  lie('robinhood', 'approve', 'spender', 'an approval of the factory', (m, w) => {
    m.op.a.spender = w.adapter.mock.addresses.factory;
  }),
  lie('robinhood', 'approve', 'spender', 'an approval of a stranger', (m, w) => {
    m.op.a.spender = w.stranger;
  }),
  lie('robinhood', 'approve', 'amount', 'a larger approval', (m) => {
    m.op.a.amountRaw = usd(1001);
  }),
  lie('robinhood', 'approve', 'owner', 'an approval in the name of another owner', (m, w) => {
    m.op.a.owner = w.stranger;
  }),
  lie('robinhood', 'approve', 'vault', 'an approval for another plan', (m) => {
    m.op.a.basketId = '7';
  }),
  lie(
    'robinhood',
    'approve',
    'target',
    'a call sent somewhere else than the transaction says',
    (m, w) => {
      m.to = w.stranger;
    },
  ),
  lie('solana', 'create_vault', 'amount', 'a larger deposit inside the create', (m) => {
    m.op.a.depositRaw = usd(2000);
  }),
  lie('solana', 'create_vault', 'targets', 'other weights than the plan', (m) => {
    m.op.a.targets = [{ asset: 'solana:tsla', weightBps: 10_000 }];
  }),
  lie('solana', 'create_vault', 'auto_follow', 'auto-follow switched on in the bytes', (m) => {
    m.op.a.autoFollow = true;
  }),
  lie('solana', 'create_vault', 'version', 'a shared portfolio the plan does not follow', (m) => {
    m.op.a.recipeOnchainId = 'somewhere';
    m.op.a.expectedVersion = 1;
  }),
  lie('solana', 'create_vault', 'owner', 'a vault opened for another owner', (m, w) => {
    m.op.a.owner = w.stranger;
  }),
  lie('solana', 'create_vault', 'vault', 'a vault opened for another plan', (m) => {
    m.op.a.basketId = '7';
  }),
  lie('solana', 'deposit', 'vault', "a deposit into another person's vault", (m, w) => {
    m.op.a.vault = mockVaultAddress('solana', w.stranger, BASKET);
  }),
  lie('solana', 'deposit', 'amount', 'a larger deposit', (m) => {
    m.op.a.amountRaw = usd(501);
  }),
  lie('solana', 'swap', 'minimum', 'a lower minimum', (m) => {
    m.mins = ['1'];
  }),
  lie('solana', 'swap', 'amount', 'a trade that sells more', (m) => {
    (m.op.a.trades as [{ amountInRaw: string }])[0].amountInRaw = usd(101);
  }),
  lie('solana', 'swap', 'asset', 'a trade that buys another token', (m) => {
    (m.op.a.trades as [{ buy: string }])[0].buy = 'solana:tsla';
  }),
  lie('solana', 'swap', 'calls', 'a second trade', (m) => {
    const trades = m.op.a.trades as object[];
    trades.push(trades[0] as object);
    m.mins.push(m.mins[0] as string);
  }),
  lie(
    'robinhood',
    'create_vault',
    'minimum',
    'a lower minimum on the trade inside the create',
    (m) => {
      m.mins = ['0'];
    },
  ),
  lie('solana', 'swap', 'step', 'another operation than the step', (m, w) => {
    m.op = { kind: 'withdraw', a: { vault: w.vault, assets: ['solana:spy'] } };
  }),
  lie('solana', 'swap', 'signer', 'an operation signed by someone else', (m, w) => {
    m.signer = w.stranger;
  }),
  lie('solana', 'swap', 'chain', 'an operation of another chain', (m) => {
    m.chain = 'base';
  }),
  lie('solana', 'set_targets', 'targets', 'a target more than the step sets', (m) => {
    (m.op.a.targets as object[]).push({ asset: 'solana:tsla', weightBps: 100 });
  }),
  lie('solana', 'accept_version', 'version', 'an accept of another version', (m) => {
    m.op.a.expectedVersion = 3;
  }),
  lie(
    'solana',
    'auto_off',
    'auto_follow',
    'the switch turned on where the step turns it off',
    (m) => {
      m.op.a.on = true;
    },
  ),
  lie('solana', 'withdraw', 'asset', 'a withdrawal of another token than the step names', (m) => {
    m.op.a.assets = ['solana:spy'];
  }),
  lie('solana', 'withdraw', 'vault', "a withdrawal from another person's vault", (m, w) => {
    m.op.a.vault = mockVaultAddress('solana', w.stranger, BASKET);
  }),
  {
    name: 'solana: the switch turned on with no consent handed over',
    check: 'consent',
    input: () => input(worlds.solana, 'auto_on', undefined, []),
  },
  {
    name: 'solana: a create with auto-follow on and no consent handed over',
    check: 'consent',
    input: () => input(worlds.solana, 'follow', undefined, ['new_asset']),
  },
  {
    name: 'solana: a version accepted with no consent handed over',
    check: 'consent',
    input: () => input(worlds.solana, 'accept_version', undefined, []),
  },
  {
    name: 'robinhood: an approval of everything, as the order itself asks',
    check: 'unlimited',
    input: () => {
      const w = worlds.robinhood;
      const all = ((1n << 256n) - 1n).toString();
      const c = w.cases.approve as Case;
      const tx = tampered(c.tx, (m) => {
        m.op.a.amountRaw = all;
      });
      return { ...input(w, 'approve', tx), step: { ...c.step, amountRaw: all } as ApprovedStep };
    },
  },
  {
    name: 'solana: a message hash that is not the hash of the bytes',
    check: 'hash',
    input: () => {
      const w = worlds.solana;
      return input(w, 'swap', { ...(w.cases.swap as Case).tx, messageHash: 'cd'.repeat(32) });
    },
  },
  {
    name: 'robinhood: a message hash that is not the hash of the call',
    check: 'hash',
    input: () => {
      const w = worlds.robinhood;
      return input(w, 'swap', { ...(w.cases.swap as Case).tx, messageHash: 'cd'.repeat(32) });
    },
  },
];

/** A mock call with other fields around the same operation, and the hash of the call as it then is. */
const recalled = (
  tx: BasketTx,
  evm: Partial<NonNullable<BasketTx['evm']>>,
  to?: string,
): BasketTx => {
  const moved = to
    ? tampered(tx, (m) => {
        m.to = to;
      })
    : tx;
  const call = { ...(moved.evm as NonNullable<BasketTx['evm']>), ...evm, ...(to ? { to } : {}) };
  const messageHash = createHash('sha256')
    .update(evmCallPreimage({ ...call, signer: moved.signer, data: moved.payload }))
    .digest('hex');
  return { ...moved, evm: call, messageHash };
};
const onEvm = (
  name: string,
  check: GuardCheck,
  what: string,
  change: (tx: BasketTx, w: World) => BasketTx,
): Negative => ({
  name: `robinhood: ${what}`,
  check,
  input: () => {
    const w = worlds.robinhood;
    return input(w, name, change((w.cases[name] as Case).tx, w));
  },
});
negatives.push(
  // What passes as a mock step must not be a transaction of a real chain: a mock deployment for an
  // EVM chain once passed a call that sent native value to a stranger on a real chain id.
  onEvm('approve', 'value', 'a mock call that sends native value', (tx) =>
    recalled(tx, { value: '5000000000000000000' }),
  ),
  onEvm('approve', 'network', 'a mock call for a real chain id', (tx) =>
    recalled(tx, { chainId: 4663 }),
  ),
  onEvm('approve', 'target', 'a mock approval sent to a stranger', (tx, w) =>
    recalled(tx, {}, w.stranger),
  ),
  onEvm(
    'approve',
    'target',
    'a mock call sent to a stranger, while the operation names the token',
    (tx, w) => recalled(tx, { to: w.stranger }),
  ),
  onEvm('deposit', 'target', "a mock deposit sent to another person's vault", (tx, w) =>
    recalled(tx, {}, mockVaultAddress('robinhood', w.stranger, BASKET)),
  ),
  onEvm('create_vault', 'target', 'a mock create sent to the factory', (tx, w) =>
    recalled(tx, {}, w.adapter.mock.addresses.factory),
  ),
);

describe('the guard on the mock chain: each negative is refused, and by the check that names it', () => {
  eachBites(negatives);
});
