import type { WebWalletPort } from '../port';
import { portStore } from './mock-provider';

// What stands in for signing.ts in the tests of the order screen: the whole port of `portStore`, as
// the provider would hand it to the one file that may hold it.
//
//   vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));

export const useSigningPort = (): WebWalletPort => portStore.get();
