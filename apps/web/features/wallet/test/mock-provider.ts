import { type ReactNode, useSyncExternalStore } from 'react';
import { type ScreenPort, screenPort, type WebWalletPort } from '../port';
import { createPortStore } from './fake-port';

// What stands in for WalletProvider.tsx in the tests of the screens:
//
//   vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
//
// The screens then read the port of `portStore`, and a test changes it as the provider would. As in
// the app, what a screen reads has no signing member.

export const portStore = createPortStore();

const screens = new WeakMap<WebWalletPort, ScreenPort>();
const screenOf = () => {
  const port = portStore.get();
  let screen = screens.get(port);
  if (!screen) {
    screen = screenPort(port);
    screens.set(port, screen);
  }
  return screen;
};

export const useWalletPort = () => useSyncExternalStore(portStore.subscribe, screenOf, screenOf);
export const useApiFetch = () => portStore.api;
export const WalletProvider = ({ children }: { children: ReactNode }) => children;
