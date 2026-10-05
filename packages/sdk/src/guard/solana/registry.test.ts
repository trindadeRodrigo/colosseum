import { createHash } from 'node:crypto';
import { BasketTx, type ConsentKind } from '@colosseum/schemas';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { eachBites, type Negative, refusalOf } from '../../../test/bites';
import * as e from '../../../test/evm';
import { withRules } from '../../../test/rules';
import {
  ASSETS,
  CONFIG,
  type Ix,
  join,
  OWNER,
  ownerSwapIx,
  raw,
  SOLANA,
  STRANGER,
  SYSTEM,
  solanaTx,
  someone,
  targetsArg,
  u16,
  unitLimitIx,
  unitPriceIx,
  vaultIx,
  type Wire,
  wire,
} from '../../../test/solana';
import { approvedSteps } from '../approved';
import { deploymentsOf } from '../deployment';
import { BASKET_PROGRAM } from '../generated/basket-program';
import { guardTransaction } from '../index';
import { runGuard } from '../run';
import type { ApprovedStep, GuardInput, Publication } from '../types';
import { recipeAddress } from './addresses';
import type { ProgramTable } from './table';

vi.mock('../rules', () => import('../../../test/rules'));
vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));

// The registry calls a creator signs for a shared portfolio of their own (gate SHARED-FULL, AGT-4):
// publish the first version, update to the next, take back the version that waits. The portfolio is the
// registry's account for the creator and the family, derived here by @solana/kit; the bytes may name
// nothing else. Each negative is refused by the one check that names it (test/bites.ts).

const hex = (label: string) => createHash('sha256').update(label).digest('hex');
const FAMILY = hex('sdk test: family');
const META = hex('sdk test: family text');
const COMPONENTS = [
  { asset: 'solana:spy', weightBps: 6000 },
  { asset: 'solana:gold', weightBps: 4000 },
];
const recipeOf = async (creator: string, family = FAMILY) =>
  (
    await getProgramDerivedAddress({
      programAddress: address(BASKET_PROGRAM.address),
      seeds: ['recipe', raw(creator), Buffer.from(family, 'hex')],
    })
  )[0] as string;
const RECIPE = await recipeOf(OWNER);

const base = { legId: 'leg-1', chain: 'solana', owner: OWNER, basketId: '0' } as const;
const terms = (action: Publication['action']): Publication =>
  action === 'cancel'
    ? { action, familyId: FAMILY, components: [], metaHash: null, version: 2 }
    : {
        action,
        familyId: FAMILY,
        components: COMPONENTS,
        metaHash: META,
        version: action === 'publish' ? 1 : 2,
      };
const stepOf = (action: Publication['action']): ApprovedStep => ({
  ...base,
  kind: 'publish',
  ...terms(action),
});
const publishStep = stepOf('publish');
const updateStep = stepOf('update');
const cancelStep = stepOf('cancel');

type Over = {
  accounts?: Record<string, string>;
  family?: string;
  components?: { asset: string; weightBps: number }[];
  meta?: string;
  fee?: number;
  flags?: number;
  extra?: { address: string }[];
  flagsOf?: Record<string, { signer: boolean; writable: boolean }>;
};
const BUDGET = [unitLimitIx(200_000), unitPriceIx(10_000n)];
const publishIx = (o: Over = {}) =>
  vaultIx(
    BASKET_PROGRAM,
    'publish_recipe',
    {
      creator: OWNER,
      recipe: RECIPE,
      config: CONFIG,
      assets: ASSETS,
      system_program: SYSTEM,
      ...o.accounts,
    },
    join(
      Buffer.from(o.family ?? FAMILY, 'hex'),
      targetsArg(o.components ?? COMPONENTS),
      Buffer.from(o.meta ?? META, 'hex'),
      u16(o.fee ?? 0),
      Uint8Array.of(o.flags ?? 0),
    ),
    o.extra,
    o.flagsOf,
  );
const updateIx = (o: Over = {}) =>
  vaultIx(
    BASKET_PROGRAM,
    'update_recipe',
    { creator: OWNER, recipe: RECIPE, config: CONFIG, assets: ASSETS, ...o.accounts },
    join(targetsArg(o.components ?? COMPONENTS), Buffer.from(o.meta ?? META, 'hex')),
    o.extra,
    o.flagsOf,
  );
const cancelIx = (o: Over = {}) =>
  vaultIx(
    BASKET_PROGRAM,
    'cancel_pending',
    { signer: OWNER, recipe: RECIPE, config: CONFIG, ...o.accounts },
    new Uint8Array(),
    o.extra,
    o.flagsOf,
  );

const input = (
  step: ApprovedStep,
  bytes: Wire,
  over: Partial<BasketTx> = {},
  consents: ConsentKind[] = ['publish'],
): GuardInput => ({ step, tx: solanaTx(step, bytes, over), deployment: SOLANA, consents });

