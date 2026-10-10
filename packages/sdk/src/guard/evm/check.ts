import { hexDecode, hexEncode, utf8Encode } from '../../bytes';
import { sha256 } from '../../hash';
import { type Context, isRawAmount, isUnlimited, reading, sameWeights, tradesOf } from '../context';
import { familyTextHash } from '../meta';
import { GuardRefusal } from '../refusal';
import type { ApprovedTrade, EvmDeployment, Withdrawal } from '../types';
import { type AbiValue, decodeArgs, parseSignature } from './abi';
import { evmIndexId, evmVaultAddress, planIdOf } from './addresses';
import { readV4SingleSwap, type V4SingleSwap } from './route';
import type { InterfaceTable } from './table';

// An EVM transaction against the step. It is one call, with no value, to one of four contracts and no
// other: the cash token for an approval, the factory for a create, the registry for a publish, the
// person's own vault for everything else. The vault's address is derived here. The function is the step's, its arguments are
// the step's, and a `multicall` is opened and every call inside it is held to the same rule. A call
// that trades carries a deadline, and it is held to this guard's own clock. The call data each trade
// hands its exchange is read too, and held to the one route the deployment states for that exchange.

/** The most a transaction may state as its fee where the deployment sets no ceiling: 0.001 of the native token. */
export const DEFAULT_EVM_FEE_WEI = 1_000_000_000_000_000n;
/** The most gas a transaction may state where the deployment sets no ceiling. */
export const DEFAULT_EVM_MAX_GAS = 5_000_000;
/** How deep a `multicall` may hold another. */
const MAX_DEPTH = 3;
/**
 * The longest a signed trade stays good: its deadline is in the future and at most this far off. The
 * contracts refuse it after the deadline, so a signature that was never sent cannot land later at
 * whatever the market then gives above its minimum.
 */
export const MAX_EVM_DEADLINE_S = 1_800;
const ZERO32 = `0x${'0'.repeat(64)}`;

const WEIGHTS = '(address,uint16)[]';
const SWAPS = '(address,address,address,uint256,uint256,bytes)[]';
/** The functions this guard was written against, each by interface and exact signature. */
const FN = {
  approve: ['ERC20', 'approve(address,uint256)'],
  createVault: ['VaultFactory', `createVault(bytes32,${WEIGHTS},bytes32,uint32,bool)`],
  createVaultAndBuy: [
    'VaultFactory',
    `createVaultAndBuy(bytes32,${WEIGHTS},bytes32,uint32,bool,uint256,${SWAPS},uint64)`,
  ],
  deposit: ['BasketVault', 'deposit(uint256)'],
  ownerSwap: ['BasketVault', `ownerSwap(${SWAPS},uint64)`],
  withdraw: ['BasketVault', 'withdraw(address,uint256)'],
  withdrawAll: ['BasketVault', 'withdrawAll()'],
  setTargets: ['BasketVault', `setTargets(${WEIGHTS})`],
  acceptVersion: ['BasketVault', 'acceptVersion(bytes32,uint32)'],
  setAutoFollow: ['BasketVault', 'setAutoFollow(bool)'],
  multicall: ['BasketVault', 'multicall(bytes[])'],
  createIndex: ['IndexRegistry', `create(bytes32,${WEIGHTS},bytes32,uint16,uint8)`],
  publishVersion: ['IndexRegistry', `publish(bytes32,${WEIGHTS},bytes32)`],
  cancelPending: ['IndexRegistry', 'cancel(bytes32)'],
} as const;
type FnName = keyof typeof FN;
export const GUARDED_EVM_FUNCTIONS: readonly (readonly [string, string])[] = Object.values(FN);

type Atom =
  | { fn: 'deposit'; amount: bigint }
  | { fn: 'swap'; swap: AbiValue[]; deadline: bigint }
  | { fn: 'withdraw'; token: string; amount: bigint }
  | { fn: 'withdrawAll' }
  | { fn: 'setTargets'; weights: AbiValue[] }
  | { fn: 'acceptVersion'; indexId: string; version: bigint }
  | { fn: 'setAutoFollow'; on: boolean };

