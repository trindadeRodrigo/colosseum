'use client';
import { useEffect } from 'react';
import { publicWalletEnv, walletChains } from '../chains';
import { chainOfEvmId, evmRpc } from '../dev/rpc';
import { createWalletPort } from '../port';
import type { BridgeProps } from '../WalletProvider';
import { createTestDriver } from './test-driver';

/**
 * The throwaway wallet in place of Privy, when NEXT_PUBLIC_WALLET_DRIVER=test under `next dev`.
 * A reload makes new keys. Never part of a production build (see test-driver.ts).
 */
export default function TestBridge({ onPort }: BridgeProps) {
  useEffect(() => {
    let live = true;
    (async () => {
      const chains = walletChains(publicWalletEnv());
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
  }, [onPort]);
  return null;
}