describe('the guard on Solana: a creator publishes, updates and takes back a shared portfolio', () => {
  it("the recipe is the program's account for the creator and the family, as @solana/kit derives it", () => {
    expect(recipeAddress(BASKET_PROGRAM.address, OWNER, FAMILY)).toBe(RECIPE);
  });

  it('passes each, on both message versions, with the consent the review screen collects', () => {
    const cases: [ApprovedStep, Ix][] = [
      [publishStep, publishIx()],
      [updateStep, updateIx()],
      [cancelStep, cancelIx()],
    ];
    for (const [step, ix] of cases)
      for (const version of [0, 'legacy'] as const) {
        const given = input(step, wire([...BUDGET, ix], { version }));
        expect(BasketTx.safeParse(given.tx).success, step.kind).toBe(true);
        const name = step.kind === 'publish' ? step.action : step.kind;
        expect(refusalOf(() => guardTransaction(given))?.message ?? null, name).toBeNull();
      }
  });

  it('takes the step from the order and the terms the screen showed, and from nothing else', () => {
    const order = {
      id: 'order-1',
      owner: { solana: OWNER },
      legs: [
        {
          id: 'leg-1',
          orderId: 'order-1',
          chain: 'solana',
          seq: 0,
          signer: 'owner',
          kind: 'publish',
          description: 'publish',
          trades: [],
          expected: [],
          status: 'planned',
          attempt: 0,
          txId: null,
          explorerUrl: null,
          validUntil: null,
          error: null,
        },
      ],
    } as unknown as Parameters<typeof approvedSteps>[0];
    expect(approvedSteps(order, { basketId: '0', publish: terms('publish') }, SOLANA)).toEqual([
      publishStep,
    ]);
    // A publish step with nothing said of what is published is refused before anything is built.
    expect(refusalOf(() => approvedSteps(order, { basketId: '0' }, SOLANA))?.code).toBe('order');
  });

  it('refuses a step that cannot mean what it says', () => {
    const bytes = wire([...BUDGET, publishIx()]);
    const wrong: [string, Partial<Publication>][] = [
      ['no such action', { action: 'delete' as never }],
      ['a family id that is not 32 bytes of hex', { familyId: 'ab' }],
      ['no version', { version: 0 }],
      [
        'weights that do not add up to 10,000',
        { components: [{ asset: 'solana:spy', weightBps: 9000 }] },
      ],
      ['an asset of another chain', { components: [{ asset: 'base:spy', weightBps: 10_000 }] }],
      ['no text hash', { metaHash: null }],
    ];
    for (const [name, change] of wrong) {
      const step = { ...publishStep, ...change } as ApprovedStep;
      expect(refusalOf(() => guardTransaction(input(step, bytes)))?.code, name).toBe('order');
    }
    const loaded = { ...cancelStep, components: COMPONENTS } as ApprovedStep;
    expect(refusalOf(() => guardTransaction(input(loaded, wire([cancelIx()]))))?.code).toBe(
      'order',
    );
  });

  it('a cancel names no version: the bytes are held to the creator and the portfolio, and an interface that grew a version is not one it knows', () => {
    const cancel = BASKET_PROGRAM.instructions
      .cancel_pending as ProgramTable['instructions'][string];
    expect(cancel.args).toEqual([]);
    const grown: ProgramTable = {
      ...BASKET_PROGRAM,
      instructions: {
        ...BASKET_PROGRAM.instructions,
        cancel_pending: { ...cancel, args: [{ name: 'version', type: 'u32' }] },
      },
    };
    const bytes = wire([
      vaultIx(
        grown,
        'cancel_pending',
        { signer: OWNER, recipe: RECIPE, config: CONFIG },
        Uint8Array.of(2, 0, 0, 0),
      ),
    ]);
    const refusal = refusalOf(() =>
      withRules({ program: grown }, () => runGuard(input(cancelStep, bytes))),
    );
    expect(refusal?.code).toBe('unsupported');
    expect(refusal?.message).toMatch(/no rule for the argument version/);
  });
});

const on = (
  step: ApprovedStep,
  name: string,
  check: Negative['check'],
  ix: () => Promise<Ix> | Ix,
  consents?: ConsentKind[],
): Negative => ({
  name,
  check,
  input: async () => input(step, wire([...BUDGET, await ix()]), {}, consents),
});
const notSigning = { signer: false, writable: true };

describe('the registry calls elsewhere: not signed yet', () => {
  it("on Robinhood Chain until IndexRegistry's interface is final, and on the mock", () => {
    const evmStep = {
      ...publishStep,
      chain: 'robinhood',
      owner: e.OWNER,
      components: [{ asset: 'robinhood:spy', weightBps: 10_000 }],
    } as ApprovedStep;
    const evmCall = e.evmTx(evmStep, { to: e.anyone('registry'), data: Uint8Array.of(1, 2, 3, 4) });
    const onEvm = refusalOf(() =>
      guardTransaction({ step: evmStep, tx: evmCall, deployment: e.EVM, consents: ['publish'] }),
    );
    expect(onEvm?.code).toBe('unsupported');
    expect(onEvm?.message).toMatch(/IndexRegistry/);
    const mock = deploymentsOf('mock').solana;
    if (!mock) throw new Error('the mock has no solana');
    const onMock = refusalOf(() =>
      guardTransaction({
        step: publishStep,
        tx: { ...solanaTx(publishStep, wire([publishIx()])), provenance: 'mock' },
        deployment: mock,
        consents: ['publish'],
      }),
    );
    expect(onMock?.code).toBe('unsupported');
  });
});

