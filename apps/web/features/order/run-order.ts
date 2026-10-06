'use client';
import {
  type BasketLine,
  type ChainId,
  type ConsentKind,
  chainFamily,
  type OrderDetail,
} from '@colosseum/schemas';
import {
  basketIdOfPlan,
  type ChainRead,
  chainReadOf,
  createOrderApi,
  type ExecutionEvent,
  type ExecutionResult,
  execute,
  type PlanTerms,
  type SignedRecord,
  type SignedStore,
} from '@colosseum/sdk';
import { useCallback } from 'react';
import type { SharedTerms } from '../shared/terms';
import { useSigningPort } from '../wallet/signing';
import { useApiFetch } from '../wallet/WalletProvider';
import { chainNode } from './chain-node';
import { targetsOfPlan } from './plan-terms';
import { basketOfPlan, deploymentsFor, onMock } from './readiness';

// The one place in the app that signs: an order, through `execute(order, deps)` of @colosseum/sdk. The
// executor runs the guard on the bytes of every step and asks the wallet only for what the guard
// passed. The whole wallet port is handed to it here and nowhere else: the screen that calls `run` gets
// the answer, never the port. components/shell/product-routes.test.ts holds this file to being the
// only one the app ships that imports the whole port, and the order screen to being the only one that
// imports this file. What it hands the executor is features/wallet/README.md, "Before any product
// screen signs", item 3.

/** Why an order cannot be run in this browser, before anything is asked of the API or the wallet. */
export type NotRunnable =
  /** The chain has no deployment committed for its network: nothing is signed there. */
  | 'no-deployment'
  /** No wallet of the order's family is signed in. */
  | 'no-wallet'
  /** This browser keeps nothing (local storage): a signature could be made twice. */
  | 'no-store'
  /** This browser cannot hold an order to one tab (`navigator.locks`). */
  | 'no-lock'
  /** The plan's lines name another chain than the order's. */
  | 'plan-mismatch';

export type RunOutcome =
  | ExecutionResult
  /** Another tab of this browser is running the same order. Nothing was done here. */
  | { status: 'elsewhere' }
  | { status: 'not-runnable'; why: NotRunnable }
  /** Something the executor did not answer for: a store that failed mid-way, a bug. */
  | { status: 'crashed'; message: string };

export type RunInput = {
  /** The order exactly as the review screen showed it when the person approved it. */
  order: OrderDetail;
  /** The plan it buys, as the plan screen showed it: its id and its lines. */
  plan: {
    proposalId: string;
    lines: readonly BasketLine[];
    /** The person the order is for: a plan made from a link numbers their vault with it. */
    userId: string;
    /** This browser kept the plan as one made from a link: for an order that states no number. */
    linked?: boolean;
  };
  /**
   * For an order about a shared portfolio: the terms its screen showed (features/shared/terms.ts),
   * which take the plan's place.
   */
  terms?: SharedTerms;
  /** What the person ticked on the review screen, for this order. */
  consents: readonly ConsentKind[];
  /** Only after `needs_review`, and only with what that answer said, once the person approved again. */
  approvedAgain?: { legId: string; signedTimes: number };
  onEvent?: (event: ExecutionEvent) => void;
  /** Set `aborted` to stop between steps: a signature already made is still reported. */
  signal?: { readonly aborted: boolean };
};

/** The caller's own read of the chain, or none: on the mock no node is asked anything. */
export function chainReadFor(chain: ChainId, mock: boolean): ChainRead | undefined {
  if (mock) return undefined;
  const node = chainNode(chain);
  if (!node) return undefined;
  return chainReadOf(chainFamily(chain) === 'solana' ? { solana: node } : { evm: node });
}

/**
 * The guard's terms for an order about a shared portfolio, from what its screen showed: a buy follows
 * the portfolio's version from a vault numbered by the family's id, with auto-follow off; a follow
 * names the vault the person picked; a publish names the form's family id, text and weights.
 */
export function planTermsOf(terms: SharedTerms): PlanTerms {
  switch (terms.kind) {
    case 'family':
      return { basketId: basketIdOfPlan(terms.familyId), follow: terms.follow, autoFollow: false };
    case 'follow':
      return {
        basketId: terms.basketId,
        ...(terms.follow ? { follow: terms.follow } : {}),
        autoFollow: terms.autoFollow,
      };
    case 'publish':
      return {
        basketId: '0',
        publish: {
          action: terms.action,
          familyId: terms.familyId,
          components: terms.components,
          text: terms.text,
          version: terms.version,
        },
      };
  }
}

