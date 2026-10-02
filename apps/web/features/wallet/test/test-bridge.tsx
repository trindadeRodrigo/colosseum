'use client';
import { useEffect, useMemo } from 'react';
import { publicWalletEnv, walletChains } from '../chains';
import { chainOfEvmId, evmRpc } from '../dev/rpc';
import { createWalletPort, idleDriver } from '../port';
import { useApiCheck } from '../use-api-check';
import type { BridgeProps } from '../WalletProvider';
import { createTestDriver } from './test-driver';

/**
 * The throwaway wallet in place of Privy, when NEXT_PUBLIC_WALLET_DRIVER=test under `next dev`.
 * A reload makes new keys. Never part of a production build (see test-driver.ts).
 */
export default function TestBridge({ onPort }: BridgeProps) {
  const setup = useMemo(() => {
    try {
      return walletChains(publicWalletEnv());
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);
  const chains = typeof setup === 'string' ? null : setup;
  const check = useApiCheck(chains);
  // The same rule as with Privy: no wallet until the API says it is on the same networks.
  const problem = typeof setup === 'string' ? setup : check && !check.ok ? check.problem : null;
  const ready = chains !== null && check?.ok === true;

  useEffect(() => {
    if (problem) onPort(createWalletPort(idleDriver(), walletChains(), problem));
  }, [onPort, problem]);

  useEffect(() => {
    if (!ready || !chains) return;
    let live = true;
    (async () => {
      const driver = await createTestDriver({
        prepareEvm: (from, request) =>
          evmRpc(chainOfEvmId(chains, request.chainId)).fees(from, request),
        onChange: () => live && onPort(createWalletPort(driver, chains)),
      });
      if (live) onPort(createWalletPort(driver, chains));
    })();
    return () => {
      live = false;
    };
  }, [onPort, ready, chains]);
  return null;
}
