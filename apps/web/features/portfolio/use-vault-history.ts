'use client';
import type { OrderDetail } from '@colosseum/schemas';
import { useEffect, useMemo, useState } from 'react';
import type { Execution } from '../../components/ui/ExecutionList';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { dollars } from '../goal/sheet';
import { activityOf } from '../order/activity';
import { readOrder } from '../order/order-api';
import { type OrderRecord, recallOrders } from '../order/order-record';
import { onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { mergeRecords, readPersonPlans, recordsOfPlans } from './server-plans';

// The person's buys and what of them reached the chain. The buys are the server's list of their plans
// (GET /v1/me/plans, server-plans.ts) together with what this browser kept (order-record.ts), so the
// history is the same on a new device; each is read again from the API (GET /v1/orders/{id}), so a
// line says where a step stands now. An order about a shared portfolio (a follow, a publish) and the
// keeper's trades are in no list the API has: of those, this is what this browser placed.

/** What one order did on chain, under what the order was. */
export type OrderActivity = {
  orderId: string;
  /** "Buy of $80,000": the order in a few words. */
  title: string;
  /** When the order was made, as an ISO instant. */
  at: string;
  executions: Execution[];
};

export type VaultHistory = {
  records: OrderRecord[];
  /** Every step that reached the chain, newest first. */
  activity: Execution[];
  /** The same steps by the order they belong to, the newest order first. */
  orders: OrderActivity[];
  /** The orders whose deposit is confirmed on chain, as the API last said: only these were put in. */
  deposited: ReadonlySet<string>;
  /**
   * The orders that stopped with cash left in the vault: a buy whose deposit landed and whose buying
   * did not finish, or the order made to finish one, itself stopped. Not one that a later order
   * finished. Its page offers to finish the buy with that cash.
   */
  stopped: ReadonlySet<string>;
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
  const lang = useLang();
  const [orders, setOrders] = useState<OrderActivity[]>([]);
  const [deposited, setDeposited] = useState<ReadonlySet<string>>(new Set());
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const kept = known ? recallOrders(userId) : [];
    setRecords(kept);
    if (!known || !userId) return;
    let live = true;
    // What this browser kept is shown at once; the server's list joins it when it answers.
    void readPersonPlans(apiFetch).then((plans) => {
      if (live && plans.length > 0) setRecords(mergeRecords(kept, recordsOfPlans(plans, userId)));
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
      setOrders([]);
      setDeposited(new Set());
      setStopped(new Set());
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
      // An order goes no further when it failed or ran out of time with a step not done. The buy a
      // later order finished is not stopped any more.
      const over = (order: OrderDetail) =>
        order.status === 'failed' ||
        order.status === 'expired' ||
        order.legs.some((leg) => leg.status === 'failed' || leg.status === 'expired');
      const landed = (order: OrderDetail) =>
        order.legs.some(
          (leg) =>
            (leg.kind === 'create_vault' || leg.kind === 'deposit') && leg.status === 'confirmed',
        );
      const finished = new Set(
        read.flatMap((answer, i) =>
          answer.kind === 'read' && answer.order.status === 'done' && records[i]?.continues
            ? [records[i]?.continues?.orderId ?? '']
            : [],
        ),
      );
      setStopped(
        new Set(
          read.flatMap((answer, i) => {
            const record = records[i];
            if (answer.kind !== 'read' || !record || answer.order.status === 'done') return [];
            const root = record.continues?.orderId ?? record.orderId;
            if (finished.has(root) || !over(answer.order)) return [];
            return record.continues || landed(answer.order) ? [record.orderId] : [];
          }),
        ),
      );
      setOrders(
        read
          .flatMap((answer, i): OrderActivity[] => {
            const record = records[i];
            if (answer.kind !== 'read' || !record) return [];
            const executions = activityOf(answer.order, t, onMock(port, record.chain));
            if (executions.length === 0) return [];
            const kind = record.terms?.kind;
            return [
              {
                orderId: answer.order.id,
                title:
                  kind === 'follow'
                    ? t.activity.order.follow
                    : kind === 'publish'
                      ? t.activity.order.publish
                      : t.activity.order.buy(dollars(record.amountUsd, lang)),
                at: answer.order.createdAt,
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

  const activity = useMemo(
    () => orders.flatMap((o) => o.executions).sort((a, b) => b.at.localeCompare(a.at)),
    [orders],
  );
  return { records, activity, orders, deposited, stopped };
}
