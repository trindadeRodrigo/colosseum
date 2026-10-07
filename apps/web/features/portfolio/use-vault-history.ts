'use client';
import { useEffect, useMemo, useState } from 'react';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { dollars } from '../goal/sheet';
import type { ActivityGroup } from '../order/ActivityPanel';
import { activityOf } from '../order/activity';
import { readOrder } from '../order/order-api';
import { isBuy, type OrderRecord, recallOrders } from '../order/order-record';
import { onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { utc } from './figures';

// The orders this browser placed for the person, and what of them reached the chain: each read again
// from the API (GET /v1/orders/{id}), so a line says where a step stands now. The API has no route
// that lists a person's orders or the keeper's trades, so this is the history this browser knows.

export type VaultHistory = {
  records: OrderRecord[];
  /** What reached the chain, under the order each line was a step of, newest order first. */
  activity: ActivityGroup[];
  /** The orders whose deposit is confirmed on chain, as the API last said: only these were put in. */
  deposited: ReadonlySet<string>;
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
  const [activity, setActivity] = useState<ActivityGroup[]>([]);
  const [deposited, setDeposited] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setRecords(known ? recallOrders(userId) : []);
  }, [userId, known]);

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
                      : record.terms?.kind === 'follow'
                        ? t.activity.follow(when)
                        : record.terms?.kind === 'publish'
                          ? t.activity.publish(when)
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

  return { records, activity, deposited };
}
