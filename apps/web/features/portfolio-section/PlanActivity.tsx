'use client';
import { ActivityPanel } from '../order/ActivityPanel';
import { useVaultHistory } from '../portfolio/use-vault-history';
import { ordersOfVault } from '../portfolio/vault-goal';
import type { Plan } from './api';
import { useWords } from './words';

// The steps of the person's own orders for one vault, in the activity panel as the monitor has it
// (features/order/ActivityPanel.tsx): the orders the app recorded for the person (what this browser
// kept, joined by the server's list of their plans), narrowed to those of this vault by its plan's
// number on the chain, each read again from the API so a line says where its step stands now. One
// sentence says what the list is, and that the keeper's trades are not in it: those are in the block
// above, from the snapshots.
//
// The panel brings the disclaimer, from the one constant: on a page that carries it, the section's
// frame does not draw its own (PortfolioShell.tsx), so the page ends with exactly one.

export function PlanActivity({ plan }: { plan: Plan }) {
  const words = useWords().plan.activity;
  const history = useVaultHistory();
  const orders = new Set(ordersOfVault(plan, history.records).map((record) => record.orderId));
  return (
    <div data-ui="plan-activity" className="flex flex-col gap-3">
      <p
        data-ui="plan-activity-note"
        className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
      >
        {words.note}
      </p>
      <ActivityPanel
        groups={history.activity.filter((group) => orders.has(group.id))}
        empty={words.none}
        // the page is headed by the one chain every line is on
        chainTags={false}
      />
    </div>
  );
}
