import type { Context } from '../src/guard/context';
import type { InterfaceTable } from '../src/guard/evm/table';
import { BASKET_PROGRAM } from '../src/guard/generated/basket-program';
import { EVM_INTERFACE } from '../src/guard/generated/evm-interface';
import { type GuardCheck, GuardRefusal } from '../src/guard/refusal';
import type { GuardRules } from '../src/guard/rules';
import type { ProgramTable } from '../src/guard/solana/table';

// The guard's rules with a switch, for the package's tests and nothing else. A test file that takes a
// check out puts this module in place of the real one:
//
//   vi.mock('../rules', () => import('../../../test/rules'));
//
// and runs the guard inside `withRules`. Outside it, these rules are the real ones.

export type TestRules = {
  /** The checks taken out. */
  without?: readonly GuardCheck[];
  program?: ProgramTable;
  evmInterface?: InterfaceTable;
};

let off = new Set<GuardCheck>();
/** How many times the guard has asked these rules for its `need`: none means the swap is not in place. */
let asked = 0;

export const rules: GuardRules = {
  need: (legId) => {
    asked += 1;
    const need: Context['need'] = (check, ok, message) => {
      if (!ok && !off.has(check)) throw new GuardRefusal(check, message, legId);
    };
    return need;
  },
  program: BASKET_PROGRAM,
  evmInterface: EVM_INTERFACE,
};

/** Runs `run` with the guard under `change`, and puts the real rules back after. */
export function withRules<T>(change: TestRules, run: () => T): T {
  const before = asked;
  off = new Set(change.without ?? []);
  rules.program = change.program ?? BASKET_PROGRAM;
  rules.evmInterface = change.evmInterface ?? EVM_INTERFACE;
  let result: T;
  try {
    result = run();
  } finally {
    off = new Set();
    rules.program = BASKET_PROGRAM;
    rules.evmInterface = EVM_INTERFACE;
  }
  // A guard that never asked these rules ran under the real ones, and changed nothing.
  if (asked === before)
    throw new Error('the guard never read these rules: this test file has no vi.mock of them');
  return result;
}
