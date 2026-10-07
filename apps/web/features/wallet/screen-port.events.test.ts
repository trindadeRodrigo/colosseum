// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, unmountAll } from '../../components/ui/test/dom';
import { type ScreenPort, SIGNING_MEMBERS, type WebWalletPort } from './port';
import { useSigningHold, useSigningPort } from './signing';
import { fakePort } from './test/fake-port';
import { useWalletPort, useWalletRestart, WalletProvider } from './WalletProvider';

// The provider itself, mounted: what `useWalletPort()` hands a screen has no member that signs, sends
// or shows a key, before the wallet has loaded and after. The whole port is behind `useSigningPort()`,
// which no product route may import (components/shell/product-routes.test.ts, rule 3).

const bridge = vi.hoisted(() => ({
  onPort: null as null | ((port: unknown) => void),
  mounts: 0,
}));
// The bridge is loaded with next/dynamic. Here it is a component that keeps the provider's `onPort`,
// so the test can report a port as the bridge does.
vi.mock('next/dynamic', () => ({
  default: () => (props: { onPort: (port: unknown) => void }) => {
    bridge.onPort = props.onPort;
    useEffect(() => {
      bridge.mounts += 1;
    }, []);
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

  it('mounts the wallet provider again on restart, with no reload: the old port goes, the person stays known', async () => {
    let restart = (): boolean => false;
    const seen: { screen?: ScreenPort; whole?: WebWalletPort } = {};
    const Screen = () => {
      seen.screen = useWalletPort();
      seen.whole = useSigningPort();
      restart = useWalletRestart();
      return null;
    };
    await mount(createElement(WalletProvider, null, createElement(Screen)));
    await settle();
    const before = bridge.mounts;
    // ready, as far as the provider that is about to go said
    const old = fakePort({ status: 'ready', userId: 'did:privy:test' });
    await act(async () => bridge.onPort?.(old));
    let done = false;
    await act(async () => {
      done = restart();
    });
    await settle();
    expect(done).toBe(true);
    expect(bridge.mounts).toBe(before + 1);
    // nothing is left of the port whose hooks are unmounted: loading, for the same person, and no
    // signer that could be handed to a run
    expect(seen.screen?.status).toBe('loading');
    expect(seen.screen?.userId).toBe('did:privy:test');
    expect(seen.whole).not.toBe(old);
    expect(seen.whole?.status).toBe('loading');
    await expect(seen.whole?.sign('solana', [])).rejects.toThrow(/still loading/);
    await act(async () => bridge.onPort?.(fakePort({ status: 'ready', userId: 'did:privy:test' })));
    expect(seen.screen?.status).toBe('ready');
  });

  it('is not mounted again while a run of an order is open, and is once the run is over', async () => {
    let restart = (): boolean => false;
    let hold = (): (() => void) => () => {};
    const seen: { whole?: WebWalletPort } = {};
    const Screen = () => {
      seen.whole = useSigningPort();
      restart = useWalletRestart();
      hold = useSigningHold();
      return null;
    };
    await mount(createElement(WalletProvider, null, createElement(Screen)));
    await settle();
    const ready = fakePort({ status: 'ready', userId: 'did:privy:test' });
    await act(async () => bridge.onPort?.(ready));
    const before = bridge.mounts;
    const release = hold();
    let done = true;
    await act(async () => {
      done = restart();
    });
    expect(done).toBe(false);
    expect(bridge.mounts).toBe(before);
    // the run keeps the port it started on
    expect(seen.whole).toBe(ready);
    release();
    // released twice by mistake, it still counts once
    release();
    await act(async () => {
      done = restart();
    });
    await settle();
    expect(done).toBe(true);
    expect(bridge.mounts).toBe(before + 1);
  });
});
