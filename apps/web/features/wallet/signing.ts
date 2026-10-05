'use client';
import { useContext, useEffect } from 'react';
import type { WebWalletPort } from './port';
import { WalletContext } from './WalletProvider';

// The whole wallet port, with the members that sign, send and show a key. Nothing a product route is
// built from may import this file: until the guard has checked the bytes against the order
// (packages/sdk, AGT-1), no screen signs. components/shell/product-routes.test.ts lists who may: today
// the wallet check under /dev, which is in no production build. The one leg executor is added to that
// list, on purpose, when it exists.

export function useSigningPort(): WebWalletPort {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useSigningPort() needs <WalletProvider> above it');
  const { activate } = value;
  useEffect(activate, [activate]);
  return value.port;
}
