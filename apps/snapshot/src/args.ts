// The worker's command line, in the keeper's words (apps/keeper/src/main.ts):
//
//   --once                 one pass over every chain, then exit: 1 when a pass failed
//   --loop                 a pass every interval, until stopped
//   --interval <seconds>   the wait between passes with --loop: 600 by default, 60 or more
//   --dry-run              reads and prints, writes nothing
//
// A flag it does not know stops the worker. `--dryrun` read as nothing would write the rows the person
// meant to leave alone.

/** Ten minutes: how often a vault is read (docs/vault/PROMPT-BUILD-PORTFOLIO.md, "Discovery"). */
export const DEFAULT_INTERVAL_S = 600;
/** A pass costs two or three node calls a vault, and the nodes are free ones: not more than once a minute. */
export const MIN_INTERVAL_S = 60;

export type Args = { loop: boolean; dryRun: boolean; intervalS: number };

const FLAGS = ['--once', '--loop', '--interval', '--dry-run'];

export function parseArgs(argv: readonly string[]): Args {
  let intervalS = DEFAULT_INTERVAL_S;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!FLAGS.includes(arg))
      throw new Error(`${arg} is not a flag of the snapshot worker: ${FLAGS.join(', ')}`);
    seen.add(arg);
    if (arg !== '--interval') continue;
    // Digits only: Number('') is 0 and Number('6e2') is 600, and neither is what a person typed.
    const value = argv[++i] ?? '';
    intervalS = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(intervalS) || intervalS < MIN_INTERVAL_S)
      throw new Error(`--interval is whole seconds, ${MIN_INTERVAL_S} or more`);
  }
  if (seen.has('--once') === seen.has('--loop')) throw new Error('say --once or --loop');
  return { loop: seen.has('--loop'), dryRun: seen.has('--dry-run'), intervalS };
}
