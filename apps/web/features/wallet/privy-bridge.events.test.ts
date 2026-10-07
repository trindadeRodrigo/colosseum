// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, unmountAll } from '../../components/ui/test/dom';
import type { WebWalletPort } from './port';
import { type PendingWallet, privyDouble } from './test/privy-double';

vi.mock('@privy-io/react-auth', async () => (await import('./test/privy-double')).reactAuth);
vi.mock('@privy-io/react-auth/solana', async () => (await import('./test/privy-double')).solana);
/** What the app's public settings say of this page's address, and how often they were asked. */
const origin = vi.hoisted(() => ({ refused: false as boolean | null, asked: 0 }));
vi.mock('./origin-check', async (original) => ({
  ...(await original<typeof import('./origin-check')>()),
  asksOriginRefused: async () => {
    origin.asked += 1;
    return origin.refused;
  },
}));
vi.mock('./use-api-check', () => {
  const ok = { ok: true, chains: [] };
  return { useApiCheck: () => ok };
});

// The bridge itself, mounted over a stand-in for Privy's hooks. A person who signs in with a passkey
// is owed a wallet of each family, and the bridge makes them: one call at a time, never the same
// wallet twice, and nobody is `ready` (so nobody is asked for a chain) until both are there.

process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'app-id';

async function bridge({ strict = false } = {}) {
  const { default: PrivyBridge } = await import('./privy-bridge');
  const ports: WebWalletPort[] = [];
  const onPort = (port: WebWalletPort) => {
    ports.push(port);
  };
  const node = createElement(PrivyBridge, { onPort });
  await mount(strict ? createElement(StrictMode, null, node) : node);
  await settle();
  return { ports, port: () => ports.at(-1) as WebWalletPort };
}

/**
 * The bridge as the wallet provider mounts it: mounted again on `restart()`, with what the provider
 * keeps across mounts (`carry`).
 */
async function restartable() {
  const { default: PrivyBridge } = await import('./privy-bridge');
  const ports: WebWalletPort[] = [];
  const carry = { making: Promise.resolve() };
  let again = () => {};
  const Host = () => {
    const [turn, setTurn] = useState(0);
    again = () => setTurn((n) => n + 1);
    return createElement(PrivyBridge, {
      key: turn,
      carry,
      onPort: (port: WebWalletPort) => {
        ports.push(port);
      },
    });
  };
  await mount(createElement(Host));
  await settle();
  return {
    port: () => ports.at(-1) as WebWalletPort,
    /** `wait` false under fake timers, where the test moves the clock itself. */
    restart: async (wait = true) => {
      await act(async () => again());
      if (wait) await settle();
    },
  };
}

/** Answers the oldest call that is on its way. */
async function answer(how: (call: PendingWallet) => void) {
  const call = privyDouble.pending.shift();
  if (!call) throw new Error('no call to make a wallet is on its way');
  await act(async () => how(call));
  await settle();
}

const families = (port: WebWalletPort) => port.accounts.map((a) => `${a.family}:${a.kind}`);

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe('the wallets a passkey sign-in owes', () => {
  it.each([
    ['', false],
    [' under strict mode, which runs every effect twice', true],
  ])('are made one call at a time, each family once%s', async (_, strict) => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port } = await bridge({ strict });
    expect(privyDouble.calls).toEqual(['solana']);
    expect(port().status).toBe('loading');
    expect(port().walletsOwed).toBe('making');

    await answer((call) => call.made());
    // the first wallet is there: the second is asked for once, by the same loop
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
    expect(privyDouble.pending).toHaveLength(1);
    expect(port().status).toBe('loading');

    await answer((call) => call.made());
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
    expect(privyDouble.mostAtOnce).toBe(1);
    expect(port().status).toBe('ready');
    expect(port().walletsOwed).toBeNull();
    expect(families(port())).toEqual(['evm:embedded', 'solana:embedded']);
  });

  it('are none for someone who connected a wallet', async () => {
    privyDouble.reset(privyDouble.walletPerson('solana'));
    const { port } = await bridge();
    expect(privyDouble.calls).toEqual([]);
    expect(port().status).toBe('ready');
    expect(families(port())).toEqual(['solana:external']);
  });

  it('start when the person signs in, and not before', async () => {
    privyDouble.reset();
    const { port } = await bridge();
    expect(port().status).toBe('signed-out');
    expect(privyDouble.calls).toEqual([]);
    await act(async () => privyDouble.signIn(privyDouble.passkeyPerson()));
    await settle();
    expect(privyDouble.calls).toEqual(['solana']);
    expect(port().status).toBe('loading');
    // signed in, so there is a session to sign out of while the wallets are made
    expect(port().userId).toBe('did:privy:one');
  });
});

