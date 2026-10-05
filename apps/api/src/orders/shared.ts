import { checkCreatorLimits, familyIdOf, metaHash } from '@colosseum/basket';
import { mockRecipeId } from '@colosseum/chain-mock';
import { recipeAddress } from '@colosseum/chain-solana/vault';
import type { Db } from '@colosseum/db';
import {
  type Address,
  type AutoFollowOffer,
  type BasketAsset,
  ChainError,
  type ChainId,
  chainFamily,
  type IntentRequest,
  isAddressOf,
  type Leg,
  type Principal,
  type Recipe,
  type Target,
} from '@colosseum/schemas';
import { holds } from '../plugins/auth';
import { assertBuilds, type ChainEntry, type ChainRegistry } from './chains';
import { Refusal } from './errors';
import { hasVersion, type StoredFamily, syncVersions, userIdOf, writePublished } from './families';

// Shared portfolios as orders (DESIGN-VAULT section 6, gate SHARED-FULL): a creator publishes one, a
// person follows one. The API plans and builds; the creator's own form says what is published, and the
// guard in packages/sdk holds the bytes to what that form showed (AGT-4): the family id, the text, the
// assets and weights. Solana only for now: Robinhood Chain's registry calls wait for EVM-3 and ADE-2.

type PublishRequest = Extract<IntentRequest, { type: 'publish' }>;
type FollowRequest = Extract<IntentRequest, { type: 'follow' }>;

/** What a creator's text may be (DESIGN-VAULT section 12): short, with no link in it. */
export const SHARED_TEXT = { maxChars: 280 } as const;

const DIGIT_LETTERS: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
};

/**
 * The folded key of a name: lower case, digits that look like letters read as those letters, nothing
 * but letters, then the shapes that pass for each other folded together: `rn` reads as `m`, and `i`,
 * `l` and `1` as one letter. Two names with one key are one name: the second is refused.
 */
export function nameKeyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[0-9]/g, (d) => DIGIT_LETTERS[d] ?? d)
    .replace(/[^a-z]/g, '')
    .replace(/rn/g, 'm')
    .replace(/i/g, 'l');
}

/**
 * A link, refused in a name or a description: a scheme (`://`), `www.`, or a bare host and its path
 * (`evil.xyz/airdrop`): dotted labels ending in letters, standing on their own, an email address included.
 */
const LINK = /:\/\/|www\.|(?<!\w)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/i;
/**
 * A character a person cannot see or that turns text around: format characters (zero-width spaces and
 * joiners, the bidi controls, a soft hyphen, a byte-order mark) and control characters but a newline.
 */
const HIDDEN = /\p{Cf}|(?!\n)\p{Cc}/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The text a family's hash covers, from a publish request. A creator's portfolio is always `index`. */
export function familyText(req: PublishRequest, familyId: string) {
  return { familyId, slug: req.family, name: req.name, copy: req.copy, kind: 'index' as const };
}

/**
 * The text of a publish, held to the rules a name and a description follow. A link is refused, not
 * stripped: the text hashed is the text the creator's form showed, so the server never changes it.
 */
export function checkText(req: PublishRequest): void {
  if (!SLUG.test(req.family) || req.family.length > 64)
    throw new Refusal(422, 'a slug is lower-case letters, digits and dashes, at most 64');
  if (!PRINTABLE_ASCII.test(req.name) || req.name.trim() !== req.name)
    throw new Refusal(
      422,
      'a name is plain ASCII letters, digits and punctuation, with no space at either end',
    );
  for (const [what, text] of [
    ['name', req.name],
    ['description', req.copy],
  ] as const) {
    if (text.length > SHARED_TEXT.maxChars)
      throw new Refusal(
        422,
        `the ${what} is ${text.length} characters, and the most is ${SHARED_TEXT.maxChars}`,
      );
    if (LINK.test(text)) throw new Refusal(422, `the ${what} holds a link, and none is allowed`);
    if (HIDDEN.test(text))
      throw new Refusal(
        422,
        `the ${what} holds a character that can't be seen or that turns text around, and none is allowed`,
      );
  }
  if (!nameKeyOf(req.name)) throw new Refusal(422, 'a name has at least one letter');
}

