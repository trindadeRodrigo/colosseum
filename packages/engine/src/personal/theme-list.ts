import { ChainId } from '@colosseum/schemas';
import { z } from 'zod';
import { PersonalInputError } from './types';

// A theme list (gate THEMES): which tokens count for a theme on one chain. The team curates it, a
// person confirms its membership, never a model. One file per theme per chain, under
// `content/themes/<chain>/<slug>.json`; the API reads the files of the person's chain and hands them
// to `compose` in its context, so `compose` reads no file.

/** A sentence in each language a plan is written in. */
const Words = z.object({ en: z.string().min(1), pt: z.string().min(1) });

/**
 * LOCAL TYPE. A curated theme list. `status` is `proposed` until a person confirms the membership;
 * only a confirmed list fills a theme sleeve. `version` goes up with every change of members.
 */
export const ThemeList = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: Words,
    chain: ChainId,
    version: z.number().int().positive(),
    curator: z.string().min(1),
    status: z.enum(['proposed', 'confirmed']),
    /** The day the status was set: proposed, or confirmed by the curator (YYYY-MM-DD). */
    decidedOn: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
    /** The row of docs/GATES.md that records the decision, once there is one. */
    gate: z.string().min(1).optional(),
    note: z.string().optional(),
    /** Each name by the token symbol the shelf lists it under on the chain, with why it is on the list. */
    members: z
      .array(z.object({ symbol: z.string().min(1), reason: Words }))
      .min(1)
      .refine((ms) => new Set(ms.map((m) => m.symbol)).size === ms.length, {
        message: 'a name is on the list twice',
      }),
  })
  .strict();
export type ThemeList = z.infer<typeof ThemeList>;

/**
 * A theme list read from its file, validated. Throws `PersonalInputError` with the file's name and
 * what is wrong: a list that does not validate is never used.
 */
export function parseThemeList(raw: unknown, file = 'theme list'): ThemeList {
  const parsed = ThemeList.safeParse(raw);
  if (!parsed.success)
    throw new PersonalInputError(
      'InvalidContext',
      parsed.error.issues.map((i) => ({
        path: [file, ...i.path].join('.'),
        message: i.message,
      })),
    );
  return parsed.data;
}