describe('a wallet that could not be made', () => {
  it('leaves nobody ready with one wallet: the person is signed in, and owed', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port, ports } = await bridge();
    await answer((call) => call.made());
    await answer((call) => call.fails());
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
    expect(port().walletsOwed).toBe('failed');
    expect(port().status).toBe('loading');
    expect(port().userId).toBe('did:privy:one');
    expect(ports.map((p) => p.status)).not.toContain('ready');
  });

  it('is made when asked again: that wallet alone, and then the person is ready', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port } = await bridge();
    await answer((call) => call.made());
    await answer((call) => call.fails());

    let outcome = 'waiting';
    await act(async () => {
      void port()
        .ensureWallets()
        .then(
          () => {
            outcome = 'made';
          },
          () => {
            outcome = 'failed';
          },
        );
    });
    await settle();
    expect(privyDouble.calls).toEqual(['solana', 'ethereum', 'ethereum']);
    expect(port().walletsOwed).toBe('making');
    expect(outcome).toBe('waiting');
    await answer((call) => call.made());
    expect(outcome).toBe('made');
    expect(port().status).toBe('ready');
    expect(families(port())).toEqual(['evm:embedded', 'solana:embedded']);
    expect(privyDouble.mostAtOnce).toBe(1);
  });

  it('says so to whoever asked again, when it fails again', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port } = await bridge();
    await answer((call) => call.fails('quota'));
    expect(port().walletsOwed).toBe('failed');
    let reason: unknown = null;
    await act(async () => {
      void port()
        .ensureWallets()
        .catch((e: { reason?: unknown }) => {
          reason = e.reason;
        });
    });
    await settle();
    await answer((call) => call.fails('quota'));
    expect(reason).toBe('wallet_not_made');
    expect(port().walletsOwed).toBe('failed');
    expect(port().status).toBe('loading');
  });

  it('is not tried again by itself, under strict mode either', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port } = await bridge({ strict: true });
    await answer((call) => call.fails());
    expect(port().walletsOwed).toBe('failed');
    expect(privyDouble.calls).toEqual(['solana']);
    expect(privyDouble.pending).toHaveLength(0);
  });

  it('is not asked for a second time while the first call is on its way', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port } = await bridge();
    let done = false;
    await act(async () => {
      void port()
        .ensureWallets()
        .then(() => {
          done = true;
        });
      void port()
        .ensureWallets()
        .catch(() => {});
    });
    await settle();
    expect(privyDouble.calls).toEqual(['solana']);
    await answer((call) => call.made());
    await answer((call) => call.made());
    expect(done).toBe(true);
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
  });
});

describe('Privy’s answer that the wallet is there already', () => {
  it('is a wallet that is there, not a failure', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port } = await bridge();
    await answer((call) => call.made());
    // made in another tab in the meantime: Privy throws a plain Error with these words
    await answer((call) => call.alreadyThere());
    expect(port().walletsOwed).toBeNull();
    expect(port().status).toBe('ready');
    expect(families(port())).toEqual(['evm:embedded', 'solana:embedded']);
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
  });

  it('still leaves the person owed while this page does not list that wallet', async () => {
    vi.useFakeTimers();
    privyDouble.reset(privyDouble.passkeyPerson());
    const { default: PrivyBridge } = await import('./privy-bridge');
    const ports: WebWalletPort[] = [];
    await mount(createElement(PrivyBridge, { onPort: (p: WebWalletPort) => void ports.push(p) }));
    const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await tick(0);
    const call = () => privyDouble.pending.shift() as PendingWallet;
    await act(async () => call().made());
    await tick(0);
    await act(async () => call().alreadyThere(false));
    await tick(0);
    // given a moment to appear in the list, then called missing: never ready with one wallet
    expect(ports.at(-1)?.walletsOwed).toBe('making');
    await tick(2_500);
    expect(ports.at(-1)?.walletsOwed).toBe('failed');
    expect(ports.map((p) => p.status)).not.toContain('ready');
  });
});

describe('one person after another', () => {
  it('does not carry the first person’s job over to the second', async () => {
    privyDouble.reset(privyDouble.passkeyPerson('did:privy:one'));
    const { port } = await bridge();
    expect(privyDouble.calls).toEqual(['solana']);
    await act(async () => privyDouble.signOut());
    await act(async () => privyDouble.signIn(privyDouble.passkeyPerson('did:privy:two')));
    await settle();
    // the second person's wallets wait for the call that is still on its way
    expect(privyDouble.calls).toEqual(['solana']);
    // it answers, for the first person: their job makes nothing for the second
    await answer((call) => call.made());
    expect(privyDouble.calls).toEqual(['solana', 'solana']);
    await answer((call) => call.made());
    await answer((call) => call.made());
    expect(privyDouble.calls).toEqual(['solana', 'solana', 'ethereum']);
    expect(privyDouble.mostAtOnce).toBe(1);
    expect(port().status).toBe('ready');
    expect(port().userId).toBe('did:privy:two');
  });
});