const weightsIn = (list: AbiValue[]) =>
  list.map((w) => {
    const [token, bps] = w as [string, bigint];
    return { key: token, bps: Number(bps) };
  });

export function checkEvm(ctx: Context, deployment: EvmDeployment, table: InterfaceTable): void {
  const { step, tx, need } = ctx;
  const { legId, owner } = step;
  const unsupported = (message: string) => new GuardRefusal('unsupported', message, legId);

  const selectorIf = (name: FnName): string | undefined => table[FN[name][0]]?.[FN[name][1]];
  /** The selector of a function this step cannot do without. */
  const selectorOf = (name: FnName): string => {
    const selector = selectorIf(name);
    if (!selector)
      throw unsupported(
        `the committed interface has no ${FN[name].join('.')}: this step cannot be checked until the table is regenerated`,
      );
    return selector;
  };
  const named = (selector: string): string => {
    for (const [face, functions] of Object.entries(table))
      for (const [signature, s] of Object.entries(functions))
        if (s === selector) return `${face}.${signature}`;
    return `a function no interface names (${selector})`;
  };
  const argsOf = (name: FnName, body: Uint8Array): AbiValue[] =>
    reading(`the arguments of ${FN[name][1]}`, legId, () =>
      decodeArgs(parseSignature(FN[name][1]).inputs, body),
    );
  const token = (asset: string): string => {
    const listed = deployment.assets[asset];
    if (!listed) throw unsupported(`the deployment lists no token for ${asset}`);
    return listed.token.toLowerCase();
  };
  const routers = deployment.routers.map((r) => r.toLowerCase());
  const now = Math.floor(Date.now() / 1000);
  const checkDeadline = (deadline: bigint) =>
    need(
      'deadline',
      deadline > BigInt(now) && deadline <= BigInt(now + MAX_EVM_DEADLINE_S),
      `a trade is good until ${deadline}, and it is ${now}: a deadline is ahead of the clock by at most ${MAX_EVM_DEADLINE_S} s`,
    );

  const evm = tx.evm;
  const call = reading('the call', legId, () => {
    if (!evm) throw new Error('an EVM transaction names its target');
    const to = evm.to.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error('the target is not an address');
    if (!isRawAmount(evm.value)) throw new Error('the value is not raw units');
    const data = hexDecode(tx.payload);
    if (data.length < 4) throw new Error('the call data names no function');
    return { to, value: evm.value, chainId: evm.chainId, gas: evm.gas, data };
  });

  need(
    'network',
    call.chainId === deployment.evmChainId,
    `the call is for chain ${call.chainId}, and this deployment is chain ${deployment.evmChainId}`,
  );
  need('value', call.value === '0', `the call sends ${call.value} of the native token`);
  // The rule of the shared types (`evmCallPreimage`): the call alone, without nonce, gas or fees.
  const preimage = `evm:${call.chainId}:${tx.signer.toLowerCase()}:${call.to}:${call.value}:0x${hexEncode(call.data)}`;
  need(
    'hash',
    hexEncode(sha256(utf8Encode(preimage))) === tx.messageHash,
    'the message hash stated is not the hash of the call',
  );
  const maxGas = deployment.fee?.maxGas ?? DEFAULT_EVM_MAX_GAS;
  const maxFee = BigInt(deployment.fee?.maxFeeNativeRaw ?? DEFAULT_EVM_FEE_WEI);
  need(
    'fee',
    (call.gas === undefined || call.gas <= maxGas) && BigInt(tx.preview.feeNativeRaw) <= maxFee,
    `the transaction states ${call.gas ?? 'no'} gas and a fee of ${tx.preview.feeNativeRaw}, above the ${maxGas} gas or the ${maxFee} allowed`,
  );

  const selector = `0x${hexEncode(call.data.slice(0, 4))}`;
  const body = call.data.slice(4);

  if (step.kind === 'publish') {
    // The creator's own shared portfolio of this family, through the deployment's registry: its id is
    // derived from the owner and the family, never named. The text hash is worked out here from the
    // text the creator saw, never a hash handed over.
    const registry = deployment.registry?.toLowerCase();
    if (!registry) throw unsupported('the deployment names no registry: nothing is published here');
    const fn: FnName =
      step.action === 'publish'
        ? 'createIndex'
        : step.action === 'update'
          ? 'publishVersion'
          : 'cancelPending';
    const wanted = selectorOf(fn);
    need(
      'target',
      call.to === registry,
      `a shared portfolio is published through the registry, and this call is to ${call.to}`,
    );
    const right = selector === wanted;
    need('function', right, `the call is ${named(selector)}, and the step is to ${step.action}`);
    if (!right) return;
    const args = argsOf(fn, body);
    const id = reading('the family', legId, () => evmIndexId(owner, step.familyId));
    if (fn === 'cancelPending') {
      need('recipe', args[0] === id, "the bytes cancel another creator's or family's version");
      return;
    }
    const [named32, weights, metaHash, maxFeeBps, flags] = args as [
      string,
      AbiValue[],
      string,
      bigint | undefined,
      bigint | undefined,
    ];
    need(
      'recipe',
      fn === 'createIndex' ? named32 === `0x${step.familyId.toLowerCase()}` : named32 === id,
      'the bytes publish another family, or for another creator',
    );
    need(
      'targets',
      sameWeights(
        step.components.map((t) => ({ key: token(t.asset), bps: t.weightBps })),
        weightsIn(weights),
      ),
      "the assets and weights in the bytes are not the version's",
    );
    // Only the four fields shown, under the step's own family: a family id inside the text is not read.
    const t = step.text;
    const textHash = t
      ? `0x${familyTextHash({ familyId: step.familyId, slug: t.slug, name: t.name, copy: t.copy, kind: t.kind })}`
      : '';
    need('recipe', metaHash === textHash, "the bytes publish another family's text");
    if (fn === 'createIndex') {
      need('limits', maxFeeBps === 0n, `the bytes set a fee cap of ${maxFeeBps}`);
      need('limits', flags === 0n, `the bytes set the flags ${flags}`);
    }
    return;
  }

  const vault = reading('the owner', legId, () =>
    evmVaultAddress(deployment, owner, step.basketId),
  );

  /**
   * The call data a trade hands its exchange, against the trade itself. The vault holds a trade to its
   * minimum whatever the route, so a route through another pool costs the person at most the gap
   * between the quote and the minimum; this takes that away too. The route is exactly what the builder
   * makes (packages/chain-evm/src/vault/routes.ts): `execute` with one `V4_SWAP` of
   * `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`, in the pool of the trade's two tokens at the
   * deployment's fee, tick spacing and hooks, for the trade's amount, under the trade's deadline. The
   * router's own minimums are zero, as built: the vault's `minOut` is the one that binds.
   */
  const checkRoute = (
    router: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    data: Uint8Array,
    deadline: bigint,
  ) => {
    const rule = Object.hasOwn(deployment.routes, router) ? deployment.routes[router] : undefined;
    if (!rule) {
      // An exchange the deployment does not name was refused above as `router`. One it names without
      // saying how its call data is read is refused here: nothing goes unread unsaid.
      need(
        'route',
        !routers.includes(router),
        `the deployment does not say how the call data of ${router} is read`,
      );
      return;
    }
    if (rule.kind === 'unread') {
      need(
        'route',
        deployment.provenance !== 'live',
        `the call data of ${router} is not read, and on a live network every trade's is`,
      );
      return;
    }
    let route: V4SingleSwap;
    try {
      route = readV4SingleSwap(data);
    } catch (e) {
      need(
        'route',
        false,
        `a trade's call data for ${router} is not one exact-input swap in one pool: ${e instanceof Error ? e.message : 'it cannot be read'}`,
      );
      return;
    }
    // Uniswap v4 sorts a pool's two tokens: the lower address is `currency0`.
    const [currency0, currency1] =
      BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
    need(
      'asset',
      route.currency0 === currency0 && route.currency1 === currency1,
      `a trade's route is in the pool of ${route.currency0} and ${route.currency1}, and the trade is ${tokenIn} for ${tokenOut}`,
    );
    need(
      'asset',
      route.settle.currency === tokenIn && route.take.currency === tokenOut,
      `a trade's route pays in ${route.settle.currency} and takes ${route.take.currency}, and the trade is ${tokenIn} for ${tokenOut}`,
    );
    need(
      'route',
      route.fee === BigInt(rule.fee) && route.tickSpacing === BigInt(rule.tickSpacing),
      `a trade's route is in a pool of fee ${route.fee} and tick spacing ${route.tickSpacing}, and the deployment's is ${rule.fee} and ${rule.tickSpacing}`,
    );
    need(
      'route',
      route.hooks === rule.hooks && route.hookData.length === 0,
      `a trade's route is in a pool with the hooks ${route.hooks}, or hands a hook ${route.hookData.length} bytes`,
    );
    need(
      'route',
      route.zeroForOne === (tokenIn === currency0),
      `a trade's route swaps the pool the other way: it sells ${tokenOut}`,
    );
    need(
      'amount',
      route.amountIn === amountIn && route.settle.maxAmount === amountIn,
      `a trade's route sells ${route.amountIn} and pays in up to ${route.settle.maxAmount}, and the trade sells ${amountIn}`,
    );
    need(
      'minimum',
      route.amountOutMinimum === 0n && route.minHopPriceX36 === 0n && route.take.minAmount === 0n,
      `a trade's route sets the exchange's own minimums (${route.amountOutMinimum}, ${route.minHopPriceX36}, ${route.take.minAmount}), and the vault's minimum is the only one a built trade carries`,
    );
    need(
      'deadline',
      route.deadline === deadline,
      `a trade's route is good until ${route.deadline}, and the trade until ${deadline}`,
    );
  };
  const checkSwap = (swap: AbiValue[], trade: ApprovedTrade, deadline: bigint) => {
    const [router, tokenIn, tokenOut, amountIn, minOut, data] = swap as [
      string,
      string,
      string,
      bigint,
      bigint,
      Uint8Array,
    ];
    need('router', routers.includes(router), `a trade goes through ${router}`);
    need(
      'asset',
      tokenIn === token(trade.sell) && tokenOut === token(trade.buy),
      `a trade is ${tokenIn} for ${tokenOut}, and the step's is ${trade.sell} for ${trade.buy}`,
    );
    need(
      'amount',
      amountIn === BigInt(trade.inRaw),
      `a trade sells ${amountIn}, and the step ${trade.inRaw}`,
    );
    need(
      'minimum',
      minOut === BigInt(trade.minOutRaw),
      `a trade accepts ${minOut} at the least, and the step ${trade.minOutRaw}`,
    );
    checkRoute(router, tokenIn, tokenOut, amountIn, data, deadline);
  };
  const checkSwaps = (swaps: AbiValue[][], trades: ApprovedTrade[], deadline: bigint) => {
    need(
      'calls',
      swaps.length === trades.length,
      `the bytes make ${swaps.length} trades, and the step ${trades.length}`,
    );
    swaps.forEach((swap, i) => {
      const trade = trades[i];
      if (trade) checkSwap(swap, trade, deadline);
    });
  };

  if (step.kind === 'approve') {
    need(
      'target',
      call.to === token(deployment.cash),
      `an approval is a call to the cash token, and this one is to ${call.to}`,
    );
    const approves = selector === selectorOf('approve');
    need('function', approves, `the call is ${named(selector)}, and the step is an approval`);
    if (!approves) return;
    const [spender, amount] = argsOf('approve', body) as [string, bigint];
    need(
      'spender',
      spender === vault,
      `the approval is for ${spender}, and the plan's vault is ${vault}`,
    );
    need(
      'amount',
      amount === BigInt(step.amountRaw),
      `the approval is for ${amount}, and the step's is ${step.amountRaw}`,
    );
    need(
      'unlimited',
      !isUnlimited(amount) && !isUnlimited(BigInt(step.amountRaw)),
      'an approval of everything is never signed',
    );
    return;
  }

  if (step.kind === 'create_vault') {
    need(
      'target',
      call.to === deployment.factory.toLowerCase(),
      `a vault is opened by the factory, and this call is to ${call.to}`,
    );
    const buys = selector === selectorOf('createVaultAndBuy');
    const creates = buys || selector === selectorOf('createVault');
    need('function', creates, `the call is ${named(selector)}, and the step opens a vault`);
    if (!creates) return;
    const [salt, targets, indexId, version, autoFollow, cash, swaps, deadline] = argsOf(
      buys ? 'createVaultAndBuy' : 'createVault',
      body,
    ) as [
      string,
      AbiValue[],
      string,
      bigint,
      boolean,
      bigint | undefined,
      AbiValue[][] | undefined,
      bigint | undefined,
    ];
    if (deadline !== undefined) checkDeadline(deadline);
    const follow = step.follow;
    need('vault', salt === planIdOf(step.basketId), 'the vault is opened for another plan number');
    need(
      'targets',
      sameWeights(
        follow ? [] : step.targets.map((t) => ({ key: token(t.asset), bps: t.weightBps })),
        weightsIn(targets),
      ),
      "the targets in the bytes are not the plan's",
    );
    need(
      'version',
      indexId === (follow?.recipeOnchainId.toLowerCase() ?? ZERO32) &&
        version === BigInt(follow?.version ?? 0),
      'the bytes follow another shared portfolio, or another version of it',
    );
    need('auto_follow', autoFollow === step.autoFollow, 'the bytes set auto-follow another way');
    need(
      'amount',
      (cash ?? 0n) === BigInt(step.depositRaw),
      `the bytes deposit ${cash ?? 0n}, and the step ${step.depositRaw}`,
    );
    // Only `createVaultAndBuy` carries trades, and it carries their deadline with them.
    checkSwaps(swaps ?? [], step.trades, deadline ?? 0n);
    return;
  }

  // ---- every other step is a call to the person's own vault
  const needs: Record<typeof step.kind, FnName[]> = {
    deposit: ['deposit', 'ownerSwap'],
    swap: ['ownerSwap'],
    set_targets: ['setTargets'],
    accept_version: ['acceptVersion'],
    set_auto_follow: ['setAutoFollow'],
    withdraw: ['withdraw', 'withdrawAll'],
  };
  needs[step.kind].forEach(selectorOf);
  need('target', call.to === vault, `the call is to ${call.to}, and the plan's vault is ${vault}`);
  const atoms: Atom[] = [];
  const open = (data: Uint8Array, depth: number): void => {
    const inner = `0x${hexEncode(data.slice(0, 4))}`;
    const rest = data.slice(4);
    const is = (name: FnName) => data.length >= 4 && inner === selectorIf(name);
    if (is('multicall')) {
      if (depth >= MAX_DEPTH)
        throw new GuardRefusal('malformed', 'calls nested deeper than this guard opens', legId);
      for (const each of argsOf('multicall', rest)[0] as Uint8Array[]) open(each, depth + 1);
    } else if (is('deposit'))
      atoms.push({ fn: 'deposit', amount: argsOf('deposit', rest)[0] as bigint });
    else if (is('ownerSwap')) {
      const [swaps, deadline] = argsOf('ownerSwap', rest) as [AbiValue[][], bigint];
      checkDeadline(deadline);
      need('calls', swaps.length > 0, 'a swap call that makes no trade');
      for (const swap of swaps) atoms.push({ fn: 'swap', swap, deadline });
    } else if (is('withdraw')) {
      const [asset, amount] = argsOf('withdraw', rest) as [string, bigint];
      atoms.push({ fn: 'withdraw', token: asset, amount });
    } else if (is('withdrawAll')) {
      argsOf('withdrawAll', rest);
      atoms.push({ fn: 'withdrawAll' });
    } else if (is('setTargets'))
      atoms.push({ fn: 'setTargets', weights: argsOf('setTargets', rest)[0] as AbiValue[] });
    else if (is('acceptVersion')) {
      const [indexId, version] = argsOf('acceptVersion', rest) as [string, bigint];
      atoms.push({ fn: 'acceptVersion', indexId, version });
    } else if (is('setAutoFollow'))
      atoms.push({ fn: 'setAutoFollow', on: argsOf('setAutoFollow', rest)[0] as boolean });
    else need('function', false, `${named(inner)} is never signed here`);
  };
  open(call.data, 0);

  const trades = tradesOf(step);
  const withdrawals: Withdrawal[] | 'all' = step.kind === 'withdraw' ? step.withdrawals : [];
  const wanted: Atom['fn'][] =
    step.kind === 'deposit'
      ? ['deposit', ...trades.map(() => 'swap' as const)]
      : step.kind === 'swap'
        ? trades.map(() => 'swap' as const)
        : step.kind === 'set_targets'
          ? ['setTargets']
          : step.kind === 'accept_version'
            ? ['acceptVersion']
            : step.kind === 'set_auto_follow'
              ? ['setAutoFollow']
              : withdrawals === 'all'
                ? ['withdrawAll']
                : withdrawals.map(() => 'withdraw' as const);
  const made = atoms.map((a) => a.fn);
  const everything =
    withdrawals === 'all' && made.length > 0 && made.every((fn) => fn === 'withdraw');
  need(
    'calls',
    everything ||
      (made.length > 0 && made.length === wanted.length && made.every((fn, i) => fn === wanted[i])),
    `the calls are [${made.join(', ')}], and this step is [${wanted.join(', ')}]`,
  );

  const takeable = new Set([
    ...Object.values(deployment.assets).map((a) => a.token.toLowerCase()),
    ...(step.kind === 'withdraw' ? (step.held ?? []) : []).map((h) => h.address.toLowerCase()),
  ]);
  const taken = new Set<string>();
  let next = 0;
  for (const atom of atoms) {
    // A call out of place was refused above. With that check taken out it is passed over.
    if (!everything && wanted[next] !== atom.fn) continue;
    const at = next;
    next += 1;
    switch (atom.fn) {
      case 'deposit':
        if (step.kind === 'deposit')
          need(
            'amount',
            atom.amount === BigInt(step.amountRaw),
            `the bytes deposit ${atom.amount}, and the step ${step.amountRaw}`,
          );
        break;
      case 'swap': {
        const trade = trades[step.kind === 'deposit' ? at - 1 : at];
        if (trade) checkSwap(atom.swap, trade, atom.deadline);
        break;
      }
      case 'withdraw': {
        if (withdrawals === 'all') {
          // Everything the vault holds: the bytes choose among the tokens the deployment lists and
          // those the caller says the vault holds, each once, at any amount. The vault pays only
          // its owner.
          need(
            'asset',
            takeable.has(atom.token) && !taken.has(atom.token),
            `a withdrawal of ${atom.token}, which the deployment does not list and the vault is not known to hold, or which is taken twice`,
          );
          taken.add(atom.token);
          break;
        }
        const w = withdrawals[at];
        if (!w) break;
        need('asset', atom.token === token(w.asset), `the bytes withdraw ${atom.token}`);
        need(
          'amount',
          w.amountRaw === null || atom.amount === BigInt(w.amountRaw),
          `the bytes withdraw ${atom.amount}, and the step ${w.amountRaw}`,
        );
        break;
      }
      case 'withdrawAll':
        break;
      case 'setTargets':
        if (step.kind === 'set_targets')
          need(
            'targets',
            sameWeights(
              step.targets.map((t) => ({ key: token(t.asset), bps: t.weightBps })),
              weightsIn(atom.weights),
            ),
            "the targets in the bytes are not the step's",
          );
        break;
      case 'acceptVersion':
        if (step.kind === 'accept_version')
          need(
            'version',
            atom.indexId === step.follow.recipeOnchainId.toLowerCase() &&
              atom.version === BigInt(step.follow.version),
            'the bytes accept another shared portfolio, or another version of it',
          );
        break;
      case 'setAutoFollow':
        if (step.kind === 'set_auto_follow')
          need('auto_follow', atom.on === step.on, 'the bytes set auto-follow another way');
        break;
    }
  }
}
