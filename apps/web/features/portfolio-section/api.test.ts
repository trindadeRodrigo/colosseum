import { describe, expect, it } from 'vitest';
import type { ApiFetch } from '../account/person';
import { json } from '../wallet/test/fake-port';
import {
  EXPOSURE_PATH,
  HISTORY_PATH,
  PLANS_PATH,
  pathOf,
  planIn,
  REBALANCES_PATH,
  readExposure,
  readHistory,
  readPlans,
  readRebalances,
} from './api';
import {
  exposure,
  history,
  plans,
  RH_SILENT,
  rebalances,
  SOL_GROW,
  SOL_INCOME,
} from './test/fixtures';

// The four fetchers of the section: each asks its route with the query it was handed, reads the
// answer with the contract's schema, and says in one word what came of it. An answer that is not the
// frozen shape, or not about what was asked, is not shown.

const answering = (answer: (path: string) => Response | Promise<Response>) => {
  const asked: string[] = [];
  const apiFetch: ApiFetch = async (path) => {
    asked.push(path);
    return answer(path);
  };
  return { apiFetch, asked };
};

describe('the fetchers of the portfolio section', () => {
  it('ask each route by its address, with the query that was handed over and nothing else', async () => {
    const { apiFetch, asked } = answering(() => json({}, 500));
    await readPlans(apiFetch);
    await readPlans(apiFetch, { chain: 'solana', address: SOL_INCOME });
    await readExposure(apiFetch, { address: SOL_INCOME });
    await readRebalances(apiFetch, { limit: 200 });
    await readHistory(apiFetch, {
      chain: 'robinhood',
      address: RH_SILENT,
      step: '1d',
      from: '2026-09-30T12:00:00.000Z',
    });
    expect(asked).toEqual([
      PLANS_PATH,
      `${PLANS_PATH}?chain=solana&address=${SOL_INCOME}`,
      `${EXPOSURE_PATH}?address=${SOL_INCOME}`,
      `${REBALANCES_PATH}?limit=200`,
      `${HISTORY_PATH}?chain=robinhood&address=${RH_SILENT}&step=1d&from=2026-09-30T12%3A00%3A00.000Z`,
    ]);
    expect(pathOf(PLANS_PATH, { chain: undefined })).toBe(PLANS_PATH);
  });

  it('hand on an answer in the frozen shape as it came', async () => {
    const whole = {
      plans: plans(),
      exposure: exposure(),
      rebalances: rebalances(),
      history: history(),
    };
    const { apiFetch } = answering((path) =>
      json(
        path.startsWith(PLANS_PATH)
          ? whole.plans
          : path.startsWith(EXPOSURE_PATH)
            ? whole.exposure
            : path.startsWith(REBALANCES_PATH)
              ? whole.rebalances
              : whole.history,
      ),
    );
    expect(await readPlans(apiFetch)).toEqual({ kind: 'read', answer: whole.plans });
    expect(await readExposure(apiFetch)).toEqual({ kind: 'read', answer: whole.exposure });
    expect(await readRebalances(apiFetch)).toEqual({ kind: 'read', answer: whole.rebalances });
    expect(await readHistory(apiFetch)).toEqual({ kind: 'read', answer: whole.history });
  });

  it.each([
    [() => json({ error: 'Route not found' }, 404), 'unavailable'],
    [() => json({ error: 'slow down' }, 429), 'busy'],
    [() => json({ error: 'sign in first' }, 401), 'signed-out'],
    [() => json({ error: 'no identity token was sent' }, 401), 'no-identity'],
    [() => json({ error: 'not yours' }, 403), 'signed-out'],
    [() => json({ error: 'the window spans more than 1000 steps' }, 400), 'refused'],
    [() => json({ error: 'the database did not answer' }, 503), 'unreachable'],
    [() => Promise.reject(new TypeError('fetch failed')), 'unreachable'],
    [() => new Response('<html>', { status: 200 }), 'unreadable'],
    [() => json({ chains: 'nope' }), 'unreadable'],
  ] as const)('say what came of a read that failed: %#', async (answer, kind) => {
    for (const read of [readPlans, readExposure, readRebalances, readHistory])
      expect(await read(answering(answer).apiFetch)).toEqual({ kind });
  });

  it('do not show an answer that names a chain twice, or read and unavailable at once', async () => {
    const answer = plans();
    const [solana] = answer.chains;
    if (!solana) throw new Error('no chain');
    const twice = { ...answer, chains: [...answer.chains, solana] };
    expect(await readPlans(answering(() => json(twice)).apiFetch)).toEqual({ kind: 'unreadable' });
    const both = {
      ...answer,
      unavailable: [{ ...answer.unavailable[0], chain: 'solana' }],
    };
    expect(await readPlans(answering(() => json(both)).apiFetch)).toEqual({ kind: 'unreadable' });
  });

  it('do not show a vault or a step filed under a chain it is not on (gate ONE-CHAIN)', async () => {
    const answer = plans();
    const [solana, robinhood] = answer.chains;
    if (!solana || !robinhood) throw new Error('no chains');
    const misfiled = {
      ...answer,
      chains: [{ ...solana, plans: [...solana.plans, ...robinhood.plans] }, robinhood],
    };
    expect(await readPlans(answering(() => json(misfiled)).apiFetch)).toEqual({
      kind: 'unreadable',
    });
    const steps = rebalances();
    const [first, second] = steps.chains;
    if (!first || !second) throw new Error('no chains');
    const mixed = { ...steps, chains: [{ ...first, entries: second.entries }, second] };
    expect(await readRebalances(answering(() => json(mixed)).apiFetch)).toEqual({
      kind: 'unreadable',
    });
  });

  it('do not show an answer about another chain or another vault than the one asked for', async () => {
    // asked for one chain, answered with every chain
    const all = answering(() => json(plans()));
    expect(await readPlans(all.apiFetch, { chain: 'solana' })).toEqual({ kind: 'unreadable' });
    // asked for one vault, answered with every vault
    for (const [read, body] of [
      [readPlans, plans()],
      [readRebalances, rebalances()],
      [readHistory, history()],
      [readExposure, exposure()],
    ] as const) {
      const { apiFetch } = answering(() => json(body));
      expect(await read(apiFetch, { address: SOL_GROW }), read.name).toEqual({
        kind: 'unreadable',
      });
    }
    // narrowed as asked, it is read: an EVM address in any case is the same vault
    const narrowed = answering(() => json(plans({ address: RH_SILENT })));
    const outcome = await readPlans(narrowed.apiFetch, {
      address: RH_SILENT.toUpperCase().replace('0X', '0x'),
    });
    expect(outcome.kind).toBe('read');
    // and an address of nobody's is nothing on every chain, which is an answer and no error
    const nobody = answering(() =>
      json(plans({ address: 'So11111111111111111111111111111111111111112' })),
    );
    const none = await readPlans(nobody.apiFetch, {
      address: 'So11111111111111111111111111111111111111112',
    });
    expect(none.kind === 'read' && none.answer.chains.flatMap((c) => c.plans)).toEqual([]);
  });
});

describe('the vault an address names', () => {
  it('is found by its chain and its address, an EVM address in any case', () => {
    const answer = plans();
    expect(planIn(answer, 'solana', SOL_INCOME)?.plan.name).toBe('Rent fund');
    expect(planIn(answer, 'solana', SOL_INCOME)?.chain.chain).toBe('solana');
    const shouted = `0x${RH_SILENT.slice(2).toUpperCase()}`;
    expect(planIn(answer, 'robinhood', shouted)?.plan.address).toBe(RH_SILENT);
  });

  it('is nothing for a chain the answer does not have, a vault filed elsewhere, or words that are no address', () => {
    const answer = plans();
    expect(planIn(answer, 'base', SOL_INCOME)).toBeNull();
    expect(planIn(answer, 'robinhood', SOL_INCOME)).toBeNull();
    expect(planIn(answer, 'solana', RH_SILENT)).toBeNull();
    expect(planIn(answer, 'solana', SOL_INCOME.toLowerCase())).toBeNull();
    expect(planIn(answer, 'nowhere', '')).toBeNull();
  });
});
