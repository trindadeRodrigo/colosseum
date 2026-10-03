import type { Address } from '@solana/kit';
import { vaultErrorName } from './accounts';

// What a failed transaction says, in the adapter's words. The status of a signature carries only the
// error; which program raised it is in the transaction's logs.

/**
 * The program that raised the error: the first "failed" line. When a program fails inside a call from
 * another, each caller logs the same failure after it, so the first one is the origin.
 */
function failedProgram(logs: readonly string[]): { program: string; text: string } | null {
  for (const line of logs) {
    const match = line.match(/^Program (\w+) failed: (.+)$/);
    if (match?.[1] && match[2]) return { program: match[1], text: match[2] };
  }
  return null;
}

/** Anchor's own line for an error it raised: its name, number and message. */
function anchorMessage(logs: readonly string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const match = logs[i]?.match(
      /Error Code: (\w+)\. Error Number: \d+\. Error Message: (.+?)\.?$/,
    );
    if (match?.[1] && match[2]) return `${match[1]}: ${match[2]}`;
  }
  return null;
}

/** The custom error code of `{ InstructionError: [index, { Custom: code }] }`, or null. */
function customCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) return null;
  const detail = (err.InstructionError as unknown[])[1];
  if (typeof detail !== 'object' || detail === null || !('Custom' in detail)) return null;
  const code = Number(detail.Custom);
  return Number.isSafeInteger(code) ? code : null;
}

/** The name the runtime gives an error that is not a program's own: 'BlockhashNotFound', 'InvalidAccountData'. */
function runtimeName(err: unknown): string {
  if (typeof err === 'string') return err;
  if (typeof err !== 'object' || err === null) return 'Unknown';
  if ('InstructionError' in err) {
    const detail = (err.InstructionError as unknown[])[1];
    if (typeof detail === 'string') return detail;
    if (typeof detail === 'object' && detail !== null) return Object.keys(detail)[0] ?? 'Unknown';
    return 'InstructionError';
  }
  return Object.keys(err)[0] ?? 'Unknown';
}

/**
 * The code and message of a transaction that reverted. A custom code is named as the vault's own error
 * only when the logs show the vault program raised it: other programs number their errors from 6000
 * too. Without logs the code stays a number.
 */
export function describeFailure(
  err: unknown,
  logs: readonly string[] | null,
  program: Address,
): { code: string; message: string } {
  const code = customCode(err);
  const failed = logs ? failedProgram(logs) : null;
  const said = (logs ? anchorMessage(logs) : null) ?? failed?.text ?? null;
  if (code === null) {
    const name = runtimeName(err);
    return { code: name, message: said ?? `the transaction failed: ${name}` };
  }
  const own = failed?.program === program ? vaultErrorName(code) : null;
  if (own) return { code: own, message: said ?? `the vault refused: ${own}` };
  const by = failed ? `program ${failed.program}` : 'a program';
  return { code: `Custom:${code}`, message: said ? `${by}: ${said}` : `${by} failed with ${code}` };
}
