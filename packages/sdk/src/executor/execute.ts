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
import { familyOf } from '../guard/context';
import { GuardRefusal, isGuardRefusal } from '../guard/refusal';
import { type Guarded, isGuarded } from '../guard/run';
import { count, isObject, text } from '../guard/strict';
import type {
  ApprovedStep,
  GuardDeployment,
  GuardDeployments,
  GuardInput,
  PlanTerms,
} from '../guard/types';
import { isApiRefusal, type OrderApi } from './api';
import type { ChainRead, Fate } from './chain-read';
import { heldToPass } from './signed';
import { walletFailure } from './wallet';

// The order executor: one state machine that walks an order step by step. For each step it asks the
// API to build, holds the bytes to the approved step with the guard, asks the wallet to sign, reports
// to the API, and waits for the chain. The web and an outside agent run the same one.
//
// What it keeps to:
//   The signer is never called without a pass of the guard on those exact bytes.
//   One approved step gets one signature. What was signed is remembered by order and step, and is
//   reported again instead of made again. A second signature needs proof that the first can never
//   land, read from the chain by the caller's own connection, or the person approving the step again.
//   The API's word that a transaction did not land is never enough: it is the one party that gains
//   from a second signature.
//   What a wallet hands back is read before it is reported: it is the transaction the guard passed.
//   Every transition is written to the API before the next step: a build, a report, a cancel.
//   What was approved is worked out once, from the order it was handed. The API's later answers are
//   read for what has happened, never for what a step may do.

/** What the executor needs of a wallet: the web's `WalletPort` fits as it is. */
export type OrderSigner = {
  /** The account that signs for a wallet family, or null when none is connected. */
  active(family: 'solana' | 'evm'): { address: string } | null;
  caps(chain: ChainId): { signOnly: boolean };
  /** Signs and hands the signed transactions back, one per transaction given. Throws a `WalletError`. */
  sign(chain: ChainId, txs: BasketTx[]): Promise<string[]>;
  /** For a wallet that cannot sign without sending: signs, sends, and answers the transaction's id. */
  send(chain: ChainId, tx: BasketTx): Promise<{ txId: string }>;
};

/** What is remembered of the signatures an approved step has had. */
export type SignedRecord = {
  /** How many times the wallet has signed the step, counting one it was asked for and never answered. */
  times: number;
  chain: ChainId;
  /** The message last signed for the step. */
  messageHash: string;
  /**
   * What the wallet handed back for it: what is reported, and what the chain is asked about. Null when
   * a wallet that sends by itself was asked and its answer never came: it may have sent.
   */
  proof: ReportLegRequest | null;
};

/**
 * What was signed, by order and step (`signedKey`). It has to outlive whatever runs the order: in a
 * browser the page and the tab (local storage), for an agent the process. A store that is lost forgets
 * that a step was signed, and a `Map` made anew for each run remembers nothing.
 */
export type SignedStore = {
  get(key: string): SignedRecord | undefined | Promise<SignedRecord | undefined>;
  set(key: string, record: SignedRecord): unknown;
};

/** The key a step's record is kept under. */
export const signedKey = (orderId: string, legId: string) => `${orderId}:${legId}`;

const readable = (v: unknown): v is SignedRecord =>
  isObject(v) &&
  count(v.times, 0) &&
  text(v.chain) &&
  typeof v.messageHash === 'string' &&
  (v.proof === null ||
    (isObject(v.proof) &&
      Object.keys(v.proof).length === 1 &&
      (text(v.proof.signedTx) || text(v.proof.txId))));

