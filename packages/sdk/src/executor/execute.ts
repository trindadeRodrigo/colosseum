import type {
  Attempt,
  BasketTx,
  ChainId,
  ConsentKind,
  Leg,
  OrderDetail,
  OrderError,
  ReportLegRequest,
  WalletErrorCode,
} from '@colosseum/schemas';
import { approvedSteps } from '../guard/approved';
import { GuardRefusal, isGuardRefusal } from '../guard/refusal';
import { type Guarded, isGuarded } from '../guard/run';
import type { ApprovedStep, GuardDeployments, GuardInput, PlanTerms } from '../guard/types';
import { isApiRefusal, type OrderApi } from './api';
import { walletFailure } from './wallet';

// The order executor: one state machine that walks an order step by step. For each step it asks the
// API to build, holds the bytes to the approved step with the guard, asks the wallet to sign, reports
// to the API, and waits for the chain. The web and an outside agent run the same one.
//
// What it keeps to:
//   The signer is never called without a pass of the guard on those exact bytes.
//   The same bytes are never signed twice: what was signed is remembered, and reported again instead.
//   Every transition is written to the API before the next step: a build, a report, a cancel.
//   What was approved is worked out once, from the order it was handed. The API's later answers are
//   read for what has happened, never for what a step may do.

/** What the executor needs of a wallet: the web's `WalletPort` fits as it is. */
export type OrderSigner = {
  caps(chain: ChainId): { signOnly: boolean };
  /** Signs and hands the signed transactions back, one per transaction given. Throws a `WalletError`. */
  sign(chain: ChainId, txs: BasketTx[]): Promise<string[]>;
  /** For a wallet that cannot sign without sending: signs, sends, and answers the transaction's id. */
  send(chain: ChainId, tx: BasketTx): Promise<{ txId: string }>;
};

/**
 * What was signed, by the bytes it was signed for. A `Map` fits. One that outlives the page (session
 * storage) lets a reload report a signature the page made and never got to report, without asking the
 * wallet again.
 */
export type SignedStore = {
  get(key: string): ReportLegRequest | undefined | Promise<ReportLegRequest | undefined>;
  set(key: string, signed: ReportLegRequest): unknown;
};

/** How long the executor keeps trying before it hands back `waiting`. */
export type Patience = {
  /** A report the chain has not seen yet is sent again this many times, this far apart. */
  reportTries: number;
  reportDelayMs: number;
  /** A step that was sent is read again this many times, this far apart, until it lands. */
  landingTries: number;
  landingDelayMs: number;
  /** An earlier attempt that can still land is waited out this many times, this far apart. */
  waitTries: number;
  waitDelayMs: number;
  /** A step is built again this many times after its transaction expired without landing. */
  rebuilds: number;
  /** A call that failed without an answer (the network) is made again this many times, this far apart. */
  apiTries: number;
  apiDelayMs: number;
};
export const DEFAULT_PATIENCE: Patience = {
  reportTries: 20,
  reportDelayMs: 1500,
  landingTries: 80,
  landingDelayMs: 1500,
  waitTries: 80,
  waitDelayMs: 1500,
  rebuilds: 2,
  apiTries: 3,
  apiDelayMs: 1000,
};

export type ExecutionEvent = {
  legId: string;
  /** What the executor is about to do for the step, or what the step has come to. */
  phase: 'building' | 'checking' | 'signing' | 'reporting' | 'landing' | 'waiting' | 'settled';
  /** The order as the API last answered it: every step's status and explorer link. */
  order: OrderDetail;
};

export type ExecutorDeps = {
  api: Pick<OrderApi, 'getOrder' | 'buildLeg' | 'reportLeg' | 'cancelLeg'>;
  signer: OrderSigner;
  /** The app's own configuration of each chain. Never taken from the API that builds the transactions. */
  deployments: GuardDeployments;
  /** What the review screen showed beside the order: the plan's number, its targets, what it follows. */
  plan: PlanTerms;
  /** The consents the person gave on the review screen, for this order. */
  consents?: readonly ConsentKind[];
  signed?: SignedStore;
  patience?: Partial<Patience>;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: ExecutionEvent) => void;
  /** Set `aborted` to stop between steps. A signature already made is still reported. */
  signal?: { readonly aborted: boolean };
};

