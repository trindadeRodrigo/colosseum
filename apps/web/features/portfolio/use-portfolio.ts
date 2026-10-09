'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type PortfolioOutcome, readPortfolio } from './portfolio';

// The person's vaults on every chain, for a screen. They are read once the person is known, and read
// again when the person changes or the screen asks: an answer is shown only for the person it was
// asked for, never for whoever is signed in by the time it lands. The chain a person's new plans
// start on has no part in it (gate CHAIN-AT-THE-PLAN): changing it reads nothing again.

export type PortfolioState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  /** Signed in, with no wallet the server knows a chain for: the account says why. */
  | { kind: 'no-account-chain' }
  /** Asked, and waiting for the answer. */
  | { kind: 'reading' }
  /** What the API answered, for this person. */
  | { kind: 'answered'; outcome: PortfolioOutcome };

export function usePortfolio(): { state: PortfolioState; again: () => void; busy: boolean } {
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account } = useAccount();
  const [answer, setAnswer] = useState<{
    key: string;
    outcome: PortfolioOutcome;
  } | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const wanted = useRef('');

  const ready = account.status === 'ready';
  const who = port.userId;
  const key = ready && who ? `${who}:${round}` : '';

  useEffect(() => {
    wanted.current = key;
    // Nobody to read for (signed out, no wallet): nothing is on its way, whatever was.
    if (!key) {
      setBusy(false);
      return;
    }
    setBusy(true);
    readPortfolio(apiFetch).then((outcome) => {
      if (wanted.current !== key) return;
      setAnswer({ key, outcome });
      setBusy(false);
    });
  }, [key, apiFetch]);

  const again = useCallback(() => setRound((n) => n + 1), []);

  let state: PortfolioState;
  if (port.status === 'loading' || account.status === 'loading') state = { kind: 'loading' };
  else if (port.status === 'signed-out' || account.status === 'signed-out')
    state = { kind: 'signed-out' };
  else if (!ready) state = { kind: 'no-account-chain' };
  else {
    // The last answer stays on the screen while it is read again, if it was for this person; the
    // button says it is reading.
    const same = answer?.key.startsWith(`${who}:`) ? answer : null;
    state = same ? { kind: 'answered', outcome: same.outcome } : { kind: 'reading' };
  }
  return { state, again, busy };
}
