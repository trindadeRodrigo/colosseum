'use client';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { readWay } from '../invest/handoff';
import { InvestScreen } from '../invest/InvestScreen';
import { useWalletPort } from '../wallet/WalletProvider';
import { GoalConversation } from './GoalConversation';

/** Two separate conversations; a model preview cannot enter guided funding state. */
export function GoalEntry() {
  const t = useT();
  const { account, chain } = useAccount();
  const port = useWalletPort();
  const [mode, setMode] = useState('explore');
  const network = chain ? port.network(chain) : null;
  useEffect(() => {
    // Only an existing validated financial continuation belongs to the guided flow.
    // Its original consumer retains ownership of reading/removing the saved sheet and change.
    if (readWay()) setMode('guided');
  }, []);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <label className="flex items-center gap-2 self-start text-caption text-muted-foreground">
        {t.goal.explore.mode}
        <select
          data-ui="goal-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
          className="min-w-0 rounded-sm border border-border bg-background px-2 py-1 text-body-sm text-foreground"
        >
          <option value="explore">{t.goal.explore.explore}</option>
          <option value="guided">{t.goal.explore.guided}</option>
        </select>
      </label>
      {mode === 'explore' ? (
        <GoalConversation
          key={`${port.userId}:${chain}:${network?.provenance}`}
          userId={port.userId}
          chain={chain}
          provenance={network?.provenance ?? null}
          ready={port.status === 'ready' && account.status === 'ready' && network?.on === true}
        />
      ) : (
        <InvestScreen />
      )}
    </div>
  );
}
