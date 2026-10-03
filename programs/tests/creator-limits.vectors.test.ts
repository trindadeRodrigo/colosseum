import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, KeyPairSigner } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Component,
  cancelPendingInstruction,
  DEFAULT_PARAMS,
  decodeRecipePublished,
  ERR,
  familyId,
  initPlatform,
  limitReason,
  publishRecipeInstruction,
  readRecipe,
  recipeAddress,
  setParamsInstruction,
  updateRecipeInstruction,
  upsertAssetInstruction,
} from './src/basket';
import {
  createWorld,
  events,
  expectError,
  expectOk,
  failed,
  fundedSigner,
  REPO_ROOT,
  type SendResult,
  send,
  setClock,
} from './src/env';
import { createMint, TOKEN_PROGRAM } from './src/tokens';

// The four author limits, held to the one list of cases the TypeScript check and the EVM
// registry are held to (fixtures/creator-limits). Each case is driven through the real program:
// the state its scenario names is built with real publishes at the times it gives, then the
// version is proposed at `now`. Hostile case A16.

type Version = { exists?: number; n: number; assets: string[]; weightsBps: number[] };
type Case = {
  name: string;
  group: string;
  scenario:
    | 'first'
    | 'next'
    | 'pending'
    | 'pending_delay_lowered'
    | 'cancelled'
    | 'matured'
    | 'next_ceiling_lowered';
  prev: Version;
  next: Version & { flags: number; maxFeeBps: number };
  older: Version;
  waiting: Version;
  ctx: { now: number; lastPublishAt: number; publishDelay: number; hasPending: number };
  expect: {
    ok: number;
    error: string;
    reason: string;
    reasonId: number;
    breaks: string[];
    turnoverBps: number;
    effectiveAt: number;
  };
};
type Vectors = {
  error: string;
  limits: { maxWeightBps: number };
  platform: { assets: string[]; ceilingsBps: number[]; unlisted: string[]; cash: string };
  count: number;
  cases: Case[];
};

const vectors = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'creator-limits', 'vectors.json'), 'utf8'),
) as Vectors;
const LONG_DELAY = 172_800;

