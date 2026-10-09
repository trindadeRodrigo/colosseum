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

// happy-dom has no WebAuthn. The screens' tests are of a browser that has it; the one that has
// none takes it away (SignIn.events.test.ts).
if (typeof window !== 'undefined' && !('PublicKeyCredential' in window))
  Object.defineProperty(window, 'PublicKeyCredential', {
    value: class PublicKeyCredential {},
    configurable: true,
    writable: true,
  });

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
/** How often this browser was marked signed out without the service (WalletProvider's `leaveHere`). */
export const left = { count: 0 };
const leaveHere = () => {
  left.count += 1;
};
export const useLeaveHere = () => leaveHere;
export const useOustedPerson = () => null;
export const WalletProvider = ({ children }: { children: ReactNode }) => children;
