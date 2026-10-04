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

/** The fields of a transaction the guard reads, each of the type it is read as. */
function readable(tx: BasketTx): string | null {
  if (typeof tx !== 'object' || tx === null) return 'it is not an object';
  for (const field of ['payload', 'chain', 'chainId', 'legKind', 'legId', 'signer', 'provenance'])
    if (typeof (tx as Record<string, unknown>)[field] !== 'string') return `it has no ${field}`;
  if (!/^[0-9a-f]{64}$/.test(tx.messageHash)) return 'its message hash is not 32 bytes of hex';
  if (tx.feePayer !== undefined && typeof tx.feePayer !== 'string')
    return 'its fee payer is not text';
  const preview = tx.preview;
  if (typeof preview !== 'object' || preview === null) return 'it has no preview';
  if (!isRawAmount(preview.feeNativeRaw)) return 'its stated fee is not raw units';
  if (
    !Array.isArray(preview.minimums) ||
    !preview.minimums.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        text(m.sell) &&
        text(m.buy) &&
        isRawAmount(m.inRaw) &&
        isRawAmount(m.minOutRaw),
    )
  )
    return 'its preview states no minimums';
  const evm = tx.evm;
  if (evm !== undefined) {
    if (typeof evm !== 'object' || evm === null) return 'its EVM call is not an object';
    if (typeof evm.to !== 'string' || typeof evm.value !== 'string')
      return 'its EVM call has no target';
    if (!Number.isSafeInteger(evm.chainId) || evm.chainId < 0)
      return 'its chain id is not a number';
    if (evm.gas !== undefined && !(Number.isSafeInteger(evm.gas) && evm.gas > 0))
      return 'its gas limit is not a number';
    if (evm.nonce !== undefined && !(Number.isSafeInteger(evm.nonce) && evm.nonce >= 0))
      return 'its nonce is not a number';
  }
  return null;
}

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
  const tx = deepFreeze(structuredClone(input.tx));
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
  const unreadable = readable(tx);
  if (unreadable) throw new GuardRefusal('malformed', `the transaction: ${unreadable}`, legId);

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
