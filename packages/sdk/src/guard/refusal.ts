// What the guard says when it refuses. Each check has one code, so a refusal names the one thing that
// was wrong, and a test can take one check out and see its vector pass.

/** One check of the guard. `guardTransaction` runs every one that applies to the step. */
export const GUARD_CHECKS = [
  // ---- every chain
  /** The transaction is for another step: its kind or its leg is not the step's. */
  'step',
  /** It is for another chain, or another wallet family. */
  'chain',
  /** It is for another network: its label, or on EVM its chain id, is not this deployment's. */
  'network',
  /** Someone other than the person signs it or pays for it. */
  'signer',
  /** Its `messageHash` is not the hash of its own bytes. */
  'hash',
  /** The minimums its preview states are not the step's. */
  'preview',
  /** The step switches auto-follow on or accepts a version, and no consent was handed over for that. */
  'consent',
  /** The fee its bytes can commit the wallet to is above the ceiling. */
  'fee',
  /** An amount is not the step's: a deposit, an approval, what a trade sells, a withdrawal. */
  'amount',
  /** The least a trade must pay out is not the step's. */
  'minimum',
  /** A token is not the step's asset. */
  'asset',
  /** The vault's targets, or a shared portfolio's assets and weights, are not the step's. */
  'targets',
  /** The auto-follow switch is not as the step has it. */
  'auto_follow',
  /** The shared portfolio followed, or its version, is not the step's. */
  'version',
  /** The shared portfolio published, updated or taken back is not the step's: another creator's or family's, or other text. */
  'recipe',
  /** A shared portfolio published with a fee cap or flags that are not zero. */
  'limits',
  /** The vault is not the person's own for this plan. */
  'vault',
  /** A trade goes through an exchange the deployment does not name. */
  'router',
  // ---- Solana
  /** An instruction of a program the step does not use. */
  'program',
  /** The vault program's instructions are not exactly the step's: another, one more, one fewer. */
  'instruction',
  /** A compute-budget instruction other than the unit limit and the unit price, or one of them twice. */
  'budget',
  /** A token-account instruction that is not "create the person's or their vault's account". */
  'token_account',
  /** The owner an instruction names is not the person. */
  'owner',
  /** A fixed account is not the one the program expects, or an instruction carries accounts it has no use for. */
  'accounts',
  /** The person's own token account, where a deposit comes from or a withdrawal goes to, is someone else's. */
  'recipient',
  // ---- EVM
  /** The call sends native value. */
  'value',
  /** The call's target is not the contract the step calls. */
  'target',
  /** The function is not the step's: unknown, never signed here, or another step's. */
  'function',
  /** The calls inside are not exactly the step's: another, one more, one fewer. */
  'calls',
  /** An approval names someone other than the plan's vault. */
  'spender',
  /** An approval of everything, whatever the order says. */
  'unlimited',
  /** A trade's deadline has passed, or is further off than a signed step may stay good. */
  'deadline',
] as const;
export type GuardCheck = (typeof GUARD_CHECKS)[number];

/**
 * Why a transaction was refused before any check ran its course:
 * - `malformed`: its bytes or its fields cannot be read as a transaction of this chain.
 * - `unsupported`: this guard has no rule for the step, the chain or the interface as committed.
 * - `order`: the order itself does not say enough, or says something no step can mean.
 * - `deployment`: the deployment is not one this package loaded from a deployment file, or the file
 *   cannot be read as one.
 */
export type GuardCode = GuardCheck | 'malformed' | 'unsupported' | 'order' | 'deployment';

/** The guard's refusal. Nothing is signed when one is thrown. */
export class GuardRefusal extends Error {
  readonly code: GuardCode;
  /** The leg the transaction was built for, where the refusal is about one. */
  readonly legId: string | null;
  constructor(code: GuardCode, message: string, legId: string | null = null) {
    super(message);
    this.name = 'GuardRefusal';
    this.code = code;
    this.legId = legId;
  }
}

export const isGuardRefusal = (e: unknown): e is GuardRefusal =>
  e instanceof GuardRefusal ||
  (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'GuardRefusal');
