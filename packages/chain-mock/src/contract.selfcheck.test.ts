import { type BuiltTx, type ChainAdapter, ChainError, type ChainReader } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { CONTRACT_GROUPS, type ContractFixture, type ReadsFixture, runContract } from './contract';
import { mockFixture } from './fixture';
import { sha256Hex } from './ids';

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

type MockChain = 'solana' | 'robinhood';
const BOTH: MockChain[] = ['solana', 'robinhood'];
/** `chains` narrows a fault to where it can show: an approval exists on an EVM chain only. */
const FAULTS: { fault: string; wrap: Wrap; caught: string[]; chains?: MockChain[] }[] = [
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
    fault: 'states no minimum for its trades',
    wrap: (real) => spoilTx(real, (tx) => ({ ...tx, preview: { ...tx.preview, minimums: [] } })),
    caught: ['states the least each trade accepts, one entry per trade and in their order'],
  },
  {
    fault: 'leaves the minimums out of the preview',
    wrap: (real) =>
      spoilTx(real, ({ preview: { minimums: _minimums, ...preview }, ...tx }) => ({
        ...tx,
        preview,
      })),
    caught: ['previews a deposit as cash leaving the wallet for the vault, and nothing else'],
  },
  {
    fault: 'states a minimum for a keeper leg whose bytes carry none, or none where they carry one',
    wrap: (real, f) => ({
      buildKeeperLeg: async (vault, trade) => {
        const tx = await real.buildKeeperLeg(vault, trade);
        const stated = tx.preview.minimums.length
          ? []
          : [{ sell: trade.sell, buy: trade.buy, inRaw: trade.amountInRaw, minOutRaw: '1' }];
        return vault === f.vault ? { ...tx, preview: { ...tx.preview, minimums: stated } } : tx;
      },
    }),
    caught: ['a keeper trade moves the vault toward its target and stamps the asset'],
  },
  {
    fault: 'accepts any output: every minimum is zero',
    wrap: (real) =>
      spoilTx(real, (tx) => ({
        ...tx,
        preview: {
          ...tx.preview,
          minimums: tx.preview.minimums.map((m) => ({ ...m, minOutRaw: '0' })),
        },
      })),
    caught: ['states the least each trade accepts, one entry per trade and in their order'],
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
    fault: 'calls itself live',
    wrap: () => ({ provenance: 'live' as const }),
    caught: ['names its chain, its capabilities and the label on its figures'],
  },
  {
    fault: 'says a price never goes stale',
    wrap: (real) => ({
      getPrices: async (ids) =>
        (await real.getPrices(ids)).map((p) => ({ ...p, maxAgeSeconds: 0 })),
    }),
    caught: [
      'prices what it is asked for, once each, freshly, and every asset that has a price source',
    ],
  },
  {
    fault: 'asks for more gas when told that no account is opened',
    wrap: (real) => ({
      funding: async (owner, need) => {
        const r = await real.funding(owner, need);
        return need.newAccounts === 0
          ? { ...r, gasNeedRaw: (BigInt(r.gasNeedRaw) * 2n).toString(), ok: false }
          : r;
      },
    }),
    caught: ['says whether a wallet can pay: cash and gas, and ok only when both are there'],
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
    caught: ['lists exactly the vaults with auto-follow on'],
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
    fault: "holds a person's own targets to exactly 10,000",
    wrap: (real) => ({
      buildSetTargets: async (a) => {
        if (a.targets.reduce((n, t) => n + t.weightBps, 0) !== 10_000)
          throw new ChainError('BadInput', 'targets: weights must add up to exactly 10,000');
        return real.buildSetTargets(a);
      },
    }),
    caught: [
      'targets that leave a share in cash are stored as they are: at most 10,000, not exactly',
    ],
  },
  {
    fault: 'takes targets that add up to more than the whole',
    wrap: (real, f) => ({
      buildSetTargets: (a) =>
        real.buildSetTargets(a).catch(async (e) => {
          if (!(e instanceof ChainError) || e.code !== 'BadInput') throw e;
          return real.buildSetAutoFollow({ vault: f.manualVault, on: false });
        }),
    }),
    caught: ['arguments that are not what the schema says: BadInput, never another kind of error'],
  },
  {
    fault: 'lets a caller name who may take the cash',
    wrap: (real) => ({
      buildApprove: ({ owner, basketId, amountRaw }) =>
        real.buildApprove({ owner, basketId, amountRaw }),
    }),
    caught: ['approves cash for a plan where the chain needs it, and refuses where it does not'],
    chains: ['robinhood'],
  },
  {
    fault: 'hashes any signed bytes to the last transaction it built',
    wrap: (real) => {
      let last = '';
      return {
        ...spoilTx(real, (tx) => {
          last = tx.messageHash;
          return tx;
        }),
        messageHashOf: async () => last,
      };
    },
    caught: [
      'does not take altered bytes for the ones it built, and lands nothing when asked to relay them',
    ],
  },
  {
    fault: 'relays altered bytes as the transaction it built',
    wrap: (real, f) => {
      let last: BuiltTx | undefined;
      return {
        ...spoilTx(real, (tx) => {
          last = tx;
          return tx;
        }),
        relay: (signed) =>
          real.relay(signed).catch((e) => {
            if (!last || !(e instanceof ChainError)) throw e;
            return f.send(last);
          }),
      };
    },
    caught: [
      'does not take altered bytes for the ones it built, and lands nothing when asked to relay them',
    ],
  },
  {
    fault: 'hashes the signature along with the message',
    wrap: (real) => ({
      messageHashOf: async (signed) =>
        `${(await real.messageHashOf(signed)).slice(0, 56)}${'0'.repeat(8)}`,
    }),
    caught: [
      'reads the hash it built back from the signed bytes, relays them, and finds them on the chain',
    ],
  },
  {
    fault: 'says every transaction carries every message',
    wrap: () => ({ carries: async () => 'this' as const }),
    caught: [
      'says of a transaction whether it is this call, another call, or one the chain has not seen',
    ],
  },
  {
    fault: 'says a transaction it has not seen is another call',
    wrap: (real) => ({
      carries: async (txId, hash) => {
        const answer = await real.carries(txId, hash);
        return answer === 'unseen' ? 'another' : answer;
      },
    }),
    caught: [
      'says of a transaction whether it is this call, another call, or one the chain has not seen',
    ],
  },
  {
    fault: 'says it has not seen a transaction that is another call',
    wrap: (real) => ({
      carries: async (txId, hash) => {
        const answer = await real.carries(txId, hash);
        return answer === 'another' ? 'unseen' : answer;
      },
    }),
    caught: [
      'says of a transaction whether it is this call, another call, or one the chain has not seen',
    ],
  },
  {
    fault: 'never finds an attempt that landed and nobody reported',
    wrap: () => ({ fate: async () => ({ state: 'open' as const }) }),
    caught: [
      'reads the hash it built back from the signed bytes, relays them, and finds them on the chain',
    ],
  },
  {
    fault: 'states no nonce and no gas limit on an EVM transaction',
    wrap: (real) =>
      spoilTx(real, (tx) =>
        tx.evm
          ? { ...tx, evm: { to: tx.evm.to, value: tx.evm.value, chainId: tx.evm.chainId } }
          : tx,
      ),
    caught: ['previews a deposit as cash leaving the wallet for the vault, and nothing else'],
    chains: ['robinhood'],
  },
  {
    fault: 'answers what became of an attempt from its message alone, whatever its nonce',
    wrap: (real) => ({
      fate: async (attempt) => {
        // Any landed transaction of the same call counts, as if the hash named the attempt.
        for (let nonce = 0; nonce < (attempt.nonce ?? 0); nonce += 1) {
          const earlier = await real.fate({ ...attempt, nonce });
          if (earlier.state === 'landed') return earlier;
        }
        return real.fate(attempt);
      },
    }),
    caught: [
      'the same call built again is its own attempt: open, not landed because the first one did',
    ],
    chains: ['robinhood'],
  },
  {
    fault: 'never says an attempt is gone',
    wrap: (real) => ({
      fate: async (attempt) => {
        const answer = await real.fate(attempt);
        return answer.state === 'gone' ? { state: 'open' as const } : answer;
      },
    }),
    caught: ['two calls built on one nonce: one lands, and the other is gone'],
    chains: ['robinhood'],
  },
  {
    fault: 'ignores the nonce a rebuild is given',
    wrap: (real) => ({
      buildSetAutoFollow: ({ vault, on }) => real.buildSetAutoFollow({ vault, on }),
    }),
    caught: ['two calls built on one nonce: one lands, and the other is gone'],
    chains: ['robinhood'],
  },
  {
    fault: 'reads no nonce from signed bytes or from a transaction it has seen',
    wrap: () => ({ nonceOf: async () => null }),
    caught: [
      'reads the hash it built back from the signed bytes, relays them, and finds them on the chain',
    ],
    chains: ['robinhood'],
  },
  {
    fault: 'takes a nonce on a chain that has none',
    wrap: (real) => ({
      buildSetAutoFollow: ({ vault, on }) => real.buildSetAutoFollow({ vault, on }),
      buildDeposit: ({ nonce: _nonce, ...rest }) => real.buildDeposit(rest),
    }),
    caught: ['a nonce on a chain that has none: NotSupported'],
    chains: ['solana'],
  },
  // ---- what the review of FRAME-1b found: five adapters that were wrong on the money path and passed.
  {
    fault: "approves a spender that is not the plan's vault",
    wrap: (real) => ({
      // An approval for a plan nobody has: the cash is approved to an address that is not this plan's
      // vault, which is what approving the factory, or any other spender, comes to.
      buildApprove: (a) =>
        'spender' in a
          ? real.buildApprove(a)
          : real.buildApprove({ owner: a.owner, basketId: '999999', amountRaw: a.amountRaw }),
    }),
    caught: [
      'an approval is for the plan it names: its vault takes that much, and no more',
      'opening a vault stores the targets and the switch it was asked for, and takes its first deposit',
    ],
    chains: ['robinhood'],
  },
  {
    fault: 'opens a vault with other targets than asked, and with auto-follow on',
    wrap: (real) => ({
      buildCreateVault: (a) => {
        const [x, y, ...rest] = a.targets;
        const targets =
          x && y
            ? [{ ...x, weightBps: y.weightBps }, { ...y, weightBps: x.weightBps }, ...rest]
            : a.targets;
        return real.buildCreateVault({
          ...a,
          targets,
          autoFollow: a.recipeOnchainId ? a.autoFollow : true,
        });
      },
    }),
    caught: [
      'opening a vault stores the targets and the switch it was asked for, and takes its first deposit',
    ],
  },
  {
    fault: 'reports a reverted transaction as confirmed',
    wrap: (real) => ({
      track: async (id, until) => {
        const status = await real.track(id, until);
        return status.status === 'reverted'
          ? { status: 'confirmed' as const, explorerUrl: status.explorerUrl }
          : status;
      },
    }),
    caught: [
      "a price that moves past a trade's minimum reverts it, and the transaction is tracked as reverted",
    ],
  },
  {
    fault: 'states a minimum in the preview and puts none in the bytes',
    wrap: (real) => ({
      buildOwnerSwap: async (a) => {
        const stated = await real.buildOwnerSwap(a);
        const loose = await real.buildOwnerSwap({ ...a, slippageBps: 10_000 });
        return { ...loose, preview: { ...loose.preview, minimums: stated.preview.minimums } };
      },
    }),
    caught: [
      "a price that moves past a trade's minimum reverts it, and the transaction is tracked as reverted",
    ],
  },
  {
    fault: 'hashes a transaction by a rule of its own',
    wrap: (real) => {
      // Its own hash, consistent with itself: what it builds and what it reads back from signed bytes
      // agree, so only a check against the family's rule can tell.
      const own = (hash: string) => sha256Hex(`own:${hash}`);
      return {
        ...spoilTx(real, (tx) => ({ ...tx, messageHash: own(tx.messageHash) })),
        messageHashOf: async (signed) => own(await real.messageHashOf(signed)),
      };
    },
    caught: ['previews a deposit as cash leaving the wallet for the vault, and nothing else'],
  },
  {
    fault: 'answers what became of an attempt from its own memory of what it relayed',
    wrap: (real) => {
      const relayed = new Map<string, string>();
      return {
        relay: async (signed) => {
          const sent = await real.relay(signed);
          relayed.set(await real.messageHashOf(signed), sent.txId);
          return sent;
        },
        fate: async (attempt) => {
          const txId = relayed.get(attempt.messageHash);
          return txId ? { state: 'landed' as const, txId } : { state: 'open' as const };
        },
      };
    },
    caught: [
      'says of a transaction whether it is this call, another call, or one the chain has not seen',
    ],
  },
  // ---- and what it asked for beside them.
  {
    fault: "takes one wallet's transaction for the same call by another wallet",
    wrap: (real) => {
      // It matches a transaction on its call and not on its signer: the same approval by two wallets
      // is one message to it.
      const first = new Map<string, string>();
      const twin = new Map<string, string>();
      return {
        buildApprove: async (a) => {
          const tx = await real.buildApprove(a);
          const call = `${a.basketId}:${a.amountRaw}`;
          const seen = first.get(call);
          if (seen === undefined) first.set(call, tx.messageHash);
          else twin.set(tx.messageHash, seen);
          return tx;
        },
        carries: (txId, hash) => real.carries(txId, twin.get(hash) ?? hash),
      };
    },
    caught: ["does not take one wallet's transaction for the same call by another wallet"],
    chains: ['robinhood'],
  },
  {
    fault: 'says no price is ever stale',
    wrap: (real) => ({
      getPrices: async (ids) => (await real.getPrices(ids)).map((p) => ({ ...p, ageSeconds: 0 })),
    }),
    caught: [
      'prices what it is asked for, once each, freshly, and every asset that has a price source',
    ],
  },
  {
    fault: 'never shows a multiplier that is scheduled',
    wrap: (real) => {
      const plain = <H extends { scheduled?: unknown }>({ scheduled: _scheduled, ...h }: H) => h;
      const vault = (v: Awaited<ReturnType<ChainAdapter['getVault']>>) =>
        v ? { ...v, cash: plain(v.cash), positions: v.positions.map(plain) } : v;
      return {
        getVault: async (address) => vault(await real.getVault(address)),
        getVaults: async (owner) => (await real.getVaults(owner)).flatMap((v) => vault(v) ?? []),
        getWalletHoldings: async (owner) => (await real.getWalletHoldings(owner)).map(plain),
      };
    },
    caught: ['shows each holding as raw × multiplier / 10^decimals'],
  },
  {
    fault: 'says every refusal can be tried again',
    wrap: (real) => spoilErrors(real, (e) => new ChainError(e.code, e.message, true)),
    caught: [
      'a vault that does not exist: VaultNotFound',
      'a deposit of more cash than the wallet holds: NotFunded',
    ],
  },
  {
    fault: 'publishes other weights than it was sent',
    wrap: (real) => ({
      buildPublishRecipe: ({ creator, recipe, nonce }) => {
        const [x, y, ...rest] = recipe.components;
        const components =
          x && y
            ? [{ ...x, weightBps: y.weightBps }, { ...y, weightBps: x.weightBps }, ...rest]
            : recipe.components;
        return real.buildPublishRecipe({ creator, recipe: { ...recipe, components }, nonce });
      },
    }),
    caught: ['publishing a version makes it the one that waits, with the weights that were sent'],
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
    fault: 'lets the keeper go any distance past a target',
    wrap: (real, f) => ({
      buildKeeperLeg: (vault, trade) =>
        real.buildKeeperLeg(vault, trade).catch((e) => {
          if (!(e instanceof ChainError) || e.code !== 'PastTarget') throw e;
          return real.buildKeeperLeg(f.vault, f.keeperTrade);
        }),
    }),
    caught: ['the keeper, past a target by more than the band: PastTarget'],
  },
  {
    fault: 'stops the keeper at the target exactly, with no band',
    wrap: (real) => ({
      buildKeeperLeg: async (vault, trade) => {
        const tx = await real.buildKeeperLeg(vault, trade);
        // What the asset is at once the trade is in, against its target: over it is refused.
        const state = await real.getVault(vault);
        const assets = await real.listAssets();
        const prices = await real.getPrices(assets.map((a) => a.id));
        const priceOf = (id: string) => Number(prices.find((p) => p.asset === id)?.usdPerToken);
        const unit = (id: string) => 10 ** (assets.find((a) => a.id === id)?.decimals ?? 0);
        const change = (id: string) =>
          tx.preview.changes
            .filter((x) => x.holder === 'vault' && x.asset === id)
            .reduce((n, x) => n + Number(x.deltaRaw), 0);
        const value = (id: string, raw: string) =>
          ((Number(raw) + change(id)) / unit(id)) * priceOf(id);
        if (!state) return tx;
        const total = [state.cash, ...state.positions].reduce(
          (n, h) => n + value(h.asset, h.raw),
          0,
        );
        const bought = state.positions.find((p) => p.asset === trade.buy);
        if (bought && (value(bought.asset, bought.raw) / total) * 10_000 > bought.targetBps)
          throw new ChainError('PastTarget', 'past the target');
        return tx;
      },
    }),
    caught: ['lets the keeper end inside the band, short of the target or a little past it'],
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
    fault: 'publishes whatever an author sends',
    wrap: (real, f) => ({
      buildPublishRecipe: (a) =>
        real.buildPublishRecipe(a).catch((e) => {
          if (!(e instanceof ChainError) || e.code !== 'CreatorLimit') throw e;
          return real.buildPublishRecipe({ creator: f.owner, recipe: f.publishRecipe });
        }),
    }),
    caught: ['a shared portfolio outside the author limits: CreatorLimit'],
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

async function failures(chain: MockChain, wrap: Wrap): Promise<string[]> {
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

  for (const { fault, wrap, caught, chains } of FAULTS)
    it(`catches an adapter that ${fault}`, async () => {
      for (const chain of chains ?? BOTH)
        expect(await failures(chain, wrap)).toEqual(expect.arrayContaining(caught));
    });

  it('runs the groups it is asked for, and reads no shared portfolio for the ones that need none', async () => {
    expect(CONTRACT_GROUPS).toEqual([
      'reads',
      'shared portfolios',
      'quotes',
      'builds',
      'refusals',
      'signed bytes',
      'state after a transaction lands',
    ]);
    const all = await runContract(() => mockFixture('solana'));
    const reads = await runContract(() => mockFixture('solana'), { groups: ['reads'] });
    expect(reads.length).toBeGreaterThan(8);
    expect(reads.length).toBeLessThan(all.length);
    expect(reads.every((r) => r.passed)).toBe(true);
    expect(all.slice(0, reads.length).map((r) => r.name)).toEqual(reads.map((r) => r.name));
    // Every case is in exactly one group, and the groups together are the whole contract.
    let total = 0;
    for (const group of CONTRACT_GROUPS)
      total += (await runContract(() => mockFixture('solana'), { groups: [group] })).length;
    expect(total).toBe(all.length);
    await expect(
      runContract(() => mockFixture('solana'), { groups: ['read' as 'reads'] }),
    ).rejects.toThrow(/no group called read/);

    // An adapter whose registry is not there yet: the reads and the quotes still run and pass.
    const noRegistry: Wrap = () => ({
      getRecipe: async () => {
        throw new ChainError('NotSupported', 'shared portfolios are not on chain yet');
      },
    });
    for (const groups of [['reads'], ['quotes'], ['reads', 'quotes']] as const) {
      const results = await runContract(
        async () => {
          const f = await mockFixture('robinhood');
          return { ...f, adapter: { ...f.adapter, ...noRegistry(f.adapter, f) } as ChainAdapter };
        },
        { groups: [...groups] },
      );
      expect(results.filter((r) => !r.passed)).toEqual([]);
    }
    // With a group that needs one, the same adapter cannot even start.
    await expect(
      runContract(
        async () => {
          const f = await mockFixture('robinhood');
          return { ...f, adapter: { ...f.adapter, ...noRegistry(f.adapter, f) } as ChainAdapter };
        },
        { groups: ['shared portfolios'] },
      ),
    ).rejects.toThrow(/not on chain yet/);
  });

  it('runs the reads on an adapter that has only its read side', async () => {
    const f = await mockFixture('solana');
    const a = f.adapter;
    // Ten read calls and nothing else: no builder, no relay, and no registry or quote behind them.
    const refuse = async (): Promise<never> => {
      throw new ChainError('NotSupported', 'not on chain yet');
    };
    const reader: ChainReader = {
      chain: a.chain,
      capabilities: { ...a.capabilities, trade: 'readonly' },
      provenance: a.provenance,
      listAssets: a.listAssets,
      getPrices: a.getPrices,
      getVaults: a.getVaults,
      getVault: a.getVault,
      listAutoFollowVaults: a.listAutoFollowVaults,
      getRecipe: refuse,
      getWalletHoldings: a.getWalletHoldings,
      funding: a.funding,
      quote: refuse,
      track: a.track,
    };
    const results = await runContract(
      (): ReadsFixture => ({
        adapter: reader,
        provenance: f.provenance,
        notBefore: f.notBefore,
        owner: f.owner,
        stranger: f.stranger,
        vault: f.vault,
        manualVault: f.manualVault,
        newAssetVault: f.newAssetVault,
        depositRaw: f.depositRaw,
        unknownTxId: f.unknownTxId,
        stalePriced: f.stalePriced,
        scheduledAsset: f.scheduledAsset,
      }),
      { groups: ['reads'] },
    );
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBeGreaterThan(8);
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
          'lists exactly the vaults with auto-follow on',
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
