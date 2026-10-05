'use client';
import { useContext, useEffect } from 'react';
import type { WebWalletPort } from './port';
import { WalletContext } from './WalletProvider';

// The whole wallet port, with the members that sign, send and show a key. One file the app ships may
// import this: the order runner (features/order/run-order.ts), which hands it to `execute()` of
// packages/sdk, so that nothing is signed that the guard has not checked against the order (AGT-1).
// components/shell/product-routes.test.ts holds that; the wallet check under /dev imports it too, and
// is in no production build.

export function useSigningPort(): WebWalletPort {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useSigningPort() needs <WalletProvider> above it');
  const { activate } = value;
  useEffect(activate, [activate]);
  return value.port;
}
