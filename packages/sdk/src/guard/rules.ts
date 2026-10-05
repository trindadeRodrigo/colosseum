import type { Context } from './context';
import type { InterfaceTable } from './evm/table';
import { BASKET_PROGRAM } from './generated/basket-program';
import { EVM_INTERFACE } from './generated/evm-interface';
import { GuardRefusal } from './refusal';
import type { ProgramTable } from './solana/table';

// What the guard holds every transaction to: each comparison refuses the step when it fails, and the
// bytes are read against the interfaces generated from the committed files. Nothing a caller hands the
// guard changes these. The package's own tests put another module in this one's place (test/rules.ts)
// to take a check out or read against another interface; that module is never built.

export type GuardRules = {
  /** The rule each comparison of a step is held to. */
  need(legId: string | null): Context['need'];
  program: ProgramTable;
  evmInterface: InterfaceTable;
};

export const rules: GuardRules = Object.freeze({
  need:
    (legId: string | null): Context['need'] =>
    (check, ok, message) => {
      if (!ok) throw new GuardRefusal(check, message, legId);
    },
  program: BASKET_PROGRAM,
  evmInterface: EVM_INTERFACE,
});
