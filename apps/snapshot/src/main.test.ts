import type { Db } from '@colosseum/db';
import { ChainError } from '@colosseum/schemas';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { mainnetRefusal, NO_CHAIN } from './chains';
import { holdChains, lastWords, pingFromEnv, type StartDeps, start } from './main';
import type { SnapshotRun } from './run';

// The worker's entry: what stops it at start stops it before the database is opened and before any
// pass; a good start hands the passes what the command line and the environment said; and the ping. No
// database and no node here: every one of them is handed in.

const PING = 'https://hc.example.invalid/ping/PINGKEY';
const DB_URL = 'postgres://worker:DBPASS@db.example.invalid:5432/tenonfi';

function recorder(status = 200, fail = false) {
  const calls: { url: string; method?: string; timed: boolean }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, timed: init?.signal instanceof AbortSignal });
    if (fail) throw new Error(`connect failed to ${url}`);
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

/** Everything `start` would open, as stand-ins that write down what they were asked. */
function deps(over: Partial<StartDeps> = {}) {
  const log: string[] = [];
  const runs: SnapshotRun[] = [];
  const stops: (() => Promise<void>)[] = [];
  const db = { fake: 'db' } as unknown as Db;
  const made: StartDeps = {
    open: () => {
      log.push('open');
      return {
        db,
        client: {
          end: async (options) => {
            log.push(options ? `end within ${options.timeout} s` : 'end');
          },
        },
      };
    },
    holdChains: async (_db, _env, dryRun) => {
      log.push(dryRun ? 'chains checked' : 'chains written');
    },
    run: async (o) => {
      log.push('run');
      runs.push(o);
    },
    onStop: (end) => {
      stops.push(end);
    },
    warn: (line) => {
      log.push(`warn: ${line}`);
    },
    ...over,
  };
  return { deps: made, log, runs, stops, db };
}

const MOCK = { SNAPSHOT_CHAINS: 'solana', CHAIN_MODE_SOLANA: 'mock' };

describe('the snapshot worker at start', () => {
  it('stops on a bad command line before it reads the environment or opens the database', async () => {
    const d = deps({
      sources: async () => {
        d.log.push('sources');
        return [];
      },
    });
    await expect(start([], MOCK, d.deps)).rejects.toThrow('say --once or --loop');
    await expect(start(['--once', '--interval', '5'], MOCK, d.deps)).rejects.toThrow(
      '--interval is whole seconds, 60 or more',
    );
    expect(d.log).toEqual([]);
  });

  it('stops on mainnet, and with no chain to read, before the database is opened or a pass is made', async () => {
    const d = deps();
    await expect(
      start(['--once'], { ...MOCK, CHAIN_NETWORK_SOLANA: 'mainnet' }, d.deps),
    ).rejects.toThrow(mainnetRefusal('CHAIN_NETWORK_SOLANA'));
    await expect(start(['--loop'], {}, d.deps)).rejects.toThrow(NO_CHAIN);
    expect(d.log).toEqual([]);
    expect(d.runs).toEqual([]);
  });

  it('holds the database to the chains, then runs the passes with what was asked, then closes it', async () => {
    const d = deps();
    await start(['--once'], { ...MOCK, DATABASE_URL: DB_URL }, d.deps);
    expect(d.log).toEqual(['open', 'chains written', 'run', 'end']);
    const [run] = d.runs;
    expect(run?.sources.map((s) => [s.chain, s.provenance, s.source])).toEqual([
      ['solana', 'mock', 'chain-mock'],
    ]);
    expect(run?.db).toBe(d.db);
    expect(run?.loop).toBe(false);
    expect(run?.dryRun).toBe(false);
    expect(run?.intervalMs).toBe(600_000);
    // What every reason is said through takes the database's address out.
    expect(run?.hide?.(`could not reach ${DB_URL}`)).toBe('could not reach <DATABASE_URL>');
    expect(typeof run?.ping).toBe('function');
  });

  it('passes the loop, the interval and the dry run on, and a dry run only checks the chain rows', async () => {
    const d = deps();
    await start(['--loop', '--interval', '120', '--dry-run'], MOCK, d.deps);
    expect(d.log).toEqual(['open', 'chains checked', 'run', 'end']);
    expect(d.runs[0]?.loop).toBe(true);
    expect(d.runs[0]?.dryRun).toBe(true);
    expect(d.runs[0]?.intervalMs).toBe(120_000);
  });

  it('fails when a pass failed or the database is another network’s, and still closes the database', async () => {
    const failed = deps({
      run: async () => {
        throw new Error('1 of 1 chains failed their pass');
      },
    });
    await expect(start(['--once'], MOCK, failed.deps)).rejects.toThrow('1 of 1 chains failed');
    expect(failed.log).toEqual(['open', 'chains written', 'end']);
    const other = deps({
      holdChains: async () => {
        throw new Error('chains.solana is local in this database and testnet in the config');
      },
    });
    await expect(start(['--once'], MOCK, other.deps)).rejects.toThrow('chains.solana is local');
    // No pass was made on a database of another network.
    expect(other.log).toEqual(['open', 'end']);
    expect(other.runs).toEqual([]);
  });

  it('hands over what closes the database when the process is told to stop', async () => {
    const d = deps();
    await start(['--once'], MOCK, d.deps);
    expect(d.stops).toHaveLength(1);
    await d.stops[0]?.();
    expect(d.log.at(-1)).toBe('end within 5 s');
  });

  it('pings through the worker’s own settings, and says a failed ping with no address in it', async () => {
    const r = recorder(500);
    const d = deps({ fetch: r.fetch });
    await start(['--once'], { ...MOCK, SNAPSHOT_PING_URL: PING }, d.deps);
    await d.runs[0]?.ping?.(true);
    expect(r.calls.map((c) => c.url)).toEqual([PING]);
    expect(d.log.at(-1)).toBe('warn: the health check answered 500');
  });
});

