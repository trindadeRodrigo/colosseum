import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type BasketAsset,
  ChainError,
  type Component,
  PublishRecipeArgs,
  type Recipe,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createMockAdapter } from './adapter';
import { mockAddress, mockRecipeId, sha256Hex } from './ids';
import { mockAssets } from './shelf';

// The mock registry refuses what a real one would: the shared vectors for the four author limits
// (fixtures/creator-limits) are published through the adapter, each from the state its scenario
// describes. Where the `Recipe` schema cannot even say what a vector says (a repeated asset, a weight
// of zero, a sum that is off, a non-zero `flags`), the adapter refuses it as BadInput before the
// registry is asked; the rest reach the registry and get `CreatorLimit` with the rule named.

type Version = { n: number; assets: string[]; weightsBps: number[] };
type Case = {
  name: string;
  scenario: string;
  prev: Version & { exists: number };
  next: Version & { flags: number; maxFeeBps: number };
  older: Version & { exists: number };
  waiting: Version & { exists: number };
  ctx: { now: number; lastPublishAt: number; publishDelay: number; hasPending: number };
  expect: { ok: number; error: string; reason: string; effectiveAt: number };
};
const file = fileURLToPath(
  new URL('../../../fixtures/creator-limits/vectors.json', import.meta.url),
);
const vectors: {
  platform: { assets: string[]; ceilingsBps: number[]; cash: string };
  cases: Case[];
} = JSON.parse(readFileSync(file, 'utf8'));

const CHAIN = 'solana';
const id = (name: string) => `${CHAIN}:${name.toLowerCase().replaceAll('_', '-')}`;
const [cash, template] = mockAssets(CHAIN);
if (!cash || !template) throw new Error('the mock lists no assets');
// The vectors name the chain's cash token and give it a ceiling like any asset's, so that the only
// thing against it is that it is cash.
const ASSETS: BasketAsset[] = vectors.platform.assets.map((name, i) => ({
  ...(name === vectors.platform.cash ? cash : template),
  id: id(name),
  address: mockAddress(CHAIN, `asset:${name}`),
  symbol: name,
  maxWeightBps: vectors.platform.ceilingsBps[i] ?? 0,
}));
const PRICES = Object.fromEntries(ASSETS.map((a) => [a.id, '1']));
const OWNER = mockAddress(CHAIN, 'author');
const FAMILY = 'ef'.repeat(32);
const RECIPE_ID = mockRecipeId(CHAIN, OWNER, FAMILY);

function recipe(v: Version, header = { flags: 0, maxFeeBps: 0 }): Recipe {
  return {
    schemaVersion: 1,
    familyId: FAMILY,
    chain: CHAIN,
    onchainId: null,
    creator: OWNER,
    kind: 'community',
    version: 1,
    effectiveAt: 0,
    components: v.assets.map(
      (name, i): Component => ({ kind: 'asset', asset: id(name), weightBps: v.weightsBps[i] ?? 0 }),
    ),
    metaHash: sha256Hex('limits'),
    // A vector may carry a value the type does not allow; the adapter is what has to refuse it.
    ...(header as { flags: 0; maxFeeBps: 0 }),
  };
}

/** The mock chain in the state the case's scenario describes, at the case's `now`. */
async function arrange(c: Case) {
  const delay = c.ctx.publishDelay;
  const start = { first: c.ctx.now, next: c.ctx.lastPublishAt }[c.scenario];
  const adapter = createMockAdapter({
    chain: CHAIN,
    assets: ASSETS,
    prices: PRICES,
    publishDelaySeconds: delay,
    now: new Date((start ?? c.ctx.lastPublishAt - delay) * 1000).toISOString(),
  });
  const { mock } = adapter;
  mock.fund(OWNER, { gasRaw: '1000000000' });
  const publish = async (v: Version) =>
    mock.send(await adapter.buildPublishRecipe({ creator: OWNER, recipe: recipe(v) }));
  if (c.scenario === 'next') await publish(c.prev);
  if (c.scenario === 'pending') {
    // `prev` goes into effect, and one delay later the waiting version is published.
    await publish(c.prev);
    mock.advance(delay);
    await publish(c.waiting);
  }
  if (c.scenario === 'matured') {
    // The older version goes into effect; one delay later `prev` is published, waits, and matures.
    await publish(c.older);
    mock.advance(delay);
    await publish(c.prev);
  }
  mock.advance(c.ctx.now - mock.now());
  expect(mock.now()).toBe(c.ctx.now);
  return adapter;
}

