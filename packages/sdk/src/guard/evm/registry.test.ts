import { createHash } from 'node:crypto';
import { BasketTx, type ConsentKind } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { eachBites, type Negative, refusalOf } from '../../../test/bites';
import {
  anyone,
  call,
  type EvmCallOf,
  evmDeployment,
  evmTx,
  FACTORY,
  OWNER,
  STRANGER,
  VAULT,
  WEIGHTS,
} from '../../../test/evm';
import { deploymentsOf } from '../deployment';
import { guardTransaction, isGuarded } from '../index';
import { familyTextHash } from '../meta';
import type { ApprovedStep, EvmDeployment, GuardInput, Loaded, Publication } from '../types';
import type { AbiValue } from './abi';
import { evmIndexId } from './addresses';

vi.mock('../rules', () => import('../../../test/rules'));
vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));

// The registry calls a creator signs for a shared portfolio of their own on an EVM chain (gate
// SHARED-FULL, AGT-4): `create` the first version, `publish` the next, `cancel` the one that waits. The
// portfolio's id is keccak256(abi.encode(creator, familyId)), derived here; the call goes to the
// deployment's registry and nowhere else. Each negative is refused by the one check that names it.

const hex = (label: string) => createHash('sha256').update(label).digest('hex');
const REGISTRY = anyone('registry');
const EVM = evmDeployment({ registry: REGISTRY });
const FAMILY = hex('sdk test: family');
const TEXT = {
  slug: 'sand-to-server',
  name: 'From Sand to Server',
  copy: 'Chips, and what runs on them.',
  kind: 'index' as const,
};
const META = `0x${familyTextHash({ familyId: FAMILY, ...TEXT })}`;
const COMPONENTS = [
  { asset: 'robinhood:spy', weightBps: 6000 },
  { asset: 'robinhood:gold', weightBps: 4000 },
];
const ID = evmIndexId(OWNER, FAMILY);
const tokenOf = (asset: string) => EVM.assets[asset]?.token ?? anyone(`token ${asset}`);
/** Weights as the registry takes them: by token address, ascending. */
const weights = (c: { asset: string; weightBps: number }[]): AbiValue[] =>
  c
    .map((t) => [tokenOf(t.asset), BigInt(t.weightBps)] as [string, bigint])
    .sort(([a], [b]) => (a < b ? -1 : 1));

const base = { legId: 'leg-1', chain: 'robinhood', owner: OWNER, basketId: '0' } as const;
const stepOf = (action: Publication['action']): ApprovedStep => ({
  ...base,
  kind: 'publish',
  ...(action === 'cancel'
    ? { action, familyId: FAMILY, components: [], text: null, version: 2 }
    : {
        action,
        familyId: FAMILY,
        components: COMPONENTS,
        text: TEXT,
        version: action === 'publish' ? 1 : 2,
      }),
});
const publishStep = stepOf('publish');
const updateStep = stepOf('update');
const cancelStep = stepOf('cancel');

type Over = {
  family?: string;
  id?: string;
  components?: { asset: string; weightBps: number }[];
  meta?: string;
  fee?: bigint;
  flags?: bigint;
};
const createData = (o: Over = {}) =>
  call(`create(bytes32,${WEIGHTS},bytes32,uint16,uint8)`, [
    `0x${o.family ?? FAMILY}`,
    weights(o.components ?? COMPONENTS),
    o.meta ?? META,
    o.fee ?? 0n,
    o.flags ?? 0n,
  ]);
const publishData = (o: Over = {}) =>
  call(`publish(bytes32,${WEIGHTS},bytes32)`, [
    o.id ?? ID,
    weights(o.components ?? COMPONENTS),
    o.meta ?? META,
  ]);
const cancelData = (o: Over = {}) => call('cancel(bytes32)', [o.id ?? ID]);
const to = (data: Uint8Array, target = REGISTRY): EvmCallOf => ({ to: target, data });

const input = (
  step: ApprovedStep,
  c: EvmCallOf,
  over: Partial<BasketTx> = {},
  consents: ConsentKind[] = ['publish'],
): GuardInput => ({ step, tx: evmTx(step, c, over), deployment: EVM, consents });
const on = (
  step: ApprovedStep,
  name: string,
  check: Negative['check'],
  c: EvmCallOf,
  over: Partial<BasketTx> = {},
  consents?: ConsentKind[],
): Negative => ({ name, check, input: () => input(step, c, over, consents) });

