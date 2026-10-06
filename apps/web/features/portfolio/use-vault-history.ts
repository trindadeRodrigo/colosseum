'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Execution } from '../../components/ui/ExecutionList';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { activityOf } from '../order/activity';
import { readOrder } from '../order/order-api';
import { type OrderRecord, recallOrders } from '../order/order-record';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';

// The orders this browser placed for the person, and what of them reached the chain: each read again
// from the API (GET /v1/orders/{id}), so a line says where a step stands now. The API has no route
// that lists a person's orders or the keeper's trades, so this is the history this browser knows.

export type VaultHistory = {
  records: OrderRecord[];
  activity: Execution[];
  /** The orders whose deposit is confirmed on chain, as the API last said: only these were put in. */
  deposited: ReadonlySet<string>;
};

export function useVaultHistory(): VaultHistory {
  const t = useT();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account } = useAccount();
  const chain = account.status === 'ready' ? account.chain : null;
  const userId = port.userId;
  const [records, setRecords] = useState<OrderRecord[]>([]);
  const [activity, setActivity] = useState<Execution[]>([]);
  const [deposited, setDeposited] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setRecords(chain ? recallOrders(userId).filter((r) => r.chain === chain) : []);
  }, [userId, chain]);

  const ids = useMemo(() => records.map((r) => r.orderId).join('|'), [records]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the list of orders changes, by its ids
  useEffect(() => {
    let live = true;
    if (!chain || records.length === 0) {
      setActivity([]);
      setDeposited(new Set());
      return;
    }
    const explorer = `${t.chain.names[chain]} ${t.order.explorer}`;
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
          .flatMap((answer) =>
            answer.kind === 'read' ? activityOf(answer.order, t, explorer) : [],
          )
          .sort((a, b) => b.at.localeCompare(a.at)),
      );
    });
    return () => {
      live = false;
    };
  }, [ids, chain, apiFetch, t]);

  return { records, activity, deposited };
}
