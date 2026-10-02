'use client';
import { useId, useState } from 'react';
import { accountLines, failureSentence } from './view';
import { useWalletPort } from './WalletProvider';

// Plain on purpose: the design system's Button and its tokens arrive with BRAND-1, and this control
// takes them then. What is fixed here is the behaviour: one "Sign in" button that opens a choice of
// passkey or wallet (GATES, SIGN-IN-LABEL), the signed-in state, and sign out. Square corners, no
// spinner: a busy button changes its label.

const quiet = 'rounded-[2px] border border-gray-500 px-3 py-1.5 text-sm hover:border-black';
const solid = 'rounded-[2px] bg-black px-3 py-1.5 text-sm text-white';

type Busy = 'passkey' | 'wallet' | 'out' | null;

export function SignIn() {
  const port = useWalletPort();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const menu = useId();

  async function run(what: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(what);
    setProblem(null);
    try {
      await action();
      setOpen(false);
    } catch (e) {
      setProblem(failureSentence(e));
    } finally {
      setBusy(null);
    }
  }

  if (port.status === 'ready') {
    const lines = accountLines(port.accounts);
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {port.test && <span className="border border-gray-500 px-1.5 font-mono text-xs">MOCK</span>}
        {lines.length === 0 && <span>Signed in, with no wallet connected here</span>}
        {lines.map((line) => (
          <span key={line.family} className="font-mono" title={line.address}>
            {line.label}
          </span>
        ))}
        <button
          type="button"
          className={quiet}
          aria-busy={busy === 'out'}
          aria-disabled={busy === 'out'}
          onClick={() => busy || run('out', () => port.signOut())}
        >
          {busy === 'out' ? 'Signing out…' : 'Sign out'}
        </button>
        {problem && <p role="alert">{problem}</p>}
      </div>
    );
  }

  const loading = port.status === 'loading';
  // Not set up: the button stays, switched off, with the reason in words beside it.
  const off = loading || port.problem !== null;
  return (
    <div className="text-sm">
      <button
        type="button"
        className={solid}
        aria-expanded={open}
        aria-controls={menu}
        aria-busy={loading}
        aria-disabled={off}
        onClick={() => off || setOpen((v) => !v)}
      >
        {loading ? 'Loading sign-in…' : 'Sign in'}
      </button>
      {port.problem && <p className="mt-2">Sign-in is not set up here: {port.problem}.</p>}
      {open && !off && (
        <div id={menu} className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={quiet}
            aria-busy={busy === 'passkey'}
            aria-disabled={busy !== null}
            onClick={() => busy || run('passkey', () => port.signIn('passkey'))}
          >
            {busy === 'passkey' ? 'Waiting for your passkey…' : 'Passkey'}
          </button>
          <button
            type="button"
            className={quiet}
            aria-busy={busy === 'wallet'}
            aria-disabled={busy !== null}
            onClick={() => busy || run('wallet', () => port.signIn('wallet'))}
          >
            {busy === 'wallet' ? 'Waiting for your wallet…' : 'Wallet'}
          </button>
        </div>
      )}
      {problem && (
        <p className="mt-2" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
