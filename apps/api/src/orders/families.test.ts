import { randomUUID } from 'node:crypto';
import { indexFamilies, recipes } from '@colosseum/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../testing/harness';
import { writePublished } from './families';
import { nameKeyOf } from './shared';

// Two creators' publishes of one new slug, recorded at the same moment: the family's text and its
// recipe are always one creator's, whichever is recorded first (the lock on the family id). On the real
// database, as the order routes run on it.

let data: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  data = await testDb();
});
afterAll(async () => {
  await data.cleanUp();
});

const write = (familyId: string, who: 'a' | 'b') =>
  writePublished(data.db, {
    familyId,
    slug: `race-${familyId.slice(0, 12)}`,
    // Letters only, one per hex digit of the id: no two families share a key.
    nameKey: `race${familyId.slice(0, 16).replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)] ?? 'x')}${who}`,
    name: `Creator ${who}`,
    copy: `Written by ${who}.`,
    creatorUserId: null,
    chain: 'solana',
    onchainId: `${who}:${familyId}`,
    creator: `creator-${who}`,
  });

describe('two publishes of one new slug at once', () => {
  it('leave the text and the recipe to one creator, every time', async () => {
    const mixed: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const familyId = randomUUID().replaceAll('-', '').padEnd(64, '0');
      data.trackFamily(familyId);
      const [a, b] = await Promise.all([write(familyId, 'a'), write(familyId, 'b')]);
      // exactly one of the two is written
      expect([a, b].filter((x) => x !== null)).toHaveLength(1);
      const [family] = await data.db
        .select()
        .from(indexFamilies)
        .where(eq(indexFamilies.familyId, familyId));
      const rows = await data.db.select().from(recipes).where(eq(recipes.familyId, familyId));
      const textBy = family?.name.slice(-1);
      if (rows.length !== 1 || rows[0]?.creator !== `creator-${textBy}`) mixed.push(familyId);
    }
    expect(mixed).toEqual([]);
  });

  it('let the same creator record the next version, with new text', async () => {
    const familyId = randomUUID().replaceAll('-', '').padEnd(64, '0');
    data.trackFamily(familyId);
    expect(await write(familyId, 'a')).not.toBeNull();
    expect(await write(familyId, 'b')).toBeNull();
    expect(await write(familyId, 'a')).not.toBeNull();
  });
});

describe('the folded key of a name', () => {
  it('reads look-alike letters as one: i, l and 1; rn and m; digits for letters; case and spaces', () => {
    const same = ['Illiquid', 'I11iquid', 'lLLiquid', 'Il1 iquid', 'IL-LIQUID'];
    for (const name of same) expect(nameKeyOf(name), name).toBe(nameKeyOf(same[0] ?? ''));
    expect(nameKeyOf('Modern')).toBe(nameKeyOf('Modem'));
    expect(nameKeyOf('Morning')).toBe(nameKeyOf('Moming'));
    expect(nameKeyOf('G0LD')).toBe(nameKeyOf('gold'));
    expect(nameKeyOf('Gold')).not.toBe(nameKeyOf('Bold'));
  });
});
