'use client';
import type { ChainId, SharedFamily, SharedRecipe, Target } from '@colosseum/schemas';
import {
  type ChainRecipe,
  familyIdOf,
  familyTextHash,
  readSolanaRecipe,
  vaultOf,
} from '@colosseum/sdk';
import { useEffect, useState } from 'react';
import { chainNode } from '../order/chain-node';
import { deploymentsFor } from '../order/readiness';

// The shared portfolio a follow is held to, read from this app's own node, not from our server (WEB-4).
// The account is the one the registry derives from the creator and the family id; the family id is the
// one this app works out from the slug (`familyIdOf`), the rule every portfolio published through the
// app follows. What it reads takes the place of the API's answer on the screen and in the guard's
// terms. Where it cannot read, it says which reason, and the screen shows the API's answer as
// unverified:
//
//   mock         the chain runs on the mock: there is no chain to read
//   no-node      no node of this chain is set for this app (NEXT_PUBLIC_CHAIN_READ_RPC_<CHAIN>)
//   no-reader    the chain is an EVM chain: this app does not read its registry yet, node or no node
//   no-deployment  no deployment is committed for the chain's network: no mints to read lines with
//   family-id    the portfolio's id is not the one its slug gives: it was not published through the
//                app, and the slug-to-id link is our server's word
//
// Where it has a node and a deployment and still cannot read (the node did not answer, the account is
// not the program's recipe of that creator and family, the server's creator is no address of the
// chain), the read has `failed`: that blocks a follow, as a portfolio the chain does not hold does.

export type ChainCheck =
  | { state: 'reading' }
  | {
      state: 'read';
      recipe: ChainRecipe;
      /** The version in effect as targets: null when a line is a token this app does not list. */
      targets: Target[] | null;
      /** Our server answered something else than the chain holds: another account, version or weights. */
      differs: boolean;
      /**
       * Which version's hash the text shown (name, description) is the text of, worked out here
       * (`familyTextHash`): null when neither, and the page says the text does not match.
       */
      textMatches: 'active' | 'pending' | null;
    }
  /** The registry has no portfolio of this creator and family on the chain. */
  | { state: 'missing' }
  /**
   * This app has a node and a deployment for the chain, and still could not read the portfolio: the
   * node did not answer, or the account at the derived address is not the program's recipe of that
   * creator and family, or the server named a creator that is no address of the chain. A server that
   * lies can cause any of these, so nothing is offered: no buy and no follow, as for `missing`.
   */
  | { state: 'failed' }
  | { state: 'unverified'; why: 'mock' | 'no-node' | 'no-reader' | 'no-deployment' | 'family-id' };

const sameTargets = (a: readonly Target[], b: readonly Target[]) =>
  a.length === b.length &&
  a.every((t, i) => t.asset === b[i]?.asset && t.weightBps === b[i]?.weightBps);

/** Reads the recipe once per family, recipe and chain. */
export function useChainRecipe(
  chain: ChainId,
  mock: boolean,
  family: Pick<SharedFamily, 'slug' | 'familyId' | 'name' | 'copy' | 'kind'> | null,
  recipe: SharedRecipe | null,
): ChainCheck {
  const [check, setCheck] = useState<ChainCheck>({ state: 'reading' });
  const known = family !== null;
  const slug = family?.slug ?? '';
  const familyId = family?.familyId ?? '';
  // The text as the page shows it, hashed here: the same encoding the guard and the registry use.
  const textHash = family
    ? familyTextHash({
        familyId: familyIdOf(family.slug),
        slug: family.slug,
        name: family.name,
        copy: family.copy,
        kind: family.kind,
      })
    : '';
  const creator = recipe?.creator ?? null;
  const onchainId = recipe?.onchainId ?? null;
  const version = recipe?.active.version ?? null;
  const shown = recipe ? JSON.stringify(recipe.active.components) : '';
  useEffect(() => {
    let mine = true;
    const say = (next: ChainCheck) => {
      if (mine) setCheck(next);
    };
    if (mock) say({ state: 'unverified', why: 'mock' });
    else if (!known || familyIdOf(slug) !== familyId)
      say({ state: 'unverified', why: 'family-id' });
    else {
      const deployment = deploymentsFor(chain, false)?.[chain];
      const node = chainNode(chain);
      if (!deployment) say({ state: 'unverified', why: 'no-deployment' });
      else if (deployment.family !== 'solana') say({ state: 'unverified', why: 'no-reader' });
      else if (!node) say({ state: 'unverified', why: 'no-node' });
      // From here this app can read the chain: whatever stops the read stops the follow.
      else if (!creator) say({ state: 'failed' });
      else {
        say({ state: 'reading' });
        readSolanaRecipe(node, deployment, { creator, familyId: familyIdOf(slug) }).then(
          (read) => {
            if (!read) return say({ state: 'missing' });
            const lines = read.active.components;
            const targets = lines.every((l) => l.asset !== null)
              ? lines.map((l) => ({ asset: l.asset as string, weightBps: l.weightBps }))
              : null;
            const api: Target[] = shown ? JSON.parse(shown) : [];
            say({
              state: 'read',
              recipe: read,
              targets,
              textMatches:
                read.active.metaHash === textHash
                  ? 'active'
                  : read.pending?.metaHash === textHash
                    ? 'pending'
                    : null,
              differs:
                read.address !== onchainId ||
                read.active.version !== version ||
                !targets ||
                !sameTargets(targets, api),
            });
          },
          () => say({ state: 'failed' }),
        );
      }
    }
    return () => {
      mine = false;
    };
  }, [chain, mock, known, slug, familyId, creator, onchainId, version, shown, textHash]);
  return check;
}

/**
 * True when `address` is the vault the guard derives from the owner and the plan number, on this
 * chain's committed deployment: a follow names that number in its step, and it has to be the vault the
 * person picked. False when it is another; null where nothing is derived (no deployment, an EVM chain).
 */
export function isVaultOf(
  chain: ChainId,
  mock: boolean,
  owner: string,
  basketId: string,
  address: string,
): boolean | null {
  const deployment = deploymentsFor(chain, mock)?.[chain];
  if (!deployment) return null;
  const derived = vaultOf(deployment, owner, basketId);
  return derived === null ? null : derived === address;
}

/** The id of a new shared portfolio, as the form shows it: `familyIdOf(slug)` of the SDK, the API's rule. */
export const familyIdFor = (slug: string): string => familyIdOf(slug);
