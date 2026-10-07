'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Execution } from '../../components/ui/ExecutionList';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { activityOf, activityOfWithdrawals } from '../order/activity';
import { readOrder } from '../order/order-api';
import { type OrderRecord, recallOrders } from '../order/order-record';
import { onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
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
  activity: Execution[];
  /** The orders whose deposit is confirmed on chain, as the API last said: only these were put in. */
  deposited: ReadonlySet<string>;
  /** The person's withdrawals, as the server lists them: what was taken out is counted from these. */
  withdrawals: readonly ServerWithdrawal[];
};

export function useVaultHistory(): VaultHistory {
  const t = useT();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account } = useAccount();
  // Every chain's orders: a plan stays on its chain when the person switches (CHAIN-SWITCH).
  const known = account.status === 'ready';
  const userId = port.userId;
  const [records, setRecords] = useState<OrderRecord[]>([]);
  const [activity, setActivity] = useState<Execution[]>([]);
  const [deposited, setDeposited] = useState<ReadonlySet<string>>(new Set());
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
      return;
    }
    Promise.all(records.map((r) => readOrder(apiFetch, r.orderId))).then((read) => {
      if (!live) return;
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
      setActivity(
        read
          .flatMap((answer, i) => {
            const chain = records[i]?.chain;
            return answer.kind === 'read' && chain
              ? activityOf(answer.order, t, onMock(port, chain))
              : [];
          })
          .sort((a, b) => b.at.localeCompare(a.at)),
      );
    });
    return () => {
      live = false;
    };
  }, [ids, apiFetch, t]);

  // A withdrawal's steps are lines too, from the server's list. A step this browser's own order
  // already gave a line keeps that one.
  const lines = useMemo(() => {
    const own = new Set(activity.map((e) => e.id));
    const taken = activityOfWithdrawals(withdrawals, t, (chain) => onMock(port, chain));
    return [...activity, ...taken.filter((e) => !own.has(e.id))].sort((a, b) =>
      b.at.localeCompare(a.at),
    );
  }, [activity, withdrawals, t, port]);

  return { records, activity: lines, deposited, withdrawals };
}
