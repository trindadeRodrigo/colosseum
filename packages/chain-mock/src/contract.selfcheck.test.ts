import { type BuiltTx, type ChainAdapter, ChainError } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { type ContractFixture, runContract } from './contract';
import { mockFixture } from './fixture';

// The contract is only worth running if a wrong adapter fails it. Each adapter below is the mock with
// one thing broken; the test names the cases that must catch it. A fault that no case catches is a hole
// in the contract, and this file is where it shows.

type Wrap = (real: ChainAdapter, f: ContractFixture) => Partial<ChainAdapter>;
const BUILDERS = [
  'buildApprove',
  'buildCreateVault',
  'buildDeposit',
  'buildOwnerSwap',
  'buildSetTargets',
  'buildAcceptVersion',
  'buildSetAutoFollow',
  'buildWithdrawInKind',
  'buildPublishRecipe',
  'buildAdoptVersion',
  'buildKeeperLeg',
] as const;

/** Every builder, with `spoil` applied to each transaction it returns. */
function spoilTx(real: ChainAdapter, spoil: (tx: BuiltTx) => unknown): Partial<ChainAdapter> {
  const out: Record<string, unknown> = {};
  for (const name of BUILDERS) {
    const build = real[name] as (...args: unknown[]) => Promise<BuiltTx | BuiltTx[]>;
    out[name] = async (...args: unknown[]) => {
      const built = await build(...args);
      return Array.isArray(built) ? built.map(spoil) : spoil(built);
    };
  }
  return out as Partial<ChainAdapter>;
}
/** Every method, with a refusal passed through `change`. */
function spoilErrors(
  real: ChainAdapter,
  change: (e: ChainError) => unknown,
): Partial<ChainAdapter> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== 'function') continue;
    out[name] = async (...args: unknown[]) => {
      try {
        return await (value as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        throw e instanceof ChainError ? change(e) : e;
      }
    };
  }
  return out as Partial<ChainAdapter>;
}