/** A recipe's assets and weights. A shared portfolio lists assets only. */
export const recipeTargets = (r: Pick<Recipe, 'components'>): Target[] =>
  r.components.flatMap((c) =>
    c.kind === 'asset' ? [{ asset: c.asset, weightBps: c.weightBps }] : [],
  );

/**
 * The id of a creator's recipe on a chain, worked out as the registry does: on Solana the account at
 * ["recipe", creator, family id]; on the mock the mock's own rule. An EVM registry's id waits for its
 * final interface.
 */
export async function recipeIdOf(
  entry: ChainEntry,
  creator: Address,
  familyId: string,
): Promise<string> {
  if (entry.mock) return mockRecipeId(entry.chain, creator, familyId);
  if (entry.config.family !== 'solana')
    throw new Refusal(
      501,
      `a shared portfolio on ${entry.config.name} waits for its registry (EVM-3)`,
    );
  const program = entry.config.contracts.program;
  if (!program) throw new Error(`${entry.chain} names no vault program`);
  type Key = Parameters<typeof recipeAddress>[0];
  return recipeAddress(
    program as Key,
    creator as Key,
    Uint8Array.from(Buffer.from(familyId, 'hex')),
  );
}

/** A recipe as the chain has it now, or null when there is none at that id. */
export async function readRecipe(
  entry: ChainEntry,
  onchainId: string,
): Promise<{ active: Recipe; pending: Recipe | null } | null> {
  try {
    return await entry.adapter.getRecipe(onchainId);
  } catch (e) {
    if (e instanceof ChainError && e.code === 'RecipeNotFound') return null;
    throw e;
  }
}

/**
 * Whether the auto-follow switch is offered on a recipe (gate GOLD-ONE-TAP): the chain runs a keeper
 * path, and every asset of the versions given has an oracle there, which is what the asset list's
 * `autoFollowEligible` says (the program's keeper switch on Solana). An asset the list does not have at
 * all has no oracle either.
 */
export function autoFollowOffer(
  entry: ChainEntry,
  versions: Target[][],
  assets: BasketAsset[],
): AutoFollowOffer {
  if (!entry.adapter.capabilities.autoFollow)
    return { offered: false, reason: 'switched_off', assets: [] };
  const eligible = new Map(assets.map((a) => [a.id, a.autoFollowEligible]));
  const without = [...new Set(versions.flat().map((t) => t.asset))].filter(
    (id) => eligible.get(id) !== true,
  );
  return without.length
    ? { offered: false, reason: 'no_oracle', assets: without }
    : { offered: true };
}

/** The refusal of auto-follow on a recipe that does not offer it. */
export function refuseAutoFollow(
  entry: ChainEntry,
  offer: Extract<AutoFollowOffer, { offered: false }>,
): never {
  if (offer.reason === 'switched_off')
    throw new Refusal(422, `auto-follow is not available on ${entry.config.name}`, {
      fix: 'Follow it with auto-follow off: you are asked to rebalance when it changes.',
    });
  throw new Refusal(
    422,
    `this shared portfolio holds ${offer.assets.join(', ')}, which has no price oracle on ${entry.config.name}, so it is not rebalanced for you`,
    {
      fix: 'Follow it with auto-follow off: you are asked to rebalance, in one tap, when it changes.',
    },
  );
}

export type SharedContext = {
  principal: Principal;
  chains: ChainRegistry;
  db: Db;
  homeChain(): Promise<ChainId>;
  bySlug(slug: string): Promise<StoredFamily | null>;
  byNameKey(key: string): Promise<StoredFamily | null>;
};

