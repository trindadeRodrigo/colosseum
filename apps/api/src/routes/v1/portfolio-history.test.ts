import { type Db, vaultSnapshots } from '@colosseum/db';
import {
  type ChainId,
  DISCLAIMER,
  HISTORY_MAX_POINTS,
  HISTORY_STEP_SECONDS,
  HistoryStep,
  OrderError,
  PortfolioHistoryResponse,
} from '@colosseum/schemas';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { lastOfEachStep } from '../../portfolio/history';
import {
  type Person,
  type PersonKind,
  person,
  signIn,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import {
  type SnapshotSeed,
  seedSnapshot,
  seedVault,
  snapshotRowOf,
  vaultAddress,
} from '../../testing/portfolio-world';

// GET /v1/portfolio/history (PORT-2): a person's vaults over time, read from the snapshot worker's
// rows and thinned to one point a step by the query. Through HTTP on the mock chains and the real
// database. The worker is another app, so each test writes the rows a pass would have written, for
// people it makes itself, and reads only theirs: other sessions write to this database at the same
// time.

vi.setConfig({ testTimeout: 60_000 });

/** The app's clock. No test waits on it: a history is read from rows, each with its own time. */
const NOW = new Date('2026-10-05T12:34:56.000Z');
/** A time in October 2026, in UTC. */
const utc = (day: number, hour: number, minute = 0, second = 0, ms = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute, second, ms));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const millisOf = (step: HistoryStep) => HISTORY_STEP_SECONDS[step] * 1000;
const before = (when: Date, ms: number) => new Date(when.getTime() - ms);
/** Every `minutes` from `first` to `last`, both included. */
const every = (first: Date, last: Date, minutes = 10) => {
  const times: Date[] = [];
  for (let t = first.getTime(); t <= last.getTime(); t += minutes * MINUTE) times.push(new Date(t));
  return times;
};
const iso = (when: Date) => when.toISOString();

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('history');
  data = await testDb();
  undo.push(() => data.cleanUp());
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db, now: () => NOW }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));

/** What a request sends. A time may be a `Date`, sent as its ISO instant, or the text itself. */
type Query = {
  from?: Date | string;
  to?: Date | string;
  step?: string;
  chain?: string;
  address?: string;
};

const ask = (who: Pick<Person, 'headers'> | null, query: Query = {}, on: FastifyInstance = app) => {
  const sent = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    sent.set(key, value instanceof Date ? iso(value) : value);
  const search = sent.toString();
  return on.inject({
    method: 'GET',
    url: `/v1/portfolio/history${search ? `?${search}` : ''}`,
    headers: who?.headers ?? {},
  });
};

/**
 * A read that is answered: the answer as the contract says one is, and its text as it was sent, for
 * the tests that look for what must not be anywhere in it.
 */
async function answered(who: Pick<Person, 'headers'>, query: Query = {}, on?: FastifyInstance) {
  const res = await ask(who, query, on);
  expect(res.statusCode, res.body).toBe(200);
  return { answer: PortfolioHistoryResponse.parse(res.json()), body: res.body };
}
const read = async (who: Pick<Person, 'headers'>, query: Query = {}, on?: FastifyInstance) =>
  (await answered(who, query, on)).answer;

/** A read that is refused, with its status and what it said. */
async function refused(who: Pick<Person, 'headers'>, query: Query) {
  const res = await ask(who, query);
  return { status: res.statusCode, ...OrderError.parse(res.json()) };
}

const vaultsOn = (answer: PortfolioHistoryResponse, chain: ChainId) => {
  const entry = answer.chains.find((c) => c.chain === chain);
  if (!entry) throw new Error(`the answer has no entry for ${chain}`);
  return entry.vaults;
};
const seriesOf = (answer: PortfolioHistoryResponse, address: string) => {
  const series = answer.chains.flatMap((c) => c.vaults).find((v) => v.address === address);
  if (!series) throw new Error('the answer does not list that vault');
  return series;
};
/** A series as its times and values, which is what tells one snapshot from another here. */
const marks = (series: { points: { observedAt: string; valueUsd: string }[] }) =>
  series.points.map((p) => [p.observedAt, p.valueUsd]);
const timesOf = (series: { points: { observedAt: string }[] }) =>
  series.points.map((p) => p.observedAt);

/** Writes made-up snapshots, many in one statement. */
async function seedMany(seeds: SnapshotSeed[]) {
  for (let i = 0; i < seeds.length; i += 400)
    await data.db.insert(vaultSnapshots).values(seeds.slice(i, i + 400).map(snapshotRowOf));
}

/**
 * A snapshot of the vault at each of these times. The first is worth `first` dollars and each one a
 * dollar more than the one before, so a point's value says which snapshot it is.
 */
const valued = (
  vault: Pick<SnapshotSeed, 'chain' | 'address' | 'owner'>,
  times: Date[],
  first: number,
): SnapshotSeed[] => times.map((observedAt, i) => ({ ...vault, observedAt, valueUsd: first + i }));

/** A vault of the person's on Solana, with a snapshot at each of these times. */
async function vaultWith(who: Person, times: Date[], first = 1000) {
  const address = vaultAddress('solana');
  await seedMany(valued({ chain: 'solana', address, owner: who.solana }, times, first));
  return address;
}