const FAULTS: { fault: string; wrap: Wrap; caught: string[] }[] = [
  {
    fault: 'gives every transaction the same hash',
    wrap: (real) => spoilTx(real, (tx) => ({ ...tx, messageHash: 'f'.repeat(64) })),
    caught: ['builds a different transaction, with a different hash, for every different step'],
  },
  {
    fault: 'gives every transaction the same bytes',
    wrap: (real) => spoilTx(real, (tx) => ({ ...tx, payload: 'AAAAAAAAAAAA' })),
    caught: ['builds a different transaction, with a different hash, for every different step'],
  },
  {
    fault: 'drops the fields a wallet needs: evm on EVM, the last valid block height on Solana',
    wrap: (real) => spoilTx(real, ({ evm: _evm, lastValidBlockHeight: _height, ...rest }) => rest),
    caught: ['previews a deposit as cash leaving the wallet for the vault, and nothing else'],
  },
  {
    fault: 'does not simulate',
    wrap: (real) =>
      spoilTx(real, (tx) => ({ ...tx, preview: { ...tx.preview, simulated: false } })),
    caught: ['previews a deposit as cash leaving the wallet for the vault, and nothing else'],
  },
  {
    fault: 'stamps leg ids itself',
    wrap: (real) => spoilTx(real, (tx) => ({ ...tx, legId: 'leg', attemptId: 'attempt' })),
    caught: ['previews a trade inside the vault, with the wallet untouched'],
  },
  {
    fault: 'labels its transactions live',
    wrap: (real) => spoilTx(real, (tx) => ({ ...tx, provenance: 'live' })),
    caught: ['publishes a recipe, signed by its creator'],
  },
  {
    fault: 'labels its prices live, and stamps them in 1970',
    wrap: (real) => ({
      getPrices: async (ids) =>
        (await real.getPrices(ids)).map((p) => ({
          ...p,
          provenance: 'live' as const,
          fetchedAt: '1970-01-01T00:00:00.000Z',
        })),
    }),
    caught: [
      'prices what it is asked for, once each, freshly, and every asset that has a price source',
    ],
  },
  {
    fault: 'quotes with no floor',
    wrap: (real) => ({
      quote: async (t, taker) => ({ ...(await real.quote(t, taker)), minOutRaw: '0' }),
    }),
    caught: ['quotes a trade: the same trade back, a floor under the output, a cost in range'],
  },
  {
    fault: 'says gas is free',
    wrap: (real) => ({
      funding: async (owner, need) => {
        const r = await real.funding(owner, need);
        return { ...r, gasNeedRaw: '0', ok: BigInt(r.cashHaveRaw) >= BigInt(r.cashNeedRaw) };
      },
    }),
    caught: ['says whether a wallet can pay: cash and gas, and ok only when both are there'],
  },
  {
    fault: 'lists vaults that have auto-follow off',
    wrap: (real, f) => ({
      listAutoFollowVaults: async (id) => [...(await real.listAutoFollowVaults(id)), f.manualVault],
    }),
    caught: ['lists exactly the vaults with auto-follow on, and filters them by recipe'],
  },
  {
    fault: 'never sees a transaction land',
    wrap: () => ({ track: async () => ({ status: 'pending' as const, explorerUrl: '' }) }),
    caught: [
      'a deposit moves cash, and only cash, from the owner to the vault',
      'a withdrawal hands every token to the owner, and to nobody else',
    ],
  },
  {
    fault: 'builds targets other than the ones asked for',
    wrap: (real) => ({
      // The weights of the first two assets, swapped.
      buildSetTargets: ({ vault, targets: [a, b, ...rest] }) =>
        real.buildSetTargets({
          vault,
          targets:
            a && b
              ? [{ ...a, weightBps: b.weightBps }, { ...b, weightBps: a.weightBps }, ...rest]
              : [],
        }),
    }),
    caught: ['setting targets stores exactly those, stops following, and switches auto-follow off'],
  },
  {
    fault: 'switches auto-follow on whatever was asked',
    wrap: (real) => ({
      buildSetAutoFollow: (a) => real.buildSetAutoFollow({ vault: a.vault, on: true }),
    }),
    caught: ['switching auto-follow changes what the vault and the auto-follow list say'],
  },
  {
    fault: 'withdraws the cash and leaves the rest',
    wrap: (real, f) => ({
      buildWithdrawInKind: async (a) => {
        const cash = (await real.getVault(f.vault))?.cash.asset ?? '';
        return real.buildWithdrawInKind({ vault: a.vault, assets: [cash] });
      },
    }),
    caught: [
      'previews a withdrawal as the tokens themselves going to the owner',
      'a withdrawal hands every token to the owner, and to nobody else',
    ],
  },
  {
    fault: 'lets the keeper trade away from a target',
    wrap: (real, f) => ({
      buildKeeperLeg: (vault, trade) =>
        real.buildKeeperLeg(vault, trade).catch((e) => {
          if (!(e instanceof ChainError) || e.code !== 'NotTowardTarget') throw e;
          return real.buildKeeperLeg(f.vault, f.keeperTrade);
        }),
    }),
    caught: ['the keeper, away from a target: NotTowardTarget'],
  },
  {
    fault: 'lets the keeper adopt a version that adds an asset',
    wrap: (real, f) => ({
      buildAdoptVersion: (vault) =>
        real.buildAdoptVersion(vault).catch((e) => {
          if (!(e instanceof ChainError) || e.code !== 'NewAssetNeedsOwner') throw e;
          return real.buildKeeperLeg(f.vault, f.keeperTrade);
        }),
    }),
    caught: ['adopting a version that adds an asset: NewAssetNeedsOwner'],
  },
  {
    fault: 'refuses with a plain Error',
    wrap: (real) => spoilErrors(real, (e) => new Error(e.message)),
    caught: [
      'a vault that does not exist: VaultNotFound',
      'a plan id the owner already used: VaultExists',
      'more trades than one transaction takes: TooManyTrades',
      'arguments that are not what the schema says: BadInput, never another kind of error',
      'the keeper, with auto-follow off: AutoFollowOff',
      'the keeper, in an asset the vault did not accept: MintNotAccepted',
      'the keeper, away from a target: NotTowardTarget',
    ],
  },
  {
    fault: 'refuses everything with the same code',
    wrap: (real) => spoilErrors(real, (e) => new ChainError('Unknown', e.message)),
    caught: [
      'opens a vault that follows a recipe at the version the person saw, and no other',
      'a vault that does not exist: VaultNotFound',
      'a deposit of more cash than the wallet holds: NotFunded',
      'accepting a version before it takes effect: VersionNotEffective; a wrong number: VersionMismatch',
    ],
  },
];