describe('the author limits, from the shared vectors (A16)', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let creator: KeyPairSigner;
  const mints = new Map<string, Address>();
  const ceilings = new Map<string, number>();
  let delay = DEFAULT_PARAMS.publishDelayS;

  const mintOf = (name: string): Address => {
    const mint = mints.get(name);
    if (!mint) throw new Error(`the vectors name ${name}, which the test did not map to a mint`);
    return mint;
  };
  const components = (v: Version): Component[] =>
    v.assets.map((name, i) => ({ mint: mintOf(name), weightBps: v.weightsBps[i] ?? 0 }));

  async function setCeiling(name: string, maxWeightBps: number): Promise<void> {
    if (ceilings.get(name) === maxWeightBps) return;
    expectOk(
      await send(svm, admin, [await upsertAssetInstruction(admin, mintOf(name), { maxWeightBps })]),
    );
    ceilings.set(name, maxWeightBps);
  }
  async function setDelay(publishDelayS: number): Promise<void> {
    if (delay === publishDelayS) return;
    expectOk(
      await send(svm, admin, [
        await setParamsInstruction(admin, { ...DEFAULT_PARAMS, publishDelayS }),
      ]),
    );
    delay = publishDelayS;
  }

  beforeAll(async () => {
    ({ svm, deployer: admin } = await createWorld());
    creator = await fundedSigner(svm, 100n);
    const { platform } = vectors;
    for (const name of [...platform.assets, ...platform.unlisted]) {
      const mint = await createMint(svm, admin, { program: TOKEN_PROGRAM, decimals: 8 });
      mints.set(name, mint.address);
    }
    // The vectors' cash token is the cash mint of this deployment's Config, and it is on the list
    // with a ceiling like any other: the only thing against it is that it is cash.
    await initPlatform(svm, admin, { cashMint: mintOf(platform.cash) });
    for (const [i, name] of platform.assets.entries())
      await setCeiling(name, platform.ceilingsBps[i] ?? 0);
  });

  it('has every case the file says it has, and a mint for every name', () => {
    expect(vectors.cases).toHaveLength(vectors.count);
    expect(vectors.count).toBe(87);
    expect(vectors.error).toBe('CreatorLimit');
    for (const c of vectors.cases)
      for (const v of [c.prev, c.next, c.older, c.waiting])
        for (const name of v.assets) mintOf(name);
  });

  it.each(vectors.cases.map((c, i) => [i, c.name, c.group, c] as const))(
    'case %i: %s (%s)',
    async (i, _name, _group, c) => {
      const family = familyId(`case-${i}`);
      const recipe = await recipeAddress(creator.address, family);
      const { now, lastPublishAt, publishDelay } = c.ctx;
      const publish = async (v: Version, header = { flags: 0, maxFeeBps: 0 }) =>
        send(svm, creator, [
          await publishRecipeInstruction({
            creator,
            familyId: family,
            components: components(v),
            ...header,
          }),
        ]);
      const update = async (v: Version) =>
        send(svm, creator, [
          await updateRecipeInstruction({ creator, recipe, components: components(v) }),
        ]);

      // A version of the state that came before may sit over the ceiling the platform gives its
      // asset today (`next_ceiling_lowered`): it was published when the ceiling was at the most.
      const platformCeiling = (name: string) =>
        vectors.platform.ceilingsBps[vectors.platform.assets.indexOf(name)] ?? 0;
      const raised = new Set<string>();
      for (const v of [c.older, c.prev, c.waiting])
        for (const [j, name] of v.assets.entries())
          if ((v.weightsBps[j] ?? 0) > Math.min(vectors.limits.maxWeightBps, platformCeiling(name)))
            raised.add(name);
      for (const name of raised) await setCeiling(name, vectors.limits.maxWeightBps);

      await setDelay(publishDelay);
      switch (c.scenario) {
        case 'first':
          break;
        case 'next':
        case 'next_ceiling_lowered':
          setClock(svm, lastPublishAt);
          expectOk(await publish(c.prev));
          break;
        case 'pending':
          setClock(svm, lastPublishAt - publishDelay);
          expectOk(await publish(c.prev));
          setClock(svm, lastPublishAt);
          expectOk(await update(c.waiting));
          break;
        case 'pending_delay_lowered':
          // The waiting version was published under a longer delay, which was then lowered.
          await setDelay(LONG_DELAY);
          setClock(svm, lastPublishAt - LONG_DELAY);
          expectOk(await publish(c.prev));
          setClock(svm, lastPublishAt);
          expectOk(await update(c.waiting));
          await setDelay(publishDelay);
          break;
        case 'cancelled':
          setClock(svm, lastPublishAt - publishDelay);
          expectOk(await publish(c.prev));
          setClock(svm, lastPublishAt);
          expectOk(await update(c.waiting));
          expectOk(
            await send(svm, creator, [await cancelPendingInstruction({ signer: creator, recipe })]),
          );
          break;
        case 'matured':
          setClock(svm, lastPublishAt - publishDelay);
          expectOk(await publish(c.older));
          setClock(svm, lastPublishAt);
          expectOk(await update(c.prev));
          break;
      }
      for (const name of raised) await setCeiling(name, platformCeiling(name));
      setClock(svm, now);

      // The state the case describes is the state the program is in.
      const first = c.prev.exists === 0;
      const before = first ? null : readRecipe(svm, recipe);
      if (before) {
        const waiting = before.pending.version !== 0 && BigInt(now) < before.pending.effectiveAt;
        expect([Number(before.lastPublishTs), waiting ? 1 : 0]).toEqual([
          lastPublishAt,
          c.ctx.hasPending,
        ]);
      }
      const inEffect = before
        ? before.pending.version !== 0 && !c.ctx.hasPending
          ? before.pending
          : before.current
        : null;
      if (inEffect) expect(inEffect.components).toEqual(components(c.prev));

      const result: SendResult = first
        ? await publish(c.next, { flags: c.next.flags, maxFeeBps: c.next.maxFeeBps })
        : await update(c.next);

      if (c.expect.ok === 1) {
        const meta = expectOk(result);
        const after = readRecipe(svm, recipe);
        const published = first ? after.current : after.pending;
        // One past the highest number ever given out: a cancelled version keeps its number.
        expect(published.version).toBe(first ? 1 : (before?.lastVersion ?? 0) + 1);
        if (c.scenario === 'cancelled') expect(published.version).toBe(3);
        expect(after.lastVersion).toBe(published.version);
        expect(Number(published.effectiveAt)).toBe(c.expect.effectiveAt);
        expect(published.components).toEqual(components(c.next));
        expect(Number(after.lastPublishTs)).toBe(now);
        // What waited and came into effect is now the current version.
        if (!first) expect(after.current).toEqual(inEffect);
        const [event] = events(meta, 'RecipePublished').map(decodeRecipePublished);
        expect([event?.version, event?.turnoverBps, Number(event?.effectiveAt)]).toEqual([
          published.version,
          c.expect.turnoverBps,
          c.expect.effectiveAt,
        ]);
        return;
      }

      // Refused: one error for every limit, and the rule's number in the log.
      expectError(result, ERR.CreatorLimit);
      if (!failed(result)) throw new Error('unreachable');
      expect(limitReason(result.meta().logs())).toBe(c.expect.reasonId);
      if (first) expect(svm.getAccount(recipe).exists).toBe(false);
      else expect(readRecipe(svm, recipe)).toEqual(before);
    },
  );
});
