'use client';
import type { ChainId } from '@colosseum/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type PortfolioOutcome, readPortfolio } from './portfolio';

// The person's vaults, for a screen. They are read once the person and their chain are known, and read
// again when either changes or the screen asks: an answer is shown only for the person and the chain
// it was asked for, never for whoever is signed in by the time it lands.

export type PortfolioState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  /** Signed in, and the chain is not known or not chosen: the account says why. */
  | { kind: 'no-account-chain' }
  /** Asked, and waiting for the answer. */
  | { kind: 'reading'; chain: ChainId }
  /** What the API answered, for this person and this chain. */
  | { kind: 'answered'; chain: ChainId; outcome: PortfolioOutcome };

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

  const chain = account.status === 'ready' ? account.chain : null;
  const who = port.userId;
  const key = chain && who ? `${who}:${chain}:${round}` : '';

  useEffect(() => {
    wanted.current = key;
    // Nobody to read for (signed out, no chain): nothing is on its way, whatever was.
    if (!key || !chain) {
      setBusy(false);
      return;
    }
    setBusy(true);
    readPortfolio(apiFetch, chain).then((outcome) => {
      if (wanted.current !== key) return;
      setAnswer({ key, outcome });
      setBusy(false);
    });
  }, [key, chain, apiFetch]);

  const again = useCallback(() => setRound((n) => n + 1), []);

  let state: PortfolioState;
  if (port.status === 'loading' || account.status === 'loading') state = { kind: 'loading' };
  else if (port.status === 'signed-out' || account.status === 'signed-out')
    state = { kind: 'signed-out' };
  else if (!chain) state = { kind: 'no-account-chain' };
  else {
    // The last answer stays on the screen while it is read again, if it was for this person and
    // chain; the button says it is reading.
    const same = answer?.key.startsWith(`${who}:${chain}:`) ? answer : null;
    state = same ? { kind: 'answered', chain, outcome: same.outcome } : { kind: 'reading', chain };
  }
  return { state, again, busy };
}
