import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Target } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import {
  CREATOR_LIMIT_ERROR,
  CREATOR_LIMITS,
  type CreatorLimitContext,
  checkCreatorLimits,
  LIMIT_REASONS,
  versionEffectiveAt,
} from './creator-limits';
import { referenceBreaks } from './creator-limits.reference';

// fixtures/creator-limits/vectors.json is the one list of cases the TypeScript check, the Solana program
// and the EVM registry are each tested against. This is the TypeScript side.

type Version = { n: number; assets: string[]; weightsBps: number[] };
type Case = {
  name: string;
  group: string;
  scenario: string;
  prev: Version & { exists: number };
  next: Version & { flags: number; maxFeeBps: number };
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
  limits: Record<string, number>;
  error: string;
  reasons: { id: number; name: string }[];
  platform: { n: number; assets: string[]; ceilingsBps: number[]; unlisted: string[] };
  count: number;
  cases: Case[];
};

const file = fileURLToPath(
  new URL('../../../fixtures/creator-limits/vectors.json', import.meta.url),
);
const vectors: Vectors = JSON.parse(readFileSync(file, 'utf8'));

/** A placeholder name as an asset id of this repo: 'CAP_2500' is 'solana:cap-2500'. */
const assetId = (name: string) => `solana:${name.toLowerCase().replaceAll('_', '-')}`;
const targets = (v: Version): Target[] =>
  v.assets.map((name, i) => ({ asset: assetId(name), weightBps: v.weightsBps[i] ?? Number.NaN }));
const platform = vectors.platform.assets.map((name, i) => ({
  id: assetId(name),
  maxWeightBps: vectors.platform.ceilingsBps[i] ?? Number.NaN,
}));

function inputs(c: Case) {
  const prev = c.prev.exists === 1 ? targets(c.prev) : null;
  const ctx: CreatorLimitContext = {
    assets: platform,
    now: c.ctx.now,
    lastPublishAt: c.prev.exists === 1 ? c.ctx.lastPublishAt : null,
    hasPending: c.ctx.hasPending === 1,
    publishDelay: c.ctx.publishDelay,
  };
  return { prev, next: targets(c.next), ctx, header: c.next };
}

describe('the shared vectors for the author limits', () => {
  it('is a file this check can be held to', () => {
    expect(vectors.limits).toEqual(CREATOR_LIMITS);
    expect(vectors.error).toBe(CREATOR_LIMIT_ERROR);
    expect(vectors.reasons.map((r) => r.name)).toEqual([...LIMIT_REASONS]);
    expect(vectors.reasons.map((r) => r.id)).toEqual(LIMIT_REASONS.map((_, i) => i + 1));
    expect(vectors.count).toBe(vectors.cases.length);
    expect(vectors.platform.n).toBe(vectors.platform.assets.length);
    expect(vectors.platform.ceilingsBps).toHaveLength(vectors.platform.n);
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(vectors.cases.length);
    for (const name of vectors.platform.unlisted)
      expect(vectors.platform.assets).not.toContain(name);
  });

  it('has a case that is refused for each rule, and cases that pass', () => {
    const refusedFor = new Set(vectors.cases.map((c) => c.expect.reason));
    for (const reason of LIMIT_REASONS) expect(refusedFor, reason).toContain(reason);
    expect(vectors.cases.filter((c) => c.expect.ok === 1).length).toBeGreaterThan(15);
  });

  it('is integers and strings only, and says the same thing twice where it repeats itself', () => {
    const walk = (value: unknown, path: string) => {
      if (value && typeof value === 'object') {
        for (const [k, x] of Object.entries(value)) walk(x, `${path}.${k}`);
        return;
      }
      const plain = typeof value === 'string' || Number.isSafeInteger(value);
      expect(plain, `${path} is ${String(value)}`).toBe(true);
    };
    walk(vectors, '');
    for (const c of vectors.cases) {
      for (const v of [c.prev, c.next]) {
        expect(v.assets, c.name).toHaveLength(v.n);
        expect(v.weightsBps, c.name).toHaveLength(v.n);
      }
      if (c.prev.exists === 0) expect(c.prev.n, c.name).toBe(0);
      expect(c.scenario === 'first', c.name).toBe(c.prev.exists === 0);
      expect(c.scenario.startsWith('pending'), c.name).toBe(c.ctx.hasPending === 1);
      if (c.prev.exists === 0) expect(c.ctx.lastPublishAt, c.name).toBe(0);
      expect(c.expect.breaks[0] ?? '', c.name).toBe(c.expect.reason);
      expect(c.expect.reasonId, c.name).toBe(
        vectors.reasons.find((r) => r.name === c.expect.reason)?.id ?? 0,
      );
      expect(c.expect.error, c.name).toBe(c.expect.ok === 1 ? '' : vectors.error);
    }
  });

  describe.each([...new Set(vectors.cases.map((c) => c.group))])('%s', (group) => {
    it.each(vectors.cases.filter((c) => c.group === group).map((c) => [c.name, c] as const))(
      '%s',
      (_name, c) => {
        const { prev, next, ctx, header } = inputs(c);
        const result = checkCreatorLimits(prev, next, ctx, header);
        if (c.expect.ok === 1) {
          expect(result).toEqual({ ok: true, turnoverBps: c.expect.turnoverBps });
          expect(versionEffectiveAt(prev, ctx)).toBe(c.expect.effectiveAt);
        } else {
          expect(result).toMatchObject({ ok: false, code: c.expect.reason });
          expect(result.ok === false && result.detail.length).toBeGreaterThan(0);
        }
        // The slow reference, written apart from the check, finds the same rules broken.
        expect(referenceBreaks(prev, next, ctx, header)).toEqual(c.expect.breaks);
      },
    );
  });
});