describe('the guard on Solana: each registry negative is refused by the check that names it', () => {
  const negatives: Negative[] = [
    // ---- another creator, another recipe
    on(publishStep, "another creator's portfolio of the same family", 'recipe', async () =>
      publishIx({ accounts: { recipe: await recipeOf(STRANGER) } }),
    ),
    on(publishStep, 'another family of the creator', 'recipe', async () =>
      publishIx({ accounts: { recipe: await recipeOf(OWNER, hex('another family')) } }),
    ),
    on(publishStep, 'the family id of another family beside the right account', 'recipe', () =>
      publishIx({ family: hex('another family') }),
    ),
    on(publishStep, "another family's text", 'recipe', () =>
      publishIx({ meta: hex('other text') }),
    ),
    on(publishStep, 'a stranger named as the creator', 'owner', () =>
      publishIx({ accounts: { creator: STRANGER }, flagsOf: { creator: notSigning } }),
    ),
    on(updateStep, "an update of another creator's portfolio", 'recipe', async () =>
      updateIx({ accounts: { recipe: await recipeOf(STRANGER) } }),
    ),
    on(updateStep, 'an update with another text', 'recipe', () =>
      updateIx({ meta: hex('other text') }),
    ),
    on(updateStep, 'a stranger named as the creator of an update', 'owner', () =>
      updateIx({ accounts: { creator: STRANGER }, flagsOf: { creator: notSigning } }),
    ),
    on(cancelStep, 'a cancel of another portfolio', 'recipe', async () =>
      cancelIx({ accounts: { recipe: await recipeOf(OWNER, hex('another family')) } }),
    ),
    on(cancelStep, "a cancel of another creator's portfolio", 'recipe', async () =>
      cancelIx({ accounts: { recipe: await recipeOf(STRANGER) } }),
    ),
    on(cancelStep, 'a stranger named as the one who cancels', 'owner', () =>
      cancelIx({ accounts: { signer: STRANGER }, flagsOf: { signer: notSigning } }),
    ),
    // ---- other targets
    on(publishStep, 'other weights', 'targets', () =>
      publishIx({
        components: [
          { asset: 'solana:spy', weightBps: 4000 },
          { asset: 'solana:gold', weightBps: 6000 },
        ],
      }),
    ),
    on(publishStep, 'another asset', 'targets', () =>
      publishIx({
        components: [
          { asset: 'solana:spy', weightBps: 6000 },
          { asset: 'solana:usdc', weightBps: 4000 },
        ],
      }),
    ),
    on(publishStep, 'an asset more', 'targets', () =>
      publishIx({
        components: [
          ...COMPONENTS.map((c) => ({ ...c, weightBps: c.weightBps - 500 })),
          { asset: 'solana:usdc', weightBps: 1000 },
        ],
      }),
    ),
    on(updateStep, 'an update to other weights', 'targets', () =>
      updateIx({
        components: [
          { asset: 'solana:spy', weightBps: 5000 },
          { asset: 'solana:gold', weightBps: 5000 },
        ],
      }),
    ),
    // ---- other limits
    on(publishStep, 'a fee cap that is not zero', 'limits', () => publishIx({ fee: 1 })),
    on(publishStep, 'flags that are not zero', 'limits', () => publishIx({ flags: 1 })),
    // ---- another call, or more than the call
    on(publishStep, 'an update where the step is a first publish', 'instruction', () => updateIx()),
    on(updateStep, 'a first publish where the step is an update', 'instruction', () => publishIx()),
    on(updateStep, 'a cancel where the step is an update', 'instruction', () => cancelIx()),
    on(cancelStep, 'an update where the step takes a version back', 'instruction', () =>
      updateIx(),
    ),
    {
      name: 'a trade beside the publish',
      check: 'instruction',
      input: async () =>
        input(
          publishStep,
          wire([
            ...BUDGET,
            publishIx(),
            await ownerSwapIx(BASKET_PROGRAM, {
              sell: 'solana:usdc',
              buy: 'solana:spy',
              inRaw: '1',
              minOutRaw: '1',
            }),
          ]),
        ),
    },
    on(publishStep, 'another config', 'accounts', () =>
      publishIx({ accounts: { config: someone('config') } }),
    ),
    on(publishStep, 'another system program', 'accounts', () =>
      publishIx({ accounts: { system_program: someone('system') } }),
    ),
    on(cancelStep, 'an account more on a cancel', 'accounts', () =>
      cancelIx({ extra: [{ address: someone('spare') }] }),
    ),
    // ---- no consent
    on(publishStep, 'a publish with no consent handed over', 'consent', () => publishIx(), []),
    on(updateStep, 'an update with the consent for something else', 'consent', () => updateIx(), [
      'new_asset',
      'auto_follow_on',
    ]),
    on(cancelStep, 'a cancel with no consent handed over', 'consent', () => cancelIx(), []),
  ];
  eachBites(negatives);
});