/**
 * What the mock cannot be brought to: it has no cancel, and one publish delay and one asset list for
 * its lifetime.
 */
const NOT_ON_THE_MOCK = ['cancelled', 'pending_delay_lowered', 'next_ceiling_lowered'];
const runnable = vectors.cases.filter((c) => !NOT_ON_THE_MOCK.includes(c.scenario));

describe('chain-mock: publishing a shared portfolio is held to the author limits', () => {
  const seen = { accepted: 0, refused: new Set<string>(), badInput: 0 };

  it.each(runnable.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const adapter = await arrange(c);
    const args = { creator: OWNER, recipe: recipe(c.next, c.next) };
    const outcome = await adapter.buildPublishRecipe(args).then(
      (tx) => ({ tx }),
      (error: unknown) => ({ error }),
    );

    if (c.expect.ok === 1) {
      if ('error' in outcome) throw outcome.error;
      const { txId } = await adapter.mock.send(outcome.tx);
      expect((await adapter.track(txId)).status).toBe('confirmed');
      const { active, pending } = await adapter.getRecipe(RECIPE_ID);
      const published = c.prev.exists === 1 ? pending : active;
      expect(published?.effectiveAt).toBe(c.expect.effectiveAt);
      expect(published?.version).toBe(c.prev.exists === 1 ? active.version + 1 : 1);
      expect(published?.components).toEqual(args.recipe.components);
      seen.accepted += 1;
      return;
    }
    const refusal = 'error' in outcome ? outcome.error : null;
    if (!(refusal instanceof ChainError)) throw new Error('the mock built what it should refuse');
    if (!PublishRecipeArgs.safeParse(args).success) {
      expect(refusal.code).toBe('BadInput');
      seen.badInput += 1;
      return;
    }
    expect(refusal.code).toBe(c.expect.error);
    expect(refusal.message.startsWith(`${c.expect.reason}: `), refusal.message).toBe(true);
    expect(refusal.retryable).toBe(false);
    seen.refused.add(c.expect.reason);
  });

  it('ran every scenario the mock can be brought to, and met most of the rules on the way', () => {
    expect(vectors.cases.length - runnable.length).toBe(5);
    expect(runnable.filter((c) => c.scenario === 'matured').length).toBeGreaterThanOrEqual(3);
    expect(seen.accepted).toBeGreaterThan(15);
    expect(seen.badInput).toBeGreaterThan(10);
    expect([...seen.refused].sort()).toEqual([
      'AssetNotListed',
      'CashNotAllowed',
      'TooFewAssets',
      'TooManyAssets',
      'TurnoverTooHigh',
      'VersionPending',
      'VersionTooSoon',
      'WeightAboveCeiling',
      'WeightBelowMin',
      'WeightOffStep',
    ]);
  });

  it('refuses the same version when sent, if the limits bite between build and send', async () => {
    // Built while allowed; another version lands first; the first is then one too many.
    const c = vectors.cases.find((x) => x.name === 'exactly on time, 300-second delay');
    if (!c) throw new Error('the vector is gone');
    const adapter = await arrange(c);
    const publish = () =>
      adapter.buildPublishRecipe({ creator: OWNER, recipe: recipe(c.next, c.next) });
    const [first, second] = [await publish(), await publish()];
    await adapter.mock.send(first);
    const { txId } = await adapter.mock.send(second);
    expect(await adapter.track(txId)).toMatchObject({
      status: 'reverted',
      error: { code: 'CreatorLimit' },
    });
  });
});
