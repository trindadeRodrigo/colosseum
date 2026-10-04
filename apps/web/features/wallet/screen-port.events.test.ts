// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, unmountAll } from '../../components/ui/test/dom';
import { type ScreenPort, SIGNING_MEMBERS, type WebWalletPort } from './port';
import { useSigningPort } from './signing';
import { fakePort } from './test/fake-port';
import { useWalletPort, WalletProvider } from './WalletProvider';

// The provider itself, mounted: what `useWalletPort()` hands a screen has no member that signs, sends
// or shows a key, before the wallet has loaded and after. The whole port is behind `useSigningPort()`,
// which no product route may import (components/shell/product-routes.test.ts, rule 3).

const bridge = vi.hoisted(() => ({ onPort: null as null | ((port: unknown) => void) }));
// The bridge is loaded with next/dynamic. Here it is a component that keeps the provider's `onPort`,
// so the test can report a port as the bridge does.
vi.mock('next/dynamic', () => ({
  default: () => (props: { onPort: (port: unknown) => void }) => {
    bridge.onPort = props.onPort;
    return null;
  },
}));

afterEach(unmountAll);

describe('what the provider hands a screen', () => {
  async function provider() {
    const seen: { screen?: ScreenPort; whole?: WebWalletPort } = {};
    const Screen = () => {
      seen.screen = useWalletPort();
      return null;
    };
    const Signer = () => {
      seen.whole = useSigningPort();
      return null;
    };
    await mount(createElement(WalletProvider, null, createElement(Screen), createElement(Signer)));
    await settle();
    return seen;
  }
  const signing = (port: object | undefined) =>
    SIGNING_MEMBERS.filter((member) => port !== undefined && member in port);

  it('is the wallet with no signing member, before it has loaded and once it has', async () => {
    const seen = await provider();
    expect(seen.screen?.status).toBe('loading');
    expect(signing(seen.screen)).toEqual([]);

    const ready = fakePort({ status: 'ready', userId: 'did:privy:test' });
    await act(async () => bridge.onPort?.(ready));
    await settle();
    expect(seen.screen?.status).toBe('ready');
    expect(seen.screen?.userId).toBe('did:privy:test');
    expect(signing(seen.screen)).toEqual([]);
    // not hidden behind a type: the object does not have them
    for (const member of SIGNING_MEMBERS)
      expect((seen.screen as unknown as Record<string, unknown>)[member]).toBeUndefined();
  });

  it('keeps the whole port behind useSigningPort()', async () => {
    const seen = await provider();
    const ready = fakePort({ status: 'ready' });
    await act(async () => bridge.onPort?.(ready));
    await settle();
    expect(seen.whole).toBe(ready);
    expect(signing(seen.whole)).toEqual([...SIGNING_MEMBERS]);
  });
});