/** A step of a shared-portfolio order before it is a leg. */
export type SharedStep = { chain: ChainId; kind: Leg['kind']; description: string };

/**
 * The family a publish is for: the stored one of that slug, or a new one with the id `familyIdOf(slug)`.
 * Another creator's portfolio is refused, and so is a name that folds to the key of another family.
 */
export async function familyOfPublish(
  req: PublishRequest,
  ctx: Pick<SharedContext, 'bySlug' | 'byNameKey' | 'principal' | 'db'>,
): Promise<{ familyId: string; stored: StoredFamily | null }> {
  const stored = await ctx.bySlug(req.family);
  const familyId = stored?.familyId ?? familyIdOf(req.family);
  if (req.familyId !== undefined && req.familyId !== familyId)
    throw new Refusal(409, 'the family id is not the one of this shared portfolio', {
      fix: 'Read the shared portfolio again.',
    });
  const look = await ctx.byNameKey(nameKeyOf(req.name));
  if (look && look.familyId !== familyId)
    throw new Refusal(409, 'another shared portfolio has this name, or one that reads the same', {
      fix: 'Choose another name.',
    });
  if (stored) {
    const theirs = (chain: ChainId) => {
      const creator = req.creator[chainFamily(chain)];
      const recipe = stored.recipes.find((r) => r.chain === chain);
      return recipe ? recipe.creator !== creator : false;
    };
    const me = await userIdOf(ctx.db, ctx.principal.userId);
    const another =
      req.recipes.some((d) => theirs(d.chain)) ||
      // A family is its creator's on every chain: one with no recipe on this chain yet is not open to
      // anybody else either.
      (stored.creatorUserId !== null && stored.creatorUserId !== me) ||
      (stored.creatorUserId === null && stored.recipes.every((r) => theirs(r.chain)));
    if (another)
      throw new Refusal(409, "this shared portfolio is another creator's", {
        fix: 'Publish yours under another slug.',
      });
  }
  return { familyId, stored };
}

/**
 * A creator's publish, planned: one `publish` step per chain, each the first version (in effect at
 * once) or the next one (in effect after the publish delay), held to the four creator limits against
 * what the chain has now. The limit on time is the chain's to say when the step is built.
 */
export async function planPublish(
  req: PublishRequest,
  ctx: SharedContext,
): Promise<{ familyId: string; steps: SharedStep[] }> {
  if (!holds(ctx.principal, req.creator))
    throw new Refusal(403, 'the creator in the request is not a wallet of the signed-in person');
  checkText(req);
  const chains = req.recipes.map((d) => d.chain);
  if (new Set(chains).size !== chains.length)
    throw new Refusal(422, 'a shared portfolio has one recipe per chain');
  const { familyId } = await familyOfPublish(req, ctx);
  const steps: SharedStep[] = [];
  for (const draft of req.recipes) {
    const family = chainFamily(draft.chain);
    const name = ctx.chains.name(draft.chain);
    // The registry calls on EVM wait for EVM-3's final interface and ADE-2's adapter: the guard
    // refuses them too.
    if (family !== 'solana')
      throw new Refusal(
        501,
        `publishing on ${name} is not built yet: its registry calls wait for EVM-3`,
      );
    const entry = ctx.chains.get(draft.chain);
    assertBuilds(entry);
    const creator = req.creator[family];
    if (!creator)
      throw new Refusal(422, `the creator has no ${family} address, and the recipe is on ${name}`);
    const onchain = await readRecipe(entry, await recipeIdOf(entry, creator, familyId));
    const verdict = checkCreatorLimits(
      onchain ? recipeTargets(onchain.active) : null,
      recipeTargets(draft),
      {
        assets: await entry.adapter.listAssets(),
        now: 0,
        lastPublishAt: null,
        hasPending: Boolean(onchain?.pending),
        publishDelay: 0,
      },
    );
    if (!verdict.ok)
      throw new Refusal(422, verdict.detail, {
        code: 'CREATOR_LIMIT',
        fix: 'Change the weights within the limits a shared portfolio follows.',
      });
    steps.push({
      chain: draft.chain,
      kind: 'publish',
      description: onchain
        ? `Publish the next version of your shared portfolio on ${name}: it takes effect after the publish delay`
        : `Publish your shared portfolio on ${name}: version 1, in effect at once`,
    });
  }
  return { familyId, steps };
}