describe('the guard on EVM: the registry calls of a creator pass', () => {
  it('the id is the registry’s: keccak256(abi.encode(creator, familyId))', () => {
    expect(ID).toMatch(/^0x[0-9a-f]{64}$/);
    expect(evmIndexId(OWNER, `0x${FAMILY}`)).toBe(ID);
    expect(evmIndexId(STRANGER, FAMILY)).not.toBe(ID);
    expect(evmIndexId(OWNER.toUpperCase().replace('0X', '0x'), FAMILY)).toBe(ID);
  });

  it('create the first version, publish the next, cancel the one that waits', () => {
    const cases: [ApprovedStep, EvmCallOf][] = [
      [publishStep, to(createData())],
      [updateStep, to(publishData())],
      [cancelStep, to(cancelData())],
    ];
    for (const [step, c] of cases) {
      const given = input(step, c);
      expect(BasketTx.safeParse(given.tx).success).toBe(true);
      expect(refusalOf(() => guardTransaction(given))?.message ?? null).toBeNull();
      expect(isGuarded(guardTransaction(given))).toBe(true);
    }
  });

  it('passes a create through the registry of the committed 46630 entry, with no copy of the chain', () => {
    const rh = deploymentsOf('testnet').robinhood as Loaded<EvmDeployment>;
    expect(rh.registry).toBe('0xe73c5df15452469873f610a26dac7fec68a23b14');
    const step: ApprovedStep = {
      ...publishStep,
      components: [
        { asset: 'robinhood:tspy', weightBps: 4000 },
        { asset: 'robinhood:tqqq', weightBps: 3000 },
        { asset: 'robinhood:tgld', weightBps: 3000 },
      ],
    } as ApprovedStep;
    const components = step.kind === 'publish' ? step.components : [];
    const data = call(`create(bytes32,${WEIGHTS},bytes32,uint16,uint8)`, [
      `0x${FAMILY}`,
      components
        .map((t) => [rh.assets[t.asset]?.token ?? '', BigInt(t.weightBps)] as [string, bigint])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      META,
      0n,
      0n,
    ]);
    const given: GuardInput = {
      step,
      tx: evmTx(step, { to: rh.registry ?? '', data }),
      deployment: rh,
      consents: ['publish'],
    };
    expect(refusalOf(() => guardTransaction(given))?.message ?? null).toBeNull();
    // the same bytes to the factory are refused
    const elsewhere = { ...given, tx: evmTx(step, { to: rh.factory, data }) };
    expect(refusalOf(() => guardTransaction(elsewhere))?.code).toBe('target');
  });

  it('is not signed where the deployment names no registry', () => {
    const none = evmDeployment();
    const refusal = refusalOf(() =>
      guardTransaction({ ...input(publishStep, to(createData())), deployment: none }),
    );
    expect(refusal?.code).toBe('unsupported');
  });
});

describe('the guard on EVM: each registry negative is refused by the check that names it', () => {
  const negatives: Negative[] = [
    // ---- another creator, another family, other text
    on(
      publishStep,
      'a create of another family',
      'recipe',
      to(createData({ family: hex('another') })),
    ),
    on(
      updateStep,
      "a publish to another creator's portfolio",
      'recipe',
      to(publishData({ id: evmIndexId(STRANGER, FAMILY) })),
    ),
    on(
      updateStep,
      'a publish to another family of the creator',
      'recipe',
      to(publishData({ id: evmIndexId(OWNER, hex('another')) })),
    ),
    on(
      cancelStep,
      "a cancel of another creator's version",
      'recipe',
      to(cancelData({ id: evmIndexId(STRANGER, FAMILY) })),
    ),
    on(
      publishStep,
      "another family's text",
      'recipe',
      to(createData({ meta: `0x${hex('other text')}` })),
    ),
    on(
      updateStep,
      'the hash of a text the creator did not see',
      'recipe',
      to(
        publishData({
          meta: `0x${familyTextHash({ familyId: FAMILY, ...TEXT, copy: 'Chips, and what runs off them.' })}`,
        }),
      ),
    ),
    // ---- other assets and weights
    on(
      publishStep,
      'other weights',
      'targets',
      to(
        createData({
          components: [
            { asset: 'robinhood:spy', weightBps: 5000 },
            { asset: 'robinhood:gold', weightBps: 5000 },
          ],
        }),
      ),
    ),
    on(
      updateStep,
      'another asset',
      'targets',
      to(
        publishData({
          components: [
            { asset: 'robinhood:spy', weightBps: 6000 },
            { asset: 'robinhood:usdc', weightBps: 4000 },
          ],
        }),
      ),
    ),
    on(
      publishStep,
      'an asset more',
      'targets',
      to(createData({ components: [...COMPONENTS, { asset: 'robinhood:usdc', weightBps: 0 }] })),
    ),
    // ---- the limits a create sets
    on(publishStep, 'a fee cap', 'limits', to(createData({ fee: 1n }))),
    on(publishStep, 'flags', 'limits', to(createData({ flags: 1n }))),
    // ---- another contract, another function
    on(publishStep, 'a create sent to the factory', 'target', to(createData(), FACTORY)),
    on(cancelStep, 'a cancel sent to the vault', 'target', to(cancelData(), VAULT)),
    on(publishStep, 'a publish step that makes the next version', 'function', to(publishData())),
    on(updateStep, 'an update that creates', 'function', to(createData())),
    on(cancelStep, 'a cancel that publishes', 'function', to(publishData())),
    on(
      publishStep,
      'an approval to the registry',
      'function',
      to(call('approve(address,uint256)', [STRANGER, 1n])),
    ),
    // ---- the call around it
    on(publishStep, 'another network', 'network', { ...to(createData()), chainId: 4663 }),
    on(publishStep, 'a value sent', 'value', { ...to(createData()), value: '1' }),
    on(publishStep, 'no consent', 'consent', to(createData()), {}, []),
    on(updateStep, 'another consent', 'consent', to(publishData()), {}, ['new_asset']),
  ];
  eachBites(negatives);
});