const SIGNED = (key: string) => `tf-signed:${key}`;

/**
 * What has been signed, by order and step, in local storage: it outlives the page and the tab, and the
 * tabs of this browser share it. A record that does not read comes back as something the executor
 * cannot read, and it then asks the person instead of signing again. A write that fails throws, and
 * the executor then stops.
 */
export const localSigned: SignedStore = {
  get(key) {
    const raw = window.localStorage.getItem(SIGNED(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as SignedRecord;
    } catch {
      return { unreadable: raw } as unknown as SignedRecord;
    }
  },
  set(key, record) {
    window.localStorage.setItem(SIGNED(key), JSON.stringify(record));
  },
};

/**
 * The vault's number for a plan's order: the one the order states, held to a number this app works out
 * itself (the plan's, or the person's own for a plan made from a link, gate `AGENT-LINK`); null when it
 * is neither. An order that states none, made before the API kept it, is numbered as this browser kept
 * the plan.
 */
export function planNumberOf(
  stated: string | undefined,
  plan: { proposalId: string; userId: string; linked?: boolean },
): string | null {
  // A plan this browser kept as one made from a link has the person's own number and no other: an
  // API that states the plan's shared number for it would lead the link to this vault.
  const own = plan.linked
    ? [basketOfPlan(plan.proposalId, plan.userId)]
    : [basketOfPlan(plan.proposalId), basketOfPlan(plan.proposalId, plan.userId)];
  if (stated !== undefined) return own.includes(stated) ? stated : null;
  return basketOfPlan(plan.proposalId, plan.linked ? plan.userId : null);
}

/** True when this browser keeps what is written to local storage. */
function storageWorks(): boolean {
  try {
    const probe = 'tf-signed:probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** The order runner. `run` takes an order the person approved and walks it as far as it can go. */
export function useOrderRunner(): { run: (input: RunInput) => Promise<RunOutcome> } {
  const port = useSigningPort();
  const apiFetch = useApiFetch();

  const run = useCallback(
    async (input: RunInput): Promise<RunOutcome> => {
      const { order } = input;
      const chain = order.legs[0]?.chain;
      if (!chain) return { status: 'not-runnable', why: 'no-deployment' };
      const mock = onMock(port, chain);
      const deployments = deploymentsFor(chain, mock);
      const deployment = deployments?.[chain];
      if (!deployments || !deployment) return { status: 'not-runnable', why: 'no-deployment' };
      if (!port.active(chainFamily(chain))) return { status: 'not-runnable', why: 'no-wallet' };
      const plan = input.terms ? planTermsOf(input.terms) : null;
      const targets = input.terms ? [] : targetsOfPlan(input.plan.lines, chain, deployment.cash);
      if (!targets) return { status: 'not-runnable', why: 'plan-mismatch' };
      const basketId = input.terms ? null : planNumberOf(order.basketId, input.plan);
      if (!input.terms && basketId === null)
        return { status: 'not-runnable', why: 'plan-mismatch' };
      if (!storageWorks()) return { status: 'not-runnable', why: 'no-store' };
      if (typeof navigator === 'undefined' || !navigator.locks)
        return { status: 'not-runnable', why: 'no-lock' };

      const go = () =>
        execute(order, {
          api: createOrderApi(apiFetch),
          signer: port,
          deployments,
          plan: plan ?? {
            basketId: basketId ?? '',
            targets,
            autoFollow: false,
          },
          consents: input.consents,
          signed: localSigned,
          chainRead: chainReadFor(chain, mock),
          ...(input.approvedAgain ? { approvedAgain: input.approvedAgain } : {}),
          onEvent: input.onEvent,
          signal: input.signal,
        });
      try {
        // One run of an order at a time, across the tabs of this browser: a second tab that ran while
        // the first had asked the wallet and not yet written down what it signed would sign again.
        return await navigator.locks.request(`order:${order.id}`, { ifAvailable: true }, (lock) =>
          lock ? go() : ({ status: 'elsewhere' } as const),
        );
      } catch (e) {
        return { status: 'crashed', message: e instanceof Error ? e.message : String(e) };
      }
    },
    [port, apiFetch],
  );
  return { run };
}
