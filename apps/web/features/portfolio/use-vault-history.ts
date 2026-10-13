'use client';
import { useEffect, useMemo, useState } from 'react';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { dollars } from '../goal/sheet';
import type { ActivityGroup } from '../order/ActivityPanel';
import { activityOf, activityOfWithdrawals } from '../order/activity';
import { readOrder } from '../order/order-api';
import { depositLanded, stoppedShort } from '../order/order-check';
import { forgetUnapproved, isBuy, type OrderRecord, recallOrders } from '../order/order-record';
import { onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { utc } from './figures';
import { mergeRecords, readPersonPlans, recordsOfPlans } from './server-plans';
import { readPersonWithdrawals, type ServerWithdrawal } from './server-withdrawals';

// The person's buys and what of them reached the chain. The buys are the server's list of their plans
// (GET /v1/me/plans, server-plans.ts) together with what this browser kept (order-record.ts), so the
// history is the same on a new device; each is read again from the API (GET /v1/orders/{id}), so a
// line says where a step stands now. An order about a shared portfolio (a follow, a publish) and the
// keeper's trades are in no list the API has: of those, this is what this browser placed. Withdrawals
// are the server's list too (GET /v1/me/withdrawals, server-withdrawals.ts).

export type VaultHistory = {
  records: OrderRecord[];
  /** What reached the chain, under the order each line was a step of, newest order first. */
  activity: ActivityGroup[];
  /** The orders whose deposit is confirmed on chain, as the API last said: only these were put in. */
  deposited: ReadonlySet<string>;
  /**
   * The orders that stopped with their cash left in the vault: a buy whose deposit landed and whose
   * buying did not finish, or the order made to finish one, itself stopped. Not one that another
   * order was made to finish: what it left is that order's. Its page offers to finish the buy.
   */
  stopped: ReadonlySet<string>;
  /** The person's withdrawals, as the server lists them: what was taken out is counted from these. */
  withdrawals: readonly ServerWithdrawal[];
};

export function useVaultHistory(): VaultHistory {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account } = useAccount();
  // Every chain's orders: a plan stays on its chain when the person switches (CHAIN-SWITCH).
  const known = account.status === 'ready';
  const userId = port.userId;
  const [records, setRecords] = useState<OrderRecord[]>([]);
  // Each group with when its order was made: the server's withdrawals are sorted in among them.
  const [activity, setActivity] = useState<(ActivityGroup & { at: string })[]>([]);
  const [deposited, setDeposited] = useState<ReadonlySet<string>>(new Set());
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const [withdrawals, setWithdrawals] = useState<readonly ServerWithdrawal[]>([]);

  useEffect(() => {
    const kept = known ? recallOrders(userId) : [];
    setRecords(kept);
    setWithdrawals([]);
    if (!known || !userId) return;
    let live = true;
    // What this browser kept is shown at once; the server's list joins it when it answers.
    void readPersonPlans(apiFetch).then((plans) => {
      if (live && plans.length > 0) setRecords(mergeRecords(kept, recordsOfPlans(plans, userId)));
    });
    void readPersonWithdrawals(apiFetch).then((listed) => {
      if (live) setWithdrawals(listed);
    });
    return () => {
      live = false;
    };
  }, [userId, known, apiFetch]);

  const ids = useMemo(() => records.map((r) => r.orderId).join('|'), [records]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the list of orders changes, by its ids
  useEffect(() => {
    let live = true;
    if (records.length === 0) {
      setActivity([]);
      setDeposited(new Set());
      setStopped(new Set());
      return;
    }
    Promise.all(records.map((r) => readOrder(apiFetch, r.orderId))).then((read) => {
      if (!live) return;
      // An order this browser kept that nobody approved and whose time ran out (the invest card
      // makes one to show its prices, and a closed tab can leave it behind) is no buy: its record is
      // dropped here, so it is not asked about again. Never one that finishes another order: what
      // that one is held to is in its record.
      for (const [i, answer] of read.entries()) {
        const record = records[i];
        if (
          answer.kind === 'read' &&
          record &&
          record.approved === null &&
          !record.continues &&
          answer.order.expiresAt * 1000 < Date.now() &&
          answer.order.legs.every((leg) => leg.attempt === 0)
        )
          forgetUnapproved(record.orderId, userId);
      }
      setDeposited(
        new Set(
          read.flatMap((answer) =>
            answer.kind === 'read' &&
            answer.order.legs.some(
              (leg) =>
                (leg.kind === 'create_vault' || leg.kind === 'deposit') &&
                leg.status === 'confirmed',
            )
              ? [answer.order.id]
              : [],
          ),
        ),
      );
      const continued = new Set(records.flatMap((r) => (r.continues ? [r.continues.orderId] : [])));
      setStopped(
        new Set(
          read.flatMap((answer, i) => {
            const record = records[i];
            if (answer.kind !== 'read' || !record || !isBuy(record)) return [];
            // a buy of a plan, or money added to a vault: the two the server finishes
            if (record.terms && record.terms.kind !== 'vault') return [];
            if (continued.has(record.orderId) || !stoppedShort(answer.order)) return [];
            return record.continues || depositLanded(answer.order) ? [record.orderId] : [];
          }),
        ),
      );
      setActivity(
        read
          .flatMap((answer, i) => {
            const record = records[i];
            if (answer.kind !== 'read' || !record) return [];
            const executions = activityOf(answer.order, t, onMock(port, record.chain));
            const when = utc(lang, answer.order.createdAt);
            return executions.length === 0
              ? []
              : [
                  {
                    id: answer.order.id,
                    at: answer.order.createdAt,
                    title: isBuy(record)
                      ? t.activity.buy(dollars(record.amountUsd, lang), when)
                      : record.terms?.kind === 'withdraw'
                        ? t.activity.withdraw(when)
                        : record.terms?.kind === 'follow'
                          ? t.activity.follow(when)
                          : record.terms?.kind === 'publish'
                            ? t.activity.publish(when)
                            : record.terms?.kind === 'retarget'
                              ? t.mix.activity(when)
                              : t.activity.order(when),
                    executions,
                  },
                ];
          })
          .sort((a, b) => b.at.localeCompare(a.at)),
      );
    });
    return () => {
      live = false;
    };
  }, [ids, apiFetch, t, lang]);

  // A withdrawal is a group of lines too, from the server's list: one this browser never placed is
  // there as well. An order this browser's own record already gave a group keeps that one.
  const groups = useMemo(() => {
    const own = new Set(activity.map((group) => group.id));
    const taken = withdrawals
      .filter((w) => !own.has(w.orderId))
      .map((w) => ({
        id: w.orderId,
        at: w.createdAt,
        title: t.activity.withdraw(utc(lang, w.createdAt)),
        executions: activityOfWithdrawals([w], t, (chain) => onMock(port, chain)),
      }))
      .filter((group) => group.executions.length > 0);
    return [...activity, ...taken].sort((a, b) => b.at.localeCompare(a.at));
  }, [activity, withdrawals, t, lang, port]);

  return { records, activity: groups, deposited, stopped, withdrawals };
}