describe('the points of a vault', () => {
  // Two vaults of one person, read every ten minutes across a midnight in UTC. The first from 21:05
  // on Oct 4 to 02:55 on Oct 5, worth 1000 and a dollar more at each read; the second from 22:07 to
  // 00:57, from 5000.
  const window = { from: utc(4, 21), to: utc(5, 3) };
  const firstTimes = every(utc(4, 21, 5), utc(5, 2, 55));
  const secondTimes = every(utc(4, 22, 7), utc(5, 0, 57));
  let ann: Person;
  let first: string;
  let second: string;

  beforeAll(async () => {
    ann = await someone();
    first = await vaultWith(ann, firstTimes, 1000);
    second = await vaultWith(ann, secondTimes, 5000);
  });

  it('are every snapshot at a step of ten minutes', async () => {
    const answer = await read(ann, { ...window, step: '10m' });
    // The window and the step it used, said back.
    expect([answer.from, answer.to, answer.step]).toEqual([
      '2026-10-04T21:00:00.000Z',
      '2026-10-05T03:00:00.000Z',
      '10m',
    ]);
    expect(answer.chains.map((c) => c.chain)).toEqual(['solana']);
    expect(vaultsOn(answer, 'solana').map((v) => v.address)).toEqual([first, second].sort());
    expect(marks(seriesOf(answer, first))).toEqual(
      firstTimes.map((t, i) => [iso(t), `${1000 + i}.00`]),
    );
    expect(marks(seriesOf(answer, second))).toEqual(
      secondTimes.map((t, i) => [iso(t), `${5000 + i}.00`]),
    );
    expect(firstTimes).toHaveLength(36);
    expect(secondTimes).toHaveLength(18);
  });

  it('are the last snapshot of each hour at a step of an hour', async () => {
    const answer = await read(ann, { ...window, step: '1h' });
    expect(marks(seriesOf(answer, first))).toEqual([
      ['2026-10-04T21:55:00.000Z', '1005.00'],
      ['2026-10-04T22:55:00.000Z', '1011.00'],
      ['2026-10-04T23:55:00.000Z', '1017.00'],
      ['2026-10-05T00:55:00.000Z', '1023.00'],
      ['2026-10-05T01:55:00.000Z', '1029.00'],
      ['2026-10-05T02:55:00.000Z', '1035.00'],
    ]);
    expect(marks(seriesOf(answer, second))).toEqual([
      ['2026-10-04T22:57:00.000Z', '5005.00'],
      ['2026-10-04T23:57:00.000Z', '5011.00'],
      ['2026-10-05T00:57:00.000Z', '5017.00'],
    ]);
  });

  it('are the last snapshot of each day at a step of a day', async () => {
    const answer = await read(ann, { ...window, step: '1d' });
    expect(answer.step).toBe('1d');
    expect(marks(seriesOf(answer, first))).toEqual([
      ['2026-10-04T23:55:00.000Z', '1017.00'],
      ['2026-10-05T02:55:00.000Z', '1035.00'],
    ]);
    expect(marks(seriesOf(answer, second))).toEqual([
      ['2026-10-04T23:57:00.000Z', '5011.00'],
      ['2026-10-05T00:57:00.000Z', '5017.00'],
    ]);
  });

  it('take the hour when no step is asked', async () => {
    const answer = await read(ann, window);
    expect(answer.step).toBe('1h');
    expect(seriesOf(answer, first).points).toHaveLength(6);
  });

  it('sit in steps counted on UTC boundaries, whatever the window starts at', async () => {
    // From 21:30: the hours are still the clock's, so the first point is the last read before 22:00
    // and not the last of an hour that starts at the window's own start, which would be 22:25.
    const hours = await read(ann, { from: utc(4, 21, 30), to: utc(5, 2, 20), step: '1h' });
    expect(marks(seriesOf(hours, first))).toEqual([
      ['2026-10-04T21:55:00.000Z', '1005.00'],
      ['2026-10-04T22:55:00.000Z', '1011.00'],
      ['2026-10-04T23:55:00.000Z', '1017.00'],
      ['2026-10-05T00:55:00.000Z', '1023.00'],
      ['2026-10-05T01:55:00.000Z', '1029.00'],
      // The hour the window ends in: its last read inside the window.
      ['2026-10-05T02:15:00.000Z', '1031.00'],
    ]);
    // From noon to noon is one day long and holds two days of the calendar: a point each, where a
    // day counted from the window's start would have one.
    const days = await read(ann, { from: utc(4, 12), to: utc(5, 12), step: '1d' });
    expect(marks(seriesOf(days, first))).toEqual([
      ['2026-10-04T23:55:00.000Z', '1017.00'],
      ['2026-10-05T02:55:00.000Z', '1035.00'],
    ]);
    // Four reads in two ten-minute steps of the clock, 21:10 and 21:20, asked from 21:05: two points,
    // where steps counted from 21:05 would hold three.
    const cy = await someone();
    const quick = vaultAddress('solana');
    await seedMany(
      valued(
        { chain: 'solana', address: quick, owner: cy.solana },
        [utc(4, 21, 12), utc(4, 21, 18), utc(4, 21, 22), utc(4, 21, 28)],
        700,
      ),
    );
    const tens = await read(cy, { from: utc(4, 21, 5), to: utc(4, 21, 35), step: '10m' });
    expect(marks(seriesOf(tens, quick))).toEqual([
      ['2026-10-04T21:18:00.000Z', '701.00'],
      ['2026-10-04T21:28:00.000Z', '703.00'],
    ]);
  });

  it('leave out a vault with no snapshot in the window, and answer empty lists for a window with none', async () => {
    // The second vault was first read at 22:07.
    const early = await read(ann, { from: utc(4, 21), to: utc(4, 22), step: '10m' });
    expect(vaultsOn(early, 'solana').map((v) => v.address)).toEqual([first]);
    expect(seriesOf(early, first).points).toHaveLength(6);
    // A week before either was read: the chain is there, with nothing under it.
    const none = await read(ann, { from: utc(1, 0), to: utc(2, 0), step: '10m' });
    expect(none).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      step: '10m',
      chains: [{ chain: 'solana', name: 'Solana', provenance: 'mock', vaults: [] }],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    });
  });

  it('are read with the columns a point is made of, and not the prices', async () => {
    const rows = await lastOfEachStep(
      data.db,
      { entry: registry.get('solana'), owners: [ann.solana] },
      { ...window, step: '1d', address: first },
    );
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual([
        'address',
        'cash',
        'lossUsedBps',
        'method',
        'observedAt',
        'positions',
        'source',
        'valueUsd',
      ]);
  });

  it('count the days in UTC, whatever time zone the database’s session keeps', async () => {
    // Midnight in São Paulo is 03:00 in UTC. Days counted there would hold every read of the first
    // vault, 21:05 to 02:55, in one.
    const rows = await data.db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'America/Sao_Paulo'`);
      return lastOfEachStep(
        tx as unknown as Db,
        { entry: registry.get('solana'), owners: [ann.solana] },
        { ...window, step: '1d', address: first },
      );
    });
    expect(rows.map((row) => [iso(row.observedAt), row.valueUsd])).toEqual([
      ['2026-10-04T23:55:00.000Z', '1017.00'],
      ['2026-10-05T02:55:00.000Z', '1035.00'],
    ]);
  });
});

describe('the window of a history', () => {
  it('includes both of its ends', async () => {
    const ann = await someone();
    const from = utc(5, 10);
    const to = utc(5, 11);
    const vault = await vaultWith(
      ann,
      [before(from, 1), from, utc(5, 10, 30), to, new Date(to.getTime() + 1)],
      100,
    );
    const answer = await read(ann, { from, to, step: '10m' });
    // The read a millisecond before the window and the one a millisecond after it are not in it. The
    // second of those shares the step of the window's end, and is newer: it is still not the point.
    expect(marks(seriesOf(answer, vault))).toEqual([
      ['2026-10-05T10:00:00.000Z', '101.00'],
      ['2026-10-05T10:30:00.000Z', '102.00'],
      ['2026-10-05T11:00:00.000Z', '103.00'],
    ]);
    expect([answer.from, answer.to]).toEqual([iso(from), iso(to)]);
  });

  it('is the last thousand steps, and ninety days at the most, when the request names none', async () => {
    const dee = await someone();
    const ago = (ms: number) => before(NOW, ms);
    const at = {
      ninetyOneDays: ago(91 * DAY),
      eightyNineDays: ago(89 * DAY),
      overAThousandHours: ago(1001 * HOUR),
      underAThousandHours: ago(999 * HOUR),
      overAThousandTens: ago(1001 * 10 * MINUTE),
      underAThousandTens: ago(999 * 10 * MINUTE),
      halfAnHour: ago(30 * MINUTE),
      // After the clock's now: never in a window that ends now.
      ahead: new Date(NOW.getTime() + 30 * MINUTE),
    };
    const vault = await vaultWith(dee, Object.values(at));

    // No step either: the hour.
    const plain = await read(dee);
    expect([plain.from, plain.to, plain.step]).toEqual([
      iso(ago(HISTORY_MAX_POINTS * HOUR)),
      iso(NOW),
      '1h',
    ]);
    expect(timesOf(seriesOf(plain, vault))).toEqual(
      [at.underAThousandHours, at.overAThousandTens, at.underAThousandTens, at.halfAnHour].map(iso),
    );

    const tens = await read(dee, { step: '10m' });
    expect([tens.from, tens.to]).toEqual([iso(ago(HISTORY_MAX_POINTS * 10 * MINUTE)), iso(NOW)]);
    expect(timesOf(seriesOf(tens, vault))).toEqual([at.underAThousandTens, at.halfAnHour].map(iso));

    // A thousand days would be the thousand steps: ninety is the most.
    const days = await read(dee, { step: '1d' });
    expect([days.from, days.to]).toEqual([iso(ago(90 * DAY)), iso(NOW)]);
    // One point a day: the two reads of Aug 24 are one, and so are the two of Sep 28.
    expect(timesOf(seriesOf(days, vault))).toEqual(
      [at.eightyNineDays, at.underAThousandHours, at.underAThousandTens, at.halfAnHour].map(iso),
    );

    // Only `to`: the window ends there and starts a thousand steps before it.
    const until = await read(dee, { to: ago(DAY), step: '1h' });
    expect([until.from, until.to]).toEqual([
      iso(ago(DAY + HISTORY_MAX_POINTS * HOUR)),
      iso(ago(DAY)),
    ]);
    // Only `from`: the window ends now.
    const since = await read(dee, { from: ago(2 * HOUR), step: '10m' });
    expect([since.from, since.to]).toEqual([iso(ago(2 * HOUR)), iso(NOW)]);
    expect(timesOf(seriesOf(since, vault))).toEqual([iso(at.halfAnHour)]);
  });

  it('is refused past a thousand steps, and answered at exactly a thousand', async () => {
    const ann = await someone();
    const to = utc(5, 12);
    const fixes: Record<HistoryStep, string> = {
      '10m': 'Ask a shorter window, or a longer step: this one is answered at `1h` or `1d`.',
      '1h': 'Ask a shorter window, or a longer step: this one is answered at `1d`.',
      '1d': 'Ask a shorter window: no step answers one this long.',
    };
    for (const step of HistoryStep.options) {
      const cap = before(to, HISTORY_MAX_POINTS * millisOf(step));
      const atCap = await read(ann, { from: cap, to, step });
      expect([step, atCap.from, atCap.to]).toEqual([step, iso(cap), iso(to)]);
      // One millisecond more.
      expect([step, await refused(ann, { from: before(cap, 1), to, step })]).toEqual([
        step,
        {
          status: 400,
          error: `this window asks for 1001 steps of ${step}, and one read answers 1000 at most`,
          fix: fixes[step],
        },
      ]);
    }
    // Sixty days by the hour.
    expect(await refused(ann, { from: before(to, 60 * DAY), to, step: '1h' })).toEqual({
      status: 400,
      error: 'this window asks for 1440 steps of 1h, and one read answers 1000 at most',
      fix: 'Ask a shorter window, or a longer step: this one is answered at `1d`.',
    });
    // Named `from` alone, the window runs to now: it is held to the same thousand steps.
    expect((await refused(ann, { from: before(NOW, 1001 * HOUR) })).error).toBe(
      'this window asks for 1001 steps of 1h, and one read answers 1000 at most',
    );
  });

  it('answers a window at the cap whole, and every vault in it: nothing is cut', async () => {
    const max = await someone();
    // A read every ten minutes for exactly a thousand steps, both ends included, and a second vault
    // read three hundred times inside them: more points between the two than one vault may have.
    const from = utc(1, 0, 3);
    const to = new Date(from.getTime() + HISTORY_MAX_POINTS * 10 * MINUTE);
    const long = await vaultWith(max, every(from, to), 1);
    const short = await vaultWith(max, every(utc(2, 0, 4), utc(4, 1, 54)), 1);
    const answer = await read(max, { from, to, step: '10m' });
    const whole = seriesOf(answer, long);
    expect(whole.points).toHaveLength(HISTORY_MAX_POINTS + 1);
    expect([whole.points[0]?.observedAt, whole.points.at(-1)?.observedAt]).toEqual([
      iso(from),
      iso(to),
    ]);
    expect(seriesOf(answer, short).points).toHaveLength(300);
  });

  it('is refused when it does not run forward', async () => {
    const ann = await someone();
    expect(await refused(ann, { from: utc(5, 11), to: utc(5, 10) })).toEqual({
      status: 400,
      error: '`from` (2026-10-05T11:00:00.000Z) is not before `to` (2026-10-05T10:00:00.000Z)',
      fix: 'Ask a `from` that is earlier than `to`. Left out, `to` is now.',
    });
    // A window of no length is none.
    expect((await refused(ann, { from: utc(5, 10), to: utc(5, 10) })).status).toBe(400);
    // `from` alone, after the clock's now.
    expect(await refused(ann, { from: new Date(NOW.getTime() + 1) })).toMatchObject({
      status: 400,
      error: '`from` (2026-10-05T12:34:56.001Z) is not before `to` (2026-10-05T12:34:56.000Z)',
    });
  });

  it('is refused before the year 1, which the database keeps no time for', async () => {
    const ann = await someone();
    const said = {
      status: 400,
      error: 'this window starts before the year 1, and no time is kept before it',
      fix: 'Ask a window that starts later.',
    };
    expect(
      await refused(ann, { from: '0000-06-01T00:00:00Z', to: '0000-06-02T00:00:00Z' }),
    ).toEqual(said);
    // The same when the start is worked out: a thousand hours before the tenth day of the year 1.
    expect(await refused(ann, { to: '0001-01-10T00:00:00Z' })).toEqual(said);
    // The year 1 itself is a window like any other, with nothing in it.
    const first = await read(ann, { from: '0001-01-01T00:00:00Z', to: '0001-01-02T00:00:00Z' });
    expect(first.chains.flatMap((c) => c.vaults)).toEqual([]);
  });

  it('refuses a step that is not one of the three and a time that is not an ISO instant', async () => {
    const ann = await someone();
    const bad: [Query, string][] = [
      [{ step: '5m' }, 'step'],
      [{ step: '1H' }, 'step'],
      [{ step: '' }, 'step'],
      [{ from: 'yesterday' }, 'from'],
      [{ from: '2026-10-05' }, 'from'],
      [{ from: '2026-10-05T10:00:00' }, 'from'],
      [{ from: '2026-10-05T10:00:00+00:00' }, 'from'],
      [{ from: '2026-02-30T00:00:00Z' }, 'from'],
      [{ from: '1759665600' }, 'from'],
      [{ to: 'now' }, 'to'],
      [{ to: '2026-10-05 10:00:00Z' }, 'to'],
      [{ to: '' }, 'to'],
      [{ chain: 'ethereum' }, 'chain'],
    ];
    for (const [query, field] of bad) {
      const said = await refused(ann, query);
      expect([query, said.status]).toEqual([query, 400]);
      expect(said.error).toContain(`querystring/${field}`);
    }
  });
});

describe('whose history is answered', () => {
  const window = { from: utc(5, 9), to: utc(5, 12), step: '10m' };
  const times = [utc(5, 10, 5), utc(5, 10, 15)];

  it('is the person’s own: another person reads none of it, by any query', async () => {
    const ann = await someone();
    const bob = await someone();
    const hers = await vaultWith(ann, times, 1000);
    const his = await vaultWith(bob, times, 2000);
    await seedVault(data.db, { chain: 'solana', owner: ann.solana, address: hers, name: 'Hers' });

    expect(vaultsOn(await read(ann, window), 'solana').map((v) => v.address)).toEqual([hers]);
    // Bob, asking for everything, for the chain, and for his own vault, gets his own.
    for (const query of [{}, { chain: 'solana' }, { address: his }]) {
      const answer = await read(bob, { ...window, ...query });
      expect(vaultsOn(answer, 'solana').map((v) => v.address)).toEqual([his]);
      expect(marks(seriesOf(answer, his))).toEqual(times.map((t, i) => [iso(t), `${2000 + i}.00`]));
    }
    // Asking for hers by its address narrows his answer to nothing. It is the answer an address
    // that names no vault at all gets, word for word: nothing says that hers exists.
    const asked = await answered(bob, { ...window, address: hers });
    const unknown = await answered(bob, { ...window, address: vaultAddress('solana') });
    expect(asked.body).toBe(unknown.body);
    expect(asked.answer.chains).toEqual([
      { chain: 'solana', name: 'Solana', provenance: 'mock', vaults: [] },
    ]);
    for (const query of [
      {},
      { chain: 'solana' },
      { address: hers },
      { step: '1h' },
      { step: '1d' },
    ]) {
      const { body } = await answered(bob, { ...window, ...query });
      expect(body).not.toContain(hers);
      expect(body).not.toContain('Hers');
      expect(body).not.toContain('"1000.00"');
    }
  });

  it('is empty, and no error, for a person who signed in with no wallet', async () => {
    const nobody = { headers: await signIn(issuer, 'did:privy:test-history-no-wallet', []) };
    expect(await read(nobody, window)).toEqual({
      from: '2026-10-05T09:00:00.000Z',
      to: '2026-10-05T12:00:00.000Z',
      step: '10m',
      chains: [],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    });
  });

  it('is nobody’s without a sign-in', async () => {
    const ann = await someone();
    const hers = await vaultWith(ann, times);
    for (const query of [window, { ...window, address: hers }, {}, { step: 'never' }]) {
      const res = await ask(null, query);
      expect([query, res.statusCode]).toEqual([query, 401]);
      expect(res.body).not.toContain(hers);
    }
  });

  it('narrows to one vault by its address and to one chain by its id', async () => {
    const pat = await someone('passkey');
    const one = await vaultWith(pat, times, 100);
    const two = await vaultWith(pat, times, 200);
    const other = vaultAddress('robinhood');
    await seedMany(valued({ chain: 'robinhood', address: other, owner: pat.evm }, times, 300));

    // Wallets of both families: both chains, in the server's order, each with its own vaults.
    const all = await read(pat, window);
    expect(all.chains.map((c) => [c.chain, c.name, c.provenance])).toEqual([
      ['solana', 'Solana', 'mock'],
      ['robinhood', 'Robinhood Chain', 'mock'],
    ]);
    expect(vaultsOn(all, 'solana').map((v) => v.address)).toEqual([one, two].sort());
    expect(vaultsOn(all, 'robinhood').map((v) => v.address)).toEqual([other]);
    expect(marks(seriesOf(all, other))).toEqual(times.map((t, i) => [iso(t), `${300 + i}.00`]));

    // One vault: the other vault of the same chain is gone, and the other chain holds nothing.
    const single = await read(pat, { ...window, address: two });
    expect(single.chains.map((c) => [c.chain, c.vaults.map((v) => v.address)])).toEqual([
      ['solana', [two]],
      ['robinhood', []],
    ]);
    expect(marks(seriesOf(single, two))).toEqual(times.map((t, i) => [iso(t), `${200 + i}.00`]));

    // One chain: the other has no entry at all.
    const evm = await read(pat, { ...window, chain: 'robinhood' });
    expect(evm.chains.map((c) => [c.chain, c.vaults.map((v) => v.address)])).toEqual([
      ['robinhood', [other]],
    ]);
    // A chain the person holds no wallet for narrows the answer to nothing.
    expect((await read(pat, { ...window, chain: 'base' })).chains).toEqual([]);
    // A vault named on the chain it is not on is no vault there.
    const crossed = await read(pat, { ...window, chain: 'robinhood', address: two });
    expect(crossed.chains.map((c) => [c.chain, c.vaults])).toEqual([['robinhood', []]]);
  });

  it('keeps a chain’s entry to that chain, for a wallet that is the same on another', async () => {
    // An EVM wallet has one address on every EVM chain. A person is not read on Base yet, and a row
    // of their wallet's there is not Robinhood Chain's: it is under neither chain's entry.
    const pat = await someone('passkey');
    const here = vaultAddress('robinhood');
    const onBase = vaultAddress('base');
    await seedMany([
      ...valued({ chain: 'robinhood', address: here, owner: pat.evm }, times, 100),
      ...valued({ chain: 'base', address: onBase, owner: pat.evm }, times, 500),
    ]);
    for (const query of [{}, { chain: 'robinhood' }, { address: onBase }, { step: '1d' }]) {
      const { body } = await answered(pat, { ...window, ...query });
      expect(body).not.toContain(onBase);
      expect(body).not.toContain('"500.00"');
    }
    const answer = await read(pat, window);
    expect(answer.chains.map((c) => [c.chain, c.vaults.map((v) => v.address)])).toEqual([
      ['solana', []],
      ['robinhood', [here]],
    ]);
  });

  it('reads the vaults of every wallet the person holds on a chain', async () => {
    const ann = await someone();
    const again = await someone();
    const one = await vaultWith(ann, times, 100);
    const two = await vaultWith(again, times, 200);
    // One sign-in whose identity token lists both Solana wallets.
    const both = {
      headers: await signIn(issuer, ann.sub, [
        { family: 'solana', address: ann.solana, client: 'phantom' },
        { family: 'solana', address: again.solana, client: 'privy' },
      ]),
    };
    expect(vaultsOn(await read(both, window), 'solana').map((v) => v.address)).toEqual(
      [one, two].sort(),
    );
    expect(vaultsOn(await read(ann, window), 'solana').map((v) => v.address)).toEqual([one]);
  });

  it('says a chain of the person’s that is switched off, and never shows it as empty', async () => {
    const pat = await someone('passkey');
    const here = await vaultWith(pat, times);
    const there = vaultAddress('robinhood');
    await seedMany(valued({ chain: 'robinhood', address: there, owner: pat.evm }, times, 300));
    const off = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now: () => NOW,
      env: { CHAIN_MODE_ROBINHOOD: 'off' },
    });
    const answer = await read(pat, window, off.app);
    expect(answer.chains.map((c) => [c.chain, c.vaults.map((v) => v.address)])).toEqual([
      ['solana', [here]],
    ]);
    expect(answer.unavailable).toEqual([
      {
        chain: 'robinhood',
        name: 'Robinhood Chain',
        code: 'CHAIN_UNAVAILABLE',
        error: 'Robinhood Chain is switched off on this server',
        retryable: false,
      },
    ]);
    // Asked for by name, the chain that is off is still said, and the other is not read.
    const named = await read(pat, { ...window, chain: 'robinhood' }, off.app);
    expect([named.chains, named.unavailable.map((u) => u.chain)]).toEqual([[], ['robinhood']]);
    expect((await answered(pat, { ...window, address: there }, off.app)).body).not.toContain(there);
    await off.app.close();
    // On a server that runs both, nothing is unavailable.
    expect((await read(pat, window)).unavailable).toEqual([]);
  });

  it('never answers a row read under another label as this server’s', async () => {
    const ann = await someone();
    const vault = await vaultWith(ann, times, 1000);
    // The same wallet's vault as a test network's worker read it: a newer row of the same hour, and
    // a vault that has no other rows.
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: vault,
      owner: ann.solana,
      observedAt: utc(5, 10, 25),
      valueUsd: 9999,
      provenance: 'sandbox',
    });
    const elsewhere = vaultAddress('solana');
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: elsewhere,
      owner: ann.solana,
      observedAt: utc(5, 10, 5),
      valueUsd: 8888,
      provenance: 'sandbox',
    });
    for (const step of HistoryStep.options) {
      const { answer, body } = await answered(ann, { ...window, step });
      expect(answer.chains.map((c) => [c.provenance, c.vaults.map((v) => v.address)])).toEqual([
        ['mock', [vault]],
      ]);
      expect(body).not.toContain('9999.00');
      expect(body).not.toContain('8888.00');
    }
    // The hour's point is the last read under this server's label, not the newer one.
    expect(marks(seriesOf(await read(ann, { ...window, step: '1h' }), vault))).toEqual([
      ['2026-10-05T10:15:00.000Z', '1001.00'],
    ]);

    // A server that runs the chain on a test network answers the rows read there, under that label,
    // and none of the mock's.
    const relabel = <T extends ReturnType<ChainRegistry['get']>>(entry: T): T => ({
      ...entry,
      provenance: 'sandbox',
    });
    const testnet = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now: () => NOW,
      wrap: (inner) => ({
        ...inner,
        get: (chain) => relabel(inner.get(chain)),
        active: () => inner.active().map(relabel),
      }),
    });
    const { answer: there, body } = await answered(ann, window, testnet.app);
    expect(there.chains.map((c) => [c.provenance, c.vaults.map((v) => v.address)])).toEqual([
      ['sandbox', [elsewhere, vault].sort()],
    ]);
    expect(marks(seriesOf(there, vault))).toEqual([['2026-10-05T10:25:00.000Z', '9999.00']]);
    expect(marks(seriesOf(there, elsewhere))).toEqual([['2026-10-05T10:05:00.000Z', '8888.00']]);
    expect(body).not.toContain('"1000.00"');
    expect(body).not.toContain('"1001.00"');
    await testnet.app.close();
  });

  it('answers nothing, and no error, for an address that is not one of the chain’s', async () => {
    const pat = await someone('passkey');
    await vaultWith(pat, times);
    for (const address of [
      '\u0000',
      'not an address',
      '0x',
      pat.solana.slice(0, 20),
      '%',
      "' or 1=1 --",
    ]) {
      const answer = await read(pat, { ...window, address });
      expect([address, answer.chains.map((c) => [c.chain, c.vaults])]).toEqual([
        address,
        [
          ['solana', []],
          ['robinhood', []],
        ],
      ]);
    }
  });

  it('takes an EVM address in any case, as the rest of the API takes one', async () => {
    const pat = await someone('passkey');
    const address = vaultAddress('robinhood');
    await seedMany(valued({ chain: 'robinhood', address, owner: pat.evm }, times, 2000));
    const upper = `0x${address.slice(2).toUpperCase()}`;
    expect(upper).not.toBe(address);
    for (const asked of [address, upper, ` ${upper} `]) {
      const answer = await read(pat, { ...window, address: asked });
      expect(vaultsOn(answer, 'robinhood').map((v) => v.address)).toEqual([address]);
      expect(vaultsOn(answer, 'solana')).toEqual([]);
    }
    // A Solana address is its own case: another case is another address, and names no vault.
    const solana = await vaultWith(pat, times);
    const other = await read(pat, { ...window, address: solana.toLowerCase() });
    expect(other.chains.flatMap((c) => c.vaults)).toEqual([]);
  });

  it('asks no chain anything: the answer is the database’s', async () => {
    const pat = await someone('passkey');
    const vault = await vaultWith(pat, times);
    await seedVault(data.db, { chain: 'solana', owner: pat.solana, address: vault, name: 'Mine' });
    // Every call of an adapter's, on any chain, is written down.
    const asked: string[] = [];
    const watched = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now: () => NOW,
      wrap: (inner) => {
        const watch = <T extends ReturnType<ChainRegistry['get']>>(entry: T): T => ({
          ...entry,
          adapter: new Proxy(entry.adapter, {
            get(target, key) {
              const value = Reflect.get(target, key, target);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                asked.push(`${entry.chain}.${String(key)}`);
                return value.apply(target, args);
              };
            },
          }),
        });
        return {
          ...inner,
          get: (chain) => watch(inner.get(chain)),
          active: () => inner.active().map(watch),
        };
      },
    });
    for (const query of [window, { ...window, address: vault }, { step: '1d' }]) {
      const answer = await read(pat, query, watched.app);
      expect(seriesOf(answer, vault).name).toBe('Mine');
    }
    expect(asked).toEqual([]);
    await watched.app.close();
  });
});

describe('what a history says of a vault', () => {
  it('is its value in cents, its cash in dollars, and each position against its target', async () => {
    const ann = await someone();
    const address = vaultAddress('solana');
    const row = await seedSnapshot(data.db, {
      chain: 'solana',
      address,
      owner: ann.solana,
      observedAt: utc(5, 10, 5),
      valueUsd: 1234.56,
      parts: {
        spy: 5000,
        nvda: { weightBps: 2000, targetBps: 3000 },
        // Held, with no price: it has no value and weighs nothing.
        gold: { weightBps: 1000, priced: false },
      },
      lossUsedBps: 12,
    });
    const answer = await read(ann, { from: utc(5, 10), to: utc(5, 11), step: '10m' });
    expect(answer.disclaimer).toBe(DISCLAIMER.en);
    expect(seriesOf(answer, address)).toEqual({
      address,
      name: null,
      source: 'chain-mock',
      method: 'a snapshot a test made up',
      points: [
        {
          observedAt: '2026-10-05T10:05:00.000Z',
          valueUsd: '1234.56',
          // What the priced positions leave of the whole: 3,000 bps of it, a dollar each.
          cashUsd: '370.368',
          positions: [
            {
              asset: 'solana:spy',
              valueUsd: '617.28',
              weightBps: 5000,
              targetBps: 5000,
              driftBps: 0,
            },
            {
              asset: 'solana:nvda',
              valueUsd: '246.912',
              weightBps: 2000,
              targetBps: 3000,
              driftBps: -1000,
            },
            {
              asset: 'solana:gold',
              valueUsd: null,
              weightBps: 0,
              targetBps: 1000,
              driftBps: -1000,
            },
          ],
          lossUsedBps: 12,
        },
      ],
    });
    // As the row holds them: the cash by its display amount, not its raw units.
    expect([row.valueUsd, row.cash.display, row.cash.raw]).toEqual([
      '1234.56',
      '370.368',
      '370368000',
    ]);
  });

  it('says where a series was read from and how once, and on a point only where it differs', async () => {
    const ann = await someone();
    const address = vaultAddress('solana');
    const base = { chain: 'solana' as const, address, owner: ann.solana };
    await seedMany([
      { ...base, observedAt: utc(5, 8, 5) },
      { ...base, observedAt: utc(5, 9, 5), method: 'the vault as an older worker read it' },
      { ...base, observedAt: utc(5, 10, 5), source: 'another reader' },
      { ...base, observedAt: utc(5, 11, 5) },
      { ...base, observedAt: utc(5, 12, 5), method: 'the vault as a newer worker reads it' },
    ]);
    const made = 'a snapshot a test made up';
    const said = (series: { points: { source?: string; method?: string }[] }) =>
      series.points.map(({ source, method }) => ({ source, method }));

    // Up to the read of 11:05, which was made as most were.
    const most = seriesOf(await read(ann, { from: utc(5, 8), to: utc(5, 11, 30) }), address);
    expect([most.source, most.method]).toEqual(['chain-mock', made]);
    expect(said(most)).toEqual([
      { source: undefined, method: undefined },
      { source: undefined, method: 'the vault as an older worker read it' },
      { source: 'another reader', method: undefined },
      { source: undefined, method: undefined },
    ]);
    // A point that says nothing of its own has no such field at all.
    expect(most.points[0]).not.toHaveProperty('source');
    expect(most.points[0]).not.toHaveProperty('method');

    // With the read of 12:05 the series is made its way, and the older points say their own.
    const newer = seriesOf(await read(ann, { from: utc(5, 8), to: utc(5, 12, 30) }), address);
    expect([newer.source, newer.method]).toEqual([
      'chain-mock',
      'the vault as a newer worker reads it',
    ]);
    expect(said(newer)).toEqual([
      { source: undefined, method: made },
      { source: undefined, method: 'the vault as an older worker read it' },
      { source: 'another reader', method: made },
      { source: undefined, method: made },
      { source: undefined, method: undefined },
    ]);
  });

  it('names a vault as its owner named it, and not at all otherwise', async () => {
    const ann = await someone();
    const bob = await someone();
    const times = [utc(5, 10, 5)];
    const named = await vaultWith(ann, times);
    const unnamed = await vaultWith(ann, times);
    const uncached = await vaultWith(ann, times);
    const anothers = await vaultWith(ann, times);
    const relabelled = await vaultWith(ann, times);
    await seedVault(data.db, {
      chain: 'solana',
      owner: ann.solana,
      address: named,
      name: 'Retirement',
    });
    await seedVault(data.db, { chain: 'solana', owner: ann.solana, address: unnamed });
    // A cache row at the vault's address that is not hers, and one read under another label: a name
    // on either is not a name she gave this vault here.
    await seedVault(data.db, {
      chain: 'solana',
      owner: bob.solana,
      address: anothers,
      name: 'Somebody else’s',
    });
    await seedVault(data.db, {
      chain: 'solana',
      owner: ann.solana,
      address: relabelled,
      name: 'From a test network',
      provenance: 'sandbox',
    });
    const { answer, body } = await answered(ann, { from: utc(5, 10), to: utc(5, 11) });
    expect(Object.fromEntries(vaultsOn(answer, 'solana').map((v) => [v.address, v.name]))).toEqual({
      [named]: 'Retirement',
      [unnamed]: null,
      [uncached]: null,
      [anothers]: null,
      [relabelled]: null,
    });
    expect(body).not.toContain('Somebody else');
    expect(body).not.toContain('From a test network');
  });

  it('lists the vaults by address and each one’s points oldest first', async () => {
    const ann = await someone();
    // Two addresses the database's collation orders one way and their characters the other: where
    // they first differ, the first has a capital letter and the second a small one from earlier in
    // the alphabet. The answer is in the order of the characters, as the section's other reads are.
    const crossed = (): [string, string] => {
      for (let tries = 0; tries < 100_000; tries++) {
        const a = vaultAddress('solana');
        const b = vaultAddress('solana');
        const i = [...a].findIndex((ch, at) => ch !== b[at]);
        const [x, y] = [a[i] ?? '', b[i] ?? ''];
        if (/[A-Z]/.test(x) && /[a-z]/.test(y) && x.toLowerCase() > y) return [a, b];
      }
      throw new Error('no such pair of addresses');
    };
    const [capital, small] = crossed();
    const times = [utc(5, 10, 5), utc(5, 11, 5), utc(5, 12, 5)];
    for (const address of [small, capital])
      await seedMany(valued({ chain: 'solana', address, owner: ann.solana }, times, 1));
    const answer = await read(ann, { from: utc(5, 10), to: utc(5, 13) });
    const listed = vaultsOn(answer, 'solana');
    expect(listed.map((v) => v.address)).toEqual([capital, small]);
    expect(listed.map((v) => v.address)).toEqual([capital, small].sort());
    for (const series of listed) expect(timesOf(series)).toEqual(times.map(iso));
  });
});
