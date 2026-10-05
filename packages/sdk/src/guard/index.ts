import { type Guarded, runGuard } from './run';
import type { GuardInput } from './types';

// The guard (DESIGN-VAULT section 9). A wallet made in the app signs with no prompt, so this is the one
// check between a server that is wrong, or compromised, and the person's key. It is given the step the
// person approved and the transaction a server built for it, reads the bytes itself, and refuses
// anything that is not exactly that step. The preview is never believed: it is held to the bytes.
//
// It holds no key, calls no network and reads no clock.

/**
 * Passes a transaction that is exactly the approved step, and throws a `GuardRefusal` naming what was
 * wrong otherwise. Sign only what this returns: `pass.tx` is a frozen copy of the transaction checked.
 */
export function guardTransaction(input: GuardInput): Guarded {
  return runGuard(input);
}

export { approvedSteps } from './approved';
export {
  DEPLOYMENT_FORMAT,
  type DeploymentFile,
  type DeploymentNetwork,
  type DeploymentsRead,
  deploymentsOf,
  type EvmEntry,
  isLoadedDeployment,
  type MockEntry,
  readDeploymentFile,
  type SolanaEntry,
} from './deployment';
export { evmVaultAddress } from './evm/addresses';
export { canonicalFamilyText, type FamilyText, familyTextHash } from './meta';
export {
  GUARD_CHECKS,
  type GuardCheck,
  type GuardCode,
  GuardRefusal,
  isGuardRefusal,
} from './refusal';
export { type Guarded, isGuarded } from './run';
export { vaultAddress as solanaVaultAddress } from './solana/addresses';
export type {
  ApprovedKind,
  ApprovedStep,
  ApprovedTrade,
  EvmDeployment,
  FeeLimit,
  Follow,
  GuardDeployment,
  GuardDeployments,
  GuardInput,
  HeldToken,
  Loaded,
  MockDeployment,
  PlanTerms,
  SolanaDeployment,
  Withdrawal,
} from './types';
