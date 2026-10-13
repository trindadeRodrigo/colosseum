import {
  type ChainVault,
  deploymentsOf,
  evmVaultAddress,
  solanaVaultAddress,
} from '@colosseum/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVM, json } from '../wallet/test/fake-port';
import { exactPublishTargets, readPublishVault } from './publish-vault';
import { SOLANA, vaultOf, WEIGHTS } from './test/fixtures';

const node = vi.hoisted(() => ({ enabled: true }));
const live = vi.hoisted(() => ({ read: vi.fn(), evm: vi.fn() }));
vi.mock('../order/chain-node', () => ({ chainNode: () => (node.enabled ? vi.fn() : undefined) }));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  readSolanaVault: live.read,
  readEvmVault: live.evm,
}));
const address = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '42');
const source = { chain: 'solana', owner: SOLANA, address, basketId: '42', mock: false } as const;
const chainRead = (targets = WEIGHTS): ChainVault => ({
  address,
  autoFollow: false,
  targets: targets.map((t) => ({ ...t, token: t.asset })),
});
const answer = (over: Parameters<typeof vaultOf>[0] = {}, provenance = 'sandbox') =>
  json({
    chain: 'solana',
    name: 'Solana',
    mode: 'live',
    provenance,
    prices: [],
    disclaimer: 'd',
    vault: { ...vaultOf({ address, basketId: '42', ...over }), provenance },
  });
beforeEach(() => {
  node.enabled = true;
  live.read.mockReset().mockResolvedValue(chainRead());
  live.evm.mockReset();
});

describe('an exact shared vault strategy', () => {
  it('preserves every exact target and order without using held shares or cash balances', () => {
    expect(exactPublishTargets('solana', WEIGHTS)).toEqual(WEIGHTS);
    expect(exactPublishTargets('solana', [...WEIGHTS].reverse())).toEqual([...WEIGHTS].reverse());
  });
  it.each([
    { raw: undefined },
    { raw: [] },
    { raw: [{ kind: 'index', family: 'other', weightBps: 10000 }] },
    { raw: [{ asset: null, weightBps: 10000 }] },
    { raw: [{ asset: 'solana:spyx', weightBps: 7000 }] },
    { raw: [{ asset: 'base:spyx', weightBps: 10000 }] },
  ])('refuses missing, empty, nested or incomplete targets %j', ({ raw }) => {
    expect(exactPublishTargets('solana', raw)).toBeNull();
  });
  it('takes the independently proved chain targets when the API describes other weights', async () => {
    const result = await readPublishVault(async () => answer({ positions: [] }), source);
    expect(result).toMatchObject({ kind: 'read', components: WEIGHTS, source: 'chain' });
    expect(live.read).toHaveBeenCalledOnce();
  });
  it.each([
    { owner: '11111111111111111111111111111111' },
    { basketId: '43' },
    { address: '11111111111111111111111111111111' },
  ])('rejects forged API identity %j before reading targets', async (over) => {
    expect(await readPublishVault(async () => answer(over), source)).toEqual({ kind: 'owner' });
    expect(live.read).not.toHaveBeenCalled();
  });
  it('refuses sandbox API-only targets when there is no independent reader', async () => {
    node.enabled = false;
    expect(await readPublishVault(async () => answer(), source)).toEqual({ kind: 'unverified' });
  });
  it.each([
    { targets: [{ asset: 'solana:usdc', weightBps: 3000 }, ...WEIGHTS.slice(0, 2)] },
    { targets: [{ asset: null, token: 'unknown', weightBps: 10000 }] },
  ])('does not remove positive cash or unknown target entries %j', async ({ targets }) => {
    live.read.mockResolvedValue({ ...chainRead(), targets });
    expect(await readPublishVault(async () => answer(), source)).toEqual({ kind: 'unsupported' });
  });
  it('shares an owner-proved EVM vault with structural zero cash without changing positive targets', async () => {
    const deployment = deploymentsOf('testnet').robinhood;
    if (deployment?.family !== 'evm') throw new Error('missing committed EVM fixture');
    const evmAddress = evmVaultAddress(deployment, EVM, '42');
    const weights = [
      { asset: 'robinhood:tspy', weightBps: 4000 },
      { asset: 'robinhood:tqqq', weightBps: 3000 },
      { asset: 'robinhood:tnvda', weightBps: 3000 },
    ];
    const targets = [...weights, { asset: deployment.cash, weightBps: 0 }].map((t) => ({
      ...t,
      token: deployment.assets[t.asset]?.token ?? '',
    }));
    live.evm.mockResolvedValue({ address: evmAddress, autoFollow: false, targets });
    const res = () =>
      json({
        chain: 'robinhood',
        name: 'Robinhood Chain',
        mode: 'live',
        provenance: 'sandbox',
        prices: [],
        disclaimer: 'd',
        vault: {
          ...vaultOf({
            chain: 'robinhood',
            address: evmAddress,
            owner: EVM,
            basketId: '42',
            cash: { asset: deployment.cash, raw: '0', display: '0', multiplier: '1' },
          }),
          provenance: 'sandbox',
        },
      });
    expect(
      await readPublishVault(async () => res(), {
        chain: 'robinhood',
        owner: EVM,
        address: evmAddress,
        basketId: '42',
        mock: false,
      }),
    ).toMatchObject({ kind: 'read', components: weights, strategy: JSON.stringify(targets) });
    expect(live.evm).toHaveBeenCalledOnce();
  });
  it('canonically excludes zero allocations but retains the full verified snapshot for change checks', async () => {
    const targets = [...WEIGHTS, { asset: 'solana:usdc', token: 'cash', weightBps: 0 }];
    live.read.mockResolvedValue({ ...chainRead(), targets });
    const result = await readPublishVault(async () => answer(), source);
    expect(result).toMatchObject({
      kind: 'read',
      components: WEIGHTS,
      strategy: JSON.stringify(targets),
    });
    expect(exactPublishTargets('solana', [{ asset: 'solana:usdc', weightBps: 0 }])).toBeNull();
    live.read.mockResolvedValue({
      ...chainRead(),
      targets: [
        { asset: 'solana:usdc', weightBps: 1000 },
        ...WEIGHTS.map((t, i) => ({ ...t, weightBps: i === 0 ? 3000 : t.weightBps })),
      ],
    });
    expect(await readPublishVault(async () => answer(), source)).toEqual({ kind: 'unsupported' });
  });
  it('accepts only explicitly mock-stamped API targets on the mock, without inventing cash', async () => {
    const mock = { ...source, mock: true };
    const ids = ['solana:spy', 'solana:nvda', 'solana:tsla'];
    const positions = WEIGHTS.map((t, i) => ({
      asset: ids[i] ?? t.asset,
      targetBps: t.weightBps,
      raw: '0',
      display: '0',
      multiplier: '1',
      lastKeeperAt: null,
      valueUsd: '0',
      weightBps: 0,
      driftBps: -t.weightBps,
    }));
    const result = await readPublishVault(async () => answer({ positions }, 'mock'), mock);
    expect(result).toMatchObject({ kind: 'read', source: 'mock' });
    expect(await readPublishVault(async () => answer({ positions }, 'sandbox'), mock)).toEqual({
      kind: 'unverified',
    });
    expect(
      await readPublishVault(
        async () => answer({ positions: positions.slice(0, 2) }, 'mock'),
        mock,
      ),
    ).toEqual({ kind: 'unsupported' });
    expect(live.read).not.toHaveBeenCalled();
    expect(deploymentsOf('testnet').solana).toBeDefined();
  });
});