/** What a wallet that sends by itself says when it sent nothing. Any other failure may have sent. */
const NOT_SENT = new Set<WalletErrorCode>([
  'rejected',
  'expired',
  'no_gas',
  'wrong_chain',
  'not_connected',
  'wrong_account',
  'unsupported',
]);
const FATES: readonly Fate[] = ['landed', 'open', 'gone', 'unknown'];

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
  /** `deploymentsOf(network)` for each chain. Never made from what the API answers. */
  deployments: GuardDeployments;
  /** What the review screen showed beside the order: the plan's number, its targets, what it follows. */
  plan: PlanTerms;
  /** The consents the person gave on the review screen, for this order. */
  consents?: readonly ConsentKind[];
  /** What has been signed, by order and step. Without it nothing is signed. */
  signed: SignedStore;
  /**
   * The caller's own read of the chain (`chainReadOf`), never the API. Left out, a step that was signed
   * once is not signed again by the executor: it answers `needs_review`.
   */
  chainRead?: ChainRead;
  /**
   * The person approved a step again after a `needs_review`: that answer's `legId` and `signedTimes`,
   * handed back. Good for one more signature of that step, and for nothing once the chain says the
   * earlier one landed or can still land.
   */
  approvedAgain?: { legId: string; signedTimes: number };
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
  /**
   * The step was signed before, the API does not have it as sent, and nothing proves the earlier
   * signature can never land. Signing again could make the step happen twice, so it is the person's to
   * approve again: show them, and run the order with `approvedAgain` set to this `legId` and
   * `signedTimes`. `unproven`: no read of the chain was given, or it could not tell. `asked`: a wallet
   * that sends by itself was asked and never answered. `unreadable`: what the store holds for the step
   * cannot be read.
   */
  | {
      status: 'needs_review';
      order: OrderDetail;
      legId: string;
      signedTimes: number;
      why: 'unproven' | 'asked' | 'unreadable';
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

/** The executor around a guard. `execute` is this with the real one; nothing else is exported from the package. */
export function makeExecute(guard: Guard) {
  return async function execute(order: OrderDetail, deps: ExecutorDeps): Promise<ExecutionResult> {
    const { api, signer } = deps;
    const patience = { ...DEFAULT_PATIENCE, ...deps.patience };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const consents = deps.consents ?? [];
    /** However the API answers, a step's loop turns this many times at most. */
    const maxTurns =
      patience.landingTries +
      patience.waitTries +
      patience.reportTries +
      8 * (patience.rebuilds + 2);
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
    let deployment: GuardDeployment;
    let steps: ApprovedStep[];
    let owner: string;
    try {
      const given = chain ? deps.deployments[chain] : undefined;
      if (!chain || !given)
        throw new GuardRefusal(
          'unsupported',
          `no deployment was given for ${chain ?? 'this order'}`,
        );
      deployment = given;
      steps = approvedSteps(order, deps.plan, deployment);
      // The order is the wallet's own. An order that names another owner would have every address
      // derived from that owner, so it is refused here, before the API is asked for anything.
      const family = familyOf(chain);
      owner = order.owner[family] ?? '';
      if (!owner || signer.active(family)?.address !== owner)
        throw new GuardRefusal(
          'signer',
          "the order's owner is not the account this wallet signs with",
        );
    } catch (e) {
      if (!isGuardRefusal(e)) throw e;
      return { status: 'refused', order: seen, legId: e.legId, refusal: e };
    }
    if (typeof deps.signed?.get !== 'function' || typeof deps.signed.set !== 'function')
      return failure(
        new Error('nothing was given to remember what is signed in, so nothing is signed'),
        null,
      );

    /** What this run signed, whatever the store does with it afterwards. */
    const mine = new Map<string, SignedRecord>();
    const recall = async (key: string): Promise<SignedRecord | 'unreadable' | undefined> => {
      const held: unknown = mine.get(key) ?? (await deps.signed.get(key));
      if (held === undefined || held === null) return undefined;
      return readable(held) ? held : 'unreadable';
    };
    const remember = async (key: string, record: SignedRecord) => {
      mine.set(key, record);
      await deps.signed.set(key, record);
    };
    /** What became of the last signature of a step, by the chain itself. Anything else is not knowing. */
    const fateOf = async (record: SignedRecord): Promise<Fate> => {
      if (!record.proof || !deps.chainRead) return 'unknown';
      try {
        const fate = await deps.chainRead.fateOf({
          chain: record.chain,
          owner,
          proof: record.proof,
        });
        return FATES.includes(fate) ? fate : 'unknown';
      } catch {
        return 'unknown';
      }
    };

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

    type Made =
      | { record: SignedRecord & { proof: ReportLegRequest } }
      | { wallet: { code: WalletErrorCode; message: string }; unknown: boolean };
    const changed = (message: string) => Object.assign(new Error(message), { code: 'changed' });
    /**
     * The one place the wallet is asked for anything: a pass of the guard goes in, and what was signed
     * comes out, already written down under the order and the step. `unknown` is a wallet that sends by
     * itself and failed without saying whether it sent.
     */
    const sign = async (
      pass: Guarded,
      key: string,
      before: SignedRecord | undefined,
    ): Promise<Made> => {
      if (!isGuarded(pass)) throw new Error('only what the guard passed is signed');
      const { tx } = pass;
      const now = {
        times: (before?.times ?? 0) + 1,
        chain: tx.chainId,
        messageHash: tx.messageHash,
      };
      if (!signer.caps(tx.chainId).signOnly) {
        // It is written down that the wallet was asked before it is asked: a page that dies between
        // the two does not ask a second time.
        await remember(key, { ...now, proof: null });
        try {
          const { txId } = await signer.send(tx.chainId, tx);
          if (typeof txId !== 'string' || !txId)
            throw new Error('the wallet did not hand back the id of what it sent');
          const record = { ...now, proof: { txId } };
          await remember(key, record);
          return { record };
        } catch (e) {
          const wallet = walletFailure(e);
          const unknown = !NOT_SENT.has(wallet.code);
          if (!unknown)
            await remember(
              key,
              before ?? { times: 0, chain: tx.chainId, messageHash: '', proof: null },
            );
          return { wallet, unknown };
        }
      }
      let signedTx: string;
      try {
        const [first, ...more] = await signer.sign(tx.chainId, [tx]);
        if (typeof first !== 'string' || !first || more.length)
          throw changed('the wallet did not hand back one signed transaction');
        try {
          heldToPass(pass, deployment, first);
        } catch (e) {
          throw changed(e instanceof Error ? e.message : 'the wallet signed something else');
        }
        signedTx = first;
      } catch (e) {
        // Nothing left the wallet's hands but what came back here, and that is dropped.
        return { wallet: walletFailure(e), unknown: false };
      }
      const record = { ...now, proof: { signedTx } };
      await remember(key, record);
      return { record };
    };

    const runStep = async (step: ApprovedStep): Promise<ExecutionResult | null> => {
      const { legId } = step;
      const key = signedKey(order.id, legId);
      let builds = 0;
      let closes = 0;
      let turns = 0;
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

      const review = (
        why: 'unproven' | 'asked' | 'unreadable',
        signedTimes: number,
      ): ExecutionResult => ({ status: 'needs_review', order: seen, legId, signedTimes, why });
      const approvedFor = (times: number) =>
        deps.approvedAgain?.legId === legId && deps.approvedAgain.signedTimes === times;

      /**
       * The step was signed before and a new attempt has been built for it. Null: it may be signed
       * once more. `rebuild`: go round again. Anything else is where the run stops.
       */
      const again = async (
        record: SignedRecord | 'unreadable',
      ): Promise<ExecutionResult | 'rebuild' | null> => {
        if (record === 'unreadable') {
          if (approvedFor(0)) return null;
          await cancel(legId);
          return review('unreadable', 0);
        }
        let fate = await fateOf(record);
        if (fate === 'gone') return null;
        if (fate === 'open') {
          // It can still land. The attempt just built is given up, and the chain is asked again until
          // the first has landed or no longer can. The API is not asked: it has said what it says.
          await cancel(legId);
          for (let tries = 0; fate === 'open' && tries < patience.waitTries; tries += 1) {
            tell(legId, 'waiting');
            await sleep(patience.waitDelayMs);
            fate = await fateOf(record);
          }
          if (fate === 'open') return { status: 'waiting', order: seen, legId, why: 'in_flight' };
          try {
            await read();
          } catch (e) {
            return failure(e, legId);
          }
          return 'rebuild';
        }
        if (fate === 'landed') {
          // The chain has the step's transaction. The API is told once more; if it still does not
          // have the step as sent, nothing more is signed for it, whoever approves.
          await cancel(legId);
          const { proof } = record;
          try {
            if (proof) seen = await call(() => api.reportLeg(order.id, legId, proof));
          } catch {
            try {
              await read();
            } catch (e) {
              return failure(e, legId);
            }
          }
          const now = seen.legs.find((l) => l.id === legId)?.status;
          if (now === 'sent' || now === 'confirmed' || now === 'failed') return 'rebuild';
          return failure(
            new Error(
              "this step's transaction is on the chain and the API does not have it: nothing more is signed for it",
            ),
            legId,
          );
        }
        // Nothing proves the earlier signature dead. Only the person can say sign again.
        if (approvedFor(record.times)) return null;
        await cancel(legId);
        return review(record.proof ? 'unproven' : 'asked', record.times);
      };

      for (;;) {
        turns += 1;
        if (turns > maxTurns)
          return failure(new Error('the step did not settle: run the order again'), legId);
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
        const record = await recall(key);
        const before = record === 'unreadable' ? undefined : record;
        if (leg.status === 'built' && latest) {
          const held = before?.messageHash === latest.messageHash ? before : undefined;
          if (held?.proof && !reported.has(latest.id)) {
            reported.add(latest.id);
            const stop = await report(legId, held.proof);
            if (stop) return stop;
            continue;
          }
          // A wallet that sends by itself was asked for exactly this attempt and never answered. It
          // may be on its way, so the attempt is not closed: the person looks first.
          if (held && held.proof === null && held.times > 0 && !approvedFor(held.times))
            return review('asked', held.times);
          // Not signed here: it is closed so the step can be built again. Whether a step that was
          // signed before may be signed again is settled where the wallet is asked, not here.
          const closed = await cancel(legId);
          const after = seen.legs.find((l) => l.id === legId);
          // Closed, and the order shows it: the step is built again at the top of the loop. An API
          // that answers each close with a new attempt is not followed round for ever.
          if (
            closed === 'closed' &&
            !(after?.status === 'built' && after.attempt === leg.attempt)
          ) {
            closes += 1;
            if (closes > patience.rebuilds + 1)
              return failure(
                new Error('the API opens an attempt each time one is closed: run the order again'),
                legId,
              );
            continue;
          }
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

        // ---- sign: one signature for an approved step
        let proof: ReportLegRequest;
        if (before?.proof && before.messageHash === pass.tx.messageHash) {
          // These very bytes were signed for this step: what was signed is reported again.
          proof = before.proof;
        } else {
          // Bytes that were signed for another step of the order are not signed for this one.
          for (const other of steps) {
            if (other.legId === legId) continue;
            const theirs = await recall(signedKey(order.id, other.legId));
            if (
              theirs !== undefined &&
              theirs !== 'unreadable' &&
              theirs.times > 0 &&
              theirs.messageHash === pass.tx.messageHash
            ) {
              await cancel(legId);
              return {
                status: 'refused',
                order: seen,
                legId,
                refusal: new GuardRefusal(
                  'step',
                  'these bytes were signed for another step of the order',
                  legId,
                ),
              };
            }
          }
          if (record === 'unreadable' || (record && record.times > 0)) {
            const stop = await again(record);
            if (stop === 'rebuild') continue;
            if (stop) return stop;
          }
          tell(legId, 'signing');
          const made = await sign(pass, key, before);
          if ('wallet' in made) {
            // It may have been sent: the attempt stays open, and the person looks before anything else.
            if (made.unknown) return review('asked', (before?.times ?? 0) + 1);
            await cancel(legId);
            // A blockhash that went stale before the wallet signed: the step is built again.
            if (made.wallet.code === 'expired' && builds <= patience.rebuilds) continue;
            return { status: 'cancelled', order: seen, legId, wallet: made.wallet };
          }
          proof = made.record.proof;
        }
        reported.add(attempt.id);
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
