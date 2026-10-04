import type { BasketTx, ConsentKind } from '@colosseum/schemas';
import { type Context, familyOf, isRawAmount, tradesOf } from './context';
import { checkEvm } from './evm/check';
import type { InterfaceTable } from './evm/table';
import { BASKET_PROGRAM } from './generated/basket-program';
import { EVM_INTERFACE } from './generated/evm-interface';
import { checkMock } from './mock/check';
import { type GuardCheck, GuardRefusal } from './refusal';
import { checkSolana } from './solana/check';
import type { ProgramTable } from './solana/table';
import type { ApprovedStep, GuardInput } from './types';

// The guard itself: the step and the transaction go in, and either a pass comes out or a refusal is
// thrown. This file is the part every chain shares; the bytes are read by the chain's own check.

/** A transaction the guard has passed, with the step it was held to. Frozen: nothing can change it after. */
export type Guarded = {
  readonly tx: BasketTx;
  readonly step: ApprovedStep;
};

const PASSED = new WeakSet<object>();

/** True only for what `guardTransaction` returned: a pass cannot be made any other way. */
export const isGuarded = (value: unknown): value is Guarded =>
  typeof value === 'object' && value !== null && PASSED.has(value);

/** For tests only: the checks to leave out, and the tables in place of the generated ones. */
export type GuardOverrides = {
  without?: readonly GuardCheck[];
  program?: ProgramTable;
  evmInterface?: InterfaceTable;
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const NO_SUCH_STEP = 'this guard signs no such step';

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown, least: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= least;
const signedRaw = (v: unknown) => typeof v === 'string' && /^(?:0|-?[1-9]\d{0,77})$/.test(v);

/**
 * An object with exactly these fields and no other. A field the guard does not know is one it has not
 * checked, and what it has not checked is not handed on to a signer.
 */
function only(what: string, value: unknown, fields: readonly string[]): Loose {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  const extra = Object.keys(value).filter((key) => !fields.includes(key));
  if (extra.length)
    throw new Error(`${what} carries ${extra.join(', ')}, which the guard does not read`);
  return value;
}
const must = (ok: boolean, what: string) => {
  if (!ok) throw new Error(what);
};

/**
 * The transaction again, field by field: only what `BasketTx` has, each of the type it is read as. The
 * pass is made of this copy, so nothing reaches a signer that the guard did not look at.
 */
function rebuilt(given: unknown, family: 'solana' | 'evm'): BasketTx {
  const tx = only('the transaction', given, TX_FIELDS);
  for (const field of ['payload', 'chain', 'chainId', 'legKind', 'legId', 'attemptId', 'signer'])
    must(text(tx[field]), `it has no ${field}`);
  must(typeof tx.description === 'string', 'its description is not text');
  must(text(tx.provenance), 'it has no label');
  must(
    typeof tx.messageHash === 'string' && /^[0-9a-f]{64}$/.test(tx.messageHash),
    'its message hash is not 32 bytes of hex',
  );
  must(tx.feePayer === undefined || text(tx.feePayer), 'its fee payer is not text');
  must(
    tx.lastValidBlockHeight === undefined || count(tx.lastValidBlockHeight, 0),
    'its last valid block height is not a number',
  );

  const preview = only('its preview', tx.preview, PREVIEW_FIELDS);
  for (const field of ['source', 'method', 'fetchedAt', 'provenance', 'summary'])
    must(typeof preview[field] === 'string', `its preview has no ${field}`);
  must(typeof preview.simulated === 'boolean', 'its preview does not say whether it was simulated');
  must(isRawAmount(preview.feeNativeRaw), 'its stated fee is not raw units');
  must(
    Array.isArray(preview.changes) && Array.isArray(preview.minimums),
    'its preview states no changes or no minimums',
  );
  const changes = (preview.changes as unknown[]).map((entry) => {
    const c = only('a change in its preview', entry, ['holder', 'asset', 'deltaRaw']);
    must(
      (c.holder === 'wallet' || c.holder === 'vault') && text(c.asset) && signedRaw(c.deltaRaw),
      'a change in its preview cannot be read',
    );
    return { holder: c.holder, asset: c.asset, deltaRaw: c.deltaRaw };
  });
  const minimums = (preview.minimums as unknown[]).map((entry) => {
    const m = only('a minimum in its preview', entry, ['sell', 'buy', 'inRaw', 'minOutRaw']);
    must(
      text(m.sell) && text(m.buy) && isRawAmount(m.inRaw) && isRawAmount(m.minOutRaw),
      'a minimum in its preview cannot be read',
    );
    return { sell: m.sell, buy: m.buy, inRaw: m.inRaw, minOutRaw: m.minOutRaw };
  });

  // An EVM call belongs to an EVM chain and to no other.
  must(
    (tx.evm !== undefined) === (family === 'evm'),
    family === 'evm'
      ? 'an EVM transaction names its target'
      : 'it carries an EVM call on a chain that has none',
  );
  let evm: Loose | undefined;
  if (tx.evm !== undefined) {
    const call = only('its EVM call', tx.evm, ['to', 'value', 'chainId', 'nonce', 'gas']);
    must(
      typeof call.to === 'string' && typeof call.value === 'string',
      'its EVM call has no target',
    );
    must(count(call.chainId, 0), 'its chain id is not a number');
    must(call.gas === undefined || count(call.gas, 1), 'its gas limit is not a number');
    must(call.nonce === undefined || count(call.nonce, 0), 'its nonce is not a number');
    evm = {
      to: call.to,
      value: call.value,
      chainId: call.chainId,
      ...(call.nonce === undefined ? {} : { nonce: call.nonce }),
      ...(call.gas === undefined ? {} : { gas: call.gas }),
    };
  }
  return {
    chain: tx.chain,
    payload: tx.payload,
    ...(evm ? { evm } : {}),
    description: tx.description,
    provenance: tx.provenance,
    ...(tx.lastValidBlockHeight === undefined
      ? {}
      : { lastValidBlockHeight: tx.lastValidBlockHeight }),
    legKind: tx.legKind,
    chainId: tx.chainId,
    signer: tx.signer,
    ...(tx.feePayer === undefined ? {} : { feePayer: tx.feePayer }),
    messageHash: tx.messageHash,
    preview: {
      source: preview.source,
      method: preview.method,
      fetchedAt: preview.fetchedAt,
      provenance: preview.provenance,
      summary: preview.summary,
      simulated: preview.simulated,
      feeNativeRaw: preview.feeNativeRaw,
      changes,
      minimums,
    },
    legId: tx.legId,
    attemptId: tx.attemptId,
  } as BasketTx;
}
const TX_FIELDS = [
  'chain',
  'payload',
  'evm',
  'description',
  'provenance',
  'lastValidBlockHeight',
  'legKind',
  'chainId',
  'signer',
  'feePayer',
  'messageHash',
  'preview',
  'legId',
  'attemptId',
];
const PREVIEW_FIELDS = [
  'source',
  'method',
  'fetchedAt',
  'provenance',
  'summary',
  'simulated',
  'feeNativeRaw',
  'changes',
  'minimums',
];

/** What is wrong with a step before any transaction is looked at, or null. */
function stepProblem(step: ApprovedStep): string | null {
  const onChain = (asset: unknown) =>
    typeof asset === 'string' && asset.startsWith(`${step.chain}:`);
  const targets = (list: { asset: string; weightBps: number }[]) =>
    Array.isArray(list) &&
    list.every((t) => onChain(t.asset) && Number.isInteger(t.weightBps) && t.weightBps > 0);
  if (!text(step.legId) || !text(step.owner)) return 'it names no leg or no owner';
  const address =
    familyOf(step.chain) === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/;
  if (!address.test(step.owner)) return "the owner is not an address of the step's chain";
  if (!/^(?:0|[1-9]\d{0,19})$/.test(step.basketId) || BigInt(step.basketId) >= 1n << 64n)
    return "the plan's number is not a 64-bit number";
  for (const t of tradesOf(step)) {
    if (!onChain(t.sell) || !onChain(t.buy) || t.sell === t.buy)
      return 'a trade is not between two assets of its chain';
    if (!isRawAmount(t.inRaw) || !isRawAmount(t.minOutRaw)) return 'a trade has no amounts';
  }
  switch (step.kind) {
    case 'approve':
      return isRawAmount(step.amountRaw) ? null : 'the approval has no amount';
    case 'create_vault':
      if (!isRawAmount(step.depositRaw)) return 'the deposit is not raw units';
      if (!targets(step.targets)) return 'a target is not an asset of its chain with a weight';
      if (step.follow && step.targets.length)
        return 'a vault that follows takes no targets of its own';
      if (
        step.follow &&
        !(text(step.follow.recipeOnchainId) && Number.isInteger(step.follow.version))
      )
        return 'the shared portfolio followed has no id or no version';
      return typeof step.autoFollow === 'boolean' ? null : 'auto-follow is neither on nor off';
    case 'deposit':
      return isRawAmount(step.amountRaw) ? null : 'the deposit is not raw units';
    case 'swap':
      return step.trades.length ? null : 'a swap makes at least one trade';
    case 'set_targets':
      return targets(step.targets) ? null : 'a target is not an asset of its chain with a weight';
    case 'accept_version':
      return text(step.follow?.recipeOnchainId) && Number.isInteger(step.follow.version)
        ? null
        : 'the shared portfolio accepted has no id or no version';
    case 'set_auto_follow':
      return typeof step.on === 'boolean' ? null : 'auto-follow is neither on nor off';
    case 'withdraw':
      return step.withdrawals === 'all' ||
        (step.withdrawals.length > 0 &&
          step.withdrawals.every(
            (w) => onChain(w.asset) && (w.amountRaw === null || isRawAmount(w.amountRaw)),
          ))
        ? null
        : 'a withdrawal names no asset of its chain';
    default:
      return NO_SUCH_STEP;
  }
}

/** The consent a step needs before it is signed, or null. */
function consentFor(step: ApprovedStep): ConsentKind | null {
  if (step.kind === 'accept_version') return 'new_asset';
  if (step.kind === 'create_vault' && step.autoFollow) return 'auto_follow_on';
  if (step.kind === 'set_auto_follow' && step.on) return 'auto_follow_on';
  return null;
}

export function runGuard(input: GuardInput, overrides: GuardOverrides = {}): Guarded {
  if (typeof input.step !== 'object' || input.step === null)
    throw new GuardRefusal('order', 'no step was given');
  const step = deepFreeze(structuredClone(input.step));
  const { deployment } = input;
  const consents = input.consents ?? [];
  const legId = typeof step.legId === 'string' ? step.legId : null;
  const off = new Set(overrides.without ?? []);
  const need: Context['need'] = (check, ok, message) => {
    if (!ok && !off.has(check)) throw new GuardRefusal(check, message, legId);
  };

  let wrong: string | null;
  try {
    wrong = stepProblem(step);
  } catch {
    wrong = 'it cannot be read';
  }
  if (wrong)
    throw new GuardRefusal(
      wrong === NO_SUCH_STEP ? 'unsupported' : 'order',
      `the step: ${wrong}`,
      legId,
    );
  if (!deployment || deployment.chain !== step.chain)
    throw new GuardRefusal('unsupported', `no deployment was given for ${step.chain}`, legId);
  // The transaction is taken apart and put together again from the fields that are read. That copy is
  // what every check looks at and what the pass carries.
  let tx: BasketTx;
  try {
    tx = deepFreeze(rebuilt(structuredClone(input.tx), familyOf(step.chain)));
  } catch (e) {
    const why = e instanceof Error ? e.message : 'it cannot be read';
    throw new GuardRefusal('malformed', `the transaction: ${why}`, legId);
  }

  // ---- what the transaction says of itself
  need(
    'step',
    tx.legKind === step.kind && tx.legId === step.legId,
    `the transaction is a ${tx.legKind} for leg ${tx.legId}, and the step is a ${step.kind} for leg ${step.legId}`,
  );
  need(
    'chain',
    tx.chainId === step.chain && tx.chain === familyOf(step.chain),
    `the transaction is for ${tx.chainId}, and the step is on ${step.chain}`,
  );
  const label = deployment.family === 'mock' ? 'mock' : deployment.provenance;
  need(
    'network',
    tx.provenance === label,
    `the transaction is labelled ${tx.provenance}, and this network's are ${label}`,
  );
  need(
    'signer',
    tx.signer === step.owner && (tx.feePayer === undefined || tx.feePayer === step.owner),
    'the transaction is signed or paid for by someone other than the person',
  );
  const trades = tradesOf(step);
  need(
    'preview',
    tx.preview.minimums.length === trades.length &&
      tx.preview.minimums.every((m, i) => {
        const t = trades[i];
        return (
          t &&
          m.sell === t.sell &&
          m.buy === t.buy &&
          m.inRaw === t.inRaw &&
          m.minOutRaw === t.minOutRaw
        );
      }),
    "the minimums the transaction states are not the step's",
  );
  const consent = consentFor(step);
  need(
    'consent',
    consent === null || consents.includes(consent),
    `this step needs the person's consent (${consent}), and none was handed over`,
  );

  // ---- what its bytes say
  const ctx: Context = { step, tx, consents, need };
  if (deployment.family === 'mock') checkMock(ctx, deployment);
  else if (deployment.family === 'solana')
    checkSolana(ctx, deployment, overrides.program ?? BASKET_PROGRAM);
  else checkEvm(ctx, deployment, overrides.evmInterface ?? EVM_INTERFACE);

  const passed: Guarded = Object.freeze({ tx, step });
  PASSED.add(passed);
  return passed;
}
