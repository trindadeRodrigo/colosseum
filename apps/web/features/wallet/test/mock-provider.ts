import { type ReactNode, useSyncExternalStore } from 'react';
import { createPortStore } from './fake-port';

// What stands in for WalletProvider.tsx in the tests of the screens:
//
//   vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
//
// The screens then read the port of `portStore`, and a test changes it as the provider would.

export const portStore = createPortStore();

export const useWalletPort = () =>
  useSyncExternalStore(portStore.subscribe, portStore.get, portStore.get);
export const useApiFetch = () => portStore.api;
export const WalletProvider = ({ children }: { children: ReactNode }) => children;