/**
 * The shared portfolio a person follows, on their own chain (gate ONE-CHAIN): the stored family, its
 * recipe on that chain, and the recipe as the chain has it now. A portfolio with no recipe there is
 * not offered to them.
 */
export async function followedOn(
  slug: string,
  chain: ChainId,
  ctx: Pick<SharedContext, 'chains' | 'bySlug'>,
  version: number | undefined,
) {
  const family = await ctx.bySlug(slug);
  if (!family) throw new Refusal(404, 'no shared portfolio with that slug');
  const entry = ctx.chains.get(chain);
  const stored = family.recipes.find((r) => r.chain === chain);
  if (!stored)
    throw new Refusal(
      422,
      `this shared portfolio is not published on ${entry.config.name}, where your plans live`,
    );
  const onchain = await readRecipe(entry, stored.onchainId);
  if (!onchain)
    throw new Refusal(409, `this shared portfolio is not on ${entry.config.name} any more`);
  if (version !== undefined && version !== onchain.active.version)
    throw new Refusal(
      409,
      `version ${onchain.active.version} of this shared portfolio is in effect, not version ${version}`,
      { code: 'VERSION_CHANGED', fix: 'Read the shared portfolio again.' },
    );
  return { family, entry, recipe: stored, onchain };
}

/**
 * An existing vault of the person's, made to follow a shared portfolio, or its auto-follow switched:
 * `accept_version` where it does not follow the version in effect, then `set_auto_follow` where the
 * switch changes. Auto-follow on is refused on a portfolio that does not offer it (GOLD-ONE-TAP).
 * Nothing is traded: what the vault holds is rebalanced by the one-tap prompt or by the keeper.
 */
export async function planFollow(
  req: FollowRequest,
  ctx: SharedContext,
): Promise<{
  entry: ChainEntry;
  owner: Address;
  version: number;
  steps: SharedStep[];
  needsConsent: ('auto_follow_on' | 'new_asset')[];
}> {
  const chain = await ctx.homeChain();
  const entry = ctx.chains.get(chain);
  assertBuilds(entry);
  const family = chainFamily(chain);
  if (!isAddressOf(family, req.vault))
    throw new Refusal(422, `that vault is not on ${entry.config.name}, where your plans live`);
  const vault = await entry.adapter.getVault(req.vault);
  const mine = ctx.principal.wallets.some((w) => w.family === family && w.address === vault?.owner);
  if (!vault || !mine) throw new Refusal(404, 'no vault of yours at that address');
  const { onchain } = await followedOn(req.family, chain, ctx, req.version);
  const active = onchain.active;
  const steps: SharedStep[] = [];
  const needsConsent: ('auto_follow_on' | 'new_asset')[] = [];
  const name = entry.config.name;
  // Auto-follow on, asked for or already on, is held to the offer whatever else the order does: a
  // vault that keeps auto-follow on and accepts a portfolio holding an asset with no oracle would be
  // keeper-rebalanced into it (gate GOLD-ONE-TAP).
  if (req.autoFollow) {
    const offer = autoFollowOffer(
      entry,
      [active, ...(onchain.pending ? [onchain.pending] : [])].map(recipeTargets),
      await entry.adapter.listAssets(),
    );
    if (!offer.offered) refuseAutoFollow(entry, offer);
  }
  if (vault.recipeOnchainId !== active.onchainId || vault.acceptedVersion !== active.version) {
    // The vault takes the version's weights, assets it has no target on included: the guard asks the
    // person's own tap for every accept.
    needsConsent.push('new_asset');
    steps.push({
      chain,
      kind: 'accept_version',
      description: `Follow version ${active.version} of this shared portfolio: your vault's targets become its weights. Nothing is traded in this step`,
    });
  }
  if (req.autoFollow !== vault.autoFollow) {
    if (req.autoFollow) needsConsent.push('auto_follow_on');
    // Off goes first: the vault takes a new version with the keeper already stopped. On goes last,
    // once the vault follows the version the offer was held to.
    steps[req.autoFollow ? 'push' : 'unshift']({
      chain,
      kind: 'set_auto_follow',
      description: req.autoFollow
        ? `Switch auto-follow on: the keeper on ${name} rebalances the vault when this portfolio changes`
        : 'Switch auto-follow off: you are asked to rebalance when this portfolio changes',
    });
  }
  if (!steps.length)
    throw new Refusal(409, 'the vault already follows this shared portfolio as asked', {
      details: { retryable: false },
    });
  return { entry, owner: vault.owner, version: active.version, steps, needsConsent };
}