async function failures(chain: 'solana' | 'robinhood', wrap: Wrap): Promise<string[]> {
  const results = await runContract(async () => {
    const f = await mockFixture(chain);
    return { ...f, adapter: { ...f.adapter, ...wrap(f.adapter, f) } as ChainAdapter };
  });
  return results.filter((r) => !r.passed).map((r) => r.name);
}

describe('the adapter contract fails a wrong adapter', () => {
  it('passes the mock itself through the same runner', async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const results = await runContract(() => mockFixture(chain));
      expect(results.filter((r) => !r.passed)).toEqual([]);
      expect(results.length).toBeGreaterThan(40);
    }
  });

  for (const { fault, wrap, caught } of FAULTS)
    it(`catches an adapter that ${fault}`, async () => {
      for (const chain of ['solana', 'robinhood'] as const)
        expect(await failures(chain, wrap)).toEqual(expect.arrayContaining(caught));
    });

  it('catches the adapter the review of FRAME-1 wrote, which passed every case before', async () => {
    // Garbage bytes and one hash for every transaction, nothing simulated, no chain fields, quotes with
    // no floor, prices of nothing, free gas, a transaction that never lands, and builders that ignore
    // what they were asked.
    const wrong: Wrap = (real, f) => ({
      ...spoilTx(real, ({ evm: _evm, lastValidBlockHeight: _height, feePayer: _payer, ...tx }) => ({
        ...tx,
        payload: 'AA==',
        messageHash: 'x',
        description: '',
        preview: { ...tx.preview, simulated: false, feeNativeRaw: '0', summary: 'x' },
      })),
      quote: async (t, taker) => ({
        ...(await real.quote(t, taker)),
        minOutRaw: '0',
        costBps: -99_999,
      }),
      track: async () => ({ status: 'pending' as const, explorerUrl: '' }),
      getPrices: async (ids) =>
        (await real.getPrices(ids)).map((p) => ({ ...p, usdPerToken: '0.000000000000000001' })),
      funding: async (owner, need) => ({ ...(await real.funding(owner, need)), gasNeedRaw: '0' }),
      listAutoFollowVaults: async () => [f.vault, f.stranger, f.owner],
    });
    for (const chain of ['solana', 'robinhood'] as const) {
      const failed = await failures(chain, wrong);
      expect(failed.length).toBeGreaterThanOrEqual(20);
      expect(failed).toEqual(
        expect.arrayContaining([
          'prices what it is asked for, once each, freshly, and every asset that has a price source',
          'lists exactly the vaults with auto-follow on, and filters them by recipe',
          'says whether a wallet can pay: cash and gas, and ok only when both are there',
          'quotes a trade: the same trade back, a floor under the output, a cost in range',
          'builds a different transaction, with a different hash, for every different step',
          'a deposit moves cash, and only cash, from the owner to the vault',
          'switching auto-follow changes what the vault and the auto-follow list say',
          'setting targets stores exactly those, stops following, and switches auto-follow off',
        ]),
      );
    }
  });
});