describe('the provider mounted again ("Try again" for a slow sign-in)', () => {
  it('asks for no wallet beside a call still open, and the loop left behind makes nothing more', async () => {
    privyDouble.reset(privyDouble.passkeyPerson());
    const { port, restart } = await restartable();
    expect(privyDouble.calls).toEqual(['solana']);
    await restart();
    // the first driver's call is still open: the new driver waits for it
    expect(privyDouble.calls).toEqual(['solana']);
    expect(privyDouble.pending).toHaveLength(1);
    expect(port().walletsOwed).toBe('making');

    await answer((call) => call.made());
    // the old loop stopped before its next wallet; the new one asks for what is still owed, once
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
    expect(privyDouble.pending).toHaveLength(1);
    await answer((call) => call.made());
    expect(privyDouble.calls).toEqual(['solana', 'ethereum']);
    expect(privyDouble.mostAtOnce).toBe(1);
    // and that one came from the mounted provider's hooks, not from the loop left behind
    expect(privyDouble.deadCalls).toBe(0);
    expect(port().status).toBe('ready');
    expect(families(port())).toEqual(['evm:embedded', 'solana:embedded']);
  });

  it('does not wait for ever on a call that never ends: after its wait the new driver asks', async () => {
    const { OPEN_CALL_WAIT_MS } = await import('./privy-bridge');
    privyDouble.reset(privyDouble.passkeyPerson());
    const { restart } = await restartable();
    vi.useFakeTimers();
    await restart(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_CALL_WAIT_MS - 1);
    });
    expect(privyDouble.calls).toEqual(['solana']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(privyDouble.calls).toEqual(['solana', 'solana']);
  });

  it('ends a sign-in that was open on the port that is gone', async () => {
    privyDouble.reset();
    privyDouble.passkey = () => new Promise(() => {});
    const { port, restart } = await restartable();
    let outcome = 'open';
    void port()
      .signIn('passkey')
      .then(
        () => {
          outcome = 'signed in';
        },
        (e: unknown) => {
          outcome = e instanceof Error ? e.message : 'failed';
        },
      );
    await settle();
    expect(outcome).toBe('open');
    await restart();
    expect(outcome).toMatch(/started again/);
    // and the new port signs in as before
    privyDouble.passkey = async () => ({});
    await expect(port().signIn('passkey')).resolves.toBeUndefined();
  });
});

describe('an address the sign-in service refuses', () => {
  const later = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const mounted = async () => {
    const { default: PrivyBridge } = await import('./privy-bridge');
    const ports: WebWalletPort[] = [];
    await mount(
      createElement(PrivyBridge, {
        onPort: (port: WebWalletPort) => {
          ports.push(port);
        },
      }),
    );
    await later(0);
    return () => ports.at(-1) as WebWalletPort;
  };
  const start = (answer: boolean | null) => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    origin.refused = answer;
    origin.asked = 0;
    privyDouble.reset();
  };

  it('is said at once, with nobody signed in, whether the provider has loaded or never does', async () => {
    for (const loaded of [false, true]) {
      start(true);
      if (!loaded) privyDouble.notLoaded();
      const port = await mounted();
      expect(origin.asked).toBe(1);
      expect(port().status).toBe('signed-out');
      expect(port().problemKind).toBe('origin');
      expect(port().problem).toContain(window.location.origin);
      // and it goes on being said if the provider loads late, or someone turns out to be signed in:
      // every call from this address is refused the same
      await act(async () => privyDouble.reset(privyDouble.walletPerson('solana')));
      await later(60_000);
      expect(port().problemKind).toBe('origin');
      expect(origin.asked).toBe(1);
      await unmountAll();
    }
  });

  it('is not said when the settings take the address, or cannot be read: the provider’s own port stands', async () => {
    for (const answer of [false, null]) {
      start(answer);
      privyDouble.notLoaded();
      const port = await mounted();
      await later(60_000);
      expect(port().status).toBe('loading');
      expect(port().problem).toBeNull();
      await act(async () => privyDouble.reset());
      await later(0);
      expect(port().status).toBe('signed-out');
      expect(port().problem).toBeNull();
      await unmountAll();
    }
  });

  it('is asked once per tab: an address found allowed is not asked about on the next mount, one not read is', async () => {
    start(false);
    await mounted();
    expect(origin.asked).toBe(1);
    await unmountAll();
    await mounted();
    expect(origin.asked).toBe(1);
    await unmountAll();
    // settings that could not be read are no answer: asked again
    start(null);
    await mounted();
    await unmountAll();
    await mounted();
    expect(origin.asked).toBe(2);
  });
});