/**
 * Once a publish step has confirmed, the family and its recipe are written, as the chain has them
 * (DESIGN-VAULT section 6: a family is created or renamed only then). Nothing is written unless the
 * recipe on the chain is the creator's and one of its versions carries the hash of the order's text:
 * bytes that published other words under this family id leave the server's text as it was.
 */
export async function recordPublished(
  ctx: { db: Db; chains: ChainRegistry; principal: Principal },
  order: { owner: Partial<Record<'solana' | 'evm', string>>; legs: Leg[] },
  req: PublishRequest,
  log: (message: string) => void,
): Promise<void> {
  const familyId = req.familyId ?? familyIdOf(req.family);
  const hash = metaHash(familyText(req, familyId));
  for (const leg of order.legs) {
    if (leg.kind !== 'publish' || leg.status !== 'confirmed') continue;
    const creator = order.owner[chainFamily(leg.chain)];
    if (!creator) continue;
    // Written once: a later read of the order does not ask the chain again.
    if (await hasVersion(ctx.db, familyId, leg.chain, hash)) continue;
    const entry = ctx.chains.get(leg.chain);
    const onchainId = await recipeIdOf(entry, creator, familyId);
    let onchain: Awaited<ReturnType<typeof readRecipe>>;
    try {
      onchain = await readRecipe(entry, onchainId);
    } catch (e) {
      // The order is still answered: the family is written on a later read, once the chain answers.
      if (!(e instanceof ChainError)) throw e;
      log(`the recipe ${onchainId} on ${leg.chain} could not be read: ${e.message}`);
      continue;
    }
    // The id is derived from the creator, so a recipe found there is the creator's.
    if (!onchain) continue;
    if (onchain.active.metaHash !== hash && onchain.pending?.metaHash !== hash) {
      log(`the recipe ${onchainId} on ${leg.chain} carries no version with the text of this order`);
      continue;
    }
    try {
      const recipeId = await writePublished(ctx.db, {
        familyId,
        slug: req.family,
        nameKey: nameKeyOf(req.name),
        name: req.name,
        copy: req.copy,
        creatorUserId: await userIdOf(ctx.db, ctx.principal.userId),
        chain: leg.chain,
        onchainId,
        creator,
      });
      if (!recipeId) {
        log(
          `the family ${familyId} on ${leg.chain} is another creator's: this publish is not written`,
        );
        continue;
      }
      await syncVersions(ctx.db, recipeId, onchain);
    } catch (e) {
      // Another family took the slug or a look-alike name between the order and its landing. The chain
      // has the recipe; the shelf does not show it under a name that is not its own.
      if ((e as { code?: unknown }).code === '23505') {
        log(`the family ${familyId} could not be stored: its slug or name is another family's`);
        continue;
      }
      throw e;
    }
  }
}