export type ExecutionResult =
  /** Every step is confirmed. */
  | { status: 'done'; order: OrderDetail }
  /** The guard refused: the order itself, or the transaction built for a step. Nothing was signed for it. */
  | { status: 'refused'; order: OrderDetail; legId: string | null; refusal: GuardRefusal }
  /** The wallet said no, or failed. The step's attempt was cancelled, and the order can be run again. */
  | {
      status: 'cancelled';
      order: OrderDetail;
      legId: string;
      wallet: { code: WalletErrorCode; message: string };
    }
  /** A step's transaction landed and reverted. It is not sent again: a new attempt is the person's to ask for. */
  | { status: 'failed'; order: OrderDetail; legId: string; error: Leg['error'] }
  /** The order ran out of time. */
  | { status: 'expired'; order: OrderDetail }
  /** EVM: a step of another order of this wallet can still land. Report or cancel that one first. */
  | {
      status: 'blocked';
      order: OrderDetail;
      legId: string;
      blocking: { orderId: string; legId: string };
    }
  /** Nothing is wrong and nothing more can be done now. Run the order again later. */
  | {
      status: 'waiting';
      order: OrderDetail;
      legId: string;
      /** `landing`: sent and not landed yet. `in_flight`: an earlier attempt can still land. `unseen`: reported, and the chain has not seen it. `stopped`: the caller asked to stop. */
      why: 'landing' | 'in_flight' | 'unseen' | 'stopped';
    }
  /** The API refused or could not be reached, in a way no step here can get around. */
  | {
      status: 'error';
      order: OrderDetail;
      legId: string | null;
      error: { status: number | null; message: string; body?: OrderError };
    };

type Guard = (input: GuardInput) => Guarded;

const SETTLED = new Set<Leg['status']>(['confirmed', 'skipped']);

/** What names the bytes of one attempt: the message, and on EVM the nonce it is signed on. */
const keyOf = (chain: ChainId, messageHash: string, nonce: number | null | undefined) =>
  `${chain}:${messageHash}:${nonce ?? ''}`;