describe('what the worker says of an error that ends it', () => {
  it('is the message alone, with no address in it, whatever the error carries', () => {
    const node = 'https://solana.example.invalid/?api-key=SOLKEY123';
    const env = { SOLANA_RPC_URL: node, DATABASE_URL: DB_URL };
    const cause = new Error(`HTTP request failed.\n\nURL: ${node}`);
    const error = new Error(`no answer from ${node}, and none from ${DB_URL}`, { cause });
    expect(lastWords(env, error)).toBe(
      'no answer from <SOLANA_RPC_URL>, and none from <DATABASE_URL>',
    );
    expect(lastWords(env, cause)).toBe('HTTP request failed.\n\nURL: <SOLANA_RPC_URL>');
    expect(lastWords(env, new Error('fetch failed\nURL: https://elsewhere.example/k'))).toBe(
      'fetch failed\nURL: <hidden>',
    );
    // What is thrown is not always an error.
    expect(lastWords(env, `refused by ${node}`)).toBe('refused by <SOLANA_RPC_URL>');
    expect(lastWords(env, undefined)).toBe('undefined');
  });

  it('says a database that is down at start by why, never by the query it did not take', () => {
    const env = { DATABASE_URL: DB_URL };
    // What Drizzle throws for the first query of a start, with the reason in its cause.
    const down = new DrizzleQueryError(
      'select "id", "network" from "chains"',
      [],
      Object.assign(new Error(`connect ECONNREFUSED ${DB_URL}`), { code: 'ECONNREFUSED' }),
    );
    expect(down.message).toContain('Failed query: select');
    expect(lastWords(env, down)).toBe('the database did not take a query (ECONNREFUSED)');
    // A cause with no code still says nothing of the query or of what it carried.
    const bare = new DrizzleQueryError('insert into "chains" values ($1)', ['solana']);
    expect(lastWords(env, bare)).toBe('the database did not take a query');
  });

  it('says a refusal of a chain with its code in front of the sentence', () => {
    const refused = new ChainError(
      'NotSupported',
      'the Solana RPC is a mainnet node, and this server runs a test network only',
    );
    expect(lastWords({}, refused)).toBe(
      'NotSupported: the Solana RPC is a mainnet node, and this server runs a test network only',
    );
  });
});

describe('the worker’s health check', () => {
  it('posts to the address after a good pass and to its fail address after a failed one', async () => {
    const r = recorder();
    const ping = pingFromEnv({ SNAPSHOT_PING_URL: ` ${PING}/ ` }, { fetch: r.fetch });
    await ping(true);
    await ping(false);
    expect(r.calls).toEqual([
      { url: `${PING}/`, method: 'POST', timed: true },
      { url: `${PING}/fail`, method: 'POST', timed: true },
    ]);
  });

  it('does nothing with no address set', async () => {
    const r = recorder();
    await pingFromEnv({}, { fetch: r.fetch })(true);
    await pingFromEnv({ SNAPSHOT_PING_URL: '  ' }, { fetch: r.fetch })(false);
    expect(r.calls).toEqual([]);
  });

  it('never throws and never repeats the address when a post fails', async () => {
    const said: string[] = [];
    for (const r of [recorder(500), recorder(200, true)]) {
      const ping = pingFromEnv(
        { SNAPSHOT_PING_URL: PING },
        { fetch: r.fetch, warn: (l) => said.push(l) },
      );
      await expect(ping(true)).resolves.toBeUndefined();
      await expect(ping(false)).resolves.toBeUndefined();
    }
    expect(said).toEqual([
      'the health check answered 500',
      'the health check answered 500',
      'the health check could not be reached',
      'the health check could not be reached',
    ]);
    expect(said.join(' ')).not.toMatch(/PINGKEY|hc\.example/);
  });
});

describe('the database and the chains at start', () => {
  /** A stand-in for the two queries `seedChains` and the dry check make. */
  function fakeDb(rows: { id: string; network: string }[]) {
    const written: unknown[] = [];
    const db = {
      select: () => ({ from: async () => rows }),
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoUpdate: async () => {
            written.push(values);
          },
        }),
      }),
    } as unknown as Db;
    return { db, written };
  }

  it('writes the chain rows before the first pass, and nothing in a dry run', async () => {
    const wet = fakeDb([]);
    await holdChains(wet.db, {}, false);
    expect((wet.written[0] as { id: string; network: string }[]).map((r) => r.id).sort()).toEqual([
      'base',
      'robinhood',
      'solana',
    ]);
    const dry = fakeDb([]);
    await holdChains(dry.db, {}, true);
    expect(dry.written).toEqual([]);
  });

  it('refuses a database whose chain row names another network, dry run or not', async () => {
    for (const dryRun of [false, true]) {
      const local = fakeDb([{ id: 'solana', network: 'local' }]);
      await expect(holdChains(local.db, {}, dryRun), String(dryRun)).rejects.toThrow(
        'chains.solana is local in this database and testnet in the config: one database per network',
      );
      expect(local.written).toEqual([]);
      const same = fakeDb([{ id: 'solana', network: 'testnet' }]);
      await expect(holdChains(same.db, {}, dryRun)).resolves.toBeUndefined();
    }
  });
});
