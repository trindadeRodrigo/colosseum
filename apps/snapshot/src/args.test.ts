import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERVAL_S, MIN_INTERVAL_S, parseArgs } from './args';

// The worker's command line: --once or --loop, the interval, the dry run.

describe("the snapshot worker's command line", () => {
  it('takes --once or --loop, and exactly one of them', () => {
    expect(parseArgs(['--once'])).toEqual({ loop: false, dryRun: false, intervalS: 600 });
    expect(parseArgs(['--loop'])).toEqual({ loop: true, dryRun: false, intervalS: 600 });
    expect(() => parseArgs([])).toThrow('say --once or --loop');
    expect(() => parseArgs(['--once', '--loop'])).toThrow('say --once or --loop');
    expect(() => parseArgs(['--dry-run'])).toThrow('say --once or --loop');
  });

  it('reads the interval in seconds: ten minutes by default, never under a minute', () => {
    expect(DEFAULT_INTERVAL_S).toBe(600);
    expect(MIN_INTERVAL_S).toBe(60);
    expect(parseArgs(['--loop', '--interval', '60']).intervalS).toBe(60);
    expect(parseArgs(['--interval', '900', '--loop']).intervalS).toBe(900);
    for (const bad of ['59', '0', '-600', '90.5', '6e2', 'ten', '']) {
      expect(() => parseArgs(['--loop', '--interval', bad]), bad).toThrow(
        '--interval is whole seconds, 60 or more',
      );
    }
    // the number is missing: the next flag is not read as one
    expect(() => parseArgs(['--loop', '--interval'])).toThrow('--interval is whole seconds');
    expect(() => parseArgs(['--interval', '--loop'])).toThrow('--interval is whole seconds');
  });

  it('reads --dry-run, in any place', () => {
    expect(parseArgs(['--dry-run', '--once']).dryRun).toBe(true);
    expect(parseArgs(['--loop', '--interval', '120', '--dry-run'])).toEqual({
      loop: true,
      dryRun: true,
      intervalS: 120,
    });
  });

  it('stops on a flag it does not know, so a mistyped --dry-run never writes', () => {
    expect(() => parseArgs(['--once', '--dryrun'])).toThrow(
      '--dryrun is not a flag of the snapshot worker',
    );
    expect(() => parseArgs(['--once', '--interval=600'])).toThrow('is not a flag');
    expect(() => parseArgs(['once'])).toThrow('once is not a flag of the snapshot worker');
  });
});