/** The executor around a guard. `execute` is this with the real one; nothing else is exported from the package. */
export function makeExecute(guard: Guard) {
  return async function execute(order: OrderDetail, deps: ExecutorDeps): Promise<ExecutionResult> {
    const { api, signer } = deps;
    const patience = { ...DEFAULT_PATIENCE, ...deps.patience };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const signed: SignedStore = deps.signed ?? new Map<string, ReportLegRequest>();
    const consents = deps.consents ?? [];
    /** The order as the API last answered it. Only what has happened is read from it. */
    let seen = order;

    const failure = (e: unknown, legId: string | null): ExecutionResult => ({
      status: 'error',
      order: seen,
      legId,
      error: isApiRefusal(e)
        ? { status: e.status, message: e.body.error, body: e.body }
        : {
            status: null,
            message: e instanceof Error ? e.message : 'the API could not be reached',
          },
    });
    /** A call that got no answer is made again. One the API answered, with a yes or a no, is not. */
    const call = async <T>(run: () => Promise<T>): Promise<T> => {
      for (let tries = 1; ; tries += 1) {
        try {
          return await run();
        } catch (e) {
          if (isApiRefusal(e) || tries >= patience.apiTries) throw e;
          await sleep(patience.apiDelayMs);
        }
      }
    };
    const read = async () => {
      seen = await call(() => api.getOrder(order.id));
    };
    const tell = (legId: string, phase: ExecutionEvent['phase']) =>
      deps.onEvent?.({ legId, phase, order: seen });
    const expired = (e: unknown) =>
      isApiRefusal(e) && (e.status === 410 || e.body.code === 'ORDER_EXPIRED');

    // ---- what was approved: once, from the order as it was handed over
    const chain = order.legs[0]?.chain;
    const deployment = chain ? deps.deployments[chain] : undefined;
    let steps: ApprovedStep[];
    try {
      if (!chain || !deployment)
        throw new GuardRefusal(
          'unsupported',
          `no deployment was given for ${chain ?? 'this order'}`,
        );
      steps = approvedSteps(order, deps.plan, deployment);
    } catch (e) {
      if (!isGuardRefusal(e)) throw e;
      return { status: 'refused', order: seen, legId: e.legId, refusal: e };
    }

    try {
      await read();
    } catch (e) {
      return failure(e, null);
    }
    if (seen.id !== order.id)
      return failure(new Error('the API answered with another order'), null);

    /** Says the latest attempt will not be sent, so the step can be built again. Never throws. */
    const cancel = async (legId: string): Promise<'closed' | 'wait' | 'read'> => {
      try {
        seen = await call(() => api.cancelLeg(order.id, legId));
        return 'closed';
      } catch (e) {
        // On Solana an attempt that can still land is closed only by time.
        if (isApiRefusal(e) && e.body.details?.retryable) return 'wait';
        try {
          await read();
        } catch {
          // The order is read again at the top of the loop, or by the next run.
        }
        return 'read';
      }
    };

    const report = async (
      legId: string,
      proof: ReportLegRequest,
    ): Promise<ExecutionResult | null> => {
      tell(legId, 'reporting');
      for (let tries = 1; ; tries += 1) {
        try {
          seen = await call(() => api.reportLeg(order.id, legId, proof));
          return null;
        } catch (e) {
          if (!isApiRefusal(e)) return failure(e, legId);
          if (expired(e)) return { status: 'expired', order: seen };
          // The chain has not seen the transaction yet: that is not a refusal of it.
          if (e.body.details?.retryable) {
            if (tries >= patience.reportTries)
              return { status: 'waiting', order: seen, legId, why: 'unseen' };
            await sleep(patience.reportDelayMs);
            continue;
          }
          // Refused for good. If the step has moved on all the same, the order says so.
          try {
            await read();
          } catch (again) {
            return failure(again, legId);
          }
          const now = seen.legs.find((l) => l.id === legId)?.status;
          return now === 'sent' || now === 'confirmed' || now === 'failed'
            ? null
            : failure(e, legId);
        }
      }
    };

    /** The one place the wallet is asked for anything: a pass of the guard goes in, a signature comes out. */
    const sign = async (pass: Guarded): Promise<ReportLegRequest> => {
      if (!isGuarded(pass)) throw new Error('only what the guard passed is signed');
      const { tx } = pass;
      if (!signer.caps(tx.chainId).signOnly) {
        const { txId } = await signer.send(tx.chainId, tx);
        return { txId };
      }
      const [signedTx, ...more] = await signer.sign(tx.chainId, [tx]);
      if (typeof signedTx !== 'string' || !signedTx || more.length)
        throw Object.assign(new Error('the wallet did not hand back one signed transaction'), {
          code: 'changed',
        });
      return { signedTx };
    };

    const runStep = async (step: ApprovedStep): Promise<ExecutionResult | null> => {
      const { legId } = step;
      let builds = 0;
      const waited = { landing: 0, in_flight: 0 };
      const reported = new Set<string>();
      const wait = async (why: 'landing' | 'in_flight'): Promise<ExecutionResult | null> => {
        waited[why] += 1;
        const limit = why === 'landing' ? patience.landingTries : patience.waitTries;
        if (waited[why] > limit) return { status: 'waiting', order: seen, legId, why };
        tell(legId, why === 'landing' ? 'landing' : 'waiting');
        await sleep(why === 'landing' ? patience.landingDelayMs : patience.waitDelayMs);
        try {
          await read();
        } catch (e) {
          return failure(e, legId);
        }
        return null;
      };

      for (;;) {
        const leg = seen.legs.find((l) => l.id === legId);
        if (!leg) return failure(new Error('the order the API has is not the one approved'), legId);
        if (SETTLED.has(leg.status)) {
          tell(legId, 'settled');
          return null;
        }
        if (leg.status === 'failed') {
          tell(legId, 'settled');
          return { status: 'failed', order: seen, legId, error: leg.error };
        }
        // A transaction that was sent is followed to its end, whatever has become of the order since.
        if (leg.status === 'sent') {
          const stop = await wait('landing');
          if (stop) return stop;
          continue;
        }
        if (seen.status === 'expired') return { status: 'expired', order: seen };
        if (deps.signal?.aborted) return { status: 'waiting', order: seen, legId, why: 'stopped' };

        // ---- an attempt that was built and never reported: a reload, or an answer that was lost
        const latest: Attempt | undefined = seen.attempts.find(
          (a) => a.legId === legId && a.n === leg.attempt,
        );
        if (leg.status === 'built' && latest) {
          const key = keyOf(leg.chain, latest.messageHash, latest.nonce);
          const held = await signed.get(key);
          if (held && !reported.has(key)) {
            reported.add(key);
            const stop = await report(legId, held);
            if (stop) return stop;
            continue;
          }
          // Not signed here, or signed and the bytes are gone: it is closed so the step can be built
          // again. On an EVM chain the rebuild shares its nonce, so only one of the two can land.
          const closed = await cancel(legId);
          if (closed === 'closed') continue;
          // It can still land (Solana: only time closes it), or the API would not say. Either way the
          // order is read again after a pause, and not for ever.
          const stop = await wait('in_flight');
          if (stop) return stop;
          continue;
        }

        // ---- build
        if (builds > patience.rebuilds)
          return failure(
            new Error(`the step did not land in ${builds} attempts: run the order again`),
            legId,
          );
        tell(legId, 'building');
        let built: Awaited<ReturnType<OrderApi['buildLeg']>>;
        try {
          built = await call(() => api.buildLeg(order.id, legId));
        } catch (e) {
          if (!isApiRefusal(e)) return failure(e, legId);
          if (expired(e)) return { status: 'expired', order: seen };
          const blocking = e.body.details?.blocking;
          if (blocking) return { status: 'blocked', order: seen, legId, blocking };
          // The API knows something this run does not: an attempt whose answer was lost, a step that
          // landed meanwhile. The order says which; if it says nothing new, the refusal stands.
          const before = `${leg.status}:${leg.attempt}`;
          try {
            await read();
          } catch (again) {
            return failure(again, legId);
          }
          const now = seen.legs.find((l) => l.id === legId);
          if (now && `${now.status}:${now.attempt}` !== before) continue;
          if (e.body.details?.retryable) {
            const stop = await wait('in_flight');
            if (stop) return stop;
            continue;
          }
          return failure(e, legId);
        }
        builds += 1;
        const { tx, attempt } = built;

        // ---- the guard: these bytes are the step the person approved, or nothing is signed
        tell(legId, 'checking');
        let pass: Guarded;
        try {
          if (
            attempt?.legId !== legId ||
            tx?.attemptId !== attempt.id ||
            attempt.messageHash !== tx.messageHash
          )
            throw new GuardRefusal(
              'step',
              'the API answered with a transaction and an attempt that are not of this step',
              legId,
            );
          pass = guard({ step, tx, deployment, consents });
        } catch (e) {
          if (!isGuardRefusal(e)) throw e;
          await cancel(legId);
          return { status: 'refused', order: seen, legId, refusal: e };
        }

        // ---- sign, unless these very bytes were signed before: then what was signed is reported again
        const key = keyOf(pass.tx.chainId, pass.tx.messageHash, pass.tx.evm?.nonce);
        let proof = await signed.get(key);
        if (!proof) {
          tell(legId, 'signing');
          try {
            proof = await sign(pass);
          } catch (e) {
            const wallet = walletFailure(e);
            await cancel(legId);
            // A blockhash that went stale before the wallet signed: the step is built again.
            if (wallet.code === 'expired' && builds <= patience.rebuilds) continue;
            return { status: 'cancelled', order: seen, legId, wallet };
          }
          await signed.set(key, proof);
        }
        reported.add(key);
        const stop = await report(legId, proof);
        if (stop) return stop;
      }
    };

    try {
      for (const step of steps) {
        const stop = await runStep(step);
        if (stop) return stop;
      }
      await read();
    } catch (e) {
      if (isGuardRefusal(e)) return { status: 'refused', order: seen, legId: e.legId, refusal: e };
      return failure(e, null);
    }
    return { status: 'done', order: seen };
  };
}
