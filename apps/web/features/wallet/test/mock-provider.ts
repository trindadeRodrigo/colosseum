import { type ReactNode, useSyncExternalStore } from 'react';
import { type ScreenPort, screenPort, type WebWalletPort } from '../port';
import { createPortStore, fakePort } from './fake-port';

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
/** How often the wallet provider was started again, and whether it refuses (an order is being run). */
export const restarts = { count: 0, refuse: false };
const restart = () => {
  if (restarts.refuse) return false;
  restarts.count += 1;
  // as the provider does: the port of the bridge that is gone goes, and the person stays known
  portStore.set(fakePort({ status: 'loading', userId: portStore.get().userId }));
  return true;
};
export const useWalletRestart = () => restart;
export const WalletProvider = ({ children }: { children: ReactNode }) => children;
