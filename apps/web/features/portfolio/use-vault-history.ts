'use client';
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

// The orders this browser placed for the person, and what of them reached the chain: each read again
// from the API (GET /v1/orders/{id}), so a line says where a step stands now. The API has no route
// that lists a person's orders or the keeper's trades, so this is the history this browser knows.

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

  useEffect(() => {
    setRecords(known ? recallOrders(userId) : []);
  }, [userId, known]);

  const ids = useMemo(() => records.map((r) => r.orderId).join('|'), [records]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the list of orders changes, by its ids
  useEffect(() => {
    let live = true;
    if (records.length === 0) {
      setOrders([]);
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
  return { records, activity, orders, deposited };
}
